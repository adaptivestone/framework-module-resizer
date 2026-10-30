// The read path. `resolve` partitions the requested size×format grid into ready (served from a
// stored preview) vs missing (handed to the Dispatcher), threading three host waterfalls
// (resolveSizes / beforeEnqueue / formatPublicUrls) and never throwing into the caller's read. A
// stale stored preview (made from another original or with other settings) is still served,
// marked stale, and its replacement is queued with the missing ones.
// `prewarm` is the request half of pre-warming at upload: it expands the catalog through the same
// waterfalls and hands what is missing or stale to the Dispatcher, which confirms what was
// queued. The original itself is never served: an original smaller than the box still gets a
// preview, made by the worker at the original's own size. Every URL comes from the PURE, I/O-free
// storage.publicUrl of a stored preview. A Reader takes its parts explicitly and knows no Resizer.
// Every resolve() counts one `resize.read` with its outcome. A read writes a log line only for what
// an operator must fix, and only once per Reader: an unregistered pipeline name, a dropped format
// list, a missing task queue the caller asked to queue to.
import type { Catalog } from './catalog.ts';
import type { ResizeMetrics } from './contracts/metrics.ts';
import type { ResizeStorage } from './contracts/storage.ts';
import {
  type Dispatcher,
  type DispatchRequest,
  noQueueResult,
} from './dispatcher.ts';
import { ResizeError } from './errors.ts';
import { hasErrorClass } from './helpers/errorClass.ts';
import { logNeverThrow } from './helpers/log.ts';
import type { HookBus } from './hooks.ts';
import { getSizeKey, requireMediaId, toMissingPreview } from './images.ts';
import { NoopMetrics } from './metrics.ts';
import type { PipelineRegistry } from './pipelines.ts';
import type {
  MissingPreview,
  Preview,
  PreviewScope,
  PrewarmOpts,
  PrewarmResult,
  ReadDecision,
  ReadyEntry,
  ResizeLogger,
  ResolveOpts,
  SizeInput,
} from './types.d.ts';

export interface ReaderDeps {
  catalog: Catalog;
  // undefined: no task queue (eager only), or one that cannot be used (see queueFailure)
  dispatcher: Dispatcher | undefined;
  // Why the Resizer's task queue cannot be used (no lock store, invalid timing), already logged
  // once by the Resizer: reads queue nothing and prewarm reports it.
  queueFailure?: { error: unknown };
  hooks: HookBus;
  pipelines: PipelineRegistry;
  storage: ResizeStorage;
  logger: ResizeLogger;
  name: string; // the Resizer's name: part of every preview identity
  queueName: string; // the Resizer's queue for missing variants, unless a call names its own
  // Where each read is counted (a Resizer passes its bound sink); default: nothing is recorded.
  metrics?: ResizeMetrics;
}

/**
 * What became of one read, in the order resolve() decides it: the pipeline is not registered;
 * every requested cell was served; nothing was left to queue (a beforeEnqueue tap, unconfigured
 * formats, or `enqueueMissing: false`); the media has no stored original; there is no task queue;
 * a task was added; a task of the media, pipeline and queue is already active; or the task queue
 * could not take it (or the read itself failed).
 */
export type ReadOutcome =
  | 'ready'
  | 'enqueued'
  | 'in-flight'
  | 'suppressed'
  | 'eager-only'
  | 'no-original'
  | 'unknown-pipeline'
  | 'failed';

// What one read counts: its media, and the distinct variants it found missing and stale.
interface ReadCounts {
  mediaId?: string;
  missing: number;
  stale: number;
}

// A once-log keeps at most this many keys: host input (pipeline names, format lists) is unbounded.
const ONCE_LOG_KEYS = 100;

const noMetrics = new NoopMetrics();

/** Serves the stored previews of one Resizer and requests the missing ones. Never throws. */
export class Reader {
  readonly #deps: ReaderDeps;
  readonly #metrics: ResizeMetrics;
  // The logs a read writes once per Reader: each would repeat on every read until the host
  // changes its code or config, so the read metrics count the reads instead.
  readonly #loggedPipelines = new Set<string>();
  readonly #loggedFormats = new Set<string>();
  #loggedEagerOnly = false;

  constructor(deps: ReaderDeps) {
    this.#deps = deps;
    this.#metrics = deps.metrics ?? noMetrics;
  }

