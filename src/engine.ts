// The read-path engine (06 · §17). `resizer.resolve` delegates here: it partitions the
// requested size×format grid into ready (served from an existing preview, an SVG original,
// or an "original already fits" original) vs missing (handed to enqueue), threading three
// host waterfalls (resolveSizes / beforeEnqueue / formatPublicUrls) and never throwing into
// the caller's read. All URLs come from the PURE, I/O-free storage.publicUrl; the only I/O
// is the owner/admin-gated signedUrl (itself caught + fallen back). Imports the Resizer
// TYPE only — resizer.ts imports resolveImpl as a value, so this cycle is runtime-free.
import { getApp } from './app.ts';
import { getResizeConfig, requiredFormats } from './config/resize.ts';
import { enqueue } from './enqueue.ts';
import { isPositiveFinite } from './helpers/guards.ts';
import {
  expandMissingPreviews,
  getFilterSig,
  getPreviewIdentity,
  getSizeKey,
  requireMediaId,
} from './images.ts';
import type { Resizer } from './resizer.ts';
import type {
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
  formats?: PreviewFormat[]; // default = requiredFormats(config)
  ctx?: Record<string, unknown>; // threaded to read-path hooks; ctx.isOwner/isAdmin gate signedUrl
  enqueueMissing?: boolean; // default true
}

export interface PrewarmOpts {
  media: MediaLike;
  sizes: SizeInput[];
  pipeline?: string; // selects a registered pipeline; default 'default'
  formats?: PreviewFormat[]; // default = requiredFormats(config)
  ctx?: Record<string, unknown>; // reaches the read-path waterfalls only (worker ctx stays {})
}

// Owner/admin private-original reads: short-lived by design (the only read-path I/O). A
// small constant is fine — the URL is re-minted on every read, so it never needs to outlive
// one response.
const SIGNED_ORIGINAL_TTL_SECONDS = 300; // 5 minutes

/**
 * §17 steps 1–11. See the module header for the shape. The ENTIRE body runs inside a
 * try/catch (the never-throw guarantee, layer 3): on any unexpected internal error it logs
 * and returns the safe value `{ decision: { ready-so-far, missing: [] }, output: <that> }`
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

    // 2. Active format list — read + worker MUST agree (requiredFormats).
    const formats = opts.formats ?? requiredFormats(getResizeConfig());

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

    if (
      original &&
      (original.contentType === 'image/svg+xml' || original.format === 'svg')
    ) {
      // 6. SVG pass-through — served at every size×format from the ORIGINAL url, never
      // resized or enqueued (vector resize is a no-op); the requested format is ignored. Routes
      // through the SAME original-URL rule as the fast-path (06 · §17 step 6): signedUrl for an
      // owner/admin when the driver supports it (private-bucket SVG read), else pure publicUrl.
      const url = await originalUrl(resizer, original, ctx);
      for (const size of sizes) {
        let sizeKey: string;
        try {
          sizeKey = getSizeKey(size);
        } catch {
          continue; // a size with nothing usable is skipped (as in step 7)
        }
        for (const format of formats) {
          const entry: ReadyEntry = { sizeKey, format, url, isOriginal: true };
          if (size.filters) {
            entry.filters = size.filters;
          }
          ready.push(entry);
        }
      }
      // missing stays empty; skip step 7.
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
            getFilterSig(size.filters) === 'none' && // (a) no filters
            !size.fit &&
            isPositiveFinite(size.width) && // (b) plain cover WxH
            isPositiveFinite(size.height) &&
            isPositiveFinite(original.width) && // (c) original dims known
            isPositiveFinite(original.height) &&
            original.width <= size.width && // (d) not larger than the box
            original.height <= size.height
          ) {
            ready.push({
              sizeKey,
              format,
              url: await originalUrl(resizer, original, ctx),
              isOriginal: true,
            });
            continue;
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

    // 9. Enqueue the missing variants (default on). No transport → log ONCE and skip
    // (eager-only host — missing variants stay placeholders); else enqueue, guarded.
    if (opts.enqueueMissing !== false && decision.missing.length > 0) {
      if (!resizer.transport) {
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

    // 10. Host turns the decision into its response shape. No tap → output === decision.
    const output = await resizer.runWaterfall(
      'formatPublicUrls',
      decision,
      ctx,
    );

    // 11.
    return { decision, output };
  } catch (err) {
    // Never-throw guarantee (layer 3): the read must not break on an internal error.
    logResolveError(err);
    const safe: ReadDecision = { ready, missing: [] };
    return { decision: safe, output: safe };
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

    // 2. SVG originals are pass-through — never resized or enqueued (06 · §17 step 6). No-op.
    const original = media.original;
    if (
      original &&
      (original.contentType === 'image/svg+xml' || original.format === 'svg')
    ) {
      getApp().logger.info(
        `resize prewarm: media ${mediaId} original is SVG — pass-through, nothing to warm`,
      );
      return { enqueued: 0 };
    }

    // 2. Expand sizes × formats → deduped MissingPreview[], skipping unbuildable sizes + existing
    //    identities. The fast-path is deliberately NOT consulted here (see the doc comment).
    const formats = opts.formats ?? requiredFormats(getResizeConfig());
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

/**
 * The public URL for an original-backed ready entry. Owner/admin reads get a signed URL
 * when the driver supports it — the ONLY read-path I/O, so it is caught and falls back to
 * the pure publicUrl on any error (the read must not break on a presign hiccup).
 */
async function originalUrl(
  resizer: Resizer,
  original: Original,
  ctx: Record<string, unknown>,
): Promise<string> {
  const storage = resizer.storage;
  if ((ctx.isOwner || ctx.isAdmin) && storage.signedUrl) {
    try {
      return await storage.signedUrl(original, SIGNED_ORIGINAL_TTL_SECONDS);
    } catch (err) {
      getApp().logger.error(
        'resize resolve: signedUrl failed — falling back to the public URL',
        err,
      );
    }
  }
  return storage.publicUrl(original);
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
