// The read-path engine (06 · §17). `resizer.resolve` delegates here: it partitions the
// requested size×format grid into ready (served from an existing preview
// or an "original already fits" raster original) vs missing (handed to enqueue), threading three
// host waterfalls (resolveSizes / beforeEnqueue / formatPublicUrls) and never throwing into
// the caller's read. All URLs come from the PURE, I/O-free storage.publicUrl; the only I/O
// is the owner/admin-gated signedUrl (itself caught + fallen back). Imports the Resizer
// TYPE only — resizer.ts imports resolveImpl as a value, so this cycle is runtime-free.
import { canonicalizeVariants, enqueue, enqueueConfirmed } from './enqueue.ts';
import {
  ResizeConfigError,
  ResizeMediaError,
  ResizeSetupError,
} from './errors.ts';
import { isPositiveFinite } from './helpers/guards.ts';
import {
  expandPreviewRequests,
  getFilterSig,
  getPreviewIdentity,
  getSizeKey,
  isSvgOriginal,
  isUsablePreview,
  previewScope,
  requireMediaId,
} from './images.ts';
import type { Resizer } from './resizer.ts';
import type {
  MediaLike,
  MissingPreview,
  Original,
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
  ctx?: Record<string, unknown>; // threaded to read-path hooks; ctx.isOwner/isAdmin gate signedUrl
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

// Owner/admin private-original reads: short-lived by design (the only read-path I/O). A
// small constant is fine — the URL is re-minted on every read, so it never needs to outlive
// one response.
const SIGNED_ORIGINAL_TTL_SECONDS = 300; // 5 minutes

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
  const { media } = opts;
  // Built incrementally so the never-throw catch can still return what was produced.
  const ready: ReadyEntry[] = [];
  const decision: ReadDecision = { ready, missing: [] };

  try {
    await resizer.ready(); // drivers given as functions load here, inside the never-throw guard
    const ctx = opts.ctx ?? {};
    const storage = resizer.storage; // required constructor option — always present (§17.3)
    const pipeline = opts.pipeline ?? 'default';
    // Inside the never-throw try: a media with no id/_id logs + returns the safe empty decision
    // rather than enqueueing under the literal 'undefined' key (04 · papercut).
    const mediaId = requireMediaId(media);

    // 1. Host size magic (expand/inject/map/dedupe). Guarded per-tap inside runWaterfall.
    const sizes = (await resizer.runWaterfall(
      'resolveSizes',
      opts.sizes,
      ctx,
    )) as SizeInput[];

    const formats = opts.formats ?? resizer.config.formats;

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

    const original = media.original;
    const missing: MissingPreview[] = [];
    const missingSeen = new Set<string>();
    const originalIsSvg = isSvgOriginal(original);
    // Compute this lazily. A generated preview is independently public and must remain
    // readable even when a legacy original now points to a retired/unavailable bucket.
    // A driver that does not implement the check is deliberately conservative: a public URL
    // from an arbitrary custom driver is not enough proof that an original is safe to expose.
    let originalIsPublic: boolean | undefined;
    const isOriginalPublic = (): boolean => {
      if (originalIsPublic === undefined) {
        try {
          originalIsPublic =
            original != null &&
            original.storageRef != null &&
            storage.canServeOriginalPublicly?.(original.storageRef) === true;
        } catch (err) {
          resizer.logger.error(
            'resize resolve: canServeOriginalPublicly threw — treating original as private',
            err,
          );
          originalIsPublic = false;
        }
      }
      return originalIsPublic;
    };
    const authorizedOriginalRead = Boolean(
      (ctx.isOwner || ctx.isAdmin) && storage.signedUrl,
    );

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
          const entry: ReadyEntry = {
            sizeKey,
            format,
            url: storage.publicUrl(existing.storageRef),
            preview: existing,
            contentType: existing.contentType,
          };
          if (size.filters) {
            entry.filters = size.filters;
          }
          ready.push(entry);
          continue;
        }

        // "original already fits" fast-path — ALL of (a)–(d) must hold (§17 step 7).
        if (
          original &&
          !originalIsSvg &&
          (isOriginalPublic() || authorizedOriginalRead) &&
          getFilterSig(size.filters) === 'none' && // (a) no filters
          !size.fit &&
          isPositiveFinite(size.width) && // (b) plain cover WxH
          isPositiveFinite(size.height) &&
          isPositiveFinite(original.width) && // (c) original dims known
          isPositiveFinite(original.height) &&
          original.width <= size.width && // (d) not larger than the box
          original.height <= size.height
        ) {
          const url = await originalUrl(
            resizer,
            original,
            ctx,
            isOriginalPublic(),
          );
          if (url !== undefined) {
            const fits: ReadyEntry = {
              sizeKey,
              format,
              url,
              isOriginal: true,
            };
            if (original.contentType) {
              fits.contentType = original.contentType;
            }
            ready.push(fits);
            continue;
          }
        }

        // missing → deduped by identity.
        if (missingSeen.has(identity)) {
          continue;
        }
        missingSeen.add(identity);
        const mp: MissingPreview = { sizeKey, format };
        if (size.filters && Object.keys(size.filters).length > 0) {
          mp.filters = size.filters;
        }
        if (isPositiveFinite(size.width)) {
          mp.requestedWidth = size.width;
        }
        if (isPositiveFinite(size.height)) {
          mp.requestedHeight = size.height;
        }
        if (size.fit) {
          mp.fit = true;
        }
        missing.push(mp);
      }
    }

    // 8. beforeEnqueue — REASSIGN the (post-hook) missing set so steps 9–10 + the host's
    // formatPublicUrls all see exactly what was enqueued.
    decision.missing = (await resizer.runWaterfall(
      'beforeEnqueue',
      missing,
      ctx,
    )) as MissingPreview[];

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
 * confirm it. Uses the read path's `resolveSizes` / `beforeEnqueue` waterfalls; the "original
 * already fits" fast-path is not consulted (that is a read-time serving decision). NEVER throws:
 * an upload must not fail because pre-warming hiccuped, so an unexpected error becomes
 * `status: 'incomplete'` with a RESIZE_ENQUEUE_INTERNAL_ERROR issue.
 */
