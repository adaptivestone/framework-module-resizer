// Test-only: run a Consumer with the options the loop took before it became a class, so tests
// keep one call per loop. The timing is the queue's own, and the logger defaults to console.
import { Consumer, type ConsumerDeps } from '../consumer.ts';
import type { TaskEventHandler, TaskQueue } from '../contracts/taskQueue.ts';
import { timingOf } from '../timing.ts';
import type { ResizeLogger } from '../types.d.ts';

/** Consume `queue` from `tasks` until `signal` aborts. Invalid timing rejects. */
export async function consume(
  tasks: TaskQueue,
  opts: {
    queue: string;
    signal: AbortSignal;
    handle: ConsumerDeps['handle'];
    onEvent?: TaskEventHandler;
    logger?: ResizeLogger;
  },
): Promise<void> {
  await new Consumer({
    tasks,
    timing: timingOf(tasks),
    handle: opts.handle,
    events: opts.onEvent,
    logger: opts.logger ?? console,
  }).run(opts.queue, opts.signal);
}
