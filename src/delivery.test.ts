// One delivered record through the real Consumer and a real SqsTaskQueue over a fake SQS client:
// what the handler leaves in the queue, and what it does to the message, the gate and the observers
// on the way.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { defaultQueueOptions } from './config/resize.ts';
import { Consumer } from './consumer.ts';
import type { ClaimedTask, TaskQueue } from './contracts/taskQueue.ts';
import {
  batchHandler,
  type SqsBatchResponse,
  type SqsRecordLike,
} from './delivery.ts';
import { SqsTaskQueue } from './drivers/sqs.ts';
import { ResizeError, ResizeSetupError } from './errors.ts';
import { gateKey } from './lockKeys.ts';
import { silentLogger } from './testHelpers/fakes.ts';
import {
  contextOf,
  DEAD_URL,
  deferred,
  denied,
  fakeSqs,
  GATE_KEY,
  lostReceipt,
  pushed,
  QUEUE_URL,
  recordOf,
} from './testHelpers/pushHarness.ts';

const context = () => contextOf(60_000);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const listed = (out: SqsBatchResponse) =>
  out.batchItemFailures.map((failure) => failure.itemIdentifier);
const boom = async () => {
  throw new Error('boom');
};

test('a task that succeeds is adopted, deleted, its gate released, not listed, and metrics flushed', async () => {
  const sqs = fakeSqs();
  let visibilityWhileRunning: number[] = [];
  const { handler, locks, events, flushes, wiring } = pushed(sqs, async () => {
    visibilityWhileRunning = sqs.visibility();
  });
  const flush = wiring.flush;
  let deletesAtFlush = -1;
  wiring.flush = async (waitMs) => {
    deletesAtFlush = sqs.deletes();
    await flush(waitMs);
  };
  await locks.acquire(GATE_KEY, 'g1', 600_000);
  const out = await handler({ Records: [recordOf('a')] }, context());
  assert.deepEqual(out, { batchItemFailures: [] });
  assert.deepEqual(visibilityWhileRunning, [60], 'adopted before it ran');
  assert.deepEqual(sqs.visibility(), [60]);
  assert.equal(sqs.deletes(), 1);
  assert.deepEqual(
    sqs.calls.map(({ input }) => [input.QueueUrl, input.ReceiptHandle]),
    [
      [QUEUE_URL, 'rh-a'],
      [QUEUE_URL, 'rh-a'],
    ],
  );
  assert.equal(locks.entry(GATE_KEY), undefined);
  assert.deepEqual(
    events.map((e) => e.event),
    ['completed'],
  );
  assert.equal(flushes.length, 1);
  assert.equal(deletesAtFlush, 1, 'the flush comes after the batch');
});

test('a retryable failure sets the backoff and is listed, with its gate held for backoff + lease', async () => {
  const sqs = fakeSqs();
  const { handler, locks, events } = pushed(sqs, boom);
  await locks.acquire(GATE_KEY, 'g1', 600_000);
  const out = await handler({ Records: [recordOf('a', { n: 2 })] }, context());
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
  assert.deepEqual(sqs.visibility(), [60, 10]);
  assert.equal(sqs.deletes(), 0);
  const left = (locks.entry(GATE_KEY)?.expiresAt ?? 0) - Date.now();
  assert.ok(left > 65_000 && left <= 70_000, `gate holds ${left}`);
  assert.deepEqual(
    events.map((e) => e.event),
    ['failed'],
  );
});

test('the last attempt is dead-lettered and not listed', async () => {
  const sqs = fakeSqs();
  const { handler, locks, events } = pushed(sqs, boom);
  await locks.acquire(GATE_KEY, 'g1', 1000);
  const out = await handler({ Records: [recordOf('a', { n: 5 })] }, context());
  assert.deepEqual(out.batchItemFailures, []);
  assert.deepEqual(
    sqs.sends().map((send) => send.QueueUrl),
    [DEAD_URL],
  );
  assert.equal(sqs.deletes(), 1);
  const left = (locks.entry(GATE_KEY)?.expiresAt ?? 0) - Date.now();
  assert.ok(left > 590_000, `cooldown ${left}`);
  assert.deepEqual(
    events.map((e) => e.event),
    ['deadLettered'],
  );
});

