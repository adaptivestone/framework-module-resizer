// The worker, framework-free. `runWorker()` serves a list of Resizers (default: every registered
// one) for ONE named queue: it runs one Consumer, the worker loop (src/consumer.ts), per distinct
// TaskQueue those Resizers use, after verifying each of them. Every claim names the served
// Resizers, so a task queue that filters claims never hands it another Resizer's task. Each task
// runs with the Resizer named in it and that Resizer's coordination (the cooldown of a dead-letter,
// and the lock store of the gate lock on a queue without gatesByTask), and its events go to that
// Resizer's observers. The host logger is called only through logNeverThrow, so a logger that
// throws never stops it.
// The work itself is the Resizer's Processor (src/processor.ts).
// Framework hosts start it through `runResizeWorker()` (src/framework/worker.ts), which adds the
// `worker.enabled` switch, process signals and the app logger.
import sharp from 'sharp';
import { Consumer } from './consumer.ts';
import type {
  LeasedTask,
  TaskEventHandler,
  TaskQueue,
} from './contracts/taskQueue.ts';
import type { TaskCoordination } from './coordination.ts';
import { ResizeSetupError } from './errors.ts';
import { logNeverThrow } from './helpers/log.ts';
import {
  getResizer,
  listResizers,
  processorOf,
  type Resizer,
  taskCoordinationOf,
  tasksPartOf,
} from './resizer.ts';
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
): Promise<void> {
  return runTask(getResizer(task.resizer), task, taskOpts);
}

/** Run one task with `resizer`, once its parts and services are ready. */
async function runTask(
  resizer: Resizer,
  task: LeasedTask,
  taskOpts: { signal: AbortSignal } | undefined,
): Promise<void> {
  await resizer.ready();
  return processorOf(resizer).processTask(task, taskOpts);
}

/**
 * Refuse to start when a Resizer of this process that the worker does not serve uses one of
 * `consumed`, the consumed task queues that cannot filter claims: the worker would claim that
 * Resizer's tasks without running them. A task queue that filters claims never hands it such a
 * task, so it may be shared and is not passed here. This is an early error only; the loop never
 * runs such a task either (see runWorker). Only the task queue part of each such Resizer is
 * loaded, so a failure of its other parts cannot hide it. A task queue that cannot be loaded fails
 * startup too, since it may be one of these. Resizers constructed in other processes cannot be
 * seen here.
 */
async function refuseUnservedSharers(
  queue: string,
  consumed: Set<TaskQueue>,
  unserved: Resizer[],
): Promise<void> {
  const sharing: string[] = [];
  const unknown: string[] = [];
  let loadError: unknown;
  for (const resizer of unserved) {
    let tasks: TaskQueue | undefined;
    try {
      tasks = await tasksPartOf(resizer);
    } catch (err) {
      unknown.push(`'${resizer.name}'`);
      loadError ??= err;
      continue;
    }
    if (tasks && consumed.has(tasks)) {
      sharing.push(`'${resizer.name}'`);
    }
  }
  const problems: string[] = [];
  if (sharing.length > 0) {
    problems.push(
      `Resizer(s) ${sharing.join(', ')} share a task queue this worker consumes for queue '${queue}' but are not in the \`resizers\` list — the worker would claim their tasks without running them; list them too, or give them their own task queue`,
    );
  }
  if (unknown.length > 0) {
    problems.push(
      `the task queue of Resizer(s) ${unknown.join(', ')} failed to load, so whether it is one this worker consumes for queue '${queue}' could not be determined — fix that task queue (the load error is the cause)`,
    );
  }
  if (problems.length > 0) {
    throw new ResizeSetupError(`resize worker: ${problems.join('; ')}`, {
      code: 'RESIZE_QUEUE_SHARED_RESIZER_UNLISTED',
      cause: loadError,
    });
  }
}

