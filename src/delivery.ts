// Push delivery: a batch of SQS records handed to the process, each run through the real worker
// loop (src/consumer.ts), unchanged. A one-shot task queue over the real one gives a Consumer the
// delivered task once and then ends its run, so its retries, dead-letters, gate lock, observers and
// metrics are the worker's own. A record that must stay in the queue is listed in
// `batchItemFailures`, never thrown: Lambda then retries only those. A record that cannot be
// delivered is listed alone, with a line, and its neighbours run. Only an event that is no SQS batch
// (no Records array, a bad context, a record with no messageId to list it by), and checks that
// reject, throw. The host logger is called only through logNeverThrow.
//
// The time rules. A Lambda function is killed at its timeout, and rows persist once at the end of a
// task, so a task is stopped while there is time left to store what it finished: its budget is the
// time left minus a reserve, and it runs under that budget as its taskTimeoutMs. The handler waits
// for it until the margin before the deadline, then lists it and returns, whatever async work is
// still running (code that blocks the event loop holds these timers too, and can pass the deadline).
// The Consumer needs no change for this, since the handler races its run from outside. What runs on
// past the return goes on detached, and only if the environment is reused: the process freezes at
// the return and thaws at the next invocation, so a variant in flight can still store its row then.
// Its media writes are not fenced, as with a pull worker's timed-out delivery, and the next read
// judges that row as any other: a row from an older original is stale and is queued again. A record
// with too little time is not started and gets no visibility call, so it comes back only after the
// queue's visibility timeout: the queue can drain first, and an alarm has time to fire.
//
// Internal, and it may change in any release, apart from the event and handler types that
// src/lambda.ts re-exports: `createSqsHandler()` there is the public way in.
import { Consumer, type ConsumerDeps } from './consumer.ts';
import type { DeliveryQueue } from './contracts/delivery.ts';
import {
  type ClaimedTask,
  type FailOptions,
  type LeasedTask,
  type TaskAddResult,
  TaskQueue,
} from './contracts/taskQueue.ts';
import { ResizeSetupError } from './errors.ts';
import { logNeverThrow } from './helpers/log.ts';
import { carrierOf } from './routing.ts';
import type { ResizeLogger } from './types.d.ts';
import {
  flushMetrics,
  prepareServing,
  type ServedLane,
  type ServingOptions,
} from './worker.ts';

export interface SqsRecordLike {
  messageId: string;
  receiptHandle: string;
  body: string;
  // Optional in the type so that a hand-built event gets its answer from the handler, which lists a
  // record without a count and names it.
  attributes?: { ApproximateReceiveCount?: string };
  eventSourceARN?: string;
}
export interface SqsEventLike {
  Records: readonly SqsRecordLike[];
}
export interface LambdaContextLike {
  getRemainingTimeInMillis(): number;
}
export interface SqsBatchResponse {
  batchItemFailures: { itemIdentifier: string }[];
}
export type SqsHandler = (
  event: SqsEventLike,
  context: LambdaContextLike,
) => Promise<SqsBatchResponse>;

// One consumed queue name on one backend.
export interface DeliveryLane {
  queue: string;
  carrier: TaskQueue & DeliveryQueue;
  deps: ConsumerDeps; // its `accepts` is undefined, and `tasks` and `timing` are replaced per delivery
}

export interface DeliveryWiring {
  lanes: readonly DeliveryLane[];
  // limits.processingTimeoutSeconds of the task's Resizer; undefined for a Resizer not served.
  processingSecondsOf(task: LeasedTask): number | undefined;
  flush(waitMs: number): Promise<void>; // never rejects
  logger: ResizeLogger;
}

// The handler returns this long before the function timeout: the end of the handler, the response
// and the flush need that much. It doubles as the least budget, since a task given less could not
// finish anything that is worth a receive.
export const SETTLE_MARGIN_MS = 2_000;

export interface BatchOptions {
  stopBeforeTimeoutMs?: number; // the reserve; default defaultReserveMs per record
  settleMarginMs: number; // the handler returns this long before the deadline; also the least budget
  logger?: ResizeLogger; // for the one line written before the wiring exists; default console
}

