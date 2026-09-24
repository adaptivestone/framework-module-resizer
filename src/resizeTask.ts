// The async resize CORE (07 · Worker §11, 11 · Modes §11.1). ONE sharp pipeline shared by
// both generation modes:
//   - processTask()  = the core + lease/lock/transport bookkeeping (queued/lazy worker)
//   - generateImpl()  = the core WITHOUT locks/transport (eager `resizer.generate`)
// Steps 2–8 (download once → metadata guards + orientation normalize → beforeSteps once →
// decode once + bounded per-variant resize/encode/upload → one appendPreviews) live in
// generatePreviews(). getResizer()/Resizer are imported for the value/type; the resizer↔
// resizeTask cycle is runtime-safe (only hoisted functions are referenced, never called at
// module load). sharp is a hard dep; this is the only place besides worker.ts that decodes.
import sharp, { type FormatEnum, type OutputOptions } from 'sharp';
import { getApp } from './app.ts';
import { canonicalizeVariants } from './enqueue.ts';
import {
  ResizeGenerateError,
  ResizeMediaError,
  ResizeNoOriginalError,
} from './errors.ts';
import { runBounded } from './helpers/concurrency.ts';
import { isAvifBuffer } from './helpers/imageFormat.ts';
import { randomHex } from './helpers/random.ts';
import {
  calculateResizedDimensions,
  expandMissingPreviews,
  getPreviewIdentity,
  isUsablePreview,
  requireMediaId,
} from './images.ts';
import { getResizeConfig } from './resizeConfig.ts';
import {
  type GenerateOpts,
  type GenerateResult,
  getResizer,
  type LeasedTask,
  type Resizer,
} from './resizer.ts';
import type {
  MediaLike,
  MissingPreview,
  Preview,
  SizeInput,
} from './types.d.ts';

/** Normalize a driver download / beforeStep result to a Node Buffer for the next sharp(). */
const asBuffer = (b: Buffer | Uint8Array): Buffer =>
  Buffer.isBuffer(b) ? b : Buffer.from(b);

/** Random folder prefix for a preview key = the original key's folder, else 'uploads'. */
function keyPrefix(originalKey: string | undefined): string {
  if (!originalKey) {
    return 'uploads';
  }
  const idx = originalKey.lastIndexOf('/');
  return idx > 0 ? originalKey.slice(0, idx) : 'uploads';
}

// ---------------------------------------------------------------------------
// The shared core (07 steps 2–8; 11 · §11.1 step 4). Both modes expand their inputs into a
// `requested` MissingPreview[] and call this. `useLocks` toggles the queued-mode two-tier
// locks (dispatch release on skip-existing + best-effort worker lock); `persist` toggles the
// single appendPreviews + onPreviewGenerated firing (eager `persist:false` returns raw).
// ---------------------------------------------------------------------------

export interface GenerateCoreArgs {
  media: MediaLike;
  mediaId: string;
  requested: MissingPreview[];
  pipeline: string;
  ctx: Record<string, unknown>;
  useLocks: boolean;
  persist: boolean;
  signal?: AbortSignal;
}

export interface GenerateCoreResult {
  generated: Preview[];
  failedCount: number;
}

