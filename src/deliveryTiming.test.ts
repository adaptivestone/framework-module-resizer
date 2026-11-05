// The time rules of push delivery, through the real Consumer and a real SqsTaskQueue over a fake SQS
// client: when a delivered task is stopped, when the handler stops waiting for it, and which records
// are not started. Each test runs on a virtual clock (onVirtualClock), so its numbers are exact and a
// busy machine cannot move them: every timer, Date.now() and performance.now() read that clock, and
// it moves only once everything that can run has run.
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import {
  defaultReserveMs,
  type LambdaContextLike,
  SETTLE_MARGIN_MS,
} from './delivery.ts';
import type { ResizeError } from './errors.ts';
import { type ClockLocks, clockLocks } from './testHelpers/fakes.ts';
import {
  contextOf,
  deferred,
  fakeSqs,
  GATE_KEY,
  onVirtualClock,
  pushed,
  recordOf,
} from './testHelpers/pushHarness.ts';

const MARGIN = 300;
const timed = (name: string, body: () => Promise<void>) =>
  test(name, (t: TestContext) => onVirtualClock(t, body));
// A task that honours the abort: records the time left when it arrived.
const abortable =
  (c: LambdaContextLike, seen: { left?: number }) =>
  (_t: unknown, { signal }: { signal: AbortSignal }) =>
    new Promise<void>((_r, reject) => {
      signal.addEventListener('abort', () => {
        seen.left = c.getRemainingTimeInMillis();
        reject(new Error('aborted'));
      });
    });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const notRun = async () => assert.fail('must not run');

test('the margin the public entry passes is 2 s', () => {
  assert.equal(SETTLE_MARGIN_MS, 2000);
});

test('defaultReserveMs is limits.processingTimeoutSeconds + 5 s, never above half the time left', () => {
  assert.equal(defaultReserveMs(300_000, 30), 35_000);
  assert.equal(defaultReserveMs(70_000, 30), 35_000);
  assert.equal(defaultReserveMs(60_000, 30), 30_000);
  assert.equal(defaultReserveMs(300_000, 120), 125_000);
  assert.equal(defaultReserveMs(5_001, 30), 2_500);
});

timed(
  'the default reserve stops a hung task at half the time left, and the task settles inside the invocation',
  async () => {
    const sqs = fakeSqs();
    const c = contextOf(1400);
    const seen: { left?: number } = {};
    const { handler, events, lines } = pushed(sqs, abortable(c, seen), {
      margin: MARGIN,
    });
    const out = await handler({ Records: [recordOf('a')] }, c);
    assert.equal(seen.left, 700);
    assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
    assert.equal((events[0].error as ResizeError).code, 'RESIZE_TASK_TIMEOUT');
    assert.deepEqual(sqs.visibility(), [60, 5]);
    assert.deepEqual(
      lines.filter((l) => l.level === 'error'),
      [],
      'the rejection the stop caused is no error of the delivery',
    );
  },
);

timed(
  'an explicit stopBeforeTimeoutMs above half the time left is honoured as given',
  async () => {
    const sqs = fakeSqs();
    const c = contextOf(1400);
    const seen: { left?: number } = {};
    const { handler } = pushed(sqs, abortable(c, seen), {
      margin: MARGIN,
      stop: 1000,
    });
    await handler({ Records: [recordOf('a')] }, c);
    assert.equal(seen.left, 1000);
  },
);

timed(
  'the budget is what is left after the checks and the adoption',
  async () => {
    const sqs = fakeSqs({
      ChangeMessageVisibilityCommand: (n) => (n === 1 ? sleep(100) : undefined),
    });
    const c = contextOf(1400);
    const seen: { left?: number } = {};
    const { handler } = pushed(sqs, abortable(c, seen), {
      margin: MARGIN,
      stop: 500,
      checks: () => sleep(100),
    });
    await handler({ Records: [recordOf('a')] }, c);
    assert.equal(seen.left, 500);
  },
);

