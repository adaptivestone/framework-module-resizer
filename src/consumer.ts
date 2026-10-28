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
  // does not accept is never handled: it goes back unprocessed for another worker (holding its
  // gate lock, when coordinationOf gives one, as a task given back does), before the maxAttempts
  // check, so it is never dead-lettered here, and the loop waits idlePollMs before its next claim,
  // so a queue that holds only such tasks is not claimed in a tight loop.
  accepts?: (task: LeasedTask) => boolean;
  // Runs one task: resolving completes it, rejecting fails it. The signal aborts on a lost lease,
  // a timeout or the shutdown.
  handle: (task: LeasedTask, opts: { signal: AbortSignal }) => Promise<void>;
  events?: TaskEventHandler;
  logger: ResizeLogger;
  // Optional: the Resizers this worker serves, passed to every claim, so a queue that filters
  // claims hands out only their tasks.
  resizers?: readonly string[];
  // Optional, must not throw: the coordination of the task's Resizer, read once for each claimed
  // task: the cooldown its dead-letter gets, the gateTtlMs a task given back keeps its gate lock
  // for, and the lock store that holds its gate lock on a queue without gatesByTask. Undefined, or
  // absent: the default cooldown and no gate lock.
  coordinationOf?: (task: LeasedTask) => TaskCoordination | undefined;
}

// The gate lock of a task on a queue without gatesByTask. Such a queue cannot tell that a task of
// the same Resizer, media, pipeline and queue is already active, so the Dispatcher takes a lock in
// the Resizer's LockStore when it queues one, under an owner that travels with the task
// (`gateOwner`).
// The Consumer keeps that lock for as long as the task can still run: one lease and one heartbeat
// interval when the task starts and on every heartbeat (so a redelivery after a crash still finds
// it), the backoff plus one lease after a retry, the cooldown after a dead-letter, gateTtlMs after
// a give-back (as a freshly queued task holds it); it releases the lock once the task is
// completed. When an extend finds the lock lapsed (`false`) while the task runs, or for a retry
// or a cooldown hold, the Consumer takes it back once under the task's owner (`acquire`), which
// succeeds only while nobody else holds it: a lock another request took over stays theirs. A
// give-back only extends it. Once a task's lease is known to be lost, the Consumer makes no
// call for it at all: no terminal call, no gate call, no event. Every call is best effort: a
// failure is logged, and neither changes the task's outcome or its events. A call that has not answered within the gate bound
// (min(leaseMs, 30 s)) counts as failed, and a task's end waits for its gate calls for at most one
// bound in all, so a hanging lock store never holds a task, the loop or the shutdown longer.
interface GateLock {
  locks: LockStore;
  key: string;
  owner: string;
  gateTtlMs: number; // the hold of a task given back
}

// Consecutive claim failures wait idlePollMs × 2^(n-1), up to this many idlePollMs, so a down
// database is not hit (and logged) by every worker every idlePollMs.
const MAX_CLAIM_ERROR_BACKOFF = 10;

// The longest wait for the lock store, whatever the lease: see GateLock.
const MAX_GATE_WAIT_MS = 30_000;

// A gate call that has not answered in time.
const TIMED_OUT = Symbol('timed out');

// The retake rules of a hold made after the task ended: a retry or cooldown hold takes a lapsed
// lock back, a give-back only extends it (see #giveBack).
const always = () => true;
const never = () => false;

export class Consumer {
  readonly #deps: ConsumerDeps;
  // How long one gate call, or all the gate calls at a task's end, may take (see GateLock).
  readonly #gateWaitMs: number;

