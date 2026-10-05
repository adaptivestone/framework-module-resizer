import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type {
  ClaimedTask,
  LeasedTask,
  NewTask,
  TaskEventHandler,
} from '../contracts/taskQueue.ts';
import { ResizeSetupError } from '../errors.ts';
import { consumeQueue, timingOf } from '../queue.ts';
import { Resizer, resetResizerForTests } from '../resizer.ts';
import { fakeDb } from '../testHelpers/fakes.ts';
import { makeImageConfig } from '../testHelpers/resizeConfig.ts';
import type { MissingPreview, QueueTimingOptions } from '../types.d.ts';
import { SqsTaskQueue } from './sqs.ts';

// No live AWS or test-only driver seam: the public `client` option accepts this recording fake.
// Route real SDK command classes by constructor name and supply canned outputs/errors.
type CommandName =
  | 'SendMessageCommand'
  | 'ReceiveMessageCommand'
  | 'DeleteMessageCommand'
  | 'ChangeMessageVisibilityCommand';
interface FakeCommand {
  input: Record<string, unknown>;
  constructor: { name: string };
}
interface FakeMessage {
  MessageId?: string;
  Body?: string;
  ReceiptHandle?: string;
  Attributes?: { ApproximateReceiveCount?: string };
}
function makeFakeSqsClient(
  opts: {
    messageId?: string;
    message?: FakeMessage;
    outputs?: Partial<Record<CommandName, (Record<string, unknown> | Error)[]>>;
  } = {},
) {
  const commands: FakeCommand[] = [];
  const sent: FakeCommand[] = [];
  const deletes: Record<string, unknown>[] = [];
  const changeVis: Record<string, unknown>[] = [];
  const receiveParams: Record<string, unknown>[] = [];
  const receiveOptions: { abortSignal?: AbortSignal }[] = [];
  const outputs = Object.fromEntries(
    Object.entries(opts.outputs ?? {}).map(([name, values]) => [
      name,
      [...values],
    ]),
  );
  let delivered = false;
  const client = {
    async send(
      command: FakeCommand,
      options: { abortSignal?: AbortSignal } = {},
    ) {
      const name = command.constructor.name;
      commands.push(command);
      switch (name) {
        case 'ReceiveMessageCommand':
          receiveParams.push(command.input);
          receiveOptions.push(options);
          break;
        case 'DeleteMessageCommand':
          deletes.push(command.input);
          break;
        case 'ChangeMessageVisibilityCommand':
          changeVis.push(command.input);
          break;
        case 'SendMessageCommand':
          sent.push(command);
          break;
        default:
          throw new Error(`unexpected SQS command ${name}`);
      }
      const output = outputs[name]?.shift();
      if (output instanceof Error) {
        throw output;
      }
      if (output !== undefined) {
        return output;
      }
      if (name === 'ReceiveMessageCommand' && opts.message && !delivered) {
        delivered = true;
        return { Messages: [opts.message] };
      }
      return name === 'SendMessageCommand' ? { MessageId: opts.messageId } : {};
    },
  } as unknown as SQSClient;
  return {
    client,
    commands,
    sent,
    deletes,
    changeVis,
    receiveParams,
    receiveOptions,
  };
}
const variant = (over: Partial<MissingPreview> = {}): MissingPreview => ({
  sizeKey: '300x300',
  format: 'jpeg',
  ...over,
});
const newTask = (over: Partial<NewTask> = {}): NewTask => ({
  resizer: 'default',
  queue: 'default',
  mediaId: 'm1',
  pipeline: 'photo',
  previews: [variant()],
  requestKey: 'request-key',
  ...over,
});
const message = (over: Partial<FakeMessage> = {}): FakeMessage => ({
  MessageId: 'mid',
  ReceiptHandle: 'rh',
  Body: JSON.stringify({
    mediaId: 'm1',
    pipeline: 'photo',
    previews: [variant()],
  }),
  ...over,
});
const claimedTask = (over: Partial<ClaimedTask> = {}): ClaimedTask => ({
  taskId: 'mid',
  resizer: 'default',
  queue: 'default',
  mediaId: 'm1',
  pipeline: 'photo',
  previews: [variant()],
  token: JSON.stringify(['q', 'rh']),
  attempts: 1,
  ...over,
});
function recordingLogger() {
  const errors: unknown[][] = [];
  const logger = {
    info() {},
    warn() {},
    error(...args: unknown[]) {
      errors.push(args);
    },
  };
  return { errors, logger };
}
interface Recorder {
  completed: { task: LeasedTask }[];
  failed: { task: LeasedTask; err: unknown }[];
  deadLettered: { task: LeasedTask; err: unknown }[];
  onEvent: TaskEventHandler;
}
function makeEvents(): Recorder {
  const rec: Recorder = {
    completed: [],
    failed: [],
    deadLettered: [],
    onEvent: () => {},
  };
  rec.onEvent = (event, task, error) => {
    if (event === 'completed') {
      rec.completed.push({ task });
    } else {
      rec[event].push({ task, err: error });
    }
  };
  return rec;
}
const BULK_URL = 'https://q/bulk';
const DEAD_URL = 'https://q/dead';
const fastTiming: Partial<QueueTimingOptions> = {
  idlePollMs: 1,
  retryBackoffMs: { base: 1000, max: 1000 },
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForReal(pred: () => boolean) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > 2000) {
      throw new Error('waitForReal timed out');
    }
    await sleep(5);
  }
}
afterEach(resetResizerForTests);