timed(
  'an uncancellable encode that outlasts the settle wait: the handler returns by the margin, lists the record and warns',
  async () => {
    const sqs = fakeSqs();
    const encode = deferred();
    const c = contextOf(1000);
    const { handler, events, lines } = pushed(sqs, () => encode.promise, {
      margin: MARGIN,
      stop: 500,
    });
    const out = await handler({ Records: [recordOf('a')] }, c);
    assert.equal(c.getRemainingTimeInMillis(), MARGIN);
    assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
    assert.deepEqual(sqs.visibility(), [60, 5]);
    assert.equal((events[0].error as ResizeError).code, 'RESIZE_TASK_TIMEOUT');
    assert.ok(
      lines.some(
        (l) =>
          l.level === 'warn' &&
          /task a had not settled 300 ms before the function timeout/.test(
            l.message,
          ),
      ),
    );
    const calls = sqs.calls.length;
    encode.resolve();
    await sleep(30);
    assert.equal(sqs.calls.length, calls, 'a late success makes no queue call');
    assert.equal(sqs.deletes(), 0, 'a late success never completes the task');
  },
);

timed(
  'an uncancellable encode that rejects after the return is no unhandled rejection',
  async () => {
    const sqs = fakeSqs();
    const encode = deferred();
    const { handler } = pushed(sqs, () => encode.promise, {
      margin: MARGIN,
      stop: 500,
    });
    await handler({ Records: [recordOf('a')] }, contextOf(1000));
    encode.reject(new Error('late')); // node:test fails the file on an unhandled rejection
    await sleep(30);
  },
);

// A slow step at the end of a task. `slow` is one deferred, resolved at the end of each test.
const boom = async () => {
  throw new Error('boom');
};
const ok = async () => {};
interface SlowEnd {
  name: string;
  n: number;
  handle: () => Promise<void>;
  listed: boolean;
  hold?: (slow: Promise<void>) => Parameters<typeof fakeSqs>[0];
  observer?: boolean;
  body?: string;
  what?: string;
  timing?: { leaseMs: number };
  hungExtend?: boolean;
  settleMs?: number;
  stop?: number;
}
const slowEnds: SlowEnd[] = [
  {
    name: 'fail',
    n: 1,
    handle: boom,
    listed: true,
    hold: (slow) => ({
      ChangeMessageVisibilityCommand: (nth) => (nth === 2 ? slow : undefined),
    }),
  },
  {
    name: 'complete',
    n: 1,
    handle: ok,
    listed: true,
    hold: (slow) => ({ DeleteMessageCommand: () => slow }),
  },
  {
    name: 'dead-letter send',
    n: 5,
    handle: boom,
    listed: true,
    hold: (slow) => ({ SendMessageCommand: () => slow }),
  },
  // A report waits up to taskTimeoutMs from its own start, and taskTimeoutMs here is the budget. So
  // the margin is what ends it only when the task took more than reserve - margin before its report
  // started: 300 ms here, against 200. The test below covers a task that took less.
  {
    name: 'observer after a completion',
    n: 1,
    handle: () => sleep(300),
    stop: 500,
    listed: false,
    observer: true,
  },
  {
    name: 'move of a malformed message',
    n: 1,
    handle: ok,
    listed: true,
    body: '{not json',
    what: 'reading message a',
    hold: (slow) => ({ SendMessageCommand: () => slow }),
  },
  // The Consumer bounds a gate call by min(leaseMs, 30 s). A lease of 1500 ms outlasts the settle
  // deadline; settleMs lets it run out.
  {
    name: 'gate extend',
    n: 1,
    handle: ok,
    listed: true,
    timing: { leaseMs: 1500 },
    hungExtend: true,
    settleMs: 1600,
  },
];
for (const end of slowEnds) {
  timed(
    `a slow ${end.name}: the handler returns by the margin and warns`,
    async () => {
      const slow = deferred();
      const sqs = fakeSqs(end.hold?.(slow.promise) ?? {});
      const c = contextOf(1000);
      const locks: ClockLocks = end.hungExtend
        ? Object.assign(clockLocks(), {
            extend: () => new Promise<boolean>(() => {}),
          })
        : clockLocks();
      const { handler, lines } = pushed(sqs, end.handle, {
        margin: MARGIN,
        stop: end.stop,
        locks,
        timing: end.timing,
        observer: end.observer ? () => slow.promise : undefined,
      });
      await locks.acquire(GATE_KEY, 'g1', 600_000);
      const out = await handler(
        { Records: [recordOf('a', { n: end.n, body: end.body })] },
        c,
      );
      assert.equal(c.getRemainingTimeInMillis(), MARGIN);
      assert.deepEqual(
        out.batchItemFailures,
        end.listed ? [{ itemIdentifier: 'a' }] : [],
      );
      assert.ok(
        lines.some(
          (l) =>
            l.level === 'warn' &&
            new RegExp(`${end.what ?? 'task a'} had not settled`).test(
              l.message,
            ),
        ),
      );
      slow.resolve();
      await sleep(end.settleMs ?? 30);
    },
  );
}

