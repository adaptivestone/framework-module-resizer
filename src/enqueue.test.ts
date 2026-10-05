import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import type { NewTask, TaskQueue } from './contracts/taskQueue.ts';
import { buildRequestKey, canonicalizeVariants, enqueue } from './enqueue.ts';
import { FrameworkResizer } from './framework/resizer.ts';
import { type ResizeStorage, resetResizerForTests } from './resizer.ts';
import {
  type FakeLocks,
  fakeDb,
  MemoryTaskQueue,
} from './testHelpers/fakes.ts';
import { makeResizeConfig } from './testHelpers/resizeConfig.ts';
import type { MissingPreview, StorageRef } from './types.d.ts';

// ---------------------------------------------------------------------------
// Harness — recording app + recording driver fakes (see engine.test.ts).
// ---------------------------------------------------------------------------

function installFakeApp() {
  const errors: unknown[][] = [];
  setAppInstance({
    getConfig: () => makeResizeConfig(),
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

const storage: ResizeStorage = {
  download: async () => Buffer.alloc(0),
  upload: async () => ({ key: 'k' }),
  publicUrl: (ref: StorageRef) => `https://cdn/${ref.key}`,
};

function makeTasks(behavior?: (task: NewTask) => { taskId: string | null }) {
  const calls: NewTask[] = [];
  const tasks = new MemoryTaskQueue();
  tasks.add = async (task) => {
    calls.push(task);
    return behavior ? behavior(task) : { taskId: 't1' };
  };
  return { tasks, calls };
}

function makeLocks(acquire: boolean | ((key: string) => boolean) = true) {
  const acquired: { key: string; ttl: number }[] = [];
  const released: string[] = [];
  const locks: FakeLocks = {
    acquire: async (key, ttl) => {
      acquired.push({ key, ttl });
      return typeof acquire === 'function' ? acquire(key) : acquire;
    },
    release: async (key) => {
      released.push(key);
    },
  };
  return { locks, acquired, released };
}

function makeResizer(opts: { tasks?: TaskQueue; locks?: FakeLocks }) {
  const { tasks, locks } = opts;
  return new FrameworkResizer({
    storage,
    db: fakeDb({ locks }),
    tasks,
  });
}

const variant = (over: Partial<MissingPreview> = {}): MissingPreview => ({
  sizeKey: '300x300',
  format: 'jpeg',
  ...over,
});

afterEach(() => {
  resetResizerForTests();
  resetAppInstance();
});

// ---------------------------------------------------------------------------
// §18 enqueue algorithm
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
    const request = {
      mediaId: 'm1',
      resizer: 'default',
      queue: 'default',
      pipeline: 'default',
    };
    assert.equal(
      buildRequestKey({ ...request, previews: [first, second] }),
      buildRequestKey({
        ...request,
        previews: [
          second,
          { ...first, filters: { nested: { a: 1, z: 2 } } as never },
        ],
      }),
    );
  });

  test('dedups variants by identity before acquiring locks', async () => {
    installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks, acquired } = makeLocks(true);
    const r = makeResizer({ tasks, locks });
    const enqueued = await enqueue(
      r,
      'm1',
      'default',
      [variant(), variant()],
      'default',
    );
    assert.equal(acquired.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].previews.length, 1);
    assert.equal(enqueued, 1); // returns the count handed to the task queue
  });

  test('keeps distinct nested filter values as distinct preview identities', async () => {
    installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks, acquired } = makeLocks(true);
    const r = makeResizer({ tasks, locks });

    const enqueued = await enqueue(
      r,
      'm1',
      'default',
      [
        variant({ filters: { crop: { x: 0, y: 0 } } as never }),
        variant({ filters: { crop: { x: 10, y: 0 } } as never }),
      ],
      'default',
    );

    assert.equal(acquired.length, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].previews.length, 2);
    assert.equal(enqueued, 2);
  });

  test('keeps nested string and number filter leaves distinct', async () => {
    installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks, acquired } = makeLocks(true);
    const r = makeResizer({ tasks, locks });

    const enqueued = await enqueue(
      r,
      'm1',
      'default',
      [
        variant({ filters: { crop: { x: 1 } } as never }),
        variant({ filters: { crop: { x: '1' } } as never }),
      ],
      'default',
    );

    assert.equal(acquired.length, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].previews.length, 2);
    assert.equal(enqueued, 2);
  });

  test('acquires a dispatch lock per identity with the configured TTL', async () => {
    installFakeApp();
    const { tasks } = makeTasks();
    const { locks, acquired } = makeLocks(true);
    tasks.getTiming = () => ({ lockTtlMs: { dispatch: 12345, worker: 60000 } });
    const r = makeResizer({ tasks, locks });
    await enqueue(
      r,
      'm1',
      'default',
      [variant(), variant({ format: 'webp' })],
      'default',
    );
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
    installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(
      (key) => key.endsWith(':jpeg:none'), // only the jpeg lock is won
    );
    const r = makeResizer({ tasks, locks });
    const enqueued = await enqueue(
      r,
      'm1',
      'default',
      [variant(), variant({ format: 'webp' })],
      'default',
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0].previews.map((p) => p.format),
      ['jpeg'],
    );
    assert.equal(enqueued, 1); // only the surviving winner is counted
  });

  test('a rejecting dispatch-lock acquire skips that variant; earlier survivors still enqueue', async () => {
    const { errors } = installFakeApp();
    const { tasks, calls } = makeTasks();
    const locks: FakeLocks = {
      // jpeg acquires fine; the webp acquire REJECTS — that variant is not a survivor (log +
      // continue), and the earlier jpeg survivor still reaches the task queue (1.2b).
      acquire: async (key) => {
        if (key.endsWith(':webp:none')) {
          throw new Error('lock backend down');
        }
        return true;
      },
      release: async () => {},
    };
    const r = makeResizer({ tasks, locks });
    const enqueued = await enqueue(
      r,
      'm1',
      'default',
      [variant(), variant({ format: 'webp' })],
      'default',
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0].previews.map((p) => p.format),
      ['jpeg'],
    );
    assert.equal(enqueued, 1);
    assert.ok(errors.length >= 1);
  });

  test('does not call the task queue when no lock survives', async () => {
    installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(false);
    const r = makeResizer({ tasks, locks });
    const enqueued = await enqueue(r, 'm1', 'default', [variant()], 'default');
    assert.equal(calls.length, 0);
    assert.equal(enqueued, 0); // no survivor → nothing handed over
  });

  test('on success (non-null taskId) the survivor locks are NOT released', async () => {
    installFakeApp();
    const { tasks } = makeTasks();
    const { locks, released } = makeLocks(true);
    const r = makeResizer({ tasks, locks });
    const enqueued = await enqueue(r, 'm1', 'default', [variant()], 'default');
    assert.equal(released.length, 0);
    assert.equal(enqueued, 1); // success → the one survivor is counted
  });

  test('releases survivor locks when the task queue throws (never rethrows)', async () => {
    const { errors } = installFakeApp();
    const { tasks } = makeTasks(() => {
      throw new Error('down');
    });
    const { locks, released } = makeLocks(true);
    const r = makeResizer({ tasks, locks });
    const enqueued = await enqueue(r, 'm1', 'default', [variant()], 'default');
    assert.deepEqual(released, [
      'resize_dispatch:m1:default:default:300x300:jpeg:none',
    ]);
    assert.ok(errors.length >= 1);
    assert.equal(enqueued, 0); // a throw released the locks → nothing durably queued
  });

  test('releases survivor locks when taskId is null (soft failure)', async () => {
    const { errors } = installFakeApp();
    const { tasks } = makeTasks(() => ({ taskId: null }));
    const { locks, released } = makeLocks(true);
    const r = makeResizer({ tasks, locks });
    const enqueued = await enqueue(r, 'm1', 'default', [variant()], 'default');
    assert.deepEqual(released, [
      'resize_dispatch:m1:default:default:300x300:jpeg:none',
    ]);
    assert.ok(errors.length >= 1);
    assert.equal(enqueued, 0); // null taskId → soft failure → not counted
  });

  test('passes mediaId + pipeline + survivors through to the task queue', async () => {
    installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(true);
    const r = makeResizer({ tasks, locks });
    const v = variant({ requestedWidth: 300, requestedHeight: 300 });
    await enqueue(r, 'm1', 'photo', [v], 'default');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mediaId, 'm1');
    assert.equal(calls[0].pipeline, 'photo');
    assert.equal(calls[0].requestKey, buildRequestKey(calls[0]));
    assert.deepEqual(calls[0].previews, [v]);
  });

  test('enqueue sends the resizer name and the given queue', async () => {
    installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(true);
    const resizer = new FrameworkResizer({
      storage,
      tasks,
      db: fakeDb({ locks }),
      name: 'listings',
    });
    await enqueue(
      resizer,
      'm1',
      'default',
      [{ sizeKey: '300x300', format: 'webp' }],
      'bulk',
    );
    assert.deepEqual(
      { resizer: calls[0].resizer, queue: calls[0].queue },
      { resizer: 'listings', queue: 'bulk' },
    );
  });
});