  constructor(deps: ConsumerDeps) {
    this.#deps = deps;
    this.#gateWaitMs = Math.min(deps.timing.leaseMs, MAX_GATE_WAIT_MS);
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
      const coordination = coordinationOf?.(toLeasedTask(task));
      // Not a task this worker runs (see ConsumerDeps.accepts): back to the queue for another.
      if (accepts && !accepts(toLeasedTask(task))) {
        await this.#giveBack(
          task,
          coordination,
          `resize worker: task ${task.taskId} was given back: this worker does not accept it`,
        );
        await sleep(idlePollMs, signal);
        continue;
      }
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
        await this.#giveBackAtShutdown(task, coordination);
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
    // The gate outlives the lease by one heartbeat interval: the lock and the lease are moved by
    // the same tick, so after a crash a redelivery that starts once the lease has ended still finds
    // its gate held.
    const runningGateMs = leaseMs + heartbeatMs;
    // Per-task lease-loss signal; worker shutdown also aborts the current task, so it finishes
    // its current variant, skips the rest, goes back to the queue, and the loop exits promptly.
    const taskController = new AbortController();
    const onShutdown = () => taskController.abort();
    signal.addEventListener('abort', onShutdown, { once: true });
    let leaseLost = false;
    // The gate lock gets runningGateMs when the task starts: the task may have waited in the queue
    // for most of the lock's time. Each heartbeat that renewed the lease extends it again, until the
    // task ends. Gate calls run one after another, so the one made after the task lands last. A
    // heartbeat skips its extend while an earlier one is still pending, which serves as well: a
    // slow lock store gets no backlog, and the task's end waits for at most that one call, and
    // never longer than the gate bound.
    const gate = this.#gate(task, coordination);
    let ended = false;
    // Set once the task's end stops waiting for the gate calls made while it ran: a call still
    // pending then must not take a lapsed lock back behind the end's own call.
    let settled = false;
    const running = () => !leaseLost && !settled;
    let extendPending = false;
    let gateCalls = this.#holdGate(task, gate, runningGateMs, running);
    const heartbeat = setInterval(() => {
      tasks.renew(task, leaseMs).then(
        (held) => {
          if (!held) {
            leaseLost = true;
            taskController.abort();
          } else if (gate && !ended && !extendPending) {
            extendPending = true;
            gateCalls = gateCalls
              // Not after the task ended, or once its lease is known to be lost.
              .then(() =>
                ended || leaseLost
                  ? undefined
                  : this.#holdGate(task, gate, runningGateMs, running),
              )
              .finally(() => {
                extendPending = false;
              });
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
    if (timedOut) {
      // Abort at once: the handler must not wait behind a pending gate call. The detached handler
      // is harmless: later writes are token-fenced, and previews it pushes are valid ones.
      taskController.abort();
    }
    if (leaseLost) {
      // Another worker may hold the task now. Any write would be stale: SQS accepts the delete of
      // an old receipt, and both deliveries share the gate owner, so a completion here would
      // release the gate of the delivery that runs it now. So no terminal call, no gate call and
      // no event: the task is left to its next delivery.
      taskController.abort();
      logNeverThrow(
        logger,
        `resize worker: task ${task.taskId} lost its lease — left to its next delivery`,
        undefined,
        'warn',
      );
      return;
    }
    // From here on every gate call of this task shares one deadline: the task's end, and with it
    // the loop and the shutdown, waits for the lock store for at most one gate bound in all. A
    // call made after the deadline is still sent, but its answer is not waited for.
    const gateDeadline = Date.now() + this.#gateWaitMs;
    await this.#within(gateCalls, gateDeadline);
    settled = true;

    if (timedOut) {
      await this.#finish(
        task,
        coordination,
        new ResizeError(
          `resize worker: task ${task.taskId} exceeded taskTimeoutMs (${taskTimeoutMs}ms)`,
          { code: 'RESIZE_TASK_TIMEOUT' },
        ),
        false,
        gateDeadline,
      );
    } else if (ok) {
      try {
        if (await tasks.complete(task)) {
          await this.#releaseGate(task, gate, gateDeadline);
          await this.#report('completed', task);
        }
      } catch (err) {
        logNeverThrow(
          logger,
          `resize worker: completing task ${task.taskId} failed`,
          err,
        );
      }
    } else if (signal.aborted && !notRetryable(handlerError)) {
      // Stopped by the shutdown, not by its own failure: not an attempt. A non-retryable error
      // still dead-letters: the task proved it can never succeed before the shutdown stopped it.
      await this.#giveBackAtShutdown(task, coordination, gateDeadline);
    } else {
      await this.#finish(task, coordination, handlerError, false, gateDeadline);
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
   * for the cooldown; the gate call waits until `gateDeadline` at most.
   */
  async #finish(
    task: ClaimedTask,
    coordination: TaskCoordination | undefined,
    error: unknown,
    forceDead = false,
    gateDeadline = Date.now() + this.#gateWaitMs,
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
          await this.#holdGate(task, gate, cooldownMs, always, gateDeadline);
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
          always,
          gateDeadline,
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
      key: gateKey(task.resizer, task.queue, task.mediaId, task.pipeline),
      owner: task.gateOwner,
      gateTtlMs: coordination.gateTtlMs,
    };
  }

  /**
   * Move the gate lock's expiry to `ttlMs` from now, when there is one, waiting until `deadline`
   * at most (default: one gate bound). When the extend finds the lock lapsed, take it back once
   * under the task's owner, while `retake()` still allows it; `false` from that acquire (another
   * request holds the gate) is ignored. Never rejects.
   */
  async #holdGate(
    task: ClaimedTask,
    gate: GateLock | undefined,
    ttlMs: number,
    retake: () => boolean = always,
    deadline = Date.now() + this.#gateWaitMs,
  ): Promise<void> {
    if (!gate) {
      return;
    }
    const held = await this.#gateCall(
      task,
      'extending',
      () => gate.locks.extend(gate.key, gate.owner, ttlMs),
      deadline,
    );
    if (held === false && retake()) {
      await this.#gateCall(
        task,
        'taking back',
        () => gate.locks.acquire(gate.key, gate.owner, ttlMs),
        deadline,
      );
    }
  }

