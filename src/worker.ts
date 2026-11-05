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
// events go to that Resizer's observers; its claim wait and outcome go to that Resizer's metrics
// sink, and each served sink is flushed once when the worker stops. The host logger is called only
// through logNeverThrow, so a logger that throws never stops it.
// The work itself is the Resizer's Processor (src/processor.ts).
// Framework hosts start it through `runResizeWorker()` (src/framework/worker.ts), which adds the
// `worker.enabled` switch, process signals and the app logger.
// `prepareServing()` is everything before the loops, with two users: `runWorker()`, which claims
// its tasks, and `createSqsHandler()` (src/lambda.ts), whose tasks are pushed to it.
import { inspect } from 'node:util';
import sharp from 'sharp';
import { Consumer, type ConsumerDeps } from './consumer.ts';
import type {
  LeasedTask,
  TaskEventHandler,
  TaskQueue,
} from './contracts/taskQueue.ts';
import type { TaskCoordination } from './coordination.ts';
import { ResizeSetupError } from './errors.ts';
import { logNeverThrow } from './helpers/log.ts';
import type { ProcessTaskResult } from './processor.ts';
import {
  getResizer,
  listResizers,
  metricsOf,
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
): Promise<ProcessTaskResult> {
  return runTask(getResizer(task.resizer), task, taskOpts);
}

/** Run one task with `resizer`, once its parts and services are ready. */
async function runTask(
  resizer: Resizer,
  task: LeasedTask,
  taskOpts: { signal: AbortSignal } | undefined,
): Promise<ProcessTaskResult> {
  await resizer.ready();
  return processorOf(resizer).processTask(task, taskOpts);
}

// Who a message of the serving speaks for. A worker's text is what its host's alerts match, and a
// Lambda host has no worker to be told about. The lines of a running task (src/consumer.ts,
// src/processor.ts) say `resize worker:` for both: the Consumer does not change for push delivery.
interface Voice {
  tag: string; // what a message starts with
  self: string; // what a message calls the process
  // What would happen to the tasks of a Resizer it does not serve, on a task queue it consumes.
  unserved: string;
}
const WORKER_VOICE: Voice = {
  tag: 'resize worker',
  self: 'worker',
  unserved: 'the worker would claim their tasks without running them',
};
const HANDLER_VOICE: Voice = {
  tag: 'resize lambda',
  self: 'handler',
  unserved: 'their messages would reach this handler, which cannot run them',
};
const voiceOf = (pushed: boolean | undefined): Voice =>
  pushed ? HANDLER_VOICE : WORKER_VOICE;

/**
 * Refuse to start when a Resizer of this process that the worker does not serve carries `queue`
 * on one of `consumed`, the consumed backends that cannot filter claims: the worker would claim
 * that Resizer's tasks without running them. A backend that filters claims never hands it such a
 * task, so it may be shared and is not passed here. This is an early error only; the loop never
 * runs such a task either (see depsOf). Only the task queue part of each such Resizer is
 * loaded, so a failure of its other parts cannot hide it, and on a router its route of `queue` is
 * built, so two routers whose builders return one backend are compared too. A task queue or route
 * that cannot be loaded fails startup too, since it may be one of these. A Resizer that does not
 * carry `queue` builds nothing. Resizers constructed in other processes cannot be seen here.
 */