  /**
   * Partition the requested grid into ready vs missing, queue the missing and stale set, and let
   * the host shape the response. The ENTIRE body runs inside one try/catch (the never-throw
   * guarantee): on any unexpected internal error it logs and returns the safe value
   * `{ decision: { ready-so-far, missing: [] }, output: undefined }` instead of rejecting into the
   * caller's read. Either way the read is counted once, with its outcome.
   */
  async resolve(
    opts: ResolveOpts,
  ): Promise<{ decision: ReadDecision; output: unknown }> {
    const { catalog, hooks, pipelines, storage, logger, name } = this.#deps;
    // Built incrementally so the never-throw catch can still return what was produced.
    const ready: ReadyEntry[] = [];
    const decision: ReadDecision = { ready, missing: [] };
    // What the read counts. `opts` may be missing (a JS host): the catch below counts it too.
    const read: ReadCounts = { missing: 0, stale: 0 };

    try {
      // Inside the guard, so a missing options object also returns the safe empty decision.
      const { media } = opts;
      const ctx = opts.ctx ?? {};
      const pipeline = opts.pipeline ?? 'default';
      // Inside the never-throw try: a media with no id/_id logs + returns the safe empty decision
      // rather than enqueueing under the literal 'undefined' key.
      const mediaId = requireMediaId(media);
      read.mediaId = mediaId;
      // A pipeline this process does not know (e.g. registered only in another process) has
      // unknown steps: serve what is already stored for it, but no task can be trusted to render it.
      const knownPipeline = pipelines.has(pipeline);
      if (!knownPipeline && firstTime(this.#loggedPipelines, pipeline)) {
        logger.error(
          `resize resolve: pipeline '${pipeline}' is not registered on Resizer '${name}' — serving stored previews only, nothing is queued (logged once per pipeline name)`,
        );
      }

      // Host size magic (expand/inject/map/dedupe). The hook bus guards each tap.
      const sizes = (await hooks.runWaterfall(
        'resolveSizes',
        opts.sizes,
        ctx,
      )) as SizeInput[];

      // `null` formats (from a JS host) mean the configured ones too.
      const { formats, dropped } = catalog.configuredFormats(
        opts.formats ?? undefined,
      );
      logUnconfiguredFormats(
        logger,
        'resize resolve',
        dropped,
        '',
        this.#loggedFormats,
      );

      // The usable stored previews of this scope, by identity, fresh or stale. Stored previews
      // keep the scope they were rendered in, so another pipeline or Resizer never matches them.
      // An unregistered pipeline serves every stored row as fresh: nothing can replace it.
      const scope: PreviewScope = { resizer: name, pipeline };
      const { fresh: previewMap, stale: staleMap } = knownPipeline
        ? catalog.splitStored(media, scope)
        : {
            fresh: catalog.storedPreviews(media, scope),
            stale: new Map<string, Preview>(),
          };

      // Missing and stale variants, in cell order: one list for the hook and one task.
      const toQueue: MissingPreview[] = [];
      const queuedIdentities = new Set<string>();
      const staleIdentities = new Set<string>();
      let missingCount = 0;

      // Per requested size × format.
      for (const size of sizes) {
        let sizeKey: string;
        try {
          sizeKey = getSizeKey(size);
        } catch {
          continue; // skip a size whose key cannot be built
        }
        for (const format of formats) {
          const identity = catalog.identity(scope, {
            sizeKey,
            format,
            filters: size.filters,
          });
          const fresh = previewMap.get(identity);
          const existing = fresh ?? staleMap.get(identity);
          // A stale row joins the queue before its URL is built: when the driver rejects its ref,
          // the replacement still gets a new one.
          if (!fresh && existing && !queuedIdentities.has(identity)) {
            queuedIdentities.add(identity);
            staleIdentities.add(identity);
            toQueue.push(toMissingPreview(size, sizeKey, format));
          }
          if (existing) {
            // exists → serve the generated preview, stale or not.
            let url: string;
            try {
              url = storage.publicUrl(existing.storageRef);
            } catch (err) {
              // A ref the driver rejects (e.g. a bucket no longer allowlisted) loses only this
              // cell. A fresh one is neither ready nor missing: the preview is stored, so queueing
              // it again would not help.
              logger.error(
                `resize resolve: publicUrl failed for stored preview ${identity} of media ${mediaId} — skipping it`,
                err,
              );
              continue;
            }
            const entry: ReadyEntry = {
              sizeKey,
              format,
              url,
              preview: existing,
              contentType: existing.contentType,
            };
            if (size.filters) {
              entry.filters = size.filters;
            }
            if (!fresh) {
              entry.stale = true;
            }
            ready.push(entry);
            continue;
          }
          if (!knownPipeline) {
            continue; // stored previews only
          }

          // missing → deduped by identity, whatever the original's size or the reader's ctx.
          if (queuedIdentities.has(identity)) {
            continue;
          }
          queuedIdentities.add(identity);
          missingCount += 1;
          toQueue.push(toMissingPreview(size, sizeKey, format));
        }
      }
      read.missing = missingCount;
      read.stale = staleIdentities.size;
      this.#countStale(pipeline, mediaId, read.stale);

      // beforeEnqueue — REASSIGN the (post-hook) queue list so the enqueue below and the host's
      // formatPublicUrls both see exactly what was enqueued: a variant whose identity was stale
      // goes to `decision.stale`, the rest to `decision.missing`. An unknown pipeline skips the
      // hook, so a tap cannot add variants that would be queued for it; a variant the tap added or
      // rewrote to an unconfigured format is dropped.
      let queued: MissingPreview[] = [];
      if (knownPipeline) {
        const { configured, unconfigured } = catalog.splitConfigured(
          (await hooks.runWaterfall(
            'beforeEnqueue',
            toQueue,
            ctx,
          )) as MissingPreview[],
        );
        logUnconfiguredTapFormats(
          logger,
          'resize resolve',
          unconfigured,
          this.#loggedFormats,
        );
        queued = configured;
        const split = splitStale(configured, staleIdentities, (variant) =>
          catalog.identity(scope, variant),
        );
        decision.missing = split.missing;
        if (split.stale.length > 0) {
          decision.stale = split.stale;
        }
      }

      let outcome: ReadOutcome = 'unknown-pipeline';
      if (knownPipeline) {
        const result = await this.#queueMissing(
          opts,
          mediaId,
          pipeline,
          queued,
        );
        // Every requested cell was served fresh; a variant a tap added (queued above) does not
        // change it.
        outcome = toQueue.length === 0 ? 'ready' : result;
      }

      // The host turns the decision into its response shape. No tap / tap throws →
      // `output === undefined` (never leak `{ ready, missing }` as a DTO).
      const output = await hooks.runWaterfall(
        'formatPublicUrls',
        decision,
        ctx,
        'optional',
      );

      this.#countRead(pipeline, outcome, read, ready.length);
      return { decision, output };
    } catch (err) {
      // Never-throw guarantee: the read must not break on an internal error.
      logNeverThrow(
        logger,
        'resize resolve: unexpected internal error — returning the safe empty decision',
        err,
      );
      this.#countRead(
        opts?.pipeline ?? 'default',
        'failed',
        read,
        ready.length,
      );
      const safe: ReadDecision = { ready, missing: [] };
      return { decision: safe, output: undefined };
    }
  }

  /**
   * Queue the variants a read found missing, and say what became of them. By default a Resizer
   * with a task queue (so a Dispatcher) queues them; one without serves what is stored, and warns
   * once only when the caller asked to queue. A task queue that cannot be used queues nothing; the
   * Resizer logged why when it started.
   */
  async #queueMissing(
    opts: ResolveOpts,
    mediaId: string,
    pipeline: string,
    previews: MissingPreview[],
  ): Promise<ReadOutcome> {
    const { dispatcher, queueFailure, logger } = this.#deps;
    if (previews.length === 0 || opts.enqueueMissing === false) {
      return 'suppressed';
    }
    if (opts.media.original?.storageRef == null) {
      return 'no-original';
    }
    if (!dispatcher) {
      if (queueFailure) {
        return 'failed';
      }
      if (opts.enqueueMissing === true && !this.#loggedEagerOnly) {
        this.#loggedEagerOnly = true;
        logger.warn(
          'resize resolve: missing previews but no task queue is configured — they stay placeholders (eager-only host? give the Resizer `tasks` for lazy mode; logged once)',
        );
      }
      return 'eager-only';
    }
    try {
      const { outcome } = await dispatcher.enqueueWithOutcome({
        mediaId,
        pipeline,
        previews,
        queue: opts.queue ?? this.#deps.queueName,
      });
      return outcome;
    } catch (err) {
      // enqueueWithOutcome is internally guarded and should never reach here; belt-and-suspenders.
      logger.error(
        'resize resolve: enqueue threw unexpectedly (read continues)',
        err,
      );
      return 'failed';
    }
  }

  /** Count one read. The sink a Resizer passes never throws; a bare one must not break the read. */
  #countRead(
    pipeline: string,
    outcome: ReadOutcome,
    read: ReadCounts,
    ready: number,
  ): void {
    try {
      this.#metrics.count(
        'resize.read',
        1,
        { pipeline, outcome },
        {
          ...(read.mediaId === undefined ? {} : { mediaId: read.mediaId }),
          ready,
          missing: read.missing,
          stale: read.stale,
        },
      );
    } catch {
      // A Reader built by hand with a sink that throws loses only the count.
    }
  }

  /** Count the stale previews one read found, when it found any; guarded like #countRead. */
  #countStale(pipeline: string, mediaId: string, stale: number): void {
    if (stale === 0) {
      return;
    }
    try {
      this.#metrics.count(
        'resize.preview.stale',
        stale,
        { pipeline },
        { mediaId },
      );
    } catch {
      // A Reader built by hand with a sink that throws loses only the count.
    }
  }

  /**
   * Pre-warm the catalog at UPLOAD: queue every missing or stale variant (only a fresh stored
   * preview is ready) without blocking on image work, and report each requested variant (ready / accepted / not required / unconfirmed, with task
   * receipts and issues): every missing identity is either confirmed by a task receipt or
   * explicit. A task already in flight for the media, pipeline and queue confirms only the
   * variants it holds (the queue's findActive() reports them); a held gate lock never counts as
   * queued. Uses
   * the read path's `resolveSizes` / `beforeEnqueue` waterfalls. NEVER throws: an upload
   * must not fail because pre-warming hiccuped, so an unexpected error becomes
   * `status: 'incomplete'` with a RESIZE_ENQUEUE_INTERNAL_ERROR issue.
   */
  async prewarm(opts: PrewarmOpts): Promise<PrewarmResult> {
    const { catalog, dispatcher, hooks, pipelines, logger, name } = this.#deps;
    // What has been expanded so far: an unexpected error reports it all as unconfirmed.
    let expanded: MissingPreview[] = [];
    try {
      const ctx = opts.ctx ?? {};
      const { media } = opts;
      const pipeline = opts.pipeline ?? 'default';
      const mediaId = requireMediaId(media);
      const sizes = (await hooks.runWaterfall(
        'resolveSizes',
        opts.sizes,
        ctx,
      )) as SizeInput[];
      const scope: PreviewScope = { resizer: name, pipeline };
      const identityOf = (preview: MissingPreview) =>
        catalog.identity(scope, preview);
      // `null` formats (from a JS host) mean the configured ones too.
      const { formats, dropped } = catalog.configuredFormats(
        opts.formats ?? undefined,
      );
      logUnconfiguredFormats(logger, 'resize prewarm', dropped, '');
      // Requested in formats that have no encoder settings: reported, never queued.
      const unconfigured = catalog.expand(sizes, dropped, scope);
      const finish = (result: PrewarmResult): PrewarmResult =>
        withUnconfiguredFormats(result, unconfigured);
      const requestedBeforePolicy = catalog.expand(sizes, formats, scope);
      expanded = [...requestedBeforePolicy, ...unconfigured];
      if (!pipelines.has(pipeline)) {
        // Its steps are unknown in this process, so no task can be trusted to render it.
        const message = `pipeline '${pipeline}' is not registered on Resizer '${name}'`;
        logger.error(`resize prewarm: ${message} — nothing is queued`);
        return finish({
          status: 'incomplete',
          requested: requestedBeforePolicy,
          ready: [],
          accepted: [],
          notRequired: [],
          unconfirmed: requestedBeforePolicy,
          tasks: [],
          issues: [
            {
              code: 'RESIZE_PIPELINE_UNKNOWN',
              message,
              retryable: false,
              previews: requestedBeforePolicy,
            },
          ],
        });
      }
      if (requestedBeforePolicy.length === 0) {
        return finish({
          status: 'not-required',
          reason: 'empty-request',
          requested: [],
          ready: [],
          accepted: [],
          notRequired: [],
          unconfirmed: [],
          tasks: [],
          issues: [],
        });
      }

      // Only a fresh stored preview is ready: a stale one is required and queued like a missing one.
      const readyIdentities = catalog.freshIdentities(media, scope);
      const ready = requestedBeforePolicy.filter((preview) =>
        readyIdentities.has(identityOf(preview)),
      );
      const missingBeforePolicy = requestedBeforePolicy.filter(
        (preview) => !readyIdentities.has(identityOf(preview)),
      );
      const afterPolicy = catalog
        .canonicalize(
          (await hooks.runWaterfall(
            'beforeEnqueue',
            missingBeforePolicy,
            ctx,
          )) as MissingPreview[],
        )
        .filter((preview) => !readyIdentities.has(identityOf(preview)));
      // A tap may add or rewrite variants: one in an unconfigured format is reported like a
      // per-call one (once per identity), never queued.
      const { configured: required, unconfigured: fromPolicy } =
        catalog.splitConfigured(afterPolicy);
      logUnconfiguredTapFormats(logger, 'resize prewarm', fromPolicy);
      const unconfiguredIdentities = new Set(unconfigured.map(identityOf));
      for (const preview of fromPolicy) {
        const identity = identityOf(preview);
        if (!unconfiguredIdentities.has(identity)) {
          unconfiguredIdentities.add(identity);
          unconfigured.push(preview);
        }
      }
      const requiredIdentities = new Set(required.map(identityOf));
      const notRequired = missingBeforePolicy.filter(
        (preview) => !requiredIdentities.has(identityOf(preview)),
      );
      const requested = [...ready, ...required, ...notRequired];
      expanded = [...requested, ...unconfigured];
      if (required.length === 0) {
        return finish({
          status: ready.length > 0 ? 'ready' : 'not-required',
          ...(ready.length === 0 ? { reason: 'filtered' as const } : {}),
          requested,
          ready,
          accepted: [],
          notRequired,
          unconfirmed: [],
          tasks: [],
          issues: [],
        });
      }
      if (media.original?.storageRef == null) {
        return finish({
          status: 'incomplete',
          requested,
          ready,
          accepted: [],
          notRequired,
          unconfirmed: required,
          tasks: [],
          issues: [
            {
              code: 'RESIZE_ENQUEUE_NO_ORIGINAL',
              message: `media ${mediaId} has no original storage ref`,
              retryable: false,
              previews: required,
            },
          ],
        });
      }

      const { queueFailure } = this.#deps;
      if (!dispatcher && queueFailure) {
        // Nothing can be queued; the Resizer logged the failure when it started.
        return finish({
          ...prewarmFailure(queueFailure.error, required),
          requested,
          ready,
          notRequired,
        });
      }
      const request: DispatchRequest = {
        mediaId,
        pipeline,
        previews: required,
        queue: opts.queue ?? this.#deps.queueName,
      };
      const attempt = dispatcher
        ? await dispatcher.enqueueConfirmed(request)
        : noQueueResult(required);
      if ('timingError' in attempt) {
        // The call's queue has invalid timing: reported as for a task queue that cannot be used.
        return finish({
          ...prewarmFailure(attempt.timingError, required),
          requested,
          ready,
          notRequired,
        });
      }
      return finish({
        status: attempt.unconfirmed.length > 0 ? 'incomplete' : 'accepted',
        requested,
        ready,
        accepted: attempt.accepted,
        notRequired,
        unconfirmed: attempt.unconfirmed,
        tasks: attempt.tasks,
        issues: attempt.issues,
      });
    } catch (err) {
      logNeverThrow(
        logger,
        'resize prewarm: unexpected internal error — nothing confirmed',
        err,
      );
      return prewarmFailure(err, expanded);
    }
  }
}

