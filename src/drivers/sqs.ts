// SqsTaskQueue: the task queue on Amazon SQS. Each TaskQueue operation is one SQS call — the core
// owns the worker loop, retries and dead-lettering, so SQS behaves exactly like the database queue:
//   claim    = ReceiveMessage (visibility timeout = lease; ApproximateReceiveCount = attempts)
//   renew    = ChangeMessageVisibility        complete = DeleteMessage
//   retry    = ChangeMessageVisibility(delay) dead     = send to deadLetterQueueUrl (if set), delete
//   release  = ChangeMessageVisibility(0)
// The SQS client is built from region/endpoint on first use unless the host passes `client`;
// credentials come from the AWS provider chain. Subpath-only entry: the optional AWS SDK peer is
// resolved only when this file is imported, so a missing SDK fails at the host's import line.
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  type ClaimedTask,
  type NewTask,
  TaskQueue,
} from '../contracts/taskQueue.ts';
import { ResizeSetupError } from '../errors.ts';
import { validateLockTtlMs } from '../resizeConfig.ts';
import type {
  MissingPreview,
  QueueTimingOptions,
  ResizeLogger,
} from '../types.d.ts';

export interface SqsTaskQueueOptions {
  queueUrl: string; // serves the 'default' queue
  queues?: Record<string, string>; // other named queues → queue URLs
  // Where dead tasks go (their body plus the error), before they are deleted. Without it a dead
  // task is logged and deleted.
  deadLetterQueueUrl?: string;
  timing?: Partial<QueueTimingOptions>; // missing values use defaultQueueOptions
  waitTimeSeconds?: number; // long poll per claim, 0–20; default 10
  logger?: ResizeLogger; // default: console
  region?: string;
  endpoint?: string;
  client?: SQSClient; // an existing client (custom credentials, proxy, shared instance)
}

// The message body: the durable, ctx-free task payload.
interface TaskBody {
  resizer?: string;
  queue?: string;
  mediaId: string;
  pipeline: string;
  previews: MissingPreview[];
}

const MAX_VISIBILITY_SECONDS = 43_200; // SQS limit: 12 hours

const seconds = (ms: number): number =>
  Math.min(MAX_VISIBILITY_SECONDS, Math.max(0, Math.ceil(ms / 1000)));

// A receipt handle that no longer works means another receive took the message: the lease is lost.
const isLostReceipt = (err: unknown): boolean => {
  const name = (err as { name?: unknown })?.name;
  return (
    name === 'ReceiptHandleIsInvalid' ||
    name === 'MessageNotInflight' ||
    name === 'InvalidParameterValue'
  );
};

export class SqsTaskQueue extends TaskQueue {
  readonly #opts: SqsTaskQueueOptions;
  #client: SQSClient | undefined;
  #warnedNoReceiveCount = false;

  constructor(opts: SqsTaskQueueOptions) {
    super();
    if (!opts?.queueUrl) {
      throw new ResizeSetupError('resize sqs: `queueUrl` is required', {
        code: 'RESIZE_SQS_QUEUE_URL_REQUIRED',
      });
    }
    if (opts.timing?.lockTtlMs !== undefined) {
      validateLockTtlMs(opts.timing.lockTtlMs);
    }
    // erasableSyntaxOnly: no parameter properties — assign fields explicitly.
    this.#opts = opts;
  }