describe('SqsTaskQueue.add', () => {
  test('sends the default queue to opts.queueUrl with the task JSON body and returns MessageId', async () => {
    const { client, sent } = makeFakeSqsClient({ messageId: 'mid-1' });
    const tasks = new SqsTaskQueue({
      queueUrl: 'https://q/url',
      region: 'us-east-1',
      queues: { bulk: BULK_URL },
      client,
    });
    const res = await tasks.add(newTask());
    assert.equal(res.taskId, 'mid-1');
    assert.equal(sent[0].input.QueueUrl, 'https://q/url');
    assert.deepEqual(JSON.parse(String(sent[0].input.MessageBody)), {
      resizer: 'default',
      queue: 'default',
      mediaId: 'm1',
      pipeline: 'photo',
      previews: [variant()],
    });
  });
  test('a named queue is sent to its URL from `queues`, and the body names resizer and queue', async () => {
    const { client, sent } = makeFakeSqsClient({ messageId: 'mid-2' });
    const tasks = new SqsTaskQueue({
      queueUrl: 'https://q/url',
      queues: { bulk: BULK_URL },
      client,
    });
    await tasks.add(newTask({ resizer: 'listings', queue: 'bulk' }));
    assert.equal(sent[0].input.QueueUrl, BULK_URL);
    const body = JSON.parse(String(sent[0].input.MessageBody));
    assert.equal(body.resizer, 'listings');
    assert.equal(body.queue, 'bulk');
  });
  test('an unknown queue rejects with RESIZE_SQS_QUEUE_UNKNOWN and sends nothing', async () => {
    const { client, sent } = makeFakeSqsClient({ messageId: 'unused' });
    const tasks = new SqsTaskQueue({ queueUrl: 'q', client });
    await assert.rejects(
      () => tasks.add(newTask({ queue: 'bulk' })),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_SQS_QUEUE_UNKNOWN' &&
        err.message.includes("'bulk'"),
    );
    assert.equal(sent.length, 0);
  });
  test('returns a null taskId when the send response has no MessageId', async () => {
    const { client } = makeFakeSqsClient();
    const tasks = new SqsTaskQueue({ queueUrl: 'q', client });
    assert.equal((await tasks.add(newTask())).taskId, null);
  });
  test('prewarm accepts a successful SQS MessageId receipt', async () => {
    const { client } = makeFakeSqsClient({ messageId: 'mid-strict' });
    const tasks = new SqsTaskQueue({ queueUrl: 'q', client });
    const resizer = new Resizer({
      config: makeImageConfig(),
      storage: {
        download: async () => Buffer.alloc(0),
        upload: async ({ key }) => ({ key }),
        publicUrl: () => '',
      },
      db: fakeDb(),
      tasks,
    });
    const result = await resizer.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'original.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(result.status, 'accepted');
    assert.equal(result.tasks[0].taskId, 'mid-strict');
  });
  test('prewarm leaves an SQS lock loser unconfirmed (SQS has no lookup)', async () => {
    const { client, sent } = makeFakeSqsClient({ messageId: 'unused' });
    const tasks = new SqsTaskQueue({ queueUrl: 'q', client });
    const resizer = new Resizer({
      config: makeImageConfig(),
      storage: {
        download: async () => Buffer.alloc(0),
        upload: async ({ key }) => ({ key }),
        publicUrl: () => '',
      },
      db: fakeDb({
        locks: { acquire: async () => false, release: async () => {} },
      }),
      tasks,
    });
    const result = await resizer.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'original.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_LOCK_CONTENDED');
    assert.equal(sent.length, 0);
  });
});

