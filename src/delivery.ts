// Push delivery: a batch of SQS records handed to the process, each run through the real worker
// loop (src/consumer.ts), unchanged. A one-shot task queue over the real one gives a Consumer the
// delivered task once and then ends its run, so its retries, dead-letters, gate lock, observers and
// metrics are the worker's own. A record that must stay in the queue is listed in
// `batchItemFailures`, never thrown: Lambda then retries only those. Only an event that is no SQS
// batch, and checks that reject, throw. The host logger is called only through logNeverThrow.
// Internal: no entry re-exports this file, and it may change in any release; `createSqsHandler()`
// (src/lambda.ts) is the public way in.
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
import type { ResizeLogger } from './types.d.ts';

export interface SqsRecordLike {
  messageId: string;
  receiptHandle: string;
  body: string;
  // Optional in the type so that a hand-built event gets its answer from the event check, which
  // refuses a record without a count.
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

// How a delivery ended. Only 'completed', 'dead' and 'discarded' took the message out of the queue.
type DeliveryEnd =
  | 'completed'
  | 'dead'
  | 'retry'
  | 'given-back'
  | 'lease-lost'
  | 'left'
  | 'discarded';

const noop = () => {};

// A message's receive count as SQS reports it: a whole number from 1, in text. Anything else reads
// as NaN, as 0, or as the same 1 on every delivery, so a failing task never reaches maxAttempts and
// loops until the queue's redrive policy takes it.
const RECEIVE_COUNT = /^[1-9]\d*$/;

const filled = (value: unknown): boolean =>
  typeof value === 'string' && value !== '';

const isRecord = (record: SqsRecordLike): boolean =>
  filled(record?.messageId) &&
  filled(record.receiptHandle) &&
  typeof record.body === 'string';

/** Throw unless this is an SQS batch whose records can all be counted and answered. */
function checkEvent(event: SqsEventLike, context: LambdaContextLike): void {
  if (
    !Array.isArray(event?.Records) ||
    !event.Records.every(isRecord) ||
    typeof context?.getRemainingTimeInMillis !== 'function'
  ) {
    throw new ResizeSetupError(
      "resize lambda: the event is not an SQS batch: it needs a Records array whose records have a messageId, a receiptHandle and a string body, and a context with getRemainingTimeInMillis() — check the function's trigger",
      { code: 'RESIZE_SQS_EVENT_INVALID', retryable: false },
    );
  }
  for (const { messageId, attributes } of event.Records) {
    const count = attributes?.ApproximateReceiveCount;
    if (typeof count !== 'string' || !RECEIVE_COUNT.test(count)) {
      throw new ResizeSetupError(
        `resize lambda: message ${messageId} has no attributes.ApproximateReceiveCount that holds a whole number from 1, as SQS reports it: its deliveries could not be counted, so a failing task would never be dead-lettered — check the function's trigger`,
        { code: 'RESIZE_SQS_EVENT_INVALID', retryable: false },
      );
    }
  }
}

/**
 * The queue a Consumer sees for one delivered task: the first claim hands it out and the second
 * ends the run, and the rest goes to the real queue. `end` is what the queue last took; a call that
 * throws leaves it, and a falsy answer means the lease was lost. It forwards no optional flags, as
 * a DeliveryQueue has no `gatesByTask`.
 */
class OneShotQueue extends TaskQueue {
  end: DeliveryEnd = 'left';
  readonly #carrier: TaskQueue & DeliveryQueue;
  readonly #task: ClaimedTask;
  readonly #stop: AbortController;
  #claimed = false;

  constructor(
    carrier: TaskQueue & DeliveryQueue,
    task: ClaimedTask,
    stop: AbortController,
  ) {
    super();
    this.#carrier = carrier;
    this.#task = task;
    this.#stop = stop;
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

/** Run one record through a Consumer. A throw here is the caller's to log. */
async function deliver(
  record: SqsRecordLike,
  wired: DeliveryWiring,
  onAdoptionFailure: (id: string, err: unknown) => void,
): Promise<DeliveryEnd> {
  const { messageId: id, receiptHandle: receipt, body } = record;
  const { logger } = wired;
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
  const receiveCount = record.attributes?.ApproximateReceiveCount;
  const task = await lane.carrier.taskOfDelivery(
    { id, receipt, body, receiveCount },
    lane.queue,
  );
  if (typeof task === 'string') {
    return task;
  }
  if (!(await adopt(lane, task, (err) => onAdoptionFailure(id, err)))) {
    logNeverThrow(
      logger,
      `resize lambda: message ${id} lost its receipt before it started — left to its next delivery`,
      undefined,
      'warn',
    );
    return 'lease-lost';
  }
  const stop = new AbortController();
  const once = new OneShotQueue(lane.carrier, task, stop);
  // The handler can outlast the Consumer's wait for it (a timeout). It has settled before this
  // returns, so nothing of it runs across the freeze that follows the invocation's end.
  let settled: Promise<unknown> = Promise.resolve();
  const consumer = new Consumer({
    ...lane.deps,
    tasks: once,
    handle: (leased, opts) => {
      const running = lane.deps.handle(leased, opts);
      settled = running.catch(noop);
      return running;
    },
  });
  await consumer
    .run(lane.queue, stop.signal)
    .then(() => settled)
    .catch((err) => {
      logNeverThrow(
        logger,
        `resize lambda: the delivery of task ${task.taskId} ended with an error`,
        err,
      );
    });
  return once.end;
}

/**
 * The handler of an SQS trigger: checks the event, runs `wiring` once (it runs again after it
 * rejected, which throws from the invocation and touches no record), then delivers the records in
 * order and lists those that stay in the queue.
 */
export function batchHandler(
  wiring: () => Promise<DeliveryWiring>,
): SqsHandler {
  let ready: Promise<DeliveryWiring> | undefined;
  // A role without the permission fails every adoption, and one line says what is wrong.
  let adoptionFailureLogged = false;
  return async (event, context) => {
    checkEvent(event, context);
    ready ??= wiring().catch((err) => {
      ready = undefined;
      throw err;
    });
    const wired = await ready;
    const onAdoptionFailure = (id: string, err: unknown) => {
      if (adoptionFailureLogged) {
        return;
      }
      adoptionFailureLogged = true;
      logNeverThrow(
        wired.logger,
        `resize lambda: setting the visibility of message ${id} failed — the task runs, but a crash would hide the message for the queue's whole visibility timeout; does the role allow sqs:ChangeMessageVisibility?`,
        err,
      );
    };
    const batchItemFailures: SqsBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
      let end: DeliveryEnd = 'left';
      try {
        end = await deliver(record, wired, onAdoptionFailure);
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
    await wired.flush(5000);
    return { batchItemFailures };
  };
}
