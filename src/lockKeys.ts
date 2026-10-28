// The gate lock key. At most one task is active per Resizer, media, pipeline and queue: that is
// the gate. A task queue with gatesByTask keeps the gate in its own task rows and takes no lock. On
// a task queue without it (e.g. SqsTaskQueue) the gate is a lock in the Resizer's LockStore: the
// Dispatcher takes it when it queues a task and hands its owner to the task, and the worker holds
// it while the task is in flight, waiting for a retry, and for the cooldown after a dead-letter,
// and releases it once the task completes. No other lock exists: the queue leases each task to one
// worker at a time, and the media store keeps one row per preview identity.

/**
 * The gate lock of one Resizer, queue, media and pipeline on a task queue without gatesByTask:
 * while it is held, no other task is queued for them. Its owner travels with the task as
 * `gateOwner`.
 */
export function gateKey(
  resizer: string,
  queue: string,
  mediaId: string,
  pipeline: string,
): string {
  return `resize_gate:${resizer}:${queue}:${mediaId}:${pipeline}`;
}
