import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import type { LockStore } from './contracts/locks.ts';
import type {
  NewTask,
  TaskAddResult,
  TaskQueue,
} from './contracts/taskQueue.ts';
import {
  Dispatcher,
  type DispatchRequest,
  noQueueResult,
} from './dispatcher.ts';
import { canonicalizeVariants } from './images.ts';
import { MemoryTaskQueue, memoryLocks } from './testHelpers/fakes.ts';
import { timingOf } from './timing.ts';
import type { MissingPreview, ResizeLogger } from './types.d.ts';

// ---------------------------------------------------------------------------
// Harness — a Dispatcher built from a task queue, a lock store and a recording logger. No Resizer,
// no media store, no storage and no framework app.
// ---------------------------------------------------------------------------

const silent: ResizeLogger = { info() {}, warn() {}, error() {} };

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

function makeTasks(behavior?: (task: NewTask) => TaskAddResult) {
  const calls: NewTask[] = [];
  const tasks = new MemoryTaskQueue();
  tasks.add = async (task) => {
    calls.push(task);
    return behavior ? behavior(task) : { status: 'added', taskId: 't1' };
  };
  return { tasks, calls };
}

// A recording lock store: every acquire and release with its key and owner.
function makeLocks(acquire: boolean | ((key: string) => boolean) = true) {
  const acquired: { key: string; owner: string; ttl: number }[] = [];
  const released: { key: string; owner: string }[] = [];
  const locks: LockStore = {
    acquire: async (key, owner, ttl) => {
      acquired.push({ key, owner, ttl });
      return typeof acquire === 'function' ? acquire(key) : acquire;
    },
    extend: async () => true,
    release: async (key, owner) => {
      released.push({ key, owner });
      return true;
    },
  };
  return { locks, acquired, released };
}

function makeDispatcher(
  opts: { tasks?: TaskQueue; locks?: LockStore; name?: string } = {},
) {
  const tasks = opts.tasks ?? new MemoryTaskQueue();
  return new Dispatcher({
    tasks,
    locks: opts.locks ?? memoryLocks(),
    timing: timingOf(tasks),
    name: opts.name ?? 'default',
    logger: recordingLogger,
  });
}

const variant = (over: Partial<MissingPreview> = {}): MissingPreview => ({
  sizeKey: '300x300',
  format: 'jpeg',
  ...over,
});

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

describe('Dispatcher', () => {
  test('a Dispatcher works with only a lock store and a task queue', async () => {
    const tasks = new MemoryTaskQueue();
    const dispatcher = new Dispatcher({
      tasks,
      locks: memoryLocks(),
      timing: timingOf(tasks),
      name: 'default',
      logger: silent,
    });
    const req: DispatchRequest = {
      mediaId: 'm1',
      pipeline: 'default',
      previews: [variant()],
      queue: 'default',
    };
    assert.equal(await dispatcher.enqueue(req), 1);
    assert.equal(await dispatcher.enqueue(req), 0); // the dispatch lock is held
    assert.equal(tasks.added.length, 1);
    const confirmed = await dispatcher.enqueueConfirmed({
      ...req,
      mediaId: 'm2',
    });
    assert.deepEqual(confirmed.accepted, [variant()]);
    assert.equal(confirmed.tasks[0].taskId, 'task-2');
  });

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
});

// ---------------------------------------------------------------------------
// The read path's enqueue
// ---------------------------------------------------------------------------

