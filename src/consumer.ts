// The worker loop, the same for every TaskQueue backend: claiming (the served Resizers' tasks only,
// on a queue that filters claims), the lease heartbeat, the task timeout, giving tasks back (at
// shutdown, and tasks the worker does not accept), the retry policy (backoff, dead-lettering after
// maxAttempts, non-retryable errors), the dead-letter cooldown, the gate lock of a queue without
// gatesByTask, and task events. Backends only implement the atomic TaskQueue operations. The host
// logger is called only through logNeverThrow, so a logger that throws never stops the loop.
import { defaultCoordination } from './config/resize.ts';
import type { LockStore } from './contracts/locks.ts';
import type {
  ClaimedTask,
  ClaimOptions,
  LeasedTask,
  TaskEvent,
  TaskEventHandler,
  TaskQueue,
} from './contracts/taskQueue.ts';
import type { TaskCoordination } from './coordination.ts';
import { ResizeError } from './errors.ts';
import { logNeverThrow } from './helpers/log.ts';
import { sleep } from './helpers/sleep.ts';
import { gateKey } from './lockKeys.ts';
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

/** The task as observers and handlers see it: with its delivery count, without the lease token. */
export function toLeasedTask(task: ClaimedTask): LeasedTask {
  return {
    taskId: task.taskId,
    resizer: task.resizer,
    queue: task.queue,
    mediaId: task.mediaId,
    pipeline: task.pipeline,
    previews: task.previews,
    attempts: task.attempts,
  };
}

// A ResizeError says when no retry can help (`retryable: false`), so the task is dead-lettered at
// once instead of being downloaded and decoded again. The brand, not `instanceof`, identifies one:
// it also matches an error from a duplicate copy of this package. Errors from other libraries are
// retried, even with a `retryable` field of their own (an AWS SDK v2 4xx carries one).
function notRetryable(error: unknown): boolean {
  return ResizeError.isResizeError(error) && error.retryable === false;
}

export interface ConsumerDeps {
  tasks: TaskQueue;
  timing: QueueTiming; // the queue's complete timing (timingOf)
  // Optional, must not throw: whether this worker runs `task` (default: every task). A task it
  // does not accept is never handled: it goes back unprocessed for another worker, before the
  // maxAttempts check, so it is never dead-lettered here, and the loop waits idlePollMs before its
  // next claim, so a queue that holds only such tasks is not claimed in a tight loop.
  accepts?: (task: LeasedTask) => boolean;
  // Runs one task: resolving completes it, rejecting fails it. The signal aborts on a lost lease,
  // a timeout or the shutdown.
  handle: (task: LeasedTask, opts: { signal: AbortSignal }) => Promise<void>;
  events?: TaskEventHandler;
  logger: ResizeLogger;
  // Optional: the Resizers this worker serves, passed to every claim, so a queue that filters
  // claims hands out only their tasks.
  resizers?: readonly string[];
  // Optional, must not throw: the coordination of the task's Resizer, read once for each task the
  // worker accepts: the cooldown its dead-letter gets, and the lock store that holds its gate lock
  // on a queue without gatesByTask. Undefined, or absent: the default cooldown and no gate lock.
  coordinationOf?: (task: LeasedTask) => TaskCoordination | undefined;
}