describe('SqsTaskQueue.claim', () => {
  test('a malformed message body is logged and left for SQS redelivery without calling the handler', async (t) => {
    // Malformed messages never become tasks, so claim logs them without task events.
    const { errors, logger } = recordingLogger();
    const { client, deletes } = makeFakeSqsClient({
      message: message({ Body: 'not json{{{' }),
    });
    const tasks = new SqsTaskQueue({
      queueUrl: 'q',
      client,
      logger,
      timing: fastTiming,
    });
    const rec = makeEvents();
    let handlerCalls = 0;
    const ctrl = new AbortController();
    const loop = consumeQueue(tasks, {
      signal: ctrl.signal,
      queue: 'default',
      handle: async () => {
        handlerCalls += 1;
      },
      onEvent: rec.onEvent,
      logger,
    });
    t.after(async () => {
      ctrl.abort();
      await loop;
    });
    await waitForReal(() => errors.length >= 1);
    assert.equal(handlerCalls, 0);
    assert.deepEqual(rec.completed, []);
    assert.deepEqual(rec.failed, []);
    assert.deepEqual(rec.deadLettered, []);
    assert.equal(deletes.length, 0);
    assert.match(String(errors[0][0]), /malformed task body.*mid/);
  });
  test('uses the lease as visibility timeout, including the default queue timing', async () => {
    const { client, receiveParams } = makeFakeSqsClient();
    const tasks = new SqsTaskQueue({
      queueUrl: 'q',
      client,
      timing: {
        leaseMs: 30_000,
        lockTtlMs: { dispatch: 60_000, worker: 30_000 },
      },
    });
    await tasks.claim('default', timingOf(tasks).leaseMs);
    assert.equal(receiveParams[0].VisibilityTimeout, 30);
    const { client: client2, receiveParams: receiveParams2 } =
      makeFakeSqsClient();
    const defaults = new SqsTaskQueue({ queueUrl: 'q', client: client2 });
    await defaults.claim('default', timingOf(defaults).leaseMs);
    assert.equal(receiveParams2[0].VisibilityTimeout, 60);
  });
  test('a named queue is consumed from its URL in `queues`', async () => {
    const { client, receiveParams } = makeFakeSqsClient();
    const tasks = new SqsTaskQueue({
      queueUrl: 'q',
      queues: { bulk: BULK_URL },
      client,
    });
    await tasks.claim('bulk', 60_000);
    assert.equal(receiveParams[0].QueueUrl, BULK_URL);
  });
  test('an unknown queue rejects with RESIZE_SQS_QUEUE_UNKNOWN before polling', async () => {
    const { client, receiveParams } = makeFakeSqsClient();
    const tasks = new SqsTaskQueue({ queueUrl: 'q', client });
    await assert.rejects(
      () => tasks.claim('bulk', 60_000),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_SQS_QUEUE_UNKNOWN',
    );
    assert.equal(receiveParams.length, 0);
  });
  test('a body naming resizer and queue becomes the claimed task with its receipt and attempt count', async () => {
    const { client, receiveParams, receiveOptions } = makeFakeSqsClient({
      message: message({
        Body: JSON.stringify({
          resizer: 'listings',
          queue: 'bulk',
          mediaId: 'm1',
          pipeline: 'photo',
          previews: [variant()],
        }),
        Attributes: { ApproximateReceiveCount: '3' },
      }),
    });
    const tasks = new SqsTaskQueue({
      queueUrl: 'q',
      queues: { bulk: BULK_URL },
      client,
      waitTimeSeconds: 7,
    });
    const ctrl = new AbortController();
    const task = await tasks.claim('bulk', 1250, ctrl.signal);
    assert.deepEqual(
      task,
      claimedTask({
        resizer: 'listings',
        queue: 'bulk',
        token: JSON.stringify([BULK_URL, 'rh']),
        attempts: 3,
      }),
    );
    assert.deepEqual(receiveParams[0], {
      QueueUrl: BULK_URL,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 7,
      VisibilityTimeout: 2,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    });
    assert.equal(receiveOptions[0].abortSignal, ctrl.signal);
  });
  test('a body without resizer/queue reads as the default Resizer on the consumed queue', async () => {
    const { client } = makeFakeSqsClient({ message: message() });
    const tasks = new SqsTaskQueue({
      queueUrl: 'q',
      queues: { bulk: BULK_URL },
      client,
    });
    const task = await tasks.claim('bulk', 60_000);
    assert.equal(task.resizer, 'default');
    assert.equal(task.queue, 'bulk');
    assert.equal(task.attempts, 1);
  });
  test('long-polls 10 seconds by default, and the queue named in the body wins', async () => {
    const { client, receiveParams } = makeFakeSqsClient({
      message: message({
        Body: JSON.stringify({
          resizer: 'listings',
          queue: 'bulk',
          mediaId: 'm1',
          pipeline: 'photo',
          previews: [variant()],
        }),
      }),
    });
    const tasks = new SqsTaskQueue({
      queueUrl: 'q',
      queues: { bulk: BULK_URL },
      client,
    });
    const task = await tasks.claim('default', 60_000);
    assert.equal(receiveParams[0].WaitTimeSeconds, 10);
    assert.equal(receiveParams[0].QueueUrl, 'q');
    assert.equal(task?.queue, 'bulk');
  });
  test('empty receives and messages without a receipt handle return null', async () => {
    const { client } = makeFakeSqsClient({
      message: message({ ReceiptHandle: undefined }),
    });
    const tasks = new SqsTaskQueue({ queueUrl: 'q', client });
    assert.equal(await tasks.claim('default', 60_000), null);
    assert.equal(await tasks.claim('default', 60_000), null);
  });
  test('a missing MessageId falls back to the receipt handle', async () => {
    const { client } = makeFakeSqsClient({
      message: message({ MessageId: undefined }),
    });
    const tasks = new SqsTaskQueue({ queueUrl: 'q', client });
    assert.equal((await tasks.claim('default', 60_000)).taskId, 'rh');
  });
  test('malformed task bodies go to the configured dead-letter queue before deletion', async () => {
    for (const body of ['not json{{{', JSON.stringify({ mediaId: 'm1' })]) {
      const { client, commands, sent, deletes } = makeFakeSqsClient({
        message: message({ Body: body }),
      });
      const { logger } = recordingLogger();
      const tasks = new SqsTaskQueue({
        queueUrl: 'q',
        client,
        logger,
        deadLetterQueueUrl: DEAD_URL,
      });
      assert.equal(await tasks.claim('default', 60_000), null);
      assert.deepEqual(
        commands.map((cmd) => cmd.constructor.name),
        ['ReceiveMessageCommand', 'SendMessageCommand', 'DeleteMessageCommand'],
      );
      assert.deepEqual(sent[0].input, {
        QueueUrl: DEAD_URL,
        MessageBody: body,
      });
      assert.deepEqual(deletes[0], { QueueUrl: 'q', ReceiptHandle: 'rh' });
    }
  });
});

