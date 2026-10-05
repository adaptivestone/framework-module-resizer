// The enqueue half of the HTTP-side path (06 · §18). Turns the read's `missing`
// variants into ONE queued task, collapsing a concurrent read fan-out into a single
// dispatch via per-identity dispatch locks. Never throws into the caller's read: on any
// task-queue failure it logs + releases the survivors' locks so a later read can retry.
// Takes the Resizer type-only (the resizer.ts → engine.ts → enqueue.ts value chain never
// closes back on this module at runtime — 05 · design delta).
import { createHash } from 'node:crypto';
import type { NewTask } from './contracts/taskQueue.ts';
import { canonicalizeFilterValue, getPreviewIdentity } from './images.ts';
import { timingOf } from './queue.ts';
import type { Resizer } from './resizer.ts';
import type {
  EnqueueIssue,
  EnqueueReceipt,
  MissingPreview,
  PreviewScope,
} from './types.d.ts';

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
 * stable result goes into the request key, so a list permutation cannot create another
 * durable task in a queue that deduplicates by it.
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
 * Build a bounded request identity a task queue can deduplicate by (e.g. the Mongo queue's
 * unique index). The complete
 * file + resizer + queue + pipeline identity is included before hashing; the hash keeps the
 * indexed value small even when filters or the variant catalog are large. The queue is part
 * of the key, so the same request on another queue is a separate task: an interactive
 * request never waits behind a bulk backfill that happens to hold the same payload.
 */
export function buildRequestKey(task: {
  mediaId: string;
  resizer: string;
  queue: string;
  pipeline: string;
  previews: readonly MissingPreview[];
}): string {
  const canonical = canonicalizeVariants(task.previews);
  // FNV-style string hashing would be shorter but collision-prone for a durable
  // correctness key. Web Crypto is not guaranteed in every supported Node runtime,
  // so use the built-in SHA-256 implementation.
  const json = JSON.stringify({
    fileId: task.mediaId,
    resizer: task.resizer,
    queue: task.queue,
    pipeline: task.pipeline,
    variants: canonical,
  });
  return `v2:${createHash('sha256').update(json).digest('hex')}`;
}

/**
 * §18. Dedup `missing` by identity, acquire a per-variant dispatch lock, enqueue the
 * lock-winners as one task, and release those locks only on failure (a throw OR a
 * `taskId === null` soft failure). On success the locks are deliberately left to expire
 * — they collapse concurrent read fan-out into this single task.
 *
 * The read path's best-effort enqueue (prewarm uses enqueueConfirmed instead). Returns the number
 * of variants HANDED TO the task queue — the lock-winners on a successful enqueue. Every
 * non-success path returns 0: no task queue, no surviving lock, a throw, or a `taskId === null`
 * soft failure (the released locks let a later read retry, so nothing durable was queued).
 * resolve() ignores the count.
 */
