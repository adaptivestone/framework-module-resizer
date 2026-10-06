import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import type { NewTask } from './contracts/taskQueue.ts';
import { FrameworkResizer } from './framework/resizer.ts';
import {
  Resizer,
  type ResizeStorage,
  resetResizerForTests,
} from './resizer.ts';
import {
  type FakeLocks,
  fakeDb,
  MemoryTaskQueue,
} from './testHelpers/fakes.ts';
import {
  makeImageConfig,
  makeResizeConfig,
} from './testHelpers/resizeConfig.ts';
import type { MediaLike, StorageRef } from './types.d.ts';

// ---------------------------------------------------------------------------
// Harness — a recording ambient app (getConfig('resize') → { mediaModelName },
// recording logger) + recording driver fakes. A Resizer takes its logger/config from the
// app when it is constructed, so install the fake before constructing the Resizer.
// ---------------------------------------------------------------------------

function installFakeApp() {
  const info: unknown[][] = [];
  const warn: unknown[][] = [];
  const errors: unknown[][] = [];
  setAppInstance({
    getConfig: () => makeResizeConfig(),
    getModel: () => ({}),
    logger: {
      info(...a: unknown[]) {
        info.push(a);
      },
      warn(...a: unknown[]) {
        warn.push(a);
      },
      error(...a: unknown[]) {
        errors.push(a);
      },
    },
  } as never);
  return { info, warn, errors };
}

function makeStorage(o: Partial<ResizeStorage> = {}): ResizeStorage {
  return {
    download: async () => Buffer.alloc(0),
    upload: async () => ({ key: 'k' }),
    publicUrl: (ref: StorageRef) => `https://cdn/${ref.key}`,
    ...o,
  };
}

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

afterEach(() => {
  resetResizerForTests();
  resetAppInstance();
});

// ---------------------------------------------------------------------------
// §17 read-path — ready vs missing partitioning
// ---------------------------------------------------------------------------