test('retryable: false dead-letters at once and is not listed', async () => {
  const sqs = fakeSqs();
  const { handler, events } = pushed(sqs, async () => {
    throw new ResizeError('no', {
      code: 'RESIZE_SOURCE_FORMAT_UNSUPPORTED',
      retryable: false,
    });
  });
  const out = await handler({ Records: [recordOf('a')] }, context());
  assert.deepEqual(out.batchItemFailures, []);
  assert.equal(sqs.sends().length, 1);
  assert.equal(sqs.deletes(), 1);
  assert.deepEqual(
    events.map((e) => e.event),
    ['deadLettered'],
  );
});

test('a receive count past maxAttempts is dead-lettered without running', async () => {
  const sqs = fakeSqs();
  const { handler, events } = pushed(sqs, async () => assert.fail('ran'));
  const out = await handler({ Records: [recordOf('a', { n: 6 })] }, context());
  assert.deepEqual(out.batchItemFailures, []);
  assert.equal(sqs.sends().length, 1);
  assert.equal(
    (events[0].error as ResizeError).code,
    'RESIZE_TASK_MAX_ATTEMPTS',
  );
});

test('a lost receipt at adoption runs nothing and is listed', async () => {
  const sqs = fakeSqs({
    ChangeMessageVisibilityCommand: (n) =>
      n === 1 ? lostReceipt() : undefined,
  });
  const { handler, locks, events, lines } = pushed(sqs, async () =>
    assert.fail('ran'),
  );
  await locks.acquire(GATE_KEY, 'other', 600_000);
  const held = locks.entry(GATE_KEY);
  const out = await handler({ Records: [recordOf('a')] }, context());
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
  assert.deepEqual(locks.entry(GATE_KEY), held, 'no gate call');
  assert.deepEqual(events, []);
  assert.equal(
    lines.filter(
      (l) => l.level === 'warn' && /lost its receipt/.test(l.message),
    ).length,
    1,
  );
  assert.deepEqual(sqs.visibility(), [60], 'no other queue call');
});

test('an adoption that fails for another reason logs once and the task still runs', async () => {
  const sqs = fakeSqs({ ChangeMessageVisibilityCommand: () => denied() });
  const ran: string[] = [];
  const { handler, lines, events } = pushed(sqs, async (task) => {
    ran.push(task.taskId);
  });
  const adoptionLines = () =>
    lines.filter(
      (l) =>
        l.level === 'error' && /sqs:ChangeMessageVisibility/.test(l.message),
    );
  const out = await handler({ Records: [recordOf('a')] }, context());
  assert.deepEqual(ran, ['a']);
  assert.deepEqual(out.batchItemFailures, []);
  assert.equal(adoptionLines().length, 1);
  assert.match(adoptionLines()[0].message, /message a /);
  assert.equal((adoptionLines()[0].error as Error).name, 'AccessDenied');
  // Once per handler: another record of this batch, or of a later batch, adds no line.
  const next = await handler(
    { Records: [recordOf('b'), recordOf('c')] },
    context(),
  );
  assert.deepEqual(ran, ['a', 'b', 'c']);
  assert.deepEqual(next.batchItemFailures, []);
  assert.equal(adoptionLines().length, 1);
  assert.equal(events.length, 3);
});

test('a malformed body is moved aside when it can be, and listed when it cannot', async () => {
  for (const body of ['{not json', '[', '{"mediaId":"m1"}']) {
    const sqs = fakeSqs();
    const { handler } = pushed(sqs, async () => assert.fail('ran'));
    const out = await handler(
      { Records: [recordOf('a', { body })] },
      context(),
    );
    assert.deepEqual(out.batchItemFailures, [], body);
    assert.equal(sqs.sends().length, 1, body);
    assert.equal(sqs.sends()[0].QueueUrl, DEAD_URL, body);
    assert.equal(sqs.deletes(), 1, body);
    assert.deepEqual(sqs.visibility(), [], `${body}: not adopted`);
  }
  const sqs = fakeSqs();
  const { handler } = pushed(sqs, async () => assert.fail('ran'), {
    dlq: false,
  });
  const out = await handler(
    { Records: [recordOf('a', { body: '{not json' })] },
    context(),
  );
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
  assert.deepEqual(sqs.calls, []);
});

