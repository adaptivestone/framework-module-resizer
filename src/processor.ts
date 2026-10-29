// The resize core: ONE sharp pipeline shared by both generation modes, owned by `Processor`:
//   - processTask() = the core for one queued task, run by the worker
//   - generate()    = the core for eager `resizer.generate`
// The steps (download once → metadata guards → an SVG rendered once to a raster → beforeSteps
// once, after an orientation normalize → decode once + bounded per-variant resize/encode/upload →
// one appendPreviews) live in #generatePreviews(); the persist step and its reconciliation of
// what the media store kept are a PreviewRecorder's (previewRecorder.ts), and the Processor fires
// onPreviewGenerated over the rows it kept. The Processor also fires the task observers,
// and invalidate() removes stored previews for `resizer.invalidate` (one media store write).
// It takes no locks: the queue leases a task to one worker at a time, the lease token fences the
// task's writes, and the media store keeps one row per preview identity when an expired lease lets
// two workers render the same variant. It takes its parts explicitly and knows no Resizer. sharp
// is a hard dep; this is the only module that resizes or encodes (SVG rendering runs in a child
// process: helpers/svgRaster.ts).
import sharp, {
  type FormatEnum,
  type Metadata,
  type OutputOptions,
  type Sharp,
} from 'sharp';
import type { Catalog } from './catalog.ts';
import type { ObserverName } from './contracts/hooks.ts';
import type { MediaStore, ReplacedPreviews } from './contracts/media.ts';
import type { ResizeStorage } from './contracts/storage.ts';
import type { LeasedTask, TaskEvent } from './contracts/taskQueue.ts';
import {
  ResizeGenerateError,
  ResizeMediaError,
  ResizeNoOriginalError,
  ResizeSetupError,
  ResizeStorageError,
} from './errors.ts';
import { runBounded } from './helpers/concurrency.ts';
import { isAnimatedFormat, isAvifBuffer } from './helpers/imageFormat.ts';
import { logNeverThrow } from './helpers/log.ts';
import { randomHex } from './helpers/random.ts';
import { svgNaturalSize, svgRasterDensity } from './helpers/svgDimensions.ts';
import { rasterizeSvg } from './helpers/svgRaster.ts';
import type { HookBus } from './hooks.ts';
import {
  calculateResizedDimensions,
  coverDimensions,
  previewScope,
  requireMediaId,
} from './images.ts';
import type { PipelineRegistry } from './pipelines.ts';
import { PreviewRecorder } from './previewRecorder.ts';
import { encodeSignature, previewOrigin } from './signatures.ts';
import type {
  GenerateOpts,
  GenerateResult,
  InvalidateOpts,
  MediaLike,
  MissingPreview,
  Preview,
  PreviewScope,
  ResizeConfig,
  ResizeLogger,
  SizeInput,
  StorageRef,
} from './types.d.ts';

/** Normalize a driver download / beforeStep result to a Node Buffer for the next sharp(). */
const asBuffer = (b: Buffer | Uint8Array): Buffer =>
  Buffer.isBuffer(b) ? b : Buffer.from(b);

/**
 * An unregistered pipeline must not render: its previews would be stored under that pipeline's
 * identity without its steps, and `resolve` would serve them for good (a renamed watermark
 * pipeline during a rolling deploy would lose its watermark). `default` always exists.
 */
function requirePipeline(
  pipelines: PipelineRegistry,
  resizerName: string,
  name: string,
): void {
  if (!pipelines.has(name)) {
    throw new ResizeSetupError(
      `resize: pipeline '${name}' is not registered on Resizer '${resizerName}' — register it in every process that generates previews (API and worker) before using it`,
      { code: 'RESIZE_PIPELINE_UNKNOWN' },
    );
  }
}

/**
 * A media store written before replacePreviews existed cannot remove rows. invalidate() and the
 * Resizer's verify() check it, with one message.
 */
export function requireReplacePreviews(media: MediaStore): void {
  if (typeof media.replacePreviews !== 'function') {
    throw new ResizeSetupError(
      'resize: the media store has no replacePreviews(mediaId, identities, rows) — a custom MediaStore needs it since 0.3.0',
      { code: 'RESIZE_MEDIA_REPLACE_MISSING' },
    );
  }
}

