// Push delivery (preview): an SQS-triggered Lambda runs queued tasks with the same lease, retries,
// dead-letters and gate as a worker. Each record goes through the worker's own loop, and one that
// must stay in the queue is listed in `batchItemFailures`. This entry imports no AWS SDK, no framework
// code and no mongoose: the Resizers the host constructs bring what they use. It stays "preview" until
// the check list in RELEASE.md has passed against real AWS. Standard SQS queues only.
import {
  batchHandler,
  SETTLE_MARGIN_MS,
  type SqsHandler,
  wiringOf,
} from './delivery.ts';
import { ResizeConfigError } from './errors.ts';
import type { Resizer } from './resizer.ts';
import type { ResizeLogger } from './types.d.ts';
import { queueNamesOf, shownValue } from './worker.ts';

export type {
  LambdaContextLike,
  SqsBatchResponse,
  SqsEventLike,
  SqsHandler,
  SqsRecordLike,
} from './delivery.ts';

export interface SqsHandlerOptions {
  // The queue(s) this function consumes: one name or a list; default 'default'. Records go to their
  // queue by event source.
  queue?: string | readonly string[];
  // The Resizers to serve; default: every Resizer registered at the first invocation.
  resizers?: readonly Resizer[];
  // Process-wide Sharp tuning, applied once, at the first invocation. Omitted: left as it is.
  sharp?: { concurrency: number; cache: boolean };
  // The time kept back from the function timeout for the end of a task. Default:
  // limits.processingTimeoutSeconds + 5 s, never above half the time left. Given: a whole number of
  // ms, at least 3000, honoured as given, with no cap.
  stopBeforeTimeoutMs?: number;
  logger?: ResizeLogger; // default console
}

// The handler returns SETTLE_MARGIN_MS before the function timeout, so a stop at that same moment
// never lands (measured: the settle timer fires first, and nothing is stored). The extra second is
// for the end of a task: the variant in flight, the persist and the answer to the queue.
const MIN_STOP_BEFORE_TIMEOUT_MS = SETTLE_MARGIN_MS + 1000;

/**
 * Push delivery (preview): the handler of an SQS trigger, for a standard queue. It may be called
 * before the Resizers exist: they are looked up, and every start check runs, at the first invocation.
 * A check that rejects throws from the invocation and touches no record, and the next invocation
 * checks again.
 *
 * The trigger must set `ReportBatchItemFailures`, or retries are lost silently: Lambda then reads the
 * returned list as a success and deletes every message of the batch.
 */
export function createSqsHandler(opts: SqsHandlerOptions = {}): SqsHandler {
  const queue = queueNamesOf(opts.queue, true);
  const { resizers, sharp, stopBeforeTimeoutMs, logger } = opts;
  if (
    stopBeforeTimeoutMs !== undefined &&
    (!Number.isSafeInteger(stopBeforeTimeoutMs) ||
      stopBeforeTimeoutMs < MIN_STOP_BEFORE_TIMEOUT_MS)
  ) {
    throw new ResizeConfigError(
      `resize lambda: stopBeforeTimeoutMs must be a whole number of milliseconds, at least ${MIN_STOP_BEFORE_TIMEOUT_MS}: the handler returns ${SETTLE_MARGIN_MS} ms before the function timeout, and a stop needs time to store finished work and answer the queue before that (got ${shownValue(stopBeforeTimeoutMs)})`,
      { code: 'RESIZE_CONFIG_INVALID' },
    );
  }
  return batchHandler(() => wiringOf({ queue, resizers, sharp, logger }), {
    stopBeforeTimeoutMs,
    settleMarginMs: SETTLE_MARGIN_MS,
    logger,
  });
}
