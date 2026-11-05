// What only real timers can show: a timer left behind, a late answer after the return, and a loop
// that blocks the timers. src/deliveryTiming.test.ts pins the numbers on a virtual clock, where a
// timer left behind keeps nothing alive, so clearing the settle wait's timer is checked only here.
// Every time bound here is an upper bound on the time left: a busy machine only lowers it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ResizeError } from './errors.ts';
import {
  contextOf,
  deferred,
  fakeSqs,
  pushed,
  recordOf,
} from './testHelpers/pushHarness.ts';

const MARGIN = 300;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// First, so that no detached timer of an earlier test can end during it and hide one left here.
test('no timer of a delivery outlives the return', async () => {
  const timers = () =>
    process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const before = timers();
  const sqs = fakeSqs();
  const { handler } = pushed(sqs, async () => {}, { margin: MARGIN });
  const out = await handler(
    { Records: [recordOf('a'), recordOf('b')] },
    contextOf(60_000),
  );
  assert.deepEqual(out.batchItemFailures, []);
  await new Promise((r) => setImmediate(r));
  assert.ok(timers() <= before, `timers ${before} -> ${timers()}`);
});

test('a hung task is stopped at half the time left, and the task settles inside the invocation', async () => {
  const sqs = fakeSqs();
  const c = contextOf(1400);
  let left: number | undefined;
  const { handler, events } = pushed(
    sqs,
    (_t, { signal }) =>
      new Promise<void>((_r, reject) => {
        signal.addEventListener('abort', () => {
          left = c.getRemainingTimeInMillis();
          reject(new Error('aborted'));
        });
      }),
    { margin: MARGIN },
  );
  const out = await handler({ Records: [recordOf('a')] }, c);
  assert.ok(left !== undefined && left <= 720, `stopped with ${left} left`);
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
  assert.equal((events[0].error as ResizeError).code, 'RESIZE_TASK_TIMEOUT');
});

test('an uncancellable encode: the handler returns at the margin at the earliest, lists it and warns, and a late success makes no call', async () => {
  const sqs = fakeSqs();
  const encode = deferred();
  const c = contextOf(1000);
  const { handler, lines } = pushed(sqs, () => encode.promise, {
    margin: MARGIN,
    stop: 500,
  });
  const out = await handler({ Records: [recordOf('a')] }, c);
  const left = c.getRemainingTimeInMillis();
  assert.ok(left <= MARGIN + 30, `returned with ${left} left`);
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
  assert.ok(
    lines.some(
      (l) => l.level === 'warn' && /task a had not settled/.test(l.message),
    ),
  );
  const calls = sqs.calls.length;
  encode.resolve();
  await sleep(30);
  assert.equal(sqs.calls.length, calls);
  assert.equal(sqs.deletes(), 0);
});

test('a complete that hangs past the settle deadline and then succeeds: it is listed, and the late answer only reports', async () => {
  const answered = deferred();
  const sqs = fakeSqs({ DeleteMessageCommand: () => answered.promise });
  const c = contextOf(1000);
  const { handler, lines, events } = pushed(sqs, async () => {}, {
    margin: MARGIN,
    stop: 500,
  });
  const out = await handler({ Records: [recordOf('a')] }, c);
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
  assert.ok(lines.some((l) => /task a had not settled/.test(l.message)));
  assert.deepEqual(events, []);
  answered.resolve();
  await sleep(30);
  assert.deepEqual(
    events.map((e) => e.event),
    ['completed'],
  );
  assert.equal(sqs.deletes(), 1);
});

test('a step that blocks the loop past both timers: the finished task still completes once, and the handler answers', async () => {
  const sqs = fakeSqs();
  const c = contextOf(1000);
  const { handler, lines } = pushed(
    sqs,
    async () => {
      await sleep(100);
      // Past the stop at 500 and the settle deadline at 700: a host's sync work.
      const end = performance.now() + 700;
      while (performance.now() < end) {
        // nothing
      }
    },
    { margin: MARGIN, stop: 500 },
  );
  const out = await handler({ Records: [recordOf('b')] }, c);
  const left = c.getRemainingTimeInMillis();
  assert.ok(left <= MARGIN, `the promise cannot hold here: ${left} left`);
  // The listing must match what the queue took, whichever the load made first.
  assert.equal(sqs.deletes() === 1, out.batchItemFailures.length === 0);
  assert.ok(!lines.some((l) => l.level === 'error'));
});