describe('resolve — partitioning', () => {
  test('a falsy scalar preview ref remains ready and is passed through unchanged', async () => {
    installFakeApp();
    const refs: unknown[] = [];
    const r = new FrameworkResizer({
      storage: makeStorage({
        publicUrl: (ref) => {
          refs.push(ref);
          return `/media/${String(ref)}`;
        },
      }),
    });
    const { decision } = await r.resolve({
      media: {
        id: 'scalar',
        original: { storageRef: 0 },
        previews: [
          {
            storageRef: false,
            contentType: 'image/jpeg',
            sizeKey: '20x20',
            format: 'jpeg',
          },
        ],
      },
      sizes: [{ width: 20, height: 20 }],
      formats: ['jpeg'],
    });
    assert.equal(decision.ready[0]?.url, '/media/false');
    assert.deepEqual(refs, [false]);
  });
  test('partitions existing previews to ready and absent ones to missing', async () => {
    installFakeApp();
    const r = new FrameworkResizer({ storage: makeStorage() });
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
    const { decision } = await r.resolve({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
      enqueueMissing: false,
    });
    assert.equal(decision.ready.length, 1);
    assert.deepEqual(decision.ready[0], {
      sizeKey: '300x300',
      format: 'jpeg',
      url: 'https://cdn/p1',
      preview: media.previews?.[0],
      contentType: 'image/jpeg',
    });
    assert.equal(decision.missing.length, 1);
    assert.deepEqual(decision.missing[0], {
      sizeKey: '300x300',
      format: 'webp',
      requestedWidth: 300,
      requestedHeight: 300,
    });
  });

  test('a null original preserves cached previews, missing variants, and the formatting hook', async () => {
    const { errors } = installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks, acquired } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      db: fakeDb({ locks }),
      hooks: {
        formatPublicUrls: (decision) =>
          decision.ready.map((entry) => entry.url),
      },
    });
    // Plain/lean Mongo records can carry BSON null for this optional nested field.
    const media = {
      id: 'm1',
      original: null,
      previews: [
        {
          storageRef: { key: 'cached.jpg' },
          contentType: 'image/jpeg',
          sizeKey: '300x300',
          format: 'jpeg',
        },
      ],
    } as unknown as MediaLike;

    const { decision, output } = await r.resolve({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
    });

    assert.equal(decision.ready.length, 1);
    assert.equal(decision.ready[0].url, 'https://cdn/cached.jpg');
    assert.deepEqual(decision.missing, [
      {
        sizeKey: '300x300',
        format: 'webp',
        requestedWidth: 300,
        requestedHeight: 300,
      },
    ]);
    assert.deepEqual(output, ['https://cdn/cached.jpg']);
    assert.equal(calls.length, 0);
    assert.equal(acquired.length, 0);
    assert.equal(errors.length, 0);
  });

  test('a legacy original on a retired bucket never reaches the driver: its previews serve and missing ones queue', async () => {
    const { errors } = installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage({
        publicUrl: (ref: StorageRef) => {
          if (ref.key === 'legacy-origin.jpg') {
            throw new Error('original bucket is no longer allowlisted');
          }
          return `https://cdn/${ref.key}`;
        },
      }),
      tasks,
      db: fakeDb({ locks }),
    });
    const { decision } = await r.resolve({
      media: {
        id: 'm1',
        original: {
          storageRef: { key: 'legacy-origin.jpg' },
          bucket: 'retired-bucket',
          width: 50,
          height: 50,
        },
        previews: [
          {
            storageRef: { key: 'public-preview.jpg' },
            contentType: 'image/jpeg',
            sizeKey: '300x300',
            format: 'jpeg',
          },
        ],
      },
      sizes: [
        { width: 300, height: 300 },
        { width: 100, height: 100 },
      ],
      formats: ['jpeg'],
    });
    assert.deepEqual(
      decision.ready.map((entry) => entry.url),
      ['https://cdn/public-preview.jpg'],
    );
    assert.deepEqual(
      decision.missing.map((m) => m.sizeKey),
      ['100x100'],
    );
    assert.deepEqual(
      calls[0]?.previews.map((p) => p.sizeKey),
      ['100x100'],
    );
    assert.equal(errors.length, 0);
  });

  test('a filtered variant is distinct from the unfiltered same size', async () => {
    installFakeApp();
    const r = new FrameworkResizer({ storage: makeStorage() });
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
    const { decision } = await r.resolve({
      media,
      sizes: [
        { width: 300, height: 300 },
        { width: 300, height: 300, filters: { blur: 40 } },
      ],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.equal(decision.ready.length, 1);
    assert.equal(decision.ready[0].url, 'https://cdn/p1');
    assert.equal(decision.missing.length, 1);
    assert.deepEqual(decision.missing[0], {
      sizeKey: '300x300',
      format: 'jpeg',
      filters: { blur: 40 },
      requestedWidth: 300,
      requestedHeight: 300,
    });
  });

  test('a getSizeKey-throwing size is skipped; others are processed', async () => {
    installFakeApp();
    const r = new FrameworkResizer({ storage: makeStorage() });
    const { decision } = await r.resolve({
      media: { id: 'm1' },
      sizes: [{}, { width: 300, height: 300 }],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.equal(decision.ready.length, 0);
    assert.equal(decision.missing.length, 1);
    assert.equal(decision.missing[0].sizeKey, '300x300');
  });
});

// ---------------------------------------------------------------------------
// §17 read-path — hooks (resolveSizes / formatPublicUrls / beforeEnqueue)
// ---------------------------------------------------------------------------

describe('resolve — waterfall hooks', () => {
  test('resolveSizes tap expands the size list fed to the loop', async () => {
    installFakeApp();
    const r = new FrameworkResizer({
      storage: makeStorage(),
      hooks: {
        resolveSizes: () => [
          { width: 100, height: 100 },
          { width: 200, height: 200 },
        ],
      },
    });
    const { decision } = await r.resolve({
      media: { id: 'm1' },
      sizes: [],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.equal(decision.missing.length, 2);
    assert.deepEqual(decision.missing.map((m) => m.sizeKey).sort(), [
      '100x100',
      '200x200',
    ]);
  });

  test('formatPublicUrls tap output is returned as `output`', async () => {
    installFakeApp();
    const r = new FrameworkResizer({
      storage: makeStorage(),
      hooks: { formatPublicUrls: () => ({ shaped: true }) },
    });
    const { decision, output } = await r.resolve({
      media: { id: 'm1' },
      sizes: [],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.deepEqual(output, { shaped: true });
    assert.deepEqual(decision, { ready: [], missing: [] });
  });

  test('with no formatPublicUrls tap, output === undefined', async () => {
    installFakeApp();
    const r = new FrameworkResizer({ storage: makeStorage() });
    const { decision, output } = await r.resolve({
      media: { id: 'm1' },
      sizes: [],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.deepEqual(decision, { ready: [], missing: [] });
    assert.equal(output, undefined);
  });

  test('a throwing formatPublicUrls tap yields output === undefined (does not leak the decision)', async () => {
    const { errors } = installFakeApp();
    const r = new FrameworkResizer({
      storage: makeStorage(),
      hooks: {
        formatPublicUrls: () => {
          throw new Error('dto boom');
        },
      },
    });
    const { decision, output } = await r.resolve({
      media: { id: 'm1' },
      sizes: [],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.deepEqual(decision, { ready: [], missing: [] });
    assert.equal(output, undefined);
    assert.ok(errors.length >= 1);
  });

  test('a throwing beforeEnqueue tap is skipped (missing kept intact)', async () => {
    const { errors } = installFakeApp();
    const r = new FrameworkResizer({
      storage: makeStorage(),
      hooks: {
        beforeEnqueue: () => {
          throw new Error('boom');
        },
      },
    });
    const { decision } = await r.resolve({
      media: { id: 'm1' },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.equal(decision.missing.length, 1);
    assert.ok(errors.length >= 1);
  });
});

// ---------------------------------------------------------------------------
// §17 step 9 → §18 — enqueue wiring
// ---------------------------------------------------------------------------

describe('resolve — enqueue wiring', () => {
  test('threads the pipeline name and enqueues only the missing variants', async () => {
    installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      db: fakeDb({ locks }),
      pipelines: { photo: {} },
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
          pipeline: 'photo', // previews are scoped by pipeline
        },
      ],
    };
    await r.resolve({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
      pipeline: 'photo',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mediaId, 'm1');
    assert.equal(calls[0].pipeline, 'photo');
    assert.deepEqual(
      calls[0].previews.map((p) => `${p.sizeKey}:${p.format}`),
      ['300x300:webp'],
    );
  });

  test('sends the Resizer name and its queue, or the per-call queue', async () => {
    installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      db: fakeDb({ locks }),
      name: 'listings',
      queue: 'interactive',
    });
    const media: MediaLike = {
      id: 'm1',
      original: { storageRef: { key: 'orig.jpg' }, contentType: 'image/jpeg' },
    };
    await r.resolve({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    await r.resolve({
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

  test('nothing is enqueued when nothing is missing', async () => {
    installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      db: fakeDb({ locks }),
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
    await r.resolve({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(calls.length, 0);
  });

  test('uses String(media._id) for the dispatch lock when id is absent', async () => {
    installFakeApp();
    const { tasks } = makeTasks();
    const { locks, acquired } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      db: fakeDb({ locks }),
    });
    await r.resolve({
      media: {
        _id: { toString: () => 'abc123' },
        original: { storageRef: { key: 'orig.jpg' } },
      },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(acquired.length, 1);
    assert.equal(
      acquired[0].key,
      'resize_dispatch:abc123:default:default:300x300:jpeg:none',
    );
  });

  test('resolve does not throw when tasks.add throws; survivor locks released', async () => {
    installFakeApp();
    const { tasks } = makeTasks(() => {
      throw new Error('task queue down');
    });
    const { locks, released } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      db: fakeDb({ locks }),
    });
    const { decision } = await r.resolve({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(decision.missing.length, 1);
    assert.deepEqual(released, [
      'resize_dispatch:m1:default:default:300x300:jpeg:none',
    ]);
  });

  test('resolve does not throw when task queue returns taskId null; locks released', async () => {
    installFakeApp();
    const { tasks } = makeTasks(() => ({ taskId: null }));
    const { locks, released } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      db: fakeDb({ locks }),
    });
    await r.resolve({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.deepEqual(released, [
      'resize_dispatch:m1:default:default:300x300:jpeg:none',
    ]);
  });

  test('an original without a key leaves variants missing without enqueueing or locking', async () => {
    const { info } = installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks, acquired } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      db: fakeDb({ locks }),
    });
    const { decision } = await r.resolve({
      media: { id: 'm1', original: {} as MediaLike['original'] },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(decision.missing.length, 1);
    assert.equal(calls.length, 0);
    assert.equal(acquired.length, 0);
    assert.equal(info.length, 1);
  });

  test('an absent original leaves variants missing without enqueueing or locking', async () => {
    const { info } = installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks, acquired } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      db: fakeDb({ locks }),
    });
    const { decision } = await r.resolve({
      media: { id: 'm1' },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(decision.missing.length, 1);
    assert.equal(calls.length, 0);
    assert.equal(acquired.length, 0);
    assert.equal(info.length, 1);
  });
});

describe('prewarm — missing original key', () => {
  test('returns zero without enqueueing or locking', async () => {
    installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks, acquired } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      db: fakeDb({ locks }),
    });
    const result = await r.prewarm({
      media: { id: 'm1', original: {} as MediaLike['original'] },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_NO_ORIGINAL');
    assert.equal(calls.length, 0);
    assert.equal(acquired.length, 0);
  });
});

// ---------------------------------------------------------------------------
// §17 step 9 — no task queue on the instance
// ---------------------------------------------------------------------------

describe('resolve — no task queue (eager-only host)', () => {
  test('defaults enqueueMissing to false: missing intact, no warn', async () => {
    const { warn } = installFakeApp();
    const r = new FrameworkResizer({ storage: makeStorage() });
    const { decision } = await r.resolve({
      media: { id: 'm1' },
      sizes: [
        { width: 300, height: 300 },
        { width: 100, height: 100 },
      ],
      formats: ['jpeg'],
    });
    assert.equal(decision.missing.length, 2);
    assert.equal(warn.length, 0);
  });

  test('explicit enqueueMissing:true with no task queue still warns once', async () => {
    const { warn } = installFakeApp();
    const r = new FrameworkResizer({ storage: makeStorage() });
    const { decision } = await r.resolve({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
      enqueueMissing: true,
    });
    assert.equal(decision.missing.length, 1);
    assert.equal(warn.length, 1);
  });
});

// ---------------------------------------------------------------------------
// SVG originals, including legacy public copies, require raster previews.
// ---------------------------------------------------------------------------

describe('resolve — SVG raster previews', () => {
  test('queues missing size×format variants instead of exposing a public original', async () => {
    installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      db: fakeDb({ locks }),
    });
    const media: MediaLike = {
      id: 'm1',
      original: {
        storageRef: { key: 'logo.svg' },
        contentType: 'image/svg+xml',
        width: 20,
        height: 20,
      },
    };
    const { decision } = await r.resolve({
      media,
      sizes: [
        { width: 300, height: 300 },
        { width: 100, height: 100 },
      ],
      formats: ['jpeg', 'webp'],
    });
    assert.equal(decision.ready.length, 0);
    assert.equal(decision.missing.length, 4);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].previews.length, 4);
  });

  test('never signs an SVG original or serves an SVG preview', async () => {
    installFakeApp();
    let signedCalls = 0;
    const r = new FrameworkResizer({
      storage: makeStorage({
        signedUrl: async () => {
          signedCalls++;
          return 'https://signed/private.svg';
        },
      }),
    });
    const media: MediaLike = {
      id: 'm1',
      original: {
        storageRef: { key: 'private/logo.svg' },
        contentType: 'image/svg+xml',
        width: 20,
        height: 20,
      },
      previews: [
        {
          storageRef: { key: 'published/logo.svg' },
          sizeKey: '300x300',
          format: 'jpeg',
          contentType: 'image/svg+xml',
        },
      ],
    };
    for (const ctx of [{}, { isOwner: true }]) {
      const { decision } = await r.resolve({
        media,
        sizes: [{ width: 300, height: 300 }],
        formats: ['jpeg'],
        ctx,
        enqueueMissing: false,
      });
      assert.deepEqual(decision.ready, []);
      assert.equal(decision.missing.length, 1);
    }
    assert.equal(signedCalls, 0);
  });

  test('stored raster preview is returned for an SVG original', async () => {
    installFakeApp();
    const r = new FrameworkResizer({ storage: makeStorage() });
    const { decision } = await r.resolve({
      media: {
        id: 'm1',
        original: { storageRef: { key: 'logo' }, format: 'svg' },
        previews: [
          {
            storageRef: { key: 'logo.webp' },
            sizeKey: '300x300',
            format: 'webp',
            contentType: 'image/webp',
          },
        ],
      },
      sizes: [{ width: 300, height: 300 }],
      formats: ['webp'],
      enqueueMissing: false,
    });
    assert.equal(decision.ready[0].url, 'https://cdn/logo.webp');
    assert.equal(decision.ready[0].contentType, 'image/webp');
    assert.deepEqual(decision.missing, []);
  });
});

// ---------------------------------------------------------------------------
// The original is never served in place of a preview
// ---------------------------------------------------------------------------

describe('resolve — the original is never served', () => {
  // Smaller than every requested box: the worker makes a preview at its own size instead.
  const smallOriginal = (): MediaLike => ({
    id: 'm1',
    original: {
      storageRef: { key: 'orig.jpg' },
      contentType: 'image/jpeg',
      width: 100,
      height: 100,
    },
  });

  test('a small public original with a 300×300 size is missing and queued', async () => {
    installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(true);
    const r = new FrameworkResizer({
      // A custom driver written before the removal still declares its originals public: ignored.
      storage: makeStorage({
        canServeOriginalPublicly: () => true,
      } as Partial<ResizeStorage>),
      tasks,
      db: fakeDb({ locks }),
    });
    const { decision } = await r.resolve({
      media: smallOriginal(),
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
    });
    assert.deepEqual(decision.ready, []);
    assert.deepEqual(decision.missing, [
      {
        sizeKey: '300x300',
        format: 'jpeg',
        requestedWidth: 300,
        requestedHeight: 300,
      },
      {
        sizeKey: '300x300',
        format: 'webp',
        requestedWidth: 300,
        requestedHeight: 300,
      },
    ]);
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0].previews.map((p) => `${p.sizeKey}:${p.format}`),
      ['300x300:jpeg', '300x300:webp'],
    );
  });

  test('an owner or admin ctx changes nothing: the original is neither signed nor linked', async () => {
    installFakeApp();
    const signed: StorageRef[] = [];
    const linked: StorageRef[] = [];
    const r = new FrameworkResizer({
      storage: makeStorage({
        publicUrl: (ref: StorageRef) => {
          linked.push(ref);
          return `https://cdn/${ref.key}`;
        },
        signedUrl: async (ref: StorageRef) => {
          signed.push(ref);
          return `https://signed/${ref.key}`;
        },
      }),
    });
    const read = (ctx: Record<string, unknown>) =>
      r.resolve({
        media: smallOriginal(),
        sizes: [{ width: 300, height: 300 }],
        formats: ['jpeg'],
        ctx,
        enqueueMissing: false,
      });
    const anonymous = await read({});
    assert.deepEqual(anonymous.decision.ready, []);
    assert.equal(anonymous.decision.missing.length, 1);
    for (const ctx of [{ isOwner: true }, { isAdmin: true }]) {
      assert.deepEqual((await read(ctx)).decision, anonymous.decision);
    }
    assert.deepEqual(signed, []);
    assert.deepEqual(linked, []);
  });

  test('every size shape is missing for a step-less pipeline too', async () => {
    installFakeApp();
    const r = new FrameworkResizer({
      storage: makeStorage(),
      pipelines: { plain: { beforeSteps: [], variantSteps: [] } },
    });
    for (const pipeline of ['default', 'plain']) {
      const { decision } = await r.resolve({
        media: smallOriginal(),
        sizes: [
          { width: 300, height: 300 },
          { width: 300 },
          { fit: true },
          { width: 300, height: 300, filters: { blur: 40 } },
        ],
        formats: ['jpeg'],
        pipeline,
        enqueueMissing: false,
      });
      assert.deepEqual(decision.ready, []);
      assert.deepEqual(
        decision.missing.map((m) => m.sizeKey),
        ['300x300', '300w', 'fit', '300x300'],
      );
    }
  });
});

// ---------------------------------------------------------------------------
// §17 never-throw guarantee
// ---------------------------------------------------------------------------

describe('resolve — never throws', () => {
  // p2's ref is rejected by the driver (e.g. its bucket is no longer allowlisted).
  const throwingStorage = () =>
    makeStorage({
      publicUrl: (ref: StorageRef) => {
        if (ref.key === 'p2') {
          throw new Error('bucket is not allowlisted');
        }
        return `https://cdn/${ref.key}`;
      },
    });
  const storedPreview = (key: string, sizeKey: string) => ({
    storageRef: { key },
    contentType: 'image/jpeg',
    sizeKey,
    format: 'jpeg',
  });
  const threeStored = (): MediaLike => ({
    id: 'm1',
    original: { storageRef: { key: 'orig.jpg' }, width: 4000, height: 3000 },
    previews: [
      storedPreview('p1', '300x300'),
      storedPreview('p2', '100x100'),
      storedPreview('p3', '50x50'),
    ],
  });
  const sizes = [
    { width: 300, height: 300 },
    { width: 100, height: 100 },
    { width: 50, height: 50 },
    { width: 600, height: 600 },
  ];

  test('a publicUrl throw skips only that cell: later cells, the hook and the enqueue proceed', async () => {
    const { errors } = installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: throwingStorage(),
      tasks,
      db: fakeDb({ locks }),
      hooks: {
        formatPublicUrls: (decision) =>
          decision.ready.map((entry) => entry.url),
      },
    });
    const { decision, output } = await r.resolve({
      media: threeStored(),
      sizes,
      formats: ['jpeg'],
      enqueueMissing: true,
    });
    assert.deepEqual(
      decision.ready.map((entry) => entry.url),
      ['https://cdn/p1', 'https://cdn/p3'],
    );
    // The rejected preview is neither ready nor missing; the absent size still queues.
    assert.deepEqual(
      decision.missing.map((m) => m.sizeKey),
      ['600x600'],
    );
    assert.deepEqual(output, ['https://cdn/p1', 'https://cdn/p3']);
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0].previews.map((p) => p.sizeKey),
      ['600x600'],
    );
    assert.equal(errors.length, 1);
  });

  test('a publicUrl throw without enqueueing still returns every other cell', async () => {
    const { errors } = installFakeApp();
    const r = new FrameworkResizer({ storage: throwingStorage() });
    const { decision } = await r.resolve({
      media: threeStored(),
      sizes,
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.deepEqual(
      decision.ready.map((entry) => entry.url),
      ['https://cdn/p1', 'https://cdn/p3'],
    );
    assert.deepEqual(
      decision.missing.map((m) => m.sizeKey),
      ['600x600'],
    );
    assert.equal(errors.length, 1);
  });

  test('resolve(undefined) returns the logged safe empty decision', async () => {
    const { errors } = installFakeApp();
    const r = new FrameworkResizer({ storage: makeStorage() });
    const { decision, output } = await r.resolve(undefined as never);
    assert.deepEqual(decision, { ready: [], missing: [] });
    assert.equal(output, undefined);
    assert.equal(errors.length, 1);
  });

  test('media with no id/_id → logged safe empty decision (never-throw wrapper absorbs requireMediaId)', async () => {
    const { errors } = installFakeApp();
    const r = new FrameworkResizer({ storage: makeStorage() });
    const { decision, output } = await r.resolve({
      media: {
        original: {
          storageRef: { key: 'orig.jpg' },
          contentType: 'image/jpeg',
        },
      },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.deepEqual(decision, { ready: [], missing: [] });
    assert.equal(output, undefined);
    assert.ok(errors.length >= 1);
  });
});

describe('resolve — unknown pipeline', () => {
  test('serves stored previews of that pipeline, reports nothing missing, queues nothing and logs', async () => {
    const { errors } = installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks, acquired } = makeLocks(true);
    let beforeEnqueueCalls = 0;
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      db: fakeDb({ locks }),
      hooks: {
        beforeEnqueue: (missing) => {
          beforeEnqueueCalls += 1;
          return [...missing, { sizeKey: '10x10', format: 'jpeg' }];
        },
        formatPublicUrls: (decision) =>
          decision.ready.map((entry) => entry.url),
      },
    });
    const media: MediaLike = {
      id: 'm1',
      // Smaller than the box: still not served, for an unknown pipeline as for any other.
      original: { storageRef: { key: 'orig.jpg' }, width: 100, height: 100 },
      previews: [
        {
          storageRef: { key: 'retired.webp' },
          contentType: 'image/webp',
          sizeKey: '300x300',
          format: 'webp',
          pipeline: 'retired',
        },
        {
          storageRef: { key: 'default.jpg' },
          contentType: 'image/jpeg',
          sizeKey: '300x300',
          format: 'jpeg',
        },
      ],
    };
    const { decision, output } = await r.resolve({
      media,
      sizes: [{ width: 300, height: 300 }, { width: 600 }],
      formats: ['jpeg', 'webp'],
      pipeline: 'retired',
      enqueueMissing: true,
    });
    assert.deepEqual(
      decision.ready.map((entry) => entry.url),
      ['https://cdn/retired.webp'],
    );
    assert.deepEqual(decision.missing, []);
    assert.deepEqual(output, ['https://cdn/retired.webp']);
    assert.equal(beforeEnqueueCalls, 0);
    assert.equal(calls.length, 0);
    assert.equal(acquired.length, 0);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /'retired'/);
  });

  test('"default" is always known, registered or not', async () => {
    const { errors } = installFakeApp();
    const r = new FrameworkResizer({ storage: makeStorage() });
    const { decision } = await r.resolve({
      media: { id: 'm1' },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
      pipeline: 'default',
      enqueueMissing: false,
    });
    assert.equal(decision.missing.length, 1);
    assert.equal(errors.length, 0);
  });
});

describe('resolve — per-call formats', () => {
  test('formats without an encode.formats entry are dropped with one logged error', async () => {
    const { errors } = installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      db: fakeDb({ locks }),
    });
    const { decision } = await r.resolve({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [
        { width: 100, height: 100 },
        { width: 200, height: 200 },
      ],
      // 'toString' is inherited, not an own key of encode.formats.
      formats: ['jpg', 'webp', '../../etc', 'toString', 'jpg'],
    });
    assert.deepEqual(
      decision.missing.map((m) => `${m.sizeKey}:${m.format}`),
      ['100x100:webp', '200x200:webp'],
    );
    assert.deepEqual(
      calls[0].previews.map((p) => p.format),
      ['webp', 'webp'],
    );
    assert.equal(errors.length, 1);
    const message = String(errors[0][0]);
    for (const dropped of ['jpg', '../../etc', 'toString']) {
      assert.ok(message.includes(dropped), `${dropped} named in: ${message}`);
    }
    assert.ok(!message.includes('webp'));
  });

  test('a beforeEnqueue tap cannot queue a format without an encode.formats entry', async () => {
    const { errors } = installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      db: fakeDb({ locks }),
      hooks: {
        beforeEnqueue: (missing) => [
          ...missing,
          {
            sizeKey: '300x300',
            format: 'jpg',
            requestedWidth: 300,
            requestedHeight: 300,
          },
        ],
      },
    });
    const { decision } = await r.resolve({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['webp'],
    });
    assert.deepEqual(
      decision.missing.map((m) => m.format),
      ['webp'],
    );
    assert.deepEqual(
      calls[0].previews.map((p) => p.format),
      ['webp'],
    );
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /"jpg".*beforeEnqueue/);
  });

  test('a stored preview of an unconfigured format is not served', async () => {
    const { errors } = installFakeApp();
    const r = new FrameworkResizer({ storage: makeStorage() });
    const { decision } = await r.resolve({
      media: {
        id: 'm1',
        previews: [
          {
            storageRef: { key: 'old.png' },
            contentType: 'image/png',
            sizeKey: '300x300',
            format: 'png',
          },
        ],
      },
      sizes: [{ width: 300, height: 300 }],
      formats: ['png'],
      enqueueMissing: false,
    });
    assert.deepEqual(decision, { ready: [], missing: [] });
    assert.equal(errors.length, 1);
  });

  test('the configured default formats log nothing', async () => {
    const { errors } = installFakeApp();
    const r = new FrameworkResizer({ storage: makeStorage() });
    const { decision } = await r.resolve({
      media: { id: 'm1' },
      sizes: [{ width: 300, height: 300 }],
      enqueueMissing: false,
    });
    assert.deepEqual(
      decision.missing.map((m) => m.format),
      ['jpeg', 'webp', 'avif'],
    );
    assert.equal(errors.length, 0);
  });
});

