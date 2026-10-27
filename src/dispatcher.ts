// The enqueue half of the read path. Turns the read's `missing` variants into ONE queued
// task, collapsing a concurrent read fan-out into a single dispatch via per-identity dispatch
// locks. Never throws into the caller's read: on any task-queue failure it logs + releases the
// survivors' locks so a later read can retry. Prewarm's strict counterpart reports exactly what
// was queued instead. A Dispatcher needs only the task queue, the lock store, the queue's timing,
// its Resizer's name and a logger.
import type { LockStore } from './contracts/locks.ts';
import type { NewTask, TaskQueue } from './contracts/taskQueue.ts';
import { canonicalizeVariants, getPreviewIdentity } from './images.ts';
import { DISPATCH_LOCK_OWNER, dispatchLockKey } from './lockKeys.ts';
import type { QueueTiming } from './timing.ts';
import type {
  EnqueueIssue,
  EnqueueReceipt,
  MissingPreview,
  PreviewScope,
  ResizeLogger,
} from './types.d.ts';

export interface DispatcherDeps {
  tasks: TaskQueue;
  locks: LockStore;
  timing: QueueTiming; // the task queue's validated timing (the dispatch lock TTL)
  name: string; // the Resizer's name: part of every identity, lock key and task
  logger: ResizeLogger;
}

/** What to queue: variants of one media and pipeline, on one queue. */
export interface DispatchRequest {
  mediaId: string;
  pipeline: string;
  previews: MissingPreview[];
  queue: string;
}

export interface ConfirmedEnqueueResult {
  accepted: MissingPreview[];
  unconfirmed: MissingPreview[];
  tasks: EnqueueReceipt[];
  issues: EnqueueIssue[];
}

