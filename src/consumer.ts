// The worker loop, the same for every TaskQueue backend: claiming, the lease heartbeat, the task
// timeout, giving tasks back at shutdown, the retry policy (backoff, dead-lettering after
// maxAttempts, non-retryable errors) and task events. Backends only implement the atomic TaskQueue
// operations.
import type {
  ClaimedTask,
  LeasedTask,
  TaskEvent,
  TaskEventHandler,
  TaskQueue,
} from './contracts/taskQueue.ts';
import { ResizeError } from './errors.ts';
import { sleep } from './helpers/sleep.ts';
import type { QueueTiming } from './timing.ts';
import type { QueueTimingOptions, ResizeLogger } from './types.d.ts';

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

// The thrower says when no retry can help (`retryable: false`), so the task is dead-lettered at
// once instead of being downloaded and decoded again. Errors cross process boundaries as plain
// objects, so read the field, never the class.
function notRetryable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { retryable?: unknown }).retryable === false
  );
}

export interface ConsumerDeps {
  tasks: TaskQueue;
  timing: QueueTiming; // the queue's complete timing (timingOf)
  // Runs one task: resolving completes it, rejecting fails it. The signal aborts on a lost lease,
  // a timeout or the shutdown.
  handle: (task: LeasedTask, opts: { signal: AbortSignal }) => Promise<void>;
  events?: TaskEventHandler;
  logger: ResizeLogger;
}

// Consecutive claim failures wait idlePollMs × 2^(n-1), up to this many idlePollMs, so a down
// database is not hit (and logged) by every worker every idlePollMs.
const MAX_CLAIM_ERROR_BACKOFF = 10;

export class Consumer {
  readonly #deps: ConsumerDeps;

  constructor(deps: ConsumerDeps) {
    this.#deps = deps;
  }

  /**
   * Consume `queue` until `signal` aborts: the current task finishes, or goes back to the queue
   * unprocessed if the stop aborted it; then it returns. When nothing is due the loop waits until
   * idlePollMs has passed since the claim started, so a claim that already waited (a long poll)
   * is retried at once. A storage hiccup never kills the loop: it is logged and retried with a
   * growing delay that resets after the next successful claim.
   */
  async run(queue: string, signal: AbortSignal): Promise<void> {
    const { tasks, timing, logger } = this.#deps;
    const { leaseMs, idlePollMs, maxAttempts } = timing;
    let claimFailures = 0;
    while (!signal.aborted) {
      let task: ClaimedTask | null;
      const claimStarted = Date.now();
      try {
        task = await tasks.claim(queue, leaseMs, signal);
      } catch (err) {
        if (signal.aborted) {
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
        await sleep(waitMs, signal);
        continue;
      }
      claimFailures = 0;
      if (!task) {
        const waited = Date.now() - claimStarted;
        if (waited < idlePollMs) {
          await sleep(idlePollMs - waited, signal);
        }
        continue;
      }
      // Delivered more often than allowed (its workers kept crashing mid-task): dead, not retried.
      if (task.attempts > maxAttempts) {
        await this.#finish(
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
      if (signal.aborted) {
        await this.#giveBack(task);
        break;
      }
      await this.#runTask(task, signal);
    }
  }

  /** Run one claimed task under its lease, then complete, fail or give it back. */
  async #runTask(task: ClaimedTask, signal: AbortSignal): Promise<void> {
    const { tasks, timing, handle, logger } = this.#deps;
    const { leaseMs, taskTimeoutMs } = timing;
    const heartbeatMs = Math.max(1, Math.floor(leaseMs / 2));
    // Per-task lease-loss signal; worker shutdown also aborts the current task, so it finishes
    // its current variant, skips the rest, goes back to the queue, and the loop exits promptly.
    const taskController = new AbortController();
    const onShutdown = () => taskController.abort();
    signal.addEventListener('abort', onShutdown, { once: true });
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      tasks
        .renew(task, leaseMs)
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
        handle(toLeasedTask(task), { signal: taskController.signal }).then(
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
      signal.removeEventListener('abort', onShutdown);
    }

    if (timedOut) {
      // The detached handler is harmless: later writes are token-fenced, and previews it pushes
      // are valid ones.
      taskController.abort();
      await this.#finish(
        task,
        new ResizeError(
          `resize worker: task ${task.taskId} exceeded taskTimeoutMs (${taskTimeoutMs}ms)`,
          { code: 'RESIZE_TASK_TIMEOUT' },
        ),
      );
    } else if (ok) {
      try {
        if (await tasks.complete(task)) {
          await this.#report('completed', task);
        }
      } catch (err) {
        logger.error(
          `resize worker: completing task ${task.taskId} failed`,
          err,
        );
      }
    } else if (signal.aborted && !leaseLost && !notRetryable(handlerError)) {
      // Stopped by the shutdown, not by its own failure: not an attempt. A non-retryable error
      // still dead-letters: the task proved it can never succeed before the shutdown stopped it.
      await this.#giveBack(task);
    } else {
      await this.#finish(task, handlerError);
    }
  }

  async #report(
    event: TaskEvent,
    task: ClaimedTask,
    error?: unknown,
  ): Promise<void> {
    try {
      await this.#deps.events?.(event, toLeasedTask(task), error);
    } catch (err) {
      // A throwing observer must not undo the task's state or stop the loop.
      this.#deps.logger.error(
        `resize worker: ${event} event handler failed`,
        err,
      );
    }
  }

  /** Retry the task after its backoff, or dead-letter it (forced, not retryable, last attempt). */
  async #finish(
    task: ClaimedTask,
    error: unknown,
    forceDead = false,
  ): Promise<void> {
    const { tasks, timing, logger } = this.#deps;
    const dead =
      forceDead || notRetryable(error) || task.attempts >= timing.maxAttempts;
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
        await this.#report(dead ? 'deadLettered' : 'failed', task, error);
      }
    } catch (err) {
      logger.error(`resize worker: failing task ${task.taskId} failed`, err);
    }
  }

  // The worker's shutdown stopped the task: it was not processed, so it goes back with no event,
  // no backoff and, where the queue can release it, without counting the delivery. A queue without
  // `release` retries it at once through `fail`; the delivery then counts, but it is never
  // dead-lettered here.
  async #giveBack(task: ClaimedTask): Promise<void> {
    const { tasks, logger } = this.#deps;
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
  }
}
