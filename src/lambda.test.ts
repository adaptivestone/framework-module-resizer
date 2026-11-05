// createSqsHandler, the public way in: real Resizers on a real SqsTaskQueue over a fake SQS client,
// real Sharp, and the real prepareServing checks. The rules of a delivery and of its time are tested
// in src/delivery.test.ts and src/deliveryTiming.test.ts; this is what the entry adds to them: its
// options, the wiring it takes from prepareServing, and the real 2 s margin. Nothing here touches
// AWS. The tests on real time warm the wiring first, so that a slow first check does not eat the time
// they state.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import sharp from 'sharp';
import type { LeasedTask, TaskQueue } from './contracts/taskQueue.ts';
import { batchHandler, type SqsHandler, wiringOf } from './delivery.ts';
import { SqsTaskQueue } from './drivers/sqs.ts';
import { createSqsHandler } from './lambda.ts';
import { NoopMetrics } from './metrics.ts';
import {
  getResizer,
  Resizer,
  type ResizerOptions,
  resetResizerForTests,
} from './resizer.ts';
import { RoutingTaskQueue } from './routing.ts';
import {
  clockLocks,
  fakeMedia,
  MemoryTaskQueue,
  PlainTaskQueue,
  silentLogger,
} from './testHelpers/fakes.ts';
import {
  contextOf,
  deferred,
  type FakeSqs,
  fakeSqs,
  QUEUE_ARN,
  QUEUE_URL,
  recordOf,
} from './testHelpers/pushHarness.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import type { Preview } from './types.d.ts';

const BULK_URL = 'https://sqs.eu-west-1.amazonaws.com/123456789012/resize-bulk';
const BULK_ARN = 'arn:aws:sqs:eu-west-1:123456789012:resize-bulk';

const jpeg = await sharp({
  create: {
    width: 640,
    height: 480,
    channels: 3,
    background: { r: 200, g: 40, b: 40 },
  },
})
  .jpeg()
  .toBuffer();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const sqsQueue = (sqs: FakeSqs): SqsTaskQueue =>
  new SqsTaskQueue({
    queueUrl: QUEUE_URL,
    client: sqs.client as never,
    logger: silentLogger,
  });

/**
 * A real Resizer on a real SqsTaskQueue over `sqs`, reading one JPEG. `rows` holds the media's stored
 * previews by id, and `uploads()` counts its uploads, each of which takes `uploadDelayMs`.
 */
function realResizer(
  over: Partial<ResizerOptions> & {
    sqs?: FakeSqs;
    uploadDelayMs?: number;
    verify?: () => void | Promise<void>;
  } = {},
) {
  const { sqs: given, uploadDelayMs, verify, ...options } = over;
  const sqs = given ?? fakeSqs();
  const rows = new Map<string, Preview[]>();
  let uploads = 0;
  const resizer = new Resizer({
    config: makeImageConfig({ concurrency: 1, formats: ['jpeg'] }),
    logger: silentLogger,
    storage: {
      download: async () => jpeg,
      upload: async ({ key }) => {
        if (uploadDelayMs) {
          await sleep(uploadDelayMs);
        }
        uploads += 1;
        return { key };
      },
      publicUrl: () => '',
    },
    media: fakeMedia({
      previews: rows,
      ...(verify ? { verify } : {}),
      load: async (id) => ({
        id,
        original: {
          storageRef: { key: 'o' },
          format: 'jpeg',
          width: 640,
          height: 480,
        },
        previews: rows.get(id) ?? [],
      }),
    }),
    locks: clockLocks(),
    tasks: sqsQueue(sqs),
    metrics: new NoopMetrics(),
    ...options,
  });
  return { resizer, sqs, rows, uploads: () => uploads };
}

