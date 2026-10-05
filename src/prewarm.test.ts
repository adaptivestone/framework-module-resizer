import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import type { ResizeStorage } from './contracts/storage.ts';
import type { NewTask, TaskQueue } from './contracts/taskQueue.ts';
import { Resizer, resetResizerForTests } from './resizer.ts';
import type { FakeLocks } from './testHelpers/fakes.ts';
import { fakeDb, MemoryTaskQueue, memoryLocks } from './testHelpers/fakes.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import type {
  MediaLike,
  MissingPreview,
  ResizeLogger,
  StorageRef,
} from './types.d.ts';

// ---------------------------------------------------------------------------
// Harness — a core Resizer with a memory task queue and database-owned locks.
// ---------------------------------------------------------------------------

function installFakeApp() {
  const info: unknown[][] = [];
  const warn: unknown[][] = [];
  const errors: unknown[][] = [];
  currentLogger = {
    info(...a: unknown[]) {
      info.push(a);
    },
    warn(...a: unknown[]) {
      warn.push(a);
    },
    error(...a: unknown[]) {
      errors.push(a);
    },
  };
  return { info, warn, errors };
}

let currentLogger: ResizeLogger = { info() {}, warn() {}, error() {} };

function makeStorage(o: Partial<ResizeStorage> = {}): ResizeStorage {
  return {
    download: async () => Buffer.alloc(0),
    upload: async () => ({ key: 'k' }),
    publicUrl: (ref: StorageRef) =>
      `https://cdn/${(ref as { key: string }).key}`,
    ...o,
  };
}

function makeTaskQueue(
  behavior?: (task: NewTask) => { taskId: string | null },
) {
  const memory = new MemoryTaskQueue();
  const calls: NewTask[] = [];
  const tasks: TaskQueue = {
    add: async (task) => {
      calls.push(task);
      return behavior ? behavior(task) : memory.add(task);
    },
    claim: (queue, leaseMs) => memory.claim(queue, leaseMs),
    renew: (task, leaseMs) => memory.renew(task, leaseMs),
    complete: (task) => memory.complete(task),
    fail: (task, next, error) => memory.fail(task, next, error),
    findActive: (query) => memory.findActive(query),
    getTiming: () => memory.getTiming(),
  };
  return { tasks, calls };
}

function makeLocks(acquire: boolean | ((key: string) => boolean) = true) {
  const base = memoryLocks();
  const acquired: { key: string; ttl: number }[] = [];
  const released: string[] = [];
  const dbLocks: FakeLocks = {
    acquire: async (key, ttl) => {
      acquired.push({ key, ttl });
      const allowed = typeof acquire === 'function' ? acquire(key) : acquire;
      return allowed ? base.acquire(key) : false;
    },
    release: async (key) => {
      released.push(key);
      await base.release(key);
    },
  };
  return { dbLocks, acquired, released };
}

function makeResizer(
  options: {
    storage?: ResizeStorage;
    tasks?: TaskQueue;
    dbLocks?: FakeLocks;
    name?: string;
    queue?: string;
    hooks?: ConstructorParameters<typeof Resizer>[0]['hooks'];
  } = {},
) {
  return new Resizer({
    storage: options.storage ?? makeStorage(),
    db: fakeDb({ locks: options.dbLocks }),
    tasks: options.tasks,
    config: makeImageConfig(),
    logger: currentLogger,
    name: options.name,
    queue: options.queue,
    hooks: options.hooks,
  });
}

afterEach(() => {
  resetResizerForTests();
  currentLogger = { info() {}, warn() {}, error() {} };
});

// ---------------------------------------------------------------------------
// §11.1b prewarm — expand sizes×formats → add task-queue work via dispatch locks, never throw
// ---------------------------------------------------------------------------

describe('prewarm — happy path', () => {
  test('expands N sizes × M formats, adds one task with the surviving variants', async () => {
    installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { dbLocks } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      dbLocks,
    });
    const { accepted } = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [
        { width: 300, height: 300 },
        { width: 100, height: 100 },
      ],
      formats: ['jpeg', 'webp'],
      pipeline: 'photo',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mediaId, 'm1');
    assert.equal(calls[0].pipeline, 'photo');
    assert.equal(calls[0].previews.length, 4);
    assert.equal(accepted.length, 4);
    assert.deepEqual(
      calls[0].previews.map((p) => `${p.sizeKey}:${p.format}`).sort(),
      ['100x100:jpeg', '100x100:webp', '300x300:jpeg', '300x300:webp'],
    );
  });

  test('carries requestedWidth/Height/filters/fit onto the task variants', async () => {
    installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { dbLocks } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      dbLocks,
    });
    await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [
        { width: 300, height: 300, filters: { blur: 40 } },
        { fit: true },
      ],
      formats: ['jpeg'],
    });
    assert.deepEqual(calls[0].previews, [
      {
        sizeKey: '300x300',
        format: 'jpeg',
        filters: { blur: 40 },
        requestedWidth: 300,
        requestedHeight: 300,
      },
      { sizeKey: 'fit', format: 'jpeg', fit: true },
    ]);
  });
});

