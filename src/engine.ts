// The read-path engine (06 · §17). `resizer.resolve` delegates here: it partitions the
// requested size×format grid into ready (served from an existing preview, an SVG original,
// or an "original already fits" original) vs missing (handed to enqueue), threading three
// host waterfalls (resolveSizes / beforeEnqueue / formatPublicUrls) and never throwing into
// the caller's read. All URLs come from the PURE, I/O-free storage.publicUrl; the only I/O
// is the owner/admin-gated signedUrl (itself caught + fallen back). Imports the Resizer
// TYPE only — resizer.ts imports resolveImpl as a value, so this cycle is runtime-free.
import { getApp } from './app.ts';
import { canonicalizeVariants, enqueue, enqueueConfirmed } from './enqueue.ts';
import { isPositiveFinite } from './helpers/guards.ts';
import {
  expandMissingPreviews,
  expandPreviewRequests,
  getFilterSig,
  getPreviewIdentity,
  getSizeKey,
  requireMediaId,
} from './images.ts';
import { getResizeConfig } from './resizeConfig.ts';
import type { Resizer } from './resizer.ts';
import { isPubliclyServeable, isSvgOriginal } from './svgPublicCopy.ts';
import type {
  EnqueueRequiredResult,
  MediaLike,
  MissingPreview,
  Original,
  Preview,
  PreviewFormat,
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
  enqueueMissing?: boolean; // default true when a transport is set, false otherwise
}

export interface PrewarmOpts {
  media: MediaLike;
  sizes: SizeInput[];
  pipeline?: string; // selects a registered pipeline; default 'default'
  formats?: PreviewFormat[]; // default = config.formats
  ctx?: Record<string, unknown>; // reaches the read-path waterfalls only (worker ctx stays {})
}

