// Queue transport contract: stores tasks and drives a worker's consumption of one named queue. A
// driver receives everything it needs as constructor options (no `app`). Extend this class (or pass
// any object of the same shape — the core never checks `instanceof`).
import { defaultQueueOptions } from '../config/resize.ts';
import type { EnqueueReceipt, MissingPreview } from '../types.d.ts';
import type { LockStore } from './lockStore.ts';

/** What a Resizer hands to a transport. `resizer` and `queue` route the task later. */
export interface EnqueueTask {
  resizer: string;
  queue: string;
  mediaId: string;
  pipeline: string;
  previews: MissingPreview[];
}

/** A task a worker is processing. Rows/messages written without resizer/queue read as 'default'. */
export interface LeasedTask {
  taskId: string;
  resizer: string;
  queue: string;
  mediaId: string;
  pipeline: string;
  previews: MissingPreview[];
}

export type TaskEvent = 'completed' | 'failed' | 'deadLettered';

export type TaskEventHandler = (
  event: TaskEvent,
  task: LeasedTask,
  error?: unknown,
) => void | Promise<void>;

export interface StartWorkerOpts {
  signal: AbortSignal; // worker-wide graceful shutdown
  queue: string; // consume only this queue
  onEvent?: TaskEventHandler; // completion/failure/dead-letter reports; errors it throws are logged
}

export abstract class QueueTransport {
  /**
   * The locks queued work is coordinated with: dispatch locks when requests enqueue, and worker
   * locks while a variant is generated. Locks exist only for queued work, so the transport owns
   * them.
   */
  abstract readonly locks: LockStore;

  /**
   * Optional startup check, awaited by `Resizer.verify()` and before the worker leases anything:
   * throw when the transport cannot work (e.g. its task model is not registered).
   */
  verify?(): void | Promise<void>;

  /**
   * Optional: whether this transport can consume `queue` (e.g. SQS knows only its configured
   * queue URLs). Without it every queue is served. The worker skips a transport that can't serve
   * its queue, so one Resizer's missing queue never stops the others.
   */
  servesQueue?(queue: string): boolean;

  /** Optional: lock TTLs in ms. Without it the defaults apply: `{ dispatch: 60000, worker: 60000 }`. */
  getLockTtlMs?(): { dispatch: number; worker: number };

  /** Store a task. `taskId` is the receipt; `null` when the backend gives none. */
  abstract enqueue(task: EnqueueTask): Promise<{ taskId: string | null }>;

  /**
   * Optional: active tasks of this Resizer + media + pipeline (any queue) whose payload proves
   * coverage. Lets prewarm confirm work another request queued. Omit when tasks can't be queried.
   */
  findActive?(task: EnqueueTask): Promise<EnqueueReceipt[]>;

  /**
   * Consume ONE queue (`opts.queue`) until `opts.signal` aborts: call `handleTask` per task and own
   * completion, retry and dead-lettering. `taskOpts.signal` aborts a task whose lease was lost.
   */
  abstract startWorker(
    handleTask: (
      task: LeasedTask,
      taskOpts?: { signal: AbortSignal },
    ) => Promise<void>,
    opts: StartWorkerOpts,
  ): Promise<void>;
}

/** A transport's lock TTLs, or the defaults when it sets none. */
export function lockTtlMsOf(transport: Pick<QueueTransport, 'getLockTtlMs'>): {
  dispatch: number;
  worker: number;
} {
  return transport.getLockTtlMs?.() ?? defaultQueueOptions.lockTtlMs;
}