describe('prewarm — queue', () => {
  test('without queue sends resizer.queue; with queue sends that queue', async () => {
    installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { dbLocks } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      dbLocks,
      name: 'listings',
      queue: 'interactive',
    });
    const media = { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } };
    await r.prewarm({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    await r.prewarm({
      media,
      sizes: [{ width: 100, height: 100 }],
      formats: ['jpeg'],
      queue: 'bulk',
    });
    assert.deepEqual(
      calls.map((c) => [c.resizer, c.queue]),
      [
        ['listings', 'interactive'],
        ['listings', 'bulk'],
      ],
    );
  });

  test('a Resizer without a queue option sends "default"', async () => {
    installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { dbLocks } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      dbLocks,
    });
    await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(calls[0].resizer, 'default');
    assert.equal(calls[0].queue, 'default');
  });
});

describe('prewarm — skip existing & dedup', () => {
  test('identities already in media.previews are not added to the task queue', async () => {
    installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { dbLocks } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      dbLocks,
    });
    const media: MediaLike = {
      id: 'm1',
      original: { storageRef: { key: 'orig.jpg' }, contentType: 'image/jpeg' },
      previews: [
        {
          storageRef: { key: 'p1' },
          contentType: 'image/jpeg',
          sizeKey: '300x300',
          format: 'jpeg',
        },
      ],
    };
    const { accepted } = await r.prewarm({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
    });
    assert.equal(accepted.length, 1);
    assert.deepEqual(
      calls[0].previews.map((p) => `${p.sizeKey}:${p.format}`),
      ['300x300:webp'],
    );
  });

  test('duplicate sizes within the request are deduped to one identity', async () => {
    installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { dbLocks } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      dbLocks,
    });
    const { accepted } = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [
        { width: 300, height: 300 },
        { width: 300, height: 300 },
      ],
      formats: ['jpeg'],
    });
    assert.equal(accepted.length, 1);
    assert.equal(calls[0].previews.length, 1);
  });

  test('a getSizeKey-throwing size is skipped; the others are added', async () => {
    installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { dbLocks } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      dbLocks,
    });
    const { accepted } = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [{}, { width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(accepted.length, 1);
    assert.equal(calls[0].previews[0].sizeKey, '300x300');
  });
});

describe('prewarm — SVG original uses the normal queue', () => {
  test('private SVG adds publication work to the task queue', async () => {
    installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { dbLocks, acquired } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      dbLocks,
    });
    const { accepted } = await r.prewarm({
      media: {
        id: 'm1',
        original: {
          storageRef: { key: 'logo.svg' },
          contentType: 'image/svg+xml',
        },
      },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
    });
    assert.equal(accepted.length, 2);
    assert.equal(calls.length, 1);
    assert.equal(acquired.length, 2);
  });

  test('SVG detected via original.format === "svg" is added to the task queue too', async () => {
    installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { dbLocks } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      dbLocks,
    });
    const { accepted } = await r.prewarm({
      media: {
        id: 'm1',
        original: { storageRef: { key: 'logo' }, format: 'svg' },
      },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(accepted.length, 1);
    assert.equal(calls.length, 1);
  });
});

describe('prewarm — size and task hooks', () => {
  test('resolveSizes tap expands the set fed to the expansion', async () => {
    installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { dbLocks } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      dbLocks,
      hooks: {
        resolveSizes: () => [
          { width: 100, height: 100 },
          { width: 200, height: 200 },
        ],
      },
    });
    const { accepted } = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [],
      formats: ['jpeg'],
    });
    assert.equal(accepted.length, 2);
    assert.deepEqual(calls[0].previews.map((p) => p.sizeKey).sort(), [
      '100x100',
      '200x200',
    ]);
  });

  test('beforeEnqueue tap filters the remainder (assign-back semantics)', async () => {
    installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { dbLocks } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      dbLocks,
      hooks: {
        // drop everything but the jpeg 300x300 variant
        beforeEnqueue: (missing: MissingPreview[]) =>
          missing.filter((m) => m.sizeKey === '300x300' && m.format === 'jpeg'),
      },
    });
    const { accepted } = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [
        { width: 300, height: 300 },
        { width: 100, height: 100 },
      ],
      formats: ['jpeg', 'webp'],
    });
    assert.equal(accepted.length, 1);
    assert.deepEqual(
      calls[0].previews.map((p) => `${p.sizeKey}:${p.format}`),
      ['300x300:jpeg'],
    );
  });

  test('a beforeEnqueue tap that empties the set → nothing accepted, no task queue call', async () => {
    installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { dbLocks } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      dbLocks,
      hooks: { beforeEnqueue: () => [] },
    });
    const { accepted } = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(accepted.length, 0);
    assert.equal(calls.length, 0);
  });
});

