// The async resize CORE (07 · Worker §11, 11 · Modes §11.1). ONE sharp pipeline shared by
// both generation modes:
//   - processTaskWith() = the core + lock bookkeeping (queued/lazy worker)
//   - generateImpl()    = the core WITHOUT locks (eager `resizer.generate`)
// Steps 2–8 (download once → metadata guards → beforeSteps once, after an orientation
// normalize → an SVG rendered once to a raster → decode once + bounded per-variant
// resize/encode/upload → one appendPreviews) live in generatePreviews(). Every function receives
// its Resizer as an argument, and resizer.ts is imported for types only, so the
// resizer↔resizeTask cycle is runtime-free. sharp is a hard dep; this is the only place besides
// worker.ts that decodes (SVG rendering runs in a child process: helpers/svgRaster.ts).
import sharp, {
  type FormatEnum,
  type Metadata,
  type OutputOptions,
  type Sharp,
} from 'sharp';
import { defaultQueueOptions } from './config/resize.ts';
import type { TaskQueue } from './contracts/taskQueue.ts';
import { canonicalizeVariants, dispatchLockKey } from './enqueue.ts';
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
import { rasterizeSvg } from './helpers/svgRaster.ts';
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
 * An SVG's own size to a fraction of a pixel. Its 72 dpi size (roundedW × roundedH) and any
 * raster are rounded to whole pixels, so a side derived from them can be a pixel off (200×100
 * rendered at 619×310 gives 620×311 for a 620 width), and a 1000×0.6 SVG reads as 1000×1. This
 * is a header-only read (nothing is rendered) at the highest density whose size still fits
 * limitInputPixels, which Sharp checks on the header too; the +2 margins absorb its rounding.
 */
async function svgNaturalSize(
  svg: Buffer,
  roundedW: number,
  roundedH: number,
  config: Resizer['config'],
): Promise<{ width: number; height: number }> {
  const density = Math.max(
    72,
    Math.min(
      100_000,
      Math.floor(
        72 *
          Math.sqrt(
            config.limits.inputPixels / ((roundedW + 2) * (roundedH + 2)),
          ),
      ),
    ),
  );
  const meta = await sharp(svg, {
    density,
    limitInputPixels: config.limits.inputPixels,
  })
    .timeout({ seconds: config.limits.processingTimeoutSeconds })
    .metadata();
  // Each side to within 1/scale of a pixel. A whole-number size inside that range is taken as
  // exact: the read is coarse for a long strip (40000×300 allows only about 4.7×).
  const scale = density / 72;
  const side = (scaled: number | undefined, rounded: number) => {
    const estimate = scaled === undefined ? rounded : scaled / scale;
    return Math.abs(estimate - rounded) <= 1 / scale ? rounded : estimate;
  };
  return {
    width: side(meta.width, roundedW),
    height: side(meta.height, roundedH),
  };
}

