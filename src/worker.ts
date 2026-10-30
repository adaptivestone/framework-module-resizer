// The worker, framework-free. `runWorker()` serves a list of Resizers (default: every registered
// one) for one or more named queues: for each name it runs one Consumer, the worker loop
// (src/consumer.ts), per distinct backend that carries that name on those Resizers' task queues
// (carrierOf: on a router, the route of the name; otherwise the task queue itself), after checking
// each Resizer and each Resizer's route of each name. A Resizer's own queue is checked only when
// it is consumed, so a worker for one name starts while another name's backend cannot be used.
// Every claim names the served Resizers, so a task queue that filters claims never hands it
// another Resizer's task.
// Each task runs with the Resizer named in it and that Resizer's coordination (the cooldown of a
// dead-letter, and the lock store of the gate lock on a backend without gatesByTask), and its
// events go to that Resizer's observers. The host logger is called only through logNeverThrow, so
// a logger that throws never stops it.
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
  verifyRouteOf,
  verifyServicesOf,
} from './resizer.ts';
import { carrierOf, unavailableReason, unavailableText } from './routing.ts';
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
 * Refuse to start when a Resizer of this process that the worker does not serve carries `queue`
 * on one of `consumed`, the consumed backends that cannot filter claims: the worker would claim
 * that Resizer's tasks without running them. A backend that filters claims never hands it such a
 * task, so it may be shared and is not passed here. This is an early error only; the loop never
 * runs such a task either (see runWorker). Only the task queue part of each such Resizer is
 * loaded, so a failure of its other parts cannot hide it, and on a router its route of `queue` is
 * built, so two routers whose builders return one backend are compared too. A task queue or route
 * that cannot be loaded fails startup too, since it may be one of these. A Resizer that does not
 * carry `queue` builds nothing. Resizers constructed in other processes cannot be seen here.
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
    let carrier: TaskQueue | undefined;
    try {
      const tasks = await tasksPartOf(resizer);
      carrier = tasks && (await carrierOf(tasks, queue));
    } catch (err) {
      unknown.push(`'${resizer.name}'`);
      loadError ??= err;
      continue;
    }
    if (carrier && consumed.has(carrier)) {
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

/**
 * The backends that carry `queue` on the task queues of `served`, each once, with the task queue
 * its timing is read on (that of the first Resizer that carries it there), and the Resizers that
 * carry `queue`. A task queue that does not carry it (e.g. SQS without that queue URL) is skipped,
 * so one Resizer's missing queue never stops the others. A backend that fails to build rejects
 * with that error (logged once, naming the queue); when nothing carries the name it is
 * RESIZE_QUEUE_NOT_SERVED, with the reason a task queue keeps for that name.
 */
async function carriersOf(
  queue: string,
  served: Resizer[],
  logger: ResizeLogger,
): Promise<{ carriers: Map<TaskQueue, TaskQueue>; routing: Resizer[] }> {
  const carriers = new Map<TaskQueue, TaskQueue>();
  const routing: Resizer[] = [];
  const skipped = new Set<TaskQueue>();
  for (const resizer of served) {
    const { tasks } = resizer;
    if (!tasks) {
      continue;
    }
    let carrier: TaskQueue | undefined;
    try {
      carrier = await carrierOf(tasks, queue);
    } catch (err) {
      // The build error itself, as verify() rejects with it; the log line names the queue.
      logNeverThrow(
        logger,
        `resize worker: queue '${queue}' of Resizer '${resizer.name}': its backend could not be built`,
        err,
      );
      throw err;
    }
    if (!carrier) {
      if (!skipped.has(tasks)) {
        skipped.add(tasks);
        logNeverThrow(
          logger,
          `resize worker: a task queue does not serve queue '${queue}' — skipping it`,
          undefined,
          'info',
        );
      }
      continue;
    }
    routing.push(resizer);
    if (!carriers.has(carrier)) {
      carriers.set(carrier, tasks);
    }
  }
  if (carriers.size === 0) {
    const reason = served
      .map(({ tasks }) => (tasks ? unavailableReason(tasks, queue) : undefined))
      .find((found) => found !== undefined);
    throw new ResizeSetupError(
      `resize worker: no task queue serves queue '${queue}'${reason ? ` (${unavailableText(reason)})` : ''}`,
      reason
        ? { code: 'RESIZE_QUEUE_NOT_SERVED', cause: reason.error }
        : { code: 'RESIZE_QUEUE_NOT_SERVED' },
    );
  }
  return { carriers, routing };
}

/**
 * The queue names a worker consumes, each once, in the order given: one name or a list of them;
 * default 'default'. An empty list, or a name that is not a non-empty string, is
 * RESIZE_QUEUE_INVALID, so a typo in the list is never consumed as a name of its own.
 */
function queueNamesOf(queue: string | readonly string[] | undefined): string[] {
  const names = typeof queue === 'string' ? [queue] : (queue ?? ['default']);
  if (!Array.isArray(names) || names.length === 0) {
    throw new ResizeSetupError(
      'resize worker: `queue` must be a queue name or a non-empty list of them',
      { code: 'RESIZE_QUEUE_INVALID' },
    );
  }
  for (const name of names) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new ResizeSetupError(
        `resize worker: every queue name must be a non-empty string (got ${JSON.stringify(name)})`,
        { code: 'RESIZE_QUEUE_INVALID' },
      );
    }
  }
  return [...new Set<string>(names)];
}

