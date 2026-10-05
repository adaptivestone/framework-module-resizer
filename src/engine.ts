// The read-path engine (06 · §17). `resizer.resolve` delegates here: it partitions the
// requested size×format grid into ready (served from a stored preview) vs missing (handed to
// enqueue), threading three host waterfalls (resolveSizes / beforeEnqueue / formatPublicUrls)
// and never throwing into the caller's read. The original itself is never served: an original
// smaller than the box still gets a preview, made by the worker at the original's own size.
// Every URL comes from the PURE, I/O-free storage.publicUrl of a stored preview. Imports the
// Resizer TYPE only — resizer.ts imports resolveImpl as a value, so this cycle is runtime-free.
import { canonicalizeVariants, enqueue, enqueueConfirmed } from './enqueue.ts';
import {
  ResizeConfigError,
  ResizeMediaError,
  ResizeSetupError,
} from './errors.ts';
import {
  expandPreviewRequests,
  getPreviewIdentity,
  getSizeKey,
  isUsablePreview,
  previewScope,
  requireMediaId,
  toMissingPreview,
} from './images.ts';
import type { Resizer } from './resizer.ts';
import type {
  MediaLike,
  MissingPreview,
  Preview,
  PreviewFormat,
  PrewarmResult,
  ReadDecision,
  ReadyEntry,
  SizeInput,
} from './types.d.ts';

export interface ResolveOpts {
  media: MediaLike;
  sizes: SizeInput[];
  pipeline?: string; // selects a registered pipeline; default 'default'
  formats?: PreviewFormat[]; // default = config.formats
  ctx?: Record<string, unknown>; // threaded to the read-path hooks
  enqueueMissing?: boolean; // default true when a task queue is set, false otherwise
  queue?: string; // queue for missing variants; default resizer.queue
}

export interface PrewarmOpts {
  media: MediaLike;
  sizes: SizeInput[];
  pipeline?: string; // selects a registered pipeline; default 'default'
  formats?: PreviewFormat[]; // default = config.formats
  ctx?: Record<string, unknown>; // reaches the read-path waterfalls only (worker ctx stays {})
  queue?: string; // queue for missing variants; default resizer.queue
}

/**
 * §17 steps 1–11. See the module header for the shape. The ENTIRE body runs inside a
 * try/catch (the never-throw guarantee, layer 3): on any unexpected internal error it logs
 * and returns the safe value `{ decision: { ready-so-far, missing: [] }, output: undefined }`
 * instead of rejecting into the caller's read.
 */
