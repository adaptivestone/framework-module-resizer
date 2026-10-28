// Task queue contract: where queued tasks wait. A database can hold them (MongoTaskQueue) or a
// message broker can (SqsTaskQueue). Every method is ONE atomic operation; the core owns everything
// else — the worker loop, lease heartbeat, task timeout, retry with backoff, dead-lettering, giving
// tasks back at shutdown and task events — so every backend behaves the same. A queue that gates
// by task keeps at most one active task per Resizer, media, pipeline and queue (see
// `gatesByTask`); for any other queue the core keeps that gate as a lock. Extend this class, or
// pass any object of the same shape (the core never checks `instanceof`).
import type {
  EnqueueReceipt,
  MissingPreview,
  QueueTimingOptions,
} from '../types.d.ts';

/**
 * A task to store: variants of one media and pipeline, for one Resizer, on one queue. `gateOwner`
 * is set only for a queue without `gatesByTask`; such a queue stores it with the task and hands it
 * back from `claim()`.
 */
export interface NewTask {
  resizer: string;
  queue: string;
  mediaId: string;
  pipeline: string;
  previews: MissingPreview[];
  gateOwner?: string;
}

/**
 * A stored task, as observers and handlers see it: `attempts` counts its deliveries, this one
 * included. Tasks stored without resizer/queue read as 'default'.
 */
export interface LeasedTask {
  taskId: string;
  resizer: string;
  queue: string;
  mediaId: string;
  pipeline: string;
  previews: MissingPreview[];
  attempts: number;
}

/**
 * A task held by this worker: `token` fences every later write. `gateOwner` is what `add()`
 * received with the task, handed back unchanged.
 */
export interface ClaimedTask extends LeasedTask {
  token: string;
  gateOwner?: string;
}

/**
 * What `add()` did with a task:
 * - `added`: the task is stored under `taskId`;
 * - `in-flight`: only from a queue with `gatesByTask`: an active task of this Resizer, media,
 *   pipeline and queue exists, so nothing was stored. Give its `taskId` whenever the queue knows
 *   it (prewarm confirms variants through it; an `in-flight` without an id is logged once);
 * - `unconfirmed`: the queue cannot say whether the task was stored (a write error, a response
 *   lost after the write). Beside a queue without `gatesByTask` the core then keeps the gate lock
 *   for one lease, not released: a stored task is claimed and extends it within that lease;
 *   otherwise it lapses and a later read queues the task.
 */
export type TaskAddResult =
  | { status: 'added'; taskId: string }
  | { status: 'in-flight'; taskId?: string }
  | { status: 'unconfirmed' };

/** Options for `claim()`. */
export interface ClaimOptions {
  /**
   * The Resizers this worker serves. A queue with `claimFilters` must claim only their tasks; one
   * that ignores the option may hand out any Resizer's task, which the worker then gives back
   * (`release`) or fails with RESIZE_NO_RESIZER, and must not declare `claimFilters`.
   */
  resizers?: readonly string[];
}

/** Options for `fail()`. */
export interface FailOptions {
  /**
   * With `'dead'`: how long a queue with `gatesByTask` must keep the dead task as the gate, from
   * now (the core always passes the cooldown of the task's Resizer; absent counts as 0, the gate
   * opens at once). A queue without `gatesByTask` ignores it: the core holds its gate lock for the
   * cooldown. A gating queue that ignores it opens the gate at once, so the next read queues the
   * failing media again.
   */
  cooldownMs?: number;
}

export type TaskEvent = 'completed' | 'failed' | 'deadLettered';

export type TaskEventHandler = (
  event: TaskEvent,
  task: LeasedTask,
  error?: unknown,
) => void | Promise<void>;

export abstract class TaskQueue {
  // The two flags are declared only, never emitted as class fields: a field here would put an
  // own `undefined` on every instance and hide a subclass that sets the flag with a getter.

  /**
   * Optional: the queue keeps the gate itself, at most one ACTIVE task per Resizer, media,
   * pipeline and queue, whatever variants each asks for:
   * - a task is active from `add()` until `complete()`, through its retries (`fail({ retryAt })`)
   *   and give-backs (`release()`);
   * - a dead task (`fail(task, 'dead', error, { cooldownMs })`) stays active until now +
   *   `cooldownMs`; the NEXT `add()` after that must take it over: store the new task as the
   *   active one (the dead one stops being the gate). A queue that keeps a dead task active
   *   blocks its media for good;
   * - while a task is active, `add()` stores nothing and reports `in-flight` with its id;
   * - `findActive` returns the active task while it is pending or processing, and `[]` while a
   *   dead one cools down.
   *
   * Absent: `add()` stores every task it is given and never reports `in-flight`, and the queue
   * must store `gateOwner` with each task and hand it back unchanged from `claim()`: the core then
   * keeps the gate as a lock in the Resizer's LockStore, under that owner.
   */
  declare readonly gatesByTask?: true;

