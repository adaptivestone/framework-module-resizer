// The enqueue half of the read path, and prewarm's strict counterpart. One dispatch turns the
// missing variants of one media and pipeline into ONE task on one queue, behind one gate per
// Resizer, media, pipeline and queue: while a task of theirs is queued, running, waiting for a
// retry or cooling down after a dead-letter, no other task is queued for them. A request on
// another queue is a separate task. A task queue with gatesByTask (the database queue) keeps the
// gate itself, so one `add` is the whole dispatch, and it reports `in-flight` while the gate is
// held. Beside a queue without it (SQS), the Dispatcher takes the gate lock with a fresh owner for
// coordination.gateTtlMs and hands the owner to the task as `gateOwner`; the worker then holds
// that lock until the task ends. When the queue does not say it stored the task, the lock is
// shortened to one lease of the call's queue, or gateTtlMs when that is shorter (see #dispatch).
// A call on a queue name the task queue does not serve, or whose timing is invalid, queues
// nothing. The read path never throws and counts only an added task; prewarm accepts only what the
// new task, or the active one, holds. A Dispatcher needs only the task queue, the lock store
// (beside a queue without gatesByTask), the coordination, the timing of each queue name, its
// Resizer's name and a logger.
import type { LockStore } from './contracts/locks.ts';
import type {
  NewTask,
  TaskAddResult,
  TaskQueue,
} from './contracts/taskQueue.ts';
import type { Coordination } from './coordination.ts';
import { logNeverThrow } from './helpers/log.ts';
import { randomHex } from './helpers/random.ts';
import { canonicalizeVariants, getPreviewIdentity } from './images.ts';
import { gateKey } from './lockKeys.ts';
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
  locks: LockStore | undefined; // the gate locks, beside a task queue without gatesByTask
  coordination: Coordination; // the validated policy: a gate lock lasts gateTtlMs
  // The timing of a queue name (timingOf(tasks, queue)); throws when it is invalid. Its lease is
  // how long a call's gate lock is kept when the queue may or may not have stored the task (never
  // longer than gateTtlMs).
  timingOf: (queue: string) => QueueTiming;
  name: string; // the Resizer's name: part of every identity, gate key and task
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
  // Set only when the timing of the request's queue is invalid: nothing was queued, and the caller
  // reports this error as it reports a task queue that cannot be used.
  timingError?: unknown;
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

/** What one dispatch did: the add result, or why nothing was added. */
type DispatchOutcome =
  | TaskAddResult
  | { status: 'not-served' } // the task queue does not serve the request's queue
  | { status: 'timing-invalid'; error: unknown } // the request's queue has invalid timing
  | { status: 'add-failed'; error: unknown } // `add` threw
  | { status: 'gate-held' } // another request holds the gate lock
  | { status: 'gate-failed'; error: unknown } // the gate lock could not be acquired
  // `add` resolved something that is not a TaskAddResult; `stored`: its status still says
  // 'added' (e.g. with an empty task id), so the queue may hold the task.
  | { status: 'invalid'; stored: boolean };

/** Why a call on `queue` queues nothing when the task queue does not serve that name. */
const notServed = (queue: string): string =>
  `cannot queue to '${queue}': its task queue does not serve that queue (an unknown queue name, or a queue on another backend; one Resizer cannot use two backends yet)`;

const TASK_ADD_RESULT =
  "TaskAddResult ({ status: 'added', taskId } | { status: 'in-flight', taskId? } | { status: 'unconfirmed' })";

/** True for a result in one of the TaskAddResult shapes; an added task needs a non-empty id. */
function isTaskAddResult(result: unknown): result is TaskAddResult {
  if (typeof result !== 'object' || result === null || !('status' in result)) {
    return false;
  }
  if (result.status === 'added') {
    return (
      'taskId' in result &&
      typeof result.taskId === 'string' &&
      result.taskId.length > 0
    );
  }
  return result.status === 'in-flight' || result.status === 'unconfirmed';
}

