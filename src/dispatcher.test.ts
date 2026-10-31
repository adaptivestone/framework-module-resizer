import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { defaultCoordination } from './config/resize.ts';
import type { LockStore } from './contracts/locks.ts';
import type { TaskAddResult, TaskQueue } from './contracts/taskQueue.ts';
import type { Coordination } from './coordination.ts';
import {
  Dispatcher,
  type DispatchRequest,
  noQueueResult,
} from './dispatcher.ts';
import { ResizeError, ResizeSetupError } from './errors.ts';
import { canonicalizeVariants } from './images.ts';
import { gateKey } from './lockKeys.ts';
import { markUnavailable, RoutingTaskQueue } from './routing.ts';
import {
  type ClockLocks,
  clockLocks,
  MemoryTaskQueue,
  PlainTaskQueue,
} from './testHelpers/fakes.ts';
import { fillTiming, type QueueTiming, timingOf } from './timing.ts';
import type { MissingPreview, ResizeLogger } from './types.d.ts';

// ---------------------------------------------------------------------------
// Harness — a Dispatcher built from a task queue, a lock store, the coordination and a recording
// logger. No Resizer, no media store, no storage and no framework app.
// ---------------------------------------------------------------------------

// Every logged error and warning of the current test.
let errors: unknown[][] = [];
let warnings: unknown[][] = [];
const recordingLogger: ResizeLogger = {
  info() {},
  warn(...a: unknown[]) {
    warnings.push(a);
  },
  error(...a: unknown[]) {
    errors.push(a);
  },
};

beforeEach(() => {
  errors = [];
  warnings = [];
});

interface LockCall {
  op: 'acquire' | 'extend' | 'release';
  key: string;
  owner: string;
}

/** clockLocks that list every call made to them. */
function recordingLocks(base: ClockLocks = clockLocks()) {
  const calls: LockCall[] = [];
  const locks: ClockLocks = {
    acquire: async (key, owner, ttlMs) => {
      calls.push({ op: 'acquire', key, owner });
      return base.acquire(key, owner, ttlMs);
    },
    extend: async (key, owner, ttlMs) => {
      calls.push({ op: 'extend', key, owner });
      return base.extend(key, owner, ttlMs);
    },
    release: async (key, owner) => {
      calls.push({ op: 'release', key, owner });
      return base.release(key, owner);
    },
    entry: (key) => base.entry(key),
  };
  return { locks, calls };
}

/** A lock store whose acquire rejects. */
function rejectingLocks(): LockStore {
  const base = clockLocks();
  return {
    acquire: async () => {
      throw new Error('lock store down');
    },
    extend: base.extend,
    release: base.release,
  };
}

// `locks` left out: clockLocks(); passed as undefined: no lock store.
function makeDispatcher(
  opts: {
    tasks?: TaskQueue;
    locks?: LockStore;
    coordination?: Coordination;
    timingOf?: (queue: string) => QueueTiming;
    name?: string;
  } = {},
) {
  return new Dispatcher({
    tasks: opts.tasks ?? new MemoryTaskQueue(),
    locks: 'locks' in opts ? opts.locks : clockLocks(),
    coordination: opts.coordination ?? defaultCoordination,
    timingOf: opts.timingOf ?? (() => fillTiming({})),
    name: opts.name ?? 'default',
    logger: recordingLogger,
  });
}

const variant = (over: Partial<MissingPreview> = {}): MissingPreview => ({
  sizeKey: '300x300',
  format: 'jpeg',
  ...over,
});

const v300 = variant();
const v600 = variant({ sizeKey: '600x600' });

// The request of most tests: media m1, the default pipeline and queue.
const requestFor = (
  previews: MissingPreview[],
  over: Partial<DispatchRequest> = {},
): DispatchRequest => ({
  mediaId: 'm1',
  pipeline: 'default',
  previews,
  queue: 'default',
  ...over,
});

// The gate lock of media m1, the default pipeline and the default queue of the 'default' Resizer.
const GATE = 'resize_gate:default:default:m1:default';

test('noQueueResult reports every variant as unconfirmed with a non-retryable issue', () => {
  const webp = variant({ format: 'webp' });
  // Canonical order, duplicates dropped.
  const canonical = [variant(), webp];
  assert.deepEqual(noQueueResult([webp, variant(), webp]), {
    accepted: [],
    unconfirmed: canonical,
    tasks: [],
    issues: [
      {
        code: 'RESIZE_ENQUEUE_NO_QUEUE',
        message: 'no task queue is configured',
        retryable: false,
        previews: canonical,
      },
    ],
  });
});

// ---------------------------------------------------------------------------
// The variants of one dispatch: canonical, one per identity
// ---------------------------------------------------------------------------

