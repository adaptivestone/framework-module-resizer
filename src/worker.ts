// The worker, framework-free. `runWorker()` serves a list of Resizers (default: every registered
// one) for ONE named queue: it runs one Consumer, the worker loop (src/consumer.ts), per distinct
// TaskQueue those Resizers use, after verifying each of them. Each task runs with the Resizer named
// in it, and its events go to that Resizer's observers. After a dead-letter it holds the task's
// dispatch locks for a cooldown.
// The work itself is the Resizer's Processor (src/processor.ts).
// Framework hosts start it through `runResizeWorker()` (src/framework/worker.ts), which adds the
// `worker.enabled` switch, process signals and the app logger.
import sharp from 'sharp';
import { defaultQueueOptions } from './config/resize.ts';
import { Consumer, type ConsumerDeps } from './consumer.ts';
import type {
  LeasedTask,
  TaskEventHandler,
  TaskQueue,
} from './contracts/taskQueue.ts';
import { ResizeSetupError } from './errors.ts';
import { getResizer, listResizers, type Resizer } from './resizer.ts';
import { timingOf } from './timing.ts';
import type { ResizeLogger } from './types.d.ts';

/**
 * Run one task with the Resizer it names in the process registry. An unknown name rejects with
 * RESIZE_NO_RESIZER, so the task retries and dead-letters instead of running with another
 * Resizer's storage and config.
 */
export async function processTask(
  task: LeasedTask,
  taskOpts?: { signal: AbortSignal },
  tasks?: TaskQueue, // the delivering queue; default: the Resizer's own
): Promise<void> {
  return runTask(getResizer(task.resizer), task, taskOpts, tasks);
}

/**
 * Run one task with `resizer`. Worker locks last the delivering queue's lockTtlMs.worker, so they
 * fit the lease it holds.
 */
async function runTask(
  resizer: Resizer,
  task: LeasedTask,
  taskOpts: { signal: AbortSignal } | undefined,
  tasks: TaskQueue | undefined,
): Promise<void> {
  await resizer.ready();
  // The delivering queue, else the Resizer's own; with neither (an eager-only Resizer), the
  // default TTL. Reading it before the Processor's lock check is safe: runWorker (and ready(), for
  // the Resizer's own queue) validated this timing through timingOf, which caches it.
  const queue = tasks ?? resizer.tasks;
  return resizer.processor.processTask(task, {
    signal: taskOpts?.signal,
    workerLockTtlMs: queue
      ? timingOf(queue).lockTtlMs.worker
      : defaultQueueOptions.lockTtlMs.worker,
  });
}

export interface RunWorkerOptions {
  queue?: string; // queue to consume; default 'default'
  signal: AbortSignal; // stops the worker: finish in-flight tasks, then return
  logger?: ResizeLogger; // the worker's own messages; default console
  // Process-wide Sharp tuning, applied once (keep Resizers' config.concurrency × concurrency ≈
  // CPU cores). Omitted: Sharp's settings are left as they are.
  sharp?: { concurrency: number; cache: boolean };
  // The Resizers to serve; default: every Resizer registered when the worker starts. Tasks and
  // events are routed by name among these only: a task of any other Resizer fails with
  // RESIZE_NO_RESIZER (it retries, then dead-letters), and its events are logged and dropped.
  resizers?: Resizer[];
}

