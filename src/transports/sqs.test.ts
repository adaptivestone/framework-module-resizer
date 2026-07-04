import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import { Resizer, resetResizerForTests } from '../resizer.ts';
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
  setAppInstance({
    getConfig: () => ({ mediaModelName: 'File' }),
    getModel: () => ({}),
    logger: {
      info() {},
      warn() {},
      error(...a: unknown[]) {
        errors.push(a);
      },
    },
  } as never);
  return { errors };
}

interface Recorder {
  completed: { task: unknown }[];
  failed: { task: unknown; err: unknown }[];
}
function makeRecordingResizer(transport: SqsTransport) {
  const rec: Recorder = { completed: [], failed: [] };
  new Resizer({
    storage: {
      download: async () => Buffer.alloc(0),
      upload: async () => ({ key: 'k' }),
      publicUrl: () => '',
    },
    transport,
    hooks: {
      afterTaskComplete: (task: unknown) => {
        rec.completed.push({ task });
      },
      onTaskFailed: (task: unknown, err: unknown) => {
        rec.failed.push({ task, err });
      },
    },
  });
  return rec;
}

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
  test('sends to opts.queueUrl with the {mediaId,pipeline,previews} JSON body and returns MessageId', async () => {
    const { client, sent } = makeFakeSqsClient({ messageId: 'mid-1' });
    const t = new SqsTransport({
      queueUrl: 'https://q/url',
      region: 'us-east-1',
      client,
    });
    const res = await t.enqueue({
      mediaId: 'm1',
      pipeline: 'photo',
      previews: [variant()],
    });
    assert.equal(res.taskId, 'mid-1');
    assert.equal(sent[0].input.QueueUrl, 'https://q/url');
    assert.deepEqual(JSON.parse(String(sent[0].input.MessageBody)), {
      mediaId: 'm1',
      pipeline: 'photo',
      previews: [variant()],
    });
  });

  test('returns a null taskId when the send response has no MessageId', async () => {
    const { client } = makeFakeSqsClient({ messageId: undefined });
    const t = new SqsTransport({ queueUrl: 'q', client });
    const res = await t.enqueue({ mediaId: 'm1', pipeline: 'p', previews: [] });
    assert.equal(res.taskId, null);
  });
});

// ---------------------------------------------------------------------------
// startWorker (05 · §10.3) — drives the REAL sqs-consumer with the fake client
// ---------------------------------------------------------------------------

describe('SqsTransport.startWorker', () => {
  test('a resolving handleTask fires afterTaskComplete and acks (DeleteMessage on the receipt handle)', async () => {
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
    const t = new SqsTransport({ queueUrl: 'q', client });
    const rec = makeRecordingResizer(t);
    const ctrl = new AbortController();
    const p = t.startWorker(
      async (task) => {
        seen.push(task);
      },
      { signal: ctrl.signal },
    );
    // The ack (DeleteMessage) is sent AFTER handleMessage returns, i.e. after
    // afterTaskComplete has fired — so a delivered delete proves the whole round-trip.
    await waitForReal(() => deletes.length >= 1);
    assert.equal(deletes[0].ReceiptHandle, 'rh-1');
    assert.equal(rec.completed.length, 1);
    assert.equal(seen.length, 1);
    assert.equal((rec.completed[0].task as { mediaId: string }).mediaId, 'm1');
    ctrl.abort();
    await p;
  });

  test('a throwing handleTask fires onTaskFailed with the ORIGINAL error and does NOT ack (SQS redelivers)', async () => {
    installFakeApp();
    const message: FakeMessage = {
      MessageId: 'mid',
      ReceiptHandle: 'rh',
      Body: JSON.stringify({ mediaId: 'm1', pipeline: 'p', previews: [] }),
    };
    const { client, deletes } = makeFakeSqsClient({ message });
    const boom = new Error('handler boom');
    const t = new SqsTransport({ queueUrl: 'q', client });
    const rec = makeRecordingResizer(t);
    const ctrl = new AbortController();
    const p = t.startWorker(
      async () => {
        throw boom;
      },
      { signal: ctrl.signal },
    );
    await waitForReal(() => rec.failed.length >= 1);
    assert.equal(rec.failed[0].err, boom); // driver rethrows the original error to observers
    assert.equal(rec.completed.length, 0);
    await sleep(20); // let a couple more polls run — still no ack
    assert.equal(deletes.length, 0); // not deleted → left for SQS to redeliver
    ctrl.abort();
    await p;
  });

  test('aborting opts.signal stops the consumer and resolves startWorker', async () => {
    installFakeApp();
    const { client, receiveParams } = makeFakeSqsClient({});
    const t = new SqsTransport({ queueUrl: 'q', client });
    makeRecordingResizer(t);
    const ctrl = new AbortController();
    const p = t.startWorker(async () => {}, { signal: ctrl.signal });
    await waitForReal(() => receiveParams.length >= 1); // consumer started + polling
    ctrl.abort();
    await p; // resolves only when the consumer emits 'stopped'
    assert.ok(receiveParams.length >= 1);
  });

  test('passes visibilityTimeout to the consumer (observed in ReceiveMessage params) — absent when not provided', async () => {
    installFakeApp();
    const { client, receiveParams } = makeFakeSqsClient({});
    const t = new SqsTransport({
      queueUrl: 'q',
      visibilityTimeout: 30,
      client,
    });
    makeRecordingResizer(t);
    const ctrl = new AbortController();
    const p = t.startWorker(async () => {}, { signal: ctrl.signal });
    await waitForReal(() => receiveParams.length >= 1);
    assert.equal(receiveParams[0].VisibilityTimeout, 30);
    ctrl.abort();
    await p;

    resetResizerForTests();
    const { client: client2, receiveParams: rp2 } = makeFakeSqsClient({});
    const t2 = new SqsTransport({ queueUrl: 'q', client: client2 });
    makeRecordingResizer(t2);
    const ctrl2 = new AbortController();
    const p2 = t2.startWorker(async () => {}, { signal: ctrl2.signal });
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
      queueUrl: 'q',
      visibilityTimeout: 1,
      heartbeatInterval: 0.01,
      client,
    });
    makeRecordingResizer(t);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const ctrl = new AbortController();
    const p = t.startWorker(
      async () => {
        await gate;
      },
      { signal: ctrl.signal },
    );
    // A ChangeMessageVisibility while the handler is gated proves heartbeatInterval was wired.
    await waitForReal(() => changeVis.length >= 1);
    assert.equal(changeVis[0].VisibilityTimeout, 1); // renews to the configured visibilityTimeout
    release(); // let the handler finish → heartbeat interval cleared → message acked
    await waitForReal(() => deletes.length >= 1);
    ctrl.abort();
    await p;
  });
});