export async function enqueue(
  resizer: Resizer,
  mediaId: string,
  pipeline: string,
  missing: MissingPreview[],
  queue: string,
): Promise<number> {
  // Defensive: resolve guarantees a task queue before calling us (§17 step 9), but never
  // assume — bail before grabbing any lock we could not use.
  const { tasks } = resizer;
  if (!tasks) {
    return 0;
  }

  // 1. Canonicalize first so equivalent nested filter objects and list permutations
  // reach the task queue in a stable form. The dispatch lock remains per preview
  // identity (not per whole catalog) by design; a deduplicating task queue handles the
  // complete request key.
  const canonical = canonicalizeVariants(missing);

  // 2. Dedup by identity — the one lookup/lock key, built one way (03 · Identity). The scope
  // keeps another pipeline's (or Resizer's) dispatch lock from suppressing this request.
  const scope: PreviewScope = { resizer: resizer.name, pipeline };
  const byIdentity = new Map<string, MissingPreview>();
  for (const m of canonical) {
    const identity = getPreviewIdentity(scope, m.sizeKey, m.format, m.filters);
    if (!byIdentity.has(identity)) {
      byIdentity.set(identity, m);
    }
  }

  // 3. Acquire the dispatch lock per identity; keep only the winners (others are already
  // in flight from a concurrent read). TTL in ms — the framework driver converts to s.
  const dispatchTtlMs = timingOf(tasks).lockTtlMs.dispatch;
  const survivors: MissingPreview[] = [];
  const survivorLockKeys: string[] = [];
  const attempts = await acquireDispatchLocks(
    resizer,
    mediaId,
    byIdentity,
    dispatchTtlMs,
  );
  for (const attempt of attempts) {
    // A rejecting acquire = this variant is NOT a survivor (log + continue); the other survivors
    // are unaffected and still reach the task queue. enqueue must never throw into the read.
    if (attempt.failed) {
      resizer.logger.error(
        `resize enqueue: dispatch-lock acquire failed for ${attempt.lockKey} on media ${mediaId} — skipping this variant`,
        attempt.error,
      );
    } else if (attempt.acquired) {
      survivors.push(attempt.preview);
      survivorLockKeys.push(attempt.lockKey);
    }
  }

  // 4. None survive → nothing to dispatch.
  if (survivors.length === 0) {
    return 0;
  }

  // 5/6. Enqueue; on a throw OR a null taskId (soft failure) log + release the survivors'
  // locks so a later read retries instead of waiting out the TTL. NEVER throw to caller.
  try {
    const { taskId } = await tasks.add(
      newTask(resizer.name, queue, mediaId, pipeline, survivors),
    );
    if (taskId === null) {
      resizer.logger.error(
        `resize enqueue: the task queue returned a null taskId for media ${mediaId} — releasing ${survivorLockKeys.length} dispatch lock(s) so a later read retries`,
      );
      await releaseAll(resizer, survivorLockKeys);
      return 0;
    }
    // A non-null taskId = success: the dispatch locks are intentionally held to their TTL.
    return survivors.length;
  } catch (err) {
    resizer.logger.error(
      `resize enqueue: adding the task threw for media ${mediaId} — releasing ${survivorLockKeys.length} dispatch lock(s) so a later read retries`,
      err,
    );
    await releaseAll(resizer, survivorLockKeys);
    return 0;
  }
}

export interface ConfirmedEnqueueResult {
  accepted: MissingPreview[];
  unconfirmed: MissingPreview[];
  tasks: EnqueueReceipt[];
  issues: EnqueueIssue[];
}

function variantPayloadKey(variant: MissingPreview): string {
  return JSON.stringify(canonicalizeVariants([variant])[0]);
}

interface VariantGroups {
  unique: Map<string, MissingPreview>;
  conflicts: Map<string, MissingPreview[]>;
}

/**
 * Canonicalize a complete payload before grouping it by preview identity. Exact duplicate
 * payloads are harmless; different payloads sharing an identity are not safe to confirm.
 */
function groupVariants(
  variants: readonly MissingPreview[],
  scope: PreviewScope,
): VariantGroups {
  const grouped = new Map<string, MissingPreview[]>();
  for (const preview of canonicalizeVariants(variants)) {
    const identity = getPreviewIdentity(
      scope,
      preview.sizeKey,
      preview.format,
      preview.filters,
    );
    const group = grouped.get(identity);
    if (group) {
      group.push(preview);
    } else {
      grouped.set(identity, [preview]);
    }
  }

  const unique = new Map<string, MissingPreview>();
  const conflicts = new Map<string, MissingPreview[]>();
  for (const [identity, previews] of grouped) {
    if (previews.length === 1) {
      unique.set(identity, previews[0]);
    } else {
      conflicts.set(identity, previews);
    }
  }
  return { unique, conflicts };
}

/**
 * Strict counterpart to enqueue(). A dispatch lock is only an optimization: losing it is
 * never reported as accepted. Coverage is accepted only from a non-null enqueue receipt or
 * from an optional TaskQueue.findActive() proof.
 */