  /**
   * Optional: `claim()` honours `ClaimOptions.resizers` (it claims only tasks of those Resizers).
   * Absent: it may hand out any task.
   */
  declare readonly claimFilters?: true;

  /**
   * Store a task: the result says whether it was added, another task is in flight, or the write
   * is unconfirmed (see TaskAddResult). A queue with `gatesByTask` stores nothing while an active
   * task of the same Resizer, media, pipeline and queue exists, whatever variants either asks for,
   * and reports `in-flight` (with that task's id when it knows it); see `gatesByTask`. A queue
   * without it stores every task it is given, with its `gateOwner`.
   */
  abstract add(task: NewTask): Promise<TaskAddResult>;

  /**
   * Atomically claim the oldest due task of `queue` for `leaseMs`: a waiting task whose retry time
   * has passed, or a task whose previous lease expired. Increments `attempts` and returns a new
   * `token`, or `null` when nothing is due.
   *
   * This is how a worker receives tasks; how the queue finds them is its own business. It may
   * return at once (the core then waits until idlePollMs has passed since the call) or wait for a
   * task first — a long poll, LISTEN/NOTIFY, a change stream. A waiting claim must:
   * - return (null) or throw promptly once `signal` aborts;
   * - claim only when called, never ahead: a prefetched task's lease would run out with no
   *   heartbeat for it;
   * - treat a notification as a hint to try the atomic claim, not as ownership: several workers
   *   may wake for one task, and only one claim wins.
   *
   * A queue with `claimFilters` claims only tasks of the Resizers in `opts.resizers`, when given.
   */
  abstract claim(
    queue: string,
    leaseMs: number,
    signal?: AbortSignal,
    opts?: ClaimOptions,
  ): Promise<ClaimedTask | null>;

  /** Extend the lease (the heartbeat). `false` means the lease was lost to another worker. */
  abstract renew(task: ClaimedTask, leaseMs: number): Promise<boolean>;

  /**
   * Mark the task done; on a queue with `gatesByTask` it stops being the gate, so the next `add()`
   * stores a new task. `false` means the lease was lost (the result is dropped).
   */
  abstract complete(task: ClaimedTask): Promise<boolean>;

  /**
   * Retry later (`{ retryAt }`; on a queue with `gatesByTask` the task stays active) or give up
   * (`'dead'`, keeping `error` for inspection; such a queue keeps the dead task as the gate for
   * `opts.cooldownMs`, see `gatesByTask`). `false` means the lease was lost.
   */
  abstract fail(
    task: ClaimedTask,
    next: { retryAt: Date } | 'dead',
    error: string,
    opts?: FailOptions,
  ): Promise<boolean>;

  /**
   * Optional: give a claimed task back unprocessed (the worker is shutting down, or the task is of
   * a Resizer it does not serve). It becomes claimable at once, and this delivery should not count
   * as an attempt; a backend that cannot take a delivery back (SQS counts receives) may still
   * count it. On a queue with `gatesByTask` the task stays active. `false` means the lease was
   * already lost. Without it the core retries a stopped task at once through `fail`, so the
   * delivery counts, and a task of a Resizer the worker does not serve fails with
   * RESIZE_NO_RESIZER (it retries, then dead-letters).
   */
  release?(task: ClaimedTask): Promise<boolean>;

  /**
   * Optional: the active tasks (pending or processing) of this Resizer, media, pipeline and
   * queue, each with the previews it covers; `[]` when there are none. A queue with `gatesByTask`
   * returns at most one, and `[]` while a dead task holds the gate. The Dispatcher reads it only
   * after an `in-flight` add: prewarm then accepts the variants the active task holds. Omit when
   * tasks can't be queried (e.g. SQS).
   */
  findActive?(query: {
    resizer: string;
    mediaId: string;
    pipeline: string;
    queue: string;
  }): Promise<EnqueueReceipt[]>;

  /** Optional: whether `queue` can be consumed here (default: every queue). */
  servesQueue?(queue: string): boolean;

  /** Optional: this queue's timing; missing values use the defaults (defaultQueueOptions). */
  getTiming?(): Partial<QueueTimingOptions>;

  /** Optional startup check: throw when the queue cannot work (e.g. its model is not registered). */
  verify?(): void | Promise<void>;
}