/** Queues missing variants for one Resizer. */
export class Dispatcher {
  readonly #deps: DispatcherDeps;
  // An add result in none of the TaskAddResult shapes is logged once, not on every read.
  #warnedInvalidAdd = false;
  // So is an `in-flight` without a task id from a queue that gates by task.
  #warnedIdlessInFlight = false;
  // An `unconfirmed` add on the read path is logged once, then again only after an add was
  // confirmed: a queue that cannot store tasks (e.g. an outdated model) would log every read.
  #loggedUnconfirmed = false;
  // The queue names a read found not served, or with invalid timing: each is logged once, since
  // every later read on that name meets the same answer.
  readonly #loggedNotServed = new Set<string>();
  readonly #loggedTimingInvalid = new Set<string>();

  constructor(deps: DispatcherDeps) {
    this.#deps = deps;
  }

  /**
   * The read path's best-effort enqueue (prewarm uses enqueueConfirmed instead): queue the missing
   * variants, one per identity, as one task. Returns the number of variants in the task it added;
   * 0 when nothing was added: a task of this media, pipeline and queue is in flight, its gate lock
   * is held, the add or the lock failed (logged), or the task queue does not serve the queue or
   * its timing is invalid (logged once per queue name). resolve() ignores the count. Never throws,
   * unless the task queue's own servesQueue throws.
   */
  async enqueue(req: DispatchRequest): Promise<number> {
    const { logger } = this.#deps;
    const { mediaId } = req;
    // Canonical first, so equivalent nested filter objects and list permutations reach the task
    // queue in one stable form; then one variant per identity.
    const variants = [...firstPerIdentity(req.previews, this.#scope(req))];
    if (variants.length === 0) {
      return 0;
    }
    const outcome = await this.#dispatch(req, variants);
    switch (outcome.status) {
      case 'added':
        return variants.length;
      case 'not-served':
        if (!this.#loggedNotServed.has(req.queue)) {
          this.#loggedNotServed.add(req.queue);
          logNeverThrow(
            logger,
            `resize enqueue: Resizer '${this.#deps.name}' ${notServed(req.queue)} — nothing is queued (logged once per queue name)`,
            undefined,
            'warn',
          );
        }
        return 0;
      case 'timing-invalid':
        if (!this.#loggedTimingInvalid.has(req.queue)) {
          this.#loggedTimingInvalid.add(req.queue);
          logNeverThrow(
            logger,
            `resize enqueue: Resizer '${this.#deps.name}' cannot queue to '${req.queue}': its timing is invalid — nothing is queued (logged once per queue name)`,
            outcome.error,
          );
        }
        return 0;
      case 'unconfirmed':
        if (!this.#loggedUnconfirmed) {
          this.#loggedUnconfirmed = true;
          logger.error(
            `resize enqueue: the task queue did not confirm the task for media ${mediaId} — a later read queues it (further unconfirmed adds are not logged until one is confirmed)`,
          );
        }
        return 0;
      case 'add-failed':
        logger.error(
          `resize enqueue: adding the task threw for media ${mediaId} — a later read queues it`,
          outcome.error,
        );
        return 0;
      case 'gate-failed':
        logger.error(
          `resize enqueue: the gate lock of media ${mediaId} could not be acquired — nothing queued`,
          outcome.error,
        );
        return 0;
      default:
        // in-flight and a held gate lock are normal; an invalid result was logged once.
        return 0;
    }
  }

  /**
   * Strict counterpart to enqueue(), for prewarm: the same dispatch, reported per variant. A
   * variant is accepted only when the task added now holds it, or, after an `in-flight` add, when
   * the active task that findActive() reports holds it with the same canonical payload. Every
   * other variant is unconfirmed, with an issue that says why and whether a retry can help.
   */
  async enqueueConfirmed(
    req: DispatchRequest,
  ): Promise<ConfirmedEnqueueResult> {
    const { logger } = this.#deps;
    const { mediaId } = req;
    const scope = this.#scope(req);
    const groups = groupVariants(req.previews, scope);
    const requested = [...groups.unique.values()];
    // Two payloads for one identity: neither can be confirmed, so neither joins the task.
    const conflicts = [...groups.conflicts.values()].flat();
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
    if (requested.length === 0) {
      return { accepted: [], unconfirmed: conflicts, tasks: [], issues };
    }

    // Nothing confirmed: every requested variant unconfirmed, with one issue.
    const none = (
      code: EnqueueIssue['code'],
      message: string,
      retryable = true,
    ): ConfirmedEnqueueResult => ({
      accepted: [],
      unconfirmed: [...requested, ...conflicts],
      tasks: [],
      issues: [...issues, { code, message, retryable, previews: requested }],
    });

    const outcome = await this.#dispatch(req, requested);
    switch (outcome.status) {
      case 'added':
        return {
          accepted: requested,
          unconfirmed: conflicts,
          tasks: [{ taskId: outcome.taskId, previews: requested }],
          issues,
        };
      case 'not-served':
        return none('RESIZE_QUEUE_NOT_SERVED', notServed(req.queue), false);
      case 'timing-invalid':
        // No issue here: the caller reports the error as for a task queue that cannot be used.
        return {
          accepted: [],
          unconfirmed: [...requested, ...conflicts],
          tasks: [],
          issues: [],
          timingError: outcome.error,
        };
      case 'in-flight':
        return this.#confirmActive(req, requested, conflicts, issues);
      case 'unconfirmed':
        return none(
          'RESIZE_ENQUEUE_UNCONFIRMED',
          'the task queue did not confirm the task',
        );
      case 'add-failed':
        logger.error(
          `resize prewarm: adding the task threw for media ${mediaId}`,
          outcome.error,
        );
        return none(
          'RESIZE_ENQUEUE_QUEUE_FAILED',
          'adding the task failed; outcome is unconfirmed',
        );
      case 'gate-held':
        return none(
          'RESIZE_ENQUEUE_LOCK_CONTENDED',
          "the gate lock of this media, pipeline and queue is held: a task of theirs is queued, running or waiting for a retry, or a dead task's cooldown runs",
        );
      case 'gate-failed':
        logger.error(
          `resize prewarm: the gate lock of media ${mediaId} could not be acquired`,
          outcome.error,
        );
        return none(
          'RESIZE_ENQUEUE_LOCK_FAILED',
          'the gate lock could not be acquired',
        );
      case 'invalid':
        return none(
          'RESIZE_ENQUEUE_UNCONFIRMED',
          `the task queue resolved an add result that is not a ${TASK_ADD_RESULT}; it is never counted as queued`,
          false,
        );
    }
  }

  /** The identity scope of a request: this Resizer and the request's pipeline. */
  #scope(req: DispatchRequest): PreviewScope {
    return { resizer: this.#deps.name, pipeline: req.pipeline };
  }

  /**
   * One dispatch of `variants` (canonical, one per identity) for the request's media, pipeline and
   * queue. First the queue name: one the task queue does not serve is `not-served`, and only then
   * is its timing read, so a name that is not served never enters the timing cache; invalid timing
   * is `timing-invalid`. Neither takes a lock or calls `add`.
   * On a queue with gatesByTask it is one `add`. Without it: acquire the gate lock with a fresh
   * owner for gateTtlMs, then `add` the task carrying that owner. The lock, by outcome:
   * - held by another request, or the acquire failed: this call never had it;
   * - `added`, even with an unusable task id: kept for gateTtlMs (a worker extends it once it
   *   claims the task), so no second task is queued;
   * - anything else (`unconfirmed`, a throw, an invalid result, an `in-flight` that such a queue
   *   never reports): the queue may still have stored the task (a lost response), so the lock is
   *   shortened to one lease of the request's queue, not released, and never kept longer than an
   *   added task's (min(leaseMs, gateTtlMs)). A stored task is claimed and its lock extended within
   *   that time; otherwise the lock lapses and a later read queues the task.
   * Never rejects, unless the task queue's own servesQueue throws.
   */
  async #dispatch(
    req: DispatchRequest,
    variants: MissingPreview[],
  ): Promise<DispatchOutcome> {
    const { tasks, locks, coordination, name } = this.#deps;
    if (tasks.servesQueue?.(req.queue) === false) {
      return { status: 'not-served' };
    }
    let timing: QueueTiming;
    try {
      timing = this.#deps.timingOf(req.queue);
    } catch (error) {
      return { status: 'timing-invalid', error };
    }
    const task: NewTask = {
      resizer: name,
      queue: req.queue,
      mediaId: req.mediaId,
      pipeline: req.pipeline,
      previews: canonicalizeVariants(variants),
    };
    if (tasks.gatesByTask) {
      const outcome = await this.#add(task);
      // Rare by design (the gate changed hands while add ran), constant when a unique index on the
      // gate keys lacks its partial filter: every add after a completed task then meets that row.
      if (
        outcome.status === 'in-flight' &&
        outcome.taskId === undefined &&
        !this.#warnedIdlessInFlight
      ) {
        this.#warnedIdlessInFlight = true;
        logNeverThrow(
          this.#deps.logger,
          `resize enqueue: the task queue of Resizer '${name}' reported a task in flight without its id; if this repeats, the gate index may lack its partial filter — see RESIZE_MONGO_INDEX_MISSING`,
          undefined,
          'warn',
        );
      }
      return outcome;
    }
    if (!locks) {
      return {
        status: 'gate-failed',
        error: new Error(
          `resize: Resizer '${name}' has no lock store for the gate lock of its task queue`,
        ),
      };
    }
    const key = gateKey(name, req.queue, req.mediaId, req.pipeline);
    const owner = randomHex();
    try {
      if (!(await locks.acquire(key, owner, coordination.gateTtlMs))) {
        return { status: 'gate-held' };
      }
    } catch (error) {
      return { status: 'gate-failed', error };
    }
    const outcome = await this.#add({ ...task, gateOwner: owner });
    const stored =
      outcome.status === 'added' ||
      (outcome.status === 'invalid' && outcome.stored);
    if (!stored) {
      // Maybe stored: keep the gate for one lease instead of opening it (see above). `false` (the
      // lock is gone) changes nothing.
      try {
        await locks.extend(
          key,
          owner,
          Math.min(timing.leaseMs, coordination.gateTtlMs),
        );
      } catch (err) {
        logNeverThrow(
          this.#deps.logger,
          `resize enqueue: failed to shorten the gate lock ${key} to one lease`,
          err,
        );
      }
    }
    return outcome;
  }

  /** `tasks.add(task)`: its result, a throw, or a result in none of the TaskAddResult shapes. */
  async #add(task: NewTask): Promise<DispatchOutcome> {
    let result: unknown;
    try {
      result = await this.#deps.tasks.add(task);
    } catch (error) {
      return { status: 'add-failed', error };
    }
    if (isTaskAddResult(result)) {
      if (result.status !== 'unconfirmed') {
        this.#loggedUnconfirmed = false; // the queue confirms again: log the next one
      }
      return result;
    }
    if (!this.#warnedInvalidAdd) {
      this.#warnedInvalidAdd = true;
      this.#deps.logger.error(
        `resize enqueue: Resizer '${this.#deps.name}' got an add result that is not a ${TASK_ADD_RESULT} — such a task is never counted as queued (a TaskQueue written for an older version of this module?)`,
        result,
      );
    }
    const stored =
      typeof result === 'object' &&
      result !== null &&
      'status' in result &&
      result.status === 'added';
    return { status: 'invalid', stored };
  }

  /**
   * After an `in-flight` add: accept the variants the active task holds with the same canonical
   * payload, with that task as their receipt. A requested identity for which the active task holds
   * two payloads is a conflict; the rest wait for the active task (RESIZE_TASK_IN_FLIGHT). Without
   * findActive, or when it finds no active task (a dead one that is cooling down), nothing is
   * accepted.
   */
  async #confirmActive(
    req: DispatchRequest,
    requested: MissingPreview[],
    conflicts: MissingPreview[],
    issues: EnqueueIssue[],
  ): Promise<ConfirmedEnqueueResult> {
    const { tasks: taskQueue, name, logger } = this.#deps;
    const { mediaId, pipeline, queue } = req;
    const scope = this.#scope(req);
    const unresolved = new Map(
      requested.map((preview) => [identityOf(scope, preview), preview]),
    );
    const receipts: EnqueueReceipt[] = [];
    const receiptConflicts = new Map<string, MissingPreview>();
    if (taskQueue.findActive) {
      let active: EnqueueReceipt[];
      try {
        active = await taskQueue.findActive({
          resizer: name,
          mediaId,
          pipeline,
          queue,
        });
      } catch (error) {
        logger.error(
          `resize prewarm: active-task confirmation failed for media ${mediaId}`,
          error,
        );
        return {
          accepted: [],
          unconfirmed: [...requested, ...conflicts],
          tasks: [],
          issues: [
            ...issues,
            {
              code: 'RESIZE_ENQUEUE_CONFIRM_FAILED',
              message: 'the task queue could not confirm active task coverage',
              retryable: true,
              previews: requested,
            },
          ],
        };
      }
      const unresolvedByPayload = new Map(
        [...unresolved].map(([identity, preview]) => [
          variantPayloadKey(preview),
          { identity, preview },
        ]),
      );
      for (const receipt of active) {
        if (
          typeof receipt.taskId !== 'string' ||
          receipt.taskId.trim().length === 0
        ) {
          continue;
        }
        // Inspect the complete receipt before matching any requested payload. Filtering to the
        // requested payload first would hide a second payload that makes the identity ambiguous
        // in the active task.
        const receiptGroups = groupVariants(receipt.previews ?? [], scope);
        for (const identity of receiptGroups.conflicts.keys()) {
          const preview = unresolved.get(identity);
          if (preview && !receiptConflicts.has(identity)) {
            receiptConflicts.set(identity, preview);
          }
        }
        const covered: MissingPreview[] = [];
        for (const preview of receiptGroups.unique.values()) {
          const match = unresolvedByPayload.get(variantPayloadKey(preview));
          if (match) {
            unresolved.delete(match.identity);
            unresolvedByPayload.delete(variantPayloadKey(preview));
            covered.push(match.preview);
          }
        }
        if (covered.length > 0) {
          receipts.push({ taskId: receipt.taskId, previews: covered });
        }
      }
    }

    // A receipt conflict counts only while no other receipt covered the identity.
    const conflicting = [...receiptConflicts]
      .filter(([identity]) => unresolved.has(identity))
      .map(([, preview]) => preview);
    const waiting = [...unresolved]
      .filter(([identity]) => !receiptConflicts.has(identity))
      .map(([, preview]) => preview);
    const result: ConfirmedEnqueueResult = {
      accepted: requested.filter(
        (preview) => !unresolved.has(identityOf(scope, preview)),
      ),
      unconfirmed: [...unresolved.values(), ...conflicts],
      tasks: receipts,
      issues: [...issues],
    };
    if (conflicting.length > 0) {
      result.issues.push({
        code: 'RESIZE_ENQUEUE_VARIANT_CONFLICT',
        message:
          'multiple active-task payloads share one preview identity; none can be confirmed safely',
        retryable: false,
        previews: conflicting,
      });
    }
    if (waiting.length > 0) {
      result.issues.push({
        code: 'RESIZE_TASK_IN_FLIGHT',
        message:
          'a task for this media, pipeline and queue is active, or cooling down after a dead-letter; a read after it finishes queues these',
        retryable: true,
        previews: waiting,
      });
    }
    return result;
  }
}

function identityOf(scope: PreviewScope, preview: MissingPreview): string {
  return getPreviewIdentity(
    scope,
    preview.sizeKey,
    preview.format,
    preview.filters,
  );
}

function variantPayloadKey(variant: MissingPreview): string {
  return JSON.stringify(canonicalizeVariants([variant])[0]);
}

/** The canonical variants, the first of each identity (the read path's dedup). */
function firstPerIdentity(
  variants: readonly MissingPreview[],
  scope: PreviewScope,
): Iterable<MissingPreview> {
  const byIdentity = new Map<string, MissingPreview>();
  for (const variant of canonicalizeVariants(variants)) {
    const identity = identityOf(scope, variant);
    if (!byIdentity.has(identity)) {
      byIdentity.set(identity, variant);
    }
  }
  return byIdentity.values();
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
    const identity = identityOf(scope, preview);
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