describe('canonical variants', () => {
  test('canonicalizes variants by payload, nested filter keys, and stable sort', () => {
    const first = variant({
      format: 'webp',
      filters: { nested: { z: 2, a: 1 } } as never,
      requestedWidth: 300,
    });
    const second = variant({ format: 'jpeg', fit: false });
    const canonical = canonicalizeVariants([
      first,
      second,
      { ...first, filters: { nested: { a: 1, z: 2 } } as never },
    ]);
    assert.equal(canonical.length, 2);
    assert.deepEqual(canonical[0], second);
    assert.deepEqual(canonical[1], {
      sizeKey: '300x300',
      format: 'webp',
      filters: { nested: { a: 1, z: 2 } },
      requestedWidth: 300,
    });
    // A permutation of the same request reaches the task queue as the same payload.
    assert.deepEqual(
      canonicalizeVariants([
        second,
        { ...first, filters: { nested: { a: 1, z: 2 } } as never },
      ]),
      canonical,
    );
  });

  test('dedups variants by identity before the add', async () => {
    const tasks = new MemoryTaskQueue();
    const enqueued = await makeDispatcher({ tasks }).enqueue(
      requestFor([variant(), variant()]),
    );
    assert.equal(tasks.added.length, 1);
    assert.equal(tasks.added[0].previews.length, 1);
    assert.equal(enqueued, 1); // the count handed to the task queue
  });

  test('keeps distinct nested filter values as distinct preview identities', async () => {
    const tasks = new MemoryTaskQueue();
    const enqueued = await makeDispatcher({ tasks }).enqueue(
      requestFor([
        variant({ filters: { crop: { x: 0, y: 0 } } as never }),
        variant({ filters: { crop: { x: 10, y: 0 } } as never }),
      ]),
    );
    assert.equal(tasks.added.length, 1);
    assert.equal(tasks.added[0].previews.length, 2);
    assert.equal(enqueued, 2);
  });

  test('keeps nested string and number filter leaves distinct', async () => {
    const tasks = new MemoryTaskQueue();
    const enqueued = await makeDispatcher({ tasks }).enqueue(
      requestFor([
        variant({ filters: { crop: { x: 1 } } as never }),
        variant({ filters: { crop: { x: '1' } } as never }),
      ]),
    );
    assert.equal(tasks.added.length, 1);
    assert.equal(tasks.added[0].previews.length, 2);
    assert.equal(enqueued, 2);
  });

  test('the task carries the Resizer name, the queue, the media, the pipeline and the variants', async () => {
    const tasks = new MemoryTaskQueue();
    const v = variant({ requestedWidth: 300, requestedHeight: 300 });
    await makeDispatcher({ tasks, name: 'listings' }).enqueue(
      requestFor([v], { pipeline: 'photo', queue: 'bulk' }),
    );
    assert.deepEqual(tasks.added, [
      {
        resizer: 'listings',
        queue: 'bulk',
        mediaId: 'm1',
        pipeline: 'photo',
        previews: [v],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The read path's enqueue: one gate per Resizer, media, pipeline and queue
// ---------------------------------------------------------------------------

describe('a task queue that gates by task', () => {
  test('one add per read and no lock call; a second read of the media is in-flight and queues nothing', async () => {
    const tasks = new MemoryTaskQueue();
    const { locks, calls } = recordingLocks();
    const d = makeDispatcher({ tasks, locks });
    assert.equal(await d.enqueue(requestFor([v300])), 1);
    // Another variant of the same media, pipeline and queue: the active task is the gate.
    assert.equal(await d.enqueue(requestFor([v600])), 0);
    assert.equal(tasks.rows.length, 1);
    assert.equal(tasks.added.length, 2);
    assert.equal('gateOwner' in tasks.added[0], false);
    assert.deepEqual(calls, []);
    assert.deepEqual(errors, [], 'a task in flight is not a failure');
  });

  test('needs no lock store', async () => {
    const tasks = new MemoryTaskQueue();
    assert.equal(
      await makeDispatcher({ tasks, locks: undefined }).enqueue(
        requestFor([v300]),
      ),
      1,
    );
    assert.equal(tasks.rows.length, 1);
  });

  test('another pipeline, Resizer, media or queue is a new task', async () => {
    const tasks = new MemoryTaskQueue();
    const d = makeDispatcher({ tasks });
    assert.equal(await d.enqueue(requestFor([v300])), 1);
    for (const [label, dispatcher, over] of [
      ['pipeline', d, { pipeline: 'watermark' }],
      ['Resizer', makeDispatcher({ tasks, name: 'listings' }), {}],
      ['media', d, { mediaId: 'm2' }],
      ['queue', d, { queue: 'bulk' }],
    ] as const) {
      assert.equal(
        await dispatcher.enqueue(requestFor([v300], over)),
        1,
        label,
      );
    }
    assert.equal(tasks.rows.length, 5);
  });

  test('an in-flight result without a task id is logged once per Dispatcher at warn; the outcome is unchanged', async () => {
    const tasks = new MemoryTaskQueue();
    tasks.add = async () => ({ status: 'in-flight' });
    const d = makeDispatcher({ tasks });
    assert.equal(await d.enqueue(requestFor([v300])), 0);
    assert.equal(await d.enqueue(requestFor([v600])), 0);
    const confirmed = await d.enqueueConfirmed(requestFor([v300]));
    assert.deepEqual(
      confirmed.issues.map(({ code }) => code),
      ['RESIZE_TASK_IN_FLIGHT'],
    );
    assert.equal(warnings.length, 1);
    assert.match(
      String(warnings[0][0]),
      /reported a task in flight without its id; if this repeats, the gate index may lack its partial filter — see RESIZE_MONGO_INDEX_MISSING/,
    );
    assert.deepEqual(errors, []);
    // With its id it is the normal gate: nothing logged.
    warnings = [];
    const plain = new MemoryTaskQueue();
    const other = makeDispatcher({ tasks: plain });
    assert.equal(await other.enqueue(requestFor([v300])), 1);
    assert.equal(await other.enqueue(requestFor([v300])), 0);
    assert.deepEqual(warnings, []);
  });

  test('a prewarm on bulk while a default task is active queues a bulk task', async () => {
    const tasks = new MemoryTaskQueue();
    const d = makeDispatcher({ tasks });
    assert.equal(await d.enqueue(requestFor([v300])), 1);
    assert.deepEqual(
      await d.enqueueConfirmed(requestFor([v300, v600], { queue: 'bulk' })),
      {
        accepted: [v300, v600],
        unconfirmed: [],
        tasks: [{ taskId: 'task-2', previews: [v300, v600] }],
        issues: [],
      },
    );
    assert.deepEqual(
      tasks.rows.map(({ task }) => task.queue),
      ['default', 'bulk'],
    );
  });
});

describe('a task queue without gatesByTask', () => {
  test('one gate lock per Resizer, media, pipeline and queue, owned by a fresh token that the task carries', async () => {
    const now = 5_000;
    const tasks = new PlainTaskQueue();
    const locks = clockLocks(() => now);
    const coordination = { gateTtlMs: 123_456, cooldownMs: 1_000 };
    const d = makeDispatcher({ tasks, locks, coordination });
    assert.equal(await d.enqueue(requestFor([v300, v600])), 2);
    const gate = locks.entry(GATE);
    assert.ok(gate);
    assert.match(gate.owner, /^[0-9a-f]{32}$/);
    assert.equal(tasks.added[0].gateOwner, gate.owner);
    assert.equal(gate.expiresAt - now, coordination.gateTtlMs);
    // While the gate lock is held, the media, pipeline and queue get no other task.
    assert.equal(await d.enqueue(requestFor([v300])), 0);
    assert.equal(tasks.rows.length, 1);
    // Each dispatch takes its own owner token.
    assert.equal(await d.enqueue(requestFor([v300], { mediaId: 'm2' })), 1);
    const other = locks.entry('resize_gate:default:default:m2:default');
    assert.match(other?.owner ?? '', /^[0-9a-f]{32}$/);
    assert.notEqual(other?.owner, gate.owner);
    assert.equal(tasks.added[1].gateOwner, other?.owner);
    assert.deepEqual(errors, []);
  });

  test('the gate lock is shortened to one lease, still owned by the dispatch, when add throws, resolves unconfirmed or in-flight, or an older result', async () => {
    const now = 5_000;
    const leaseMs = 30_000;
    const cases: [string, () => Promise<TaskAddResult>, number][] = [
      [
        'throws',
        async () => {
          throw new Error('queue down');
        },
        1,
      ],
      ['unconfirmed', async () => ({ status: 'unconfirmed' }), 1],
      ['in-flight', async () => ({ status: 'in-flight' }), 0],
      // An older TaskQueue: logged once, as a contract mismatch.
      ['an older result', async () => ({ taskId: 'x' }) as never, 1],
    ];
    for (const [label, add, logged] of cases) {
      errors = [];
      const tasks = new PlainTaskQueue();
      tasks.add = add;
      // The queue may have stored the task although it did not say so (a lost response).
      const { locks, calls } = recordingLocks(clockLocks(() => now));
      const d = makeDispatcher({
        tasks,
        locks,
        timingOf: () => fillTiming({ leaseMs }),
      });
      assert.equal(await d.enqueue(requestFor([v300])), 0, label);
      const [acquire, extend] = calls;
      assert.deepEqual(
        calls.map(({ op, key }) => [op, key]),
        [
          ['acquire', GATE],
          ['extend', GATE],
        ],
        label,
      );
      assert.equal(extend.owner, acquire.owner, label);
      assert.deepEqual(
        locks.entry(GATE),
        { owner: acquire.owner, expiresAt: now + leaseMs },
        label,
      );
      // While it lasts, the media, pipeline and queue get no other task.
      tasks.add = PlainTaskQueue.prototype.add;
      assert.equal(await d.enqueue(requestFor([v300])), 0, label);
      assert.equal(tasks.rows.length, 0, label);
      assert.equal(errors.length, logged, label);
    }
  });

  test('an unconfirmed add on the read path is logged once, and again after an add was confirmed', async () => {
    const tasks = new MemoryTaskQueue();
    const realAdd = tasks.add.bind(tasks);
    let confirm = false;
    tasks.add = async (task) =>
      confirm ? realAdd(task) : { status: 'unconfirmed' };
    const d = makeDispatcher({ tasks });
    const unconfirmedLines = () =>
      errors.filter(([message]) =>
        /did not confirm the task/.test(String(message)),
      ).length;
    for (let i = 0; i < 5; i++) {
      assert.equal(await d.enqueue(requestFor([v300])), 0);
    }
    assert.equal(unconfirmedLines(), 1);
    confirm = true;
    assert.equal(await d.enqueue(requestFor([v300])), 1);
    confirm = false;
    assert.equal(await d.enqueue(requestFor([v300], { mediaId: 'm2' })), 0);
    assert.equal(unconfirmedLines(), 2);
  });

  test('the one-lease hold never exceeds gateTtlMs (a lease longer than the gate lock)', async () => {
    const now = 5_000;
    const tasks = new PlainTaskQueue();
    tasks.add = async () => ({ status: 'unconfirmed' });
    const locks = clockLocks(() => now);
    const d = makeDispatcher({
      tasks,
      locks,
      timingOf: () => fillTiming({ leaseMs: 60_000 }),
      coordination: { gateTtlMs: 10_000, cooldownMs: 1_000 },
    });
    assert.equal(await d.enqueue(requestFor([v300])), 0);
    assert.equal(locks.entry(GATE)?.expiresAt, now + 10_000);
  });

  test("an unconfirmed add keeps the gate lock for the lease of the call's lane", async () => {
    const tasks = new PlainTaskQueue({
      queueTiming: { bulk: { leaseMs: 120_000 } },
    });
    tasks.add = async () => ({ status: 'unconfirmed' });
    const locks = clockLocks(() => 0);
    const d = makeDispatcher({
      tasks,
      locks,
      coordination: { gateTtlMs: 600_000, cooldownMs: 1_000 },
      timingOf: (queue) => timingOf(tasks, queue),
    });
    assert.equal(await d.enqueue(requestFor([v300], { queue: 'bulk' })), 0);
    assert.equal(
      locks.entry(gateKey('default', 'bulk', 'm1', 'default'))?.expiresAt,
      120_000,
    );
    assert.equal(
      await d.enqueue(requestFor([v300], { mediaId: 'm2', queue: 'default' })),
      0,
    );
    assert.equal(
      locks.entry(gateKey('default', 'default', 'm2', 'default'))?.expiresAt,
      60_000,
    );
  });

  test('a call on a queue with invalid timing queues nothing and reports it as the own queue would', async () => {
    const tasks = new PlainTaskQueue({
      queueTiming: { bulk: { leaseMs: 0 }, audit: { leaseMs: 0 } },
    });
    const locks = clockLocks();
    const d = makeDispatcher({
      tasks,
      locks,
      timingOf: (queue) => timingOf(tasks, queue),
    });
    const bulk = requestFor([v300, v600], { queue: 'bulk' });
    // prewarm: every variant unconfirmed, no issue of its own; the error goes back to the Reader,
    // which reports it as it reports an own queue whose timing is invalid.
    const confirmed = await d.enqueueConfirmed(bulk);
    assert.deepEqual(
      { ...confirmed, timingError: undefined },
      {
        accepted: [],
        unconfirmed: [v300, v600],
        tasks: [],
        issues: [],
        timingError: undefined,
      },
    );
    assert.ok(
      confirmed.timingError instanceof Error &&
        /leaseMs/.test(confirmed.timingError.message) &&
        /queue 'bulk'/.test(confirmed.timingError.message),
    );
    // The read path logs the error once per queue name, at error.
    assert.equal(await d.enqueue(bulk), 0);
    assert.equal(
      await d.enqueue(requestFor([v300], { mediaId: 'm2', queue: 'bulk' })),
      0,
    );
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /'bulk'/);
    // Invalid timing is never cached, so each call reads it again and meets a new error.
    assert.equal(
      (errors[0][1] as Error).message,
      confirmed.timingError.message,
    );
    // Another queue name with invalid timing is logged once too.
    assert.equal(await d.enqueue(requestFor([v300], { queue: 'audit' })), 0);
    assert.equal(await d.enqueue(requestFor([v300], { queue: 'audit' })), 0);
    assert.equal(errors.length, 2);
    assert.match(String(errors[1][0]), /'audit'/);
    // Nothing reached the task queue or the lock store.
    assert.deepEqual(tasks.added, []);
    assert.equal(
      locks.entry(gateKey('default', 'bulk', 'm1', 'default')),
      undefined,
    );
    // The default lane still queues.
    const own = await d.enqueueConfirmed(requestFor([v300]));
    assert.deepEqual(own.accepted, [v300]);
    assert.equal('timingError' in own, false);
    assert.equal(tasks.added.length, 1);
  });

  test('a call on a queue the task queue does not serve queues nothing and never reads its timing', async () => {
    const tasks = new PlainTaskQueue({ queues: ['default'] });
    const asked: string[] = [];
    const locks = clockLocks();
    const d = makeDispatcher({
      tasks,
      locks,
      timingOf: (queue) => {
        asked.push(queue);
        return timingOf(tasks, queue);
      },
    });
    const bulk = requestFor([v300, v600], { queue: 'bulk' });
    const message =
      "cannot queue to 'bulk': its task queue does not serve that queue (a queue name it does not route)";
    assert.deepEqual(await d.enqueueConfirmed(bulk), {
      accepted: [],
      unconfirmed: [v300, v600],
      tasks: [],
      issues: [
        {
          code: 'RESIZE_QUEUE_NOT_SERVED',
          message,
          retryable: false,
          previews: [v300, v600],
        },
      ],
    });
    // The read path warns once per queue name.
    assert.equal(await d.enqueue(bulk), 0);
    assert.equal(await d.enqueue(bulk), 0);
    assert.equal(warnings.length, 1);
    assert.ok(String(warnings[0][0]).includes(message));
    assert.deepEqual(tasks.added, []);
    assert.equal(
      locks.entry(gateKey('default', 'bulk', 'm1', 'default')),
      undefined,
    );
    assert.deepEqual(asked, []);
    assert.deepEqual(errors, []);
  });

  test('a servesQueue that answers undefined is not served, as verify() and the worker read it', async () => {
    const tasks = new PlainTaskQueue();
    tasks.servesQueue = (() => undefined) as never;
    const d = makeDispatcher({ tasks });
    assert.equal(await d.enqueue(requestFor([v300])), 0);
    const confirmed = await d.enqueueConfirmed(requestFor([v300]));
    assert.deepEqual(confirmed.accepted, []);
    assert.equal(confirmed.issues[0]?.code, 'RESIZE_QUEUE_NOT_SERVED');
    assert.deepEqual(tasks.added, []);
    assert.equal(warnings.length, 1);
  });

  test('a rejecting extend after an unconfirmed add is logged; the lock stays as acquired', async () => {
    const now = 5_000;
    const tasks = new PlainTaskQueue();
    tasks.add = async () => ({ status: 'unconfirmed' });
    const base = clockLocks(() => now);
    const locks: LockStore = Object.assign({}, base, {
      extend: async () => {
        throw new Error('lock store down');
      },
    });
    const coordination = { gateTtlMs: 123_456, cooldownMs: 1_000 };
    const d = makeDispatcher({ tasks, locks, coordination });
    assert.equal(await d.enqueue(requestFor([v300])), 0);
    assert.equal(base.entry(GATE)?.expiresAt, now + coordination.gateTtlMs);
    assert.ok(
      errors.some(([message]) => /shorten the gate lock/.test(String(message))),
    );
  });

  test('a held gate lock queues nothing; a rejecting acquire is logged and queues nothing', async () => {
    const tasks = new PlainTaskQueue();
    const locks = clockLocks();
    assert.equal(await locks.acquire(GATE, 'another request', 60_000), true);
    assert.equal(
      await makeDispatcher({ tasks, locks }).enqueue(requestFor([v300])),
      0,
    );
    assert.equal(tasks.added.length, 0);
    assert.equal(locks.entry(GATE)?.owner, 'another request');
    assert.deepEqual(errors, [], 'a held gate lock is not a failure');

    assert.equal(
      await makeDispatcher({ tasks, locks: rejectingLocks() }).enqueue(
        requestFor([v300]),
      ),
      0,
    );
    assert.equal(tasks.added.length, 0);
    assert.equal(errors.length, 1);
  });

  test('an added result with an unusable task id keeps the gate lock: the queue says it stored the task', async () => {
    const tasks = new PlainTaskQueue();
    tasks.add = async () => ({ status: 'added', taskId: '' }) as never;
    const locks = clockLocks();
    const d = makeDispatcher({ tasks, locks });
    assert.equal(await d.enqueue(requestFor([v300])), 0);
    const gate = locks.entry(GATE);
    assert.ok(gate, 'the gate lock is kept');
    assert.match(gate.owner, /^[0-9a-f]{32}$/);

    const other = clockLocks();
    const confirmed = await makeDispatcher({
      tasks,
      locks: other,
    }).enqueueConfirmed(requestFor([v300]));
    assert.ok(other.entry(GATE), 'the gate lock is kept');
    assert.deepEqual(confirmed.accepted, []);
    assert.deepEqual(
      confirmed.issues.map(({ code, retryable }) => ({ code, retryable })),
      [{ code: 'RESIZE_ENQUEUE_UNCONFIRMED', retryable: false }],
    );
    assert.match(confirmed.issues[0].message, /TaskAddResult/);
    // Logged once per Dispatcher, naming the contract.
    assert.equal(
      errors.filter((e) => /TaskAddResult/.test(String(e[0]))).length,
      2,
    );
  });

  test('gate keys cannot collide: each part is URI-encoded', async () => {
    assert.notEqual(
      gateKey('a:x', 'q', 'y', 'default'),
      gateKey('a', 'q', 'x:y', 'default'),
    );
    assert.equal(
      gateKey('a:x', 'q', 'm 1', 'default'),
      'resize_gate:a%3Ax:q:m%201:default',
    );
    assert.equal(gateKey('default', 'default', 'm1', 'default'), GATE);
    // Through the Dispatcher: Resizer 'a:x' with media 'y', and Resizer 'a' with media 'x:y'.
    const tasks = new PlainTaskQueue();
    const locks = clockLocks();
    assert.equal(
      await makeDispatcher({ tasks, locks, name: 'a:x' }).enqueue(
        requestFor([v300], { mediaId: 'y' }),
      ),
      1,
    );
    assert.equal(
      await makeDispatcher({ tasks, locks, name: 'a' }).enqueue(
        requestFor([v300], { mediaId: 'x:y' }),
      ),
      1,
    );
    assert.equal(tasks.rows.length, 2);
  });

  test('gate keys are separate per Resizer, pipeline and queue', async () => {
    const tasks = new PlainTaskQueue();
    const { locks, calls } = recordingLocks();
    assert.equal(
      await makeDispatcher({ tasks, locks }).enqueue(requestFor([v300])),
      1,
    );
    assert.equal(
      await makeDispatcher({ tasks, locks }).enqueue(
        requestFor([v300], { pipeline: 'watermark' }),
      ),
      1,
    );
    assert.equal(
      await makeDispatcher({ tasks, locks, name: 'listings' }).enqueue(
        requestFor([v300]),
      ),
      1,
    );
    // Another queue is a new task.
    assert.equal(
      await makeDispatcher({ tasks, locks }).enqueue(
        requestFor([v300], { queue: 'bulk' }),
      ),
      1,
    );
    assert.equal(tasks.rows.length, 4);
    assert.deepEqual(
      calls.map(({ op, key }) => [op, key]),
      [
        ['acquire', GATE],
        ['acquire', 'resize_gate:default:default:m1:watermark'],
        ['acquire', 'resize_gate:listings:default:m1:default'],
        ['acquire', 'resize_gate:default:bulk:m1:default'],
      ],
    );
  });
});

test('an add result without a status (an older TaskQueue) never counts as queued, and is logged once', async () => {
  const tasks = new MemoryTaskQueue();
  tasks.add = async () => ({ taskId: 'x' }) as never;
  const d = makeDispatcher({ tasks });
  assert.equal(await d.enqueue(requestFor([v300])), 0);
  assert.equal(await d.enqueue(requestFor([v300])), 0);
  const contract = () =>
    errors.filter((e) => /TaskAddResult/.test(String(e[0]))).length;
  assert.equal(contract(), 1);
  const confirmed = await d.enqueueConfirmed(requestFor([v300]));
  assert.deepEqual(confirmed.accepted, []);
  assert.deepEqual(confirmed.unconfirmed, [v300]);
  assert.deepEqual(confirmed.tasks, []);
  assert.equal(confirmed.issues.length, 1);
  const [issue] = confirmed.issues;
  assert.deepEqual(
    { code: issue.code, retryable: issue.retryable },
    { code: 'RESIZE_ENQUEUE_UNCONFIRMED', retryable: false },
  );
  assert.match(issue.message, /TaskAddResult/);
  assert.equal(contract(), 1, 'still logged once');
});

// ---------------------------------------------------------------------------
// Prewarm's strict counterpart: what is accepted, and why the rest is not
// ---------------------------------------------------------------------------

describe('enqueueConfirmed', () => {
  test('a cold media: every variant accepted, and the new task is the receipt', async () => {
    const tasks = new MemoryTaskQueue();
    assert.deepEqual(
      await makeDispatcher({ tasks }).enqueueConfirmed(
        requestFor([v600, v300]),
      ),
      {
        accepted: [v300, v600],
        unconfirmed: [],
        tasks: [{ taskId: 'task-1', previews: [v300, v600] }],
        issues: [],
      },
    );
  });

  test('an active task: the variants it holds are accepted with it as the receipt; the rest are RESIZE_TASK_IN_FLIGHT', async () => {
    const tasks = new MemoryTaskQueue();
    const d = makeDispatcher({ tasks });
    assert.equal(await d.enqueue(requestFor([v300])), 1);
    assert.deepEqual(await d.enqueueConfirmed(requestFor([v300, v600])), {
      accepted: [v300],
      unconfirmed: [v600],
      tasks: [{ taskId: 'task-1', previews: [v300] }],
      issues: [
        {
          code: 'RESIZE_TASK_IN_FLIGHT',
          message:
            'a task for this media, pipeline and queue is active, or cooling down after a dead-letter; a read after it finishes queues these',
          retryable: true,
          previews: [v600],
        },
      ],
    });
    assert.equal(tasks.rows.length, 1);
    assert.deepEqual(errors, []);
  });

  test('during a dead-letter cooldown nothing is accepted: every variant is RESIZE_TASK_IN_FLIGHT', async () => {
    let now = 0;
    const tasks = new MemoryTaskQueue({ now: () => now });
    const d = makeDispatcher({ tasks });
    assert.equal(await d.enqueue(requestFor([v300])), 1);
    const claimed = await tasks.claim('default', 60_000);
    assert.ok(claimed);
    assert.equal(
      await tasks.fail(claimed, 'dead', 'x', { cooldownMs: 60_000 }),
      true,
    );
    const cooling = await d.enqueueConfirmed(requestFor([v300, v600]));
    assert.deepEqual(cooling.accepted, []);
    assert.deepEqual(cooling.tasks, []);
    assert.deepEqual(cooling.unconfirmed, [v300, v600]);
    assert.deepEqual(
      cooling.issues.map(({ code, retryable, previews }) => ({
        code,
        retryable,
        previews,
      })),
      [
        {
          code: 'RESIZE_TASK_IN_FLIGHT',
          retryable: true,
          previews: [v300, v600],
        },
      ],
    );
    // Once the cooldown ends, the next request queues the task.
    now = 60_000;
    assert.deepEqual(
      (await d.enqueueConfirmed(requestFor([v300, v600]))).accepted,
      [v300, v600],
    );
  });

  test('a held gate lock on a queue without gatesByTask is RESIZE_ENQUEUE_LOCK_CONTENDED', async () => {
    const tasks = new PlainTaskQueue();
    const locks = clockLocks();
    assert.equal(await locks.acquire(GATE, 'another request', 60_000), true);
    assert.deepEqual(
      await makeDispatcher({ tasks, locks }).enqueueConfirmed(
        requestFor([v300]),
      ),
      {
        accepted: [],
        unconfirmed: [v300],
        tasks: [],
        issues: [
          {
            code: 'RESIZE_ENQUEUE_LOCK_CONTENDED',
            message:
              "the gate lock of this media, pipeline and queue is held: a task of theirs is queued, running or waiting for a retry, or a dead task's cooldown runs",
            retryable: true,
            previews: [v300],
          },
        ],
      },
    );
    assert.equal(tasks.added.length, 0);
  });

  test('an active task that holds another payload for a requested identity confirms nothing for it', async () => {
    const tasks = new MemoryTaskQueue();
    // The active task holds the requested payload and another one for the same identity.
    await tasks.add({
      resizer: 'default',
      queue: 'default',
      mediaId: 'm1',
      pipeline: 'default',
      previews: [v300, { ...v300, requestedWidth: 20 }, v600],
    });
    const result = await makeDispatcher({ tasks }).enqueueConfirmed(
      requestFor([v300, v600]),
    );
    assert.deepEqual(result.accepted, [v600]);
    assert.deepEqual(result.tasks, [{ taskId: 'task-1', previews: [v600] }]);
    assert.deepEqual(result.unconfirmed, [v300]);
    assert.deepEqual(
      result.issues.map(({ code, retryable, previews }) => ({
        code,
        retryable,
        previews,
      })),
      [
        {
          code: 'RESIZE_ENQUEUE_VARIANT_CONFLICT',
          retryable: false,
          previews: [v300],
        },
      ],
    );
  });

  test('two payloads for one requested identity are a conflict, and stay out of the task', async () => {
    const tasks = new MemoryTaskQueue();
    const wide = { ...v300, requestedWidth: 20 };
    const result = await makeDispatcher({ tasks }).enqueueConfirmed(
      requestFor([v300, wide, v600]),
    );
    assert.deepEqual(tasks.added[0].previews, [v600]);
    assert.deepEqual(result.accepted, [v600]);
    assert.deepEqual(result.unconfirmed, [wide, v300]);
    assert.deepEqual(
      result.issues.map(({ code, retryable, previews }) => ({
        code,
        retryable,
        previews,
      })),
      [
        {
          code: 'RESIZE_ENQUEUE_VARIANT_CONFLICT',
          retryable: false,
          previews: [wide, v300],
        },
      ],
    );
  });

  test('every other outcome confirms nothing, with its retryable issue', async () => {
    const throwing = async () => {
      throw new Error('down');
    };
    const cases: {
      label: string;
      tasks: () => TaskQueue;
      locks?: () => LockStore;
      code: string;
    }[] = [
      {
        label: 'findActive rejects after an in-flight add',
        tasks: () => {
          const q = new MemoryTaskQueue();
          q.add = async () => ({ status: 'in-flight', taskId: 'other' });
          q.findActive = throwing;
          return q;
        },
        code: 'RESIZE_ENQUEUE_CONFIRM_FAILED',
      },
      {
        label: 'an in-flight add on a queue without findActive',
        tasks: () => {
          const q = new PlainTaskQueue();
          q.add = async () => ({ status: 'in-flight' });
          return q;
        },
        code: 'RESIZE_TASK_IN_FLIGHT',
      },
      {
        label: 'an id-less in-flight add whose task findActive no longer sees',
        tasks: () => {
          const q = new MemoryTaskQueue();
          q.add = async () => ({ status: 'in-flight' });
          return q;
        },
        code: 'RESIZE_TASK_IN_FLIGHT',
      },
      {
        label: 'an unconfirmed add',
        tasks: () => {
          const q = new MemoryTaskQueue();
          q.add = async () => ({ status: 'unconfirmed' });
          return q;
        },
        code: 'RESIZE_ENQUEUE_UNCONFIRMED',
      },
      {
        label: 'a throwing add',
        tasks: () => {
          const q = new MemoryTaskQueue();
          q.add = throwing;
          return q;
        },
        code: 'RESIZE_ENQUEUE_QUEUE_FAILED',
      },
      {
        label: 'a rejecting acquire',
        tasks: () => new PlainTaskQueue(),
        locks: rejectingLocks,
        code: 'RESIZE_ENQUEUE_LOCK_FAILED',
      },
    ];
    for (const { label, tasks, locks, code } of cases) {
      const queue = tasks();
      const result = await makeDispatcher({
        tasks: queue,
        locks: locks ? locks() : clockLocks(),
      }).enqueueConfirmed(requestFor([v300, v600]));
      assert.deepEqual(result.accepted, [], label);
      assert.deepEqual(result.tasks, [], label);
      assert.deepEqual(result.unconfirmed, [v300, v600], label);
      assert.deepEqual(
        result.issues.map((issue) => ({
          code: issue.code,
          retryable: issue.retryable,
          previews: issue.previews,
        })),
        [{ code, retryable: true, previews: [v300, v600] }],
        label,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// A router: each call asks its questions of the backend that carries its queue
// ---------------------------------------------------------------------------

describe('a task queue that routes queue names to backends', () => {
  test("on a router, each call gets its queue's gate: the gating route adds with no lock, the plain route takes the gate lock", async () => {
    const memory = new MemoryTaskQueue();
    const plain = new PlainTaskQueue();
    const { locks, calls } = recordingLocks();
    const d = makeDispatcher({
      tasks: new RoutingTaskQueue({ default: memory, bulk: plain }),
      locks,
    });
    const own = await d.enqueueConfirmed(requestFor([v300]));
    assert.deepEqual(own.accepted, [v300]);
    assert.equal(calls.filter((c) => c.op === 'acquire').length, 0);
    const bulk = await d.enqueueConfirmed(
      requestFor([v300], { queue: 'bulk' }),
    );
    assert.deepEqual(bulk.accepted, [v300]);
    assert.deepEqual(bulk.issues, []);
    assert.deepEqual(
      calls.filter((c) => c.op === 'acquire').map((c) => c.key),
      [gateKey('default', 'bulk', 'm1', 'default')],
    );
    assert.equal(memory.added.length, 1);
    assert.equal(memory.added[0].gateOwner, undefined);
    assert.equal(plain.added.length, 1);
    assert.equal(plain.added[0].gateOwner, calls[0].owner);
  });

  test('after an in-flight add, findActive is asked of the route', async () => {
    const memory = new MemoryTaskQueue();
    let asked = 0;
    const findActive = memory.findActive.bind(memory);
    memory.findActive = (query) => {
      asked += 1;
      return findActive(query);
    };
    const router = new RoutingTaskQueue({ default: memory });
    router.findActive = async () => assert.fail('the router was asked');
    const d = makeDispatcher({ tasks: router });
    const first = await d.enqueueConfirmed(requestFor([v300]));
    const again = await d.enqueueConfirmed(requestFor([v300]));
    assert.equal(asked, 1);
    assert.deepEqual(again.accepted, [v300]);
    assert.deepEqual(again.tasks, first.tasks);
  });

  test('a route whose build fails: prewarm reports its code and retryable, the read path logs it once per name, the other route still queues', async () => {
    const cases: { error: unknown; issue: Record<string, unknown> }[] = [
      {
        error: new ResizeSetupError('install @aws-sdk/client-sqs', {
          code: 'RESIZE_PEER_MISSING',
        }),
        issue: {
          code: 'RESIZE_ENQUEUE_QUEUE_FAILED',
          causeCode: 'RESIZE_PEER_MISSING',
          message: 'install @aws-sdk/client-sqs',
          retryable: true,
        },
      },
      {
        error: new ResizeError('no bucket', {
          code: 'GCS_BUCKET_MISSING',
          retryable: false,
        }),
        issue: {
          code: 'RESIZE_ENQUEUE_QUEUE_FAILED',
          causeCode: 'GCS_BUCKET_MISSING',
          message: 'no bucket',
          retryable: false,
        },
      },
      {
        error: new ResizeError('not here', {
          code: 'RESIZE_QUEUE_NOT_SERVED',
          retryable: false,
        }),
        issue: {
          code: 'RESIZE_QUEUE_NOT_SERVED',
          message: 'not here',
          retryable: false,
        },
      },
      {
        // A setup error keeps its own retryable: no prewarm advice rule on this path.
        error: new ResizeSetupError('wiring'),
        issue: {
          code: 'RESIZE_ENQUEUE_QUEUE_FAILED',
          causeCode: 'RESIZE_SETUP',
          message: 'wiring',
          retryable: true,
        },
      },
      {
        error: new Error('boom'),
        issue: {
          code: 'RESIZE_ENQUEUE_QUEUE_FAILED',
          message: 'boom',
          retryable: true,
        },
      },
    ];
    for (const { error, issue } of cases) {
      errors = [];
      const memory = new MemoryTaskQueue();
      const d = makeDispatcher({
        tasks: new RoutingTaskQueue({
          default: memory,
          bulk: async () => {
            throw error;
          },
        }),
      });
      const bulk = requestFor([v300, v600], { queue: 'bulk' });
      assert.deepEqual(
        await d.enqueueConfirmed(bulk),
        {
          accepted: [],
          unconfirmed: [v300, v600],
          tasks: [],
          issues: [{ ...issue, previews: [v300, v600] }],
        },
        String(error),
      );
      // The read path logs it once per queue name and error, and queues nothing.
      assert.equal(await d.enqueue(bulk), 0);
      assert.equal(await d.enqueue(bulk), 0);
      assert.equal(errors.length, 1, String(error));
      assert.match(String(errors[0][0]), /cannot queue to 'bulk'/);
      assert.equal(errors[0][1], error);
      // The other route still queues.
      assert.equal(await d.enqueue(requestFor([v300])), 1);
      assert.equal(memory.added.length, 1);
    }
  });

  test('a name marked unavailable: prewarm is RESIZE_QUEUE_NOT_SERVED, not retryable, and the message names the package; resolve logs it once', async () => {
    const tasks = new MemoryTaskQueue({ queues: ['default'] });
    markUnavailable(tasks, ['bulk'], {
      driver: 'sqs',
      packages: ['@aws-sdk/client-sqs'],
      error: new ResizeSetupError('peer missing', {
        code: 'RESIZE_PEER_MISSING',
      }),
    });
    const d = makeDispatcher({ tasks });
    const bulk = requestFor([v300], { queue: 'bulk' });
    const message =
      "cannot queue to 'bulk': its task queue does not serve that queue (its driver 'sqs' needs @aws-sdk/client-sqs, which is not installed)";
    assert.deepEqual((await d.enqueueConfirmed(bulk)).issues, [
      {
        code: 'RESIZE_QUEUE_NOT_SERVED',
        message,
        retryable: false,
        previews: [v300],
      },
    ]);
    assert.equal(await d.enqueue(bulk), 0);
    assert.equal(await d.enqueue(bulk), 0);
    assert.equal(warnings.length, 1);
    assert.ok(String(warnings[0][0]).includes(message));
    assert.deepEqual(tasks.added, []);
  });

  test('a call on a plain route without a lock store reports RESIZE_ENQUEUE_LOCK_FAILED with causeCode RESIZE_LOCKS_REQUIRED; the gating route still queues', async () => {
    const memory = new MemoryTaskQueue();
    const plain = new PlainTaskQueue();
    const d = makeDispatcher({
      tasks: new RoutingTaskQueue({ default: memory, bulk: plain }),
      locks: undefined,
    });
    const bulk = requestFor([v300], { queue: 'bulk' });
    const [issue] = (await d.enqueueConfirmed(bulk)).issues;
    assert.deepEqual(
      {
        code: issue.code,
        causeCode: issue.causeCode,
        retryable: issue.retryable,
      },
      {
        code: 'RESIZE_ENQUEUE_LOCK_FAILED',
        causeCode: 'RESIZE_LOCKS_REQUIRED',
        retryable: false,
      },
    );
    assert.match(issue.message, /'bulk'/);
    assert.equal(await d.enqueue(bulk), 0);
    assert.equal(await d.enqueue(bulk), 0);
    assert.equal(errors.length, 1, 'logged once per queue name');
    assert.deepEqual(plain.added, []);
    assert.equal(await d.enqueue(requestFor([v300])), 1);
    assert.equal(memory.added.length, 1);
  });
});
