// The resize core, owned by `Processor`, shared by both generation modes:
//   - processTask() = the core for one queued task, run by the worker
//   - generate()    = the core for eager `resizer.generate`
// #renderPending() renders the variants not stored yet: download the original once; a decoder
// identifies its bytes and renders them ONCE, at the largest box the plan needs; beforeSteps run
// once on that raster, which is then reduced to the box of the plan made from their result; each
// exact size is resized once and each format encoded from it, then uploaded (bounded by
// config.concurrency); one PreviewRecorder write stores the rows, and onPreviewGenerated fires over
// the rows it kept. The sizes come from the pure plan (plan.ts), the pixel work from render.ts, and
// a source kind needs only a decoder: the Processor itself imports no image engine. It also fires
// the task observers, and invalidate() removes stored previews for `resizer.invalidate` (one media
// store write). It takes no locks: the queue leases a task to one worker at a time, the lease token
// fences the task's writes, and the media store keeps one row per preview identity when an expired
// lease lets two workers render the same variant. It takes its parts explicitly and knows no
// Resizer.
import type { Catalog } from './catalog.ts';
import type {
  DecodeBox,
  Raster,
  RenderOptions,
  SourceDecoder,
  SourceInfo,
} from './contracts/decoder.ts';
import type { ObserverName } from './contracts/hooks.ts';
import type { MediaStore, ReplacedPreviews } from './contracts/media.ts';
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
import { runBounded } from './helpers/concurrency.ts';
import { logNeverThrow } from './helpers/log.ts';
import { randomHex } from './helpers/random.ts';
import type { HookBus } from './hooks.ts';
import { previewScope, requireMediaId } from './images.ts';
import type { PipelineRegistry } from './pipelines.ts';
import {
  decodeBox,
  framesToDecode,
  planRules,
  planVariants,
  type VariantPlan,
} from './plan.ts';
import { PreviewRecorder } from './previewRecorder.ts';
import { checkRaster } from './raster.ts';
import {
  type EncodedVariant,
  encodeVariant,
  reduceToBox,
  runBeforeSteps,
  SizedRasters,
  straightAlpha,
} from './render.ts';
import { encodeSignature, previewOrigin } from './signatures.ts';
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
 * A decode failure as the task reports it: a module error that does not know its media gets the
 * media id (the decoders do not know it), any other module error stays as it is, and anything else
 * is RESIZE_SOURCE_DECODE_FAILED with the original error as its cause (retried).
 */
function sourceError(err: unknown, mediaId: string): unknown {
  if (ResizeError.isResizeError(err)) {
    if ('mediaId' in err && err.mediaId === undefined) {
      return new ResizeMediaError(`${err.message} (media ${mediaId})`, {
        mediaId,
        code: err.code,
        retryable: err.retryable,
        cause: err,
      });
    }
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
    const why =
      mismatch.reason === 'unlisted'
        ? 'no decoder lists the stored format'
        : 'its decoder refused the bytes';
    logger.warn(
      `resize worker: media ${mediaId} is stored as '${mismatch.stored}' but its bytes are '${info.format}' (${why}); rendering it as '${info.format}'`,
    );
  }
  if (info.width * info.height > limits.sourcePixels) {
    throw new ResizeMediaError(
      `resize: source ${info.width}×${info.height} exceeds limits.sourcePixels (${limits.sourcePixels}) for media ${mediaId}`,
      { mediaId, code: 'RESIZE_SOURCE_TOO_LARGE', retryable: false },
    );
  }
  return { bytes, decoder, info };
}

/** The decoder's raster at `box`, checked and in straight alpha. */
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
  if (v.fit) {
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
}