describe('prewarm — no task queue (eager-only host)', () => {
  test('reports every variant unconfirmed with a NO_QUEUE issue, without throwing', async () => {
    installFakeApp();
    const r = makeResizer({ storage: makeStorage() });
    const { accepted, status, unconfirmed, issues } = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [
        { width: 300, height: 300 },
        { width: 100, height: 100 },
      ],
      formats: ['jpeg'],
    });
    assert.equal(accepted.length, 0);
    assert.equal(status, 'incomplete');
    assert.equal(unconfirmed.length, 2);
    assert.equal(issues[0].code, 'RESIZE_ENQUEUE_NO_QUEUE');
  });
});

describe('prewarm — dispatch-lock winners only', () => {
  test('lock losers are not counted; added tasks contain only the winners', async () => {
    installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    // Only the jpeg dispatch lock is won; the webp one is already in flight elsewhere.
    const { dbLocks } = makeLocks((key) => key.endsWith(':jpeg:none'));
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      dbLocks,
    });
    const { accepted } = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
    });
    assert.equal(accepted.length, 1);
    assert.deepEqual(
      calls[0].previews.map((p) => p.format),
      ['jpeg'],
    );
  });

  test('no lock survives → nothing accepted and the task queue is not called', async () => {
    installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { dbLocks } = makeLocks(false);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      dbLocks,
    });
    const { accepted } = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(accepted.length, 0);
    assert.equal(calls.length, 0);
  });
});

describe('prewarm — queue and lock failures never throw', () => {
  test('task queue add throwing → nothing accepted, dispatch locks released, no reject', async () => {
    installFakeApp();
    const { tasks } = makeTaskQueue(() => {
      throw new Error('task queue down');
    });
    const { dbLocks, released } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      dbLocks,
    });
    const { accepted } = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(accepted.length, 0);
    assert.deepEqual(released, [
      'resize_dispatch:m1:default:default:300x300:jpeg:none',
    ]);
  });

  test('an internal error (db.acquireLock throws) is caught → nothing accepted, logged', async () => {
    const { errors } = installFakeApp();
    const { tasks } = makeTaskQueue();
    const dbLocks: FakeLocks = {
      acquire: async () => {
        throw new Error('lock backend down');
      },
      release: async () => {},
    };
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      dbLocks,
    });
    const { accepted } = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(accepted.length, 0);
    assert.ok(errors.length >= 1);
  });

  test('a throwing resolveSizes tap does not reject; prewarm proceeds on the prior value', async () => {
    const { errors } = installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { dbLocks } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      dbLocks,
      hooks: {
        resolveSizes: () => {
          throw new Error('boom');
        },
      },
    });
    const { accepted } = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(accepted.length, 1);
    assert.equal(calls[0].previews[0].sizeKey, '300x300');
    assert.ok(errors.length >= 1);
  });

  test('media with no id/_id → incomplete with a non-retryable INTERNAL_ERROR, never a throw', async () => {
    const { errors } = installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { dbLocks } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      dbLocks,
    });
    const result = await r.prewarm({
      media: { original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.accepted.length, 0);
    assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_INTERNAL_ERROR');
    assert.equal(result.issues[0].retryable, false); // a media without an id never improves
    assert.equal(calls.length, 0);
    assert.ok(errors.length >= 1);
  });
});

describe('prewarm — fast-path is NOT consulted', () => {
  test('a size the original already fits still gets added (generation decision, not serving)', async () => {
    installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { dbLocks } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      dbLocks,
    });
    const media: MediaLike = {
      id: 'm1',
      // original (200×150) fits inside the 300×300 box — resolve() would serve the original,
      // but prewarm generates the preview regardless (11 · §11.1b step 2).
      original: {
        storageRef: { key: 'orig.jpg' },
        contentType: 'image/jpeg',
        width: 200,
        height: 150,
      },
    };
    const { accepted } = await r.prewarm({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(accepted.length, 1);
    assert.deepEqual(
      calls[0].previews.map((p) => `${p.sizeKey}:${p.format}`),
      ['300x300:jpeg'],
    );
  });
});

describe('prewarm — pipelines are part of identity', () => {
  test('a default pipeline preview does not satisfy a watermark pipeline prewarm', async () => {
    installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { dbLocks } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      dbLocks,
    });
    const media = {
      id: 'm1',
      original: { storageRef: { key: 'orig.jpg' } },
      previews: [
        {
          storageRef: { key: 'p.webp' },
          sizeKey: '300x300',
          format: 'webp',
          contentType: 'image/webp',
        },
      ],
    };
    const sizes = [{ width: 300, height: 300 }];
    assert.equal(
      (await r.prewarm({ media, sizes, formats: ['webp'] })).accepted.length,
      0,
    );
    assert.equal(
      (
        await r.prewarm({
          media,
          sizes,
          formats: ['webp'],
          pipeline: 'watermark',
        })
      ).accepted.length,
      1,
    );
    assert.equal(calls[0].pipeline, 'watermark');
  });
});