describe('buildRequestKey', () => {
  const previews: MissingPreview[] = [{ sizeKey: '300x300', format: 'webp' }];
  const base = {
    mediaId: 'm1',
    resizer: 'default',
    queue: 'default',
    pipeline: 'default',
    previews,
  };

  test('is stable and versioned', () => {
    assert.match(buildRequestKey(base), /^v2:[0-9a-f]{64}$/);
    assert.equal(buildRequestKey(base), buildRequestKey({ ...base }));
  });

  test('differs by resizer and by queue', () => {
    const key = buildRequestKey(base);
    assert.notEqual(buildRequestKey({ ...base, resizer: 'listings' }), key);
    assert.notEqual(buildRequestKey({ ...base, queue: 'bulk' }), key);
  });
});

describe('dispatch locks are scoped per resizer and pipeline', () => {
  test('two pipelines of the same variant both reach the task queue', async () => {
    installFakeApp();
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
    const r = makeResizer({ tasks, locks });
    await enqueue(r, 'm1', 'default', [variant()], 'default');
    await enqueue(r, 'm1', 'watermark', [variant()], 'default');
    assert.equal(calls.length, 2);
    assert.notEqual(acquired[0].key, acquired[1].key);
    assert.ok(acquired[1].key.includes(':watermark:'));
  });
});