// The plan's row expected the margin to end every slow observer. Since phase C a report waits up to
// taskTimeoutMs from its start, so after a quick task the budget ends it, well before the margin.
timed(
  'a slow observer after a quick completion: the budget ends the wait, the handler goes on early, and the record is not listed',
  async () => {
    const sqs = fakeSqs();
    const slow = deferred();
    const c = contextOf(1000);
    const { handler, lines } = pushed(sqs, ok, {
      margin: MARGIN,
      observer: () => slow.promise,
    });
    const out = await handler({ Records: [recordOf('a')] }, c);
    assert.equal(c.getRemainingTimeInMillis(), 500);
    assert.deepEqual(out.batchItemFailures, []);
    assert.equal(sqs.deletes(), 1);
    assert.ok(
      lines.some(
        (l) =>
          l.level === 'warn' &&
          /the completed observers of task a did not settle within 500 ms \(taskTimeoutMs is 500 ms\)/.test(
            l.message,
          ),
      ),
    );
    assert.ok(!lines.some((l) => /had not settled/.test(l.message)));
    slow.resolve();
  },
);

timed(
  'a fail that answers after the next delivery completed changes neither result, and its gate hold ends by itself',
  async () => {
    const answered = deferred();
    const sqs = fakeSqs({
      ChangeMessageVisibilityCommand: (n) =>
        n === 2 ? answered.promise : undefined,
    });
    let runs = 0;
    const { handler, locks, events } = pushed(
      sqs,
      async () => {
        runs += 1;
        if (runs === 1) {
          throw new Error('boom');
        }
      },
      { margin: MARGIN },
    );
    await locks.acquire(GATE_KEY, 'g1', 600_000);
    const one = await handler({ Records: [recordOf('a')] }, contextOf(1000));
    assert.deepEqual(one.batchItemFailures, [{ itemIdentifier: 'a' }]);
    const two = await handler(
      { Records: [recordOf('a', { n: 2, receipt: 'r2' })] },
      contextOf(1000),
    );
    assert.deepEqual(two.batchItemFailures, []);
    assert.equal(locks.entry(GATE_KEY), undefined);
    answered.resolve();
    await sleep(30);
    assert.deepEqual(
      events.map((e) => e.event),
      ['completed', 'failed'],
    );
    // Duplicate work at worst: the retaken gate lapses after backoff + lease.
    const held = (locks.entry(GATE_KEY)?.expiresAt ?? 0) - Date.now();
    assert.ok(held <= 65_000, `gate held ${held}`);
  },
);

timed(
  'a first record with too little time is not started: listed, an error line, the gate held, the visibility left alone',
  async () => {
    const sqs = fakeSqs();
    const { handler, lines, locks } = pushed(sqs, notRun, { margin: MARGIN });
    await locks.acquire(GATE_KEY, 'g1', 1000);
    const out = await handler({ Records: [recordOf('a')] }, contextOf(580)); // half of it is under the margin
    assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
    assert.match(
      lines.find((l) => l.level === 'error')?.message ?? '',
      /message a, the first record of this invocation, was not started: 580 ms left and 290 ms of that for the task, at least 300 ms needed — the function timeout is too small/,
    );
    // Not adopted and not given back: the receive costs the queue's whole visibility timeout, which
    // is a window for an alarm, and the queue can drain before the record comes back.
    assert.deepEqual(sqs.calls, []);
    assert.ok((locks.entry(GATE_KEY)?.expiresAt ?? 0) - Date.now() > 590_000);
    assert.ok(
      !lines.some((l) => /back in the queue/.test(l.message)),
      'it is not back yet, and nothing shut down',
    );
  },
);

