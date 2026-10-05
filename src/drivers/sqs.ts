// SQS transport (05 · §10.3) — OPTIONAL, optional peer deps. A class (not a singleton): the
// host passes `transport: new SqsTransport({ queueUrl, … })` and the instance keeps its options
// in a `#private` field (engine-enforced, not a compile-time convention). One `SQSClient` is
// memoized from the options on first use — unless the
// host brings its own via `opts.client`. Credentials are NEVER options — they resolve via the
// standard AWS provider chain.
//
// SUBPATH-ONLY ENTRY, STATIC SDK IMPORTS (05 · §10.3): `@aws-sdk/client-sqs` and `sqs-consumer`
// are imported plainly at the top of this module. This is safe precisely because this driver is
// NOT re-exported from the main package entry (02 · §6) — hosts import
// `@adaptivestone/framework-module-resize/drivers/sqs.js` directly, so the optional peers are
// resolved ONLY when this subpath is imported, and a missing SDK fails loudly at the host's own
// import line at bootstrap (no dynamic import(), no lazy loaders).
//
// Dead-letter is NATIVE (the queue's redrive policy → DLQ): the transport just throws on
// failure and lets SQS redeliver up to maxReceiveCount, so no `deadLettered` event is reported
// here (documented — 05 · §10.3). It DOES report `completed` / `failed` through `onEvent`.
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Consumer } from 'sqs-consumer';
import { defaultQueueOptions } from '../config/resize.ts';
import type { LockStore } from '../contracts/lockStore.ts';
import {
  type EnqueueTask,
  type LeasedTask,
  QueueTransport,
  type StartWorkerOpts,
  type TaskEvent,
} from '../contracts/transport.ts';
import { ResizeSetupError } from '../errors.ts';
import { validateLockTtlMs } from '../resizeConfig.ts';
import type { ResizeLogger } from '../types.d.ts';

export interface SqsTransportOptions {
  queueUrl: string; // serves the 'default' queue
  queues?: Record<string, string>; // extra named queues → queue URLs
  // REQUIRED: the locks queued work is coordinated with (dispatch + worker locks). SQS has no
  // lock primitive, so pass a store: MongoLockStore, FrameworkLockStore, or your own LockStore.
  locks: LockStore;
  lockTtlMs?: { dispatch: number; worker: number }; // default 60000 each
  logger?: ResizeLogger; // default: console
  region?: string;
  endpoint?: string;
  visibilityTimeout?: number; // seconds; passed to sqs-consumer when provided
  heartbeatInterval?: number; // seconds; sqs-consumer extends visibility while processing
  // Bring-your-own configured client: a custom credential provider, proxy, retry strategy,
  // or a shared instance. When absent the driver constructs one from region/endpoint. (This
  // option is also the injection point exercised by the tests — the driver ships NO test-only
  // seams.)
  client?: SQSClient;
}

export class SqsTransport extends QueueTransport {
  readonly locks: LockStore;
  readonly #opts: SqsTransportOptions;
  // Memoized per instance. A host-provided `opts.client` short-circuits construction.
  // Synchronous now that the SDK is a static import — built lazily on first use.
  #client: SQSClient | undefined;

  constructor(opts: SqsTransportOptions) {
    super();
    if (!opts?.locks) {
      throw new ResizeSetupError(
        'resize sqs transport: `locks` is required (e.g. new MongoLockStore({ model: ResizeLock }) or FrameworkLockStore)',
        { code: 'RESIZE_LOCKS_REQUIRED' },
      );
    }
    if (opts.lockTtlMs !== undefined) {
      validateLockTtlMs(opts.lockTtlMs);
    }
    // erasableSyntaxOnly: no parameter properties — assign fields explicitly.
    this.#opts = opts;
    this.locks = opts.locks;
  }

  /** Only `'default'` (queueUrl) and the names in `queues` can be consumed. */
  servesQueue(queue: string): boolean {
    return queue === 'default' || Object.hasOwn(this.#opts.queues ?? {}, queue);
  }

  getLockTtlMs(): { dispatch: number; worker: number } {
    return this.#opts.lockTtlMs ?? defaultQueueOptions.lockTtlMs;
  }

  #getClient(): SQSClient {
    if (this.#opts.client) {
      return this.#opts.client;
    }
    this.#client ??= new SQSClient({
      ...(this.#opts.region !== undefined ? { region: this.#opts.region } : {}),
      ...(this.#opts.endpoint !== undefined
        ? { endpoint: this.#opts.endpoint }
        : {}),
    });
    return this.#client;
  }