/** A task body with `n` different JPEG variants. */
const bodyOf = (n: number) => ({
  resizer: 'default',
  queue: 'default',
  mediaId: 'm1',
  pipeline: 'default',
  previews: Array.from({ length: n }, (_, i) => ({
    sizeKey: `${16 + i}w`,
    format: 'jpeg',
    requestedWidth: 16 + i,
  })),
  gateOwner: 'g1',
});

/** A logger that keeps each line, with its level, for a test to read. */
const recording = () => {
  const lines: { level: string; message: string }[] = [];
  const line = (level: string) => (message: string) => {
    lines.push({ level, message });
  };
  return {
    lines,
    text: () => lines.map(({ message }) => message).join('\n'),
    logger: {
      info: line('info'),
      warn: line('warn'),
      error: line('error'),
    },
  };
};

/**
 * Run the first invocation's checks now, so that the time of the invocation under test goes to its
 * record alone. The handler keeps them from then on.
 */
const warmed = async (handler: SqsHandler): Promise<SqsHandler> => {
  await handler({ Records: [] }, contextOf(60_000));
  return handler;
};

afterEach(resetResizerForTests);

test('the entry exports createSqsHandler and nothing else at runtime', async () => {
  assert.deepEqual(Object.keys(await import('./lambda.ts')), [
    'createSqsHandler',
  ]);
});

test('createSqsHandler refuses a bad queue option at once', () => {
  for (const queue of ['', [], [' '], [1]]) {
    assert.throws(() => createSqsHandler({ queue: queue as never }), {
      code: 'RESIZE_QUEUE_INVALID',
      message: /^resize lambda: /,
    });
  }
});

test('createSqsHandler refuses a stopBeforeTimeoutMs that is not a whole number of at least 3000 ms', () => {
  for (const stopBeforeTimeoutMs of [
    2999,
    2000,
    1999,
    0,
    -1,
    2500.5,
    3000.5,
    2 ** 53,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '5000',
    null,
  ]) {
    assert.throws(
      () =>
        createSqsHandler({ stopBeforeTimeoutMs: stopBeforeTimeoutMs as never }),
      {
        code: 'RESIZE_CONFIG_INVALID',
        message: /at least 3000: the handler returns 2000 ms before/,
      },
    );
  }
  assert.equal(
    typeof createSqsHandler({ stopBeforeTimeoutMs: 3000 }),
    'function',
  );
  assert.equal(
    typeof createSqsHandler({ stopBeforeTimeoutMs: 3_600_000 }),
    'function',
  );
});

test('the refusal shows the value it got, even one that cannot be printed as JSON', () => {
  assert.throws(() => createSqsHandler({ stopBeforeTimeoutMs: 1n as never }), {
    message: /\(got 1n\)$/,
  });
});

test('a Resizer constructed after createSqsHandler and before the first invocation is served', async () => {
  const handler = createSqsHandler({ logger: silentLogger });
  const { sqs } = realResizer();
  const out = await handler({ Records: [recordOf('a')] }, contextOf(60_000));
  assert.deepEqual(out.batchItemFailures, []);
  assert.equal(sqs.deletes(), 1);
});

test('a Resizer constructed after the first invocation is not served: its task fails with RESIZE_NO_RESIZER and retries', async () => {
  const sqs = fakeSqs();
  const tasks = sqsQueue(sqs);
  realResizer({ sqs, tasks });
  const { logger, text } = recording();
  const handler = await warmed(createSqsHandler({ logger }));
  realResizer({ sqs, tasks, name: 'late' });
  const out = await handler(
    { Records: [recordOf('a', { body: { ...bodyOf(1), resizer: 'late' } })] },
    contextOf(60_000),
  );
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
  assert.deepEqual(sqs.visibility(), [60, 5]);
  assert.equal(sqs.deletes(), 0);
  assert.match(
    text(),
    /resize lambda: Resizer 'late' is not served by this handler .* its tasks fail with RESIZE_NO_RESIZER/,
  );
});

