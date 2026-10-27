// Task queue contract: where queued tasks wait. A database can hold them (MongoTaskQueue) or a
// message broker can (SqsTaskQueue). Every method is ONE atomic operation; the core owns everything
// else — the worker loop, lease heartbeat, task timeout, retry with backoff, dead-lettering, giving
// tasks back at shutdown, request de-duplication keys and task events — so every backend behaves
// the same. A queue that gates by task keeps at most one active task per Resizer, media and
// pipeline. Extend this class, or pass any object of the same shape (the core never checks
// `instanceof`).
import type {
  EnqueueReceipt,
  MissingPreview,
  QueueTimingOptions,
} from '../types.d.ts';

/**
 * A task to store. `requestKey` identifies the whole request, for de-duplicating active tasks.
 * `gateOwner`, when set, is stored with the task and handed back by `claim()`.
 */
export interface NewTask {
  resizer: string;
  queue: string;
  mediaId: string;
  pipeline: string;
  previews: MissingPreview[];
  requestKey: string;
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
 * - `in-flight`: a queue that gates by task already holds an active task of this Resizer, media
 *   and pipeline (`taskId`, when the queue knows it), so it stored nothing;
 * - `unconfirmed`: the queue could not confirm the write.
 */
export type TaskAddResult =
  | { status: 'added'; taskId: string }
  | { status: 'in-flight'; taskId?: string }
  | { status: 'unconfirmed' };

/** Options for `claim()`. */
export interface ClaimOptions {
  /** The Resizers this worker serves: a queue with `claimFilters` claims only their tasks. */
  resizers?: readonly string[];
}

/** Options for `fail()`. */
export interface FailOptions {
  /** With `'dead'`: how long a queue that gates by task keeps the dead task as the gate. */
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
   * Optional: `add()` keeps at most one active task per Resizer, media and pipeline, and reports
   * `in-flight` while one exists. Absent: `add()` never reports `in-flight`.
   */
  declare readonly gatesByTask?: true;

  /** Optional: `claim()` honours `ClaimOptions.resizers`. Absent: it may hand out any task. */
  declare readonly claimFilters?: true;

  /**
   * Store a task: the result says whether it was added, another task is in flight, or the write
   * is unconfirmed (see TaskAddResult). An active task with the same `requestKey` (if the backend
   * can find one) is reported as `added` under its own `taskId` instead of storing a new one.
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

  /** Mark the task done. `false` means the lease was lost (the result is dropped). */
  abstract complete(task: ClaimedTask): Promise<boolean>;

  /**
   * Retry later (`{ retryAt }`) or give up (`'dead'`, keeping `error` for inspection). With
   * `'dead'`, a queue that gates by task keeps the dead task as the gate for `opts.cooldownMs`.
   * `false` means the lease was lost.
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
   * count it. `false` means the lease was already lost. Without it the core retries a stopped task
   * at once through `fail`, so the delivery counts, and a task of a Resizer the worker does not
   * serve fails with RESIZE_NO_RESIZER (it retries, then dead-letters).
   */
  release?(task: ClaimedTask): Promise<boolean>;

  /**
   * Optional: the active tasks (pending or processing) of this Resizer, media and pipeline on any
   * queue, each with the previews it covers; `[]` when there are none. A queue with `gatesByTask`
   * returns at most one. The Dispatcher reads it for every variant still without a confirmed task
   * (after a dispatch lock it could not take, an unconfirmed or in-flight add, or an add that
   * threw). Omit when tasks can't be queried (e.g. SQS).
   */
  findActive?(query: {
    resizer: string;
    mediaId: string;
    pipeline: string;
  }): Promise<EnqueueReceipt[]>;

  /** Optional: whether `queue` can be consumed here (default: every queue). */
  servesQueue?(queue: string): boolean;

  /** Optional: this queue's timing; missing values use the defaults (defaultQueueOptions). */
  getTiming?(): Partial<QueueTimingOptions>;

  /** Optional startup check: throw when the queue cannot work (e.g. its model is not registered). */
  verify?(): void | Promise<void>;
}
