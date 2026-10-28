// The read path. `resolve` partitions the requested size×format grid into ready (served from a
// stored preview) vs missing (handed to the Dispatcher), threading three host waterfalls
// (resolveSizes / beforeEnqueue / formatPublicUrls) and never throwing into the caller's read.
// `prewarm` is the request half of pre-warming at upload: it expands the catalog through the same
// waterfalls and hands what is missing to the Dispatcher, which confirms what was queued. The
// original itself is never served: an original smaller than the box still gets a preview, made by
// the worker at the original's own size. Every URL comes from the PURE, I/O-free
// storage.publicUrl of a stored preview. A Reader takes its parts explicitly and knows no Resizer.
import type { Catalog } from './catalog.ts';
import type { ResizeStorage } from './contracts/storage.ts';
import {
  type Dispatcher,
  type DispatchRequest,
  noQueueResult,
} from './dispatcher.ts';
import { ResizeError } from './errors.ts';
import { logNeverThrow } from './helpers/log.ts';
import type { HookBus } from './hooks.ts';
import { getSizeKey, requireMediaId, toMissingPreview } from './images.ts';
import type { PipelineRegistry } from './pipelines.ts';
import type {
  MissingPreview,
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
  queue: string; // the Resizer's default queue for missing variants
}

/** Serves the stored previews of one Resizer and requests the missing ones. Never throws. */
export class Reader {
  readonly #deps: ReaderDeps;

  constructor(deps: ReaderDeps) {
    this.#deps = deps;
  }