test('a task of an unserved Resizer retries with backoff and takes no gate call, then dies', async () => {
  const sqs = fakeSqs();
  const { handler, locks } = pushed(sqs, async (task) => {
    if (task.resizer === 'other') {
      throw new ResizeSetupError('not served', { code: 'RESIZE_NO_RESIZER' });
    }
  });
  const key = gateKey('other', 'default', 'm1', 'default');
  await locks.acquire(key, 'g1', 600_000);
  const held = locks.entry(key);
  const body = {
    resizer: 'other',
    queue: 'default',
    mediaId: 'm1',
    pipeline: 'default',
    previews: [],
    gateOwner: 'g1',
  };
  const out = await handler({ Records: [recordOf('a', { body })] }, context());
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
  assert.deepEqual(sqs.visibility(), [60, 5]);
  assert.deepEqual(locks.entry(key), held);
  const last = await handler(
    { Records: [recordOf('b', { body, n: 5 })] },
    context(),
  );
  assert.deepEqual(last.batchItemFailures, []);
  assert.equal(sqs.sends().length, 1);
  assert.deepEqual(locks.entry(key), held);
});

test('in a mixed batch only the records still in the queue are listed', async () => {
  const sqs = fakeSqs();
  const { handler } = pushed(
    sqs,
    async (task) => {
      if (task.mediaId === 'bad') {
        throw new Error('boom');
      }
      if (task.mediaId === 'dead') {
        throw new ResizeError('no', {
          code: 'RESIZE_SOURCE_FORMAT_UNSUPPORTED',
          retryable: false,
        });
      }
    },
    { dlq: false },
  );
  const body = (mediaId: string) => ({
    resizer: 'default',
    queue: 'default',
    mediaId,
    pipeline: 'default',
    previews: [],
  });
  const out = await handler(
    {
      Records: [
        recordOf('ok', { body: body('m') }),
        recordOf('retry', { body: body('bad') }),
        recordOf('dead', { body: body('dead') }),
        recordOf('poison', { body: '[' }),
        recordOf('unknown-arn', {
          body: body('m'),
          arn: 'arn:aws:sqs:eu-west-1:123456789012:other',
        }),
      ],
    },
    context(),
  );
  assert.deepEqual(listed(out), ['retry', 'poison', 'unknown-arn']);
});

test('the heartbeat renews during the run and stops at the end', async () => {
  const sqs = fakeSqs();
  const timers = () =>
    process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const before = timers();
  const { handler } = pushed(sqs, () => sleep(2300), {
    timing: { leaseMs: 1000 },
  });
  const out = await handler({ Records: [recordOf('a')] }, context());
  assert.deepEqual(out.batchItemFailures, []);
  const renewals = sqs.visibility().length;
  assert.ok(renewals >= 5, `adoption and heartbeats: ${sqs.visibility()}`);
  assert.ok(sqs.visibility().every((v) => v === 1));
  assert.ok(timers() <= before, `timers ${before} -> ${timers()}`);
  await sleep(1200);
  assert.equal(sqs.visibility().length, renewals, 'no renewal after the end');
});

test('a duplicate delivery in parallel runs twice, both complete, and the gate ends released', async () => {
  const sqs = fakeSqs();
  let ran = 0;
  const { handler, locks, events } = pushed(sqs, async () => {
    ran += 1;
    await sleep(50);
  });
  await locks.acquire(GATE_KEY, 'g1', 600_000);
  const [one, two] = await Promise.all([
    handler({ Records: [recordOf('a', { receipt: 'r1' })] }, context()),
    handler({ Records: [recordOf('a', { receipt: 'r2', n: 2 })] }, context()),
  ]);
  assert.equal(ran, 2);
  assert.deepEqual([one.batchItemFailures, two.batchItemFailures], [[], []]);
  assert.equal(locks.entry(GATE_KEY), undefined);
  assert.deepEqual(
    events.map((e) => e.event),
    ['completed', 'completed'],
  );
});

test('a delete that fails is listed, keeps the gate and fires no event', async () => {
  const sqs = fakeSqs({
    DeleteMessageCommand: () => new Error('socket hang up'),
  });
  const { handler, locks, events } = pushed(sqs, async () => {});
  await locks.acquire(GATE_KEY, 'g1', 600_000);
  const out = await handler({ Records: [recordOf('a')] }, context());
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
  assert.deepEqual(events, []);
  assert.equal(locks.entry(GATE_KEY)?.owner, 'g1');
});