  get #logger(): ResizeLogger {
    return this.#opts.logger ?? console;
  }

  #sqs(): SQSClient {
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
  // receive, so a typo never silently drops or ignores tasks.
  #queueUrl(queue: string): string {
    const url =
      queue === 'default' ? this.#opts.queueUrl : this.#opts.queues?.[queue];
    if (!url) {
      throw new ResizeSetupError(
        `resize sqs: no queue URL for queue '${queue}' — add it to the SqsTaskQueue \`queues\` option`,
        { code: 'RESIZE_SQS_QUEUE_UNKNOWN' },
      );
    }
    return url;
  }

  /** Only `'default'` (queueUrl) and the names in `queues` can be consumed. */
  servesQueue(queue: string): boolean {
    return queue === 'default' || Object.hasOwn(this.#opts.queues ?? {}, queue);
  }

  getTiming(): Partial<QueueTimingOptions> {
    return this.#opts.timing ?? {};
  }

  async add(task: NewTask): Promise<{ taskId: string | null }> {
    const body: TaskBody = {
      resizer: task.resizer,
      queue: task.queue,
      mediaId: task.mediaId,
      pipeline: task.pipeline,
      previews: task.previews,
    };
    const out = await this.#sqs().send(
      new SendMessageCommand({
        QueueUrl: this.#queueUrl(task.queue),
        MessageBody: JSON.stringify(body),
      }),
    );
    return { taskId: out.MessageId ?? null };
  }

  async claim(
    queue: string,
    leaseMs: number,
    signal?: AbortSignal,
  ): Promise<ClaimedTask | null> {
    const queueUrl = this.#queueUrl(queue);
    const out = await this.#sqs().send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: this.#opts.waitTimeSeconds ?? 10,
        VisibilityTimeout: Math.max(1, seconds(leaseMs)),
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
      signal ? { abortSignal: signal } : {},
    );
    const message = out.Messages?.[0];
    if (!message?.ReceiptHandle) {
      return null;
    }
    const body = parseBody(message);
    if (!body) {
      await this.#discard(queueUrl, message, 'malformed task body');
      return null;
    }
    const receiveCount = message.Attributes?.ApproximateReceiveCount;
    if (receiveCount === undefined && !this.#warnedNoReceiveCount) {
      // Clients before @aws-sdk/client-sqs 3.572 drop MessageSystemAttributeNames: every delivery
      // then reads as attempt 1, so a failing task would be retried forever.
      this.#warnedNoReceiveCount = true;
      this.#logger.warn(
        'resize sqs: ReceiveMessage returned no ApproximateReceiveCount — attempts cannot be counted, so failing tasks are never dead-lettered; use @aws-sdk/client-sqs >= 3.572',
      );
    }
    return {
      taskId: message.MessageId ?? message.ReceiptHandle,
      resizer: body.resizer ?? 'default',
      queue: body.queue ?? queue,
      mediaId: body.mediaId,
      pipeline: body.pipeline,
      previews: body.previews ?? [],
      // The URL travels with the token: complete/fail/renew act on the queue it came from.
      token: JSON.stringify([queueUrl, message.ReceiptHandle]),
      attempts: Number(receiveCount ?? 1),
    };
  }

  async renew(task: ClaimedTask, leaseMs: number): Promise<boolean> {
    return this.#setVisibility(task, Math.max(1, seconds(leaseMs)));
  }

  // SQS fences less than Mongo: it accepts a delete with an outdated receipt handle and keeps the
  // message. After a lost lease this may report true and the task runs again; the worker skips
  // previews that already exist.
  async complete(task: ClaimedTask): Promise<boolean> {
    const [queueUrl, receiptHandle] = parseToken(task.token);
    try {
      await this.#sqs().send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
        }),
      );
      return true;
    } catch (err) {
      if (isLostReceipt(err)) {
        return false;
      }
      throw err;
    }
  }

  async fail(
    task: ClaimedTask,
    next: { retryAt: Date } | 'dead',
    error: string,
  ): Promise<boolean> {
    if (next !== 'dead') {
      return this.#setVisibility(
        task,
        seconds(next.retryAt.getTime() - Date.now()),
      );
    }
    const [queueUrl, receiptHandle] = parseToken(task.token);
    // Copy first, then delete: a failed send leaves the message for a retry, so a dead task is
    // never lost. If the delete then finds the lease lost, another worker holds the task and the
    // dead-letter queue may get a second copy later — a rare duplicate, never a loss.
    if (this.#opts.deadLetterQueueUrl) {
      await this.#sqs().send(
        new SendMessageCommand({
          QueueUrl: this.#opts.deadLetterQueueUrl,
          MessageBody: JSON.stringify({
            resizer: task.resizer,
            queue: task.queue,
            mediaId: task.mediaId,
            pipeline: task.pipeline,
            previews: task.previews,
            attempts: task.attempts,
            error,
          }),
        }),
      );
    } else {
      this.#logger.error(
        `resize sqs: task ${task.taskId} is dead and no deadLetterQueueUrl is set — deleting it (${error})`,
      );
    }
    try {
      await this.#sqs().send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
        }),
      );
      return true;
    } catch (err) {
      if (isLostReceipt(err)) {
        return false;
      }
      throw err;
    }
  }

  // Visible again at once. SQS cannot lower a message's receive count, so unlike the database
  // queue this delivery still counts as an attempt: a task released on its last allowed delivery
  // is dead-lettered by the next claim without running.
  async release(task: ClaimedTask): Promise<boolean> {
    return this.#setVisibility(task, 0);
  }

  async #setVisibility(
    task: ClaimedTask,
    visibilitySeconds: number,
  ): Promise<boolean> {
    const [queueUrl, receiptHandle] = parseToken(task.token);
    try {
      await this.#sqs().send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: visibilitySeconds,
        }),
      );
      return true;
    } catch (err) {
      if (isLostReceipt(err)) {
        return false;
      }
      throw err;
    }
  }

  // A message the module can't read never becomes a task: move it to the dead-letter queue when
  // there is one, otherwise leave it to the queue's own redrive policy.
  async #discard(
    queueUrl: string,
    message: Message,
    reason: string,
  ): Promise<void> {
    this.#logger.error(`resize sqs: ${reason} in message ${message.MessageId}`);
    if (!this.#opts.deadLetterQueueUrl || !message.ReceiptHandle) {
      return;
    }
    await this.#sqs().send(
      new SendMessageCommand({
        QueueUrl: this.#opts.deadLetterQueueUrl,
        MessageBody: message.Body ?? '',
      }),
    );
    await this.#sqs().send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }
}

function parseBody(message: Message): TaskBody | null {
  try {
    const body = JSON.parse(message.Body ?? '') as Partial<TaskBody>;
    if (
      typeof body?.mediaId !== 'string' ||
      typeof body.pipeline !== 'string'
    ) {
      return null;
    }
    return body as TaskBody;
  } catch {
    return null;
  }
}

function parseToken(token: string): [string, string] {
  const [queueUrl, receiptHandle] = JSON.parse(token) as [string, string];
  return [queueUrl, receiptHandle];
}