describe('enqueue', () => {
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

  test('dedups variants by identity before acquiring locks', async () => {
    const { tasks, calls } = makeTasks();
    const { locks, acquired } = makeLocks(true);
    const d = makeDispatcher({ tasks, locks });
    const enqueued = await d.enqueue(requestFor([variant(), variant()]));
    assert.equal(acquired.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].previews.length, 1);
    assert.equal(enqueued, 1); // returns the count handed to the task queue
  });

  test('keeps distinct nested filter values as distinct preview identities', async () => {
    const { tasks, calls } = makeTasks();
    const { locks, acquired } = makeLocks(true);
    const d = makeDispatcher({ tasks, locks });

    const enqueued = await d.enqueue(
      requestFor([
        variant({ filters: { crop: { x: 0, y: 0 } } as never }),
        variant({ filters: { crop: { x: 10, y: 0 } } as never }),
      ]),
    );

    assert.equal(acquired.length, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].previews.length, 2);
    assert.equal(enqueued, 2);
  });

  test('keeps nested string and number filter leaves distinct', async () => {
    const { tasks, calls } = makeTasks();
    const { locks, acquired } = makeLocks(true);
    const d = makeDispatcher({ tasks, locks });

    const enqueued = await d.enqueue(
      requestFor([
        variant({ filters: { crop: { x: 1 } } as never }),
        variant({ filters: { crop: { x: '1' } } as never }),
      ]),
    );

    assert.equal(acquired.length, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].previews.length, 2);
    assert.equal(enqueued, 2);
  });

  test('acquires a dispatch lock per identity with the configured TTL', async () => {
    const { tasks } = makeTasks();
    const { locks, acquired } = makeLocks(true);
    tasks.getTiming = () => ({ lockTtlMs: { dispatch: 12345, worker: 60000 } });
    const d = makeDispatcher({ tasks, locks });
    await d.enqueue(requestFor([variant(), variant({ format: 'webp' })]));
    assert.deepEqual(
      acquired.map((a) => a.key),
      [
        'resize_dispatch:m1:default:default:300x300:jpeg:none',
        'resize_dispatch:m1:default:default:300x300:webp:none',
      ],
    );
    assert.equal(acquired[0].ttl, 12345);
  });

  test('keeps only lock-winners; a held lock is skipped', async () => {
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(
      (key) => key.endsWith(':jpeg:none'), // only the jpeg lock is won
    );
    const d = makeDispatcher({ tasks, locks });
    const enqueued = await d.enqueue(
      requestFor([variant(), variant({ format: 'webp' })]),
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0].previews.map((p) => p.format),
      ['jpeg'],
    );
    assert.equal(enqueued, 1); // only the surviving winner is counted
  });

  test('a rejecting dispatch-lock acquire skips that variant; earlier survivors still enqueue', async () => {
    const { tasks, calls } = makeTasks();
    const locks: LockStore = {
      // jpeg acquires fine; the webp acquire REJECTS — that variant is not a survivor (log +
      // continue), and the earlier jpeg survivor still reaches the task queue.
      acquire: async (key) => {
        if (key.endsWith(':webp:none')) {
          throw new Error('lock backend down');
        }
        return true;
      },
      extend: async () => true,
      release: async () => true,
    };
    const d = makeDispatcher({ tasks, locks });
    const enqueued = await d.enqueue(
      requestFor([variant(), variant({ format: 'webp' })]),
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0].previews.map((p) => p.format),
      ['jpeg'],
    );
    assert.equal(enqueued, 1);
    assert.ok(errors.length >= 1);
  });

  test('acquires the dispatch locks in parallel; held and rejected locks still drop out', async () => {
    const { tasks, calls } = makeTasks();
    let inFlight = 0;
    let maxInFlight = 0;
    const locks: LockStore = {
      acquire: async (key) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        if (key.endsWith(':avif:none')) {
          throw new Error('lock backend down');
        }
        return !key.endsWith(':webp:none'); // webp is held by a concurrent read
      },
      extend: async () => true,
      release: async () => true,
    };
    const d = makeDispatcher({ tasks, locks });
    const enqueued = await d.enqueue(
      requestFor([
        variant(),
        variant({ format: 'webp' }),
        variant({ format: 'avif' }),
        variant({ sizeKey: '100x100' }),
      ]),
    );
    assert.equal(maxInFlight, 4);
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0].previews.map((p) => `${p.sizeKey}:${p.format}`),
      ['100x100:jpeg', '300x300:jpeg'],
    );
    assert.equal(enqueued, 2);
    assert.equal(errors.length, 1);
  });

  test('does not call the task queue when no lock survives', async () => {
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(false);
    const d = makeDispatcher({ tasks, locks });
    const enqueued = await d.enqueue(requestFor([variant()]));
    assert.equal(calls.length, 0);
    assert.equal(enqueued, 0); // no survivor → nothing handed over
  });

  test('on success (an added task) the survivor locks are NOT released', async () => {
    const { tasks } = makeTasks();
    const { locks, released } = makeLocks(true);
    const d = makeDispatcher({ tasks, locks });
    const enqueued = await d.enqueue(requestFor([variant()]));
    assert.equal(released.length, 0);
    assert.equal(enqueued, 1); // success → the one survivor is counted
  });

  test('releases survivor locks when the task queue throws (never rethrows)', async () => {
    const { tasks } = makeTasks(() => {
      throw new Error('down');
    });
    const { locks, released } = makeLocks(true);
    const d = makeDispatcher({ tasks, locks });
    const enqueued = await d.enqueue(requestFor([variant()]));
    assert.deepEqual(
      released.map(({ key }) => key),
      ['resize_dispatch:m1:default:default:300x300:jpeg:none'],
    );
    assert.ok(errors.length >= 1);
    assert.equal(enqueued, 0); // a throw released the locks → nothing durably queued
  });

  test('dispatch locks are taken and released with the fixed owner resize:dispatch', async () => {
    const { tasks } = makeTasks(() => {
      throw new Error('down');
    });
    const { locks, acquired, released } = makeLocks(true);
    const d = makeDispatcher({ tasks, locks });
    await d.enqueue(requestFor([variant()]));
    assert.equal(acquired[0].owner, 'resize:dispatch');
    assert.deepEqual(released, [
      { key: acquired[0].key, owner: 'resize:dispatch' },
    ]);
  });

  for (const result of [
    { status: 'unconfirmed' },
    { status: 'in-flight', taskId: 'other' },
  ] as const) {
    test(`releases survivor locks when the add is ${result.status} (soft failure)`, async () => {
      const { tasks } = makeTasks(() => result);
      const { locks, released } = makeLocks(true);
      const d = makeDispatcher({ tasks, locks });
      const enqueued = await d.enqueue(requestFor([variant()]));
      assert.deepEqual(
        released.map(({ key }) => key),
        ['resize_dispatch:m1:default:default:300x300:jpeg:none'],
      );
      assert.ok(errors.length >= 1);
      assert.equal(enqueued, 0); // not added → soft failure → not counted
    });
  }

  test('passes mediaId + pipeline + survivors through to the task queue', async () => {
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(true);
    const d = makeDispatcher({ tasks, locks });
    const v = variant({ requestedWidth: 300, requestedHeight: 300 });
    await d.enqueue(requestFor([v], { pipeline: 'photo' }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mediaId, 'm1');
    assert.equal(calls[0].pipeline, 'photo');
    assert.equal('requestKey' in calls[0], false);
    assert.deepEqual(calls[0].previews, [v]);
  });

  test('enqueue sends the resizer name and the given queue', async () => {
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(true);
    const d = makeDispatcher({ tasks, locks, name: 'listings' });
    await d.enqueue(
      requestFor([{ sizeKey: '300x300', format: 'webp' }], { queue: 'bulk' }),
    );
    assert.deepEqual(
      { resizer: calls[0].resizer, queue: calls[0].queue },
      { resizer: 'listings', queue: 'bulk' },
    );
  });
});

describe('dispatch locks are scoped per resizer and pipeline', () => {
  test('two pipelines of the same variant both reach the task queue', async () => {
    const { tasks, calls } = makeTasks();
    const held = new Set<string>();
    // Grants each lock key once: a second request for the SAME key is a loser.
    const { locks, acquired } = makeLocks((key) => {
      if (held.has(key)) {
        return false;
      }
      held.add(key);
      return true;
    });
    const d = makeDispatcher({ tasks, locks });
    await d.enqueue(requestFor([variant()]));
    await d.enqueue(requestFor([variant()], { pipeline: 'watermark' }));
    assert.equal(calls.length, 2);
    assert.notEqual(acquired[0].key, acquired[1].key);
    assert.ok(acquired[1].key.includes(':watermark:'));
  });
});
