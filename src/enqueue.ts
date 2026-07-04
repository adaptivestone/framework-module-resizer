// The enqueue half of the HTTP-side path (06 · §18). Turns the read's `missing`
// variants into ONE queued task, collapsing a concurrent read fan-out into a single
// dispatch via per-identity dispatch locks. Never throws into the caller's read: on any
// transport failure it logs + releases the survivors' locks so a later read can retry.
// Takes the Resizer type-only (the resizer.ts → engine.ts → enqueue.ts value chain never
// closes back on this module at runtime — 05 · design delta).
import { getApp } from './app.ts';
import { getResizeConfig } from './config/resize.ts';
import { getPreviewIdentity } from './images.ts';
import type { Resizer } from './resizer.ts';
import type { MissingPreview } from './types.d.ts';

/**
 * §18. Dedup `missing` by identity, acquire a per-variant dispatch lock, enqueue the
 * lock-winners as one task, and release those locks only on failure (a throw OR a
 * `taskId === null` soft failure). On success the locks are deliberately left to expire
 * — they collapse concurrent read fan-out into this single task.
 */
export async function enqueue(
  resizer: Resizer,
  mediaId: string,
  pipeline: string,
  missing: MissingPreview[],
): Promise<void> {
  // Defensive: resolve guarantees a transport before calling us (§17 step 9), but never
  // assume — bail before grabbing any lock we could not use.
  const { transport } = resizer;
  if (!transport) {
    return;
  }

  // 1. Dedup by identity — the one lookup/lock key, built one way (03 · Identity).
  const byIdentity = new Map<string, MissingPreview>();
  for (const m of missing) {
    const identity = getPreviewIdentity(m.sizeKey, m.format, m.filters);
    if (!byIdentity.has(identity)) {
      byIdentity.set(identity, m);
    }
  }

  // 2. Acquire the dispatch lock per identity; keep only the winners (others are already
  // in flight from a concurrent read). TTL in ms — the framework driver converts to s.
  const dispatchTtlMs = getResizeConfig().queue.lockTtlMs.dispatch;
  const survivors: MissingPreview[] = [];
  const survivorLockKeys: string[] = [];
  for (const [identity, m] of byIdentity) {
    const lockKey = `resize_dispatch:${mediaId}:${identity}`;
    if (await resizer.lockProvider.acquire(lockKey, dispatchTtlMs)) {
      survivors.push(m);
      survivorLockKeys.push(lockKey);
    }
  }

  // 3. None survive → nothing to dispatch.
  if (survivors.length === 0) {
    return;
  }

  // 4/5. Enqueue; on a throw OR a null taskId (soft failure) log + release the survivors'
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
    }
    // A non-null taskId = success: the dispatch locks are intentionally held to their TTL.
  } catch (err) {
    getApp().logger.error(
      `resize enqueue: transport.enqueue threw for media ${mediaId} — releasing ${survivorLockKeys.length} dispatch lock(s) so a later read retries`,
      err,
    );
    await releaseAll(resizer, survivorLockKeys);
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
