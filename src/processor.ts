// The resize core, owned by `Processor`, shared by both generation modes:
//   - processTask() = the core for one queued task, run by the worker
//   - generate()    = the core for eager `resizer.generate`
// #renderPending() renders the variants not stored fresh yet (a stored row made with other settings
// or from another original is stale, and is rendered again): download the original once; a decoder
// identifies its bytes and renders them ONCE, at the largest box the plan needs; beforeSteps run
// once on that raster, which is then reduced to the box of the plan made from their result; each
// exact size is resized once and each format encoded from it, then uploaded (bounded by
// config.concurrency); one PreviewRecorder persist appends the new rows and replaces the stale ones
// in one write each, and onPreviewGenerated fires over the rows it kept. The sizes come from the
// pure plan (plan.ts), the pixel work from render.ts, and a source kind needs only a decoder: the
// Processor itself imports no image engine. It also fires the task observers, and invalidate()
// removes stored previews for `resizer.invalidate` (one media store write). It takes no locks: the
// queue leases a task to one worker at a time, the lease token fences the task's writes, and the
// media store keeps one row per preview identity when an expired lease lets two workers render the
// same variant. Each variant is timed from its encode to the end
// of its upload and recorded on the metrics sink once the persist says what became of it. It takes
// its parts explicitly and knows no Resizer.
import type { Catalog } from './catalog.ts';
import type {
  DecodeBox,
  Raster,
  RenderOptions,
  SourceDecoder,
  SourceInfo,
} from './contracts/decoder.ts';
import type { ObserverName } from './contracts/hooks.ts';
import type { MediaStore } from './contracts/media.ts';
import type { ResizeMetrics } from './contracts/metrics.ts';
import type { ResizeStorage } from './contracts/storage.ts';
import type { LeasedTask, TaskEvent } from './contracts/taskQueue.ts';
import type { DecoderSet, IdentifiedSource } from './decoderSet.ts';
import {
  ResizeError,
  ResizeGenerateError,
  ResizeMediaError,
  ResizeNoOriginalError,
  ResizeSetupError,
  ResizeStorageError,
} from './errors.ts';
import { storedDims } from './freshness.ts';
import { runBounded } from './helpers/concurrency.ts';
import { hasErrorClass } from './helpers/errorClass.ts';
import { logNeverThrow } from './helpers/log.ts';
import { randomHex } from './helpers/random.ts';
import type { HookBus } from './hooks.ts';
import { previewScope, requireMediaId } from './images.ts';
import { errorCodeLabel, NoopMetrics } from './metrics.ts';
import type { PipelineRegistry } from './pipelines.ts';
import {
  decodeBox,
  framesToDecode,
  groupBySize,
  planRules,
  planVariants,
  type VariantPlan,
} from './plan.ts';
import {
  checkReplaced,
  PreviewRecorder,
  requireReplacePreviews,
} from './previewRecorder.ts';
import { checkRaster } from './raster.ts';
import {
  type EncodedVariant,
  encodeVariant,
  reduceToBox,
  runBeforeSteps,
  SizedRasters,
  straightAlpha,
} from './render.ts';
import { previewOrigin } from './signatures.ts';
import type {
  GenerateOpts,
  GenerateResult,
  InvalidateOpts,
  MediaLike,
  MissingPreview,
  Original,
  Preview,
  PreviewScope,
  ResizeConfig,
  ResizeLimits,
  ResizeLogger,
  SizeInput,
  StorageRef,
} from './types.d.ts';

/** Normalize a driver download to a Node Buffer for the decoder. */
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

/** A per-call argument names an unconfigured format: a wiring error at the call site. */
function formatNotConfiguredError(formats: string[]): ResizeSetupError {
  return new ResizeSetupError(
    `resize: formats [${formats.join(', ')}] have no encode.formats entry — request configured Sharp format ids such as 'jpeg', not aliases such as 'jpg'`,
    { code: 'RESIZE_FORMAT_NOT_CONFIGURED' },
  );
}

const MEDIA_ERROR: ReadonlySet<string> = new Set(['ResizeMediaError']);

/** A module media error (or a subclass of one, told by name) that does not know its media yet. */
function lacksMediaId(err: unknown): err is ResizeMediaError {
  return (
    ResizeError.isResizeError(err) &&
    hasErrorClass(err, MEDIA_ERROR) &&
    fieldOf(err, 'mediaId') === undefined
  );
}