test('an invocation killed mid-task leaves the lease as the crash window and its redelivery ends it', async () => {
  const sqs = fakeSqs();
  const hung = deferred();
  let started = 0;
  const { handler, locks } = pushed(sqs, () => {
    started += 1;
    return started === 1 ? hung.promise : Promise.resolve();
  });
  await locks.acquire(GATE_KEY, 'g1', 600_000);
  const first = handler(
    { Records: [recordOf('a', { receipt: 'r1' })] },
    contextOf(3_000_000),
  );
  while (started < 1) {
    await sleep(2);
  }
  assert.equal(sqs.visibility()[0], 60);
  const left = (locks.entry(GATE_KEY)?.expiresAt ?? 0) - Date.now();
  assert.ok(left > 60_000 && left <= 90_000, `gate holds ${left}`);
  const second = await handler(
    { Records: [recordOf('a', { receipt: 'r2', n: 2 })] },
    context(),
  );
  assert.deepEqual(second.batchItemFailures, []);
  assert.equal(started, 2);
  assert.equal(locks.entry(GATE_KEY), undefined);
  hung.resolve();
  await first;
});

test('a role without sqs:ChangeMessageVisibility lists the record and fires no event', async () => {
  const sqs = fakeSqs({ ChangeMessageVisibilityCommand: () => denied() });
  const { handler, locks, events } = pushed(sqs, boom);
  await locks.acquire(GATE_KEY, 'g1', 600_000);
  const out = await handler({ Records: [recordOf('a')] }, context());
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
  assert.deepEqual(events, []);
  assert.equal(locks.entry(GATE_KEY)?.owner, 'g1');
});

test('a role without sqs:SendMessage on the dead-letter queue lists a dead task and fires no event', async () => {
  const sqs = fakeSqs({ SendMessageCommand: () => denied() });
  const { handler, events } = pushed(sqs, boom);
  const out = await handler({ Records: [recordOf('a', { n: 5 })] }, context());
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
  assert.equal(sqs.deletes(), 0);
  assert.deepEqual(events, []);
});

test('a lapsed gate is retaken under its owner and released at the end', async () => {
  const sqs = fakeSqs();
  let whileRunning: { owner: string; expiresAt: number } | undefined;
  const { handler, locks } = pushed(sqs, async () => {
    await sleep(5);
    whileRunning = locks.entry(GATE_KEY);
  });
  await locks.acquire(GATE_KEY, 'g1', 1);
  await sleep(5);
  const out = await handler({ Records: [recordOf('a')] }, context());
  assert.deepEqual(out.batchItemFailures, []);
  assert.equal(whileRunning?.owner, 'g1');
  assert.ok((whileRunning?.expiresAt ?? 0) > Date.now(), 'held, not lapsed');
  assert.equal(locks.entry(GATE_KEY), undefined);
});

test('a gate held by a newer task is never released', async () => {
  const sqs = fakeSqs();
  let ran = 0;
  const { handler, locks } = pushed(sqs, async () => {
    ran += 1;
  });
  await locks.acquire(GATE_KEY, 'newer', 600_000);
  const out = await handler({ Records: [recordOf('a')] }, context());
  assert.equal(ran, 1);
  assert.deepEqual(out.batchItemFailures, []);
  assert.equal(locks.entry(GATE_KEY)?.owner, 'newer');
});

test('a receipt lost at the end of a task leaves it listed, with no event', async () => {
  const cases = [
    {
      name: 'complete',
      n: 1,
      handle: async () => {},
      sqs: fakeSqs({ DeleteMessageCommand: () => lostReceipt() }),
    },
    {
      name: 'retry',
      n: 1,
      handle: boom,
      sqs: fakeSqs({
        ChangeMessageVisibilityCommand: (nth) =>
          nth === 2 ? lostReceipt() : undefined,
      }),
    },
    {
      name: 'dead-letter',
      n: 5,
      handle: boom,
      sqs: fakeSqs({ DeleteMessageCommand: () => lostReceipt() }),
    },
  ];
  for (const { name, n, handle, sqs } of cases) {
    const { handler, events, locks } = pushed(sqs, handle);
    await locks.acquire(GATE_KEY, 'g1', 600_000);
    const out = await handler({ Records: [recordOf('a', { n })] }, context());
    assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }], name);
    assert.deepEqual(events, [], name);
    assert.equal(locks.entry(GATE_KEY)?.owner, 'g1', name);
  }
});

