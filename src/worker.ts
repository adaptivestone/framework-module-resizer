// The worker, framework-free. `runWorker()` serves every registered Resizer for ONE named queue: it
// runs the core queue loop (src/queue.ts) once per distinct TaskQueue the Resizers use, after
// verifying every Resizer. Each task runs with the Resizer named in it, and its events go to that
// Resizer's observers. After a dead-letter it holds the task's dispatch locks for a cooldown.
// Framework hosts start it through `runResizeWorker()` (src/framework/worker.ts), which adds the
// `worker.enabled` switch, process signals and the app logger.
import sharp from 'sharp';
import type {
  LeasedTask,
  TaskEvent,
  TaskEventHandler,
  TaskQueue,
} from './contracts/taskQueue.ts';
import { canonicalizeVariants, dispatchLockKey } from './enqueue.ts';
import { ResizeSetupError } from './errors.ts';
import { getPreviewIdentity } from './images.ts';
import { consumeQueue, timingOf } from './queue.ts';
import {
  getResizer,
  listResizers,
  type ObserverName,
  type Resizer,
} from './resizer.ts';
import { processTaskWith } from './resizeTask.ts';
import type { ResizeLogger } from './types.d.ts';

const OBSERVER: Record<TaskEvent, ObserverName> = {
  completed: 'afterTaskComplete',
  failed: 'onTaskFailed',
  deadLettered: 'onTaskDeadLettered',
};

/**
 * Run one task with the Resizer it names. An unknown name rejects with RESIZE_NO_RESIZER, so the
 * task retries and dead-letters instead of running with another Resizer's storage and config.
 */
export async function processTask(
  task: LeasedTask,
  taskOpts?: { signal: AbortSignal },
  tasks?: TaskQueue, // the delivering queue; default: the Resizer's own
): Promise<void> {
  const resizer = getResizer(task.resizer);
  await resizer.ready();
  return processTaskWith(resizer, task, taskOpts, tasks ?? resizer.tasks);
}

/**
 * After a dead-letter, hold the dispatch lock of every variant in the task for the delivering
 * queue's lockTtlMs.failed, so reads (resolve, prewarm) do not queue the same failing work again
 * until it ends. Release first, then acquire: the read path's shorter dispatch lock may still be
 * held. Best effort and never rejects: a failing lock call is logged, and a read that takes the
 * lock between the two calls simply queues the work once more.
 */
async function holdFailedCooldown(
  resizer: Resizer,
  task: LeasedTask,
  tasks: TaskQueue,
  logger: ResizeLogger,
): Promise<void> {
  try {
    const ttlMs = timingOf(tasks).lockTtlMs.failed;
    const scope = { resizer: resizer.name, pipeline: task.pipeline };
    const keys = new Set(
      canonicalizeVariants(task.previews).map((variant) =>
        dispatchLockKey(
          task.mediaId,
          getPreviewIdentity(
            scope,
            variant.sizeKey,
            variant.format,
            variant.filters,
          ),
        ),
      ),
    );
    await Promise.all(
      [...keys].map(async (key) => {
        try {
          await resizer.db.releaseLock(key);
          await resizer.db.acquireLock(key, ttlMs);
        } catch (err) {
          logger.error(
            `resize worker: holding the dead-letter cooldown lock ${key} failed`,
            err,
          );
        }
      }),
    );
  } catch (err) {
    logger.error(
      `resize worker: the dead-letter cooldown of task ${task.taskId} failed`,
      err,
    );
  }
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
  // Fail before claiming anything: a bad config, queue or database (e.g. a wrong mediaModelName)
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
      if (event === 'deadLettered') {
        const cooldown = holdFailedCooldown(owner, task, tasks, logger);
        cooldowns.add(cooldown);
        void cooldown.then(() => cooldowns.delete(cooldown));
      }
      if (event === 'completed') {
        await owner.runObservers(OBSERVER[event], task, {});
      } else {
        await owner.runObservers(OBSERVER[event], task, error, {});
      }
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