/**
 * The media error, naming its media. The error itself gets the media id (and its message the id),
 * so its class, private state and methods stay as they are. An error that cannot take it (frozen,
 * sealed, a read-only field, a host setter or getter that throws) is wrapped instead: a plain
 * ResizeMediaError with its code and `retryable`, and the error as its cause.
 */
function withMediaId(err: ResizeMediaError, mediaId: string): ResizeMediaError {
  try {
    if (Reflect.set(err, 'mediaId', mediaId) && err.mediaId === mediaId) {
      Reflect.set(err, 'message', `${err.message} (media ${mediaId})`);
      return err;
    }
  } catch {
    // The host's own accessor threw: the error is wrapped below, whatever it was.
  }
  const message = fieldOf(err, 'message');
  const code = fieldOf(err, 'code');
  const retryable = fieldOf(err, 'retryable');
  return new ResizeMediaError(
    `${typeof message === 'string' ? message : 'resize: the decoder refused the source'} (media ${mediaId})`,
    {
      mediaId,
      ...(typeof code === 'string' ? { code } : {}),
      ...(typeof retryable === 'boolean' ? { retryable } : {}),
      cause: err,
    },
  );
}

/** A field of a host error, or undefined when reading it throws. */
function fieldOf(err: object, key: string): unknown {
  try {
    return Reflect.get(err, key);
  } catch {
    return undefined;
  }
}

/**
 * A decode failure as the task reports it: a module error that does not know its media gets the
 * media id (the decoders do not know it), any other module error stays as it is, and anything else
 * is RESIZE_SOURCE_DECODE_FAILED with the original error as its cause (retried).
 */
