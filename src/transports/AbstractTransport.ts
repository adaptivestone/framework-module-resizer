// Queue transport contract (05 · §10.1) — NO `app` parameter anywhere; shipped drivers reach
// the framework through getApp(), custom ones close over their own. This is an INTERFACE, not
// an abstract class: drivers are plain object literals by design (05 · §10.3). It lives in its
// own file so the optional-peer SQS driver can import it WITHOUT depending on resizer.ts (the
// driver is a subpath-only entry — 05 · §10.3); it is re-exported from resizer.ts so every
// existing import site keeps working unchanged.
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

export interface QueueTransport {
  enqueue(task: EnqueueTask): Promise<{ taskId: string | null }>;

  // Optional strict-enqueue capability: active tasks (any queue) of this resizer + media +
  // pipeline whose payload can prove coverage. Transports without queryable state omit it.
  findActive?(task: EnqueueTask): Promise<EnqueueReceipt[]>;

  // The transport drives consumption its own way (poll or push) for ONE queue. It calls
  // handleTask per task and owns completion/redelivery; taskOpts.signal aborts this task if its
  // lease is lost; opts.signal is worker-wide shutdown.
  startWorker(
    handleTask: (
      task: LeasedTask,
      taskOpts?: { signal: AbortSignal },
    ) => Promise<void>,
    opts: StartWorkerOpts,
  ): Promise<void>;
}
