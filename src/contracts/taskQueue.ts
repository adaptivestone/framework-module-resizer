// Task queue contract: where queued tasks wait. A database can hold them (MongoDatabase.tasks) or a
// message broker can (SqsTaskQueue). Every method is ONE atomic operation; the core owns everything
// else — the worker loop, lease heartbeat, task timeout, retry with backoff, dead-lettering, request
// de-duplication keys and task events — so every backend behaves the same. Extend this class, or
// pass any object of the same shape (the core never checks `instanceof`).
import type {
  EnqueueReceipt,
  MissingPreview,
  QueueTimingOptions,
} from '../types.d.ts';

/** A task to store. `requestKey` identifies the whole request, for de-duplicating active tasks. */
export interface NewTask {
  resizer: string;
  queue: string;
  mediaId: string;
  pipeline: string;
  previews: MissingPreview[];
  requestKey: string;
}

/** A stored task, as observers see it. Tasks stored without resizer/queue read as 'default'. */
export interface LeasedTask {
  taskId: string;
  resizer: string;
  queue: string;
  mediaId: string;
  pipeline: string;
  previews: MissingPreview[];
}

/** A task held by this worker: `token` fences every later write; `attempts` counts deliveries. */
export interface ClaimedTask extends LeasedTask {
  token: string;
  attempts: number;
}

export type TaskEvent = 'completed' | 'failed' | 'deadLettered';

export type TaskEventHandler = (
  event: TaskEvent,
  task: LeasedTask,
  error?: unknown,
) => void | Promise<void>;

export abstract class TaskQueue {
  /**
   * Store a task. An active task with the same `requestKey` (if the backend can find one) is
   * returned instead of a new one. `taskId: null` means the backend could not confirm the write.
   */
  abstract add(task: NewTask): Promise<{ taskId: string | null }>;

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
   */
  abstract claim(
    queue: string,
    leaseMs: number,
    signal?: AbortSignal,
  ): Promise<ClaimedTask | null>;

  /** Extend the lease (the heartbeat). `false` means the lease was lost to another worker. */
  abstract renew(task: ClaimedTask, leaseMs: number): Promise<boolean>;

  /** Mark the task done. `false` means the lease was lost (the result is dropped). */
  abstract complete(task: ClaimedTask): Promise<boolean>;

  /**
   * Retry later (`{ retryAt }`) or give up (`'dead'`, keeping `error` for inspection). `false`
   * means the lease was lost.
   */
  abstract fail(
    task: ClaimedTask,
    next: { retryAt: Date } | 'dead',
    error: string,
  ): Promise<boolean>;

  /**
   * Optional: active tasks of this Resizer + media + pipeline on any queue, so prewarm can confirm
   * work another request already queued. Omit when tasks can't be queried (e.g. SQS).
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