test('a consumed name on a task queue that cannot take pushes is refused, touches no record and is checked again next time', async () => {
  let checks = 0;
  const { sqs } = realResizer({
    tasks: new PlainTaskQueue(),
    verify: () => {
      checks += 1;
    },
  });
  const handler = createSqsHandler({ logger: silentLogger });
  await assert.rejects(
    handler({ Records: [recordOf('a')] }, contextOf(60_000)),
    {
      code: 'RESIZE_DELIVERY_UNSUPPORTED',
      message: /queue 'default' of Resizer 'default' is on/,
    },
  );
  assert.deepEqual(sqs.calls, []);
  await assert.rejects(handler({ Records: [] }, contextOf(60_000)), {
    code: 'RESIZE_DELIVERY_UNSUPPORTED',
  });
  assert.equal(checks, 2);
});

test('a task queue can take pushes when it has carriesSource and taskOfDelivery, and no gatesByTask', async () => {
  // No `release`: push delivery never gives a task back to the queue.
  class PushableQueue extends PlainTaskQueue {
    carriesSource(): boolean {
      return true;
    }
    async taskOfDelivery(): Promise<'left'> {
      return 'left';
    }
  }
  const pushable = async (over: Record<string, unknown>): Promise<void> => {
    resetResizerForTests();
    const tasks = Object.assign(new PushableQueue(), over) as TaskQueue;
    realResizer({ tasks });
    await createSqsHandler({ logger: silentLogger })(
      { Records: [] },
      contextOf(60_000),
    );
  };
  await pushable({});
  for (const lacking of [
    { carriesSource: undefined },
    { taskOfDelivery: undefined },
    { gatesByTask: true },
  ]) {
    await assert.rejects(pushable(lacking), {
      code: 'RESIZE_DELIVERY_UNSUPPORTED',
    });
  }
});

test('on a router only the consumed names must be able to take pushes', async () => {
  const sqs = fakeSqs();
  const tasks = new RoutingTaskQueue({
    default: sqsQueue(sqs),
    bulk: new MemoryTaskQueue(),
  });
  realResizer({ sqs, tasks });
  const pushedDefault = createSqsHandler({ logger: silentLogger });
  assert.deepEqual(
    await pushedDefault({ Records: [recordOf('a')] }, contextOf(60_000)),
    { batchItemFailures: [] },
  );
  assert.equal(sqs.deletes(), 1);
  await assert.rejects(
    createSqsHandler({ queue: ['default', 'bulk'], logger: silentLogger })(
      { Records: [] },
      contextOf(60_000),
    ),
    {
      code: 'RESIZE_DELIVERY_UNSUPPORTED',
      message: /queue 'bulk' of Resizer 'default' is on/,
    },
  );
});

// A Resizer named `name` that takes pushes when `sqs` is given, and otherwise cannot.
const namedResizer = (name: string, sqs?: FakeSqs) =>
  realResizer(sqs ? { name, sqs } : { name, tasks: new PlainTaskQueue() });

for (const order of [
  ['a', 'b'],
  ['b', 'a'],
]) {
  test(`a Resizer on one name that cannot take pushes is named, and the fix keeps the one that can (${order} built)`, async () => {
    const sqs = fakeSqs();
    for (const name of order) {
      namedResizer(name, name === 'a' ? sqs : undefined);
    }
    await assert.rejects(
      createSqsHandler({ logger: silentLogger })(
        { Records: [] },
        contextOf(60_000),
      ),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, 'RESIZE_DELIVERY_UNSUPPORTED');
        assert.match(err.message, /queue 'default' of Resizer 'b' is on/);
        assert.match(
          err.message,
          /createSqsHandler\(\{ resizers: \[getResizer\('a'\)\] \}\)/,
        );
        assert.match(err.message, /a worker process/);
        assert.doesNotMatch(err.message, /leave it out/);
        return true;
      },
    );
    // The fix the message gives works, on the same two Resizers.
    const fixed = createSqsHandler({
      resizers: [getResizer('a')],
      logger: silentLogger,
    });
    const body = { ...bodyOf(0), resizer: 'a' };
    assert.deepEqual(
      await fixed({ Records: [recordOf('m', { body })] }, contextOf(60_000)),
      { batchItemFailures: [] },
    );
    assert.equal(sqs.deletes(), 1);
  });
}

