import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import type { LockStore } from './contracts/locks.ts';
import type { ResizeStorage } from './contracts/storage.ts';
import type {
  NewTask,
  TaskAddResult,
  TaskQueue,
} from './contracts/taskQueue.ts';
import { Resizer, resetResizerForTests } from './resizer.ts';
import { fakeMedia, memoryLocks, PlainTaskQueue } from './testHelpers/fakes.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import type {
  MediaLike,
  MissingPreview,
  ResizeLogger,
  StorageRef,
} from './types.d.ts';

// ---------------------------------------------------------------------------
// Harness — a core Resizer with a memory task queue without gatesByTask (the SQS shape), so each
// prewarm takes the gate lock of its media and pipeline in the lock store.
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

function makeTaskQueue(behavior?: (task: NewTask) => TaskAddResult) {
  const memory = new PlainTaskQueue();
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
    getTiming: () => memory.getTiming(),
  };
  return { tasks, calls };
}

function makeLocks(acquire: boolean | ((key: string) => boolean) = true) {
  const base = memoryLocks();
  const acquired: { key: string; ttl: number }[] = [];
  const released: string[] = [];
  const lockStore: LockStore = {
    acquire: async (key, owner, ttl) => {
      acquired.push({ key, ttl });
      const allowed = typeof acquire === 'function' ? acquire(key) : acquire;
      return allowed ? base.acquire(key, owner, ttl) : false;
    },
    extend: (key, owner, ttl) => base.extend(key, owner, ttl),
    release: async (key, owner) => {
      released.push(key);
      return base.release(key, owner);
    },
  };
  return { lockStore, acquired, released };
}

function makeResizer(
  options: {
    storage?: ResizeStorage;
    tasks?: TaskQueue;
    lockStore?: LockStore;
    name?: string;
    queue?: string;
    hooks?: ConstructorParameters<typeof Resizer>[0]['hooks'];
    pipelines?: ConstructorParameters<typeof Resizer>[0]['pipelines'];
  } = {},
) {
  return new Resizer({
    storage: options.storage ?? makeStorage(),
    media: fakeMedia(),
    locks: options.lockStore ?? memoryLocks(),
    tasks: options.tasks,
    config: makeImageConfig(),
    logger: currentLogger,
    name: options.name,
    queue: options.queue,
    hooks: options.hooks,
    pipelines: options.pipelines,
  });
}

afterEach(() => {
  resetResizerForTests();
  currentLogger = { info() {}, warn() {}, error() {} };
});

// ---------------------------------------------------------------------------
// §11.1b prewarm — expand sizes×formats → add task-queue work behind the gate, never throw
// ---------------------------------------------------------------------------

describe('prewarm — happy path', () => {
  test('expands N sizes × M formats, adds one task with the surviving variants', async () => {
    installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { lockStore } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      lockStore,
      pipelines: { photo: {} },
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
    const { lockStore } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      lockStore,
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
    const { lockStore } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      lockStore,
      name: 'listings',
      queue: 'interactive',
    });
    const original = { storageRef: { key: 'orig.jpg' } };
    await r.prewarm({
      media: { id: 'm1', original },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    // Another media: the gate is per Resizer, media and pipeline, whatever the queue, so the task
    // of m1 would hold it.
    await r.prewarm({
      media: { id: 'm2', original },
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
    const { lockStore } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      lockStore,
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
    const { lockStore } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      lockStore,
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
    const { lockStore } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      lockStore,
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
    const { lockStore } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      lockStore,
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
    const { lockStore, acquired } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      lockStore,
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
    assert.equal(acquired.length, 1); // one gate lock for the media and pipeline
  });

  test('SVG detected via original.format === "svg" is added to the task queue too', async () => {
    installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { lockStore } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      lockStore,
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
    const { lockStore } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      lockStore,
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
    const { lockStore } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      lockStore,
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
    const { lockStore } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      lockStore,
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

describe('prewarm — a held gate lock queues nothing', () => {
  test('one gate lock covers the whole request: every variant is in the task', async () => {
    installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { lockStore, acquired } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      lockStore,
      name: 'listings',
      pipelines: { photo: {} },
    });
    const { accepted } = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
      pipeline: 'photo',
    });
    assert.equal(accepted.length, 2);
    assert.deepEqual(
      calls[0].previews.map((p) => p.format),
      ['jpeg', 'webp'],
    );
    assert.deepEqual(
      acquired.map(({ key }) => key),
      ['resize_gate:listings:m1:photo'],
    );
  });

  test('a held gate lock → nothing accepted and the task queue is not called', async () => {
    installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { lockStore } = makeLocks(false);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      lockStore,
    });
    const { accepted, issues } = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(accepted.length, 0);
    assert.equal(calls.length, 0);
    assert.deepEqual(
      issues.map(({ code, retryable }) => [code, retryable]),
      [['RESIZE_ENQUEUE_LOCK_CONTENDED', true]],
    );
  });
});