/** Prewarm without a task queue (an eager-only Resizer): nothing is queued, and no retry helps. */
export function noQueueResult(
  previews: MissingPreview[],
): ConfirmedEnqueueResult {
  const canonical = canonicalizeVariants(previews);
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

/** Queues missing variants for one Resizer. */
export class Dispatcher {
  readonly #deps: DispatcherDeps;

  constructor(deps: DispatcherDeps) {
    this.#deps = deps;
  }

  /**
   * Dedup `missing` by identity, acquire a per-variant dispatch lock, enqueue the
   * lock-winners as one task, and release those locks only on failure (a throw OR any add
   * result but `added`, a soft failure). On success the locks are deliberately left to expire
   * — they collapse concurrent read fan-out into this single task.
   *
   * The read path's best-effort enqueue (prewarm uses enqueueConfirmed instead). Returns the
   * number of variants HANDED TO the task queue — the lock-winners on a successful enqueue.
   * Every non-success path returns 0: no surviving lock, a throw, or any add result but `added`
   * (a soft failure: the variant stays unconfirmed, nothing throws, and the released locks let a
   * later read retry).
   * resolve() ignores the count. Never throws.
   */
  async enqueue(req: DispatchRequest): Promise<number> {
    const { tasks, locks, timing, name, logger } = this.#deps;
    const { mediaId, pipeline, previews: missing, queue } = req;

    // 1. Canonicalize first so equivalent nested filter objects and list permutations
    // reach the task queue in a stable form. The dispatch lock remains per preview
    // identity (not per whole catalog) by design.
    const canonical = canonicalizeVariants(missing);

    // 2. Dedup by identity — the one lookup/lock key, built one way. The scope keeps another
    // pipeline's (or Resizer's) dispatch lock from suppressing this request.
    const scope: PreviewScope = { resizer: name, pipeline };
    const byIdentity = new Map<string, MissingPreview>();
    for (const m of canonical) {
      const identity = getPreviewIdentity(
        scope,
        m.sizeKey,
        m.format,
        m.filters,
      );
      if (!byIdentity.has(identity)) {
        byIdentity.set(identity, m);
      }
    }

    // 3. Acquire the dispatch lock per identity; keep only the winners (others are already
    // in flight from a concurrent read). Every dispatch lock has the one owner DISPATCH_LOCK_OWNER.
    const dispatchTtlMs = timing.lockTtlMs.dispatch;
    const survivors: MissingPreview[] = [];
    const survivorLockKeys: string[] = [];
    const attempts = await acquireDispatchLocks(
      locks,
      mediaId,
      byIdentity,
      dispatchTtlMs,
    );
    for (const attempt of attempts) {
      // A rejecting acquire = this variant is NOT a survivor (log + continue); the other survivors
      // are unaffected and still reach the task queue. enqueue must never throw into the read.
      if (attempt.failed) {
        logger.error(
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

    // 5/6. Enqueue; on a throw OR any result but `added` (a soft failure) log + release the
    // survivors' locks so a later read retries instead of waiting out the TTL. NEVER throw to
    // caller.
    try {
      const added = await tasks.add(
        newTask(name, queue, mediaId, pipeline, survivors),
      );
      if (added.status !== 'added') {
        logger.error(
          `resize enqueue: the task queue did not add the task for media ${mediaId} (status ${added.status}) — releasing ${survivorLockKeys.length} dispatch lock(s) so a later read retries`,
        );
        await releaseAll(logger, locks, survivorLockKeys);
        return 0;
      }
      // `added` = success: the dispatch locks are intentionally held to their TTL.
      return survivors.length;
    } catch (err) {
      logger.error(
        `resize enqueue: adding the task threw for media ${mediaId} — releasing ${survivorLockKeys.length} dispatch lock(s) so a later read retries`,
        err,
      );
      await releaseAll(logger, locks, survivorLockKeys);
      return 0;
    }
  }

  /**
   * Strict counterpart to enqueue(), for prewarm. A dispatch lock is only an optimization:
   * losing it is never reported as accepted. Coverage is accepted only from an `added` enqueue
   * result or from an optional TaskQueue.findActive() proof.
   */
  async enqueueConfirmed(
    req: DispatchRequest,
  ): Promise<ConfirmedEnqueueResult> {
    const { tasks: taskQueue, locks, timing, name, logger } = this.#deps;
    const { mediaId, pipeline, previews: missing, queue } = req;
    const canonical = canonicalizeVariants(missing);

    // Receipts from findActive belong to the same Resizer and pipeline (the task queue filters by
    // both), so one scope covers every identity built here.
    const scope: PreviewScope = { resizer: name, pipeline };
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
    const dispatchTtlMs = timing.lockTtlMs.dispatch;

    const attempts = await acquireDispatchLocks(
      locks,
      mediaId,
      byIdentity,
      dispatchTtlMs,
    );
    for (const attempt of attempts) {
      if (attempt.failed) {
        logger.error(
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
        const added = await taskQueue.add(
          newTask(name, queue, mediaId, pipeline, winners),
        );
        // Only `added` with a task ID is a receipt; any other result is unconfirmed.
        if (
          added.status !== 'added' ||
          typeof added.taskId !== 'string' ||
          added.taskId.length === 0
        ) {
          issues.push({
            code: 'RESIZE_ENQUEUE_UNCONFIRMED',
            message: 'the task queue did not confirm the task',
            retryable: true,
            previews: winners,
          });
          await releaseAll(logger, locks, winnerKeys);
        } else {
          const receipt = { taskId: added.taskId, previews: winners };
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
        logger.error(
          `resize prewarm: adding the task threw for media ${mediaId}`,
          error,
        );
        issues.push({
          code: 'RESIZE_ENQUEUE_QUEUE_FAILED',
          message: 'adding the task failed; outcome is unconfirmed',
          retryable: true,
          previews: winners,
        });
        await releaseAll(logger, locks, winnerKeys);
      }
    }

    if (unresolved.size > 0 && taskQueue.findActive) {
      try {
        const confirmations = (
          await taskQueue.findActive({ resizer: name, mediaId, pipeline })
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
            const requested = unresolvedByPayload.get(
              variantPayloadKey(preview),
            );
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
        logger.error(
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
  locks: LockStore,
  mediaId: string,
  byIdentity: Map<string, MissingPreview>,
  ttlMs: number,
): Promise<LockAttempt[]> {
  return Promise.all(
    [...byIdentity].map(async ([identity, preview]): Promise<LockAttempt> => {
      const lockKey = dispatchLockKey(mediaId, identity);
      try {
        const acquired = Boolean(
          await locks.acquire(lockKey, DISPATCH_LOCK_OWNER, ttlMs),
        );
        return { preview, lockKey, acquired, failed: false };
      } catch (error) {
        return { preview, lockKey, acquired: false, failed: true, error };
      }
    }),
  );
}

/** Best-effort release of every given dispatch lock; a failing release is logged, not thrown. */
async function releaseAll(
  logger: ResizeLogger,
  locks: LockStore,
  lockKeys: string[],
): Promise<void> {
  for (const key of lockKeys) {
    try {
      await locks.release(key, DISPATCH_LOCK_OWNER);
    } catch (err) {
      logger.error(
        `resize enqueue: failed to release dispatch lock ${key}`,
        err,
      );
    }
  }
}

/** A task for the queue, with its variants in canonical form. */
function newTask(
  resizer: string,
  queue: string,
  mediaId: string,
  pipeline: string,
  variants: MissingPreview[],
): NewTask {
  return {
    resizer,
    queue,
    mediaId,
    pipeline,
    previews: canonicalizeVariants(variants),
  };
}
