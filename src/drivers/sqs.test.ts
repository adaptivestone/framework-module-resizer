import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import { ResizeSetupError } from '../errors.ts';
import { createFrameworkResizer } from '../framework/resizer.ts';
import {
  type LeasedTask,
  resetResizerForTests,
  type TaskEventHandler,
} from '../resizer.ts';
import { makeResizeConfig } from '../testHelpers/resizeConfig.ts';
import { memoryLocks } from '../testHelpers/withLocks.ts';
import type { MissingPreview } from '../types.d.ts';
import { SqsTransport } from './sqs.ts';

// No live AWS and NO test-only seam in the driver. The driver statically imports
// `@aws-sdk/client-sqs` for the command classes and `sqs-consumer` for the Consumer (both
// installed as devDeps here), but the CLIENT is a legitimate public option (`client?:
// SQSClient`) — bring-your-own configured instance. We pass a fake client whose recording
// `send(cmd)` inspects the REAL command's `constructor.name` + `cmd.input`. For `startWorker`
// we drive the REAL `sqs-consumer` (which natively accepts an injected `sqs` client) through
// a fake implementing the ReceiveMessage → handler → DeleteMessage round-trip.

interface FakeCommand {
  input: Record<string, unknown>;
  constructor: { name: string };
}
interface FakeMessage {
  MessageId?: string;
  Body?: string;
  ReceiptHandle?: string;
}

// A recording fake SQS client covering both the enqueue path (SendMessageCommand) and the
// consumer poll loop (ReceiveMessage → one message, then empties; DeleteMessage / ChangeVis
// recorded). Routes on the REAL command's `constructor.name`.
function makeFakeSqsClient(
  opts: { messageId?: string; message?: FakeMessage } = {},
) {
  const sent: FakeCommand[] = [];
  const deletes: Record<string, unknown>[] = [];
  const changeVis: Record<string, unknown>[] = [];
  const receiveParams: Record<string, unknown>[] = [];
  let delivered = false;
  const client = {
    async send(command: FakeCommand) {
      switch (command.constructor.name) {
        case 'ReceiveMessageCommand':
          receiveParams.push(command.input);
          if (opts.message && !delivered) {
            delivered = true;
            return { Messages: [opts.message] };
          }
          return {}; // empty poll
        case 'DeleteMessageCommand':
          deletes.push(command.input);
          return {};
        case 'ChangeMessageVisibilityCommand':
          changeVis.push(command.input);
          return {};
        default: // SendMessageCommand (enqueue)
          sent.push(command);
          return { MessageId: opts.messageId };
      }
    },
  };
  return { client, sent, deletes, changeVis, receiveParams };
}

const variant = (over: Partial<MissingPreview> = {}): MissingPreview => ({
  sizeKey: '300x300',
  format: 'jpeg',
  ...over,
});

function installFakeApp() {
  const errors: unknown[][] = [];
  const logger = {
    info() {},
    warn() {},
    error(...a: unknown[]) {
      errors.push(a);
    },
  };
  setAppInstance({
    getConfig: () => makeResizeConfig(),
    getModel: () => ({}),
    logger,
  } as never);
  return { errors, logger };
}

// Task events are reported through the startWorker `onEvent` callback (the worker routes them
// to the owning Resizer's observers); this recorder stands in for it.
interface Recorder {
  completed: { task: LeasedTask }[];
  failed: { task: LeasedTask; err: unknown }[];
  onEvent: TaskEventHandler;
}
function makeEvents(): Recorder {
  const rec = { completed: [], failed: [] } as unknown as Recorder;
  rec.onEvent = (event, task, error) => {
    if (event === 'completed') {
      rec.completed.push({ task });
    }
    if (event === 'failed') {
      rec.failed.push({ task, err: error });
    }
  };
  return rec;
}

const BULK_URL = 'https://q/bulk';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitForReal(
  pred: () => boolean,
  {
    timeoutMs = 2000,
    stepMs = 5,
  }: { timeoutMs?: number; stepMs?: number } = {},
) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitForReal timed out');
    }
    await sleep(stepMs);
  }
}

afterEach(() => {
  resetResizerForTests();
  resetAppInstance();
});

// ---------------------------------------------------------------------------
// enqueue (05 · §10.3) — via the fake client passed as the `client` option
// ---------------------------------------------------------------------------

