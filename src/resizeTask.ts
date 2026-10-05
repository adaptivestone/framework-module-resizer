// The async resize CORE (07 · Worker §11, 11 · Modes §11.1). ONE sharp pipeline shared by
// both generation modes:
//   - processTaskWith() = the core + lock bookkeeping (queued/lazy worker)
//   - generateImpl()    = the core WITHOUT locks (eager `resizer.generate`)
// Steps 2–8 (download once → metadata guards → beforeSteps once, after an orientation
// normalize → decode once + bounded per-variant resize/encode/upload → one appendPreviews) live in
// generatePreviews(). Every function receives its Resizer as an argument, and resizer.ts is
// imported for types only, so the resizer↔resizeTask cycle is runtime-free. sharp is a hard
// dep; this is the only place besides worker.ts that decodes.
import sharp, {
  type FormatEnum,
  type Metadata,
  type OutputOptions,
  type Sharp,
} from 'sharp';
import { defaultQueueOptions } from './config/resize.ts';
import type { TaskQueue } from './contracts/taskQueue.ts';
import { canonicalizeVariants } from './enqueue.ts';
import {
  ResizeGenerateError,
  ResizeMediaError,
  ResizeNoOriginalError,
  ResizeSetupError,
  ResizeStorageError,
} from './errors.ts';
import { runBounded } from './helpers/concurrency.ts';
import { isAnimatedFormat, isAvifBuffer } from './helpers/imageFormat.ts';
import { randomHex } from './helpers/random.ts';
import {
  calculateResizedDimensions,
  coverDimensions,
  expandMissingPreviews,
  getPreviewIdentity,
  isUsablePreview,
  previewScope,
  requireMediaId,
} from './images.ts';
import { timingOf } from './queue.ts';
import type {
  GenerateOpts,
  GenerateResult,
  LeasedTask,
  Resizer,
} from './resizer.ts';
import type {
  MediaLike,
  MissingPreview,
  Preview,
  PreviewScope,
  SizeInput,
} from './types.d.ts';

/** Normalize a driver download / beforeStep result to a Node Buffer for the next sharp(). */
const asBuffer = (b: Buffer | Uint8Array): Buffer =>
  Buffer.isBuffer(b) ? b : Buffer.from(b);

// librsvg refuses to render an SVG whose raster side is larger than this.
const SVG_MAX_SIDE = 32767;

/**
 * An unregistered pipeline must not render: its previews would be stored under that pipeline's
 * identity without its steps, and `resolve` would serve them for good (a renamed watermark
 * pipeline during a rolling deploy would lose its watermark). `default` always exists.
 */
function requirePipeline(resizer: Resizer, name: string): void {
  if (!resizer.hasPipeline(name)) {
    throw new ResizeSetupError(
      `resize: pipeline '${name}' is not registered on Resizer '${resizer.name}' — register it in every process that generates previews (API and worker) before using it`,
      { code: 'RESIZE_PIPELINE_UNKNOWN' },
    );
  }
}

/**
 * Formats that are not an own key of `encode.formats`: an alias such as 'jpg' would skip the
 * JPEG options and the flatten step, and an arbitrary Sharp id such as 'raw' would publish a
 * pixel dump.
 */
function unconfiguredFormats(
  encoders: Record<string, unknown>,
  formats: readonly string[],
): string[] {
  return [...new Set(formats)].filter(
    (format) => !Object.hasOwn(encoders, format),
  );
}

/** A per-call argument names an unconfigured format: a wiring error at the call site. */
function formatNotConfiguredError(formats: string[]): ResizeSetupError {
  return new ResizeSetupError(
    `resize: formats [${formats.join(', ')}] have no encode.formats entry — request configured Sharp format ids such as 'jpeg', not aliases such as 'jpg'`,
    { code: 'RESIZE_FORMAT_NOT_CONFIGURED' },
  );
}

/**
 * Encode an orientation-normalized original in its own format without visible loss. Sharp's
 * defaults are lossy for some formats (JPEG quality 80 with 4:2:0, TIFF with JPEG compression),
 * and every variant is made from this buffer. The buffer is an in-memory intermediate, so encode
 * time matters more than size: WebP uses quality 95 at the lowest effort (lossless WebP of a
 * 49 MP photo took 16.5 s and 63 MB on one thread, close to the processing timeout), and the
 * lossless AVIF path uses the lowest effort too.
 */
