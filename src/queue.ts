// The core queue logic, the same for every TaskQueue backend: the worker loop (claim, lease
// heartbeat, task timeout, giving tasks back at shutdown), the retry policy (backoff,
// dead-lettering after maxAttempts, terminal errors) and task events. Backends only implement the
// atomic TaskQueue operations.
import { defaultQueueOptions } from './config/resize.ts';
import type {
  ClaimedTask,
  LeasedTask,
  TaskEvent,
  TaskEventHandler,
  TaskQueue,
} from './contracts/taskQueue.ts';
import { ResizeConfigError, ResizeError } from './errors.ts';
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

/** Complete queue timing: every key set, the optional lock TTLs included. */
export type QueueTiming = QueueTimingOptions & {
  lockTtlMs: Required<QueueTimingOptions['lockTtlMs']>;
};

const timings = new WeakMap<object, QueueTiming>();

/**
 * Check the optional dead-letter cooldown `lockTtlMs.failed` (ms) when it is set. Throws
 * ResizeConfigError.
 */
export function validateFailedLockTtl(failed: unknown): void {
  if (
    failed !== undefined &&
    !(typeof failed === 'number' && Number.isSafeInteger(failed) && failed > 0)
  ) {
    throw new ResizeConfigError(
      'resize queue options: lockTtlMs.failed must be a positive safe integer (ms)',
      { code: 'RESIZE_CONFIG_QUEUE_LOCK_TTL_INVALID' },
    );
  }
}

/**
 * Complete queue timing: the timing keys set in `own` over the defaults (other keys are ignored),
 * validated. A `lockTtlMs` without `failed` gets the default cooldown. Throws ResizeConfigError for
 * invalid timing.
 */
export function fillTiming(
  own: Partial<QueueTimingOptions> | Record<string, unknown>,
): QueueTiming {
  const timing: Record<string, unknown> = { ...defaultQueueOptions };
  for (const key of TIMING_KEYS) {
    const value = (own as Record<string, unknown>)[key];
    if (value !== undefined) {
      timing[key] = value;
    }
  }
  const lockTtlMs = timing.lockTtlMs;
  if (typeof lockTtlMs === 'object' && lockTtlMs !== null) {
    const failed = (lockTtlMs as { failed?: unknown }).failed;
    validateFailedLockTtl(failed);
    timing.lockTtlMs = {
      ...lockTtlMs,
      failed: failed ?? defaultQueueOptions.lockTtlMs.failed,
    };
  }
  validateQueueTiming(timing);
  return timing as unknown as QueueTiming;
}

/**
 * A queue's timing: its getTiming() over the defaults, validated once per queue instance (a lazy
 * getTiming is read on first use). Throws ResizeConfigError for invalid timing.
 */
export function timingOf(tasks: TaskQueue): QueueTiming {
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

// Errors no retry can fix: the media row has no original, its source has no dimensions or is over
// the pixel limits, or its SVG takes longer to render than allowed. Each retry would only download
// and decode the original again. Errors cross module boundaries as plain objects, so match the
// stable code, not the class.
const TERMINAL_ERROR_CODES: ReadonlySet<unknown> = new Set([
  'RESIZE_NO_ORIGINAL',
  'RESIZE_SOURCE_METADATA_MISSING',
  'RESIZE_SOURCE_TOO_LARGE',
  'RESIZE_SVG_RENDER_TIMEOUT',
]);

const isTerminal = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  TERMINAL_ERROR_CODES.has((error as { code?: unknown }).code);

export interface ConsumeQueueOptions {
  queue: string;
  // Stops the loop: the current task finishes, or goes back to the queue unprocessed if the stop
  // aborted it; then it returns.
  signal: AbortSignal;
  handle: (
    task: LeasedTask,
    taskOpts: { signal: AbortSignal },
  ) => Promise<void>;
  onEvent?: TaskEventHandler;
  logger?: ResizeLogger;
}

// Consecutive claim failures wait idlePollMs × 2^(n-1), up to this many idlePollMs, so a down
// database is not hit (and logged) by every worker every idlePollMs.
const MAX_CLAIM_ERROR_BACKOFF = 10;

/**
 * Consume `queue` from `tasks` until `signal` aborts. When nothing is due the loop waits until
 * idlePollMs has passed since the claim started, so a claim that already waited (a long poll)
 * is retried at once. A storage hiccup never kills the loop: it is logged and retried with a
 * growing delay that resets after the next successful claim.
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
    const dead = forceDead || isTerminal(error) || task.attempts >= maxAttempts;
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
  // The worker's shutdown stopped the task: it was not processed, so it goes back with no event,
  // no backoff and, where the queue can release it, without counting the delivery. A queue without
  // `release` retries it at once through `fail`; the delivery then counts, but it is never
  // dead-lettered here.
  const giveBack = async (task: ClaimedTask): Promise<void> => {
    try {
      const held = tasks.release
        ? await tasks.release(task)
        : await tasks.fail(
            task,
            { retryAt: new Date() },
            `resize worker: task ${task.taskId} was stopped by a worker shutdown`,
          );
      if (held) {
        logger.info(
          `resize worker: shutdown — task ${task.taskId} is back in the queue`,
        );
      }
    } catch (err) {
      logger.error(
        `resize worker: giving task ${task.taskId} back failed`,
        err,
      );
    }
  };

  let claimFailures = 0;
  while (!opts.signal.aborted) {
    let task: ClaimedTask | null;
    const claimStarted = Date.now();
    try {
      task = await tasks.claim(opts.queue, leaseMs, opts.signal);
    } catch (err) {
      if (opts.signal.aborted) {
        break;
      }
      claimFailures += 1;
      const waitMs =
        idlePollMs *
        Math.min(2 ** (claimFailures - 1), MAX_CLAIM_ERROR_BACKOFF);
      logger.error(
        `resize worker: claiming a task failed (${claimFailures} in a row) — retrying in ${waitMs} ms`,
        err,
      );
      await sleep(waitMs, opts.signal);
      continue;
    }
    claimFailures = 0;
    if (!task) {
      const waited = Date.now() - claimStarted;
      if (waited < idlePollMs) {
        await sleep(idlePollMs - waited, opts.signal);
      }
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
    // The shutdown arrived while the claim ran (a claim that returns at once ignores the signal).
    if (opts.signal.aborted) {
      await giveBack(task);
      break;
    }

    // Per-task lease-loss signal; worker shutdown also aborts the current task, so it finishes
    // its current variant, skips the rest, goes back to the queue, and the loop exits promptly.
    const taskController = new AbortController();
    const onShutdown = () => taskController.abort();
    opts.signal.addEventListener('abort', onShutdown, { once: true });
    const claimed = task;
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      tasks
        .renew(claimed, leaseMs)
        .then((held) => {
          if (!held) {
            leaseLost = true;
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
    } else if (opts.signal.aborted && !leaseLost && !isTerminal(handlerError)) {
      // Stopped by the shutdown, not by its own failure: not an attempt. A terminal error still
      // dead-letters: the task proved it can never succeed before the shutdown stopped it.
      await giveBack(task);
    } else {
      await finish(task, handlerError);
    }
  }
}
