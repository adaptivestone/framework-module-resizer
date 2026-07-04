// Queue transport contract (05 · §10.1) — NO `app` parameter anywhere; shipped drivers reach
// the framework through getApp(), custom ones close over their own. This is an INTERFACE, not
// an abstract class: drivers are plain object literals by design (05 · §10.3). It lives in its
// own file so the optional-peer SQS driver can import it WITHOUT depending on resizer.ts (the
// driver is a subpath-only entry — 05 · §10.3); it is re-exported from resizer.ts so every
// existing import site keeps working unchanged.
import type { MissingPreview } from '../types.d.ts';

export interface LeasedTask {
  taskId: string;
  mediaId: string;
  pipeline: string;
  previews: MissingPreview[];
}

export interface QueueTransport {
  enqueue(task: {
    mediaId: string;
    pipeline: string;
    previews: MissingPreview[];
  }): Promise<{ taskId: string | null }>;

  // The transport drives consumption its own way (poll OR push): it calls handleTask per
  // task and owns completion/redelivery. taskOpts.signal aborts THIS task if its lease is
  // lost (best-effort); opts.signal is worker-wide shutdown (05 · §10.1).
  startWorker(
    handleTask: (
      task: LeasedTask,
      taskOpts?: { signal: AbortSignal },
    ) => Promise<void>,
    opts: { signal: AbortSignal },
  ): Promise<void>;
}
