// The core queue logic, the same for every TaskQueue backend: the worker loop (claim, lease
// heartbeat, task timeout), the retry policy (backoff, dead-lettering after maxAttempts, terminal
// errors) and task events. Backends only implement the atomic TaskQueue operations.
import { defaultQueueOptions } from './config/resize.ts';
import type {
  ClaimedTask,
  LeasedTask,
  TaskEvent,
  TaskEventHandler,
  TaskQueue,
} from './contracts/taskQueue.ts';
import { ResizeError } from './errors.ts';
import { sleep } from './helpers/sleep.ts';
import { validateQueueTiming } from './resizeConfig.ts';
import type { QueueTimingOptions, ResizeLogger } from './types.d.ts';

const TIMING_KEYS = [
  'lockTtlMs',
  'leaseMs',
  'retryBackoffMs',
  'maxAttempts',
  'idlePollMs',
  'taskTimeoutMs',
] as const;

const timings = new WeakMap<object, QueueTimingOptions>();

/**
 * Complete queue timing: the timing keys set in `own` over the defaults (other keys are ignored),
 * validated. Throws ResizeConfigError for invalid timing.
 */
export function fillTiming(
  own: Partial<QueueTimingOptions> | Record<string, unknown>,
): QueueTimingOptions {
  const timing: Record<string, unknown> = { ...defaultQueueOptions };
  for (const key of TIMING_KEYS) {
    const value = (own as Record<string, unknown>)[key];
    if (value !== undefined) {
      timing[key] = value;
    }
  }
  validateQueueTiming(timing);
  return timing as unknown as QueueTimingOptions;
}

/**
 * A queue's timing: its getTiming() over the defaults, validated once per queue instance (a lazy
 * getTiming is read on first use). Throws ResizeConfigError for invalid timing.
 */
export function timingOf(tasks: TaskQueue): QueueTimingOptions {
  const cached = timings.get(tasks);
  if (cached) {
    return cached;
  }
  const timing = fillTiming(tasks.getTiming?.() ?? {});
  timings.set(tasks, timing);
  return timing;
}

/** Retry delay after `attempts` deliveries: `min(max, base * 2 ** (attempts - 1))`. */
export function backoffMs(
  attempts: number,
  timing: QueueTimingOptions,
): number {
  const { base, max } = timing.retryBackoffMs;
  return Math.min(max, base * 2 ** (Math.max(1, attempts) - 1));
}

/** The task as observers and handlers see it: without the lease token and attempt count. */
export function toLeasedTask(task: ClaimedTask): LeasedTask {
  return {
    taskId: task.taskId,
    resizer: task.resizer,
    queue: task.queue,
    mediaId: task.mediaId,
    pipeline: task.pipeline,
    previews: task.previews,
  };
}

export interface ConsumeQueueOptions {
  queue: string;
  signal: AbortSignal; // stops the loop: the current task finishes or aborts, then it returns
  handle: (
    task: LeasedTask,
    taskOpts: { signal: AbortSignal },
  ) => Promise<void>;
  onEvent?: TaskEventHandler;
  logger?: ResizeLogger;
}

/**
 * Consume `queue` from `tasks` until `signal` aborts. A storage hiccup never kills the loop: it is
 * logged and retried after idlePollMs.
 */
