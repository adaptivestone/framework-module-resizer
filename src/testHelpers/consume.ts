// Test-only: the loop tests' one-call form of a Consumer. It runs `queue` on `tasks` with the
// queue's own timing, events from `onEvent`, and console unless a logger is given. `resizers` and
// `coordinationOf` go to the Consumer as they are.
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
    resizers?: ConsumerDeps['resizers'];
    coordinationOf?: ConsumerDeps['coordinationOf'];
  },
): Promise<void> {
  await new Consumer({
    tasks,
    timing: timingOf(tasks),
    handle: opts.handle,
    events: opts.onEvent,
    logger: opts.logger ?? console,
    resizers: opts.resizers,
    coordinationOf: opts.coordinationOf,
  }).run(opts.queue, opts.signal);
}