  // The URL for a named queue. An unknown name is a wiring error, reported before any send or
  // poll so a typo never silently drops or ignores tasks.
  #queueUrl(queue: string): string {
    const url =
      queue === 'default' ? this.#opts.queueUrl : this.#opts.queues?.[queue];
    if (!url) {
      throw new ResizeSetupError(
        `resize sqs: no queue URL for queue '${queue}' — add it to the SqsTransport \`queues\` option`,
        { code: 'RESIZE_SQS_QUEUE_UNKNOWN' },
      );
    }
    return url;
  }

  async enqueue(task: EnqueueTask): Promise<{ taskId: string | null }> {
    // No local try/catch soft-fail: a throw is guarded by enqueue.ts; a successful send
    // without a MessageId returns a null taskId (which enqueue.ts also treats as a soft
    // failure). Body is the durable, ctx-free task payload (04 · §8).
    const queueUrl = this.#queueUrl(task.queue);
    const out = await this.#getClient().send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          resizer: task.resizer,
          queue: task.queue,
          mediaId: task.mediaId,
          pipeline: task.pipeline,
          previews: task.previews,
        }),
      }),
    );
    return { taskId: out.MessageId ?? null };
  }

  async startWorker(
    handleTask: (
      task: LeasedTask,
      taskOpts?: { signal: AbortSignal },
    ) => Promise<void>,
    workerOpts: StartWorkerOpts,
  ): Promise<void> {
    const queueUrl = this.#queueUrl(workerOpts.queue);
    // A throwing event handler (a host observer bug) is logged and never changes the
    // ack/redelivery outcome of the message.
    const report = async (
      event: TaskEvent,
      task: LeasedTask,
      error?: unknown,
    ): Promise<void> => {
      if (!workerOpts.onEvent) {
        return;
      }
      try {
        await workerOpts.onEvent(event, task, error);
      } catch (err) {
        (this.#opts.logger ?? console).error(
          `resize sqs: ${event} event handler failed`,
          err,
        );
      }
    };
    const consumer = Consumer.create({
      queueUrl,
      sqs: this.#getClient(),
      // Returning the message ACKs it (sqs-consumer deletes it). Throwing leaves it for
      // SQS to redeliver after the visibility timeout (→ DLQ via redrive policy).
      // Arrow function: sqs-consumer invokes it detached, so `this` stays instance-bound.
      handleMessage: async (message) => {
        // The body JSON.parse is INSIDE the guarded region (05 · §10.3 fix b): a malformed body
        // reports `failed` before rethrowing, consistent with a handler throw → SQS redelivers.
        // `task` starts as a minimal LeasedTask (fields unknown until the body parses) so the
        // event always carries a task-shaped payload.
        let task: LeasedTask = {
          taskId: message.MessageId ?? '',
          resizer: 'default',
          queue: workerOpts.queue,
          mediaId: '',
          pipeline: '',
          previews: [],
        };
        try {
          const body = JSON.parse(message.Body ?? '{}') as {
            resizer?: string;
            queue?: string;
            mediaId: string;
            pipeline: string;
            previews: LeasedTask['previews'];
          };
          task = {
            taskId: message.MessageId ?? '',
            resizer: body.resizer ?? 'default',
            queue: body.queue ?? workerOpts.queue,
            mediaId: body.mediaId,
            pipeline: body.pipeline,
            previews: body.previews ?? [],
          };
          await handleTask(task);
        } catch (err) {
          await report('failed', task, err);
          throw err; // let SQS redeliver → DLQ (no deadLettered event here — 05 · §10.3)
        }
        await report('completed', task);
        return message;
      },
      // visibilityTimeout / heartbeatInterval only when the host provided them (else the
      // queue default / no consumer-side heartbeat).
      ...(this.#opts.visibilityTimeout !== undefined
        ? { visibilityTimeout: this.#opts.visibilityTimeout }
        : {}),
      ...(this.#opts.heartbeatInterval !== undefined
        ? { heartbeatInterval: this.#opts.heartbeatInterval }
        : {}),
    });

    // Resolve when the consumer has fully stopped. Worker-wide shutdown wires
    // workerOpts.signal → consumer.stop() (graceful: sqs-consumer finishes in-flight first).
    await new Promise<void>((resolve) => {
      consumer.once('stopped', () => resolve());
      // `on`, NOT `once`: recurring consumer errors (e.g. heartbeat ChangeMessageVisibility
      // failures) must ALL be logged — a `once` listener drops every error after the first,
      // leaving later ones unhandled (05 · §10.3 fix a).
      consumer.on('error', (err) => {
        (this.#opts.logger ?? console).error('resize sqs consumer error', err);
      });
      const stop = () => consumer.stop();
      if (workerOpts.signal.aborted) {
        consumer.start();
        stop();
      } else {
        workerOpts.signal.addEventListener('abort', stop, { once: true });
        consumer.start();
      }
    });
  }
}
