// Test-only: the loop tests' one-call form of a Consumer. It runs `queue` on `tasks` with that
// queue name's own timing, events from `onEvent`, and console unless a logger is given.
// `resizers`, `coordinationOf` and `metricsOf` go to the Consumer as they are.
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
    metricsOf?: ConsumerDeps['metricsOf'];
  },
): Promise<void> {
  await new Consumer({
    tasks,
    timing: timingOf(tasks, opts.queue),
    handle: opts.handle,
    events: opts.onEvent,
    logger: opts.logger ?? console,
    resizers: opts.resizers,
    coordinationOf: opts.coordinationOf,
    metricsOf: opts.metricsOf,
  }).run(opts.queue, opts.signal);
}