test('a lease lost to a heartbeat stops the task, makes no terminal call and leaves it listed', async () => {
  const sqs = fakeSqs({
    ChangeMessageVisibilityCommand: (nth) =>
      nth === 2 ? lostReceipt() : undefined,
  });
  let stopped = false;
  const { handler, events } = pushed(
    sqs,
    (_task, { signal }) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          stopped = true;
          reject(new Error('aborted'));
        });
      }),
    { timing: { leaseMs: 100 } },
  );
  const out = await handler({ Records: [recordOf('a')] }, context());
  assert.equal(stopped, true, 'the stop reached the task');
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
  assert.deepEqual(sqs.visibility(), [1, 1], 'adoption, then the lost renewal');
  assert.equal(sqs.deletes(), 0);
  assert.equal(sqs.sends().length, 0);
  assert.deepEqual(events, []);
});

test('a task past its timeout has settled before the handler returns, and is listed', async () => {
  const sqs = fakeSqs();
  let ended = false;
  const { handler, events } = pushed(
    sqs,
    async () => {
      await sleep(100);
      ended = true;
    },
    { timing: { taskTimeoutMs: 20 } },
  );
  const out = await handler({ Records: [recordOf('a')] }, context());
  assert.equal(ended, true);
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
  assert.deepEqual(sqs.visibility(), [60, 5]);
  assert.equal((events[0].error as ResizeError).code, 'RESIZE_TASK_TIMEOUT');
});

test('a message from an unknown source is listed with an error line', async () => {
  const sqs = fakeSqs();
  const { handler, lines } = pushed(sqs, async () =>
    assert.fail('must not run'),
  );
  const out = await handler(
    {
      Records: [
        recordOf('a', { arn: 'arn:aws:sqs:eu-west-1:123456789012:other' }),
      ],
    },
    contextOf(60_000),
  );
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
  assert.deepEqual(sqs.calls, []);
  assert.match(
    lines.find((l) => l.level === 'error')?.message ?? '',
    /no consumed queue \(default\) matches/,
  );
});

test('a record with no event source runs on the only lane, and is listed when there are several', async () => {
  const bare = (id: string): SqsRecordLike => {
    const { eventSourceARN: _, ...record } = recordOf(id);
    return record;
  };
  const sqs = fakeSqs();
  const { handler, wiring, lines } = pushed(sqs, async () => {});
  const out = await handler({ Records: [bare('a')] }, contextOf(60_000));
  assert.deepEqual(out.batchItemFailures, []);
  assert.equal(sqs.deletes(), 1);

  const bulk = new SqsTaskQueue({
    queues: {
      bulk: 'https://sqs.eu-west-1.amazonaws.com/123456789012/resize-bulk',
    },
    client: sqs.client as unknown as SQSClient,
    logger: silentLogger,
  });
  const two = batchHandler(
    async () => ({
      ...wiring,
      lanes: [
        ...wiring.lanes,
        { ...wiring.lanes[0], queue: 'bulk', carrier: bulk },
      ],
    }),
    { settleMarginMs: 300 },
  );
  const several = await two({ Records: [bare('b')] }, contextOf(60_000));
  assert.deepEqual(several.batchItemFailures, [{ itemIdentifier: 'b' }]);
  assert.equal(sqs.deletes(), 1, 'it did not run');
  assert.match(
    lines.find((l) => l.level === 'error')?.message ?? '',
    /message b came from no event source, which no consumed queue \(default, bulk\) matches/,
  );
});

test('a record the handler cannot read is listed and the batch goes on', async () => {
  const sqs = fakeSqs();
  const { handler, carrier, lines, events } = pushed(sqs, async () => {});
  const read = carrier.taskOfDelivery.bind(carrier);
  const unreadable = new Error('unreadable');
  carrier.taskOfDelivery = async (message, queue) => {
    if (message.id === 'a') {
      throw unreadable;
    }
    return read(message, queue);
  };
  const out = await handler(
    { Records: [recordOf('a'), recordOf('b')] },
    contextOf(60_000),
  );
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
  assert.equal(sqs.deletes(), 1);
  assert.deepEqual(
    events.map((e) => e.event),
    ['completed'],
  );
  const line = lines.find(
    (l) => l.level === 'error' && /delivering message a failed/.test(l.message),
  );
  assert.equal(line?.error, unreadable);
});