/**
 * The time kept back from a task when the host sets none: its Sharp work can run on for
 * `processingSeconds` after the stop, and the 5 s are for its uploads, the persist and the queue
 * calls. Never above half the time left, so a short function still gets half of it for the task.
 */
export function defaultReserveMs(
  remainingMs: number,
  processingSeconds: number,
): number {
  return Math.min(processingSeconds * 1000 + 5000, Math.floor(remainingMs / 2));
}

// How a delivery ended. Only 'completed', 'dead' and 'discarded' took the message out of the queue.
type DeliveryEnd =
  | 'completed'
  | 'dead'
  | 'retry'
  | 'given-back'
  | 'lease-lost'
  | 'left'
  | 'discarded';

/**
 * Whether `promise` settled within `ms`, rethrowing its rejection. An answer already there wins, as
 * the timer fires a turn later at the earliest. A promise that loses is left running, and a later
 * rejection of it is handled here.
 */
async function settledWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms));
  });
  try {
    return await Promise.race([promise.then(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

// A message's receive count as SQS reports it: a whole number from 1, in text. Anything else reads
// as NaN, as 0, or as the same 1 on every delivery, so a failing task never reaches maxAttempts and
// loops until the queue's redrive policy takes it.
const RECEIVE_COUNT = /^[1-9]\d*$/;

const filled = (value: unknown): boolean =>
  typeof value === 'string' && value !== '';

/**
 * Throw unless every record can be answered: the response names a record by its messageId, and
 * Lambda reads an empty one as a failure of the whole batch.
 */
function checkEvent(event: SqsEventLike, context: LambdaContextLike): void {
  if (
    !Array.isArray(event?.Records) ||
    !event.Records.every((record) => filled(record?.messageId)) ||
    typeof context?.getRemainingTimeInMillis !== 'function'
  ) {
    throw new ResizeSetupError(
      "resize lambda: the event is not an SQS batch: it needs a Records array whose records each have a messageId, and a context with getRemainingTimeInMillis() — check the function's trigger",
      { code: 'RESIZE_SQS_EVENT_INVALID', retryable: false },
    );
  }
}

/**
 * What keeps a record from being delivered, for its line. Such a record is listed alone: a throw
 * would cost its neighbours a receive each time, and past maxAttempts they would die unrun.
 */
function flawOf(record: SqsRecordLike): string | undefined {
  if (!filled(record.receiptHandle)) {
    return 'no usable receiptHandle';
  }
  if (typeof record.body !== 'string') {
    return 'no string body';
  }
  const count = record.attributes?.ApproximateReceiveCount;
  if (typeof count !== 'string' || !RECEIVE_COUNT.test(count)) {
    return 'no attributes.ApproximateReceiveCount that holds a whole number from 1, as SQS reports it: its deliveries could not be counted, so a failing task would never be dead-lettered';
  }
  return undefined;
}

/**
 * The queue a Consumer sees for one delivered task: the first claim hands it out and the second
 * ends the run, and the rest goes to the real queue. `end` is what the queue last took; a call that
 * throws leaves it, and a falsy answer means the lease was lost. It forwards no optional flags, as
 * a DeliveryQueue has no `gatesByTask`. A task that must not `start` is handed out with the run
 * already stopped, so the Consumer dead-letters it past maxAttempts or else gives it back, with its
 * gate held, and never runs it. That give-back makes no queue call: see `release`.
 */
class OneShotQueue extends TaskQueue {
  end: DeliveryEnd = 'left';
  readonly #carrier: TaskQueue & DeliveryQueue;
  readonly #task: ClaimedTask;
  readonly #stop: AbortController;
  readonly #start: boolean;
  #claimed = false;

  constructor(
    carrier: TaskQueue & DeliveryQueue,
    task: ClaimedTask,
    stop: AbortController,
    start: boolean,
  ) {
    super();
    this.#carrier = carrier;
    this.#task = task;
    this.#stop = stop;
    this.#start = start;
  }

  add(): Promise<TaskAddResult> {
    throw new ResizeSetupError(
      'resize lambda: a delivered task queue adds nothing',
    );
  }

  async claim(): Promise<ClaimedTask | null> {
    if (this.#claimed) {
      this.#stop.abort();
      return null;
    }
    this.#claimed = true;
    if (!this.#start) {
      this.#stop.abort();
    }
    return this.#task;
  }

  renew(task: ClaimedTask, leaseMs: number): Promise<boolean> {
    return this.#carrier.renew(task, leaseMs);
  }

  async complete(task: ClaimedTask): Promise<boolean> {
    const held = await this.#carrier.complete(task);
    this.end = held ? 'completed' : 'lease-lost';
    return held;
  }

  async fail(
    task: ClaimedTask,
    next: { retryAt: Date } | 'dead',
    error: string,
    opts?: FailOptions,
  ): Promise<boolean> {
    const held = await this.#carrier.fail(task, next, error, opts);
    if (!held) {
      this.end = 'lease-lost';
    } else {
      this.end = next === 'dead' ? 'dead' : 'retry';
    }
    return held;
  }

  async release(task: ClaimedTask): Promise<boolean> {
    // A record not started stays as it is: visibility 0 would let a function that is too short use
    // up a task's receives in seconds, and a tail record take its receives from a queue with work
    // left. `false`, as nothing was given back, also keeps the Consumer from saying it is back.
    if (!this.#start) {
      return false;
    }
    const held = await this.#carrier.release(task);
    this.end = held ? 'given-back' : 'lease-lost';
    return held;
  }
}

/** The lane a record came from: by its event source, or the only one when it names none. */
function laneOf(
  lanes: readonly DeliveryLane[],
  source: string | undefined,
): DeliveryLane | undefined {
  if (!source) {
    return lanes.length === 1 ? lanes[0] : undefined;
  }
  return lanes.find(({ carrier, queue }) =>
    carrier.carriesSource(queue, source),
  );
}

/**
 * Set a delivered message's visibility to the lease, as a pull receive does, so a crash costs one
 * lease and not the queue's whole visibility timeout. Resolves false when the receipt is lost. A
 * failure of any other kind goes to `onFailure`, and the task runs all the same.
 */
async function adopt(
  lane: DeliveryLane,
  task: ClaimedTask,
  onFailure: (err: unknown) => void,
): Promise<boolean> {
  try {
    return await lane.carrier.renew(task, lane.deps.timing.leaseMs);
  } catch (err) {
    onFailure(err);
    return true;
  }
}

// What one invocation knows as it goes through its records.
interface Invocation {
  wired: DeliveryWiring;
  left: () => number; // the time left, as Lambda reports it
  margin: number;
  stopBeforeTimeoutMs: number | undefined;
  // A settle wait ran out, so a later record of the batch makes no queue call, even when a timer
  // fired a millisecond early and leaves it a little time on paper.
  expired: boolean;
  longest: number; // the longest delivery so far that ended by itself, in ms
  enteredWithMs: number; // the time left when the handler was entered
  onAdoptionFailure: (id: string, err: unknown) => void;
}

/**
 * The record gets no task run, so the time it was given goes in a line. `willDie`: it is past
 * maxAttempts, so the Consumer dead-letters it unrun rather than leaving it for a retry.
 */
function logNotStarted(
  { wired: { logger }, left, enteredWithMs, stopBeforeTimeoutMs }: Invocation,
  id: string,
  index: number,
  budget: number,
  needed: number,
  willDie = false,
): void {
  const time = `${left()} ms left and ${budget} ms of that for the task, at least ${Math.ceil(needed)} ms needed`;
  const dying = 'it is past maxAttempts, so it is dead-lettered unrun';
  const retry =
    "after the queue's visibility timeout, and this delivery counts as an attempt";
  if (index === 0) {
    // Nothing ran before it, so `needed` is the margin: a default reserve, which is over that and
    // never above half the time left, then needs twice it left. What is already spent comes on top.
    const leftToStart =
      stopBeforeTimeoutMs === undefined
        ? needed * 2
        : needed + stopBeforeTimeoutMs;
    const spent = enteredWithMs - left();
    logNeverThrow(
      logger,
      `resize lambda: message ${id}, the first record of this invocation, was not started: ${time} — the function timeout is too small for this reserve; raise it to at least ${Math.ceil((spent + leftToStart) / 1000)} s. ${willDie ? `And ${dying}` : `It is listed for a retry ${retry}`}`,
    );
    return;
  }
  logNeverThrow(
    logger,
    `resize lambda: message ${id} was not started: ${time} — ${willDie ? dying : `it is listed for a retry ${retry}`}; a batch size of 1 avoids this`,
    undefined,
    'warn',
  );
}

/** The settle wait ran out on `what`: no later record of this batch makes a queue call. */
function settleLate(run: Invocation, what: string): void {
  run.expired = true;
  logNeverThrow(
    run.wired.logger,
    `resize lambda: ${what} had not settled ${run.margin} ms before the function timeout — the handler returns, and what still runs goes on detached; raise stopBeforeTimeoutMs or the function timeout if this repeats`,
    undefined,
    'warn',
  );
}

/** Run one record through a Consumer, within the time left. A throw here is the caller's to log. */
async function deliver(
  record: SqsRecordLike,
  index: number,
  run: Invocation,
): Promise<DeliveryEnd> {
  const startedAt = performance.now();
  const { messageId: id, receiptHandle: receipt, body } = record;
  const { wired, left, margin } = run;
  const { logger } = wired;
  const flaw = flawOf(record);
  if (flaw) {
    logNeverThrow(
      logger,
      `resize lambda: message ${id} has ${flaw} — it stays in the queue, and the records beside it run; check the function's trigger`,
    );
    return 'left';
  }
  const source = record.eventSourceARN;
  const lane = laneOf(wired.lanes, source);
  if (!lane) {
    const names = wired.lanes.map(({ queue }) => queue).join(', ');
    logNeverThrow(
      logger,
      `resize lambda: message ${id} came from ${source || 'no event source'}, which no consumed queue (${names}) matches — it stays in the queue; check the \`queue\` option of createSqsHandler and the queue's URL`,
    );
    return 'left';
  }
  if (run.expired || left() <= margin) {
    logNotStarted(run, id, index, 0, margin);
    return 'left';
  }
  const receiveCount = record.attributes?.ApproximateReceiveCount;
  const reading = lane.carrier.taskOfDelivery(
    { id, receipt, body, receiveCount },
    lane.queue,
  );
  if (!(await settledWithin(reading, left() - margin))) {
    settleLate(run, `reading message ${id}`);
    return 'left';
  }
  const task = await reading;
  if (typeof task === 'string') {
    return task;
  }
  const reserve =
    run.stopBeforeTimeoutMs ??
    defaultReserveMs(left(), wired.processingSecondsOf(task) ?? 0);
  const needed = Math.max(margin, run.longest);
  const budget = () => left() - reserve;
  // A record that will not start is not adopted, and an adoption's time comes out of the budget, not
  // out of the reserve, as the budget is read again after it.
  if (budget() >= needed) {
    const adoption = adopt(lane, task, (err) => run.onAdoptionFailure(id, err));
    if (!(await settledWithin(adoption, left() - margin))) {
      // No Consumer ran, so no later dead-letter line follows: this is the only report.
      run.expired = true;
      logNeverThrow(
        logger,
        `resize lambda: setting the visibility of message ${id} had not answered ${margin} ms before the function timeout, so no task ran — does the function have a route to SQS? In a VPC it needs a NAT gateway or an SQS endpoint`,
      );
      return 'left';
    }
    if (!(await adoption)) {
      logNeverThrow(
        logger,
        `resize lambda: message ${id} lost its receipt before it started — left to its next delivery`,
        undefined,
        'warn',
      );
      return 'lease-lost';
    }
  }
  const start = budget() >= needed;
  if (!start) {
    logNotStarted(
      run,
      id,
      index,
      Math.max(0, budget()),
      needed,
      task.attempts > lane.deps.timing.maxAttempts,
    );
  }
  const stop = new AbortController();
  const once = new OneShotQueue(lane.carrier, task, stop, start);
  // What the Consumer's wait for the handler leaves behind (a timeout). The settle wait below covers
  // it, so it has settled before this returns, unless that wait runs out.
  let settled: Promise<unknown> = Promise.resolve();
  // Only a delivery that ended by itself says what a task takes. One the stop ended says what it was
  // given, and counting that would let one hung head refuse every record after it.
  let endedByItself = false;
  const consumer = new Consumer({
    ...lane.deps,
    tasks: once,
    // The stop lands when the budget ends. A task that does not start has only its observers left,
    // on a dead-letter, and a budget under zero would cut those off at once: the settle wait bounds
    // them instead.
    timing: start
      ? {
          ...lane.deps.timing,
          taskTimeoutMs: Math.min(lane.deps.timing.taskTimeoutMs, budget()),
        }
      : lane.deps.timing,
    handle: (leased, opts) => {
      const running = lane.deps.handle(leased, opts);
      const ended = () => {
        endedByItself = !opts.signal.aborted;
      };
      settled = running.then(ended, ended);
      return running;
    },
  });
  const finished = consumer
    .run(lane.queue, stop.signal)
    .then(() => settled)
    .catch((err) => {
      logNeverThrow(
        logger,
        `resize lambda: the delivery of task ${task.taskId} ended with an error`,
        err,
      );
    });
  if (!(await settledWithin(finished, left() - margin))) {
    settleLate(run, `task ${task.taskId}`);
  }
  if (endedByItself) {
    run.longest = Math.max(run.longest, performance.now() - startedAt);
  }
  // Read after the wait: a `fail` still pending leaves 'left', and a `complete` the queue took stays
  // 'completed', however long an observer then takes.
  return once.end;
}

/**
 * The handler of an SQS trigger: checks the event, runs `wiring` once (it runs again after it
 * rejected, which throws from the invocation and touches no record, and it is waited for until the
 * margin at most), then delivers the records in order and lists those that stay in the queue.
 */
export function batchHandler(
  wiring: () => Promise<DeliveryWiring>,
  opts: BatchOptions,
): SqsHandler {
  const { settleMarginMs: margin, stopBeforeTimeoutMs } = opts;
  let ready: Promise<DeliveryWiring> | undefined;
  let missed = 0; // the invocations that `ready` did not settle within
  // A role without the permission fails every adoption, and one line says what is wrong.
  let adoptionFailureLogged = false;
  return async (event, context) => {
    checkEvent(event, context);
    const left = () => context.getRemainingTimeInMillis();
    const enteredWithMs = left();
    if (!ready) {
      missed = 0;
      const built: Promise<DeliveryWiring> = wiring().catch((err) => {
        // Checks dropped below can reject long after newer ones were built.
        if (ready === built) {
          ready = undefined;
        }
        throw err;
      });
      ready = built;
    }
    const checks = ready;
    if (!(await settledWithin(checks, left() - margin))) {
      // The handler returns normally, so Lambda keeps this environment: checks that never settle
      // would list every record for its whole life, using receives until redrive moves them.
      missed += 1;
      const again = missed >= 2;
      if (again) {
        ready = undefined;
      }
      // The wiring's logger does not exist yet.
      logNeverThrow(
        opts.logger ?? console,
        `resize lambda: the start checks had not finished ${margin} ms before the function timeout — every record is listed for a retry; check the connection settings (a Mongo serverSelectionTimeoutMS longer than the function timeout, say)${again ? '; they start again on the next invocation' : ''}`,
      );
      return {
        batchItemFailures: event.Records.map(({ messageId }) => ({
          itemIdentifier: messageId,
        })),
      };
    }
    const wired = await checks;
    const run: Invocation = {
      wired,
      left,
      margin,
      stopBeforeTimeoutMs,
      expired: false,
      longest: 0,
      enteredWithMs,
      onAdoptionFailure: (id, err) => {
        if (adoptionFailureLogged) {
          return;
        }
        adoptionFailureLogged = true;
        logNeverThrow(
          wired.logger,
          `resize lambda: setting the visibility of message ${id} failed — the task runs, but a crash would hide the message for the queue's whole visibility timeout; does the role allow sqs:ChangeMessageVisibility?`,
          err,
        );
      },
    };
    const batchItemFailures: SqsBatchResponse['batchItemFailures'] = [];
    for (const [index, record] of event.Records.entries()) {
      let end: DeliveryEnd = 'left';
      try {
        end = await deliver(record, index, run);
      } catch (err) {
        logNeverThrow(
          wired.logger,
          `resize lambda: delivering message ${record.messageId} failed — it stays in the queue`,
          err,
        );
      }
      if (end !== 'completed' && end !== 'dead' && end !== 'discarded') {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    await wired.flush(Math.max(0, left() - margin / 2));
    return { batchItemFailures };
  };
}

// Whether a task queue can take pushed messages. By shape, as core may not import a driver.
function isDeliveryQueue(queue: TaskQueue): queue is TaskQueue & DeliveryQueue {
  const { carriesSource, taskOfDelivery, release } =
    queue as Partial<DeliveryQueue>;
  return (
    typeof carriesSource === 'function' &&
    typeof taskOfDelivery === 'function' &&
    typeof release === 'function' &&
    !queue.gatesByTask
  );
}

/**
 * The refusal of a consumed name that cannot take pushes. When other Resizers on that name can,
 * leaving the name out would drop them too, so the fix keeps those.
 */
async function notPushable(
  queue: string,
  routing: ServedLane['routing'],
): Promise<ResizeSetupError> {
  const can: string[] = [];
  const cannot: string[] = [];
  for (const { name, tasks } of routing) {
    const carrier = tasks && (await carrierOf(tasks, queue));
    (carrier && isDeliveryQueue(carrier) ? can : cannot).push(name);
  }
  const names = cannot.map((name) => `'${name}'`).join(', ');
  const who =
    cannot.length === 1 ? `Resizer ${names} is` : `Resizers ${names} are`;
  const kept = can.map((name) => `getResizer('${name}')`).join(', ');
  const fix =
    can.length > 0
      ? `serve only the ones that can, with createSqsHandler({ resizers: [${kept}] }), and consume the others with a worker process`
      : 'consume it with a worker process, or leave it out of createSqsHandler({ queue })';
  return new ResizeSetupError(
    `resize lambda: queue '${queue}' of ${who} on a task queue that cannot take pushed messages: only the SQS driver can — ${fix}`,
    { code: 'RESIZE_DELIVERY_UNSUPPORTED' },
  );
}

/**
 * What a batchHandler serves, from the same start checks as a worker: rejects when one of them does,
 * or when a consumed name cannot take pushed messages (on a router, the other names may).
 */
export async function wiringOf(opts: ServingOptions): Promise<DeliveryWiring> {
  const serving = await prepareServing({ ...opts, pushed: true });
  if (!serving) {
    throw new ResizeSetupError(
      'resize lambda: no Resizer has a task queue, so a pushed message has nothing to run on — give a Resizer an SQS queue',
      { code: 'RESIZE_DELIVERY_UNSUPPORTED' },
    );
  }
  const lanes: DeliveryLane[] = [];
  for (const { queue, carriers, routing } of serving.lanes) {
    for (const [carrier, timingSource] of carriers) {
      if (!isDeliveryQueue(carrier)) {
        throw await notPushable(queue, routing);
      }
      lanes.push({
        queue,
        carrier,
        deps: serving.depsOf(queue, carrier, timingSource),
      });
    }
  }
  return {
    lanes,
    processingSecondsOf: (task) =>
      serving.ownerOf(task)?.config.limits.processingTimeoutSeconds,
    flush: (waitMs) => flushMetrics(serving.resizers, waitMs),
    logger: serving.logger,
  };
}