test('the fix names every Resizer that can take pushes, and every one that cannot', async () => {
  const sqs = fakeSqs();
  namedResizer('a', sqs);
  namedResizer('b');
  namedResizer('c', fakeSqs());
  namedResizer('d');
  await assert.rejects(
    createSqsHandler({ logger: silentLogger })(
      { Records: [] },
      contextOf(60_000),
    ),
    (err: Error) => {
      assert.match(err.message, /queue 'default' of Resizers 'b', 'd' are on/);
      assert.match(
        err.message,
        /resizers: \[getResizer\('a'\), getResizer\('c'\)\]/,
      );
      return true;
    },
  );
});

test('when no Resizer on a name can take pushes, the refusal names them and leaves the name out', async () => {
  namedResizer('a');
  namedResizer('b');
  await assert.rejects(
    createSqsHandler({ logger: silentLogger })(
      { Records: [] },
      contextOf(60_000),
    ),
    (err: Error) => {
      assert.match(err.message, /queue 'default' of Resizers 'a', 'b' are on/);
      assert.match(
        err.message,
        /leave it out of createSqsHandler\(\{ queue \}\)/,
      );
      assert.doesNotMatch(err.message, /resizers:/);
      return true;
    },
  );
});

test('no Resizer with a task queue is RESIZE_DELIVERY_UNSUPPORTED', async () => {
  realResizer({ tasks: undefined });
  const { logger, lines } = recording();
  await assert.rejects(
    createSqsHandler({ logger })({ Records: [] }, contextOf(60_000)),
    { code: 'RESIZE_DELIVERY_UNSUPPORTED', message: /give a Resizer an SQS/ },
  );
  assert.deepEqual(lines, [
    {
      level: 'error',
      message: 'resize lambda: no Resizer has a task queue (eager-only wiring)',
    },
  ]);
});

test('an unlisted Resizer that shares the queue is refused, as on a worker', async () => {
  const sqs = fakeSqs();
  const tasks = sqsQueue(sqs);
  const { resizer } = realResizer({ sqs, tasks });
  realResizer({ sqs, tasks, name: 'other' });
  await assert.rejects(
    createSqsHandler({ resizers: [resizer], logger: silentLogger })(
      { Records: [] },
      contextOf(60_000),
    ),
    {
      code: 'RESIZE_QUEUE_SHARED_RESIZER_UNLISTED',
      message: /^resize lambda: Resizer\(s\) 'other' share a task queue/,
    },
  );
});

test('a Resizer on its own queue may stay out of `resizers`, and its tasks are not run', async () => {
  const { resizer } = realResizer();
  const other = fakeSqs();
  realResizer({ sqs: other, name: 'other' });
  const { logger, text } = recording();
  const handler = createSqsHandler({ resizers: [resizer], logger });
  const out = await handler(
    { Records: [recordOf('a', { body: { ...bodyOf(1), resizer: 'other' } })] },
    contextOf(60_000),
  );
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
  assert.match(text(), /Resizer 'other' is not served by this handler/);
});

test('the checks run once across invocations', async () => {
  let checks = 0;
  realResizer({
    verify: () => {
      checks += 1;
    },
  });
  const handler = createSqsHandler({ logger: silentLogger });
  await handler({ Records: [] }, contextOf(60_000));
  await handler({ Records: [recordOf('a')] }, contextOf(60_000));
  assert.equal(checks, 1);
});