  /**
   * Partition the requested grid into ready vs missing, queue the missing set, and let the host
   * shape the response. The ENTIRE body runs inside one try/catch (the never-throw guarantee): on
   * any unexpected internal error it logs and returns the safe value
   * `{ decision: { ready-so-far, missing: [] }, output: undefined }` instead of rejecting into the
   * caller's read.
   */
  async resolve(
    opts: ResolveOpts,
  ): Promise<{ decision: ReadDecision; output: unknown }> {
    const { catalog, dispatcher, hooks, pipelines, storage, logger, name } =
      this.#deps;
    // Built incrementally so the never-throw catch can still return what was produced.
    const ready: ReadyEntry[] = [];
    const decision: ReadDecision = { ready, missing: [] };

    try {
      // Inside the guard, so a missing options object also returns the safe empty decision.
      const { media } = opts;
      const ctx = opts.ctx ?? {};
      const pipeline = opts.pipeline ?? 'default';
      // Inside the never-throw try: a media with no id/_id logs + returns the safe empty decision
      // rather than enqueueing under the literal 'undefined' key.
      const mediaId = requireMediaId(media);
      // A pipeline this process does not know (e.g. registered only in another process) has
      // unknown steps: serve what is already stored for it, but no task can be trusted to render it.
      const knownPipeline = pipelines.has(pipeline);
      if (!knownPipeline) {
        logger.error(
          `resize resolve: pipeline '${pipeline}' is not registered on Resizer '${name}' — serving stored previews only, nothing is queued`,
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
      logUnconfiguredFormats(logger, 'resize resolve', dropped, '');

      // The usable stored previews of this scope, by identity. Stored previews keep the scope
      // they were rendered in, so another pipeline or Resizer never matches them.
      const scope: PreviewScope = { resizer: name, pipeline };
      const previewMap = catalog.storedPreviews(media, scope);

      const missing: MissingPreview[] = [];
      const missingSeen = new Set<string>();

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
          const existing = previewMap.get(identity);
          if (existing) {
            // exists → serve the generated preview.
            let url: string;
            try {
              url = storage.publicUrl(existing.storageRef);
            } catch (err) {
              // A ref the driver rejects (e.g. a bucket no longer allowlisted) loses only this
              // cell. It is neither ready nor missing: the preview is stored, so queueing it again
              // would not help.
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
            ready.push(entry);
            continue;
          }
          if (!knownPipeline) {
            continue; // stored previews only
          }

          // missing → deduped by identity, whatever the original's size or the reader's ctx.
          if (missingSeen.has(identity)) {
            continue;
          }
          missingSeen.add(identity);
          missing.push(toMissingPreview(size, sizeKey, format));
        }
      }

      // beforeEnqueue — REASSIGN the (post-hook) missing set so the enqueue below and the host's
      // formatPublicUrls both see exactly what was enqueued. An unknown pipeline skips the hook,
      // so a tap cannot add variants that would be queued for it; a variant the tap added or
      // rewrote to an unconfigured format is dropped.
      if (knownPipeline) {
        const { configured, unconfigured } = catalog.splitConfigured(
          (await hooks.runWaterfall(
            'beforeEnqueue',
            missing,
            ctx,
          )) as MissingPreview[],
        );
        logUnconfiguredTapFormats(logger, 'resize resolve', unconfigured);
        decision.missing = configured;
      }

      // Enqueue the missing variants. Default follows construction: a task queue (so a
      // Dispatcher) means lazy mode (enqueue), none means eager-only (do not log-on-every-read).
      // A task queue that cannot be used queues nothing; the Resizer logged why when it started.
      const enqueueMissing = opts.enqueueMissing ?? dispatcher !== undefined;
      if (enqueueMissing && decision.missing.length > 0) {
        if (media.original?.storageRef == null) {
          logger.info(
            `resize resolve: media ${mediaId} has no original storage ref — nothing enqueued`,
          );
        } else if (!dispatcher) {
          if (!this.#deps.queueFailure) {
            logger.warn(
              'resize resolve: missing previews but no task queue is configured — they stay placeholders (eager-only host? give the Resizer `tasks` for lazy mode)',
            );
          }
        } else {
          try {
            await dispatcher.enqueue({
              mediaId,
              pipeline,
              previews: decision.missing,
              queue: opts.queue ?? this.#deps.queue,
            });
          } catch (err) {
            // enqueue is internally guarded and should never reach here; belt-and-suspenders.
            logger.error(
              'resize resolve: enqueue threw unexpectedly (read continues)',
              err,
            );
          }
        }
      }

      // The host turns the decision into its response shape. No tap / tap throws →
      // `output === undefined` (never leak `{ ready, missing }` as a DTO).
      const output = await hooks.runWaterfall(
        'formatPublicUrls',
        decision,
        ctx,
        'optional',
      );

      return { decision, output };
    } catch (err) {
      // Never-throw guarantee: the read must not break on an internal error.
      logNeverThrow(
        logger,
        'resize resolve: unexpected internal error — returning the safe empty decision',
        err,
      );
      const safe: ReadDecision = { ready, missing: [] };
      return { decision: safe, output: undefined };
    }
  }

  /**
   * Pre-warm the catalog at UPLOAD: queue every missing variant without blocking on image work,
   * and report each requested variant (ready / accepted / not required / unconfirmed, with task
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

      const readyIdentities = catalog.storedIdentities(media, scope);
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
        queue: opts.queue ?? this.#deps.queue,
      };
      const attempt = dispatcher
        ? await dispatcher.enqueueConfirmed(request)
        : noQueueResult(required);
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
  if (err.retryable === false || NOT_RETRYABLE_ON_PREWARM.has(err.name)) {
    return true;
  }
  try {
    for (
      let proto: unknown = Object.getPrototypeOf(err);
      proto !== null && proto !== Object.prototype;
      proto = Object.getPrototypeOf(proto)
    ) {
      const name = (proto as { constructor?: { name?: unknown } }).constructor
        ?.name;
      if (typeof name === 'string' && NOT_RETRYABLE_ON_PREWARM.has(name)) {
        return true;
      }
    }
  } catch {
    // A prototype chain that cannot be read: no class advice, the error stays retryable.
  }
  return false;
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
 * queued or encoded without the configured options.
 */
function logUnconfiguredFormats(
  logger: ResizeLogger,
  label: string,
  formats: readonly unknown[],
  origin: string,
): void {
  if (formats.length > 0) {
    logger.error(
      `${label}: formats ${JSON.stringify(formats)}${origin} have no encode.formats entry — skipped (use a configured Sharp format id, e.g. 'jpeg', not 'jpg')`,
    );
  }
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
): void {
  logUnconfiguredFormats(
    logger,
    label,
    [...new Set(unconfigured.map((variant) => variant?.format))],
    ' from a beforeEnqueue tap',
  );
}