/** A replacePreviews result the core can read: an object with the two lists of rows. */
function isReplacedPreviews(result: unknown): result is ReplacedPreviews {
  if (typeof result !== 'object' || result === null) {
    return false;
  }
  const { stored, removed } = result as Partial<ReplacedPreviews>;
  return Array.isArray(stored) && Array.isArray(removed);
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

// The observer each task event fires.
const OBSERVER: Record<TaskEvent, ObserverName> = {
  completed: 'afterTaskComplete',
  failed: 'onTaskFailed',
  deadLettered: 'onTaskDeadLettered',
};

// ---------------------------------------------------------------------------
// The shared core. Both modes expand their inputs into a `requested` MissingPreview[] and call
// #generatePreviews. `persist` toggles the single appendPreviews + onPreviewGenerated firing
// (eager `persist:false` returns raw).
// ---------------------------------------------------------------------------

interface GenerateCoreArgs {
  media: MediaLike;
  mediaId: string;
  requested: MissingPreview[];
  pipeline: string;
  ctx: Record<string, unknown>;
  persist: boolean;
  signal?: AbortSignal;
}

interface GenerateCoreResult {
  // Previews this call stored (or, with persist:false, produced).
  generated: Preview[];
  failedCount: number;
  // Identities the media store already held from another worker: covered, not failed.
  alreadyStored: string[];
}

export interface ProcessorDeps {
  catalog: Catalog;
  media: MediaStore;
  storage: ResizeStorage;
  pipelines: PipelineRegistry;
  hooks: HookBus;
  config: ResizeConfig;
  logger: ResizeLogger;
  name: string; // the Resizer's name: part of every preview identity
}

/**
 * Renders the previews of one Resizer: eagerly for a caller, or for one queued task. Also fires
 * the task observers and removes stored previews.
 */
export class Processor {
  readonly #deps: ProcessorDeps;
  readonly #recorder: PreviewRecorder;

  constructor(deps: ProcessorDeps) {
    this.#deps = deps;
    this.#recorder = new PreviewRecorder({
      catalog: deps.catalog,
      media: deps.media,
      logger: deps.logger,
    });
  }

  /**
   * Eager mode: the core for a caller. The caller's real ctx reaches the resolveSizes waterfall
   * and the pipeline steps (unlike a queued task's ctx === {}). `persist !== false` → one
   * appendPreviews (+ display-dim backfill), and the rows are appended onto `media.previews` too;
   * otherwise the previews are returned unstored.
   */
  async generate(opts: GenerateOpts): Promise<GenerateResult> {
    const { catalog, config, hooks, name, pipelines } = this.#deps;
    const ctx = opts.ctx ?? {};
    const { media } = opts;
    const pipeline = opts.pipeline ?? 'default';
    // Eager mode is host-facing: a media with no id/_id is a caller bug → throw a named error
    // rather than silently keying on the literal 'undefined'.
    const mediaId = requireMediaId(media);

    const original = media.original;
    if (original?.storageRef == null) {
      throw new ResizeNoOriginalError(mediaId);
    }
    // Caller bugs fail before any host hook, download or decode.
    requirePipeline(pipelines, name, pipeline);
    const formats = opts.formats ?? config.formats;
    const { dropped } = catalog.configuredFormats(formats);
    if (dropped.length > 0) {
      throw formatNotConfiguredError(dropped);
    }

    // Host size magic (real ctx in eager mode).
    const sizes = (await hooks.runWaterfall(
      'resolveSizes',
      opts.sizes,
      ctx,
    )) as SizeInput[];

    // Expand sizes × formats; skip unbuildable sizes + existing identities (idempotent).
    const requested = catalog.missing(media, sizes, formats, {
      resizer: name,
      pipeline,
    });

    const persist = opts.persist !== false;
    const { generated, failedCount } = await this.#generatePreviews({
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

  /**
   * Remove this Resizer's stored previews of a media, of one pipeline or of all, in one media store
   * write, and resolve with the storage refs of the rows it removed. The rows are picked from the
   * media as the store holds it, and only rows with a stored identity are removed: the store
   * removes rows by it, and a row stored before rows carried one has none. The pipeline need not
   * be registered, so the rows of a renamed pipeline can still be removed.
   */
  async invalidate(opts: InvalidateOpts): Promise<StorageRef[]> {
    const { logger, media: mediaStore, name } = this.#deps;
    const mediaId = requireMediaId(opts.media);
    const media = await mediaStore.loadMedia(mediaId);
    if (!media) {
      return [];
    }
    const identities = new Set<string>();
    for (const row of media.previews ?? []) {
      const scope = previewScope(row);
      if (
        typeof row.identity === 'string' &&
        scope.resizer === name &&
        (opts.pipeline === undefined || scope.pipeline === opts.pipeline)
      ) {
        identities.add(row.identity);
      }
    }
    if (identities.size === 0) {
      return [];
    }
    requireReplacePreviews(mediaStore);
    const result: unknown = await mediaStore.replacePreviews(
      mediaId,
      [...identities],
      [],
    );
    if (!isReplacedPreviews(result)) {
      throw new ResizeSetupError(
        "resize: the media store's replacePreviews resolved with something other than { stored, removed } — resolve with the rows it stored and removed ([] when none)",
        { code: 'RESIZE_MEDIA_REPLACE_RESULT_INVALID' },
      );
    }
    // Off the caller's in-memory doc too, so a same-request resolve() does not serve the rows. The
    // store has already removed them, so an array that cannot be changed (a frozen one, say) is
    // only logged, and through logNeverThrow, so a throwing logger cannot lose them either: the
    // refs are the host's only record of the removed objects.
    try {
      const previews = opts.media.previews;
      if (Array.isArray(previews)) {
        for (let i = previews.length - 1; i >= 0; i -= 1) {
          const identity = previews[i]?.identity;
          if (typeof identity === 'string' && identities.has(identity)) {
            previews.splice(i, 1);
          }
        }
      }
    } catch (err) {
      logNeverThrow(
        logger,
        `resize: invalidate removed previews of media ${mediaId} from the media store but could not take them off the caller's media.previews, so a same-request resolve() may still serve them`,
        err,
        'warn',
      );
    }
    return result.removed.map((row) => row.storageRef);
  }

  /**
   * One queued task: the core, then a check that every requested identity is stored. The worker
   * loop (src/consumer.ts) runs it through the worker; it SUCCEEDS by returning and FAILS by
   * throwing (which engages the queue's retry → dead-letter). It takes no locks: the lease keeps
   * the task to one worker at a time, and the media store keeps one row per preview identity.
   */
  async processTask(
    task: LeasedTask,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const { catalog, logger, media: mediaStore, name } = this.#deps;
    // ctx does NOT cross the queue — the worker's pipeline steps depend on media/metadata.
    const ctx: Record<string, unknown> = {};

    // Load the media doc. A deleted media row is a logged no-op success (the queue completes it),
    // but a live row whose persisted original is absent/malformed is a terminal media error. In
    // particular, `{ original: {} }` must not reach storage.download: it has no usable locator and
    // retrying it cannot make the source appear.
    const media = await mediaStore.loadMedia(task.mediaId);
    if (!media) {
      logger.info(
        `resize worker: media ${task.mediaId} missing (no doc) — no-op complete`,
      );
      return;
    }
    if (media.original?.storageRef == null) {
      throw new ResizeNoOriginalError(task.mediaId);
    }
    const scope: PreviewScope = { resizer: name, pipeline: task.pipeline };
    const requestedByIdentity = new Map<string, MissingPreview>();
    for (const preview of catalog.canonicalize(task.previews)) {
      const identity = catalog.identity(scope, preview);
      if (!requestedByIdentity.has(identity)) {
        requestedByIdentity.set(identity, preview);
      }
    }
    const requested = [...requestedByIdentity.values()];
    const { generated, failedCount, alreadyStored } =
      await this.#generatePreviews({
        media,
        mediaId: task.mediaId,
        requested,
        pipeline: task.pipeline,
        ctx,
        persist: true,
        signal: opts.signal,
      });

    // A queued task is complete only when every requested identity is now persisted. Re-read once
    // so the rows of a concurrent worker running the same task (after an expired lease) count: a
    // variant that failed here may be stored there. Our own generated rows are included too:
    // appendPreviews returned successfully before #generatePreviews returned, and so are the
    // identities the media store reported as already stored by another worker.
    const refreshed = await mediaStore.loadMedia(task.mediaId);
    if (!refreshed) {
      logger.info(
        `resize worker: media ${task.mediaId} was deleted while processing — no-op complete`,
      );
      return;
    }
    const covered = new Set<string>([
      ...alreadyStored,
      ...catalog.storedIdentities(
        {
          previews: [
            ...(media.previews ?? []),
            ...(refreshed.previews ?? []),
            ...generated,
          ],
        },
        scope,
      ),
    ]);
    const missing = requested.filter(
      (preview) => !covered.has(catalog.identity(scope, preview)),
    );
    if (missing.length > 0) {
      const missingIdentities = missing.map((preview) =>
        catalog.identity(scope, preview),
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

  /**
   * Fire the observer of a task event (afterTaskComplete, onTaskFailed, onTaskDeadLettered) with
   * ctx {}: ctx does not cross the queue. A completed task's observer gets no error.
   */
  async notify(
    event: TaskEvent,
    task: LeasedTask,
    error?: unknown,
  ): Promise<void> {
    const { hooks } = this.#deps;
    if (event === 'completed') {
      await hooks.runObservers(OBSERVER[event], task, {});
    } else {
      await hooks.runObservers(OBSERVER[event], task, error, {});
    }
  }

  async #generatePreviews(args: GenerateCoreArgs): Promise<GenerateCoreResult> {
    const {
      media,
      mediaId,
      requested,
      pipeline: pipelineName,
      ctx,
      persist,
      signal,
    } = args;
    const { catalog, config, hooks, logger, name, pipelines, storage } =
      this.#deps;

    // Before any download or decode, in both modes; the queue retries it like any failure.
    requirePipeline(pipelines, name, pipelineName);

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

    // Existing-preview set (the DB check that makes re-runs idempotent). Stored previews keep
    // their own scope, so another pipeline's rendering never counts as done here.
    const scope: PreviewScope = { resizer: name, pipeline: pipelineName };
    // The identity of a requested variant or a generated row (both belong to `scope`).
    const scopedIdentity = (v: MissingPreview | Preview): string =>
      catalog.identity(scope, v);
    const existing = catalog.storedIdentities(media, scope);
    const pending = requested.filter((v) => !existing.has(scopedIdentity(v)));
    // Everything requested is already stored: no download.
    if (pending.length === 0) {
      return { generated, failedCount, alreadyStored };
    }

    // Download the original ONCE.
    let buf = asBuffer(await storage.download(original.storageRef));

    // Metadata + decode-bomb guards. EVERY worker sharp() call carries limitInputPixels, so an
    // oversized-for-inputPixels source is rejected consistently at this first probe rather than
    // slipping through to a per-variant decode.
    const origMeta = await sharp(buf, {
      limitInputPixels: config.limits.inputPixels,
    })
      .timeout({ seconds: config.limits.processingTimeoutSeconds })
      .metadata();
    if (origMeta.width === undefined || origMeta.height === undefined) {
      throw new ResizeMediaError(
        `resize: source metadata missing width/height for media ${mediaId} — cannot size safely`,
        { mediaId, code: 'RESIZE_SOURCE_METADATA_MISSING', retryable: false },
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
        { mediaId, code: 'RESIZE_SOURCE_TOO_LARGE', retryable: false },
      );
    }
    const pixelBudget = Math.min(
      config.limits.sourcePixels,
      config.limits.inputPixels,
    );

    // The dimensions the media holds: the stored pair, or, when the original never recorded it,
    // the measured display size (which the persist below backfills). Every row's origin is signed
    // with them, persisted or not, so the rows of one original always share one origin.
    const storedDims =
      original.width !== undefined && original.height !== undefined
        ? { width: original.width, height: original.height }
        : undefined;
    const mediaDims = storedDims ?? { width: dispW, height: dispH };
    const origin = previewOrigin(original.storageRef, mediaDims);

    const pipeline = pipelines.get(pipelineName);
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
    const framesOf = (
      meta: Metadata,
      frameW: number,
      frameH: number,
    ): number =>
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

    // An SVG is rendered ONCE, before anything else touches it, in a child process with a hard
    // time limit, to a lossless raster at the largest scale the pending variants need (capped by
    // the pixel budget and librsvg's side limit). From then on it is a regular image: beforeSteps
    // receive the PNG, never SVG markup they could render in-process without a time limit.
    // procW/procH stay the SVG's own size (fit sizes are computed from it and never exceed it);
    // svgAspect is its real aspect ratio, for derived sides and the cap decision.
    const fromSvg = origMeta.format === 'svg';
    let svgAspect: number | undefined;
    if (fromSvg) {
      const natural = await svgNaturalSize(
        buf,
        dispW,
        dispH,
        config.limits.inputPixels,
        config.limits.processingTimeoutSeconds,
      );
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
      const density = await svgRasterDensity(
        buf,
        natural.width,
        natural.height,
        {
          pixelBudget,
          inputPixels: config.limits.inputPixels,
          timeoutSeconds: config.limits.processingTimeoutSeconds,
          largestScale,
        },
      );
      if (density === undefined) {
        throw new ResizeMediaError(
          `resize: SVG dimensions cannot be rasterized within the renderer limits for media ${mediaId}`,
          {
            mediaId,
            code: 'RESIZE_SVG_DIMENSIONS_UNSUPPORTED',
            retryable: false,
          },
        );
      }
      buf = await rasterizeSvg(buf, {
        density,
        limitInputPixels: config.limits.inputPixels,
        timeoutMs: config.limits.processingTimeoutSeconds * 1000,
        signal,
        mediaId,
      });
    }

    // beforeSteps — the ordered, awaited chain, ONCE, over display-orientation pixels.
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
        { mediaId, code: 'RESIZE_SOURCE_TOO_LARGE', retryable: false },
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

    const processVariant = async (v: MissingPreview): Promise<void> => {
      const identity = scopedIdentity(v);
      try {
        // A task payload can name any format; only configured encoders run (no sharp work here).
        const { dropped } = catalog.configuredFormats([v.format]);
        if (dropped.length > 0) {
          throw formatNotConfiguredError(dropped);
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
        const animate =
          animatedBase !== undefined && isAnimatedFormat(v.format);
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
          resizer: name,
          pipeline: pipelineName,
          sizeKey: v.sizeKey,
          format: v.format,
          contentType,
          // One frame: an animated output reports the height of all frames stacked.
          actualWidth: info.width,
          actualHeight: info.pageHeight ?? info.height,
          bytes: data.length,
          createdAt: new Date(),
          origin,
          encodeSig: encodeSignature(config, {
            format: v.format,
            fit: v.fit === true,
            version: pipeline.version,
          }),
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
        // One bad variant must not fail the whole task; the caller decides what the failures mean.
        logger.error(
          `resize worker: variant ${identity} failed for media ${mediaId}`,
          err,
        );
        failedCount += 1;
      }
    };

    // Bounded pool over the variants not stored yet (NOT unbounded Promise.all); between variants
    // stop launching new ones if the lease was lost (best-effort — correctness holds via the
    // fencing token).
    await runBounded(pending, config.concurrency, signal, processVariant);

    // ONE atomic persist for everything generated (+ display-dim backfill when the original
    // never carried dims; previewRecorder.ts), then fire onPreviewGenerated per stored preview
    // (ctx {}).
    if (persist && generated.length > 0) {
      const backfillDims = storedDims === undefined ? mediaDims : undefined;
      const recorded = await this.#recorder.record(
        mediaId,
        scope,
        generated,
        backfillDims,
      );
      generated = recorded.stored;
      alreadyStored.push(...recorded.alreadyStored);
      for (const preview of generated) {
        await hooks.runObservers('onPreviewGenerated', preview, {});
      }
    }

    return { generated, failedCount, alreadyStored };
  }
}