test('checks that do not finish list every record, on the logger the host gave', async () => {
  const hung = deferred();
  const { sqs } = realResizer({ verify: () => hung.promise });
  const { logger, lines } = recording();
  const out = await createSqsHandler({ logger })(
    { Records: [recordOf('a'), recordOf('b')] },
    contextOf(2200),
  );
  assert.deepEqual(out.batchItemFailures, [
    { itemIdentifier: 'a' },
    { itemIdentifier: 'b' },
  ]);
  assert.deepEqual(sqs.calls, []);
  assert.match(lines[0].message, /the start checks had not/);
  assert.equal(lines[0].level, 'error');
  hung.resolve();
});

test('a verify that hung once passes on a retry: the third invocation runs its record', async () => {
  const hung = deferred();
  let checks = 0;
  const { sqs } = realResizer({
    verify: () => {
      checks += 1;
      return checks === 1 ? hung.promise : undefined;
    },
  });
  const handler = createSqsHandler({ logger: silentLogger });
  for (const n of [1, 2]) {
    assert.deepEqual(
      await handler({ Records: [recordOf('a', { n })] }, contextOf(2200)),
      { batchItemFailures: [{ itemIdentifier: 'a' }] },
    );
  }
  assert.equal(checks, 1);
  assert.deepEqual(sqs.calls, []);
  assert.deepEqual(
    await handler({ Records: [recordOf('a', { n: 3 })] }, contextOf(60_000)),
    { batchItemFailures: [] },
  );
  assert.equal(checks, 2);
  assert.equal(sqs.deletes(), 1);
  hung.resolve();
  await handler({ Records: [] }, contextOf(60_000));
  assert.equal(checks, 2, 'a late settle of the old verify changes nothing');
});

test('the Sharp tuning is applied once, and left alone when omitted', async (t) => {
  const concurrency = sharp.concurrency();
  const { memory, files, items } = sharp.cache();
  t.after(() => {
    sharp.concurrency(concurrency);
    sharp.cache({ memory: memory.max, files: files.max, items: items.max });
  });
  realResizer();
  const untuned = createSqsHandler({ logger: silentLogger });
  await untuned({ Records: [] }, contextOf(60_000));
  assert.equal(sharp.concurrency(), concurrency);
  assert.equal(sharp.cache().items.max, items.max);

  const tuned = createSqsHandler({
    sharp: { concurrency: concurrency + 1, cache: false },
    logger: silentLogger,
  });
  assert.equal(sharp.concurrency(), concurrency, 'not before the first call');
  await tuned({ Records: [] }, contextOf(60_000));
  assert.equal(sharp.concurrency(), concurrency + 1);
  assert.equal(sharp.cache().items.max, 0);

  sharp.concurrency(concurrency + 2);
  await tuned({ Records: [] }, contextOf(60_000));
  assert.equal(sharp.concurrency(), concurrency + 2, 'applied once');
});

test('records go to their queue by event source, each with that queue timing', async () => {
  const sqs = fakeSqs();
  realResizer({
    sqs,
    tasks: new SqsTaskQueue({
      queues: { default: QUEUE_URL, bulk: BULK_URL },
      getTiming: (queue) =>
        queue === 'bulk' ? { leaseMs: 120_000 } : undefined,
      client: sqs.client as never,
      logger: silentLogger,
    }),
  });
  const out = await createSqsHandler({
    queue: ['default', 'bulk'],
    logger: silentLogger,
  })(
    {
      Records: [
        recordOf('a', { arn: QUEUE_ARN }),
        recordOf('b', {
          arn: BULK_ARN,
          body: { ...bodyOf(0), queue: 'bulk' },
        }),
      ],
    },
    contextOf(60_000),
  );
  assert.deepEqual(out.batchItemFailures, []);
  assert.deepEqual(
    sqs.calls
      .filter(({ name }) => name === 'ChangeMessageVisibilityCommand')
      .map(({ input }) => [input.VisibilityTimeout, input.QueueUrl]),
    [
      [60, QUEUE_URL],
      [120, BULK_URL],
    ],
  );
  assert.deepEqual(
    sqs.calls
      .filter(({ name }) => name === 'DeleteMessageCommand')
      .map(({ input }) => input.QueueUrl),
    [QUEUE_URL, BULK_URL],
  );
});