export async function generatePreviews(
  resizer: Resizer,
  args: GenerateCoreArgs,
): Promise<GenerateCoreResult> {
  const {
    media,
    mediaId,
    requested,
    pipeline: pipelineName,
    ctx,
    useLocks,
    persist,
    signal,
  } = args;
  const app = getApp();
  const config = getResizeConfig();
  const storage = resizer.storage;

  const generated: Preview[] = [];
  let failedCount = 0;

  // Nothing requested (e.g. eager re-run where everything already exists) → no download.
  if (requested.length === 0) {
    return { generated, failedCount };
  }

  const original = media.original;
  if (!original) {
    // Callers guard this, but never assume — a media without an original has nothing to
    // resize from.
    return { generated, failedCount };
  }

  // 2. Download the original ONCE.
  let buf = asBuffer(await storage.download(original));

  // 3. Metadata + decode-bomb guards + orientation normalization (07 · §11 step 3). EVERY worker
  // sharp() call carries limitInputPixels (01 · §16), so an oversized-for-inputPixels source is
  // rejected consistently at this first probe rather than slipping through to a per-variant decode.
  const origMeta = await sharp(buf, {
    limitInputPixels: config.limits.inputPixels,
  })
    .timeout({ seconds: config.limits.processingTimeoutSeconds })
    .metadata();
  if (origMeta.width === undefined || origMeta.height === undefined) {
    throw new ResizeMediaError(
      `resize: source metadata missing width/height for media ${mediaId} — cannot size safely`,
      { mediaId, code: 'RESIZE_SOURCE_METADATA_MISSING' },
    );
  }
  const orientation = origMeta.orientation ?? 1;
  // DISPLAY dims: EXIF 5–8 swap width/height, so the stored dims are wrong for rotated photos.
  const [dispW, dispH] =
    orientation >= 5
      ? [origMeta.height, origMeta.width]
      : [origMeta.width, origMeta.height];
  const frames = config.animated
    ? Math.min(origMeta.pages ?? 1, config.limits.animationFrames)
    : 1;
  if (origMeta.width * origMeta.height * frames > config.limits.sourcePixels) {
    throw new ResizeMediaError(
      `resize: source ${origMeta.width}×${origMeta.height}×${frames}f exceeds limits.sourcePixels (${config.limits.sourcePixels}) for media ${mediaId}`,
      { mediaId, code: 'RESIZE_SOURCE_TOO_LARGE' },
    );
  }
  // Normalize orientation ONCE, before beforeSteps, so every step + variant sees DISPLAY-
  // orientation pixels (and a beforeStep that round-trips sharp() cannot re-strip a live EXIF
  // orientation and desync the result). Per-variant `.rotate()` below is then defense-in-depth.
  let displayMeta = origMeta;
  if (orientation > 1) {
    buf = await sharp(buf, {
      failOn: 'none',
      limitInputPixels: config.limits.inputPixels,
    })
      .rotate()
      .toBuffer();
    displayMeta = await sharp(buf, {
      limitInputPixels: config.limits.inputPixels,
    }).metadata();
  }

  // 4. beforeSteps — the ordered, awaited chain, ONCE, over the display-orientation buffer.
  const pipeline = resizer.getPipeline(pipelineName);
  for (const step of pipeline.beforeSteps ?? []) {
    buf = asBuffer(await step(buf, { media, metadata: displayMeta, ctx }));
  }

  // 5. Post-beforeSteps metadata. Buffer is already display-oriented → NO swap logic here.
  const procMeta = await sharp(buf, {
    limitInputPixels: config.limits.inputPixels,
  })
    .timeout({ seconds: config.limits.processingTimeoutSeconds })
    .metadata();
  const procW = procMeta.width ?? dispW;
  const procH = procMeta.height ?? dispH;
  if (
    procW * procH >
    Math.min(config.limits.sourcePixels, config.limits.inputPixels)
  ) {
    throw new ResizeMediaError(
      `resize: processed source exceeds pixel limits for media ${mediaId}`,
      { mediaId, code: 'RESIZE_SOURCE_TOO_LARGE' },
    );
  }

  // 6. Existing-preview set (the DB check that makes re-runs idempotent — 07 step 6).
  const existing = new Set<string>();
  for (const p of media.previews ?? []) {
    if (isUsablePreview(p)) {
      existing.add(getPreviewIdentity(p.sizeKey, p.format, p.filters));
    }
  }

  // 7. Decode the original ONCE; clone the base per variant so the decode is shared.
  // SVG is decoded at the largest requested scale before the shared preview pipeline.
  // Cap the intermediate raster by the same source/input pixel budgets as other inputs.
  const pixelBudget = Math.min(
    config.limits.sourcePixels,
    config.limits.inputPixels,
  );
  const largestScale =
    procMeta.format === 'svg'
      ? Math.max(
          1,
          ...requested
            .filter((variant) => !variant.fit)
            .map((variant) =>
              Math.max(
                (variant.requestedWidth ?? 0) / procW,
                (variant.requestedHeight ?? 0) / procH,
              ),
            ),
        )
      : 1;
  const density =
    procMeta.format === 'svg'
      ? Math.max(
          72,
          Math.min(
            100_000,
            Math.floor(
              72 *
                Math.min(
                  largestScale,
                  Math.sqrt(pixelBudget / (procW * procH)),
                ),
            ),
          ),
        )
      : undefined;
  const base = sharp(buf, {
    failOn: procMeta.format === 'svg' ? 'warning' : 'none',
    sequentialRead: true,
    limitInputPixels: config.limits.inputPixels,
    animated: config.animated,
    pages: config.animated ? config.limits.animationFrames : 1,
    ...(density !== undefined ? { density } : {}),
  });
  const fitBase =
    density !== undefined && density > 72 && requested.some((v) => v.fit)
      ? sharp(buf, {
          failOn: 'warning',
          sequentialRead: true,
          limitInputPixels: config.limits.inputPixels,
          animated: config.animated,
          pages: config.animated ? config.limits.animationFrames : 1,
        })
      : undefined;

  // Locks held for processed variants; released once after the pool (success AND error).
  const heldLocks = new Set<string>();

  const processVariant = async (v: MissingPreview): Promise<void> => {
    const identity = getPreviewIdentity(v.sizeKey, v.format, v.filters);
    const dispatchKey = `resize_dispatch:${mediaId}:${identity}`;
    const workerKey = `resize_worker:${mediaId}:${identity}`;

    // Skip anything already generated; in queued mode drop its dispatch lock so a later read
    // can re-enqueue a sibling promptly.
    if (existing.has(identity)) {
      if (useLocks) {
        await releaseLock(resizer, dispatchKey);
      }
      return;
    }

    // Best-effort worker lock (queued mode only) — dedup, not correctness. Not acquired →
    // leave the variant MISSING (do NOT treat as done); the next read re-detects + re-enqueues.
    // An acquire REJECTION behaves EXACTLY like "not acquired": log + skip; it must never reject
    // the bounded pool (that would skip persist + the held-lock release) — a lock-infra hiccup is
    // not a poison variant, so it does NOT count toward the poison-guard's failedCount (1.2a).
    if (useLocks) {
      let acquired: boolean;
      try {
        acquired = await resizer.lockProvider.acquire(
          workerKey,
          config.queue.lockTtlMs.worker,
        );
      } catch (err) {
        app.logger.error(
          `resize worker: worker-lock acquire failed for ${identity} on media ${mediaId} — leaving variant missing`,
          err,
        );
        return;
      }
      if (!acquired) {
        return;
      }
      heldLocks.add(workerKey);
      heldLocks.add(dispatchKey);
    }

    try {
      // Cover: dims pass straight through, clamped per provided side to limits.resultDimension.
      // Fit: already capped to config.maxSize by calculateResizedDimensions.
      const dims = calculateResizedDimensions(
        procW,
        procH,
        v.requestedWidth,
        v.requestedHeight,
        v.fit ?? false,
        config.maxSize,
      );
      let width = dims.width;
      let height = dims.height;
      if (!v.fit) {
        const cap = config.limits.resultDimension;
        if (typeof width === 'number' && width > cap) {
          width = cap;
        }
        if (typeof height === 'number' && height > cap) {
          height = cap;
        }
      }

      // Clone the shared decode; `.rotate()` on EVERY branch (defense-in-depth); normalize the
      // working colorspace BEFORE variantSteps so composited overlay colors are predictable.
      let img = (v.fit && fitBase ? fitBase : base)
        .clone()
        .rotate()
        .resize(
          width,
          height,
          v.fit
            ? { fit: 'inside', withoutEnlargement: true }
            : { fit: 'cover', position: 'center' },
        )
        .toColorspace('srgb');
      const s = config.encode.sharpen;
      const sharpenOn = s && (v.fit ? s.fit : s.cover);
      if (sharpenOn) {
        img = img.sharpen();
      }
      for (const step of pipeline.variantSteps ?? []) {
        img = await step(img, { variant: v, ctx });
      }
      if (
        procMeta.hasAlpha &&
        config.encode.flatten.formats.includes(v.format)
      ) {
        img = img.flatten({ background: config.encode.flatten.background });
      }

      const encodeOptions = config.encode.formats[v.format] ?? {};
      img = img.toFormat(
        v.format as keyof FormatEnum,
        encodeOptions as OutputOptions,
      );

      const { data, info } = await img
        .timeout({ seconds: config.limits.processingTimeoutSeconds })
        .toBuffer({ resolveWithObject: true });
      // Sharp reports AVIF output through its HEIF container id and does not expose
      // compression on OutputInfo. Inspect the produced ISO BMFF brands so configured
      // `heif: { compression: 'av1' }` receives the correct MIME type and extension too.
      const outputFormat =
        info.format === 'heif' && isAvifBuffer(data) ? 'avif' : info.format;
      if (outputFormat === 'svg') {
        throw new ResizeMediaError(
          `resize: SVG cannot be published as a preview for media ${mediaId}`,
          { mediaId, code: 'RESIZE_SVG_PUBLIC_PREVIEW' },
        );
      }
      const contentType = `image/${outputFormat}`;
      const key = `${keyPrefix(original.key)}/${randomHex()}.${outputFormat}`;
      const ref = await storage.upload({
        key,
        body: data,
        contentType,
        visibility: 'public',
      });

      const preview: Preview = {
        ...ref,
        sizeKey: v.sizeKey,
        format: v.format,
        contentType,
        actualWidth: info.width,
        actualHeight: info.height,
      };
      if (v.filters) {
        preview.filters = v.filters;
      }
      if (v.requestedWidth !== undefined) {
        preview.requestedWidth = v.requestedWidth;
      }
      if (v.requestedHeight !== undefined) {
        preview.requestedHeight = v.requestedHeight;
      }
      if (v.fit) {
        preview.fit = true;
      }
      generated.push(preview);
    } catch (err) {
      // One bad variant must not fail the whole task; poison guard (step 10) is the caller's.
      app.logger.error(
        `resize worker: variant ${identity} failed for media ${mediaId}`,
        err,
      );
      failedCount += 1;
      if (useLocks) {
        heldLocks.delete(workerKey);
        await releaseLock(resizer, workerKey);
      }
    }
  };

  // Bounded per-variant pool (NOT unbounded Promise.all); between variants stop launching new
  // ones if the lease was lost (best-effort — correctness holds via the fencing token).
  await runBounded(
    requested,
    config.worker.concurrency,
    signal,
    processVariant,
  );

  try {
    // 8. ONE atomic persist for everything generated (+ display-dim backfill when the original
    // never carried dims), then fire onPreviewGenerated per pushed preview (ctx {}).
    if (persist && generated.length > 0) {
      const backfillDims =
        original.width === undefined || original.height === undefined
          ? { width: dispW, height: dispH }
          : undefined;
      await resizer.mediaStore.appendPreviews(mediaId, generated, backfillDims);
      for (const preview of generated) {
        await resizer.runObservers('onPreviewGenerated', preview, {});
      }
    }
  } finally {
    // 9. Release every held dispatch + worker lock (success AND error paths).
    for (const key of heldLocks) {
      await releaseLock(resizer, key);
    }
  }

  return { generated, failedCount };
}