describe('SqsTaskQueue lease operations', () => {
  test('renew and complete use the queue URL and receipt in the token', async () => {
    const { client, changeVis, deletes } = makeFakeSqsClient();
    const tasks = new SqsTaskQueue({ queueUrl: 'q', client });
    const task = claimedTask({
      queue: 'bulk',
      token: JSON.stringify([BULK_URL, 'bulk-rh']),
    });
    assert.equal(await tasks.renew(task, 1250), true);
    assert.deepEqual(changeVis[0], {
      QueueUrl: BULK_URL,
      ReceiptHandle: 'bulk-rh',
      VisibilityTimeout: 2,
    });
    assert.equal(await tasks.complete(task), true);
    assert.deepEqual(deletes[0], {
      QueueUrl: BULK_URL,
      ReceiptHandle: 'bulk-rh',
    });
  });
  test('retry changes visibility to the retry delay without deleting the message', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const { client, changeVis, deletes } = makeFakeSqsClient();
    const tasks = new SqsTaskQueue({ queueUrl: 'q', client });
    for (const [delayMs, visibility] of [
      [1250, 2],
      [-1000, 0],
      [43_200_001, 43_200],
    ]) {
      assert.equal(
        await tasks.fail(
          claimedTask(),
          { retryAt: new Date(Date.now() + delayMs) },
          'retry',
        ),
        true,
      );
      assert.deepEqual(changeVis.at(-1), {
        QueueUrl: 'q',
        ReceiptHandle: 'rh',
        VisibilityTimeout: visibility,
      });
    }
    assert.equal(deletes.length, 0);
  });
  test('a dead task is sent with its error and attempt count before deletion', async () => {
    const { client, commands, sent, deletes } = makeFakeSqsClient();
    const tasks = new SqsTaskQueue({
      queueUrl: 'q',
      client,
      deadLetterQueueUrl: DEAD_URL,
    });
    assert.equal(
      await tasks.fail(claimedTask({ attempts: 5 }), 'dead', 'handler boom'),
      true,
    );
    assert.deepEqual(
      commands.map((cmd) => cmd.constructor.name),
      ['SendMessageCommand', 'DeleteMessageCommand'],
    );
    assert.equal(sent[0].input.QueueUrl, DEAD_URL);
    assert.deepEqual(JSON.parse(String(sent[0].input.MessageBody)), {
      resizer: 'default',
      queue: 'default',
      mediaId: 'm1',
      pipeline: 'photo',
      previews: [variant()],
      attempts: 5,
      error: 'handler boom',
    });
    assert.deepEqual(deletes[0], { QueueUrl: 'q', ReceiptHandle: 'rh' });
  });
  test('a dead task whose lease was lost keeps its dead-letter copy and reports false', async () => {
    const { client, sent, deletes } = makeFakeSqsClient({
      outputs: {
        DeleteMessageCommand: [
          Object.assign(new Error('lease lost'), {
            name: 'ReceiptHandleIsInvalid',
          }),
        ],
      },
    });
    const tasks = new SqsTaskQueue({
      queueUrl: 'q',
      client,
      deadLetterQueueUrl: DEAD_URL,
    });
    assert.equal(
      await tasks.fail(claimedTask(), 'dead', 'handler boom'),
      false,
    );
    // copied before the delete: a duplicate in the dead-letter queue, never a lost task
    assert.equal(sent.length, 1);
    assert.equal(sent[0].input.QueueUrl, DEAD_URL);
    assert.equal(deletes.length, 1);
  });
  test('a dead task without a dead-letter queue is logged and deleted', async () => {
    const { client, deletes, sent } = makeFakeSqsClient();
    const { logger, errors } = recordingLogger();
    const tasks = new SqsTaskQueue({ queueUrl: 'q', client, logger });
    assert.equal(await tasks.fail(claimedTask(), 'dead', 'handler boom'), true);
    assert.equal(sent.length, 0);
    assert.equal(deletes.length, 1);
    assert.match(
      String(errors[0][0]),
      /mid is dead.*no deadLetterQueueUrl.*handler boom/,
    );
  });
  test('lost receipt errors report false for renew, complete, and fail', async () => {
    for (const name of [
      'ReceiptHandleIsInvalid',
      'MessageNotInflight',
      'InvalidParameterValue',
    ]) {
      for (const operation of ['renew', 'complete', 'retry', 'dead']) {
        const command =
          operation === 'renew' || operation === 'retry'
            ? 'ChangeMessageVisibilityCommand'
            : 'DeleteMessageCommand';
        const { client } = makeFakeSqsClient({
          outputs: {
            [command]: [Object.assign(new Error('lease lost'), { name })],
          },
        });
        const { logger } = recordingLogger();
        const tasks = new SqsTaskQueue({ queueUrl: 'q', client, logger });
        const task = claimedTask();
        const held =
          operation === 'renew'
            ? await tasks.renew(task, 60_000)
            : operation === 'complete'
              ? await tasks.complete(task)
              : await tasks.fail(
                  task,
                  operation === 'dead' ? 'dead' : { retryAt: new Date() },
                  'failed',
                );
        assert.equal(held, false, `${operation}: ${name}`);
      }
    }
  });
  test('operational errors propagate and a failed dead-letter send leaves the message undeleted', async () => {
    const boom = new Error('AWS unavailable');
    const { client, deletes } = makeFakeSqsClient({
      outputs: {
        ChangeMessageVisibilityCommand: [boom, boom],
        DeleteMessageCommand: [boom],
        SendMessageCommand: [boom],
      },
    });
    const tasks = new SqsTaskQueue({
      queueUrl: 'q',
      client,
      deadLetterQueueUrl: DEAD_URL,
    });
    await assert.rejects(
      () => tasks.renew(claimedTask(), 60_000),
      (err) => err === boom,
    );
    await assert.rejects(
      () => tasks.complete(claimedTask()),
      (err) => err === boom,
    );
    await assert.rejects(
      () => tasks.fail(claimedTask(), { retryAt: new Date() }, 'failed'),
      (err) => err === boom,
    );
    await assert.rejects(
      () => tasks.fail(claimedTask(), 'dead', 'failed'),
      (err) => err === boom,
    );
    assert.equal(deletes.length, 1); // Only the attempted complete, before the dead-letter failure.
  });
});