// The errors of this package that a prewarm retry cannot fix: an unusable media, or wrong wiring or
// config. Told by the brand and the class names, so an error from a duplicate copy of the package
// gets the same advice.
const NOT_RETRYABLE_ON_PREWARM = new Set([
  'ResizeMediaError',
  'ResizeNoOriginalError',
  'ResizeOriginalError',
  'ResizeConfigError',
  'ResizeSetupError',
]);

/**
 * True when a prewarm retry cannot help `err`: an error of this package (by its brand) that says
 * so itself (`retryable: false`), or one of the classes above, or a subclass of one (a host's
 * `class HostSetupError extends ResizeSetupError`): its name, or a constructor name along its
 * prototype chain, without `instanceof`, which a duplicate package copy would defeat.
 */
function notRetryableOnPrewarm(err: unknown): boolean {
  if (!ResizeError.isResizeError(err)) {
    return false;
  }
  return (
    err.retryable === false || hasErrorClass(err, NOT_RETRYABLE_ON_PREWARM)
  );
}

/**
 * Prewarm's result for an unexpected error: every variant `requested` so far is unconfirmed, with
 * one RESIZE_ENQUEUE_INTERNAL_ERROR issue. Retryable unless the error says no retry can help, the
 * media is unusable, or the wiring or config is wrong. This `retryable` is advice to the prewarm caller, so it differs from
 * ResizeError.retryable on purpose: a ResizeSetupError will not improve on the caller's retry, yet
 * a queued task that hits one is retried (a worker deployed with the fix can run it).
 */