describe('several Resizers in one process', () => {
  test('each resolve uses its own formats and logger', async () => {
    const errorsA: unknown[][] = [];
    const errorsB: unknown[][] = [];
    const logger = (errors: unknown[][]) => ({
      info() {},
      warn() {},
      error: (...args: unknown[]) => {
        errors.push(args);
      },
    });
    // Core Resizers with explicit parts: no framework app is installed in this test.
    const db = fakeDb();
    const a = new Resizer({
      storage: makeStorage(),
      db,
      config: makeImageConfig({ formats: ['webp'] }),
      logger: logger(errorsA),
    });
    const b = new Resizer({
      name: 'listings',
      storage: makeStorage(),
      db,
      config: makeImageConfig({ formats: ['jpeg'] }),
      logger: logger(errorsB),
    });
    const media = { id: 'm1', previews: [] };
    const sizes = [{ width: 10, height: 10 }];

    const fromA = await a.resolve({ media, sizes });
    const fromB = await b.resolve({ media, sizes });
    assert.deepEqual(
      fromA.decision.missing.map((m) => m.format),
      ['webp'],
    );
    assert.deepEqual(
      fromB.decision.missing.map((m) => m.format),
      ['jpeg'],
    );

    // A media without an id is a never-throw failure, logged by the Resizer that hit it.
    await b.resolve({ media: {} as never, sizes });
    assert.equal(errorsA.length, 0);
    assert.equal(errorsB.length, 1);
  });
});