test('processingSecondsOf reads the limits of the task Resizer', async () => {
  const { resizer: a } = realResizer({ name: 'a' });
  const { resizer: b } = realResizer({
    name: 'b',
    config: makeImageConfig({ limits: { processingTimeoutSeconds: 7 } }),
  });
  const wiring = await wiringOf({ resizers: [a, b], logger: silentLogger });
  const secondsOf = (resizer: string) =>
    wiring.processingSecondsOf({ resizer } as LeasedTask);
  assert.equal(
    secondsOf('a'),
    makeImageConfig().limits.processingTimeoutSeconds,
  );
  assert.equal(secondsOf('b'), 7);
  assert.equal(secondsOf('unknown'), undefined);
});

test('the wiring runs on the carrier of the name, with the timing the router gives its builder route', async () => {
  const sqs = fakeSqs();
  const carrier = sqsQueue(sqs);
  realResizer({
    sqs,
    tasks: new RoutingTaskQueue(
      { default: async () => carrier },
      { getTiming: () => ({ leaseMs: 90_000 }) },
    ),
  });
  const { lanes } = await wiringOf({ logger: silentLogger });
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].queue, 'default');
  assert.equal(lanes[0].carrier, carrier);
  assert.equal(lanes[0].deps.timing.leaseMs, 90_000);
  assert.equal(lanes[0].deps.accepts, undefined, 'nothing is given back');
});

test('a metrics sink is flushed once per invocation, after the batch', async () => {
  const sqs = fakeSqs();
  const deletesAtFlush: number[] = [];
  realResizer({
    sqs,
    metrics: {
      count() {},
      timing() {},
      flush: async () => {
        deletesAtFlush.push(sqs.deletes());
      },
    },
  });
  const handler = createSqsHandler({ logger: silentLogger });
  await handler({ Records: [recordOf('a')] }, contextOf(60_000));
  await handler({ Records: [] }, contextOf(60_000));
  assert.deepEqual(deletesAtFlush, [1, 1]);
});

test('a full run, then its duplicate delivery, renders once', async () => {
  const { sqs, rows, uploads } = realResizer();
  const body = bodyOf(2);
  const handler = batchHandler(() => wiringOf({ logger: silentLogger }), {
    settleMarginMs: 100,
  });
  const first = await handler(
    { Records: [recordOf('a', { body })] },
    contextOf(60_000),
  );
  assert.deepEqual(first.batchItemFailures, []);
  assert.equal(rows.get('m1')?.length, 2);
  assert.equal(uploads(), 2);
  assert.equal(sqs.deletes(), 1);
  // SQS delivers at least once: the same message again, on a later receipt.
  const second = await handler(
    { Records: [recordOf('a', { body, receipt: 'r2', n: 2 })] },
    contextOf(60_000),
  );
  assert.deepEqual(second.batchItemFailures, []);
  assert.equal(rows.get('m1')?.length, 2);
  assert.equal(uploads(), 2, 'the duplicate rendered nothing');
  assert.equal(sqs.deletes(), 2);
});

test('a stop mid-task keeps the finished variants, and the retry renders only the rest', async () => {
  // The whole task takes at least 960 ms, and its budget is 600 ms.
  const count = 8;
  const { rows, uploads } = realResizer({ uploadDelayMs: 120 });
  const body = bodyOf(count);
  const handler = await warmed(
    batchHandler(() => wiringOf({ logger: silentLogger }), {
      stopBeforeTimeoutMs: 400,
      settleMarginMs: 100,
    }),
  );
  const first = await handler(
    { Records: [recordOf('a', { body })] },
    contextOf(1000),
  );
  assert.deepEqual(first.batchItemFailures, [{ itemIdentifier: 'a' }]);
  const kept = rows.get('m1')?.length ?? 0;
  assert.ok(kept > 0 && kept < count, `kept ${kept}`);
  const before = uploads();
  const second = await handler(
    { Records: [recordOf('a', { body, receipt: 'r2', n: 2 })] },
    contextOf(60_000),
  );
  assert.deepEqual(second.batchItemFailures, []);
  assert.equal(rows.get('m1')?.length, count);
  assert.equal(uploads() - before, count - kept);
});