export async function enqueueConfirmed(
  resizer: Resizer,
  mediaId: string,
  pipeline: string,
  missing: MissingPreview[],
  queue: string,
): Promise<ConfirmedEnqueueResult> {
  const taskQueue = resizer.tasks;
  const canonical = canonicalizeVariants(missing);
  if (!taskQueue) {
    return {
      accepted: [],
      unconfirmed: canonical,
      tasks: [],
      issues: [
        {
          code: 'RESIZE_ENQUEUE_NO_QUEUE',
          message: 'no task queue is configured',
          retryable: false,
          previews: canonical,
        },
      ],
    };
  }

  // Receipts from findActive belong to the same Resizer and pipeline (the task queue filters by
  // both), so one scope covers every identity built here.
  const scope: PreviewScope = { resizer: resizer.name, pipeline };
  const requestedGroups = groupVariants(canonical, scope);
  const byIdentity = requestedGroups.unique;
  const conflicts = [...requestedGroups.conflicts.values()].flat();
  const winners: MissingPreview[] = [];
  const winnerKeys: string[] = [];
  const unresolved = new Map(byIdentity);
  const issues: EnqueueIssue[] = [];
  if (conflicts.length > 0) {
    issues.push({
      code: 'RESIZE_ENQUEUE_VARIANT_CONFLICT',
      message:
        'multiple variant payloads share one preview identity; none can be confirmed safely',
      retryable: false,
      previews: conflicts,
    });
  }
  const lockContended: MissingPreview[] = [];
  const lockFailed: MissingPreview[] = [];
  const dispatchTtlMs = timingOf(taskQueue).lockTtlMs.dispatch;

  const attempts = await acquireDispatchLocks(
    resizer,
    mediaId,
    byIdentity,
    dispatchTtlMs,
  );
  for (const attempt of attempts) {
    if (attempt.failed) {
      resizer.logger.error(
        `resize prewarm: dispatch-lock acquire failed for ${attempt.lockKey}`,
        attempt.error,
      );
      lockFailed.push(attempt.preview);
    } else if (attempt.acquired) {
      winners.push(attempt.preview);
      winnerKeys.push(attempt.lockKey);
    } else {
      lockContended.push(attempt.preview);
    }
  }

  const accepted = new Map<string, MissingPreview>();
  const tasks: EnqueueReceipt[] = [];
  const activeReceiptConflicts = new Map<string, MissingPreview>();
  if (winners.length > 0) {
    try {
      const { taskId } = await taskQueue.add(
        newTask(resizer.name, queue, mediaId, pipeline, winners),
      );
      if (typeof taskId !== 'string' || taskId.length === 0) {
        issues.push({
          code: 'RESIZE_ENQUEUE_UNCONFIRMED',
          message: 'the task queue returned a null taskId',
          retryable: true,
          previews: winners,
        });
        await releaseAll(resizer, winnerKeys);
      } else {
        const receipt = { taskId, previews: winners };
        tasks.push(receipt);
        for (const preview of winners) {
          const identity = getPreviewIdentity(
            scope,
            preview.sizeKey,
            preview.format,
            preview.filters,
          );
          accepted.set(identity, preview);
          unresolved.delete(identity);
        }
      }
    } catch (error) {
      resizer.logger.error(
        `resize prewarm: adding the task threw for media ${mediaId}`,
        error,
      );
      issues.push({
        code: 'RESIZE_ENQUEUE_QUEUE_FAILED',
        message: 'adding the task failed; outcome is unconfirmed',
        retryable: true,
        previews: winners,
      });
      await releaseAll(resizer, winnerKeys);
    }
  }

  if (unresolved.size > 0 && taskQueue.findActive) {
    try {
      const confirmations = (
        await taskQueue.findActive({ resizer: resizer.name, mediaId, pipeline })
      ).map((receipt) => ({
        taskId: receipt.taskId,
        previews: canonicalizeVariants(receipt.previews ?? []),
      }));
      const unresolvedByPayload = new Map(
        [...unresolved.entries()].map(([identity, preview]) => [
          variantPayloadKey(preview),
          { identity, preview },
        ]),
      );
      for (const receipt of confirmations) {
        if (
          typeof receipt.taskId !== 'string' ||
          receipt.taskId.trim().length === 0
        ) {
          continue;
        }
        // Inspect the complete receipt before matching any requested payload. Filtering to
        // the requested payload first would hide a second payload that makes the identity
        // ambiguous in the active task.
        const receiptGroups = groupVariants(receipt.previews, scope);
        for (const identity of receiptGroups.conflicts.keys()) {
          const requested = unresolved.get(identity);
          if (requested && !activeReceiptConflicts.has(identity)) {
            activeReceiptConflicts.set(identity, requested);
          }
        }
        const covered: MissingPreview[] = [];
        for (const preview of receiptGroups.unique.values()) {
          const requested = unresolvedByPayload.get(variantPayloadKey(preview));
          if (requested) {
            accepted.set(requested.identity, requested.preview);
            unresolved.delete(requested.identity);
            unresolvedByPayload.delete(variantPayloadKey(preview));
            covered.push(requested.preview);
          }
        }
        if (covered.length > 0) {
          tasks.push({ taskId: receipt.taskId, previews: covered });
        }
      }
    } catch (error) {
      resizer.logger.error(
        `resize prewarm: active-task confirmation failed for media ${mediaId}`,
        error,
      );
      issues.push({
        code: 'RESIZE_ENQUEUE_CONFIRM_FAILED',
        message: 'the task queue could not confirm active task coverage',
        retryable: true,
        previews: [...unresolved.values()],
      });
    }
  }

  const unconfirmed = [...unresolved.values(), ...conflicts];
  const receiptConflictPreviews = [...activeReceiptConflicts.entries()]
    .filter(([identity]) => unresolved.has(identity))
    .map(([, preview]) => preview);
  if (receiptConflictPreviews.length > 0) {
    issues.push({
      code: 'RESIZE_ENQUEUE_VARIANT_CONFLICT',
      message:
        'multiple active-task payloads share one preview identity; none can be confirmed safely',
      retryable: false,
      previews: receiptConflictPreviews,
    });
  }
  if (lockContended.length > 0) {
    issues.push({
      code: 'RESIZE_ENQUEUE_LOCK_CONTENDED',
      message:
        'dispatch lock is held but no active task coverage was confirmed',
      retryable: true,
      previews: lockContended,
    });
  }
  if (lockFailed.length > 0) {
    issues.push({
      code: 'RESIZE_ENQUEUE_LOCK_FAILED',
      message: 'dispatch lock could not be acquired or confirmed',
      retryable: true,
      previews: lockFailed,
    });
  }

  // An issue explains only what stayed unconfirmed: a preview that findActive later confirmed
  // drops out of it, and an issue left with none is removed, so an accepted request carries
  // no retryable issue.
  const unresolvedIdentities = new Set(
    unconfirmed.map((preview) =>
      getPreviewIdentity(
        scope,
        preview.sizeKey,
        preview.format,
        preview.filters,
      ),
    ),
  );
  const remainingIssues = issues.flatMap((issue) => {
    const previews = issue.previews.filter((preview) =>
      unresolvedIdentities.has(
        getPreviewIdentity(
          scope,
          preview.sizeKey,
          preview.format,
          preview.filters,
        ),
      ),
    );
    return previews.length > 0 ? [{ ...issue, previews }] : [];
  });

  return {
    accepted: [...accepted.values()],
    unconfirmed,
    tasks,
    issues: remainingIssues,
  };
}

