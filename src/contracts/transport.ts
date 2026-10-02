// Queue transport contract: stores tasks and drives a worker's consumption of one named queue. A
// driver receives everything it needs as constructor options (no `app`). Extend this class (or pass
// any object of the same shape — the core never checks `instanceof`).
import type { EnqueueReceipt, MissingPreview } from '../types.d.ts';

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
   * Lease length in ms, for transports that lease tasks (Mongo). The worker checks each Resizer's
   * worker-lock TTL against it: a lock must expire within the lease.
   */
  declare readonly leaseMs?: number;

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