export interface RunWorkerOptions {
  queue?: string; // queue to consume; default 'default'
  signal: AbortSignal; // stops the worker: finish in-flight tasks, then return
  logger?: ResizeLogger; // the worker's own messages; default console
  // Process-wide Sharp tuning, applied once (keep Resizers' config.concurrency × concurrency ≈
  // CPU cores). Omitted: Sharp's settings are left as they are.
  sharp?: { concurrency: number; cache: boolean };
  // The Resizers to serve; default: every Resizer registered when the worker starts. Tasks and
  // events are routed by name among these only: a task of any other Resizer is never run here. A
  // task queue that filters claims never hands this worker another Resizer's task. On one that
  // does not, such a task goes back to the queue for a worker that serves it, or, without
  // `release`, fails with RESIZE_NO_RESIZER (it retries, then dead-letters) and its events are
  // logged and dropped; and a Resizer registered at start that shares such a task queue must be
  // listed too (RESIZE_QUEUE_SHARED_RESIZER_UNLISTED). Two listed Resizers need two names.
  resizers?: Resizer[];
}

export async function runWorker(opts: RunWorkerOptions): Promise<void> {
  const queue = opts.queue ?? 'default';
  const logger = opts.logger ?? console;
  // The served Resizers, taken once now, so one constructed later is not served (and neither is
  // it compared below); a Resizer listed twice is served once.
  const registered = listResizers();
  const resizers = [...new Set(opts.resizers ?? registered)];
  if (resizers.length === 0) {
    throw new ResizeSetupError(
      opts.resizers
        ? 'resize worker: the `resizers` list is empty — pass the Resizers this worker serves'
        : 'resize worker: no Resizer constructed — construct your Resizers in the worker process before starting it',
      { code: 'RESIZE_NO_RESIZER' },
    );
  }
  // Tasks are routed by name, so of two Resizers listed under one name the second would never run.
  const names = new Set<string>();
  for (const { name } of resizers) {
    if (names.has(name)) {
      throw new ResizeSetupError(
        `resize worker: the \`resizers\` list names '${name}' twice — list each Resizer once`,
        { code: 'RESIZE_DUPLICATE_RESIZER' },
      );
    }
    names.add(name);
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
    logNeverThrow(
      logger,
      'resize worker: no Resizer has a task queue (eager-only wiring)',
    );
    return;
  }
  // A task queue that can't consume this queue name (e.g. SQS without that queue URL) is skipped,
  // so one Resizer's missing queue never stops the others.
  for (const tasks of [...queues]) {
    if (tasks.servesQueue && !tasks.servesQueue(queue)) {
      queues.delete(tasks);
      logNeverThrow(
        logger,
        `resize worker: a task queue does not serve queue '${queue}' — skipping it`,
        undefined,
        'info',
      );
    }
  }
  if (queues.size === 0) {
    throw new ResizeSetupError(
      `resize worker: no task queue serves queue '${queue}'`,
      { code: 'RESIZE_QUEUE_NOT_SERVED' },
    );
  }
  // A task queue that filters claims never hands this worker an unserved Resizer's task, so it may
  // be shared. Only the others are compared; with none, no unserved Resizer's task queue is loaded.
  const unfiltered = new Set(
    [...queues].filter((tasks) => !tasks.claimFilters),
  );
  if (unfiltered.size > 0) {
    await refuseUnservedSharers(
      queue,
      unfiltered,
      registered.filter((resizer) => !resizers.includes(resizer)),
    );
  }
  // Fail before claiming anything: a bad config, queue or store (e.g. a wrong mediaModelName)
  // would otherwise surface only as per-task errors.
  for (const resizer of resizers) {
    await resizer.verify();
  }

  // Tasks and events are routed by the task's Resizer name among the served Resizers. Any other
  // name, constructed in this process or not, is not served.
  const ownerOf = (task: LeasedTask) =>
    resizers.find((r) => r.name === task.resizer);
  const notServed = (task: LeasedTask) =>
    `Resizer '${task.resizer}' is not served by this worker (pass it in runWorker({ resizers }) or construct it before the worker starts)`;
  // Every claim names these, so a task queue that filters claims hands out only their tasks.
  const served: readonly string[] = [...names];
  // The coordination of the task's Resizer: the cooldown of its dead-letter, and the lock store of
  // its gate lock. A task of a Resizer not served gets none: the default cooldown, no gate lock.
  // It must never throw, since the Consumer calls it outside its guards. A served Resizer was
  // readied at startup, so it cannot throw today; should it, the task runs with the defaults and
  // the cause is logged.
  const coordinationOf = (task: LeasedTask): TaskCoordination | undefined => {
    const owner = ownerOf(task);
    if (!owner) {
      return undefined;
    }
    try {
      return taskCoordinationOf(owner);
    } catch (err) {
      logNeverThrow(
        logger,
        `resize worker: the coordination of Resizer '${owner.name}' could not be read — task ${task.taskId} gets the default cooldown and no gate lock`,
        err,
      );
      return undefined;
    }
  };
  // Events go to the observers of the task's Resizer. A task of a Resizer not served has events
  // only when a task queue hands it out and cannot give it back, so it fails: they are logged and
  // dropped. A dead-letter's cooldown is already set: the Consumer sets it before the event fires.
  const events: TaskEventHandler = async (event, task, error) => {
    const owner = ownerOf(task);
    if (!owner) {
      logNeverThrow(
        logger,
        `resize worker: ${event} for task ${task.taskId} dropped — ${notServed(task)}`,
      );
      return;
    }
    // A served Resizer was readied at startup, so this resolves at once; it is kept so the
    // Processor is never read before ready().
    await owner.ready();
    await processorOf(owner).notify(event, task, error);
  };

  // The Consumer of one task queue. A task of a Resizer not served is never run here. A task queue
  // that filters claims does not hand one out. One that does not, with `release`, gives it back for
  // a worker that serves it (`accepts`), even when other task queue objects over the same tasks hid
  // it from the startup check. Otherwise it fails with RESIZE_NO_RESIZER, so it retries and then
  // dead-letters. Each such Resizer is logged once per task queue, not per task.
  const consumerOf = (tasks: TaskQueue): Consumer => {
    const givesBack =
      typeof tasks.release === 'function' && !tasks.claimFilters;
    const fate = givesBack
      ? 'its tasks are given back to the queue for a worker that serves it'
      : tasks.claimFilters
        ? 'this task queue handed its task out although it filters claims, so its tasks fail with RESIZE_NO_RESIZER (they retry, then dead-letter)'
        : 'this task queue cannot give tasks back, so its tasks fail with RESIZE_NO_RESIZER (they retry, then dead-letter)';
    const reported = new Set<string>();
    const report = (task: LeasedTask) => {
      if (!reported.has(task.resizer)) {
        reported.add(task.resizer);
        logNeverThrow(logger, `resize worker: ${notServed(task)} — ${fate}`);
      }
    };
    return new Consumer({
      tasks,
      // timingOf validates the queue's timing here, so invalid timing fails this loop.
      timing: timingOf(tasks),
      resizers: served,
      coordinationOf,
      accepts: givesBack
        ? (task) => {
            if (ownerOf(task)) {
              return true;
            }
            report(task);
            return false;
          }
        : undefined,
      handle: async (task, taskOpts) => {
        const owner = ownerOf(task);
        if (!owner) {
          report(task);
          throw new ResizeSetupError(`resize worker: ${notServed(task)}`, {
            code: 'RESIZE_NO_RESIZER',
          });
        }
        return runTask(owner, task, taskOpts);
      },
      events,
      logger,
    });
  };

  if (opts.sharp) {
    sharp.concurrency(opts.sharp.concurrency);
    sharp.cache(opts.sharp.cache);
  }

  // One loop per task queue, all on one stop signal. The first loop to fail is the cause; the
  // others may then reject only because of the abort. This is for a Consumer that cannot start, or
  // a loop that meets what it cannot guard (a claimed task that cannot be read). No test reaches
  // it any more: the timing is validated and cached when the Resizer starts, and the loop guards
  // its queue calls, observers and logging.
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
          await consumerOf(tasks).run(queue, stop.signal);
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
  logNeverThrow(logger, 'resize worker stopped', undefined, 'info');
}