timed(
  'a budget of exactly the least is started, and one a millisecond short is not',
  async () => {
    const sqs = fakeSqs();
    const started: string[] = [];
    const { handler } = pushed(
      sqs,
      async () => {
        started.push('ran');
      },
      { margin: MARGIN },
    );
    // The reserve is half the time left, rounded down: 299 of 598 leaves 299, and of 599 leaves 300.
    await handler({ Records: [recordOf('a')] }, contextOf(598));
    assert.deepEqual(started, []);
    assert.deepEqual(sqs.visibility(), [], 'not adopted');
    await handler({ Records: [recordOf('a')] }, contextOf(599));
    assert.deepEqual(started, ['ran']);
    assert.deepEqual(sqs.visibility(), [60], 'adopted');
  },
);

timed(
  'an explicit reserve that leaves too little refuses the first record too',
  async () => {
    const sqs = fakeSqs();
    const { handler, lines } = pushed(sqs, notRun, {
      margin: MARGIN,
      stop: 900,
    });
    const out = await handler({ Records: [recordOf('a')] }, contextOf(1000));
    assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
    assert.ok(
      lines.some(
        (l) => l.level === 'error' && /was not started/.test(l.message),
      ),
    );
  },
);

timed(
  'a first record with no time for a queue call is only listed',
  async () => {
    for (const left of [250, MARGIN]) {
      const sqs = fakeSqs();
      const { handler, lines } = pushed(sqs, notRun, { margin: MARGIN });
      // Past maxAttempts, where a millisecond more would dead-letter it.
      const out = await handler(
        { Records: [recordOf('a', { n: 6 })] },
        contextOf(left),
      );
      assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
      assert.deepEqual(sqs.calls, []);
      assert.ok(
        lines.some(
          (l) => l.level === 'error' && /was not started/.test(l.message),
        ),
      );
    }
    // A millisecond more leaves time for the queue calls of a dead-letter.
    const sqs = fakeSqs();
    const { handler } = pushed(sqs, notRun, { margin: MARGIN });
    const out = await handler(
      { Records: [recordOf('a', { n: 6 })] },
      contextOf(MARGIN + 1),
    );
    assert.deepEqual(out.batchItemFailures, []);
    assert.equal(sqs.deletes(), 1);
  },
);

timed(
  'a record not started runs on its next delivery, under the gate it kept',
  async () => {
    const sqs = fakeSqs();
    const { handler, locks, events } = pushed(sqs, ok, { margin: MARGIN });
    await locks.acquire(GATE_KEY, 'g1', 1000);
    const first = await handler({ Records: [recordOf('a')] }, contextOf(580));
    assert.deepEqual(first.batchItemFailures, [{ itemIdentifier: 'a' }]);
    assert.deepEqual(events, [], 'no event: nothing ran');
    const next = await handler(
      { Records: [recordOf('a', { n: 2, receipt: 'r2' })] },
      contextOf(1000),
    );
    assert.deepEqual(next.batchItemFailures, []);
    assert.deepEqual(sqs.visibility(), [60]);
    assert.equal(sqs.deletes(), 1);
    assert.equal(locks.entry(GATE_KEY), undefined);
  },
);

timed(
  'past maxAttempts with too little time the task is dead-lettered unrun and not listed',
  async () => {
    const sqs = fakeSqs();
    const { handler, events, lines } = pushed(sqs, notRun, { margin: MARGIN });
    const out = await handler(
      { Records: [recordOf('a', { n: 6 })] },
      contextOf(580),
    );
    assert.deepEqual(out.batchItemFailures, []);
    assert.equal(
      (events[0].error as ResizeError).code,
      'RESIZE_TASK_MAX_ATTEMPTS',
    );
    const line = lines.find((l) => /was not started/.test(l.message));
    assert.equal(line?.level, 'error');
    assert.match(line?.message ?? '', /it is past maxAttempts/);
    assert.doesNotMatch(line?.message ?? '', /listed for a retry/);
  },
);