/** Best-effort lock release; a failing release is logged, never thrown. */
async function releaseLock(resizer: Resizer, key: string): Promise<void> {
  try {
    await resizer.lockProvider.release(key);
  } catch (err) {
    getApp().logger.error(`resize worker: failed to release lock ${key}`, err);
  }
}

// ---------------------------------------------------------------------------
// Queued entry (07 · §11). The transport-owned lease/complete/retry loop calls this per task;
// it SUCCEEDS by returning and FAILS by throwing (which engages the transport's retry → DLQ).
// ---------------------------------------------------------------------------

export async function processTask(
  task: LeasedTask,
  taskOpts?: { signal: AbortSignal },
): Promise<void> {
  const app = getApp();
  const resizer = getResizer();
  // ctx does NOT cross the queue (04 · §8) — the worker's pipeline steps depend on media/metadata.
  const ctx: Record<string, unknown> = {};

  // 1. Load the media doc. A deleted media row is a logged no-op success (the transport
  // completes it), but a live row whose persisted original is absent/malformed is a terminal
  // media error. In particular, `{ original: {} }` must not reach storage.download: it has no
  // usable locator and retrying it cannot make the source appear.
  const media = await resizer.mediaStore.load(task.mediaId);
  if (!media) {
    app.logger.info(
      `resize worker: media ${task.mediaId} missing (no doc) — no-op complete`,
    );
    return;
  }
  if (!media.original?.key) {
    throw new ResizeNoOriginalError(task.mediaId);
  }
  const requestedByIdentity = new Map<string, MissingPreview>();
  for (const preview of canonicalizeVariants(task.previews)) {
    const identity = getPreviewIdentity(
      preview.sizeKey,
      preview.format,
      preview.filters,
    );
    if (!requestedByIdentity.has(identity)) {
      requestedByIdentity.set(identity, preview);
    }
  }
  const requested = [...requestedByIdentity.values()];
  const { generated, failedCount } = await generatePreviews(resizer, {
    media,
    mediaId: task.mediaId,
    requested,
    pipeline: task.pipeline,
    ctx,
    useLocks: true,
    persist: true,
    signal: taskOpts?.signal,
  });

  // 10. A queued task is complete only when every requested identity is now persisted. Re-read
  // once so a worker-lock loser can observe a concurrent worker's write. Our own generated rows
  // are included too: appendPreviews returned successfully before generatePreviews returned.
  const refreshed = await resizer.mediaStore.load(task.mediaId);
  if (!refreshed) {
    app.logger.info(
      `resize worker: media ${task.mediaId} was deleted while processing — no-op complete`,
    );
    return;
  }
  const covered = new Set<string>();
  for (const preview of [
    ...(media.previews ?? []),
    ...(refreshed.previews ?? []),
    ...generated,
  ]) {
    if (isUsablePreview(preview)) {
      covered.add(
        getPreviewIdentity(preview.sizeKey, preview.format, preview.filters),
      );
    }
  }
  const missing = requested.filter(
    (preview) =>
      !covered.has(
        getPreviewIdentity(preview.sizeKey, preview.format, preview.filters),
      ),
  );
  if (missing.length > 0) {
    const missingIdentities = missing.map((preview) =>
      getPreviewIdentity(preview.sizeKey, preview.format, preview.filters),
    );
    throw new ResizeGenerateError({
      mediaId: task.mediaId,
      failed: Math.max(failedCount, missing.length),
      requested: requested.length,
      missing: missingIdentities,
      message: `resize worker: task for media ${task.mediaId} is incomplete; missing ${missingIdentities.join(', ')} — failing for retry/dead-letter`,
      code: 'RESIZE_WORKER_INCOMPLETE',
    });
  }
}