describe('SqsTransport.enqueue', () => {
  test('sends the default queue to opts.queueUrl with the task JSON body and returns MessageId', async () => {
    const { client, sent } = makeFakeSqsClient({ messageId: 'mid-1' });
    const t = new SqsTransport({
      locks: memoryLocks(),
      queueUrl: 'https://q/url',
      region: 'us-east-1',
      queues: { bulk: BULK_URL },
      client,
    });
    const res = await t.enqueue({
      resizer: 'default',
      queue: 'default',
      mediaId: 'm1',
      pipeline: 'photo',
      previews: [variant()],
    });
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
    const t = new SqsTransport({
      locks: memoryLocks(),
      queueUrl: 'https://q/url',
      queues: { bulk: BULK_URL },
      client,
    });
    await t.enqueue({
      resizer: 'listings',
      queue: 'bulk',
      mediaId: 'm1',
      pipeline: 'photo',
      previews: [variant()],
    });
    assert.equal(sent[0].input.QueueUrl, BULK_URL);
    const body = JSON.parse(String(sent[0].input.MessageBody));
    assert.equal(body.resizer, 'listings');
    assert.equal(body.queue, 'bulk');
  });

  test('an unknown queue rejects with RESIZE_SQS_QUEUE_UNKNOWN and sends nothing', async () => {
    const { client, sent } = makeFakeSqsClient({ messageId: 'unused' });
    const t = new SqsTransport({ locks: memoryLocks(), queueUrl: 'q', client });
    await assert.rejects(
      () =>
        t.enqueue({
          resizer: 'default',
          queue: 'bulk',
          mediaId: 'm1',
          pipeline: 'p',
          previews: [],
        }),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_SQS_QUEUE_UNKNOWN' &&
        err.message.includes("'bulk'"),
    );
    assert.equal(sent.length, 0);
  });

  test('returns a null taskId when the send response has no MessageId', async () => {
    const { client } = makeFakeSqsClient({ messageId: undefined });
    const t = new SqsTransport({ locks: memoryLocks(), queueUrl: 'q', client });
    const res = await t.enqueue({
      resizer: 'default',
      queue: 'default',
      mediaId: 'm1',
      pipeline: 'p',
      previews: [],
    });
    assert.equal(res.taskId, null);
  });

  test('prewarm accepts a successful SQS MessageId receipt', async () => {
    installFakeApp();
    const { client } = makeFakeSqsClient({ messageId: 'mid-strict' });
    const transport = new SqsTransport({
      queueUrl: 'q',
      client,
      locks: { acquire: async () => true, release: async () => {} },
    });
    const r = createFrameworkResizer({
      storage: {
        download: async () => Buffer.alloc(0),
        upload: async ({ key }) => ({ key }),
        publicUrl: () => '',
      },
      transport,
    });
    const result = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'original.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(result.status, 'accepted');
    assert.equal(result.tasks[0].taskId, 'mid-strict');
  });

  test('prewarm leaves an SQS lock loser unconfirmed (SQS has no lookup)', async () => {
    installFakeApp();
    const { client, sent } = makeFakeSqsClient({ messageId: 'unused' });
    const transport = new SqsTransport({
      queueUrl: 'q',
      client,
      locks: { acquire: async () => false, release: async () => {} },
    });
    const r = createFrameworkResizer({
      storage: {
        download: async () => Buffer.alloc(0),
        upload: async ({ key }) => ({ key }),
        publicUrl: () => '',
      },
      transport,
    });
    const result = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'original.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_LOCK_CONTENDED');
    assert.equal(sent.length, 0);
  });
});

// ---------------------------------------------------------------------------
// startWorker (05 · §10.3) — drives the REAL sqs-consumer with the fake client
// ---------------------------------------------------------------------------