timed(
  'at maxAttempts itself a record not started is left alone, and only past it dead-lettered: the line says which, on a tail record too',
  async () => {
    const sqs = fakeSqs();
    const { handler, lines } = pushed(sqs, notRun, { margin: MARGIN });
    const out = await handler(
      { Records: [recordOf('a', { n: 5 })] },
      contextOf(580),
    );
    assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'a' }]);
    assert.deepEqual(sqs.calls, []);
    assert.match(
      lines.find((l) => /was not started/.test(l.message))?.message ?? '',
      /It is listed for a retry after the queue's visibility timeout/,
    );

    const tail = pushed(fakeSqs(), () => sleep(400), {
      margin: MARGIN,
      stop: 300,
    });
    const head = recordOf('head', {
      body: {
        resizer: 'default',
        queue: 'default',
        mediaId: 'x',
        pipeline: 'p',
        previews: [],
      },
    });
    await tail.handler(
      { Records: [head, recordOf('tail', { n: 6 })] },
      contextOf(1000),
    );
    const line = tail.lines.find((l) => /tail was not started/.test(l.message));
    assert.equal(line?.level, 'warn');
    assert.match(line?.message ?? '', /it is past maxAttempts/);
    assert.doesNotMatch(line?.message ?? '', /listed for a retry/);
  },
);

// A function whose timeout is below the reserve reaches this on every task, after its six quick
// invocations: the budget is under zero, and a timeout made from it would cut the tap off at once.
timed(
  'a dead-letter unrun on a reserve above the time left still waits for its observers, up to the margin',
  async () => {
    const sqs = fakeSqs();
    let finished = false;
    const { handler, lines } = pushed(sqs, notRun, {
      margin: MARGIN,
      stop: 5000,
      observer: async () => {
        await sleep(200);
        finished = true;
      },
    });
    const out = await handler(
      { Records: [recordOf('a', { n: 6 })] },
      contextOf(1000),
    );
    assert.deepEqual(out.batchItemFailures, []);
    assert.equal(finished, true);
    assert.ok(!lines.some((l) => /did not settle/.test(l.message)));

    const hung = fakeSqs();
    const c = contextOf(1000);
    const never = pushed(hung, notRun, {
      margin: MARGIN,
      stop: 5000,
      observer: () => new Promise<void>(() => {}),
    });
    const dead = await never.handler({ Records: [recordOf('a', { n: 6 })] }, c);
    assert.deepEqual(dead.batchItemFailures, [], 'its message is gone');
    assert.match(
      never.lines.find((l) => /was not started/.test(l.message))?.message ?? '',
      /1000 ms left and 0 ms of that for the task, at least 300 ms needed/,
    );
    assert.equal(c.getRemainingTimeInMillis(), MARGIN);
    assert.ok(
      never.lines.some(
        (l) => l.level === 'warn' && /task a had not settled/.test(l.message),
      ),
    );
  },
);

timed(
  'a tail record shorter on time than the longest delivery so far is left alone with a warning, not an error',
  async () => {
    const sqs = fakeSqs();
    const ran: string[] = [];
    const { handler, lines } = pushed(
      sqs,
      async (t) => {
        ran.push(t.mediaId);
        await sleep(400);
      },
      { margin: MARGIN, stop: 300 },
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
          recordOf('head', { body: body('head') }),
          recordOf('tail', { body: body('tail') }),
        ],
      },
      contextOf(1000),
    );
    assert.deepEqual(ran, ['head']);
    assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'tail' }]);
    assert.deepEqual(
      lines.filter((l) => l.level === 'error'),
      [],
    );
    assert.ok(
      lines.some(
        (l) =>
          l.level === 'warn' &&
          /message tail was not started: 600 ms left and 300 ms of that for the task, at least 400 ms needed — it is listed for a retry after the queue's visibility timeout/.test(
            l.message,
          ),
      ),
    );
    assert.ok(
      sqs.calls.every((call) => call.input.ReceiptHandle !== 'rh-tail'),
      'no queue call for it, so it comes back after the rest of the queue had its turn',
    );
  },
);