export async function consumeQueue(
  tasks: TaskQueue,
  opts: ConsumeQueueOptions,
): Promise<void> {
  const logger = opts.logger ?? console;
  const timing = timingOf(tasks);
  const { leaseMs, idlePollMs, taskTimeoutMs, maxAttempts } = timing;
  const heartbeatMs = Math.max(1, Math.floor(leaseMs / 2));
  const report = async (
    event: TaskEvent,
    task: ClaimedTask,
    error?: unknown,
  ): Promise<void> => {
    try {
      await opts.onEvent?.(event, toLeasedTask(task), error);
    } catch (err) {
      // A throwing observer must not undo the task's state or stop the loop.
      logger.error(`resize worker: ${event} event handler failed`, err);
    }
  };
  const finish = async (
    task: ClaimedTask,
    error: unknown,
    forceDead = false,
  ): Promise<void> => {
    // A media row without an original is terminal: retrying cannot make it appear. Errors cross
    // module boundaries as plain objects, so match the stable code, not the class.
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    const dead =
      forceDead ||
      code === 'RESIZE_NO_ORIGINAL' ||
      task.attempts >= maxAttempts;
    try {
      const held = await tasks.fail(
        task,
        dead
          ? 'dead'
          : {
              retryAt: new Date(Date.now() + backoffMs(task.attempts, timing)),
            },
        String(error).slice(0, 1000),
      );
      if (held) {
        await report(dead ? 'deadLettered' : 'failed', task, error);
      }
    } catch (err) {
      logger.error(`resize worker: failing task ${task.taskId} failed`, err);
    }
  };

  while (!opts.signal.aborted) {
    let task: ClaimedTask | null;
    try {
      task = await tasks.claim(opts.queue, leaseMs, opts.signal);
    } catch (err) {
      if (opts.signal.aborted) {
        break;
      }
      logger.error(
        'resize worker: claiming a task failed — retrying after idlePollMs',
        err,
      );
      await sleep(idlePollMs, opts.signal);
      continue;
    }
    if (!task) {
      await sleep(idlePollMs, opts.signal);
      continue;
    }
    // Delivered more often than allowed (its workers kept crashing mid-task): dead, not retried.
    if (task.attempts > maxAttempts) {
      await finish(
        task,
        new ResizeError(
          `resize worker: task ${task.taskId} exceeded maxAttempts (${maxAttempts})`,
          { code: 'RESIZE_TASK_MAX_ATTEMPTS' },
        ),
        true,
      );
      continue;
    }

    // Per-task lease-loss signal; worker shutdown also aborts the current task, so it finishes
    // its current variant, skips the rest, and the loop exits promptly.
    const taskController = new AbortController();
    const onShutdown = () => taskController.abort();
    opts.signal.addEventListener('abort', onShutdown, { once: true });
    if (opts.signal.aborted) {
      taskController.abort();
    }
    const claimed = task;
    const heartbeat = setInterval(() => {
      tasks
        .renew(claimed, leaseMs)
        .then((held) => {
          if (!held) {
            taskController.abort();
          }
        })
        .catch((err) => {
          logger.error('resize worker: lease renewal failed', err);
        });
    }, heartbeatMs);

    // Race the handler against taskTimeoutMs: one hung I/O call must not wedge the worker (the
    // heartbeat would keep renewing it forever). The handler's rejection is always handled, so a
    // detached handler that settles after a timeout never becomes an unhandled rejection.
    let handlerError: unknown;
    let ok = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, taskTimeoutMs);
    });
    try {
      await Promise.race([
        opts.handle(toLeasedTask(task), { signal: taskController.signal }).then(
          () => {
            ok = true;
          },
          (err) => {
            handlerError = err;
          },
        ),
        timeout,
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      clearInterval(heartbeat);
      opts.signal.removeEventListener('abort', onShutdown);
    }

    if (timedOut) {
      // The detached handler is harmless: later writes are token-fenced, and previews it pushes
      // are valid ones.
      taskController.abort();
      await finish(
        task,
        new ResizeError(
          `resize worker: task ${task.taskId} exceeded taskTimeoutMs (${taskTimeoutMs}ms)`,
          { code: 'RESIZE_TASK_TIMEOUT' },
        ),
      );
    } else if (ok) {
      try {
        if (await tasks.complete(task)) {
          await report('completed', task);
        }
      } catch (err) {
        logger.error(
          `resize worker: completing task ${task.taskId} failed`,
          err,
        );
      }
    } else {
      await finish(task, handlerError);
    }
  }
}