function withoutVisibleLoss(img: Sharp, format: string | undefined): Sharp {
  switch (format) {
    case 'jpeg':
      return img.jpeg({ quality: 100, chromaSubsampling: '4:4:4' });
    case 'webp':
      return img.webp({ quality: 95, effort: 0 });
    case 'heif': // AVIF reports its HEIF container
      return img.heif({ compression: 'av1', lossless: true, effort: 0 });
    case 'tiff':
      return img.tiff({ compression: 'lzw' });
    default:
      return img; // PNG and GIF are lossless at Sharp's defaults
  }
}

/**
 * True when Sharp's SVG shrink-on-load would re-render a raster of `rasterW`×`rasterH` past
 * librsvg's side limit for a cover resize to `width`×`height`. Sharp re-renders an SVG at the
 * scale the resize needs, which for a cover crop of an extreme aspect ratio (a 1×5000 strip
 * at 300×300) is the whole uncropped image: 300×1,500,000.
 */
function svgReloadExceedsLimit(
  rasterW: number,
  rasterH: number,
  width: number | undefined,
  height: number | undefined,
): boolean {
  const shrink =
    width !== undefined && height !== undefined
      ? Math.min(rasterW / width, rasterH / height)
      : width !== undefined
        ? rasterW / width
        : height !== undefined
          ? rasterH / height
          : 1;
  return Math.max(rasterW, rasterH) / shrink > SVG_MAX_SIDE;
}

/** Uploaded locators for a log line; an opaque ref that JSON cannot encode is still named. */
function describeRefs(previews: Preview[]): string {
  return previews
    .map((preview) => {
      try {
        return JSON.stringify(preview.storageRef) ?? String(preview.storageRef);
      } catch {
        return String(preview.storageRef);
      }
    })
    .join(', ');
}

// ---------------------------------------------------------------------------
// The shared core (07 steps 2–8; 11 · §11.1 step 4). Both modes expand their inputs into a
// `requested` MissingPreview[] and call this. `locks` (queued mode only: the database's locks)
// enables the two-tier locks (dispatch release on skip-existing + best-effort worker lock); `persist` toggles the
// single appendPreviews + onPreviewGenerated firing (eager `persist:false` returns raw).
// ---------------------------------------------------------------------------