interface LockAttempt {
  preview: MissingPreview;
  lockKey: string;
  acquired: boolean; // false for a lock another request holds, and for a failed acquire
  failed: boolean; // the acquire rejected (`error`)
  error?: unknown;
}

/**
 * Acquire one dispatch lock per identity, all at once: a read with many missing variants waits
 * for the slowest acquire, not for one database round trip after another. Never rejects; the
 * results keep the input order, and the caller decides how to report a held or failed lock.
 */
async function acquireDispatchLocks(
  resizer: Resizer,
  mediaId: string,
  byIdentity: Map<string, MissingPreview>,
  ttlMs: number,
): Promise<LockAttempt[]> {
  return Promise.all(
    [...byIdentity].map(async ([identity, preview]): Promise<LockAttempt> => {
      const lockKey = `resize_dispatch:${mediaId}:${identity}`;
      try {
        const acquired = Boolean(await resizer.db.acquireLock(lockKey, ttlMs));
        return { preview, lockKey, acquired, failed: false };
      } catch (error) {
        return { preview, lockKey, acquired: false, failed: true, error };
      }
    }),
  );
}

/** Best-effort release of every given lock key; a failing release is logged, not thrown. */
async function releaseAll(resizer: Resizer, lockKeys: string[]): Promise<void> {
  for (const key of lockKeys) {
    try {
      await resizer.db.releaseLock(key);
    } catch (err) {
      resizer.logger.error(
        `resize enqueue: failed to release dispatch lock ${key}`,
        err,
      );
    }
  }
}

/** A task for the queue: canonical variants plus the key that de-duplicates identical requests. */
function newTask(
  resizer: string,
  queue: string,
  mediaId: string,
  pipeline: string,
  variants: MissingPreview[],
): NewTask {
  const previews = canonicalizeVariants(variants);
  return {
    resizer,
    queue,
    mediaId,
    pipeline,
    previews,
    requestKey: buildRequestKey({
      mediaId,
      resizer,
      queue,
      pipeline,
      previews,
    }),
  };
}