async function refuseUnservedSharers(
  queue: string,
  consumed: Set<TaskQueue>,
  unserved: Resizer[],
  voice: Voice,
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
      `Resizer(s) ${sharing.join(', ')} share a task queue this ${voice.self} consumes for queue '${queue}' but are not in the \`resizers\` list — ${voice.unserved}; list them too, or give them their own task queue`,
    );
  }
  if (unknown.length > 0) {
    problems.push(
      `the task queue of Resizer(s) ${unknown.join(', ')} failed to load, so whether it is one this ${voice.self} consumes for queue '${queue}' could not be determined — fix that task queue (the load error is the cause)`,
    );
  }
  if (problems.length > 0) {
    throw new ResizeSetupError(`${voice.tag}: ${problems.join('; ')}`, {
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
  voice: Voice,
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
        `${voice.tag}: queue '${queue}' of Resizer '${resizer.name}': its backend could not be built`,
        err,
      );
      throw err;
    }
    if (!carrier) {
      if (!skipped.has(tasks)) {
        skipped.add(tasks);
        logNeverThrow(
          logger,
          `${voice.tag}: a task queue does not serve queue '${queue}' — skipping it`,
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
      `${voice.tag}: no task queue serves queue '${queue}'${reason ? ` (${unavailableText(reason)})` : ''}`,
      reason
        ? { code: 'RESIZE_QUEUE_NOT_SERVED', cause: reason.error }
        : { code: 'RESIZE_QUEUE_NOT_SERVED' },
    );
  }
  return { carriers, routing };
}

/**
 * The queue names a worker, or with `pushed` a Lambda handler, consumes, each once, in the order
 * given: one name or a list of them; default 'default'. An empty list, or a name that is not a
 * non-empty string, is RESIZE_QUEUE_INVALID, so a typo in the list is never consumed as a name of
 * its own. The message shows the value (see shownValue).
 */
export function queueNamesOf(
  queue: string | readonly string[] | undefined,
  pushed?: boolean,
): string[] {
  const { tag } = voiceOf(pushed);
  const names = typeof queue === 'string' ? [queue] : (queue ?? ['default']);
  if (!Array.isArray(names) || names.length === 0) {
    throw new ResizeSetupError(
      `${tag}: \`queue\` must be a queue name or a non-empty list of them`,
      { code: 'RESIZE_QUEUE_INVALID' },
    );
  }
  for (const name of names) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new ResizeSetupError(
        `${tag}: every queue name must be a non-empty string (got ${shownValue(name)})`,
        { code: 'RESIZE_QUEUE_INVALID' },
      );
    }
  }
  return [...new Set<string>(names)];
}

/**
 * A host value as an error message shows it, never throwing: inspect() without the value's own
 * inspector (JSON.stringify throws on a bigint, a host inspector may throw), else its type.
 */
export function shownValue(value: unknown): string {
  try {
    return inspect(value, { customInspect: false });
  } catch {
    return `a value of type ${typeof value}`;
  }
}

// The longest the stop waits for one metrics sink's flush(): a sink that hangs must not keep the
// worker from returning.
const METRICS_FLUSH_TIMEOUT_MS = 5_000;

/**
 * Flush the metrics of `resizers` once per distinct sink (Resizers given one sink share it), each
 * waited for until it settles or `waitMs` has passed, at most METRICS_FLUSH_TIMEOUT_MS. Never
 * rejects: the bound sink logs a failing flush.
 */
export async function flushMetrics(
  resizers: readonly Resizer[],
  waitMs = METRICS_FLUSH_TIMEOUT_MS,
): Promise<void> {
  const wait = Math.min(Math.max(0, waitMs), METRICS_FLUSH_TIMEOUT_MS);
  const seen = new Set<object>();
  const flushes: Promise<void>[] = [];
  for (const resizer of resizers) {
    if (seen.has(resizer.metrics)) {
      continue;
    }
    seen.add(resizer.metrics);
    flushes.push(
      withinFlushTimeout(Promise.resolve(metricsOf(resizer).flush()), wait),
    );
  }
  await Promise.all(flushes);
}

/**
 * `flush`, or `waitMs`, whichever comes first. The stop awaits this wait, so its timer stays ref'd,
 * as the Consumer's awaited waits do: the process lives until the flush settles or the bound ends,
 * and the timer is cleared as soon as the flush settles.
 */