export function prewarmFailure(
  err: unknown,
  requested: MissingPreview[],
): PrewarmResult {
  return {
    status: 'incomplete',
    requested: [...requested],
    ready: [],
    accepted: [],
    notRequired: [],
    unconfirmed: [...requested],
    tasks: [],
    issues: [
      {
        code: 'RESIZE_ENQUEUE_INTERNAL_ERROR',
        message: err instanceof Error ? err.message : String(err),
        // An unusable media (e.g. no id) or a wiring/config mistake won't improve on retry.
        retryable: !notRetryableOnPrewarm(err),
        previews: [...requested],
      },
    ],
  };
}

/**
 * Add the variants requested in formats without an `encode.formats` entry: requested, never
 * queued, and unconfirmed with a non-retryable issue (the request itself must change).
 */
function withUnconfiguredFormats(
  result: PrewarmResult,
  unconfigured: MissingPreview[],
): PrewarmResult {
  if (unconfigured.length === 0) {
    return result;
  }
  const formats = [...new Set(unconfigured.map((preview) => preview.format))];
  return {
    status: 'incomplete',
    requested: [...result.requested, ...unconfigured],
    ready: result.ready,
    accepted: result.accepted,
    notRequired: result.notRequired,
    unconfirmed: [...result.unconfirmed, ...unconfigured],
    tasks: result.tasks,
    issues: [
      ...result.issues,
      {
        code: 'RESIZE_FORMAT_NOT_CONFIGURED',
        message: `formats ${JSON.stringify(formats)} have no encode.formats entry`,
        retryable: false,
        previews: unconfigured,
      },
    ],
  };
}