export async function runWorker(opts: RunWorkerOptions): Promise<void> {
  const queue = opts.queue ?? 'default';
  const logger = opts.logger ?? console;
  // The served Resizers, taken once now, so one constructed later is not served.
  const resizers = [...(opts.resizers ?? listResizers())];
  if (resizers.length === 0) {
    throw new ResizeSetupError(
      opts.resizers
        ? 'resize worker: the `resizers` list is empty — pass the Resizers this worker serves'
        : 'resize worker: no Resizer constructed — construct your Resizers in the worker process before starting it',
      { code: 'RESIZE_NO_RESIZER' },
    );
  }
  // Drivers given as functions load now, so each Resizer's task queue is known.
  await Promise.all(resizers.map((resizer) => resizer.ready()));
  const queues = new Set<TaskQueue>();
  for (const resizer of resizers) {
    if (resizer.tasks) {
      queues.add(resizer.tasks);
    }
  }
  if (queues.size === 0) {
    logger.error(
      'resize worker: no Resizer has a task queue (eager-only wiring)',
    );
    return;
  }
  // A task queue that can't consume this queue name (e.g. SQS without that queue URL) is skipped,
  // so one Resizer's missing queue never stops the others.
  for (const tasks of [...queues]) {
    if (tasks.servesQueue && !tasks.servesQueue(queue)) {
      queues.delete(tasks);
      logger.info(
        `resize worker: a task queue does not serve queue '${queue}' — skipping it`,
      );
    }
  }
  if (queues.size === 0) {
    throw new ResizeSetupError(
      `resize worker: no task queue serves queue '${queue}'`,
      { code: 'RESIZE_QUEUE_NOT_SERVED' },
    );
  }
  // Fail before claiming anything: a bad config, queue or store (e.g. a wrong mediaModelName)
  // would otherwise surface only as per-task errors.
  for (const resizer of resizers) {
    await resizer.verify();
  }

  // Dead-letter cooldowns run beside the loop, so they never delay it or the observers; the worker
  // waits for the pending ones before it returns.
  const cooldowns = new Set<Promise<void>>();
  // Tasks and events are routed by the task's Resizer name among the served Resizers. Any other
  // name, constructed in this process or not, is not served.
  const ownerOf = (task: LeasedTask) =>
    resizers.find((r) => r.name === task.resizer);
  const notServed = (task: LeasedTask) =>
    `Resizer '${task.resizer}' is not served by this worker (pass it in runWorker({ resizers }) or construct it before the worker starts)`;
  // A task of a Resizer not served fails with RESIZE_NO_RESIZER, so it retries and dead-letters.
  const handleOf =
    (tasks: TaskQueue): ConsumerDeps['handle'] =>
    async (task, taskOpts) => {
      const owner = ownerOf(task);
      if (!owner) {
        throw new ResizeSetupError(`resize worker: ${notServed(task)}`, {
          code: 'RESIZE_NO_RESIZER',
        });
      }
      return runTask(owner, task, taskOpts, tasks);
    };
  const eventsOf =
    (tasks: TaskQueue): TaskEventHandler =>
    async (event, task, error) => {
      const owner = ownerOf(task);
      if (!owner) {
        logger.error(
          `resize worker: ${event} for task ${task.taskId} dropped — ${notServed(task)}`,
        );
        return;
      }
      // A served Resizer was readied at startup, so this resolves at once; it is kept so the
      // Processor is never read before ready().
      await owner.ready();
      const { processor } = owner;
      if (event === 'deadLettered') {
        // Outside the cooldown's never-reject guard, which is safe: this queue's timing was
        // validated through timingOf when its Consumer was built, and timingOf caches it.
        const cooldown = processor.holdFailedCooldown(
          task,
          timingOf(tasks).lockTtlMs.failed,
        );
        cooldowns.add(cooldown);
        void cooldown.then(() => cooldowns.delete(cooldown));
      }
      await processor.notify(event, task, error);
    };

  if (opts.sharp) {
    sharp.concurrency(opts.sharp.concurrency);
    sharp.cache(opts.sharp.cache);
  }

  // One loop per task queue, all on one stop signal. The first loop to fail is the cause; the
  // others may then reject only because of the abort.
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  if (opts.signal.aborted) {
    stop.abort();
  }
  opts.signal.addEventListener('abort', onAbort, { once: true });
  let firstFailure: { error: unknown } | undefined;
  try {
    await Promise.allSettled(
      [...queues].map(async (tasks) => {
        try {
          // timingOf validates the queue's timing here, so invalid timing fails this loop.
          await new Consumer({
            tasks,
            timing: timingOf(tasks),
            handle: handleOf(tasks),
            events: eventsOf(tasks),
            logger,
          }).run(queue, stop.signal);
        } catch (err) {
          firstFailure ??= { error: err };
          stop.abort();
        }
      }),
    );
  } finally {
    opts.signal.removeEventListener('abort', onAbort);
  }
  await Promise.all(cooldowns);
  if (firstFailure) {
    throw firstFailure.error;
  }
  logger.info('resize worker stopped');
}