const bodyOfMedia = (mediaId: string) => ({
  resizer: 'default',
  queue: 'default',
  mediaId,
  pipeline: 'default',
  previews: [],
});

// A 900 s function, its task stopped by its own 600 s taskTimeoutMs, 300 s left and a reserve of
// 35 s, at 1:100. What a stop took says how much time the task was given, not what a task takes, so
// the record after it runs on its 265 s.
timed(
  'a delivery the stop ended does not count as the longest: the record after a hung head still runs',
  async () => {
    const sqs = fakeSqs();
    const ran: string[] = [];
    const { handler } = pushed(
      sqs,
      ({ mediaId }, { signal }) => {
        ran.push(mediaId);
        if (mediaId !== 'hung') {
          return Promise.resolve();
        }
        return new Promise<void>((_r, reject) => {
          signal.addEventListener('abort', () => reject(new Error('stopped')));
        });
      },
      { margin: MARGIN, stop: 350, timing: { taskTimeoutMs: 6000 } },
    );
    const out = await handler(
      {
        Records: [
          recordOf('hung', { body: bodyOfMedia('hung') }),
          recordOf('next', { body: bodyOfMedia('next') }),
        ],
      },
      contextOf(9000),
    );
    assert.deepEqual(ran, ['hung', 'next']);
    assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'hung' }]);
  },
);

// It ignored the stop and ended a little later, inside the settle wait: still the stop's doing.
timed(
  'a delivery that outlives its stop and then ends does not count as the longest either',
  async () => {
    const sqs = fakeSqs();
    const ran: string[] = [];
    const { handler } = pushed(
      sqs,
      async ({ mediaId }) => {
        ran.push(mediaId);
        await sleep(mediaId === 'slow' ? 6100 : 1);
      },
      { margin: MARGIN, stop: 350, timing: { taskTimeoutMs: 6000 } },
    );
    const out = await handler(
      {
        Records: [
          recordOf('slow', { body: bodyOfMedia('slow') }),
          recordOf('next', { body: bodyOfMedia('next') }),
        ],
      },
      contextOf(9000),
    );
    assert.deepEqual(ran, ['slow', 'next']);
    assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'slow' }]);
  },
);

// A failure of its own is a delivery that ended by itself, so it says what a task can take.
timed(
  'a delivery that fails by itself counts as the longest, as one that succeeds does',
  async () => {
    const sqs = fakeSqs();
    const ran: string[] = [];
    const { handler } = pushed(
      sqs,
      async ({ mediaId }) => {
        ran.push(mediaId);
        await sleep(400);
        throw new Error('its own failure');
      },
      { margin: MARGIN, stop: 300 },
    );
    const out = await handler(
      {
        Records: [
          recordOf('head', { body: bodyOfMedia('head') }),
          recordOf('tail', { body: bodyOfMedia('tail') }),
        ],
      },
      contextOf(1000),
    );
    assert.deepEqual(ran, ['head']);
    assert.deepEqual(out.batchItemFailures, [
      { itemIdentifier: 'head' },
      { itemIdentifier: 'tail' },
    ]);
  },
);