describe('consumeQueue with SqsTaskQueue', () => {
  test('a resolving handler reports completed and deletes the receipt handle', async () => {
    const { client, deletes } = makeFakeSqsClient({
      message: message({ ReceiptHandle: 'rh-1' }),
    });
    const tasks = new SqsTaskQueue({ queueUrl: 'q', client });
    const rec = makeEvents();
    const seen: LeasedTask[] = [];
    const ctrl = new AbortController();
    let deletesAtEvent = 0;
    await consumeQueue(tasks, {
      signal: ctrl.signal,
      queue: 'default',
      handle: async (task) => {
        seen.push(task);
      },
      onEvent: async (event, task, error) => {
        deletesAtEvent = deletes.length;
        await rec.onEvent(event, task, error);
        ctrl.abort();
      },
    });
    assert.deepEqual(deletes[0], { QueueUrl: 'q', ReceiptHandle: 'rh-1' });
    assert.equal(deletesAtEvent, 1); // The event follows confirmed completion.
    assert.equal(rec.completed.length, 1);
    assert.deepEqual(seen, [rec.completed[0].task]);
    assert.deepEqual(seen[0], {
      taskId: 'mid',
      resizer: 'default',
      queue: 'default',
      mediaId: 'm1',
      pipeline: 'photo',
      previews: [variant()],
    });
  });
  test('a throwing handler reports failed with the original error and schedules redelivery without deletion', async () => {
    const { client, deletes, changeVis } = makeFakeSqsClient({
      message: message(),
    });
    const tasks = new SqsTaskQueue({
      queueUrl: 'q',
      client,
      timing: fastTiming,
    });
    const rec = makeEvents();
    const boom = new Error('handler boom');
    const ctrl = new AbortController();
    await consumeQueue(tasks, {
      signal: ctrl.signal,
      queue: 'default',
      handle: async () => {
        throw boom;
      },
      onEvent: async (event, task, error) => {
        await rec.onEvent(event, task, error);
        ctrl.abort();
      },
    });
    assert.equal(rec.failed[0].err, boom);
    assert.equal(rec.completed.length, 0);
    assert.equal(deletes.length, 0);
    assert.deepEqual(changeVis[0], {
      QueueUrl: 'q',
      ReceiptHandle: 'rh',
      VisibilityTimeout: 1,
    });
  });
  test('recurring claim errors are logged every time and the core keeps polling', async () => {
    const boom1 = new Error('poll fail 1');
    const boom2 = new Error('poll fail 2');
    const { client, receiveParams } = makeFakeSqsClient({
      outputs: { ReceiveMessageCommand: [boom1, boom2] },
    });
    const { errors, logger } = recordingLogger();
    const tasks = new SqsTaskQueue({
      queueUrl: 'q',
      client,
      timing: fastTiming,
    });
    const ctrl = new AbortController();
    await consumeQueue(tasks, {
      signal: ctrl.signal,
      queue: 'default',
      handle: async () => {},
      logger: {
        ...logger,
        error: (...args) => {
          logger.error(...args);
          if (errors.length === 2) {
            ctrl.abort();
          }
        },
      },
    });
    assert.equal(receiveParams.length, 2);
    assert.deepEqual(
      errors.map((entry) => entry[1]),
      [boom1, boom2],
    );
    assert.ok(
      errors.every((entry) =>
        String(entry[0]).includes('claiming a task failed'),
      ),
    );
  });
  test('aborting opts.signal stops polling and resolves consumeQueue', async (t) => {
    const { client, receiveParams, receiveOptions } = makeFakeSqsClient();
    const tasks = new SqsTaskQueue({
      queueUrl: 'q',
      client,
      timing: fastTiming,
    });
    const ctrl = new AbortController();
    const loop = consumeQueue(tasks, {
      signal: ctrl.signal,
      queue: 'default',
      handle: async () => {},
    });
    t.after(async () => {
      ctrl.abort();
      await loop;
    });
    await waitForReal(() => receiveParams.length >= 1);
    ctrl.abort();
    await loop;
    const polls = receiveParams.length;
    await sleep(5);
    assert.equal(receiveParams.length, polls);
    assert.equal(receiveOptions[0].abortSignal, ctrl.signal);
  });
  test('the core heartbeat renews visibility at half the lease while processing', async (t) => {
    const { client, changeVis, deletes } = makeFakeSqsClient({
      message: message(),
    });
    const tasks = new SqsTaskQueue({
      queueUrl: 'q',
      client,
      timing: {
        ...fastTiming,
        leaseMs: 20,
        lockTtlMs: { dispatch: 20, worker: 20 },
      },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ctrl = new AbortController();
    const loop = consumeQueue(tasks, {
      signal: ctrl.signal,
      queue: 'default',
      handle: async () => {
        await gate;
      },
      onEvent: () => ctrl.abort(),
    });
    t.after(async () => {
      release();
      ctrl.abort();
      await loop;
    });
    await waitForReal(() => changeVis.length >= 1);
    assert.deepEqual(changeVis[0], {
      QueueUrl: 'q',
      ReceiptHandle: 'rh',
      VisibilityTimeout: 1,
    });
    release();
    await loop;
    assert.equal(deletes.length, 1);
    const renewals = changeVis.length;
    await sleep(20);
    assert.equal(changeVis.length, renewals);
  });
  test('a throwing completed observer is logged after the message is deleted', async () => {
    const { errors, logger } = recordingLogger();
    const { client, deletes } = makeFakeSqsClient({
      message: message({ ReceiptHandle: 'rh-ok' }),
    });
    const tasks = new SqsTaskQueue({ queueUrl: 'q', client });
    const ctrl = new AbortController();
    await consumeQueue(tasks, {
      signal: ctrl.signal,
      queue: 'default',
      handle: async () => {},
      logger,
      onEvent: () => {
        ctrl.abort();
        throw new Error('observer bug');
      },
    });
    assert.equal(deletes[0].ReceiptHandle, 'rh-ok');
    assert.equal(errors[0][0], 'resize worker: completed event handler failed');
  });
  test('a throwing failed observer is logged and leaves the message scheduled for redelivery', async () => {
    const { errors, logger } = recordingLogger();
    const { client, deletes, changeVis } = makeFakeSqsClient({
      message: message(),
    });
    const tasks = new SqsTaskQueue({
      queueUrl: 'q',
      client,
      timing: fastTiming,
    });
    let handlerCalls = 0;
    const ctrl = new AbortController();
    await consumeQueue(tasks, {
      signal: ctrl.signal,
      queue: 'default',
      logger,
      handle: async () => {
        handlerCalls += 1;
        throw new Error('handler boom');
      },
      onEvent: async () => {
        ctrl.abort();
        throw new Error('observer bug');
      },
    });
    assert.equal(handlerCalls, 1);
    assert.equal(deletes.length, 0);
    assert.equal(changeVis.length, 1);
    assert.equal(errors[0][0], 'resize worker: failed event handler failed');
  });
  test('an exhausted task reports deadLettered with the original error and is moved then deleted', async () => {
    const { client, sent, deletes, changeVis } = makeFakeSqsClient({
      message: message({ Attributes: { ApproximateReceiveCount: '3' } }),
    });
    const tasks = new SqsTaskQueue({
      queueUrl: 'q',
      client,
      deadLetterQueueUrl: DEAD_URL,
      timing: { maxAttempts: 3 },
    });
    const rec = makeEvents();
    const boom = new Error('handler boom');
    const ctrl = new AbortController();
    await consumeQueue(tasks, {
      signal: ctrl.signal,
      queue: 'default',
      handle: async () => {
        throw boom;
      },
      onEvent: async (event, task, error) => {
        await rec.onEvent(event, task, error);
        ctrl.abort();
      },
    });
    assert.equal(rec.deadLettered[0].err, boom);
    assert.equal(rec.failed.length, 0);
    assert.equal(sent[0].input.QueueUrl, DEAD_URL);
    assert.equal(JSON.parse(String(sent[0].input.MessageBody)).attempts, 3);
    assert.equal(deletes.length, 1);
    assert.equal(changeVis.length, 0);
  });
});

describe('SqsTaskQueue options', () => {
  test('rejects invalid lock TTLs at construction', () => {
    assert.throws(
      () =>
        new SqsTaskQueue({
          queueUrl: 'q',
          timing: { lockTtlMs: { dispatch: 0, worker: 0 } },
        }),
      (err: Error & { code?: string }) =>
        err.code === 'RESIZE_CONFIG_QUEUE_LOCK_TTL_INVALID',
    );
  });
  test('requires queueUrl at construction', () => {
    assert.throws(
      () => new SqsTaskQueue({ queueUrl: '' }),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_SQS_QUEUE_URL_REQUIRED',
    );
  });
  test('serves only the default queue and configured names and exposes its timing', () => {
    const timing = { idlePollMs: 123 };
    const tasks = new SqsTaskQueue({
      queueUrl: 'q',
      queues: { bulk: BULK_URL },
      timing,
    });
    assert.equal(tasks.servesQueue('default'), true);
    assert.equal(tasks.servesQueue('bulk'), true);
    assert.equal(tasks.servesQueue('unknown'), false);
    assert.equal(tasks.getTiming(), timing);
    assert.deepEqual(new SqsTaskQueue({ queueUrl: 'q' }).getTiming(), {});
  });
});