  /** Release the gate lock, when there is one, waiting until `deadline` at most. Never rejects. */
  async #releaseGate(
    task: ClaimedTask,
    gate: GateLock | undefined,
    deadline: number,
  ): Promise<void> {
    if (!gate) {
      return;
    }
    await this.#gateCall(
      task,
      'releasing',
      () => gate.locks.release(gate.key, gate.owner),
      deadline,
    );
  }

  /**
   * One lock store call for the gate lock of `task`, made at once. The Consumer waits for its
   * answer until `deadline` (only for an answer already there, once that has passed); a call still
   * pending then goes on without it. Resolves with the answer, or undefined when the call rejected
   * or did not answer in time (both logged, as failed calls). Never rejects.
   */
  async #gateCall(
    task: ClaimedTask,
    action: 'extending' | 'releasing' | 'taking back',
    call: () => Promise<boolean>,
    deadline: number,
  ): Promise<boolean | undefined> {
    const { logger } = this.#deps;
    const what = `${action} the gate lock of task ${task.taskId}`;
    // A rejection is logged whenever it comes, so a call the worker stopped waiting for never
    // becomes an unhandled rejection.
    const failed = (err: unknown) => {
      logNeverThrow(logger, `resize worker: ${what} failed`, err);
      return undefined;
    };
    let answer: Promise<boolean | undefined>;
    try {
      answer = Promise.resolve(call()).then((held) => held, failed);
    } catch (err) {
      return failed(err);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(
        () => resolve(TIMED_OUT),
        Math.max(0, deadline - Date.now()),
      );
    });
    try {
      const result = await Promise.race([answer, late]);
      if (result === TIMED_OUT) {
        logNeverThrow(
          logger,
          `resize worker: ${what} timed out (the lock store did not answer within ${this.#gateWaitMs} ms) — the worker goes on without it`,
        );
        return undefined;
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Wait for `calls` until `deadline` at most; whatever is still pending then goes on alone. */
  async #within(calls: Promise<void>, deadline: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
    });
    try {
      await Promise.race([calls, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  // The worker's shutdown stopped the task before or while it ran.
  async #giveBackAtShutdown(
    task: ClaimedTask,
    coordination: TaskCoordination | undefined,
    gateDeadline?: number,
  ): Promise<void> {
    await this.#giveBack(
      task,
      coordination,
      `resize worker: task ${task.taskId} was stopped by a worker shutdown`,
      `resize worker: shutdown — task ${task.taskId} is back in the queue`,
      gateDeadline,
    );
  }

  // The task was not processed, so it goes back with no event, no backoff and, where the queue
  // can release it, without counting the delivery. A queue without `release` retries it at once
  // through `fail`, which records `reason`; the delivery then counts, but it is never dead-lettered
  // here. Its gate lock (when it has one) is held for gateTtlMs, as a freshly queued task holds
  // it, so a long deploy does not reopen the gate. `done`, when given, is logged at info once the
  // task is back.
  async #giveBack(
    task: ClaimedTask,
    coordination: TaskCoordination | undefined,
    reason: string,
    done?: string,
    gateDeadline?: number,
  ): Promise<void> {
    const { tasks, logger } = this.#deps;
    // The hold comes first, while the task is not back yet. It only extends the lock, never takes
    // a lapsed one back: a worker that lost its lease without knowing it (its renewals hung) gives
    // the task back after the next holder may have completed it and released the gate.
    const gate = this.#gate(task, coordination);
    await this.#holdGate(task, gate, gate?.gateTtlMs ?? 0, never, gateDeadline);
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
