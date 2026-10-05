// The worker (07 · Worker §11), framework-free. `runWorker()` serves every registered Resizer for
// ONE named queue: it runs the core queue loop (src/queue.ts) once per distinct TaskQueue the
// Resizers use, after verifying every Resizer. Each task runs with the Resizer named in it, and its
// events go to that Resizer's observers. Framework hosts start it through `runResizeWorker()`
// (src/framework/worker.ts), which adds the `worker.enabled` switch, process signals and the app
// logger.
import sharp from 'sharp';
import type {
  LeasedTask,
  TaskEvent,
  TaskEventHandler,
  TaskQueue,
} from './contracts/taskQueue.ts';
import { ResizeSetupError } from './errors.ts';
import { consumeQueue } from './queue.ts';
import { getResizer, listResizers, type ObserverName } from './resizer.ts';
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
  return processTaskWith(resizer, task, taskOpts, tasks ?? resizer.tasks);
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

  // Events are routed by the task's Resizer name, looked up when the event arrives.
  const onEvent: TaskEventHandler = async (event, task, error) => {
    const owner = listResizers().find((r) => r.name === task.resizer);
    if (!owner) {
      logger.error(
        `resize worker: ${event} for task ${task.taskId} of unknown Resizer '${task.resizer}'`,
      );
      return;
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
            onEvent,
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
  if (firstFailure) {
    throw firstFailure.error;
  }
  logger.info('resize worker stopped');
}
