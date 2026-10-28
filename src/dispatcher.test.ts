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
import { canonicalizeVariants } from './images.ts';
import {
  type ClockLocks,
  clockLocks,
  MemoryTaskQueue,
  PlainTaskQueue,
} from './testHelpers/fakes.ts';
import type { MissingPreview, ResizeLogger } from './types.d.ts';

// ---------------------------------------------------------------------------
// Harness — a Dispatcher built from a task queue, a lock store, the coordination and a recording
// logger. No Resizer, no media store, no storage and no framework app.
// ---------------------------------------------------------------------------

// Every logged error of the current test.
let errors: unknown[][] = [];
const recordingLogger: ResizeLogger = {
  info() {},
  warn() {},
  error(...a: unknown[]) {
    errors.push(a);
  },
};

beforeEach(() => {
  errors = [];
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
    name?: string;
  } = {},
) {
  return new Dispatcher({
    tasks: opts.tasks ?? new MemoryTaskQueue(),
    locks: 'locks' in opts ? opts.locks : clockLocks(),
    coordination: opts.coordination ?? defaultCoordination,
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
    // Another variant of the same media and pipeline: the active task is the gate.
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
    // While the gate lock is held, the media and pipeline get no other task.
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

  test('the gate lock is released when add throws, resolves unconfirmed or in-flight', async () => {
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
      const { locks, calls } = recordingLocks();
      const d = makeDispatcher({ tasks, locks });
      assert.equal(await d.enqueue(requestFor([v300])), 0, label);
      assert.equal(locks.entry(GATE), undefined, label);
      const [acquire, release] = calls;
      assert.deepEqual(
        calls.map(({ op, key }) => [op, key]),
        [
          ['acquire', GATE],
          ['release', GATE],
        ],
        label,
      );
      assert.equal(release.owner, acquire.owner, label);
      assert.equal(errors.length, logged, label);
    }
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
            'a task for this media and pipeline is active, or cooling down after a dead-letter; a read after it finishes queues these',
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
              "the gate lock of this media and pipeline is held: another request queued it, or a dead task's cooldown runs",
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