// N from the numbers the line prints: a default reserve takes half of what is left, so the budget
// reaches the least at twice that; an explicit one takes itself. Time already spent counts too.
timed(
  'the not-started error line names the function timeout to raise to',
  async () => {
    const rows: {
      name: string;
      T: number;
      stop?: number;
      checks?: () => Promise<void>;
      target: string;
    }[] = [
      { name: 'the default reserve, at 3 s', T: 3000, target: '4 s' },
      { name: 'no time for a queue call', T: 2000, target: '4 s' },
      { name: 'an explicit reserve', T: 6000, stop: 5000, target: '7 s' },
      {
        name: 'a reserve over the time',
        T: 3000,
        stop: 59_000,
        target: '61 s',
      },
      {
        name: 'a cold start that spent 1.2 s, rounded up',
        T: 5000,
        checks: () => sleep(1200),
        target: '6 s',
      },
    ];
    for (const { name, T, stop, checks, target } of rows) {
      const { handler, lines } = pushed(fakeSqs(), notRun, {
        margin: 2000,
        stop,
        checks,
      });
      await handler({ Records: [recordOf('a')] }, contextOf(T));
      const line = lines.find((l) => /was not started/.test(l.message));
      assert.equal(line?.level, 'error', name);
      assert.match(
        line?.message ?? '',
        new RegExp(
          `the function timeout is too small for this reserve; raise it to at least ${target}\\.`,
        ),
        name,
      );
    }
  },
);

timed('the longest delivery so far counts, not the last one', async () => {
  const sqs = fakeSqs();
  const ran: string[] = [];
  const { handler } = pushed(
    sqs,
    async ({ mediaId }) => {
      ran.push(mediaId);
      await sleep(mediaId === 'long' ? 400 : 100);
    },
    { margin: MARGIN, stop: 300 },
  );
  const record = (mediaId: string) =>
    recordOf(mediaId, {
      body: {
        resizer: 'default',
        queue: 'default',
        mediaId,
        pipeline: 'default',
        previews: [],
      },
    });
  // After 500 ms the tail has 350 ms for a task: enough for the last delivery, not for the longest.
  const out = await handler(
    { Records: [record('long'), record('short'), record('tail')] },
    contextOf(1150),
  );
  assert.deepEqual(ran, ['long', 'short']);
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: 'tail' }]);
});

// Lambda's clock and the timers' clock are not one, so the time left can read a little above the
// margin after a settle wait ran out on it. The batch's later records must not take that as time.
timed(
  'a settle wait that ran out holds for the rest of the batch, even when the clock shows a millisecond more',
  async () => {
    const never = () => new Promise<void>(() => {});
    const ways = [
      { name: 'a task', hold: {}, handle: never, stop: 500 },
      {
        name: 'a read',
        hold: { SendMessageCommand: never },
        handle: ok,
        body: '{not json',
      },
      {
        name: 'an adoption',
        hold: { ChangeMessageVisibilityCommand: never },
        handle: ok,
      },
    ];
    for (const { name, hold, handle, stop, body } of ways) {
      const sqs = fakeSqs(hold);
      const { handler, lines } = pushed(sqs, handle, { margin: MARGIN, stop });
      const clock = contextOf(1000);
      const c: LambdaContextLike = {
        getRemainingTimeInMillis: () =>
          Math.max(clock.getRemainingTimeInMillis(), MARGIN + 1),
      };
      // A tail no budget would stop: read, it would go to the dead-letter queue with a call of its own.
      const tail = recordOf('tail', { body: '{not json' });
      const out = await handler(
        { Records: [recordOf('head', { body }), tail] },
        c,
      );
      assert.deepEqual(
        out.batchItemFailures.map((f) => f.itemIdentifier),
        ['head', 'tail'],
        name,
      );
      assert.ok(
        sqs.calls.every((call) => call.input.ReceiptHandle !== 'rh-tail'),
        name,
      );
      assert.ok(
        lines.some(
          (l) =>
            l.level === 'warn' &&
            /message tail was not started/.test(l.message),
        ),
        name,
      );
    }
  },
);

timed(
  'the reserve reads the limit of the task, and a task of a Resizer not served keeps 5 s',
  async () => {
    const stoppedWith = async (seconds: number | undefined) => {
      const c = contextOf(20_000);
      const seen: { left?: number } = {};
      const { handler, wiring } = pushed(fakeSqs(), abortable(c, seen), {
        margin: MARGIN,
      });
      wiring.processingSecondsOf = () => seconds;
      await handler({ Records: [recordOf('a')] }, c);
      return seen.left;
    };
    assert.equal(await stoppedWith(1), 6000);
    assert.equal(await stoppedWith(undefined), 5000);
    const c = contextOf(20_000);
    const seen: { left?: number } = {};
    const { handler } = pushed(fakeSqs(), abortable(c, seen), {
      margin: MARGIN,
      processing: 2,
    });
    await handler({ Records: [recordOf('a')] }, c);
    assert.equal(seen.left, 7000, 'the harness passes `processing` through');
  },
);

