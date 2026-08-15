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
// `@adaptivestone/framework-module-resize/transports/sqs.js` directly, so the optional peers are
// resolved ONLY when this subpath is imported, and a missing SDK fails loudly at the host's own
// import line at bootstrap (no dynamic import(), no lazy loaders).
//
// Dead-letter is NATIVE (the queue's redrive policy → DLQ): the transport just throws on
// failure and lets SQS redeliver up to maxReceiveCount, so `onTaskDeadLettered` does NOT
// fire here (documented — 05 · §10.3). It DOES fire `afterTaskComplete` / `onTaskFailed`.
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Consumer } from 'sqs-consumer';
import { getApp } from '../app.ts';
import { getResizer } from '../resizer.ts';
import type { MissingPreview } from '../types.d.ts';
import type { LeasedTask, QueueTransport } from './AbstractTransport.ts';

export interface SqsTransportOptions {
  queueUrl: string;
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

export class SqsTransport implements QueueTransport {
  readonly #opts: SqsTransportOptions;
  // Memoized per instance. A host-provided `opts.client` short-circuits construction.
  // Synchronous now that the SDK is a static import — built lazily on first use.
  #client: SQSClient | undefined;

  constructor(opts: SqsTransportOptions) {
    // erasableSyntaxOnly: no parameter properties — assign fields explicitly.
    this.#opts = opts;
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

  async enqueue(task: {
    mediaId: string;
    pipeline: string;
    previews: MissingPreview[];
  }): Promise<{ taskId: string | null }> {
    // No local try/catch soft-fail: a throw is guarded by enqueue.ts; a successful send
    // without a MessageId returns a null taskId (which enqueue.ts also treats as a soft
    // failure). Body is the durable, ctx-free task payload (04 · §8).
    const out = await this.#getClient().send(
      new SendMessageCommand({
        QueueUrl: this.#opts.queueUrl,
        MessageBody: JSON.stringify({
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
    workerOpts: { signal: AbortSignal },
  ): Promise<void> {
    const consumer = Consumer.create({
      queueUrl: this.#opts.queueUrl,
      sqs: this.#getClient(),
      // Returning the message ACKs it (sqs-consumer deletes it). Throwing leaves it for
      // SQS to redeliver after the visibility timeout (→ DLQ via redrive policy).
      // Arrow function: sqs-consumer invokes it detached, so `this` stays instance-bound.
      handleMessage: async (message) => {
        // The body JSON.parse is INSIDE the guarded region (05 · §10.3 fix b): a malformed body
        // fires onTaskFailed before rethrowing, consistent with a handler throw → SQS redelivers.
        // `task` starts as a minimal LeasedTask (fields unknown until the body parses) so the
        // observer always receives a task-shaped payload.
        let task: LeasedTask = {
          taskId: message.MessageId ?? '',
          mediaId: '',
          pipeline: '',
          previews: [],
        };
        try {
          const body = JSON.parse(message.Body ?? '{}') as {
            mediaId: string;
            pipeline: string;
            previews: LeasedTask['previews'];
          };
          task = {
            taskId: message.MessageId ?? '',
            mediaId: body.mediaId,
            pipeline: body.pipeline,
            previews: body.previews ?? [],
          };
          await handleTask(task);
        } catch (err) {
          await getResizer().runObservers('onTaskFailed', task, err, {});
          throw err; // let SQS redeliver → DLQ (no onTaskDeadLettered here — 05 · §10.3)
        }
        await getResizer().runObservers('afterTaskComplete', task, {});
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
        getApp().logger.error('resize sqs consumer error', err);
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