/**
 * Name the requested formats without an `encode.formats` entry in one logged error. Per-call
 * formats are open strings, so an alias such as 'jpg' or an arbitrary id is dropped, never
 * queued or encoded without the configured options. With `seen`, each list is logged once (a
 * read repeats the same list on every request).
 */
function logUnconfiguredFormats(
  logger: ResizeLogger,
  label: string,
  formats: readonly unknown[],
  origin: string,
  seen?: Set<string>,
): void {
  if (formats.length === 0) {
    return;
  }
  const list = JSON.stringify(formats);
  if (seen && !firstTime(seen, `${label}${origin} ${list}`)) {
    return;
  }
  logger.error(
    `${label}: formats ${list}${origin} have no encode.formats entry — skipped (use a configured Sharp format id, e.g. 'jpeg', not 'jpg')`,
  );
}

/**
 * Name the formats of the variants a `beforeEnqueue` tap returned without encoder settings (a
 * worker could never produce them: they would fail, dead-letter, and be queued again by the
 * next read). A malformed entry counts too.
 */
function logUnconfiguredTapFormats(
  logger: ResizeLogger,
  label: string,
  unconfigured: readonly MissingPreview[],
  seen?: Set<string>,
): void {
  logUnconfiguredFormats(
    logger,
    label,
    [...new Set(unconfigured.map((variant) => variant?.format))],
    ' from a beforeEnqueue tap',
    seen,
  );
}

/**
 * Split the variants a read queues: one whose identity was stale on this read is a replacement,
 * every other one is missing. A variant whose identity cannot be built (a malformed tap result)
 * counts as missing.
 */
function splitStale(
  variants: readonly MissingPreview[],
  staleIdentities: ReadonlySet<string>,
  identityOf: (variant: MissingPreview) => string,
): { stale: MissingPreview[]; missing: MissingPreview[] } {
  const stale: MissingPreview[] = [];
  const missing: MissingPreview[] = [];
  for (const variant of variants) {
    let identity: string | undefined;
    if (staleIdentities.size > 0) {
      try {
        identity = identityOf(variant);
      } catch {
        identity = undefined;
      }
    }
    (identity !== undefined && staleIdentities.has(identity)
      ? stale
      : missing
    ).push(variant);
  }
  return { stale, missing };
}

/**
 * True the first time `key` is seen, which it then records, while `seen` holds fewer than
 * ONCE_LOG_KEYS keys: past that, nothing new is logged.
 */
function firstTime(seen: Set<string>, key: string): boolean {
  if (seen.has(key) || seen.size >= ONCE_LOG_KEYS) {
    return false;
  }
  seen.add(key);
  return true;
}