function sourceError(err: unknown, mediaId: string): unknown {
  if (lacksMediaId(err)) {
    return withMediaId(err, mediaId);
  }
  if (ResizeError.isResizeError(err)) {
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ResizeMediaError(
    `resize: decoding the source failed for media ${mediaId}: ${message}`,
    { mediaId, code: 'RESIZE_SOURCE_DECODE_FAILED', cause: err },
  );
}

/** The original's bytes, the decoder that reads them, and what it measured. */
interface LoadedSource {
  bytes: Buffer;
  decoder: SourceDecoder;
  info: SourceInfo;
}

/**
 * A deep copy of a storage locator for the storage driver, so a locator the host changes in place
 * does not change the download or the upload's parent. A Mongoose sub-document is copied through
 * its plain form (`toObject()`).
 */
function copyLocator(ref: StorageRef): StorageRef {
  const plain =
    typeof (ref as { toObject?: unknown } | null)?.toObject === 'function'
      ? (ref as { toObject(): unknown }).toObject()
      : ref;
  try {
    return structuredClone(plain);
  } catch {
    // A locator structuredClone cannot copy (one holding a function, say) is kept as it is: the
    // driver then reads it live, as it did before it was copied. The origin is signed from
    // signedLocator(), never from this copy.
    return plain;
  }
}

/**
 * The locator in the form the origin signature reads (its JSON form, `toJSON()` included), taken
 * now. Signing this form gives exactly what the read path computes from the live locator, and a
 * JSON form cannot change in place or fail to copy.
 */
function signedLocator(ref: StorageRef): StorageRef {
  return JSON.parse(JSON.stringify(ref)) as StorageRef;
}

/**
 * What a render reads of the original, taken once: `original` holds the driver's copy of the
 * locator (download and upload parent), `signed` the same original with the locator in the form
 * every signature of this render is computed from.
 */
function snapshotOriginal(original: Original): {
  original: Original;
  signed: Original;
} {
  const { format, width, height } = original;
  const rest = {
    ...(format === undefined ? {} : { format }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
  return {
    original: { storageRef: copyLocator(original.storageRef), ...rest },
    signed: { storageRef: signedLocator(original.storageRef), ...rest },
  };
}

/**
 * Download the original once and identify its bytes. The detected format is the truth: a stored
 * format that does not match is logged once and the bytes are rendered as what they are. One frame
 * must fit `limits.sourcePixels`; how many frames are decoded is bounded by the plan.
 */
async function loadSource(
  parts: {
    storage: ResizeStorage;
    decoders: DecoderSet;
    limits: ResizeLimits;
    logger: ResizeLogger;
  },
  original: Original,
  mediaId: string,
): Promise<LoadedSource> {
  const { storage, decoders, limits, logger } = parts;
  const bytes = asBuffer(await storage.download(original.storageRef));
  let identified: IdentifiedSource;
  try {
    identified = await decoders.identify(bytes, limits, original.format);
  } catch (err) {
    throw sourceError(err, mediaId);
  }
  const { decoder, info, mismatch } = identified;
  if (mismatch !== undefined) {
    if (info.format === mismatch.stored) {
      // A host decoder lists a built-in format and refused these bytes; a later decoder read them.
      logger.warn(
        `resize worker: media ${mediaId} is stored as '${mismatch.stored}'; the first decoder listing '${mismatch.stored}' refused these bytes, and another decoder read them`,
      );
    } else {
      const why =
        mismatch.reason === 'unlisted'
          ? 'no decoder lists the stored format'
          : mismatch.reason === 'refused'
            ? 'its decoder refused the bytes'
            : 'its decoder read another of its formats';
      logger.warn(
        `resize worker: media ${mediaId} is stored as '${mismatch.stored}' but its bytes are '${info.format}' (${why}); rendering it as '${info.format}'`,
      );
    }
  }
  if (info.width * info.height > limits.sourcePixels) {
    throw new ResizeMediaError(
      `resize: source ${info.width}×${info.height} exceeds limits.sourcePixels (${limits.sourcePixels}) for media ${mediaId}`,
      { mediaId, code: 'RESIZE_SOURCE_TOO_LARGE', retryable: false },
    );
  }
  return { bytes, decoder, info };
}

/** The decoder's raster at `box`, checked (shape and pixel budget), in straight alpha. */
async function decodeSource(
  source: LoadedSource,
  box: DecodeBox,
  opts: RenderOptions,
  mediaId: string,
): Promise<Raster> {
  try {
    const raster = await source.decoder.render(source.bytes, box, opts);
    // A broken raster is the decoder's contract error: sourceError passes it on unchanged.
    checkRaster(raster);
    // A decoder that ignores its box or decodes more frames than asked must not hand the core more
    // pixels than the budget the plan was made for.
    const { width, height, frames = 1 } = raster.info;
    const budget = Math.min(opts.limits.sourcePixels, opts.limits.inputPixels);
    if (width * height * frames > budget) {
      throw new ResizeMediaError(
        `resize: the decoder returned ${width}×${height}×${frames} pixels, over the pixel budget (${budget}) for media ${mediaId}`,
        { mediaId, code: 'RESIZE_SOURCE_TOO_LARGE', retryable: false },
      );
    }
    return await straightAlpha(raster, opts.limits);
  } catch (err) {
    throw sourceError(err, mediaId);
  }
}

/** The stored row of one encoded and uploaded variant. */
function previewRow(
  plan: VariantPlan,
  encoded: EncodedVariant,
  storageRef: StorageRef,
  stamp: { scope: PreviewScope; origin: string; encodeSig: string },
): Preview {
  const v = plan.variant;
  const row: Preview = {
    storageRef,
    identity: plan.identity,
    resizer: stamp.scope.resizer,
    pipeline: stamp.scope.pipeline,
    sizeKey: v.sizeKey,
    format: v.format,
    contentType: encoded.contentType,
    // One frame: the encoder reports an animation's frame height.
    actualWidth: encoded.width,
    actualHeight: encoded.height,
    bytes: encoded.data.length,
    createdAt: new Date(),
    origin: stamp.origin,
    encodeSig: stamp.encodeSig,
  };
  if (v.filters) {
    row.filters = v.filters;
  }
  if (v.requestedWidth !== undefined) {
    row.requestedWidth = Math.round(v.requestedWidth);
  }
  if (v.requestedHeight !== undefined) {
    row.requestedHeight = Math.round(v.requestedHeight);
  }
  // The rule that signs the row (catalog.encodeSig): only `true` makes a fit row.
  if (v.fit === true) {
    row.fit = true;
  }
  return row;
}

// The observer each task event fires.
const OBSERVER: Record<TaskEvent, ObserverName> = {
  completed: 'afterTaskComplete',
  failed: 'onTaskFailed',
  deadLettered: 'onTaskDeadLettered',
};

// ---------------------------------------------------------------------------
// The shared core. Both modes expand their inputs into a `requested` MissingPreview[] and call
// #renderPending. `persist` toggles the single appendPreviews + onPreviewGenerated firing
// (eager `persist:false` returns raw).
// ---------------------------------------------------------------------------

interface RenderPendingArgs {
  media: MediaLike;
  mediaId: string;
  requested: MissingPreview[];
  pipeline: string;
  ctx: Record<string, unknown>;
  persist: boolean;
  signal?: AbortSignal;
  mode: 'task' | 'eager'; // how the variants are recorded on the metrics sink
  taskId?: string; // the queued task's id, in task mode
}

interface RenderPendingResult {
  // Previews this call stored (or, with persist:false, produced).
  generated: Preview[];
  failedCount: number;
  // The stored rows the persist replaced (outdated, or a concurrent row of the same identity), and
  // the identities of the stored previews that replaced them.
  removed: Preview[];
  replaced: Set<string>;
  // The size every row was signed with, once the original was measured.
  originDims?: { width: number; height: number };
  // The dimensions the persist recorded on a media that had none stored.
  backfilled?: { width: number; height: number };
}

export interface ProcessorDeps {
  catalog: Catalog;
  media: MediaStore;
  storage: ResizeStorage;
  decoders: DecoderSet; // reads the originals: one decode per task
  pipelines: PipelineRegistry;
  hooks: HookBus;
  config: ResizeConfig;
  logger: ResizeLogger;
  name: string; // the Resizer's name: part of every preview identity
  // Where each variant is recorded (a Resizer passes its bound sink); default: nothing is recorded.
  metrics?: ResizeMetrics;
}

const noMetrics = new NoopMetrics();

/**
 * Renders the previews of one Resizer: eagerly for a caller, or for one queued task. Also fires
 * the task observers and removes stored previews.
 */
export class Processor {
  readonly #deps: ProcessorDeps;
  readonly #recorder: PreviewRecorder;
  readonly #metrics: ResizeMetrics;
  // Pipelines whose task found every requested preview already fresh: warned once each.
  readonly #warnedAllFresh = new Set<string>();
  // Whether a media store that dropped the dimension backfill was warned about.
  #warnedBackfill = false;

  constructor(deps: ProcessorDeps) {
    this.#deps = deps;
    this.#metrics = deps.metrics ?? noMetrics;
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

    // Expand sizes × formats; skip unbuildable sizes + fresh stored identities (idempotent).
    const requested = catalog.missing(media, sizes, formats, {
      resizer: name,
      pipeline,
    });

    const persist = opts.persist !== false;
    const { generated, failedCount, removed, replaced, backfilled } =
      await this.#renderPending({
        media,
        mediaId,
        requested,
        pipeline,
        ctx,
        persist,
        mode: 'eager',
      });

    // When the call throws, the caller's media keeps no dimensions, even if the store recorded them.
    if (requested.length > 0 && generated.length === 0 && failedCount > 0) {
      throw new ResizeGenerateError({
        mediaId,
        failed: failedCount,
        requested: requested.length,
      });
    }

    // The store appended and replaced the rows; the caller's in-memory doc gets the same swap (the
    // rows of a replaced identity leave, the new rows are appended), so a same-request resolve()
    // sees the new rows without a reload.
    if (persist && generated.length > 0) {
      media.previews = [
        ...(media.previews ?? []).filter(
          (row) =>
            !(typeof row.identity === 'string' && replaced.has(row.identity)),
        ),
        ...generated,
      ];
    }
    if (backfilled) {
      this.#setDims(media, mediaId, backfilled);
    }

    return {
      created: generated,
      failed: failedCount,
      ...(removed.length > 0
        ? { replaced: removed.map((row) => row.storageRef) }
        : {}),
    };
  }

  /**
   * The dimensions the persist recorded, set on the caller's in-memory original too, so a
   * same-request resolve() can prove the new rows fresh. The store has them already, so an
   * original that cannot be changed (a frozen one, say) is only logged.
   */
  #setDims(
    media: MediaLike,
    mediaId: string,
    dims: { width: number; height: number },
  ): void {
    try {
      const original = media.original as Original;
      original.width = dims.width;
      original.height = dims.height;
    } catch (err) {
      logNeverThrow(
        this.#deps.logger,
        `resize: generate() recorded the original's dimensions of media ${mediaId} in the media store but could not set them on the caller's media.original, so a same-request resolve() finds its previews stale`,
        err,
        'warn',
      );
    }
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
    const result = checkReplaced(
      await mediaStore.replacePreviews(mediaId, [...identities], []),
    );
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
   * One queued task: the core, then a check that every requested identity is stored fresh. The
   * worker loop (src/consumer.ts) runs it through the worker; it SUCCEEDS by returning and FAILS by
   * throwing (which engages the queue's retry → dead-letter). It takes no locks: the lease keeps
   * the task to one worker at a time, and the media store keeps one row per preview identity.
   */
  async processTask(
    task: LeasedTask,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const { catalog, logger, media: mediaStore, name } = this.#deps;
    // ctx does NOT cross the queue — the worker's pipeline steps depend on media/source.
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
    this.#warnIfAllFresh(task, media, scope, requested);
    const { generated, failedCount, originDims, backfilled } =
      await this.#renderPending({
        media,
        mediaId: task.mediaId,
        requested,
        pipeline: task.pipeline,
        ctx,
        persist: true,
        signal: opts.signal,
        mode: 'task',
        taskId: task.taskId,
      });

    // A queued task is complete only when every requested identity is now persisted fresh. Re-read
    // once so the rows of a concurrent worker running the same task (after an expired lease) count:
    // a variant that failed here may be stored there. Our own generated rows are included too:
    // the persist returned successfully before #renderPending returned. A row of the identity with
    // other signatures (another worker's, made with other settings) does not count, so the task
    // fails and its retry replaces that row.
    const refreshed = await mediaStore.loadMedia(task.mediaId);
    if (!refreshed) {
      logger.info(
        `resize worker: media ${task.mediaId} was deleted while processing — no-op complete`,
      );
      return;
    }
    if (
      backfilled &&
      !storedDims(refreshed.original) &&
      !this.#warnedBackfill
    ) {
      this.#warnedBackfill = true;
      logger.warn(
        `resize worker: the media store did not record the original's dimensions of media ${task.mediaId} — every read of such a media queues a task that downloads the original; a MediaStore must save backfillDims in appendPreviews`,
      );
    }
    const covered = catalog.freshIdentities(
      {
        original: refreshed.original,
        previews: [
          ...(media.previews ?? []),
          ...(refreshed.previews ?? []),
          ...generated,
        ],
      },
      scope,
      originDims,
    );
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
   * The worker judges freshness by its own settings, so a variant a reader queued that is fresh
   * here is skipped. A first delivery that finds every requested preview fresh on a media with
   * stored dimensions most likely comes from a reader with other settings: warned once per
   * registered pipeline. It can also follow an eager generate() that filled the variants first,
   * hence "if this repeats".
   */
  #warnIfAllFresh(
    task: LeasedTask,
    media: MediaLike,
    scope: PreviewScope,
    requested: MissingPreview[],
  ): void {
    const { catalog, logger, pipelines } = this.#deps;
    if (
      task.attempts !== 1 ||
      requested.length === 0 ||
      !pipelines.has(task.pipeline) ||
      this.#warnedAllFresh.has(task.pipeline) ||
      storedDims(media.original) === undefined
    ) {
      return;
    }
    const fresh = catalog.freshIdentities(media, scope);
    if (requested.every((p) => fresh.has(catalog.identity(scope, p)))) {
      this.#warnedAllFresh.add(task.pipeline);
      logger.warn(
        `resize worker: task ${task.taskId} of media ${task.mediaId} found every requested preview of pipeline '${task.pipeline}' already fresh — if this repeats, the API and the worker may run different image settings or pipeline versions, or resolve() was given the media without its stored original (storageRef, width, height)`,
      );
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

  async #renderPending(args: RenderPendingArgs): Promise<RenderPendingResult> {
    const {
      media,
      mediaId,
      requested,
      pipeline: pipelineName,
      ctx,
      persist,
      signal,
      mode,
      taskId,
    } = args;
    const {
      catalog,
      config,
      decoders,
      hooks,
      logger,
      name,
      pipelines,
      storage,
    } = this.#deps;
    const { limits } = config;

    // Before any download or decode, in both modes; the queue retries it like any failure.
    requirePipeline(pipelines, name, pipelineName);

    let generated: Preview[] = [];
    let failedCount = 0;
    let removed: Preview[] = [];
    const replaced = new Set<string>();
    const nothing = (): RenderPendingResult => ({
      generated,
      failedCount,
      removed,
      replaced,
    });

    // Nothing requested (e.g. eager re-run where everything is already fresh) → no download.
    if (requested.length === 0) {
      return nothing();
    }

    if (media.original?.storageRef == null) {
      // Callers guard this, but never assume — a media without an original has nothing to
      // resize from.
      return nothing();
    }
    // The original as the render found it, read once before any await: the host may replace it
    // while its bytes download, and the download, the origin every row records, the stored
    // dimensions and the upload's parent must all describe the bytes that were rendered.
    const { original, signed } = snapshotOriginal(media.original);
    const atStart: MediaLike = { original: signed, previews: media.previews };

    // The fresh stored identities are done (the DB check that makes re-runs idempotent); a stale
    // one renders again. Stored previews keep their own scope, so another pipeline's rendering
    // never counts as done here. Without stored dimensions no row is proven fresh yet: the
    // measured original decides below.
    const scope: PreviewScope = { resizer: name, pipeline: pipelineName };
    const freshAtLoad = catalog.freshIdentities(atStart, scope);
    const notFresh = requested.filter(
      (v) => !freshAtLoad.has(catalog.identity(scope, v)),
    );
    // One variant on the metrics sink: its time, its outcome, and the bytes it uploaded.
    const metrics = this.#metrics;
    const recordVariant = (
      identity: string,
      format: string,
      ms: number,
      outcome: 'stored' | 'duplicate' | 'rendered' | 'failed',
      extra: { code?: string; bytes?: number; rawFormat?: string } = {},
    ): void => {
      metrics.timing(
        'resize.variant',
        ms,
        {
          pipeline: pipelineName,
          format,
          mode,
          outcome,
          ...(extra.code === undefined ? {} : { code: extra.code }),
        },
        {
          mediaId,
          identity,
          ...(taskId === undefined ? {} : { taskId }),
          ...(extra.rawFormat === undefined
            ? {}
            : { rawFormat: extra.rawFormat }),
        },
      );
      if (extra.bytes !== undefined) {
        metrics.count('resize.variant.bytes', extra.bytes, {
          pipeline: pipelineName,
          format,
        });
      }
    };
    // A task payload can name any format; only configured encoders run. Every other variant fails
    // alone, before any download, so it is recorded with no time spent, under one `format` label
    // value (a label holds configured formats only), its own format in the context.
    const { configured, unconfigured } = catalog.splitConfigured(notFresh);
    let pending = configured;
    for (const v of unconfigured) {
      const identity = catalog.identity(scope, v);
      const error = formatNotConfiguredError([v.format]);
      logger.error(
        `resize worker: variant ${identity} failed for media ${mediaId}`,
        error,
      );
      failedCount += 1;
      recordVariant(identity, 'unconfigured', 0, 'failed', {
        ...errorCodeLabel(error),
        rawFormat: v.format,
      });
    }
    // Everything requested is already fresh or cannot be encoded: no download.
    if (pending.length === 0) {
      return nothing();
    }

    let source: LoadedSource | undefined = await loadSource(
      { storage, decoders, limits, logger },
      original,
      mediaId,
    );
    const { info } = source;

    // The dimensions the media holds: the stored pair (both numbers, as the read path counts
    // them), or, when the original never recorded it, the decoded source's display size (which
    // the persist below backfills). Every row's origin is signed with them, persisted or not, so
    // the rows of one original always share one origin.
    const stored = storedDims(original);
    // At least one pixel a side, as the plan rounds sides: a vector source may be fractional.
    const mediaDims = stored ?? {
      width: Math.max(1, Math.round(info.width)),
      height: Math.max(1, Math.round(info.height)),
    };
    const backfillDims =
      stored === undefined && persist ? mediaDims : undefined;
    const origin = previewOrigin(signed.storageRef, mediaDims);
    if (stored === undefined) {
      // Measured now, before any pixel decode: the rows signed with this size are fresh after all.
      const fresh = catalog.freshIdentities(atStart, scope, mediaDims);
      pending = pending.filter((v) => !fresh.has(catalog.identity(scope, v)));
      if (pending.length === 0) {
        // Nothing to render, but the dimensions are recorded, so the next read proves the rows
        // fresh without this download.
        if (backfillDims) {
          const recorded = await this.#recorder.record(mediaId, scope, [], {
            backfillDims,
          });
          if (recorded.failure) {
            throw recorded.failure.error;
          }
        }
        return {
          ...nothing(),
          originDims: mediaDims,
          ...(backfillDims ? { backfilled: backfillDims } : {}),
        };
      }
    }
    // The pending identities a stored row holds (stale, or from before rows were signed): the
    // persist replaces those rows instead of appending beside them.
    const storedIds = catalog.storedIdentities(atStart, scope);
    const replacing = new Set(
      pending
        .map((v) => catalog.identity(scope, v))
        .filter((identity) => storedIds.has(identity)),
    );
    // A store that cannot replace fails here, before any decode or upload.
    if (persist && replacing.size > 0) {
      requireReplacePreviews(this.#deps.media);
    }

    // The settings, the steps and the signature each row records, taken together before any pixel
    // work, with no await between them: the render uses only these, so a pipeline version, step
    // set or image setting changed while it runs (even changed and changed back) never makes a row
    // signed with one set of settings out of pixels made with another. The settings are plain
    // data; the steps are kept by reference, their lists copied.
    const settings = structuredClone(config);
    const { limits: renderLimits } = settings;
    const pipeline = pipelines.get(pipelineName);
    const beforeSteps = [...(pipeline.beforeSteps ?? [])];
    const variantSteps = [...(pipeline.variantSteps ?? [])];
    const encodeSigs = new Map(
      pending.map((v) => [
        catalog.identity(scope, v),
        catalog.encodeSig(pipelineName, v.format, v.fit === true),
      ]),
    );
    const rules = planRules(settings, scope, { beforeSteps, variantSteps });
    let plans = planVariants(info, pending, rules);

    // ONE decode per task, at the largest box the plan needs; with beforeSteps at least the
    // source's own size, so the steps see the whole source.
    let raster: Raster | undefined = await decodeSource(
      source,
      decodeBox(info, plans, { atLeastOwnSize: beforeSteps.length > 0 }),
      {
        limits: renderLimits,
        signal,
        source: info,
        frames: framesToDecode(info, plans, renderLimits),
      },
      mediaId,
    );
    // The encoded original is not read again: drop it before the pixel work.
    source = undefined;

    if (beforeSteps.length > 0) {
      const rendered = {
        width: raster.info.width,
        height: raster.info.height,
      };
      let stepping: Promise<Raster> | undefined = runBeforeSteps(
        raster,
        beforeSteps,
        { media, source: info, ctx },
        renderLimits,
      );
      // While the steps run, runBeforeSteps holds the only reference to the decoded raster, so
      // it is freed as soon as the first step resolves.
      raster = undefined;
      raster = await stepping;
      // A settled promise keeps its value, and the suspended frame keeps the promise: drop it, so
      // the full-size step result is freed once reduceToBox below has replaced it.
      stepping = undefined;
      const { width, height } = raster.info;
      if (
        width * height >
        Math.min(renderLimits.sourcePixels, renderLimits.inputPixels)
      ) {
        throw new ResizeMediaError(
          `resize: processed source exceeds pixel limits for media ${mediaId}`,
          { mediaId, code: 'RESIZE_SOURCE_TOO_LARGE', retryable: false },
        );
      }
      // A step that changed the size made a new image: every variant is planned from its pixels.
      let planned = info;
      if (width !== rendered.width || height !== rendered.height) {
        planned = {
          ...info,
          width,
          height,
          pages: 1,
          animated: false,
          vector: false,
        };
        plans = planVariants(planned, pending, rules);
      }
      // The sizes are rendered from the plan's box, not each from the full-size raster.
      raster = await reduceToBox(
        raster,
        decodeBox(planned, plans, { atLeastOwnSize: false }),
        renderLimits,
      );
    }

    // From here only `sized` holds the raster; it is cleared once the variants are done, so the
    // persist and the observers below do not keep the pixels alive.
    const sized = new SizedRasters(raster, plans, renderLimits);
    raster = undefined;
    const encodeOptions = {
      variantSteps,
      ctx,
      encode: settings.encode,
      limits: renderLimits,
    };
    // Each variant's stored row, by plan; read back in request order after the pool.
    const rows = new Map<VariantPlan, Preview>();
    // How long each rendered variant took, from the wait for its size's resized pixels (one resize,
    // shared by the formats of that size) through its encode to the end of its upload. It is
    // recorded once the persist says what became of the row.
    const durations = new Map<VariantPlan, number>();
    const renderVariant = async (plan: VariantPlan): Promise<void> => {
      const started = performance.now();
      try {
        let encoded: EncodedVariant;
        try {
          encoded = await encodeVariant(
            await sized.get(plan.size),
            plan,
            encodeOptions,
          );
        } finally {
          // Released after the encode, not after the upload: the last variant of a size does not
          // keep its sized raster during the upload.
          sized.release(plan.size);
        }
        const ref = await storage.upload({
          key: `previews/${randomHex()}.${encoded.format}`,
          body: encoded.data,
          contentType: encoded.contentType,
          visibility: 'public',
          parentRef: original.storageRef,
        });
        if (ref == null) {
          throw new ResizeStorageError(
            'resize: storage returned an invalid preview locator',
            { code: 'RESIZE_PREVIEW_STORAGE_REF_INVALID' },
          );
        }
        durations.set(plan, performance.now() - started);
        rows.set(
          plan,
          previewRow(plan, encoded, ref, {
            scope,
            origin,
            // Every plan is one of `pending`, so its signature was taken above.
            encodeSig: encodeSigs.get(plan.identity) ?? '',
          }),
        );
      } catch (err) {
        // One bad variant must not fail the whole task; the caller decides what the failures mean.
        // A media error from the pixel work (an SVG output) does not know its media: add it.
        const failure = lacksMediaId(err) ? withMediaId(err, mediaId) : err;
        logger.error(
          `resize worker: variant ${plan.identity} failed for media ${mediaId}`,
          failure,
        );
        failedCount += 1;
        recordVariant(
          plan.identity,
          plan.variant.format,
          performance.now() - started,
          'failed',
          errorCodeLabel(failure),
        );
      }
    };

    // Bounded pool over the variants (NOT unbounded Promise.all), each size's variants together,
    // so at most `concurrency` sized rasters are held at once; between variants stop launching new
    // ones if the lease was lost (best-effort — correctness holds via the fencing token).
    await runBounded(
      groupBySize(plans),
      settings.concurrency,
      signal,
      renderVariant,
    );
    sized.clear();
    // The rows in request order, whatever order the pool finished them in.
    const rendered = plans.flatMap((plan) => {
      const row = rows.get(plan);
      return row ? [{ plan, row }] : [];
    });
    generated = rendered.map(({ row }) => row);

    // ONE persist for everything generated: one append of the new rows (+ display-dim backfill
    // when the original never carried dims) and one replace of the stale ones
    // (previewRecorder.ts), then fire onPreviewGenerated per stored preview (ctx {}).
    if (persist && (generated.length > 0 || backfillDims)) {
      const recorded = await this.#recorder.record(mediaId, scope, generated, {
        backfillDims,
        replacing,
        originDims: mediaDims,
      });
      if (recorded.failure) {
        // The persist failed. A write the store rejected is logged by the recorder; a malformed
        // append result and a store without replacePreviews are not, and travel in `error`. What
        // the store kept before the failure (the append before a failed replace, or the part of a
        // failed append the reloaded media holds) is stored; nothing else this call rendered is.
        const { error } = recorded.failure;
        const stored = new Set(recorded.stored);
        for (const { plan, row } of rendered) {
          const ms = durations.get(plan) ?? 0;
          if (stored.has(row)) {
            recordVariant(plan.identity, plan.variant.format, ms, 'stored', {
              bytes: row.bytes,
            });
          } else {
            recordVariant(
              plan.identity,
              plan.variant.format,
              ms,
              'failed',
              errorCodeLabel(error),
            );
          }
        }
        throw error;
      }
      generated = recorded.stored;
      removed = recorded.removed;
      for (const row of generated) {
        const identity = catalog.identity(scope, row);
        if (replacing.has(identity)) {
          replaced.add(identity);
        }
      }
      const kept = new Set(generated);
      const duplicates = new Set(recorded.alreadyStored);
      const blocked = new Set(recorded.blocked);
      for (const { plan, row } of rendered) {
        const ms = durations.get(plan) ?? 0;
        if (kept.has(row)) {
          recordVariant(plan.identity, plan.variant.format, ms, 'stored', {
            bytes: row.bytes,
          });
        } else if (duplicates.has(plan.identity)) {
          recordVariant(plan.identity, plan.variant.format, ms, 'duplicate', {
            bytes: row.bytes,
          });
        } else if (blocked.has(plan.identity)) {
          // Another worker's row with other signatures holds the identity: not covered, so the
          // variant failed (its task retries and replaces that row).
          failedCount += 1;
          recordVariant(plan.identity, plan.variant.format, ms, 'failed', {
            code: 'RESIZE_WORKER_INCOMPLETE',
          });
        } else {
          // The media store left it out and does not hold it (or the media is gone): logged by
          // the recorder, and not stored.
          recordVariant(plan.identity, plan.variant.format, ms, 'failed');
        }
      }
      for (const preview of generated) {
        await hooks.runObservers('onPreviewGenerated', preview, {});
      }
    } else if (!persist) {
      for (const { plan, row } of rendered) {
        recordVariant(
          plan.identity,
          plan.variant.format,
          durations.get(plan) ?? 0,
          'rendered',
          {
            bytes: row.bytes,
          },
        );
      }
    }

    return {
      generated,
      failedCount,
      removed,
      replaced,
      originDims: mediaDims,
      ...(backfillDims ? { backfilled: backfillDims } : {}),
    };
  }
}