test('through the public entry a hung task returns about 2 s before the deadline', async () => {
  const encode = deferred();
  const { sqs } = realResizer({
    pipelines: {
      // A step that ignores the abort.
      default: {
        beforeSteps: [
          async (raster) => {
            await encode.promise;
            return raster;
          },
        ],
      },
    },
  });
  const handler = await warmed(createSqsHandler({ logger: silentLogger }));
  const c = contextOf(4500);
  const out = await handler(
    { Records: [recordOf('a', { body: bodyOf(1) })] },
    c,
  );
  const left = c.getRemainingTimeInMillis();
  encode.resolve();
  assert.ok(left >= 1500 && left <= 2030, `returned with ${left} left`);
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
  assert.deepEqual(sqs.visibility(), [60, 5]);
});

test('through the public entry a 3 s function never starts a task', async () => {
  // Lambda's own default timeout. The default reserve leaves under 2 s.
  const { sqs, uploads } = realResizer();
  const { logger, lines } = recording();
  const handler = await warmed(createSqsHandler({ logger }));
  const out = await handler(
    { Records: [recordOf('a', { body: bodyOf(1) })] },
    contextOf(3000),
  );
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
  const errors = lines.filter(({ level }) => level === 'error');
  assert.match(
    errors.map(({ message }) => message).join('\n'),
    /the first record of this invocation, was not started/,
  );
  assert.deepEqual(sqs.visibility(), []);
  assert.equal(uploads(), 0);
});

test('an explicit stopBeforeTimeoutMs reaches the delivery: a reserve that leaves too little starts nothing', async () => {
  // The default reserve, 30 s of this minute, would start it.
  const { sqs, uploads } = realResizer();
  const out = await createSqsHandler({
    stopBeforeTimeoutMs: 59_000,
    logger: silentLogger,
  })({ Records: [recordOf('a', { body: bodyOf(1) })] }, contextOf(60_000));
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
  assert.deepEqual(sqs.visibility(), []);
  assert.equal(uploads(), 0);
});

test('a metrics flush that hangs ends a second before the deadline at most', async () => {
  realResizer({
    metrics: { count() {}, timing() {}, flush: () => deferred().promise },
  });
  const c = contextOf(3000);
  await createSqsHandler({ logger: silentLogger })({ Records: [] }, c);
  const left = c.getRemainingTimeInMillis();
  assert.ok(left >= 500 && left <= 1030, `returned with ${left} left`);
});

test('at the smallest stopBeforeTimeoutMs the stop lands and finished work is stored before the handler returns', async () => {
  const { sqs, rows } = realResizer({ uploadDelayMs: 120 });
  const handler = await warmed(
    createSqsHandler({ stopBeforeTimeoutMs: 3000, logger: silentLogger }),
  );
  const c = contextOf(5500);
  const out = await handler(
    { Records: [recordOf('a', { body: bodyOf(40) })] },
    c,
  );
  assert.ok(
    c.getRemainingTimeInMillis() >= 2000,
    `returned with ${c.getRemainingTimeInMillis()} left`,
  );
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
  assert.deepEqual(sqs.visibility(), [60, 5]);
  assert.ok((rows.get('m1')?.length ?? 0) > 0);
});

test('a handler file that constructs no Resizer gets an answer about the handler', async () => {
  await assert.rejects(
    createSqsHandler({ logger: silentLogger })(
      { Records: [] },
      contextOf(60_000),
    ),
    { code: 'RESIZE_NO_RESIZER', message: /handler/ },
  );
});