// ---------------------------------------------------------------------------
// Eager entry (11 · Modes §11.1). Same core, NO locks/transport; the caller's real ctx reaches
// the pipeline steps (unlike the queued worker's ctx === {}). `resizer.generate` delegates here.
// ---------------------------------------------------------------------------

export async function generateImpl(
  resizer: Resizer,
  opts: GenerateOpts,
): Promise<GenerateResult> {
  const config = getResizeConfig();
  const ctx = opts.ctx ?? {};
  const { media } = opts;
  const pipeline = opts.pipeline ?? 'default';
  // Eager mode is host-facing: a media with no id/_id is a caller bug → throw a named error
  // (04 · papercut) rather than silently keying on the literal 'undefined'.
  const mediaId = requireMediaId(media);

  const original = media.original;
  if (!original?.key) {
    throw new ResizeNoOriginalError(mediaId);
  }

  // Host size magic (real ctx in eager mode), then the active format list.
  const sizes = (await resizer.runWaterfall(
    'resolveSizes',
    opts.sizes,
    ctx,
  )) as SizeInput[];
  const formats = opts.formats ?? config.formats;

  // Expand sizes × formats; skip unbuildable sizes + existing identities (idempotent).
  const requested = expandMissingPreviews(media, sizes, formats);

  const persist = opts.persist !== false;
  const { generated, failedCount } = await generatePreviews(resizer, {
    media,
    mediaId,
    requested,
    pipeline,
    ctx,
    useLocks: false,
    persist,
  });

  if (requested.length > 0 && generated.length === 0 && failedCount > 0) {
    throw new ResizeGenerateError({
      mediaId,
      failed: failedCount,
      requested: requested.length,
    });
  }

  // Persist is a $push; also append onto the caller's in-memory doc so a same-request
  // resolve() sees the new rows without a reload.
  if (persist && generated.length > 0) {
    media.previews = [...(media.previews ?? []), ...generated];
  }

  return { created: generated, failed: failedCount };
}