export type EnqueueRequiredOpts = PrewarmOpts;

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

    const formats = opts.formats ?? getResizeConfig().formats;

    // 5. previewMap keyed by identity — only complete entries (both key + contentType).
    const previewMap = new Map<string, Preview>();
    for (const p of media.previews ?? []) {
      if (p.key && p.contentType) {
        previewMap.set(getPreviewIdentity(p.sizeKey, p.format, p.filters), p);
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
            storage.canServeOriginalPublicly?.(original) === true;
        } catch (err) {
          getApp().logger.error(
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

    if (original && originalIsSvg) {
      // 6. SVG pass-through — one URL at every requested size/format, with no raster work.
      // Prefer a separately persisted public copy when the driver proves it is public.
      // Otherwise use the normal original URL rule: signed private access for owners/admins,
      // or publicUrl only when the original itself is public.
      let url: string | undefined;
      const copy = original.publicCopy;
      if (copy?.key) {
        try {
          if (storage.canServeOriginalPublicly?.(copy) === true) {
            url = storage.publicUrl(copy);
          }
        } catch (err) {
          getApp().logger.error(
            'resize resolve: SVG public copy is unavailable',
            err,
          );
        }
      }
      url ??= await originalUrl(resizer, original, ctx, isOriginalPublic());
      if (url !== undefined) {
        for (const size of sizes) {
          let sizeKey: string;
          try {
            sizeKey = getSizeKey(size);
          } catch {
            continue; // a size with nothing usable is skipped (as in step 7)
          }
          for (const format of formats) {
            const entry: ReadyEntry = {
              sizeKey,
              format,
              url,
              isOriginal: true,
            };
            if (original.contentType) {
              entry.contentType = original.contentType;
            }
            if (size.filters) {
              entry.filters = size.filters;
            }
            ready.push(entry);
          }
        }
      } else {
        // A private SVG without a public copy still needs worker work. Represent
        // that work with the requested catalog so it uses the normal queue,
        // locks, receipts, retries, and dead-letter handling.
        missing.push(...expandPreviewRequests(sizes, formats));
      }
    } else {
      // 7. Per requested size × format.
      for (const size of sizes) {
        let sizeKey: string;
        try {
          sizeKey = getSizeKey(size);
        } catch {
          continue; // skip a size whose key cannot be built
        }
        for (const format of formats) {
          const identity = getPreviewIdentity(sizeKey, format, size.filters);
          const existing = previewMap.get(identity);
          if (existing) {
            // exists → serve the generated preview.
            const entry: ReadyEntry = {
              sizeKey,
              format,
              url: storage.publicUrl(existing),
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
    }

    // 8. beforeEnqueue — REASSIGN the (post-hook) missing set so steps 9–10 + the host's
    // formatPublicUrls all see exactly what was enqueued.
    decision.missing = (await resizer.runWaterfall(
      'beforeEnqueue',
      missing,
      ctx,
    )) as MissingPreview[];

    // 9. Enqueue the missing variants. Default follows construction: a transport means
    // lazy mode (enqueue), no transport means eager-only (do not log-on-every-read).
    const enqueueMissing = opts.enqueueMissing ?? resizer.transport != null;
    if (enqueueMissing && decision.missing.length > 0) {
      if (!media.original?.key) {
        getApp().logger.info(
          `resize resolve: media ${mediaId} has no original key — nothing enqueued`,
        );
      } else if (!resizer.transport) {
        getApp().logger.warn(
          'resize resolve: missing previews but no transport is registered — they stay placeholders (eager-only host? construct the Resizer with a transport for lazy mode)',
        );
      } else {
        try {
          await enqueue(resizer, mediaId, pipeline, decision.missing);
        } catch (err) {
          // enqueue is internally guarded and should never reach here; belt-and-suspenders.
          getApp().logger.error(
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
    logResolveError(err);
    const safe: ReadDecision = { ready, missing: [] };
    return { decision: safe, output: undefined };
  }
}

/**
 * §11.1b — pre-warm the catalog at UPLOAD by queueing its variants without blocking on any image
 * work. Shares the read path's machinery: the same `resolveSizes`/`beforeEnqueue` waterfalls, the
 * same `expandMissingPreviews` skip-existing/dedup expansion, and the same dispatch-lock
 * `enqueue()`. Differences from `resolve`: no ready/URL building, and the "original already fits"
 * fast-path is NOT consulted (that is a read-time serving decision — a fits-eligible size still
 * generates a preview a later read may ignore). Like `resolve`, the ENTIRE body runs in a
 * never-throw guard (an upload must not fail because pre-warming hiccuped) and returns the safe
 * `{ enqueued: 0 }` on any internal error. `enqueued` = the count handed to `transport.enqueue`
 * (dispatch-lock survivors; lock losers are already in flight elsewhere and are not counted).
 */
export async function prewarmImpl(
  resizer: Resizer,
  opts: PrewarmOpts,
): Promise<{ enqueued: number }> {
  try {
    const ctx = opts.ctx ?? {};
    const { media } = opts;
    const pipeline = opts.pipeline ?? 'default';
    // Inside the never-throw try: no id/_id logs + returns { enqueued: 0 } (04 · papercut).
    const mediaId = requireMediaId(media);

    // 1. Host size magic (same waterfall as resolve; real ctx reaches the taps).
    const sizes = (await resizer.runWaterfall(
      'resolveSizes',
      opts.sizes,
      ctx,
    )) as SizeInput[];

    // A publicly serveable SVG is already warm. A private SVG without a public
    // copy continues through the normal queue; its worker task publishes one copy.
    const original = media.original;
    if (
      isSvgOriginal(original) &&
      (isPubliclyServeable(resizer, original?.publicCopy) ||
        isPubliclyServeable(resizer, original))
    ) {
      getApp().logger.info(
        `resize prewarm: media ${mediaId} SVG is publicly serveable — nothing to warm`,
      );
      return { enqueued: 0 };
    }

    // 2. Expand sizes × formats → deduped MissingPreview[], skipping unbuildable sizes + existing
    //    identities. The fast-path is deliberately NOT consulted here (see the doc comment).
    const formats = opts.formats ?? getResizeConfig().formats;
    const expanded = expandMissingPreviews(media, sizes, formats);

    // 3. beforeEnqueue — REASSIGN the (post-hook) set so the enqueue sees exactly what a host tap
    //    left (same assign-back semantics as resolve step 8).
    const missing = (await resizer.runWaterfall(
      'beforeEnqueue',
      expanded,
      ctx,
    )) as MissingPreview[];
    if (missing.length === 0) {
      return { enqueued: 0 };
    }

    if (!media.original?.key) {
      getApp().logger.info(
        `resize prewarm: media ${mediaId} has no original key — nothing enqueued`,
      );
      return { enqueued: 0 };
    }

    // 4. No transport → this host is eager-only; warn once and enqueue nothing.
    if (!resizer.transport) {
      getApp().logger.warn(
        'resize prewarm: previews to warm but no transport is registered — nothing enqueued (eager-only host? construct the Resizer with a transport for pre-warm/lazy mode)',
      );
      return { enqueued: 0 };
    }

    // 4. Hand the survivors to the SAME dispatch-lock enqueue as the read path; its return value
    //    is the count actually queued (post lock-loser filtering, 0 on any failure).
    const enqueued = await enqueue(resizer, mediaId, pipeline, missing);
    return { enqueued };
  } catch (err) {
    // 5. Never-throw guard (same guarantee as resolve): an upload must not fail on a prewarm hiccup.
    logPrewarmError(err);
    return { enqueued: 0 };
  }
}

/** Strict pre-warm: every missing identity is either confirmed by a task receipt or explicit. */
export async function enqueueRequiredImpl(
  resizer: Resizer,
  opts: EnqueueRequiredOpts,
): Promise<EnqueueRequiredResult> {
  const ctx = opts.ctx ?? {};
  const { media } = opts;
  const pipeline = opts.pipeline ?? 'default';
  const mediaId = requireMediaId(media);
  const sizes = (await resizer.runWaterfall(
    'resolveSizes',
    opts.sizes,
    ctx,
  )) as SizeInput[];
  const formats = opts.formats ?? getResizeConfig().formats;
  const requestedBeforePolicy = expandPreviewRequests(sizes, formats);
  const empty = (): EnqueueRequiredResult => ({
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

  const original = media.original;
  if (
    isSvgOriginal(original) &&
    (isPubliclyServeable(resizer, original?.publicCopy) ||
      isPubliclyServeable(resizer, original))
  ) {
    return {
      ...empty(),
      reason: 'svg',
      requested: requestedBeforePolicy,
      ready: requestedBeforePolicy,
      notRequired: [],
      status: 'ready',
    };
  }

  const readyIdentities = new Set<string>();
  for (const preview of media.previews ?? []) {
    if (preview.key && preview.contentType) {
      readyIdentities.add(
        getPreviewIdentity(preview.sizeKey, preview.format, preview.filters),
      );
    }
  }
  const ready = requestedBeforePolicy.filter((preview) =>
    readyIdentities.has(
      getPreviewIdentity(preview.sizeKey, preview.format, preview.filters),
    ),
  );
  const missingBeforePolicy = requestedBeforePolicy.filter(
    (preview) =>
      !readyIdentities.has(
        getPreviewIdentity(preview.sizeKey, preview.format, preview.filters),
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
        getPreviewIdentity(preview.sizeKey, preview.format, preview.filters),
      ),
  );
  const requiredIdentities = new Set(
    required.map((preview) =>
      getPreviewIdentity(preview.sizeKey, preview.format, preview.filters),
    ),
  );
  const notRequired = missingBeforePolicy.filter(
    (preview) =>
      !requiredIdentities.has(
        getPreviewIdentity(preview.sizeKey, preview.format, preview.filters),
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
  if (!media.original?.key) {
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
          message: `media ${mediaId} has no original key`,
          retryable: false,
          previews: required,
        },
      ],
    };
  }

  const attempt = await enqueueConfirmed(resizer, mediaId, pipeline, required);
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
      return await storage.signedUrl(original, SIGNED_ORIGINAL_TTL_SECONDS);
    } catch (err) {
      getApp().logger.error(
        'resize resolve: signedUrl failed — private original stays unavailable',
        err,
      );
      if (!originalIsPublic) {
        return undefined;
      }
    }
  }
  return originalIsPublic ? storage.publicUrl(original) : undefined;
}

/** Log the never-throw catch; if getApp() itself threw (called pre-Server), use console. */
function logResolveError(err: unknown): void {
  try {
    getApp().logger.error(
      'resize resolve: unexpected internal error — returning the safe empty decision',
      err,
    );
  } catch {
    // getApp() threw (resolve called before the Server exists) — last-resort console.
    console.error(
      'resize resolve: unexpected internal error (no app for logger)',
      err,
    );
  }
}

/** As logResolveError, for prewarm's never-throw catch (11 · §11.1b step 5). */
function logPrewarmError(err: unknown): void {
  try {
    getApp().logger.error(
      'resize prewarm: unexpected internal error — nothing enqueued',
      err,
    );
  } catch {
    console.error(
      'resize prewarm: unexpected internal error (no app for logger)',
      err,
    );
  }
}
