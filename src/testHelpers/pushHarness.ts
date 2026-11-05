// Test-only: the harness of push delivery. `fakeSqs` is an SQS client that records every call and
// can make one fail or wait; `pushed` puts a batchHandler with one lane over a real SqsTaskQueue on
// that client, so a delivered record runs through the real Consumer and the real queue. The other
// helpers build what a Lambda invocation receives. Nothing here touches AWS.
import type { SQSClient } from '@aws-sdk/client-sqs';
import { defaultQueueOptions } from '../config/resize.ts';
import type { ConsumerDeps } from '../consumer.ts';
import {
  batchHandler,
  type DeliveryWiring,
  type LambdaContextLike,
  type SqsHandler,
  type SqsRecordLike,
} from '../delivery.ts';
import { SqsTaskQueue } from '../drivers/sqs.ts';
import { gateKey } from '../lockKeys.ts';
import type { QueueTimingOptions, ResizeLogger } from '../types.d.ts';
import { type ClockLocks, clockLocks, recordingMetrics } from './fakes.ts';

export const QUEUE_URL =
  'https://sqs.eu-west-1.amazonaws.com/123456789012/resize';
export const QUEUE_ARN = 'arn:aws:sqs:eu-west-1:123456789012:resize';
export const DEAD_URL =
  'https://sqs.eu-west-1.amazonaws.com/123456789012/resize-dead';

/** The gate lock of the task `recordOf` delivers by default. */
export const GATE_KEY = gateKey('default', 'default', 'm1', 'default');

/**
 * What one SQS command does on its `nth` call, from 1: an `Error` makes the call throw, a promise
 * makes it wait, and undefined lets it answer.
 */
type Hold = (nth: number) => Error | Promise<void> | undefined;

export type FakeSqs = ReturnType<typeof fakeSqs>;

/** An SQS client that routes by the command's class name and records every call before answering. */
export function fakeSqs(hold: Partial<Record<string, Hold>> = {}) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const named = (name: string) => calls.filter((call) => call.name === name);
  return {
    client: {
      async send(command: unknown): Promise<unknown> {
        const {
          constructor: { name },
          input,
        } = command as {
          constructor: { name: string };
          input: Record<string, unknown>;
        };
        calls.push({ name, input });
        const held = await hold[name]?.(named(name).length);
        if (held instanceof Error) {
          throw held;
        }
        return name === 'SendMessageCommand' ? { MessageId: 'x' } : {};
      },
    },
    calls,
    visibility: (): number[] =>
      named('ChangeMessageVisibilityCommand').map(
        (call) => call.input.VisibilityTimeout as number,
      ),
    deletes: (): number => named('DeleteMessageCommand').length,
    sends: (): Record<string, unknown>[] =>
      named('SendMessageCommand').map((call) => call.input),
  };
}

/** A Lambda context with `ms` left, counting down on performance.now(). */
export function contextOf(ms: number): LambdaContextLike {
  const end = performance.now() + ms;
  return {
    getRemainingTimeInMillis: () => Math.round(end - performance.now()),
  };
}

/** A record of the harness's queue. A string body goes in as it is, anything else as its JSON. */
export function recordOf(
  id: string,
  over: { n?: number; receipt?: string; body?: unknown; arn?: string } = {},
): SqsRecordLike {
  const body = over.body ?? {
    resizer: 'default',
    queue: 'default',
    mediaId: 'm1',
    pipeline: 'default',
    previews: [],
    gateOwner: 'g1',
  };
  return {
    messageId: id,
    receiptHandle: over.receipt ?? `rh-${id}`,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    attributes: { ApproximateReceiveCount: String(over.n ?? 1) },
    eventSourceARN: over.arn ?? QUEUE_ARN,
  };
}

export function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(err: unknown): void;
} {
  return Promise.withResolvers<void>();
}

const errorNamed = (name: string, message: string): Error =>
  Object.assign(new Error(message), { name });

/** What SQS answers for a receipt that no longer works. */
export function lostReceipt(): Error {
  return errorNamed('ReceiptHandleIsInvalid', 'gone');
}

/** What SQS answers when the role lacks the permission. */
export function denied(): Error {
  return errorNamed('AccessDenied', 'denied');
}

/**
 * A batchHandler with one lane, `'default'`, over a real SqsTaskQueue on `sqs`. Only Resizer
 * `'default'` has a coordination, so only its tasks hold a gate lock. `lines` is everything the
 * logger received, the Consumer's own failure lines too, so match on text, not on how many there
 * are; a line carries `error` when the logger got one.
 */
export function pushed(
  sqs: FakeSqs,
  handle: ConsumerDeps['handle'],
  over: {
    dlq?: boolean; // default true: the queue has DEAD_URL as its dead-letter queue
    timing?: Partial<QueueTimingOptions>;
    locks?: ClockLocks; // default clockLocks()
    observer?: () => Promise<void>; // awaited in the events handler, after the event is recorded
  } = {},
): {
  handler: SqsHandler;
  wiring: DeliveryWiring;
  locks: ClockLocks;
  events: { event: string; error?: unknown }[];
  lines: { level: string; message: string; error?: unknown }[];
  flushes: number[]; // the waitMs of each flush
  carrier: SqsTaskQueue;
} {
  const lines: { level: string; message: string; error?: unknown }[] = [];
  const line =
    (level: string) =>
    (message: string, ...rest: unknown[]) => {
      lines.push({
        level,
        message,
        ...(rest.length > 0 ? { error: rest[0] } : {}),
      });
    };
  const logger: ResizeLogger = {
    info: line('info'),
    warn: line('warn'),
    error: line('error'),
  };
  const carrier = new SqsTaskQueue({
    queueUrl: QUEUE_URL,
    ...(over.dlq === false ? {} : { deadLetterQueueUrl: DEAD_URL }),
    client: sqs.client as unknown as SQSClient,
    logger,
  });
  const locks = over.locks ?? clockLocks();
  const events: { event: string; error?: unknown }[] = [];
  const flushes: number[] = [];
  const metrics = recordingMetrics();
  const wiring: DeliveryWiring = {
    lanes: [
      {
        queue: 'default',
        carrier,
        deps: {
          tasks: carrier,
          timing: { ...defaultQueueOptions, ...over.timing },
          handle,
          events: async (event, _task, error) => {
            events.push({ event, error });
            await over.observer?.();
          },
          logger,
          coordinationOf: (task) =>
            task.resizer === 'default'
              ? { cooldownMs: 600_000, gateTtlMs: 600_000, locks }
              : undefined,
          metricsOf: () => metrics,
        },
      },
    ],
    processingSecondsOf: () => 30,
    flush: async (waitMs) => {
      flushes.push(waitMs);
    },
    logger,
  };
  return {
    handler: batchHandler(async () => wiring),
    wiring,
    locks,
    events,
    lines,
    flushes,
    carrier,
  };
}