export async function prewarmImpl(
  resizer: Resizer,
  opts: PrewarmOpts,
): Promise<PrewarmResult> {
  try {
    await resizer.ready(); // inside the never-throw guard
    return await prewarmStrict(resizer, opts);
  } catch (err) {
    logNeverThrow(
      resizer,
      'resize prewarm: unexpected internal error — nothing confirmed',
      err,
    );
    return {
      status: 'incomplete',
      requested: [],
      ready: [],
      accepted: [],
      notRequired: [],
      unconfirmed: [],
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
          previews: [],
        },
      ],
    };
  }
}

/** The pre-warm itself: every missing identity is either confirmed by a task receipt or explicit. */
async function prewarmStrict(
  resizer: Resizer,
  opts: PrewarmOpts,
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
  const formats = opts.formats ?? resizer.config.formats;
  const scope = { resizer: resizer.name, pipeline };
  const requestedBeforePolicy = expandPreviewRequests(sizes, formats, scope);
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
    return empty();
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
  const required = canonicalizeVariants(
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
  if (required.length === 0) {
    return {
      status: ready.length > 0 ? 'ready' : 'not-required',
      ...(ready.length === 0 ? { reason: 'filtered' as const } : {}),
      requested,
      ready,
      accepted: [],
      notRequired,
      unconfirmed: [],
      tasks: [],
      issues: [],
    };
  }
  if (media.original?.storageRef == null) {
    return {
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
    };
  }

  const attempt = await enqueueConfirmed(
    resizer,
    mediaId,
    pipeline,
    required,
    opts.queue ?? resizer.queue,
  );
  return {
    status: attempt.unconfirmed.length > 0 ? 'incomplete' : 'accepted',
    requested,
    ready,
    accepted: attempt.accepted,
    notRequired,
    unconfirmed: attempt.unconfirmed,
    tasks: attempt.tasks,
    issues: attempt.issues,
  };
}

/**
 * The public URL for an original-backed ready entry. Owner/admin reads get a signed URL
 * when the driver supports it — the ONLY read-path I/O. A private original has no public URL
 * fallback: if signing fails, return undefined so raster callers leave the variant missing.
 */
async function originalUrl(
  resizer: Resizer,
  original: Original,
  ctx: Record<string, unknown>,
  originalIsPublic: boolean,
): Promise<string | undefined> {
  const storage = resizer.storage;
  if ((ctx.isOwner || ctx.isAdmin) && storage.signedUrl) {
    try {
      return await storage.signedUrl(
        original.storageRef,
        SIGNED_ORIGINAL_TTL_SECONDS,
      );
    } catch (err) {
      resizer.logger.error(
        'resize resolve: signedUrl failed — private original stays unavailable',
        err,
      );
      if (!originalIsPublic) {
        return undefined;
      }
    }
  }
  return originalIsPublic ? storage.publicUrl(original.storageRef) : undefined;
}

/** Log a never-throw catch; a throwing host logger falls back to the console. */
function logNeverThrow(resizer: Resizer, message: string, err: unknown): void {
  try {
    resizer.logger.error(message, err);
  } catch {
    console.error(message, err);
  }
}