// The gate lock of a task on a queue without gatesByTask. Such a queue cannot tell that a task of
// the same Resizer, media and pipeline is already active, so the Dispatcher takes a lock in the
// Resizer's LockStore when it queues one, under an owner that travels with the task (`gateOwner`).
// The Consumer keeps that lock for as long as the task can still run: one lease when the task
// starts and on every heartbeat, the backoff plus one lease after a retry, the cooldown after a
// dead-letter; it releases the lock once the task is completed. A task given back, or one whose
// lease was lost, leaves the lock to the task's next holder. Every call is best effort: `false`
// (the lock expired, or another request took it over) is ignored, a failure is logged, and neither
// changes the task's outcome or its events.
interface GateLock {
  locks: LockStore;
  key: string;
  owner: string;
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
    const { tasks, timing, accepts, resizers, coordinationOf, logger } =
      this.#deps;
    const { leaseMs, idlePollMs, maxAttempts } = timing;
    const claimOptions: ClaimOptions | undefined = resizers
      ? { resizers }
      : undefined;
    let claimFailures = 0;
    while (!signal.aborted) {
      let task: ClaimedTask | null;
      const claimStarted = Date.now();
      try {
        task = await tasks.claim(queue, leaseMs, signal, claimOptions);
      } catch (err) {
        if (signal.aborted) {
          break;
        }
        claimFailures += 1;
        const waitMs =
          idlePollMs *
          Math.min(2 ** (claimFailures - 1), MAX_CLAIM_ERROR_BACKOFF);
        logNeverThrow(
          logger,
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
      // Not a task this worker runs (see ConsumerDeps.accepts): back to the queue for another.
      if (accepts && !accepts(toLeasedTask(task))) {
        await this.#giveBack(
          task,
          `resize worker: task ${task.taskId} was given back: this worker does not accept it`,
        );
        await sleep(idlePollMs, signal);
        continue;
      }
      const coordination = coordinationOf?.(toLeasedTask(task));
      // Delivered more often than allowed (its workers kept crashing mid-task): dead, not retried.
      if (task.attempts > maxAttempts) {
        await this.#finish(
          task,
          coordination,
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
        await this.#giveBackAtShutdown(task);
        break;
      }
      await this.#runTask(task, coordination, signal);
    }
  }

  /**
   * Run one claimed task under its lease, holding its gate lock (when it has one), then complete,
   * fail or give it back.
   */
  async #runTask(
    task: ClaimedTask,
    coordination: TaskCoordination | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const { tasks, timing, handle, logger } = this.#deps;
    const { leaseMs, taskTimeoutMs } = timing;
    const heartbeatMs = Math.max(1, Math.floor(leaseMs / 2));
    // Per-task lease-loss signal; worker shutdown also aborts the current task, so it finishes
    // its current variant, skips the rest, goes back to the queue, and the loop exits promptly.
    const taskController = new AbortController();
    const onShutdown = () => taskController.abort();
    signal.addEventListener('abort', onShutdown, { once: true });
    let leaseLost = false;
    // The gate lock gets one lease when the task starts: the task may have waited in the queue for
    // most of the lock's time. Each heartbeat that renewed the lease extends it again, until the
    // task ends. Gate calls run one after another, so the one made after the task lands last.
    const gate = this.#gate(task, coordination);
    let ended = false;
    let gateCalls = this.#holdGate(task, gate, leaseMs);
    const heartbeat = setInterval(() => {
      tasks.renew(task, leaseMs).then(
        (held) => {
          if (!held) {
            leaseLost = true;
            taskController.abort();
          } else if (gate && !ended) {
            gateCalls = gateCalls.then(() =>
              this.#holdGate(task, gate, leaseMs),
            );
          }
        },
        (err) => {
          logNeverThrow(logger, 'resize worker: lease renewal failed', err);
        },
      );
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
    ended = true;
    await gateCalls;

    if (timedOut) {
      // The detached handler is harmless: later writes are token-fenced, and previews it pushes
      // are valid ones.
      taskController.abort();
      await this.#finish(
        task,
        coordination,
        new ResizeError(
          `resize worker: task ${task.taskId} exceeded taskTimeoutMs (${taskTimeoutMs}ms)`,
          { code: 'RESIZE_TASK_TIMEOUT' },
        ),
      );
    } else if (ok) {
      try {
        if (await tasks.complete(task)) {
          await this.#releaseGate(task, gate);
          await this.#report('completed', task);
        }
      } catch (err) {
        logNeverThrow(
          logger,
          `resize worker: completing task ${task.taskId} failed`,
          err,
        );
      }
    } else if (signal.aborted && !leaseLost && !notRetryable(handlerError)) {
      // Stopped by the shutdown, not by its own failure: not an attempt. A non-retryable error
      // still dead-letters: the task proved it can never succeed before the shutdown stopped it.
      await this.#giveBackAtShutdown(task);
    } else {
      await this.#finish(task, coordination, handlerError);
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
      logNeverThrow(
        this.#deps.logger,
        `resize worker: ${event} event handler failed`,
        err,
      );
    }
  }