test('a run that rejects is listed with an error line and the batch goes on', async () => {
  const sqs = fakeSqs();
  const broken = new Error('thrown before a promise exists');
  let runs = 0;
  const { handler, lines } = pushed(sqs, () => {
    runs += 1;
    if (runs === 1) {
      throw broken;
    }
    return Promise.resolve();
  });
  const out = await handler(
    { Records: [recordOf('a'), recordOf('b')] },
    contextOf(60_000),
  );
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
  assert.equal(sqs.deletes(), 1);
  const line = lines.find(
    (l) =>
      l.level === 'error' &&
      /the delivery of task a ended with an error/.test(l.message),
  );
  assert.equal(line?.error, broken);
});

test('an event that is not an SQS batch throws RESIZE_SQS_EVENT_INVALID and runs nothing', async () => {
  const sqs = fakeSqs();
  const { handler } = pushed(sqs, async () => assert.fail('must not run'));
  const bad = [
    undefined,
    {},
    { Records: 'x' },
    { Records: [{}] },
    { Records: [null] },
    { Records: [{ messageId: 'a', receiptHandle: 'r' }] },
    { Records: [{ messageId: '', receiptHandle: 'r', body: '' }] },
    { Records: [{ messageId: 'a', receiptHandle: '', body: '' }] },
    { Records: [{ receiptHandle: 'r', body: '' }] },
    { Records: [{ messageId: 'a', receiptHandle: 'r', body: 1 }] },
  ];
  for (const event of bad) {
    await assert.rejects(handler(event as never, contextOf(60_000)), {
      code: 'RESIZE_SQS_EVENT_INVALID',
      retryable: false,
      message: /the event is not an SQS batch/,
    });
  }
  for (const c of [undefined, {}, { getRemainingTimeInMillis: 1 }]) {
    await assert.rejects(handler({ Records: [] }, c as never), {
      code: 'RESIZE_SQS_EVENT_INVALID',
    });
  }
  assert.deepEqual(sqs.calls, []);
});

// A count that is not one SQS would report reads as NaN, 0, or the same 1 on every delivery, so the
// task would never be dead-lettered: `maxAttempts` compares against it (src/consumer.ts). It comes
// through an event, so it is refused with the event.
test('a record whose receive count cannot be counted throws RESIZE_SQS_EVENT_INVALID and runs nothing', async () => {
  const sqs = fakeSqs();
  const { handler, flushes } = pushed(sqs, async () =>
    assert.fail('must not run'),
  );
  const { attributes: _, ...noAttributes } = recordOf('a');
  const records: unknown[] = [
    noAttributes,
    { ...noAttributes, attributes: null },
    { ...noAttributes, attributes: 'x' },
    { ...noAttributes, attributes: {} },
    ...[
      '',
      ' ',
      'abc',
      '2x',
      '0',
      '00',
      '-1',
      '1.5',
      '1e3',
      '0x10',
      ' 2',
      '2\n',
      'Infinity',
      'NaN',
      2,
      null,
    ].map((count) => ({
      ...noAttributes,
      attributes: { ApproximateReceiveCount: count },
    })),
  ];
  for (const record of records) {
    await assert.rejects(
      handler({ Records: [record] } as never, contextOf(60_000)),
      {
        code: 'RESIZE_SQS_EVENT_INVALID',
        retryable: false,
        message: /message a .*ApproximateReceiveCount/,
      },
      JSON.stringify(record),
    );
  }
  // One such record refuses the batch, as a bad body does: the record beside it stays untouched.
  await assert.rejects(
    handler({ Records: [recordOf('b'), noAttributes] }, contextOf(60_000)),
    { code: 'RESIZE_SQS_EVENT_INVALID' },
  );
  assert.deepEqual(sqs.calls, []);
  assert.deepEqual(flushes, []);
});

test('a receive count of several digits is counted', async () => {
  const sqs = fakeSqs();
  const { handler, events } = pushed(sqs, async () =>
    assert.fail('must not run'),
  );
  const out = await handler({ Records: [recordOf('a', { n: 10 })] }, context());
  assert.deepEqual(out.batchItemFailures, []);
  assert.equal(
    (events[0].error as ResizeError).code,
    'RESIZE_TASK_MAX_ATTEMPTS',
  );
});