describe('prewarm — queue and lock failures never throw', () => {
  test('add throwing → nothing accepted, the gate lock released, no reject', async () => {
    installFakeApp();
    const { tasks } = makeTaskQueue(() => {
      throw new Error('task queue down');
    });
    const { lockStore, released } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      lockStore,
    });
    const { accepted } = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(accepted.length, 0);
    assert.deepEqual(released, ['resize_gate:default:m1:default']);
  });

  test('a rejecting gate-lock acquire is caught → nothing accepted, logged', async () => {
    const { errors } = installFakeApp();
    const { tasks } = makeTaskQueue();
    const lockStore: LockStore = {
      acquire: async () => {
        throw new Error('lock backend down');
      },
      extend: async () => true,
      release: async () => true,
    };
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      lockStore,
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
    const { lockStore } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      lockStore,
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
    const { lockStore } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      lockStore,
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

describe('prewarm — a small original', () => {
  test('a box larger than the original is queued like any other size', async () => {
    installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { lockStore } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      lockStore,
    });
    const media: MediaLike = {
      id: 'm1',
      // The 200×150 original is smaller than the 300×300 box: the worker makes a preview at the
      // original's own size, so the variant is queued like any other.
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
    const { lockStore } = makeLocks(true);
    const r = makeResizer({
      storage: makeStorage(),
      tasks,
      lockStore,
      pipelines: { watermark: {} },
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

describe('prewarm — unknown pipeline', () => {
  test('every requested variant is unconfirmed with one non-retryable RESIZE_PIPELINE_UNKNOWN issue', async () => {
    const { errors } = installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { lockStore, acquired } = makeLocks(true);
    const r = makeResizer({ tasks, lockStore });
    const result = await r.prewarm({
      media: {
        id: 'm1',
        original: { storageRef: { key: 'orig.jpg' } },
        // Stored for that pipeline name: still not reported as ready.
        previews: [
          {
            storageRef: { key: 'p.jpg' },
            sizeKey: '300x300',
            format: 'jpeg',
            contentType: 'image/jpeg',
            pipeline: 'retired',
          },
        ],
      },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
      pipeline: 'retired',
    });
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(
      result.requested.map((p) => `${p.sizeKey}:${p.format}`),
      ['300x300:jpeg', '300x300:webp'],
    );
    assert.deepEqual(result.unconfirmed, result.requested);
    assert.deepEqual(result.ready, []);
    assert.deepEqual(result.accepted, []);
    assert.deepEqual(result.notRequired, []);
    assert.deepEqual(result.tasks, []);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].code, 'RESIZE_PIPELINE_UNKNOWN');
    assert.equal(result.issues[0].retryable, false);
    assert.match(result.issues[0].message, /'retired'/);
    assert.deepEqual(result.issues[0].previews, result.requested);
    assert.equal(calls.length, 0);
    assert.equal(acquired.length, 0);
    assert.equal(errors.length, 1);
  });
});

describe('prewarm — per-call formats', () => {
  test('formats without an encode.formats entry are unconfirmed with a non-retryable issue; the rest queue', async () => {
    const { errors } = installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { lockStore } = makeLocks(true);
    const r = makeResizer({ tasks, lockStore });
    const result = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpg', 'webp'],
    });
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(
      calls[0].previews.map((p) => p.format),
      ['webp'],
    );
    assert.deepEqual(
      result.accepted.map((p) => p.format),
      ['webp'],
    );
    assert.deepEqual(
      result.unconfirmed.map((p) => p.format),
      ['jpg'],
    );
    assert.deepEqual(result.requested.map((p) => p.format).sort(), [
      'jpg',
      'webp',
    ]);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].code, 'RESIZE_FORMAT_NOT_CONFIGURED');
    assert.equal(result.issues[0].retryable, false);
    assert.deepEqual(result.issues[0].previews, result.unconfirmed);
    assert.equal(errors.length, 1);
  });

  test('only unconfigured formats: nothing queued, incomplete rather than an empty request', async () => {
    installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { lockStore } = makeLocks(true);
    const r = makeResizer({ tasks, lockStore });
    const result = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpg'],
    });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.reason, undefined);
    assert.equal(result.unconfirmed.length, 1);
    assert.equal(result.issues[0].code, 'RESIZE_FORMAT_NOT_CONFIGURED');
    assert.equal(calls.length, 0);
  });
});

describe('prewarm — formats from a beforeEnqueue tap', () => {
  const jpg300: MissingPreview = {
    sizeKey: '300x300',
    format: 'jpg',
    requestedWidth: 300,
    requestedHeight: 300,
  };

  test('an unconfigured format a tap adds is unconfirmed with a non-retryable issue; the rest queue', async () => {
    const { errors } = installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { lockStore, acquired } = makeLocks(true);
    const r = makeResizer({
      tasks,
      lockStore,
      hooks: { beforeEnqueue: (missing) => [...missing, jpg300] },
    });
    const result = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['webp'],
    });
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(
      calls[0].previews.map((p) => p.format),
      ['webp'],
    );
    assert.equal(acquired.length, 1);
    assert.deepEqual(
      result.accepted.map((p) => p.format),
      ['webp'],
    );
    assert.deepEqual(result.unconfirmed, [jpg300]);
    assert.deepEqual(result.requested.map((p) => p.format).sort(), [
      'jpg',
      'webp',
    ]);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].code, 'RESIZE_FORMAT_NOT_CONFIGURED');
    assert.equal(result.issues[0].retryable, false);
    assert.deepEqual(result.issues[0].previews, [jpg300]);
    assert.equal(errors.length, 1);
  });

  test('a tap that rewrites every variant to an unconfigured format queues nothing; a per-call duplicate is reported once', async () => {
    installFakeApp();
    const { tasks, calls } = makeTaskQueue();
    const { lockStore } = makeLocks(true);
    const r = makeResizer({
      tasks,
      lockStore,
      hooks: {
        beforeEnqueue: (missing) =>
          missing.map((m) => ({ ...m, format: 'jpg' })),
      },
    });
    const result = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpg', 'webp'],
    });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.reason, undefined);
    assert.equal(calls.length, 0);
    assert.deepEqual(result.unconfirmed, [jpg300]);
    assert.deepEqual(
      result.notRequired.map((p) => p.format),
      ['webp'],
    );
    assert.deepEqual(
      result.issues.map((issue) => [issue.code, issue.previews.length]),
      [['RESIZE_FORMAT_NOT_CONFIGURED', 1]],
    );
  });
});