  /**
   * Retry the task after its backoff, or dead-letter it (forced, not retryable, last attempt) with
   * its Resizer's cooldown. Its gate lock is then held until the retry is due plus one lease, or
   * for the cooldown.
   */
  async #finish(
    task: ClaimedTask,
    coordination: TaskCoordination | undefined,
    error: unknown,
    forceDead = false,
  ): Promise<void> {
    const { tasks, timing, logger } = this.#deps;
    const dead =
      forceDead || notRetryable(error) || task.attempts >= timing.maxAttempts;
    const message = String(error).slice(0, 1000);
    const gate = this.#gate(task, coordination);
    try {
      if (dead) {
        const cooldownMs =
          coordination?.cooldownMs ?? defaultCoordination.cooldownMs;
        if (await tasks.fail(task, 'dead', message, { cooldownMs })) {
          await this.#holdGate(task, gate, cooldownMs);
          await this.#report('deadLettered', task, error);
        }
        return;
      }
      const retryAt = new Date(Date.now() + backoffMs(task.attempts, timing));
      if (await tasks.fail(task, { retryAt }, message)) {
        await this.#holdGate(
          task,
          gate,
          Math.max(0, retryAt.getTime() - Date.now()) + timing.leaseMs,
        );
        await this.#report('failed', task, error);
      }
    } catch (err) {
      logNeverThrow(
        logger,
        `resize worker: failing task ${task.taskId} failed`,
        err,
      );
    }
  }

  /** The gate lock `task` holds (see GateLock), or undefined when it holds none. */
  #gate(
    task: ClaimedTask,
    coordination: TaskCoordination | undefined,
  ): GateLock | undefined {
    const locks = coordination?.locks;
    if (
      this.#deps.tasks.gatesByTask ||
      task.gateOwner === undefined ||
      !locks
    ) {
      return undefined;
    }
    return {
      locks,
      key: gateKey(task.resizer, task.mediaId, task.pipeline),
      owner: task.gateOwner,
    };
  }

  /** Move the gate lock's expiry to `ttlMs` from now, when there is one. Never rejects. */
  async #holdGate(
    task: ClaimedTask,
    gate: GateLock | undefined,
    ttlMs: number,
  ): Promise<void> {
    if (!gate) {
      return;
    }
    try {
      await gate.locks.extend(gate.key, gate.owner, ttlMs);
    } catch (err) {
      logNeverThrow(
        this.#deps.logger,
        `resize worker: extending the gate lock of task ${task.taskId} failed`,
        err,
      );
    }
  }

  /** Release the gate lock, when there is one. Never rejects. */
  async #releaseGate(
    task: ClaimedTask,
    gate: GateLock | undefined,
  ): Promise<void> {
    if (!gate) {
      return;
    }
    try {
      await gate.locks.release(gate.key, gate.owner);
    } catch (err) {
      logNeverThrow(
        this.#deps.logger,
        `resize worker: releasing the gate lock of task ${task.taskId} failed`,
        err,
      );
    }
  }

  // The worker's shutdown stopped the task before or while it ran.
  async #giveBackAtShutdown(task: ClaimedTask): Promise<void> {
    await this.#giveBack(
      task,
      `resize worker: task ${task.taskId} was stopped by a worker shutdown`,
      `resize worker: shutdown — task ${task.taskId} is back in the queue`,
    );
  }

  // The task was not processed, so it goes back with no event, no backoff and, where the queue
  // can release it, without counting the delivery. A queue without `release` retries it at once
  // through `fail`, which records `reason`; the delivery then counts, but it is never dead-lettered
  // here. `done`, when given, is logged at info once the task is back.
  async #giveBack(
    task: ClaimedTask,
    reason: string,
    done?: string,
  ): Promise<void> {
    const { tasks, logger } = this.#deps;
    try {
      const held = tasks.release
        ? await tasks.release(task)
        : await tasks.fail(task, { retryAt: new Date() }, reason);
      if (held && done) {
        logNeverThrow(logger, done, undefined, 'info');
      }
    } catch (err) {
      logNeverThrow(
        logger,
        `resize worker: giving task ${task.taskId} back failed`,
        err,
      );
    }
  }
}