describe('pipelines are part of preview identity', () => {
  const stored = {
    storageRef: { k: 'clean' },
    sizeKey: '300x300',
    format: 'webp',
    contentType: 'image/webp',
  };
  const sizes = [{ width: 300, height: 300 }];

  test('a default preview is not served for another pipeline', async () => {
    installFakeApp();
    const r = new FrameworkResizer({
      storage: makeStorage(),
      pipelines: { watermark: {} },
    });
    const media = { id: 'm1', previews: [stored] };
    const clean = await r.resolve({ media, sizes, formats: ['webp'] });
    const watermarked = await r.resolve({
      media,
      sizes,
      formats: ['webp'],
      pipeline: 'watermark',
    });
    assert.equal(clean.decision.ready.length, 1);
    assert.equal(watermarked.decision.ready.length, 0);
    assert.equal(watermarked.decision.missing.length, 1);
  });

  test('a preview stored for a pipeline is served only to that pipeline', async () => {
    installFakeApp();
    const r = new FrameworkResizer({
      storage: makeStorage(),
      pipelines: { watermark: {} },
    });
    const media = {
      id: 'm1',
      previews: [{ ...stored, pipeline: 'watermark' }],
    };
    const watermarked = await r.resolve({
      media,
      sizes,
      formats: ['webp'],
      pipeline: 'watermark',
    });
    const clean = await r.resolve({ media, sizes, formats: ['webp'] });
    assert.equal(watermarked.decision.ready.length, 1);
    assert.equal(clean.decision.ready.length, 0);
  });

  test("another Resizer's preview is not served", async () => {
    installFakeApp();
    const r = new FrameworkResizer({
      name: 'listings',
      storage: makeStorage(),
    });
    const media = { id: 'm1', previews: [stored] };
    const result = await r.resolve({ media, sizes, formats: ['webp'] });
    assert.equal(result.decision.ready.length, 0);
    assert.equal(result.decision.missing.length, 1);
  });
});
