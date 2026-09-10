// The enqueue half of the HTTP-side path (06 · §18). Turns the read's `missing`
// variants into ONE queued task, collapsing a concurrent read fan-out into a single
// dispatch via per-identity dispatch locks. Never throws into the caller's read: on any
// transport failure it logs + releases the survivors' locks so a later read can retry.
// Takes the Resizer type-only (the resizer.ts → engine.ts → enqueue.ts value chain never
// closes back on this module at runtime — 05 · design delta).
import { createHash } from 'node:crypto';
import { getApp } from './app.ts';
import { getResizeConfig } from './config/resize.ts';
import { canonicalizeFilterValue, getPreviewIdentity } from './images.ts';
import type { Resizer } from './resizer.ts';
import type { MissingPreview } from './types.d.ts';

function normalizeVariant(variant: MissingPreview): MissingPreview {
  const normalized: MissingPreview = {
    sizeKey: variant.sizeKey,
    format: variant.format,
  };
  if (variant.filters && Object.keys(variant.filters).length > 0) {
    normalized.filters = canonicalizeFilterValue(
      variant.filters,
    ) as MissingPreview['filters'];
  }
  if (variant.requestedWidth !== undefined) {
    normalized.requestedWidth = variant.requestedWidth;
  }
  if (variant.requestedHeight !== undefined) {
    normalized.requestedHeight = variant.requestedHeight;
  }
  if (variant.fit !== undefined) {
    normalized.fit = variant.fit;
  }
  return normalized;
}

/**
 * Canonicalize a complete queue payload: normalize nested filter keys, remove exact
 * duplicate variants, and sort the result by the canonical representation. The
 * stable result is used by Mongo enqueue so list permutation cannot create another
 * durable task.
 */
export function canonicalizeVariants(
  variants: readonly MissingPreview[],
): MissingPreview[] {
  const byKey = new Map<string, MissingPreview>();
  for (const variant of variants) {
    const normalized = normalizeVariant(variant);
    const key = JSON.stringify(normalized);
    if (!byKey.has(key)) {
      byKey.set(key, normalized);
    }
  }
  return (
    [...byKey.entries()]
      // Do not use localeCompare: durable identity ordering must be independent of
      // the host process locale.
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, variant]) => variant)
  );
}

/**
 * Build a bounded request identity for the durable Mongo dedupe index. The complete
 * file + pipeline identity is included before hashing; the hash keeps the indexed
 * value small even when filters or the variant catalog are large.
 */
export function buildRequestKey(
  mediaId: string,
  pipeline: string,
  variants: readonly MissingPreview[],
): string {
  const canonical = canonicalizeVariants(variants);
  // FNV-style string hashing would be shorter but collision-prone for a durable
  // correctness key. Web Crypto is not guaranteed in every supported Node runtime,
  // so use the built-in SHA-256 implementation.
  const json = JSON.stringify({
    fileId: mediaId,
    pipeline,
    variants: canonical,
  });
  return `v1:${createHash('sha256').update(json).digest('hex')}`;
}

/**
 * §18. Dedup `missing` by identity, acquire a per-variant dispatch lock, enqueue the
 * lock-winners as one task, and release those locks only on failure (a throw OR a
 * `taskId === null` soft failure). On success the locks are deliberately left to expire
 * — they collapse concurrent read fan-out into this single task.
 *
 * Returns the number of variants HANDED TO the transport — the lock-winners on a successful
 * enqueue (prewarm's `enqueued`, 11 · §11.1b step 4). Every non-success path returns 0: no
 * transport, no surviving lock, a throw, or a `taskId === null` soft failure (the released
 * locks let a later read retry, so nothing durable was queued). resolve() ignores the count.
 */
export async function enqueue(
  resizer: Resizer,
  mediaId: string,
  pipeline: string,
  missing: MissingPreview[],
): Promise<number> {
  // Defensive: resolve guarantees a transport before calling us (§17 step 9), but never
  // assume — bail before grabbing any lock we could not use.
  const { transport } = resizer;
  if (!transport) {
    return 0;
  }

  // 1. Canonicalize first so equivalent nested filter objects and list permutations
  // reach the transport in a stable form. The dispatch lock remains per preview
  // identity (not per whole catalog) by design; durable Mongo dedupe handles the
  // complete request key.
  const canonical = canonicalizeVariants(missing);

  // 2. Dedup by identity — the one lookup/lock key, built one way (03 · Identity).
  const byIdentity = new Map<string, MissingPreview>();
  for (const m of canonical) {
    const identity = getPreviewIdentity(m.sizeKey, m.format, m.filters);
    if (!byIdentity.has(identity)) {
      byIdentity.set(identity, m);
    }
  }

  // 3. Acquire the dispatch lock per identity; keep only the winners (others are already
  // in flight from a concurrent read). TTL in ms — the framework driver converts to s.
  const dispatchTtlMs = getResizeConfig().queue.lockTtlMs.dispatch;
  const survivors: MissingPreview[] = [];
  const survivorLockKeys: string[] = [];
  for (const [identity, m] of byIdentity) {
    const lockKey = `resize_dispatch:${mediaId}:${identity}`;
    // A rejecting acquire = this variant is NOT a survivor (log + continue); earlier survivors are
    // unaffected and still reach the transport. enqueue must never throw into the read (1.2b).
    let acquired: boolean;
    try {
      acquired = await resizer.lockProvider.acquire(lockKey, dispatchTtlMs);
    } catch (err) {
      getApp().logger.error(
        `resize enqueue: dispatch-lock acquire failed for ${lockKey} on media ${mediaId} — skipping this variant`,
        err,
      );
      continue;
    }
    if (acquired) {
      survivors.push(m);
      survivorLockKeys.push(lockKey);
    }
  }

  // 4. None survive → nothing to dispatch.
  if (survivors.length === 0) {
    return 0;
  }

  // 5/6. Enqueue; on a throw OR a null taskId (soft failure) log + release the survivors'
  // locks so a later read retries instead of waiting out the TTL. NEVER throw to caller.
  try {
    const { taskId } = await transport.enqueue({
      mediaId,
      pipeline,
      previews: survivors,
    });
    if (taskId === null) {
      getApp().logger.error(
        `resize enqueue: transport returned a null taskId for media ${mediaId} — releasing ${survivorLockKeys.length} dispatch lock(s) so a later read retries`,
      );
      await releaseAll(resizer, survivorLockKeys);
      return 0;
    }
    // A non-null taskId = success: the dispatch locks are intentionally held to their TTL.
    return survivors.length;
  } catch (err) {
    getApp().logger.error(
      `resize enqueue: transport.enqueue threw for media ${mediaId} — releasing ${survivorLockKeys.length} dispatch lock(s) so a later read retries`,
      err,
    );
    await releaseAll(resizer, survivorLockKeys);
    return 0;
  }
}

/** Best-effort release of every given lock key; a failing release is logged, not thrown. */
async function releaseAll(resizer: Resizer, lockKeys: string[]): Promise<void> {
  for (const key of lockKeys) {
    try {
      await resizer.lockProvider.release(key);
    } catch (err) {
      getApp().logger.error(
        `resize enqueue: failed to release dispatch lock ${key}`,
        err,
      );
    }
  }
}