describe('SqsTransport.startWorker', () => {
  test('a resolving handleTask reports completed and acks (DeleteMessage on the receipt handle)', async () => {
    installFakeApp();
    const message: FakeMessage = {
      MessageId: 'mid',
      ReceiptHandle: 'rh-1',
      Body: JSON.stringify({
        mediaId: 'm1',
        pipeline: 'photo',
        previews: [variant()],
      }),
    };
    const { client, deletes } = makeFakeSqsClient({ message });
    const seen: unknown[] = [];
    const t = new SqsTransport({ locks: memoryLocks(), queueUrl: 'q', client });
    const rec = makeEvents();
    const ctrl = new AbortController();
    const p = t.startWorker(
      async (task) => {
        seen.push(task);
      },
      { signal: ctrl.signal, queue: 'default', onEvent: rec.onEvent },
    );
    // The ack (DeleteMessage) is sent AFTER handleMessage returns, i.e. after the completed
    // event was reported — so a delivered delete proves the whole round-trip.
    await waitForReal(() => deletes.length >= 1);
    assert.equal(deletes[0].ReceiptHandle, 'rh-1');
    assert.equal(rec.completed.length, 1);
    assert.equal(seen.length, 1);
    assert.equal(rec.completed[0].task.mediaId, 'm1');
    ctrl.abort();
    await p;
  });

  test('a throwing handleTask reports failed with the ORIGINAL error and does NOT ack (SQS redelivers)', async () => {
    installFakeApp();
    const message: FakeMessage = {
      MessageId: 'mid',
      ReceiptHandle: 'rh',
      Body: JSON.stringify({ mediaId: 'm1', pipeline: 'p', previews: [] }),
    };
    const { client, deletes } = makeFakeSqsClient({ message });
    const boom = new Error('handler boom');
    const t = new SqsTransport({ locks: memoryLocks(), queueUrl: 'q', client });
    const rec = makeEvents();
    const ctrl = new AbortController();
    const p = t.startWorker(
      async () => {
        throw boom;
      },
      { signal: ctrl.signal, queue: 'default', onEvent: rec.onEvent },
    );
    await waitForReal(() => rec.failed.length >= 1);
    assert.equal(rec.failed[0].err, boom); // the original error reaches the event callback
    assert.equal(rec.completed.length, 0);
    await sleep(20); // let a couple more polls run — still no ack
    assert.equal(deletes.length, 0); // not deleted → left for SQS to redeliver
    ctrl.abort();
    await p;
  });

  test('a recurring consumer error is logged EVERY time (on, not once)', async () => {
    // Recurring consumer errors (e.g. heartbeat ChangeMessageVisibility failures) must all be
    // logged: `once` would capture only the FIRST and drop every later one (05 · §10.3 fix a).
    const { errors, logger } = installFakeApp();
    let polls = 0;
    const client = {
      async send(command: FakeCommand) {
        if (command.constructor.name === 'ReceiveMessageCommand') {
          polls += 1;
          throw new Error(`poll fail ${polls}`);
        }
        return {};
      },
    };
    const t = new SqsTransport({
      locks: memoryLocks(),
      queueUrl: 'q',
      client,
      logger,
    });
    const ctrl = new AbortController();
    const p = t.startWorker(async () => {}, {
      signal: ctrl.signal,
      queue: 'default',
    });
    const consumerErrors = () =>
      errors.filter((e) => e[0] === 'resize sqs consumer error');
    await waitForReal(() => consumerErrors().length >= 2);
    assert.ok(consumerErrors().length >= 2);
    ctrl.abort();
    await p;
  });

  test('a malformed message body reports failed then rethrows (no ack; SQS redelivers)', async () => {
    // The body JSON.parse runs INSIDE the guarded region: a malformed body reports failed
    // before rethrowing, consistent with a handler throw.
    installFakeApp();
    const message: FakeMessage = {
      MessageId: 'mid',
      ReceiptHandle: 'rh',
      Body: 'not json{{{',
    };
    const { client, deletes } = makeFakeSqsClient({ message });
    let handlerCalls = 0;
    const t = new SqsTransport({ locks: memoryLocks(), queueUrl: 'q', client });
    const rec = makeEvents();
    const ctrl = new AbortController();
    const p = t.startWorker(
      async () => {
        handlerCalls += 1;
      },
      { signal: ctrl.signal, queue: 'default', onEvent: rec.onEvent },
    );
    await waitForReal(() => rec.failed.length >= 1);
    assert.equal(handlerCalls, 0); // parse failed before the handler ran
    assert.equal(rec.completed.length, 0);
    await sleep(20);
    assert.equal(deletes.length, 0); // not acked → left for SQS to redeliver
    ctrl.abort();
    await p;
  });

  test('aborting opts.signal stops the consumer and resolves startWorker', async () => {
    installFakeApp();
    const { client, receiveParams } = makeFakeSqsClient({});
    const t = new SqsTransport({ locks: memoryLocks(), queueUrl: 'q', client });
    const ctrl = new AbortController();
    const p = t.startWorker(async () => {}, {
      signal: ctrl.signal,
      queue: 'default',
    });
    await waitForReal(() => receiveParams.length >= 1); // consumer started + polling
    ctrl.abort();
    await p; // resolves only when the consumer emits 'stopped'
    assert.ok(receiveParams.length >= 1);
  });

  test('passes visibilityTimeout to the consumer (observed in ReceiveMessage params) — absent when not provided', async () => {
    installFakeApp();
    const { client, receiveParams } = makeFakeSqsClient({});
    const t = new SqsTransport({
      locks: memoryLocks(),
      queueUrl: 'q',
      visibilityTimeout: 30,
      client,
    });
    const ctrl = new AbortController();
    const p = t.startWorker(async () => {}, {
      signal: ctrl.signal,
      queue: 'default',
    });
    await waitForReal(() => receiveParams.length >= 1);
    assert.equal(receiveParams[0].VisibilityTimeout, 30);
    ctrl.abort();
    await p;

    resetResizerForTests();
    const { client: client2, receiveParams: rp2 } = makeFakeSqsClient({});
    const t2 = new SqsTransport({
      locks: memoryLocks(),
      queueUrl: 'q',
      client: client2,
    });
    const ctrl2 = new AbortController();
    const p2 = t2.startWorker(async () => {}, {
      signal: ctrl2.signal,
      queue: 'default',
    });
    await waitForReal(() => rp2.length >= 1);
    assert.equal(rp2[0].VisibilityTimeout, undefined);
    ctrl2.abort();
    await p2;
  });

  test('passes heartbeatInterval to the consumer (heartbeat renews visibility while processing)', async () => {
    installFakeApp();
    const message: FakeMessage = {
      MessageId: 'mid',
      ReceiptHandle: 'rh',
      Body: JSON.stringify({ mediaId: 'm1', pipeline: 'p', previews: [] }),
    };
    const { client, changeVis, deletes } = makeFakeSqsClient({ message });
    // sqs-consumer validation requires heartbeatInterval < visibilityTimeout; a 10ms heartbeat
    // renews visibility repeatedly while the (gated) handler is in flight.
    const t = new SqsTransport({
      locks: memoryLocks(),
      queueUrl: 'q',
      visibilityTimeout: 1,
      heartbeatInterval: 0.01,
      client,
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const ctrl = new AbortController();
    const p = t.startWorker(
      async () => {
        await gate;
      },
      { signal: ctrl.signal, queue: 'default' },
    );
    // A ChangeMessageVisibility while the handler is gated proves heartbeatInterval was wired.
    await waitForReal(() => changeVis.length >= 1);
    assert.equal(changeVis[0].VisibilityTimeout, 1); // renews to the configured visibilityTimeout
    release(); // let the handler finish → heartbeat interval cleared → message acked
    await waitForReal(() => deletes.length >= 1);
    ctrl.abort();
    await p;
  });

  test('a named queue is consumed from its URL in `queues`', async () => {
    installFakeApp();
    const { client, receiveParams } = makeFakeSqsClient({});
    const t = new SqsTransport({
      locks: memoryLocks(),
      queueUrl: 'q',
      queues: { bulk: BULK_URL },
      client,
    });
    const ctrl = new AbortController();
    const p = t.startWorker(async () => {}, {
      signal: ctrl.signal,
      queue: 'bulk',
    });
    await waitForReal(() => receiveParams.length >= 1);
    assert.equal(receiveParams[0].QueueUrl, BULK_URL);
    ctrl.abort();
    await p;
  });

  test('an unknown queue rejects with RESIZE_SQS_QUEUE_UNKNOWN before polling', async () => {
    installFakeApp();
    const { client, receiveParams } = makeFakeSqsClient({});
    const t = new SqsTransport({ locks: memoryLocks(), queueUrl: 'q', client });
    await assert.rejects(
      () =>
        t.startWorker(async () => {}, {
          signal: new AbortController().signal,
          queue: 'bulk',
        }),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_SQS_QUEUE_UNKNOWN',
    );
    assert.equal(receiveParams.length, 0);
  });

  test('a body naming resizer and queue becomes the leased task', async () => {
    installFakeApp();
    const message: FakeMessage = {
      MessageId: 'mid',
      ReceiptHandle: 'rh',
      Body: JSON.stringify({
        resizer: 'listings',
        queue: 'bulk',
        mediaId: 'm1',
        pipeline: 'p',
        previews: [],
      }),
    };
    const { client, deletes } = makeFakeSqsClient({ message });
    const seen: LeasedTask[] = [];
    const t = new SqsTransport({
      locks: memoryLocks(),
      queueUrl: 'q',
      queues: { bulk: BULK_URL },
      client,
    });
    const ctrl = new AbortController();
    const p = t.startWorker(
      async (task) => {
        seen.push(task);
      },
      { signal: ctrl.signal, queue: 'bulk' },
    );
    await waitForReal(() => deletes.length >= 1);
    assert.equal(seen[0].resizer, 'listings');
    assert.equal(seen[0].queue, 'bulk');
    ctrl.abort();
    await p;
  });

  test('a body without resizer/queue reads as the default Resizer on the consumed queue', async () => {
    installFakeApp();
    const message: FakeMessage = {
      MessageId: 'mid',
      ReceiptHandle: 'rh',
      Body: JSON.stringify({ mediaId: 'm1', pipeline: 'p', previews: [] }),
    };
    const { client, deletes } = makeFakeSqsClient({ message });
    const t = new SqsTransport({
      locks: memoryLocks(),
      queueUrl: 'q',
      queues: { bulk: BULK_URL },
      client,
    });
    const rec = makeEvents();
    const ctrl = new AbortController();
    const p = t.startWorker(async () => {}, {
      signal: ctrl.signal,
      queue: 'bulk',
      onEvent: rec.onEvent,
    });
    await waitForReal(() => deletes.length >= 1);
    assert.equal(rec.completed[0].task.resizer, 'default');
    assert.equal(rec.completed[0].task.queue, 'bulk');
    ctrl.abort();
    await p;
  });

  test('a throwing onEvent after success is logged and the message is still acked', async () => {
    const { errors, logger } = installFakeApp();
    const message: FakeMessage = {
      MessageId: 'mid',
      ReceiptHandle: 'rh-ok',
      Body: JSON.stringify({ mediaId: 'm1', pipeline: 'p', previews: [] }),
    };
    const { client, deletes } = makeFakeSqsClient({ message });
    const t = new SqsTransport({
      locks: memoryLocks(),
      queueUrl: 'q',
      client,
      logger,
    });
    const ctrl = new AbortController();
    const p = t.startWorker(async () => {}, {
      signal: ctrl.signal,
      queue: 'default',
      onEvent: () => {
        throw new Error('observer bug');
      },
    });
    await waitForReal(() => deletes.length >= 1);
    assert.equal(deletes[0].ReceiptHandle, 'rh-ok');
    assert.ok(
      errors.some((e) => e[0] === 'resize sqs: completed event handler failed'),
    );
    ctrl.abort();
    await p;
  });

  test('a throwing onEvent after a handler failure is logged and the message is still not acked', async () => {
    const { errors, logger } = installFakeApp();
    const message: FakeMessage = {
      MessageId: 'mid',
      ReceiptHandle: 'rh',
      Body: JSON.stringify({ mediaId: 'm1', pipeline: 'p', previews: [] }),
    };
    const { client, deletes } = makeFakeSqsClient({ message });
    const t = new SqsTransport({
      locks: memoryLocks(),
      queueUrl: 'q',
      client,
      logger,
    });
    let handlerCalls = 0;
    const ctrl = new AbortController();
    const p = t.startWorker(
      async () => {
        handlerCalls += 1;
        throw new Error('handler boom');
      },
      {
        signal: ctrl.signal,
        queue: 'default',
        onEvent: async () => {
          throw new Error('observer bug');
        },
      },
    );
    await waitForReal(() =>
      errors.some((e) => e[0] === 'resize sqs: failed event handler failed'),
    );
    await sleep(20); // a couple more polls — still no ack
    assert.equal(handlerCalls, 1);
    assert.equal(deletes.length, 0);
    ctrl.abort();
    await p;
  });
});