export interface RunWorkerOptions {
  // The queue(s) to consume: one name or a list (a name listed twice is consumed once); default
  // 'default'. Every name must be served, else the worker does not start.
  queue?: string | readonly string[];
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
  const queues = queueNamesOf(opts.queue);
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
  if (!resizers.some((resizer) => resizer.tasks)) {
    logNeverThrow(
      logger,
      'resize worker: no Resizer has a task queue (eager-only wiring)',
    );
    return;
  }
  // Every name's backends are found before anything is claimed, so a name that nothing serves or
  // whose backend fails to build stops the start instead of being skipped.
  const lanes: Array<{
    queue: string;
    carriers: Map<TaskQueue, TaskQueue>;
    routing: Resizer[];
  }> = [];
  for (const queue of queues) {
    lanes.push({ queue, ...(await carriersOf(queue, resizers, logger)) });
  }
  // A backend that filters claims never hands this worker an unserved Resizer's task, so it may be
  // shared. Only the others are compared; with none, no unserved Resizer's task queue is loaded.
  const unserved = registered.filter((resizer) => !resizers.includes(resizer));
  for (const { queue, carriers } of lanes) {
    const unfiltered = new Set(
      [...carriers.keys()].filter((carrier) => !carrier.claimFilters),
    );
    if (unfiltered.size > 0) {
      await refuseUnservedSharers(queue, unfiltered, unserved);
    }
  }
  // Fail before claiming anything: a bad config, queue or store (e.g. a wrong mediaModelName)
  // would otherwise surface only as per-task errors. Every served Resizer is checked; each consumed
  // name is checked on each Resizer that carries it (its timing, its backend, a lock store that
  // backend needs), and no other name is. A backend or lock store that several Resizers or names
  // share is checked once.
  const verified = new Set<object>();
  for (const resizer of resizers) {
    await verifyServicesOf(resizer, verified);
  }
  for (const { queue, routing } of lanes) {
    for (const resizer of routing) {
      await verifyRouteOf(resizer, queue, verified);
    }
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

  // The Consumer of one backend for one consumed name, with that name's timing read on
  // `timingSource` (the task queue of the first served Resizer that carries the name there, as the
  // Dispatcher reads it). A task of a Resizer not served is never run here. A backend that filters
  // claims does not hand one out. One that does not, with `release`, gives it back for a worker
  // that serves it (`accepts`), even when other task queue objects over the same tasks hid it from
  // the startup check. Otherwise it fails with RESIZE_NO_RESIZER, so it retries and then dead-letters. Each
  // such Resizer is logged once per backend, not per task or name.
  const reportedOn = new Map<TaskQueue, Set<string>>();
  const consumerOf = (
    queue: string,
    tasks: TaskQueue,
    timingSource: TaskQueue,
  ): Consumer => {
    const givesBack =
      typeof tasks.release === 'function' && !tasks.claimFilters;
    const fate = givesBack
      ? 'its tasks are given back to the queue for a worker that serves it'
      : tasks.claimFilters
        ? 'this task queue handed its task out although it filters claims, so its tasks fail with RESIZE_NO_RESIZER (they retry, then dead-letter)'
        : 'this task queue cannot give tasks back, so its tasks fail with RESIZE_NO_RESIZER (they retry, then dead-letter)';
    const reported = reportedOn.get(tasks) ?? new Set<string>();
    reportedOn.set(tasks, reported);
    const report = (task: LeasedTask) => {
      if (!reported.has(task.resizer)) {
        reported.add(task.resizer);
        logNeverThrow(logger, `resize worker: ${notServed(task)} — ${fate}`);
      }
    };
    return new Consumer({
      tasks,
      // Checked at start by verifyRouteOf, so this reads the cached value.
      timing: timingOf(timingSource, queue),
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

  // One loop per backend and name, all on one stop signal. The first loop to fail is the cause;
  // the others may then reject only because of the abort. This is for a Consumer that cannot
  // start, or a loop that meets what it cannot guard (a claimed task that cannot be read). No test
  // reaches it any more: the timing is validated and cached at start, and the loop guards its
  // queue calls, observers and logging.
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  if (opts.signal.aborted) {
    stop.abort();
  }
  opts.signal.addEventListener('abort', onAbort, { once: true });
  let firstFailure: { error: unknown } | undefined;
  try {
    await Promise.allSettled(
      lanes.flatMap(({ queue, carriers }) =>
        [...carriers].map(async ([carrier, timingSource]) => {
          try {
            await consumerOf(queue, carrier, timingSource).run(
              queue,
              stop.signal,
            );
          } catch (err) {
            firstFailure ??= { error: err };
            stop.abort();
          }
        }),
      ),
    );
  } finally {
    opts.signal.removeEventListener('abort', onAbort);
  }
  if (firstFailure) {
    throw firstFailure.error;
  }
  logNeverThrow(logger, 'resize worker stopped', undefined, 'info');
}