async function withinFlushTimeout(
  flush: Promise<void>,
  waitMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
  });
  try {
    await Promise.race([flush, late]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ServingOptions {
  // The queue(s) to consume: one name or a list (a name listed twice is consumed once); default
  // 'default'. Every name must be served, else this rejects.
  queue?: string | readonly string[];
  logger?: ResizeLogger; // default console
  // Process-wide Sharp tuning, applied once the checks have passed. Omitted: left as it is.
  sharp?: { concurrency: number; cache: boolean };
  // The Resizers to serve; default: every Resizer registered at this call (see RunWorkerOptions).
  resizers?: readonly Resizer[];
  pushed?: boolean; // tasks arrive by push: nothing can be given back to another consumer
}

// One consumed queue name, with what carries it.
export interface ServedLane {
  queue: string;
  carriers: Map<TaskQueue, TaskQueue>; // backend → the task queue its timing is read on
  routing: Resizer[]; // the served Resizers that carry this name
}

// What a process needs to run tasks of the served Resizers, checked and ready.
export interface Serving {
  queues: readonly string[];
  resizers: readonly Resizer[];
  lanes: readonly ServedLane[];
  logger: ResizeLogger;
  // The served Resizer a task names; undefined when it names any other.
  ownerOf(task: LeasedTask): Resizer | undefined;
  // What the Consumer of one backend for one consumed name is built from.
  depsOf(
    queue: string,
    tasks: TaskQueue,
    timingSource: TaskQueue,
  ): ConsumerDeps;
}

/**
 * Everything that comes before serving a task: the served Resizers, the backends of every consumed
 * name, the start checks and the Sharp tuning. Rejects when a check fails, before anything is
 * claimed. Resolves undefined when no Resizer has a task queue, so there is nothing to consume (an
 * `error` line says so). It writes no start line: that one is the worker process's. Internal: the
 * main entry does not export it, and it may change in any release.
 */
export async function prepareServing(
  opts: ServingOptions,
): Promise<Serving | undefined> {
  const queues = queueNamesOf(opts.queue, opts.pushed);
  const voice = voiceOf(opts.pushed);
  const logger = opts.logger ?? console;
  // The served Resizers, taken once now, so one constructed later is not served (and neither is
  // it compared below); a Resizer listed twice is served once.
  const registered = listResizers();
  const resizers = [...new Set(opts.resizers ?? registered)];
  if (resizers.length === 0) {
    throw new ResizeSetupError(
      opts.resizers
        ? `${voice.tag}: the \`resizers\` list is empty — pass the Resizers this ${voice.self} serves`
        : opts.pushed
          ? "resize lambda: no Resizer constructed — import the file that constructs your Resizers in the handler's file, before the first invocation"
          : 'resize worker: no Resizer constructed — construct your Resizers in the worker process before starting it',
      { code: 'RESIZE_NO_RESIZER' },
    );
  }
  // Tasks are routed by name, so of two Resizers listed under one name the second would never run.
  const names = new Set<string>();
  for (const { name } of resizers) {
    if (names.has(name)) {
      throw new ResizeSetupError(
        `${voice.tag}: the \`resizers\` list names '${name}' twice — list each Resizer once`,
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
      `${voice.tag}: no Resizer has a task queue (eager-only wiring)`,
    );
    return undefined;
  }
  // Every name's backends are found before anything is claimed, so a name that nothing serves or
  // whose backend fails to build stops the start instead of being skipped.
  const lanes: ServedLane[] = [];
  for (const queue of queues) {
    lanes.push({
      queue,
      ...(await carriersOf(queue, resizers, logger, voice)),
    });
  }
  // A backend that filters claims never hands this worker an unserved Resizer's task, so it may be
  // shared. Only the others are compared; with none, no unserved Resizer's task queue is loaded.
  const unserved = registered.filter((resizer) => !resizers.includes(resizer));
  for (const { queue, carriers } of lanes) {
    const unfiltered = new Set(
      [...carriers.keys()].filter((carrier) => !carrier.claimFilters),
    );
    if (unfiltered.size > 0) {
      await refuseUnservedSharers(queue, unfiltered, unserved, voice);
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
    opts.pushed
      ? `Resizer '${task.resizer}' is not served by this handler (pass it in createSqsHandler({ resizers }) or construct it before the first invocation)`
      : `Resizer '${task.resizer}' is not served by this worker (pass it in runWorker({ resizers }) or construct it before the worker starts)`;
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
        `${voice.tag}: the coordination of Resizer '${owner.name}' could not be read — task ${task.taskId} gets the default cooldown and no gate lock`,
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
        `${voice.tag}: ${event} for task ${task.taskId} dropped — ${notServed(task)}`,
      );
      return;
    }
    // A served Resizer was readied at startup, so this resolves at once; it is kept so the
    // Processor is never read before ready().
    await owner.ready();
    await processorOf(owner).notify(event, task, error);
  };

  // What the Consumer of one backend for one consumed name is built from, with that name's timing
  // read on `timingSource` (the task queue of the first served Resizer that carries the name there,
  // as the Dispatcher reads it). A task of a Resizer not served is never run here. A backend that
  // filters claims does not hand one out. One that does not, with `release`, gives it back for a
  // worker that serves it (`accepts`), even when other task queue objects over the same tasks hid it
  // from the startup check; a pushed message has no such worker to go to. Otherwise it fails with
  // RESIZE_NO_RESIZER, so it retries and then dead-letters. Each such Resizer is logged once per
  // backend, not per task or name.
  const reportedOn = new Map<TaskQueue, Set<string>>();
  const depsOf = (
    queue: string,
    tasks: TaskQueue,
    timingSource: TaskQueue,
  ): ConsumerDeps => {
    const givesBack =
      !opts.pushed &&
      typeof tasks.release === 'function' &&
      !tasks.claimFilters;
    const fate = opts.pushed
      ? 'a pushed message cannot go to another consumer, so its tasks fail with RESIZE_NO_RESIZER (they retry, then dead-letter)'
      : givesBack
        ? 'its tasks are given back to the queue for a worker that serves it'
        : tasks.claimFilters
          ? 'this task queue handed its task out although it filters claims, so its tasks fail with RESIZE_NO_RESIZER (they retry, then dead-letter)'
          : 'this task queue cannot give tasks back, so its tasks fail with RESIZE_NO_RESIZER (they retry, then dead-letter)';
    const reported = reportedOn.get(tasks) ?? new Set<string>();
    reportedOn.set(tasks, reported);
    const report = (task: LeasedTask) => {
      if (!reported.has(task.resizer)) {
        reported.add(task.resizer);
        logNeverThrow(logger, `${voice.tag}: ${notServed(task)} — ${fate}`);
      }
    };
    return {
      tasks,
      // Checked at start by verifyRouteOf, so this reads the cached value.
      timing: timingOf(timingSource, queue),
      resizers: served,
      coordinationOf,
      // A task of a Resizer not served records nothing.
      metricsOf: (task) => {
        const owner = ownerOf(task);
        return owner ? metricsOf(owner) : undefined;
      },
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
          throw new ResizeSetupError(`${voice.tag}: ${notServed(task)}`, {
            code: 'RESIZE_NO_RESIZER',
          });
        }
        return runTask(owner, task, taskOpts);
      },
      events,
      logger,
    };
  };

  if (opts.sharp) {
    sharp.concurrency(opts.sharp.concurrency);
    sharp.cache(opts.sharp.cache);
  }

  return { queues, resizers, lanes, logger, ownerOf, depsOf };
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

/**
 * Serve the queues until `opts.signal` aborts. Resolves true after a run, and false when no Resizer
 * has a task queue, so the process consumes nothing (an `error` line says so).
 */
export async function runWorker(opts: RunWorkerOptions): Promise<boolean> {
  // `pushed` is no option of this function: a JavaScript caller cannot switch a worker to it.
  const serving = await prepareServing({ ...opts, pushed: false });
  if (!serving) {
    return false;
  }
  const { lanes, logger, queues, resizers } = serving;

  const quoted = (list: Iterable<string>) =>
    [...list].map((n) => `'${n}'`).join(', ');
  logNeverThrow(
    logger,
    `resize worker started: queues ${quoted(queues)}; Resizers ${quoted(resizers.map(({ name }) => name))}`,
    undefined,
    'info',
  );

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
            await new Consumer(
              serving.depsOf(queue, carrier, timingSource),
            ).run(queue, stop.signal);
          } catch (err) {
            firstFailure ??= { error: err };
            stop.abort();
          }
        }),
      ),
    );
  } finally {
    opts.signal.removeEventListener('abort', onAbort);
    // What the sinks still hold (LogMetrics: the open summary window) is written before the worker
    // returns, as a process often exits right after.
    await flushMetrics(resizers);
  }
  if (firstFailure) {
    throw firstFailure.error;
  }
  logNeverThrow(logger, 'resize worker stopped', undefined, 'info');
  return true;
}
