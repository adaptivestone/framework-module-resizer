// The worker, framework-free. `runWorker()` serves every registered Resizer for ONE named queue: it
// runs the core queue loop (src/queue.ts) once per distinct TaskQueue the Resizers use, after
// verifying every Resizer. Each task runs with the Resizer named in it, and its events go to that
// Resizer's observers. After a dead-letter it holds the task's dispatch locks for a cooldown. The
// work itself is the Resizer's Processor (src/processor.ts).
// Framework hosts start it through `runResizeWorker()` (src/framework/worker.ts), which adds the
// `worker.enabled` switch, process signals and the app logger.
import sharp from 'sharp';
import { defaultQueueOptions } from './config/resize.ts';
import type {
  LeasedTask,
  TaskEventHandler,
  TaskQueue,
} from './contracts/taskQueue.ts';
import { ResizeSetupError } from './errors.ts';
import { getResizer, listResizers } from './resizer.ts';
import { consumeQueue, timingOf } from './timing.ts';
import type { ResizeLogger } from './types.d.ts';

/**
 * Run one task with the Resizer it names. An unknown name rejects with RESIZE_NO_RESIZER, so the
 * task retries and dead-letters instead of running with another Resizer's storage and config.
 * Worker locks last the delivering queue's lockTtlMs.worker, so they fit the lease it holds.
 */
export async function processTask(
  task: LeasedTask,
  taskOpts?: { signal: AbortSignal },
  tasks?: TaskQueue, // the delivering queue; default: the Resizer's own
): Promise<void> {
  const resizer = getResizer(task.resizer);
  await resizer.ready();
  // The delivering queue, else the Resizer's own; with neither (an eager-only Resizer), the
  // default TTL. Reading it before the Processor's lock check is safe: consumeQueue (and ready(),
  // for the Resizer's own queue) validated this timing through timingOf, which caches it.
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
}

export async function runWorker(opts: RunWorkerOptions): Promise<void> {
  const queue = opts.queue ?? 'default';
  const logger = opts.logger ?? console;
  const resizers = listResizers();
  if (resizers.length === 0) {
    throw new ResizeSetupError(
      'resize worker: no Resizer constructed — construct your Resizers in the worker process before starting it',
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
  // Events are routed by the task's Resizer name, looked up when the event arrives.
  const eventsOf =
    (tasks: TaskQueue): TaskEventHandler =>
    async (event, task, error) => {
      const owner = listResizers().find((r) => r.name === task.resizer);
      if (!owner) {
        logger.error(
          `resize worker: ${event} for task ${task.taskId} of unknown Resizer '${task.resizer}'`,
        );
        return;
      }
      // The Processor exists once the Resizer is ready. The task's own handler readied it, unless
      // the task failed before that (e.g. a part that failed to load once) or never reached it
      // (dead-lettered for too many deliveries). A Resizer that cannot start is caught by startup
      // verification; one that slips past it (constructed after the worker started) only loses its
      // observers: this rejects, the consume loop logs it, and the task's retry and dead-letter
      // bookkeeping is already done.
      await owner.ready();
      const { processor } = owner;
      if (event === 'deadLettered') {
        // Outside the cooldown's never-reject guard, which is safe: consumeQueue validated this
        // queue's timing through timingOf before its first claim, and timingOf caches it.
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
          await consumeQueue(tasks, {
            queue,
            signal: stop.signal,
            handle: (task, taskOpts) => processTask(task, taskOpts, tasks),
            onEvent: eventsOf(tasks),
            logger,
          });
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