/** The identity a stored row answers for (rows written before previews carried one: derived). */
function identityOf(preview: Preview): string {
  return (
    preview.identity ??
    getPreviewIdentity(
      previewScope(preview),
      preview.sizeKey,
      preview.format,
      preview.filters,
    )
  );
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
  // Previews this call stored (or, with persist:false, produced).
  generated: Preview[];
  failedCount: number;
  // Identities the database already held from another worker: covered, not failed.
  alreadyStored: string[];
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

  let generated: Preview[] = [];
  let failedCount = 0;
  const alreadyStored: string[] = [];

  // Nothing requested (e.g. eager re-run where everything already exists) → no download.
  if (requested.length === 0) {
    return { generated, failedCount, alreadyStored };
  }

  const original = media.original;
  if (original?.storageRef == null) {
    // Callers guard this, but never assume — a media without an original has nothing to
    // resize from.
    return { generated, failedCount, alreadyStored };
  }

  // Existing-preview set (the DB check that makes re-runs idempotent — 07 step 6). Stored
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
  const pending = requested.filter(
    (v) =>
      !existing.has(getPreviewIdentity(scope, v.sizeKey, v.format, v.filters)),
  );
  // Everything requested is already stored: no download. In queued mode drop the dispatch locks
  // so a later read can re-enqueue a sibling promptly.
  if (pending.length === 0) {
    if (locks) {
      for (const v of requested) {
        await releaseLock(
          resizer,
          dispatchLockKey(
            mediaId,
            getPreviewIdentity(scope, v.sizeKey, v.format, v.filters),
          ),
        );
      }
    }
    return { generated, failedCount, alreadyStored };
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

  // 4. An SVG is rendered ONCE, before anything else touches it, in a child process with a hard
  // time limit, to a lossless raster at the largest scale the pending variants need (capped by
  // the pixel budget and librsvg's side limit). From then on it is a regular image: beforeSteps
  // receive the PNG, never SVG markup they could render in-process without a time limit.
  // procW/procH stay the SVG's own size (fit sizes are computed from it and never exceed it);
  // svgAspect is its real aspect ratio, for derived sides and the cap decision.
  const fromSvg = origMeta.format === 'svg';
  let svgAspect: number | undefined;
  if (fromSvg) {
    const natural = await svgNaturalSize(buf, dispW, dispH, config);
    svgAspect = natural.width / natural.height;
    const largestScale = Math.max(
      1,
      ...pending
        .filter((variant) => !variant.fit)
        .map((variant) =>
          Math.max(
            (variant.requestedWidth ?? 0) / natural.width,
            (variant.requestedHeight ?? 0) / natural.height,
          ),
        ),
    );
    const scale = Math.min(
      Math.max(
        1,
        Math.min(
          largestScale,
          Math.sqrt(pixelBudget / (natural.width * natural.height)),
        ),
      ),
      // librsvg's side limit holds whatever the pixel budget allows (a 1×5000 strip).
      SVG_MAX_SIDE / Math.max(natural.width, natural.height),
    );
    buf = await rasterizeSvg(buf, {
      density: Math.max(1, Math.min(100_000, Math.floor(72 * scale))),
      limitInputPixels: config.limits.inputPixels,
      timeoutMs: config.limits.processingTimeoutSeconds * 1000,
      signal,
      mediaId,
    });
  }

  // 5. beforeSteps — the ordered, awaited chain, ONCE, over display-orientation pixels.
  // Without steps the original is used as downloaded: each variant's `.rotate()` applies the
  // EXIF orientation, so nothing is re-encoded before the variants are made.
  const beforeSteps = pipeline.beforeSteps ?? [];
  let procMeta = fromSvg
    ? await sharp(buf, { limitInputPixels: config.limits.inputPixels })
        .timeout({ seconds: config.limits.processingTimeoutSeconds })
        .metadata()
    : origMeta;
  let procW = dispW;
  let procH = dispH;
  // The SVG sizing rules above apply while the pixels are the SVG's own raster.
  let svgSizing = fromSvg;
  if (beforeSteps.length > 0) {
    // Normalize orientation ONCE so every step sees DISPLAY-orientation pixels (and a step that
    // round-trips sharp() cannot re-strip a live EXIF orientation and desync the result),
    // re-encoded in the same format without visible loss.
    let stepMeta = procMeta;
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

    // Post-beforeSteps metadata. Buffer is already display-oriented → NO swap logic here.
    const after = await sharp(buf, {
      limitInputPixels: config.limits.inputPixels,
    })
      .timeout({ seconds: config.limits.processingTimeoutSeconds })
      .metadata();
    if (
      !fromSvg ||
      after.width !== procMeta.width ||
      after.height !== procMeta.height
    ) {
      // A step that resized the SVG's raster made a new image: from here it is sized by its
      // own pixels, like any raster.
      svgSizing = false;
      svgAspect = undefined;
      procW = after.width ?? dispW;
      procH = after.height ?? dispH;
    }
    procMeta = after;
  }
  if (procW * procH > pixelBudget) {
    throw new ResizeMediaError(
      `resize: processed source exceeds pixel limits for media ${mediaId}`,
      { mediaId, code: 'RESIZE_SOURCE_TOO_LARGE' },
    );
  }

  // Decode ONCE per kind; clone the base per variant so the decode is shared. Formats that
  // cannot hold an animation decode only the first frame (otherwise Sharp stacks every frame
  // into one tall image).
  const decode = (pages: number): Sharp =>
    sharp(buf, {
      failOn: 'none',
      sequentialRead: true,
      limitInputPixels: config.limits.inputPixels,
      pages,
    });
  const frames = framesOf(procMeta, procW, procH);
  const base = decode(1);
  const animatedBase = frames > 1 ? decode(frames) : undefined;

  // Locks held for processed variants; released once after the pool (success AND error).
  const heldLocks = new Set<string>();

  const processVariant = async (v: MissingPreview): Promise<void> => {
    const identity = getPreviewIdentity(scope, v.sizeKey, v.format, v.filters);
    const dispatchKey = dispatchLockKey(mediaId, identity);
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
      // rounded and capped to limits.resultDimension, a derived side included. For an SVG the
      // cap decision uses its real aspect ratio (a 1000×0.6 SVG reads as 1000×1).
      let { width, height } = v.fit
        ? calculateResizedDimensions(
            procW,
            procH,
            undefined,
            undefined,
            true,
            config.maxSize,
          )
        : svgAspect !== undefined
          ? coverDimensions(
              svgAspect,
              1,
              v.requestedWidth,
              v.requestedHeight,
              config.limits.resultDimension,
            )
          : coverDimensions(
              procW,
              procH,
              v.requestedWidth,
              v.requestedHeight,
              config.limits.resultDimension,
            );
      // An SVG's width-only or height-only size under the cap: the other side from the SVG's
      // real aspect ratio, and the raster resized to exactly that box (no crop).
      const svgDerived =
        svgAspect !== undefined &&
        !v.fit &&
        (width === undefined) !== (height === undefined);
      if (svgDerived && svgAspect !== undefined) {
        if (width !== undefined) {
          height = Math.max(1, Math.round(width / svgAspect));
        } else if (height !== undefined) {
          width = Math.max(1, Math.round(height * svgAspect));
        }
      }

      // A raster source that fits inside the requested WxH box is the whole image at its own
      // size: no upscaling and no cropping (only the resultDimension cap may scale it down); the
      // encode strips metadata. Only without variantSteps: a pipeline's steps keep the full box
      // they were written for (a 200×50 watermark cannot be composited onto 150×150).
      const ownSize =
        !svgSizing &&
        !v.fit &&
        (pipeline.variantSteps ?? []).length === 0 &&
        v.requestedWidth !== undefined &&
        v.requestedHeight !== undefined &&
        procW <= Math.round(v.requestedWidth) &&
        procH <= Math.round(v.requestedHeight);
      // Not sharpened when nothing was scaled.
      const unscaled =
        ownSize &&
        (width === undefined || procW <= width) &&
        (height === undefined || procH <= height);

      // Clone the shared decode; `.rotate()` on EVERY branch applies the EXIF orientation;
      // normalize the working colorspace BEFORE variantSteps so composited overlay colors are
      // predictable. An SVG raster is filled into the exact box computed from the SVG itself
      // (its rounded raster aspect ratio would shift an `inside` resize by a pixel).
      const animate = animatedBase !== undefined && isAnimatedFormat(v.format);
      let img = (animate ? animatedBase : base)
        .clone()
        .rotate()
        .resize(
          width,
          height,
          (v.fit && svgSizing) || svgDerived
            ? { fit: 'fill' }
            : v.fit || ownSize
              ? { fit: 'inside', withoutEnlargement: true }
              : { fit: 'cover', position: 'center' },
        )
        .toColorspace('srgb');
      const s = config.encode.sharpen;
      const sharpenOn = s && !unscaled && (v.fit ? s.fit : s.cover);
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
        identity,
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
      // What the database holds now, read once after a failed or partial write: the identities
      // stored on the media, null when the media is gone, undefined when the reload failed too.
      const storedIdentities = async (): Promise<
        Set<string> | null | undefined
      > => {
        try {
          const reloaded = await resizer.db.loadMedia(mediaId);
          return reloaded
            ? new Set(
                (reloaded.previews ?? [])
                  .filter(isUsablePreview)
                  .map(identityOf),
              )
            : null;
        } catch {
          return undefined;
        }
      };
      const stored = await resizer.db
        .appendPreviews(mediaId, generated, backfillDims)
        .catch(async (err: unknown) => {
          // The write may have stopped part-way (a driver can store one row at a time). Name
          // only the uploads no row points at, so an operator can find (or delete) them; a file
          // a stored row references is never offered.
          const recorded = await storedIdentities();
          const unrecorded = recorded
            ? generated.filter((p) => !recorded.has(identityOf(p)))
            : generated;
          logger.error(
            `resize: recording previews failed for media ${mediaId}; ${unrecorded.length} of ${generated.length} uploaded preview(s) are not recorded${recorded === undefined ? ' (the media could not be reloaded to check)' : ''}: storage refs ${describeRefs(unrecorded)}`,
            err,
          );
          throw err;
        });
      // The database keeps one row per identity and reports the rows it stored (nothing = all).
      // The reload says why a row was left out: the media is gone, or another worker stored the
      // same identity first (covered, not a failure).
      if (Array.isArray(stored)) {
        const kept = new Set(stored.map(identityOf));
        const leftOut = generated.filter((p) => !kept.has(identityOf(p)));
        if (leftOut.length > 0) {
          generated = generated.filter((p) => kept.has(identityOf(p)));
          const recorded = await storedIdentities();
          if (recorded === null) {
            logger.warn(
              `resize: media ${mediaId} no longer exists; ${leftOut.length} uploaded preview(s) are not recorded: storage refs ${describeRefs(leftOut)}`,
            );
          } else {
            // A failed reload trusts the database's answer: the rows are another worker's.
            const duplicates = recorded
              ? leftOut.filter((p) => recorded.has(identityOf(p)))
              : leftOut;
            const lost = recorded
              ? leftOut.filter((p) => !recorded.has(identityOf(p)))
              : [];
            if (duplicates.length > 0) {
              logger.warn(
                `resize: ${duplicates.length} preview(s) for media ${mediaId} were already stored by another worker; uploaded but not recorded storage refs: ${describeRefs(duplicates)}`,
              );
              alreadyStored.push(...duplicates.map(identityOf));
            }
            if (lost.length > 0) {
              logger.error(
                `resize: the database left out ${lost.length} preview(s) for media ${mediaId} that it does not hold; uploaded but not recorded storage refs: ${describeRefs(lost)}`,
              );
            }
          }
        }
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

  return { generated, failedCount, alreadyStored };
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
  const { generated, failedCount, alreadyStored } = await generatePreviews(
    resizer,
    {
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
    },
  );

  // 10. A queued task is complete only when every requested identity is now persisted. Re-read
  // once so a worker-lock loser can observe a concurrent worker's write. Our own generated rows
  // are included too: appendPreviews returned successfully before generatePreviews returned,
  // and so are the identities the database reported as already stored by another worker.
  const refreshed = await resizer.db.loadMedia(task.mediaId);
  if (!refreshed) {
    logger.info(
      `resize worker: media ${task.mediaId} was deleted while processing — no-op complete`,
    );
    return;
  }
  const covered = new Set<string>(alreadyStored);
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