export interface GenerateCoreArgs {
  media: MediaLike;
  mediaId: string;
  requested: MissingPreview[];
  pipeline: string;
  ctx: Record<string, unknown>;
  // Queued mode: take the database's locks with this worker-lock TTL. Eager mode passes none.
  locks?: { workerTtlMs: number };
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
    locks,
    persist,
    signal,
  } = args;
  const { config, logger } = resizer;
  const storage = resizer.storage;

  // Before any download or decode, in both modes; the queue retries it like any failure.
  requirePipeline(resizer, pipelineName);

  const generated: Preview[] = [];
  let failedCount = 0;

  // Nothing requested (e.g. eager re-run where everything already exists) → no download.
  if (requested.length === 0) {
    return { generated, failedCount };
  }

  const original = media.original;
  if (original?.storageRef == null) {
    // Callers guard this, but never assume — a media without an original has nothing to
    // resize from.
    return { generated, failedCount };
  }

  // 2. Download the original ONCE.
  let buf = asBuffer(await storage.download(original.storageRef));

  // 3. Metadata + decode-bomb guards (07 · §11 step 3). EVERY worker sharp() call carries
  // limitInputPixels (01 · §16), so an oversized-for-inputPixels source is rejected
  // consistently at this first probe rather than slipping through to a per-variant decode.
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
  // One frame must fit; how many frames are decoded is bounded below.
  if (origMeta.width * origMeta.height > config.limits.sourcePixels) {
    throw new ResizeMediaError(
      `resize: source ${origMeta.width}×${origMeta.height} exceeds limits.sourcePixels (${config.limits.sourcePixels}) for media ${mediaId}`,
      { mediaId, code: 'RESIZE_SOURCE_TOO_LARGE' },
    );
  }
  const pixelBudget = Math.min(
    config.limits.sourcePixels,
    config.limits.inputPixels,
  );

  const pipeline = resizer.getPipeline(pipelineName);
  // A preview keeps the animation only in an animated format and only without variantSteps: a
  // step sees every frame stacked into one tall image, so a composited watermark would land on
  // a single frame. Everything else is rendered from the first frame.
  const animates =
    config.animated &&
    (pipeline.variantSteps ?? []).length === 0 &&
    requested.some((v) => isAnimatedFormat(v.format));
  // Frames to decode: the source's own count (asking for more pages than exist fails the
  // decode), up to limits.animationFrames and to what fits the pixel budget (Sharp counts every
  // decoded frame against limitInputPixels). libvips cannot rotate a multi-page image, so an
  // animation that carries an EXIF orientation is rendered from its first frame.
  const framesOf = (meta: Metadata, frameW: number, frameH: number): number =>
    animates && (meta.orientation ?? 1) <= 1
      ? Math.max(
          1,
          Math.min(
            meta.pages ?? 1,
            config.limits.animationFrames,
            Math.floor(pixelBudget / (frameW * frameH)),
          ),
        )
      : 1;

  // 4. beforeSteps — the ordered, awaited chain, ONCE, over display-orientation pixels.
  // Without steps the original is used as downloaded: each variant's `.rotate()` applies the
  // EXIF orientation, so nothing is re-encoded before the variants are made.
  const beforeSteps = pipeline.beforeSteps ?? [];
  let procMeta = origMeta;
  let procW = dispW;
  let procH = dispH;
  if (beforeSteps.length > 0) {
    // Normalize orientation ONCE so every step sees DISPLAY-orientation pixels (and a step that
    // round-trips sharp() cannot re-strip a live EXIF orientation and desync the result),
    // re-encoded in the same format without visible loss.
    let stepMeta = origMeta;
    if (orientation > 1) {
      buf = await withoutVisibleLoss(
        sharp(buf, {
          failOn: 'none',
          limitInputPixels: config.limits.inputPixels,
        }).rotate(),
        origMeta.format,
      )
        .timeout({ seconds: config.limits.processingTimeoutSeconds })
        .toBuffer();
      stepMeta = await sharp(buf, {
        limitInputPixels: config.limits.inputPixels,
      }).metadata();
    }
    for (const step of beforeSteps) {
      buf = asBuffer(await step(buf, { media, metadata: stepMeta, ctx }));
    }

    // 5. Post-beforeSteps metadata. Buffer is already display-oriented → NO swap logic here.
    procMeta = await sharp(buf, {
      limitInputPixels: config.limits.inputPixels,
    })
      .timeout({ seconds: config.limits.processingTimeoutSeconds })
      .metadata();
    procW = procMeta.width ?? dispW;
    procH = procMeta.height ?? dispH;
  }
  if (procW * procH > pixelBudget) {
    throw new ResizeMediaError(
      `resize: processed source exceeds pixel limits for media ${mediaId}`,
      { mediaId, code: 'RESIZE_SOURCE_TOO_LARGE' },
    );
  }

  // 6. Existing-preview set (the DB check that makes re-runs idempotent — 07 step 6). Stored
  // previews keep their own scope, so another pipeline's rendering never counts as done here.
  const scope: PreviewScope = { resizer: resizer.name, pipeline: pipelineName };
  const existing = new Set<string>();
  for (const p of media.previews ?? []) {
    if (isUsablePreview(p)) {
      existing.add(
        getPreviewIdentity(previewScope(p), p.sizeKey, p.format, p.filters),
      );
    }
  }

  // 7. Decode the original ONCE; clone the base per variant so the decode is shared.
  // SVG is decoded at the largest requested scale before the shared preview pipeline.
  // Cap the intermediate raster by the same source/input pixel budgets as other inputs.
  const isSvg = procMeta.format === 'svg';
  let density: number | undefined;
  if (isSvg) {
    const largestScale = Math.max(
      1,
      ...requested
        .filter((variant) => !variant.fit)
        .map((variant) =>
          Math.max(
            (variant.requestedWidth ?? 0) / procW,
            (variant.requestedHeight ?? 0) / procH,
          ),
        ),
    );
    const scale = Math.min(
      Math.max(
        1,
        Math.min(largestScale, Math.sqrt(pixelBudget / (procW * procH))),
      ),
      // librsvg's side limit holds whatever the pixel budget allows (a 1×5000 strip).
      SVG_MAX_SIDE / Math.max(procW, procH),
    );
    density = Math.max(1, Math.min(100_000, Math.floor(72 * scale)));
  }
  const decode = (pages: number, svgDensity?: number): Sharp =>
    sharp(buf, {
      failOn: isSvg ? 'warning' : 'none',
      sequentialRead: true,
      limitInputPixels: config.limits.inputPixels,
      pages,
      ...(svgDensity !== undefined ? { density: svgDensity } : {}),
    });
  // Formats that cannot hold an animation decode only the first frame (otherwise Sharp stacks
  // every frame into one tall image).
  const frames = framesOf(procMeta, procW, procH);
  const base = decode(1, density);
  const animatedBase = frames > 1 ? decode(frames) : undefined;
  const fitBase =
    density !== undefined && density > 72 && requested.some((v) => v.fit)
      ? decode(1)
      : undefined;
  // Below 72 dpi (an SVG longer than the side limit) fit stays on the scaled raster: the 72 dpi
  // decode is unusable whenever Sharp does not re-render it (a 1×40000 strip). The raster's
  // rounded aspect ratio would shift an `inside` resize (a 40000×300 SVG gave 1997×15), so fit
  // fills the box calculateResizedDimensions computed from the SVG's own size.
  const exactFit = density !== undefined && density < 72;
  // The SVG raster size at `density`, for the shrink-on-load guard below.
  const svgRaster = isSvg
    ? await base
        .clone()
        .timeout({ seconds: config.limits.processingTimeoutSeconds })
        .metadata()
    : undefined;

  // Locks held for processed variants; released once after the pool (success AND error).
  const heldLocks = new Set<string>();

  const processVariant = async (v: MissingPreview): Promise<void> => {
    const identity = getPreviewIdentity(scope, v.sizeKey, v.format, v.filters);
    const dispatchKey = `resize_dispatch:${mediaId}:${identity}`;
    const workerKey = `resize_worker:${mediaId}:${identity}`;

    // Skip anything already generated; in queued mode drop its dispatch lock so a later read
    // can re-enqueue a sibling promptly.
    if (existing.has(identity)) {
      if (locks) {
        await releaseLock(resizer, dispatchKey);
      }
      return;
    }

    // Best-effort worker lock (queued mode only) — dedup, not correctness. Not acquired →
    // leave the variant MISSING (do NOT treat as done); the next read re-detects + re-enqueues.
    // An acquire REJECTION behaves EXACTLY like "not acquired": log + skip; it must never reject
    // the bounded pool (that would skip persist + the held-lock release) — a lock-infra hiccup is
    // not a poison variant, so it does NOT count toward the poison-guard's failedCount (1.2a).
    if (locks) {
      let acquired: boolean;
      try {
        acquired = await resizer.db.acquireLock(workerKey, locks.workerTtlMs);
      } catch (err) {
        logger.error(
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
      // A task payload can name any format; only configured encoders run (no sharp work here).
      if (!Object.hasOwn(config.encode.formats, v.format)) {
        throw formatNotConfiguredError([v.format]);
      }
      // Fit: capped to config.maxSize by calculateResizedDimensions. Cover: requested sides
      // rounded and capped to limits.resultDimension, a derived side included.
      const { width, height } = v.fit
        ? calculateResizedDimensions(
            procW,
            procH,
            undefined,
            undefined,
            true,
            config.maxSize,
          )
        : coverDimensions(
            procW,
            procH,
            v.requestedWidth,
            v.requestedHeight,
            config.limits.resultDimension,
          );

      // Clone the shared decode; `.rotate()` on EVERY branch applies the EXIF orientation;
      // normalize the working colorspace BEFORE variantSteps so composited overlay colors are
      // predictable.
      const animate = animatedBase !== undefined && isAnimatedFormat(v.format);
      let source = (v.fit && fitBase ? fitBase : animate ? animatedBase : base)
        .clone()
        .rotate();
      if (
        !v.fit &&
        svgRaster?.width !== undefined &&
        svgRaster.height !== undefined &&
        svgReloadExceedsLimit(svgRaster.width, svgRaster.height, width, height)
      ) {
        // An extract before the resize turns Sharp's SVG re-render off: the variant is cut from
        // the raster decoded at `density`, which fits the limit.
        source = source.extract({
          left: 0,
          top: 0,
          width: svgRaster.width,
          height: svgRaster.height,
        });
      }
      let img = source
        .resize(
          width,
          height,
          v.fit
            ? { fit: exactFit ? 'fill' : 'inside', withoutEnlargement: true }
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
      const key = `previews/${randomHex()}.${outputFormat}`;
      const ref = await storage.upload({
        key,
        body: data,
        contentType,
        visibility: 'public',
        parentRef: original.storageRef,
      });

      if (ref == null) {
        throw new ResizeStorageError(
          'resize: storage returned an invalid preview locator',
          {
            code: 'RESIZE_PREVIEW_STORAGE_REF_INVALID',
          },
        );
      }

      const preview: Preview = {
        storageRef: ref,
        resizer: resizer.name,
        pipeline: pipelineName,
        sizeKey: v.sizeKey,
        format: v.format,
        contentType,
        // One frame: an animated output reports the height of all frames stacked.
        actualWidth: info.width,
        actualHeight: info.pageHeight ?? info.height,
      };
      if (v.filters) {
        preview.filters = v.filters;
      }
      if (v.requestedWidth !== undefined) {
        preview.requestedWidth = Math.round(v.requestedWidth);
      }
      if (v.requestedHeight !== undefined) {
        preview.requestedHeight = Math.round(v.requestedHeight);
      }
      if (v.fit) {
        preview.fit = true;
      }
      generated.push(preview);
    } catch (err) {
      // One bad variant must not fail the whole task; poison guard (step 10) is the caller's.
      logger.error(
        `resize worker: variant ${identity} failed for media ${mediaId}`,
        err,
      );
      failedCount += 1;
      if (locks) {
        heldLocks.delete(workerKey);
        await releaseLock(resizer, workerKey);
      }
    }
  };

  // Bounded per-variant pool (NOT unbounded Promise.all); between variants stop launching new
  // ones if the lease was lost (best-effort — correctness holds via the fencing token).
  await runBounded(requested, config.concurrency, signal, processVariant);

  try {
    // 8. ONE atomic persist for everything generated (+ display-dim backfill when the original
    // never carried dims), then fire onPreviewGenerated per pushed preview (ctx {}).
    if (persist && generated.length > 0) {
      const backfillDims =
        original.width === undefined || original.height === undefined
          ? { width: dispW, height: dispH }
          : undefined;
      try {
        await resizer.db.appendPreviews(mediaId, generated, backfillDims);
      } catch (err) {
        // The files are stored but no row points at them: name them so an operator can find
        // (or delete) them.
        logger.error(
          `resize: recording ${generated.length} preview(s) failed for media ${mediaId}; uploaded but unrecorded storage refs: ${describeRefs(generated)}`,
          err,
        );
        throw err;
      }
      for (const preview of generated) {
        await resizer.runObservers('onPreviewGenerated', preview, {});
      }
    }
  } finally {
    // 9. Release every held dispatch + worker lock (success AND error paths).
    if (locks) {
      for (const key of heldLocks) {
        await releaseLock(resizer, key);
      }
    }
  }

  return { generated, failedCount };
}

/** Best-effort lock release; a failing release is logged, never thrown. */
async function releaseLock(resizer: Resizer, key: string): Promise<void> {
  try {
    await resizer.db.releaseLock(key);
  } catch (err) {
    resizer.logger.error(`resize worker: failed to release lock ${key}`, err);
  }
}

// ---------------------------------------------------------------------------
// Queued entry (07 · §11). The core queue loop (src/queue.ts) calls this per task; it SUCCEEDS
// by returning and FAILS by throwing (which engages the queue's retry → dead-letter).
// ---------------------------------------------------------------------------

export async function processTaskWith(
  resizer: Resizer,
  task: LeasedTask,
  taskOpts?: { signal: AbortSignal },
  // The queue that delivered the task: its worker-lock TTL fits the lease it holds. Default: the
  // Resizer's own queue (and the default TTL when processTask is called without one).
  tasks: TaskQueue | undefined = resizer.tasks,
): Promise<void> {
  const { logger } = resizer;
  // ctx does NOT cross the queue (04 · §8) — the worker's pipeline steps depend on media/metadata.
  const ctx: Record<string, unknown> = {};

  // 1. Load the media doc. A deleted media row is a logged no-op success (the queue
  // completes it), but a live row whose persisted original is absent/malformed is a terminal
  // media error. In particular, `{ original: {} }` must not reach storage.download: it has no
  // usable locator and retrying it cannot make the source appear.
  const media = await resizer.db.loadMedia(task.mediaId);
  if (!media) {
    logger.info(
      `resize worker: media ${task.mediaId} missing (no doc) — no-op complete`,
    );
    return;
  }
  if (media.original?.storageRef == null) {
    throw new ResizeNoOriginalError(task.mediaId);
  }
  const scope: PreviewScope = {
    resizer: resizer.name,
    pipeline: task.pipeline,
  };
  const requestedByIdentity = new Map<string, MissingPreview>();
  for (const preview of canonicalizeVariants(task.previews)) {
    const identity = getPreviewIdentity(
      scope,
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
    locks: {
      workerTtlMs: tasks
        ? timingOf(tasks).lockTtlMs.worker
        : defaultQueueOptions.lockTtlMs.worker,
    },
    persist: true,
    signal: taskOpts?.signal,
  });

  // 10. A queued task is complete only when every requested identity is now persisted. Re-read
  // once so a worker-lock loser can observe a concurrent worker's write. Our own generated rows
  // are included too: appendPreviews returned successfully before generatePreviews returned.
  const refreshed = await resizer.db.loadMedia(task.mediaId);
  if (!refreshed) {
    logger.info(
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
        getPreviewIdentity(
          previewScope(preview),
          preview.sizeKey,
          preview.format,
          preview.filters,
        ),
      );
    }
  }
  const missing = requested.filter(
    (preview) =>
      !covered.has(
        getPreviewIdentity(
          scope,
          preview.sizeKey,
          preview.format,
          preview.filters,
        ),
      ),
  );
  if (missing.length > 0) {
    const missingIdentities = missing.map((preview) =>
      getPreviewIdentity(
        scope,
        preview.sizeKey,
        preview.format,
        preview.filters,
      ),
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
// Eager entry (11 · Modes §11.1). Same core, NO locks; the caller's real ctx reaches
// the pipeline steps (unlike the queued worker's ctx === {}). `resizer.generate` delegates here.
// ---------------------------------------------------------------------------

export async function generateImpl(
  resizer: Resizer,
  opts: GenerateOpts,
): Promise<GenerateResult> {
  const { config } = resizer;
  const ctx = opts.ctx ?? {};
  const { media } = opts;
  const pipeline = opts.pipeline ?? 'default';
  // Eager mode is host-facing: a media with no id/_id is a caller bug → throw a named error
  // (04 · papercut) rather than silently keying on the literal 'undefined'.
  const mediaId = requireMediaId(media);

  const original = media.original;
  if (original?.storageRef == null) {
    throw new ResizeNoOriginalError(mediaId);
  }
  // Caller bugs fail before any host hook, download or decode.
  requirePipeline(resizer, pipeline);
  const formats = opts.formats ?? config.formats;
  const unconfigured = unconfiguredFormats(config.encode.formats, formats);
  if (unconfigured.length > 0) {
    throw formatNotConfiguredError(unconfigured);
  }

  // Host size magic (real ctx in eager mode).
  const sizes = (await resizer.runWaterfall(
    'resolveSizes',
    opts.sizes,
    ctx,
  )) as SizeInput[];

  // Expand sizes × formats; skip unbuildable sizes + existing identities (idempotent).
  const requested = expandMissingPreviews(media, sizes, formats, {
    resizer: resizer.name,
    pipeline,
  });

  const persist = opts.persist !== false;
  const { generated, failedCount } = await generatePreviews(resizer, {
    media,
    mediaId,
    requested,
    pipeline,
    ctx,
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
