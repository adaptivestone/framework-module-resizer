// Delivery contract: what push delivery asks of a task queue, when a transport hands the process a
// message instead of a worker receiving one. Internal: no entry re-exports it, and it may change
// in any release.
import type { ClaimedTask } from './taskQueue.ts';

/** A message pushed to the process, in the fields a task queue needs. */
export interface DeliveredMessage {
  id: string;
  receipt: string;
  body: string;
  receiveCount?: string; // as the transport reports it; absent reads as 1
}

/**
 * The task of a delivered message; 'discarded': not a task, moved aside; 'left': not a task,
 * nowhere to move it.
 */
export type DeliveredTask = ClaimedTask | 'discarded' | 'left';

/** What push delivery asks of a task queue. It must have no `gatesByTask`. */
export interface DeliveryQueue {
  carriesSource(queue: string, source: string): boolean;
  taskOfDelivery(
    message: DeliveredMessage,
    queue: string,
  ): Promise<DeliveredTask>;
  release(task: ClaimedTask): Promise<boolean>;
}