timed(
  'after an uncancellable first record the tail makes no queue call and logs no error',
  async () => {
    const sqs = fakeSqs();
    const encode = deferred();
    const c = contextOf(1000);
    const { handler, lines } = pushed(sqs, () => encode.promise, {
      margin: MARGIN,
      stop: 500,
    });
    const out = await handler(
      { Records: [recordOf('head'), recordOf('tail')] },
      c,
    );
    assert.deepEqual(
      out.batchItemFailures.map((f) => f.itemIdentifier),
      ['head', 'tail'],
    );
    assert.ok(
      sqs.calls.every((call) => call.input.ReceiptHandle === 'rh-head'),
    );
    assert.equal(c.getRemainingTimeInMillis(), MARGIN);
    assert.deepEqual(
      lines.filter((l) => l.level === 'error'),
      [],
    );
    encode.resolve();
  },
);

timed('no renewal and no timer of the task outlive the return', async () => {
  const sqs = fakeSqs();
  const encode = deferred();
  const { handler } = pushed(sqs, () => encode.promise, {
    margin: MARGIN,
    stop: 400,
    timing: { leaseMs: 200 },
  });
  await handler({ Records: [recordOf('a')] }, contextOf(900));
  const renewals = sqs.visibility().length;
  await sleep(400);
  assert.equal(sqs.visibility().length, renewals);
  encode.resolve();
});

timed('the flush gets what is left, down to half the margin', async () => {
  const sqs = fakeSqs();
  const { handler, flushes } = pushed(sqs, ok, { margin: MARGIN });
  await handler({ Records: [recordOf('a')] }, contextOf(1000));
  assert.deepEqual(flushes, [850]);
  await handler({ Records: [] }, contextOf(100));
  assert.deepEqual(flushes, [850, 0], 'no time left waits for nothing');
});

timed(
  'checks still running at the settle deadline list every record, log an error and make no queue call; the next invocation reuses them',
  async () => {
    const sqs = fakeSqs();
    const checks = deferred();
    const c = contextOf(800);
    const { handler, lines } = pushed(sqs, ok, {
      margin: MARGIN,
      checks: () => checks.promise,
    });
    const out = await handler({ Records: [recordOf('a'), recordOf('b')] }, c);
    assert.equal(c.getRemainingTimeInMillis(), MARGIN);
    assert.deepEqual(
      out.batchItemFailures.map((f) => f.itemIdentifier),
      ['a', 'b'],
    );
    assert.deepEqual(sqs.calls, []);
    assert.ok(
      lines.some(
        (l) =>
          l.level === 'error' &&
          /the first invocation's checks had not finished/.test(l.message),
      ),
    );
    checks.resolve();
    const next = await handler(
      { Records: [recordOf('a', { n: 2 })] },
      contextOf(5000),
    );
    assert.deepEqual(next.batchItemFailures, []);
  },
);

timed(
  'a visibility call that never answers is an error about the route to SQS, and no task runs',
  async () => {
    const sqs = fakeSqs({
      ChangeMessageVisibilityCommand: () => new Promise<void>(() => {}),
    });
    const { handler, lines } = pushed(sqs, notRun, { margin: MARGIN });
    const c = contextOf(1400);
    const out = await handler({ Records: [recordOf('a'), recordOf('b')] }, c);
    assert.equal(c.getRemainingTimeInMillis(), MARGIN);
    assert.deepEqual(
      out.batchItemFailures.map((f) => f.itemIdentifier),
      ['a', 'b'],
    );
    assert.match(
      lines.find((l) => l.level === 'error')?.message ?? '',
      /message a had not answered .*route to SQS/,
    );
  },
);