interface RenderPendingResult {
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
  decoders: DecoderSet; // reads the originals: one decode per task
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
    const { generated, failedCount } = await this.#renderPending({
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
    const { generated, failedCount, alreadyStored } = await this.#renderPending(
      {
        media,
        mediaId: task.mediaId,
        requested,
        pipeline: task.pipeline,
        ctx,
        persist: true,
        signal: opts.signal,
      },
    );

    // A queued task is complete only when every requested identity is now persisted. Re-read once
    // so the rows of a concurrent worker running the same task (after an expired lease) count: a
    // variant that failed here may be stored there. Our own generated rows are included too:
    // appendPreviews returned successfully before #renderPending returned, and so are the
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

  async #renderPending(args: RenderPendingArgs): Promise<RenderPendingResult> {
    const {
      media,
      mediaId,
      requested,
      pipeline: pipelineName,
      ctx,
      persist,
      signal,
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
    const existing = catalog.storedIdentities(media, scope);
    const notStored = requested.filter(
      (v) => !existing.has(catalog.identity(scope, v)),
    );
    // A task payload can name any format; only configured encoders run. Every other variant fails
    // alone, before any download.
    const { configured: pending, unconfigured } =
      catalog.splitConfigured(notStored);
    for (const v of unconfigured) {
      logger.error(
        `resize worker: variant ${catalog.identity(scope, v)} failed for media ${mediaId}`,
        formatNotConfiguredError([v.format]),
      );
      failedCount += 1;
    }
    // Everything requested is already stored or cannot be encoded: no download.
    if (pending.length === 0) {
      return { generated, failedCount, alreadyStored };
    }

    const source = await loadSource(
      { storage, decoders, limits, logger },
      original,
      mediaId,
    );
    const { info } = source;

    // The dimensions the media holds: the stored pair, or, when the original never recorded it,
    // the decoded source's display size (which the persist below backfills). Every row's origin is
    // signed with them, persisted or not, so the rows of one original always share one origin.
    const storedDims =
      original.width !== undefined && original.height !== undefined
        ? { width: original.width, height: original.height }
        : undefined;
    // At least one pixel a side, as the plan rounds sides: a vector source may be fractional.
    const mediaDims = storedDims ?? {
      width: Math.max(1, Math.round(info.width)),
      height: Math.max(1, Math.round(info.height)),
    };
    const origin = previewOrigin(original.storageRef, mediaDims);

    const pipeline = pipelines.get(pipelineName);
    const beforeSteps = pipeline.beforeSteps ?? [];
    const rules = planRules(config, scope, pipeline);
    let plans = planVariants(info, pending, rules);

    // ONE decode per task, at the largest box the plan needs; with beforeSteps at least the
    // source's own size, so the steps see the whole source.
    let raster: Raster | undefined = await decodeSource(
      source,
      decodeBox(info, plans, { atLeastOwnSize: beforeSteps.length > 0 }),
      {
        limits,
        signal,
        source: info,
        frames: framesToDecode(info, plans, limits),
      },
      mediaId,
    );

    if (beforeSteps.length > 0) {
      const rendered = {
        width: raster.info.width,
        height: raster.info.height,
      };
      const stepping = runBeforeSteps(
        raster,
        beforeSteps,
        { media, source: info, ctx },
        limits,
      );
      // While the steps run, runBeforeSteps holds the only reference to the decoded raster, so
      // it is freed as soon as the first step resolves.
      raster = undefined;
      raster = await stepping;
      const { width, height } = raster.info;
      if (width * height > Math.min(limits.sourcePixels, limits.inputPixels)) {
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
        limits,
      );
    }

    // From here only `sized` holds the raster; it is cleared once the variants are done, so the
    // persist and the observers below do not keep the pixels alive.
    const sized = new SizedRasters(raster, plans, limits);
    raster = undefined;
    const encodeOptions = {
      variantSteps: pipeline.variantSteps ?? [],
      ctx,
      encode: config.encode,
      limits,
    };
    const renderVariant = async (plan: VariantPlan): Promise<void> => {
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
        generated.push(
          previewRow(plan, encoded, ref, {
            scope,
            origin,
            encodeSig: encodeSignature(config, {
              format: plan.variant.format,
              fit: plan.variant.fit === true,
              version: pipeline.version,
            }),
          }),
        );
      } catch (err) {
        // One bad variant must not fail the whole task; the caller decides what the failures mean.
        logger.error(
          `resize worker: variant ${plan.identity} failed for media ${mediaId}`,
          err,
        );
        failedCount += 1;
      }
    };

    // Bounded pool over the variants, in request order (NOT unbounded Promise.all); between
    // variants stop launching new ones if the lease was lost (best-effort — correctness holds via
    // the fencing token).
    await runBounded(plans, config.concurrency, signal, renderVariant);
    sized.clear();

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