export async function resolveImpl(
  resizer: Resizer,
  opts: ResolveOpts,
): Promise<{ decision: ReadDecision; output: unknown }> {
  // Built incrementally so the never-throw catch can still return what was produced.
  const ready: ReadyEntry[] = [];
  const decision: ReadDecision = { ready, missing: [] };

  try {
    // Inside the guard, so a missing options object also returns the safe empty decision.
    const { media } = opts;
    await resizer.ready(); // drivers given as functions load here, inside the never-throw guard
    const ctx = opts.ctx ?? {};
    const storage = resizer.storage; // required constructor option — always present (§17.3)
    const pipeline = opts.pipeline ?? 'default';
    // Inside the never-throw try: a media with no id/_id logs + returns the safe empty decision
    // rather than enqueueing under the literal 'undefined' key (04 · papercut).
    const mediaId = requireMediaId(media);
    // A pipeline this process does not know (e.g. registered only in another process) has
    // unknown steps: serve what is already stored for it, but no task can be trusted to render it.
    const knownPipeline = resizer.hasPipeline(pipeline);
    if (!knownPipeline) {
      resizer.logger.error(
        `resize resolve: pipeline '${pipeline}' is not registered on Resizer '${resizer.name}' — serving stored previews only, nothing is queued`,
      );
    }

    // 1. Host size magic (expand/inject/map/dedupe). Guarded per-tap inside runWaterfall.
    const sizes = (await resizer.runWaterfall(
      'resolveSizes',
      opts.sizes,
      ctx,
    )) as SizeInput[];

    const { formats } = configuredFormats(
      resizer,
      opts.formats,
      'resize resolve',
    );

    // 5. previewMap keyed by identity — only complete entries (both key + contentType). Stored
    // previews keep the scope they were rendered in, so another pipeline or Resizer never
    // matches them.
    const scope = { resizer: resizer.name, pipeline };
    const previewMap = new Map<string, Preview>();
    for (const p of media.previews ?? []) {
      if (isUsablePreview(p)) {
        previewMap.set(
          getPreviewIdentity(previewScope(p), p.sizeKey, p.format, p.filters),
          p,
        );
      }
    }

    const missing: MissingPreview[] = [];
    const missingSeen = new Set<string>();

    // 7. Per requested size × format.
    for (const size of sizes) {
      let sizeKey: string;
      try {
        sizeKey = getSizeKey(size);
      } catch {
        continue; // skip a size whose key cannot be built
      }
      for (const format of formats) {
        const identity = getPreviewIdentity(
          scope,
          sizeKey,
          format,
          size.filters,
        );
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
            resizer.logger.error(
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

    // 8. beforeEnqueue — REASSIGN the (post-hook) missing set so steps 9–10 + the host's
    // formatPublicUrls all see exactly what was enqueued. An unknown pipeline skips the hook, so
    // a tap cannot add variants that would be queued for it; a variant the tap added or rewrote
    // to an unconfigured format is dropped.
    decision.missing = knownPipeline
      ? splitConfiguredVariants(
          resizer,
          (await resizer.runWaterfall(
            'beforeEnqueue',
            missing,
            ctx,
          )) as MissingPreview[],
          'resize resolve',
        ).configured
      : [];

    // 9. Enqueue the missing variants. Default follows construction: a task queue means
    // lazy mode (enqueue), none means eager-only (do not log-on-every-read).
    const enqueueMissing = opts.enqueueMissing ?? resizer.tasks != null;
    if (enqueueMissing && decision.missing.length > 0) {
      if (media.original?.storageRef == null) {
        resizer.logger.info(
          `resize resolve: media ${mediaId} has no original storage ref — nothing enqueued`,
        );
      } else if (!resizer.tasks) {
        resizer.logger.warn(
          'resize resolve: missing previews but no task queue is configured — they stay placeholders (eager-only host? give the Resizer `tasks` for lazy mode)',
        );
      } else {
        try {
          await enqueue(
            resizer,
            mediaId,
            pipeline,
            decision.missing,
            opts.queue ?? resizer.queue,
          );
        } catch (err) {
          // enqueue is internally guarded and should never reach here; belt-and-suspenders.
          resizer.logger.error(
            'resize resolve: enqueue threw unexpectedly (read continues)',
            err,
          );
        }
      }
    }

    // 10. Host turns the decision into its response shape. No tap / tap throws →
    // `output === undefined` (never leak `{ ready, missing }` as a DTO).
    const output = await resizer.runWaterfall(
      'formatPublicUrls',
      decision,
      ctx,
      'optional',
    );

    // 11.
    return { decision, output };
  } catch (err) {
    // Never-throw guarantee (layer 3): the read must not break on an internal error.
    logNeverThrow(
      resizer,
      'resize resolve: unexpected internal error — returning the safe empty decision',
      err,
    );
    const safe: ReadDecision = { ready, missing: [] };
    return { decision: safe, output: undefined };
  }
}

/**
 * Pre-warm the catalog at UPLOAD: queue every missing variant without blocking on image work, and
 * report each requested variant (ready / accepted / not required / unconfirmed, with task receipts
 * and issues). A held dispatch lock never counts as queued: the queue's findActive() must
 * confirm it. Uses the read path's `resolveSizes` / `beforeEnqueue` waterfalls. NEVER throws:
 * an upload must not fail because pre-warming hiccuped, so an unexpected error becomes
 * `status: 'incomplete'` with a RESIZE_ENQUEUE_INTERNAL_ERROR issue.
 */
export async function prewarmImpl(
  resizer: Resizer,
  opts: PrewarmOpts,
): Promise<PrewarmResult> {
  // What prewarmStrict has expanded so far: an unexpected error reports it all as unconfirmed.
  const progress: PrewarmProgress = { requested: [] };
  try {
    await resizer.ready(); // inside the never-throw guard
    return await prewarmStrict(resizer, opts, progress);
  } catch (err) {
    logNeverThrow(
      resizer,
      'resize prewarm: unexpected internal error — nothing confirmed',
      err,
    );
    return {
      status: 'incomplete',
      requested: [...progress.requested],
      ready: [],
      accepted: [],
      notRequired: [],
      unconfirmed: [...progress.requested],
      tasks: [],
      issues: [
        {
          code: 'RESIZE_ENQUEUE_INTERNAL_ERROR',
          message: err instanceof Error ? err.message : String(err),
          // An unusable media (e.g. no id) or a wiring/config mistake won't improve on retry.
          retryable: !(
            err instanceof ResizeMediaError ||
            err instanceof ResizeConfigError ||
            err instanceof ResizeSetupError
          ),
          previews: [...progress.requested],
        },
      ],
    };
  }
}

interface PrewarmProgress {
  requested: MissingPreview[];
}

/** The pre-warm itself: every missing identity is either confirmed by a task receipt or explicit. */
async function prewarmStrict(
  resizer: Resizer,
  opts: PrewarmOpts,
  progress: PrewarmProgress,
): Promise<PrewarmResult> {
  const ctx = opts.ctx ?? {};
  const { media } = opts;
  const pipeline = opts.pipeline ?? 'default';
  const mediaId = requireMediaId(media);
  const sizes = (await resizer.runWaterfall(
    'resolveSizes',
    opts.sizes,
    ctx,
  )) as SizeInput[];
  const scope = { resizer: resizer.name, pipeline };
  const { formats, dropped } = configuredFormats(
    resizer,
    opts.formats,
    'resize prewarm',
  );
  // Requested in formats that have no encoder settings: reported, never queued.
  const unconfigured = expandPreviewRequests(sizes, dropped, scope);
  const finish = (result: PrewarmResult): PrewarmResult =>
    withUnconfiguredFormats(result, unconfigured);
  const requestedBeforePolicy = expandPreviewRequests(sizes, formats, scope);
  progress.requested = [...requestedBeforePolicy, ...unconfigured];
  if (!resizer.hasPipeline(pipeline)) {
    // Its steps are unknown in this process, so no task can be trusted to render it.
    const message = `pipeline '${pipeline}' is not registered on Resizer '${resizer.name}'`;
    resizer.logger.error(`resize prewarm: ${message} — nothing is queued`);
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
  const empty = (): PrewarmResult => ({
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
  if (requestedBeforePolicy.length === 0) {
    return finish(empty());
  }

  const readyIdentities = new Set<string>();
  for (const preview of media.previews ?? []) {
    if (isUsablePreview(preview)) {
      readyIdentities.add(
        getPreviewIdentity(
          previewScope(preview),
          preview.sizeKey,
          preview.format,
          preview.filters,
        ),
      );
    }
  }
  const ready = requestedBeforePolicy.filter((preview) =>
    readyIdentities.has(
      getPreviewIdentity(
        scope,
        preview.sizeKey,
        preview.format,
        preview.filters,
      ),
    ),
  );
  const missingBeforePolicy = requestedBeforePolicy.filter(
    (preview) =>
      !readyIdentities.has(
        getPreviewIdentity(
          scope,
          preview.sizeKey,
          preview.format,
          preview.filters,
        ),
      ),
  );
  const afterPolicy = canonicalizeVariants(
    (await resizer.runWaterfall(
      'beforeEnqueue',
      missingBeforePolicy,
      ctx,
    )) as MissingPreview[],
  ).filter(
    (preview) =>
      !readyIdentities.has(
        getPreviewIdentity(
          scope,
          preview.sizeKey,
          preview.format,
          preview.filters,
        ),
      ),
  );
  // A tap may add or rewrite variants: one in an unconfigured format is reported like a per-call
  // one (once per identity), never queued.
  const { configured: required, unconfigured: fromPolicy } =
    splitConfiguredVariants(resizer, afterPolicy, 'resize prewarm');
  const unconfiguredIdentities = new Set(
    unconfigured.map((preview) =>
      getPreviewIdentity(
        scope,
        preview.sizeKey,
        preview.format,
        preview.filters,
      ),
    ),
  );
  for (const preview of fromPolicy) {
    const identity = getPreviewIdentity(
      scope,
      preview.sizeKey,
      preview.format,
      preview.filters,
    );
    if (!unconfiguredIdentities.has(identity)) {
      unconfiguredIdentities.add(identity);
      unconfigured.push(preview);
    }
  }
  const requiredIdentities = new Set(
    required.map((preview) =>
      getPreviewIdentity(
        scope,
        preview.sizeKey,
        preview.format,
        preview.filters,
      ),
    ),
  );
  const notRequired = missingBeforePolicy.filter(
    (preview) =>
      !requiredIdentities.has(
        getPreviewIdentity(
          scope,
          preview.sizeKey,
          preview.format,
          preview.filters,
        ),
      ),
  );
  const requested = [...ready, ...required, ...notRequired];
  progress.requested = [...requested, ...unconfigured];
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

  const attempt = await enqueueConfirmed(
    resizer,
    mediaId,
    pipeline,
    required,
    opts.queue ?? resizer.queue,
  );
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
 * The requested formats (default: config.formats) that have an own `encode.formats` entry. Per-call
 * formats are open strings, so an alias such as 'jpg' or an arbitrary id would otherwise be queued
 * and encoded without the configured options. The others are dropped and named in one logged error.
 */
function configuredFormats(
  resizer: Resizer,
  requested: readonly PreviewFormat[] | undefined,
  label: string,
): { formats: PreviewFormat[]; dropped: PreviewFormat[] } {
  const formats: PreviewFormat[] = [];
  const dropped = new Set<PreviewFormat>();
  for (const format of requested ?? resizer.config.formats) {
    if (isConfiguredFormat(resizer, format)) {
      formats.push(format);
    } else {
      dropped.add(format);
    }
  }
  logUnconfiguredFormats(resizer, label, [...dropped], '');
  return { formats, dropped: [...dropped] };
}

/**
 * Split what a `beforeEnqueue` tap returned by the same rule as configuredFormats: a tap may add
 * or rewrite a variant to a format with no encoder settings, which a worker could never produce
 * (it would fail, dead-letter, and be queued again by the next read). The unconfigured ones are
 * named in one logged error.
 */
function splitConfiguredVariants(
  resizer: Resizer,
  variants: readonly MissingPreview[],
  label: string,
): { configured: MissingPreview[]; unconfigured: MissingPreview[] } {
  const configured: MissingPreview[] = [];
  const unconfigured: MissingPreview[] = [];
  for (const variant of variants) {
    // `?.`: a tap's malformed entry is dropped like an unknown format, not thrown on.
    if (isConfiguredFormat(resizer, variant?.format)) {
      configured.push(variant);
    } else {
      unconfigured.push(variant);
    }
  }
  logUnconfiguredFormats(
    resizer,
    label,
    [...new Set(unconfigured.map((variant) => variant?.format))],
    ' from a beforeEnqueue tap',
  );
  return { configured, unconfigured };
}

/** True when `format` is an own key of `encode.formats` (format ids are open strings). */
function isConfiguredFormat(
  resizer: Resizer,
  format: unknown,
): format is PreviewFormat {
  return (
    typeof format === 'string' &&
    Object.hasOwn(resizer.config.encode.formats, format)
  );
}

function logUnconfiguredFormats(
  resizer: Resizer,
  label: string,
  formats: readonly unknown[],
  origin: string,
): void {
  if (formats.length > 0) {
    resizer.logger.error(
      `${label}: formats ${JSON.stringify(formats)}${origin} have no encode.formats entry — skipped (use a configured Sharp format id, e.g. 'jpeg', not 'jpg')`,
    );
  }
}

/** Log a never-throw catch; a throwing host logger falls back to the console. */
function logNeverThrow(resizer: Resizer, message: string, err: unknown): void {
  try {
    resizer.logger.error(message, err);
  } catch {
    console.error(message, err);
  }
}