test('an empty batch runs the checks and lists nothing', async () => {
  const sqs = fakeSqs();
  const { wiring, flushes } = pushed(sqs, async () => {});
  let wired = 0;
  const handler = batchHandler(
    async () => {
      wired += 1;
      return wiring;
    },
    { settleMarginMs: 300 },
  );
  const out = await handler({ Records: [] }, contextOf(60_000));
  assert.deepEqual(out, { batchItemFailures: [] });
  assert.equal(wired, 1);
  assert.equal(flushes.length, 1);
  assert.deepEqual(sqs.calls, []);
});

test('the checks run once, and rejected checks throw, touch no record and run again next time', async () => {
  const sqs = fakeSqs();
  const { wiring } = pushed(sqs, async () => assert.fail('must not run'));
  let runs = 0;
  const handler = batchHandler(
    async () => {
      runs += 1;
      if (runs === 1) {
        throw new ResizeSetupError('no'); // its default code is RESIZE_SETUP
      }
      return wiring;
    },
    { settleMarginMs: 300 },
  );
  // The event is checked first: one that is no batch runs no check at all.
  await assert.rejects(handler({} as never, contextOf(60_000)), {
    code: 'RESIZE_SQS_EVENT_INVALID',
  });
  assert.equal(runs, 0);
  await assert.rejects(
    handler({ Records: [recordOf('a')] }, contextOf(60_000)),
    { code: 'RESIZE_SETUP' },
  );
  assert.deepEqual(sqs.calls, []);
  await handler({ Records: [] }, contextOf(60_000));
  await handler({ Records: [] }, contextOf(60_000));
  assert.equal(runs, 2);
});

test('the one-shot relies on three Consumer behaviours, pinned here from the push side', async () => {
  const task: ClaimedTask = {
    taskId: 't1',
    resizer: 'default',
    queue: 'default',
    mediaId: 'm1',
    pipeline: 'default',
    previews: [],
    attempts: 1,
    token: 'token',
  };
  const queueOf = (claim: () => Promise<ClaimedTask | null>) => {
    const seen = { released: 0, failed: [] as string[] };
    const tasks: TaskQueue = {
      add: async () => ({ status: 'unconfirmed' }),
      claim,
      renew: async () => true,
      complete: async () => true,
      fail: async (_task, _next, error) => {
        seen.failed.push(error);
        return true;
      },
      release: async () => {
        seen.released += 1;
        return true;
      },
    };
    return { tasks, seen };
  };

  // A null claim re-checks the signal: run() ends well inside idlePollMs.
  const stopped = new AbortController();
  const { tasks: empty } = queueOf(async () => {
    stopped.abort();
    return null;
  });
  const started = performance.now();
  await new Consumer({
    tasks: empty,
    timing: { ...defaultQueueOptions, idlePollMs: 60_000 },
    handle: async () => assert.fail('must not run'),
    logger: silentLogger,
  }).run('default', stopped.signal);
  assert.ok(performance.now() - started < 1000, 'run() ended inside the poll');

  // A signal aborted during a claim gives the task back without running it.
  const aborted = new AbortController();
  const { tasks: back, seen: backSeen } = queueOf(async () => {
    aborted.abort();
    return task;
  });
  await new Consumer({
    tasks: back,
    timing: defaultQueueOptions,
    handle: async () => assert.fail('must not run'),
    logger: silentLogger,
  }).run('default', aborted.signal);
  assert.equal(backSeen.released, 1);
  assert.deepEqual(backSeen.failed, []);

  // `timing` is read per Consumer.
  const once = new AbortController();
  let claims = 0;
  const { tasks: hung, seen: hungSeen } = queueOf(async () => {
    claims += 1;
    if (claims > 1) {
      once.abort();
      return null;
    }
    return task;
  });
  await new Consumer({
    tasks: hung,
    timing: { ...defaultQueueOptions, taskTimeoutMs: 20 },
    handle: () => new Promise(() => {}),
    logger: silentLogger,
  }).run('default', once.signal);
  assert.equal(hungSeen.failed.length, 1);
  assert.match(hungSeen.failed[0], /exceeded taskTimeoutMs \(20ms\)/);
});
