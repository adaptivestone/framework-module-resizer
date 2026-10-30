import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import sharp from 'sharp';
import { defaultCoordination } from './config/resize.ts';
import type { LockStore } from './contracts/locks.ts';
import type { MediaStore } from './contracts/media.ts';
import type { Pipeline } from './contracts/pipeline.ts';
import type { ResizeStorage } from './contracts/storage.ts';
import { ResizeConfigError, ResizeSetupError } from './errors.ts';
import { FrameworkLockStore } from './framework/locks.ts';
import { FrameworkMediaStore } from './framework/media.ts';
import { FrameworkResizer } from './framework/resizer.ts';
import { LogMetrics, NoopMetrics } from './metrics.ts';
import {
  getResizer,
  listResizers,
  metricsOf,
  Resizer,
  type ResizerOptions,
  resetResizerForTests,
  sharedPart,
  taskCoordinationOf,
  verifyRouteOf,
  verifyServicesOf,
} from './resizer.ts';
import { markUnavailable, RoutingTaskQueue } from './routing.ts';
import {
  fakeMedia,
  MemoryTaskQueue,
  memoryLocks,
  PlainTaskQueue,
  recordingMetrics,
} from './testHelpers/fakes.ts';
import { stampFresh } from './testHelpers/fresh.ts';
import {
  makeImageConfig,
  makeResizeConfig,
} from './testHelpers/resizeConfig.ts';
import type { MissingPreview, SizeInput } from './types.d.ts';

// ---------------------------------------------------------------------------
// Fakes. The Resizer stores passed driver references verbatim (identity checks);
// FrameworkResizer fills omitted parts with framework-driver instances (instanceof
// checks) and takes the logger from the fake app installed here.
// ---------------------------------------------------------------------------

const fakeStorage = (): ResizeStorage => ({
  download: async () => Buffer.alloc(0),
  upload: async () => ({ key: 'k' }),
  publicUrl: () => '',
});

// A fake app with a silent logger and no event bus. The Resizer reads the app when it is
// constructed, so install this before constructing the Resizer.
function installFakeApp(): void {
  resetAppInstance();
  setAppInstance({
    getConfig: () => makeResizeConfig(),
    getModel: () => ({}),
    logger: { info() {}, warn() {}, error() {} },
  } as never);
}

// The minimal valid options: only `storage` is required.
const baseOpts = () => ({ storage: fakeStorage() });

beforeEach(() => {
  installFakeApp();
});

afterEach(() => {
  resetResizerForTests();
  resetAppInstance();
});

// ---------------------------------------------------------------------------
// Constructor + wiring semantics (02 · §6, delta #12)
// ---------------------------------------------------------------------------

describe('Resizer constructor — driver wiring', () => {
  test('FrameworkResizer fills the media store, and the lock store only beside a queue without gatesByTask', async () => {
    const eager = new FrameworkResizer(baseOpts());
    assert.ok(eager.media instanceof FrameworkMediaStore);
    await eager.ready();
    assert.equal(eager.locks, undefined); // no `queue` section: eager only
    resetResizerForTests();
    const tasks = new MemoryTaskQueue();
    const gating = new FrameworkResizer({ ...baseOpts(), tasks });
    assert.ok(gating.media instanceof FrameworkMediaStore);
    assert.equal(gating.locks, undefined);
    assert.equal(gating.tasks, tasks);
    resetResizerForTests();
    const plain = new FrameworkResizer({
      ...baseOpts(),
      tasks: new PlainTaskQueue(),
    });
    assert.ok(plain.locks instanceof FrameworkLockStore);
  });

  test('keeps passed drivers (no defaulting when provided)', () => {
    const storage = fakeStorage();
    const tasks = new MemoryTaskQueue();
    const media = fakeMedia();
    const locks = memoryLocks();
    const r = new FrameworkResizer({
      storage,
      tasks,
      media,
      locks,
    });
    assert.equal(r.storage, storage);
    assert.equal(r.tasks, tasks);
    assert.equal(r.media, media);
    assert.equal(r.locks, locks);
  });

  test('task queue is undefined when the config has no queue (eager-only host)', async () => {
    const r = new FrameworkResizer(baseOpts());
    await r.ready();
    assert.equal(r.tasks, undefined);
    assert.equal(
      new Resizer({ ...baseOpts(), name: 'core', media: fakeMedia() }).tasks,
      undefined,
    );
  });

  test('throws a named error when storage is missing (JS host / half-filled wiring)', () => {
    // A JS host could omit the required `storage` — fail loudly at construction with a NAMED
    // error, not a downstream TypeError (02 · §6 review fix).
    assert.throws(
      () => new Resizer({ media: fakeMedia() } as never),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_STORAGE_REQUIRED' &&
        // The message points at nothing the package does not ship.
        !err.message.includes('§'),
    );
    // The bad construction must NOT have claimed the active slot.
    assert.throws(() => getResizer(), /no Resizer named 'default'/);
  });

  test('an explicit invalid config is rejected at construction without claiming the name', () => {
    resetAppInstance();
    assert.throws(
      () =>
        new Resizer({
          storage: fakeStorage(),
          media: fakeMedia(),
          config: { ...makeImageConfig(), upload: null } as never,
        }),
      /upload must be an object/,
    );
    assert.throws(() => getResizer(), /no Resizer named 'default'/);
  });

  test('a framework Resizer reads its config file lazily; verify() reports a bad one', async () => {
    // Constructed before any framework app exists: nothing is read yet.
    resetAppInstance();
    const r = new FrameworkResizer(baseOpts());
    setAppInstance({
      getConfig: () => ({ mediaModelName: 'File', upload: null }),
      getModel: () => ({}),
      logger: { info() {}, warn() {}, error() {} },
    } as never);
    await assert.rejects(() => r.verify(), /upload must be an object/);
  });

  test('a framework Resizer built before the app works once the app exists', () => {
    resetAppInstance();
    const r = new FrameworkResizer(baseOpts());
    setAppInstance({
      getConfig: () => makeResizeConfig({ formats: ['webp'] }),
      getModel: () => ({}),
      logger: { info() {}, warn() {}, error() {} },
    } as never);
    assert.deepEqual(r.config.formats, ['webp']);
  });

  test('the default media store loads from the Resizer’s own media model', async () => {
    const asked: string[] = [];
    resetAppInstance();
    setAppInstance({
      getConfig: () => makeResizeConfig(), // mediaModelName 'File'
      getModel: (name: string) => {
        asked.push(name);
        return { findById: async () => null };
      },
      logger: { info() {}, warn() {}, error() {} },
    } as never);
    const photos = new FrameworkResizer({
      ...baseOpts(),
      name: 'photos',
      config: makeResizeConfig({ mediaModelName: 'Photo' }),
    });
    const files = new FrameworkResizer(baseOpts());
    await photos.media.loadMedia('m1');
    await files.media.loadMedia('m2');
    assert.deepEqual(asked, ['Photo', 'File']);
  });

  test('seeds pipelines from options', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#ff0000' },
    })
      .png()
      .toBuffer();
    const ran: string[] = [];
    const photo: Pipeline = {
      variantSteps: [
        async (img) => {
          ran.push('photo');
          return img;
        },
      ],
    };
    const r = new FrameworkResizer({
      storage: {
        download: async () => png,
        upload: async () => ({ key: 'k' }),
        publicUrl: () => '',
      },
      pipelines: { photo },
    });
    assert.equal(r.hasPipeline('photo'), true);
    const { created } = await r.generate({
      media: { id: 'm1', original: { storageRef: { key: 'o' } }, previews: [] },
      sizes: [{ width: 4, height: 4 }],
      formats: ['jpeg'],
      pipeline: 'photo',
      persist: false,
    });
    assert.equal(created.length, 1);
    assert.deepEqual(ran, ['photo']);
  });

  // The media has no previews, so every size the taps return is missing.
  const unrendered = { id: 'm1', previews: [] };

  test('seeds hooks from options — single fn form threads through resolve', async () => {
    installFakeApp();
    const r = new FrameworkResizer({
      ...baseOpts(),
      hooks: {
        resolveSizes: (sizes: SizeInput[]) => [
          ...sizes,
          { width: 10, height: 10 },
        ],
      },
    });
    const { decision } = await r.resolve({
      media: unrendered,
      sizes: [],
      formats: ['jpeg'],
    });
    assert.deepEqual(
      decision.missing.map((v) => v.sizeKey),
      ['10x10'],
    );
  });

  test('seeds hooks from options — array form runs every tap in order', async () => {
    installFakeApp();
    const r = new FrameworkResizer({
      ...baseOpts(),
      hooks: {
        resolveSizes: [
          (sizes: SizeInput[]) => [...sizes, { width: 10, height: 10 }],
          async (sizes: SizeInput[]) =>
            sizes.map((s) => ({
              width: (s.width ?? 0) * 2,
              height: (s.height ?? 0) * 2,
            })),
        ],
      },
    });
    const { decision } = await r.resolve({
      media: unrendered,
      sizes: [],
      formats: ['jpeg'],
    });
    // Added, then doubled.
    assert.deepEqual(
      decision.missing.map((v) => v.sizeKey),
      ['20x20'],
    );
  });
});

// ---------------------------------------------------------------------------
// Named registry: several Resizers per process, one per name
// ---------------------------------------------------------------------------

describe('drivers given as functions', () => {
  const silent = { info() {}, warn() {}, error() {} };

  test('are called once, on first use, sync or async — even under concurrent calls', async () => {
    const storage = fakeStorage();
    const media = fakeMedia();
    const locks = memoryLocks();
    const tasks = new MemoryTaskQueue();
    const calls: string[] = [];
    const r = new Resizer({
      logger: silent,
      storage: () => {
        calls.push('storage');
        return storage;
      },
      media: async () => {
        calls.push('media');
        return media;
      },
      locks: () => {
        calls.push('locks');
        return locks;
      },
      tasks: async () => {
        calls.push('tasks');
        return tasks;
      },
    });
    assert.deepEqual(calls, []);
    for (const part of ['storage', 'media', 'locks', 'tasks'] as const) {
      assert.throws(
        () => r[part],
        (err: unknown) =>
          err instanceof ResizeSetupError &&
          err.code === 'RESIZE_NOT_READY' &&
          err.message.includes(part),
      );
    }
    await Promise.all([r.ready(), r.ready(), r.verify()]);
    assert.deepEqual(calls.sort(), ['locks', 'media', 'storage', 'tasks']);
    assert.equal(r.storage, storage);
    assert.equal(r.media, media);
    assert.equal(r.locks, locks);
    assert.equal(r.tasks, tasks);
    await r.ready();
    assert.equal(calls.length, 4);
  });

  test('a part given as an object is usable while another is still loading', () => {
    const media = fakeMedia();
    const r = new Resizer({
      logger: silent,
      storage: async () => fakeStorage(),
      media,
    });
    assert.equal(r.media, media);
    assert.equal(r.locks, undefined); // not given: eager only, nothing to wait for
    assert.equal(r.tasks, undefined);
    assert.throws(() => r.storage, /has not loaded `storage`/);
  });

  test('a failed load rejects, and the next call tries again', async () => {
    let attempts = 0;
    const storage = fakeStorage();
    const r = new Resizer({
      logger: silent,
      media: fakeMedia(),
      storage: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('optional peer missing');
        }
        return storage;
      },
    });
    await assert.rejects(() => r.verify(), /optional peer missing/);
    await r.ready();
    assert.equal(attempts, 2);
    assert.equal(r.storage, storage);
  });

  test('a part that loaded is kept when a sibling fails; only the failed part is retried', async () => {
    let storageCalls = 0;
    let mediaCalls = 0;
    const storage = fakeStorage();
    const media = fakeMedia();
    const r = new Resizer({
      logger: silent,
      storage: async () => {
        storageCalls += 1;
        return storage;
      },
      media: async () => {
        mediaCalls += 1;
        if (mediaCalls === 1) {
          throw new Error('db not up');
        }
        return media;
      },
    });
    await assert.rejects(() => r.ready(), /db not up/);
    // Concurrent calls after the failure share one retry of the failed part.
    await Promise.all([r.ready(), r.ready()]);
    await r.ready();
    assert.equal(storageCalls, 1);
    assert.equal(mediaCalls, 2);
    assert.equal(r.storage, storage);
    assert.equal(r.media, media);
  });

  test('ready() validates a lazy config, and reads it again after a failure', async () => {
    let reads = 0;
    const r = new Resizer({
      logger: silent,
      storage: fakeStorage(),
      media: fakeMedia(),
      config: () => {
        reads += 1;
        return reads === 1
          ? ({ ...makeImageConfig(), upload: null } as never)
          : makeImageConfig();
      },
    });
    await assert.rejects(
      () => r.ready(),
      (err: unknown) => err instanceof ResizeConfigError,
    );
    await r.ready();
    await r.ready();
    assert.equal(reads, 2);
  });

  test('resolve() returns the safe empty decision when a lazy config fails to validate', async () => {
    const r = new Resizer({
      logger: silent,
      storage: fakeStorage(),
      media: fakeMedia(),
      config: () => ({ ...makeImageConfig(), upload: null }) as never,
    });
    assert.deepEqual(
      await r.resolve({ media: { id: 'm1' }, sizes: [{ width: 10 }] }),
      { decision: { ready: [], missing: [] }, output: undefined },
    );
  });

  test('a failed lazy task queue stays not ready until it loads', async () => {
    let taskCalls = 0;
    const tasks = new MemoryTaskQueue();
    const r = new Resizer({
      logger: silent,
      storage: fakeStorage(),
      media: fakeMedia(),
      locks: memoryLocks(),
      tasks: async () => {
        taskCalls += 1;
        if (taskCalls === 1) {
          throw new Error('queue not up');
        }
        return tasks;
      },
    });
    await assert.rejects(() => r.ready(), /queue not up/);
    assert.throws(
      () => r.tasks,
      (err: unknown) =>
        err instanceof ResizeSetupError && err.code === 'RESIZE_NOT_READY',
    );
    await r.ready();
    assert.equal(r.tasks, tasks);
    assert.equal(taskCalls, 2);
  });

  test('a loader that returns nothing for a required part is a setup error', async () => {
    const noStorage = new Resizer({
      name: 'a',
      logger: silent,
      storage: () => undefined as never,
      media: fakeMedia(),
    });
    await assert.rejects(
      () => noStorage.ready(),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_STORAGE_REQUIRED',
    );
    const noMedia = new Resizer({
      name: 'b',
      logger: silent,
      storage: fakeStorage(),
      media: async () => null as never,
    });
    await assert.rejects(
      () => noMedia.ready(),
      (err: unknown) =>
        err instanceof ResizeSetupError && err.code === 'RESIZE_MEDIA_REQUIRED',
    );
  });

  test('resolve() and prewarm() never throw when loading fails; generate() rejects', async () => {
    const errors: unknown[][] = [];
    const r = new Resizer({
      logger: { ...silent, error: (...args: unknown[]) => errors.push(args) },
      media: fakeMedia(),
      storage: async () => {
        throw new ResizeConfigError('no storage configured', {
          code: 'TEST_NO_STORAGE',
        });
      },
    });
    const media = { id: 'm1', original: { storageRef: { key: 'k' } } };
    const sizes = [{ width: 10, height: 10 }];
    const { decision, output } = await r.resolve({ media, sizes });
    assert.deepEqual(decision, { ready: [], missing: [] });
    assert.equal(output, undefined);
    const result = await r.prewarm({ media, sizes });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.issues[0].retryable, false);
    assert.ok(errors.length >= 2);
    await assert.rejects(
      () => r.generate({ media, sizes }),
      (err: unknown) =>
        err instanceof ResizeConfigError && err.code === 'TEST_NO_STORAGE',
    );
  });
});

describe('ports', () => {
  const silent = { info() {}, warn() {}, error() {} };
  const storage = fakeStorage();
  const locksRequired = (e: unknown) =>
    e instanceof ResizeSetupError &&
    e.code === 'RESIZE_LOCKS_REQUIRED' &&
    /SqsTaskQueue/.test(e.message) &&
    /one gate lock per media, pipeline and queue/.test(e.message) &&
    /FrameworkResizer/.test(e.message) &&
    /mongoParts/.test(e.message);

  test('a missing media store is RESIZE_MEDIA_REQUIRED at construction', () =>
    assert.throws(
      () => new Resizer({ storage } as unknown as ResizerOptions),
      (e: unknown) =>
        e instanceof ResizeSetupError &&
        e.code === 'RESIZE_MEDIA_REQUIRED' &&
        /FrameworkResizer/.test(e.message) &&
        /mongoParts/.test(e.message),
    ));

  test('a lazy media store that returns nothing is RESIZE_MEDIA_REQUIRED at ready()', async () => {
    const r = new Resizer({
      logger: silent,
      storage,
      media: () => undefined as unknown as MediaStore,
    });
    await assert.rejects(
      () => r.ready(),
      (e: unknown) =>
        e instanceof ResizeSetupError && e.code === 'RESIZE_MEDIA_REQUIRED',
    );
  });

  test('verify() rejects a media store without replacePreviews', async () => {
    let storeVerified = 0;
    // A custom store written before replacePreviews existed.
    const media = {
      loadMedia: async () => null,
      appendPreviews: async (_id: string, previews: unknown[]) => previews,
      verify: () => {
        storeVerified += 1;
      },
    } as unknown as MediaStore;
    const r = new Resizer({ logger: silent, storage, media });
    await r.ready();
    await assert.rejects(
      () => r.verify(),
      (e: unknown) =>
        e instanceof ResizeSetupError &&
        e.code === 'RESIZE_MEDIA_REPLACE_MISSING' &&
        e.message ===
          'resize: the media store has no replacePreviews(mediaId, identities, rows) — a custom MediaStore needs it since 0.3.0',
    );
    // Checked after the store's own verify().
    assert.equal(storeVerified, 1);
  });

  test('a task queue with gatesByTask needs no locks; one without is RESIZE_LOCKS_REQUIRED from verify()', async () => {
    const gating = new Resizer({
      logger: silent,
      storage,
      media: fakeMedia(),
      tasks: new MemoryTaskQueue(),
    });
    await gating.verify();
    assert.equal(gating.locks, undefined);
    resetResizerForTests();
    const plain = new Resizer({
      logger: silent,
      storage,
      media: fakeMedia(),
      locks: () => undefined,
      tasks: new PlainTaskQueue(),
    });
    await plain.ready();
    assert.equal(plain.locks, undefined);
    await assert.rejects(() => plain.verify(), locksRequired);
  });

  test('ready() and verify() check the image config before the task queue, and log nothing about the queue', async () => {
    let configReads = 0;
    let timingReads = 0;
    const errors: unknown[][] = [];
    const tasks = new MemoryTaskQueue();
    tasks.getTiming = () => {
      timingReads += 1;
      return { leaseMs: 0 };
    };
    const r = new Resizer({
      logger: {
        info() {},
        warn() {},
        error: (...args: unknown[]) => {
          errors.push(args);
        },
      },
      storage,
      media: fakeMedia(),
      locks: memoryLocks(),
      tasks,
      config: () => {
        configReads += 1;
        return { ...makeImageConfig(), upload: null } as never;
      },
    });
    const badConfig = (e: unknown) =>
      e instanceof ResizeConfigError &&
      /upload must be an object/.test(e.message);
    await assert.rejects(() => r.ready(), badConfig);
    await assert.rejects(() => r.verify(), badConfig);
    assert.equal(configReads, 2);
    assert.equal(timingReads, 0);
    assert.deepEqual(errors, []);
  });

  test('an eager-only Resizer needs no locks, and has no db', async () => {
    const r = new Resizer({ storage, media: fakeMedia() });
    await r.ready();
    assert.equal(r.locks, undefined);
    assert.equal(r.tasks, undefined);
    assert.equal('db' in r, false);
  });

  test('media, locks and tasks given as objects are exposed as given', () => {
    const media = fakeMedia();
    const locks = memoryLocks();
    const tasks = new MemoryTaskQueue();
    const r = new Resizer({ storage, media, locks, tasks });
    assert.equal(r.media, media);
    assert.equal(r.locks, locks);
    assert.equal(r.tasks, tasks);
  });
});

describe('a task queue the Resizer cannot use', () => {
  const png = sharp({
    create: { width: 40, height: 30, channels: 3, background: '#ff0000' },
  })
    .png()
    .toBuffer();
  // One stored preview (10x10 webp); 20x20 is missing.
  const media = () => ({
    id: 'm1',
    original: { storageRef: { key: 'o' } },
    previews: [
      {
        storageRef: { key: 'p10' },
        sizeKey: '10x10',
        format: 'webp',
        contentType: 'image/webp',
      },
    ],
  });
  const sizes = [
    { width: 10, height: 10 },
    { width: 20, height: 20 },
  ];

  /**
   * The read path serves what is stored and queues nothing, uploads and eager generate() work,
   * prewarm() reports the failure, verify() rejects with it, and it is logged once, not per call:
   * by default when the Resizer starts, or with the message `logged` says.
   */
  async function assertDegraded(
    parts: Pick<ResizerOptions, 'locks' | 'tasks'>,
    tasks: MemoryTaskQueue | PlainTaskQueue,
    failed: (e: unknown) => boolean,
    logged = /cannot use its task queue/,
  ) {
    const errors: unknown[][] = [];
    const body = await png;
    const r = new Resizer({
      config: makeImageConfig({ formats: ['webp'] }),
      logger: {
        info() {},
        warn() {},
        error: (...args: unknown[]) => {
          errors.push(args);
        },
      },
      storage: {
        download: async () => body,
        upload: async ({ key }) => ({ key }),
        publicUrl: (ref) => `https://cdn/${(ref as { key: string }).key}`,
      },
      media: fakeMedia(),
      ...parts,
    });
    await r.ready();
    // This test's media: the original's size, and its stored preview signed as the worker signs it.
    const seeded = () =>
      stampFresh(
        {
          ...media(),
          original: { storageRef: { key: 'o' }, width: 40, height: 30 },
        },
        { config: r.config },
      );
    for (let read = 0; read < 2; read += 1) {
      const { decision } = await r.resolve({ media: seeded(), sizes });
      assert.deepEqual(
        decision.ready.map((entry) => entry.url),
        ['https://cdn/p10'],
      );
      assert.deepEqual(
        decision.missing.map((variant) => variant.sizeKey),
        ['20x20'],
      );
    }
    assert.deepEqual(tasks.added, []);
    const original = await r.uploadOriginal({ body, visibility: 'private' });
    assert.equal(original.format, 'png');
    const { created } = await r.generate({
      media: seeded(),
      sizes,
      persist: false,
    });
    assert.deepEqual(
      created.map((preview) => preview.sizeKey),
      ['20x20'],
    );
    const result = await r.prewarm({ media: seeded(), sizes });
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(
      result.requested.map((variant) => variant.sizeKey),
      ['10x10', '20x20'],
    );
    assert.deepEqual(
      result.ready.map((variant) => variant.sizeKey),
      ['10x10'],
    );
    assert.deepEqual(
      result.unconfirmed.map((variant) => variant.sizeKey),
      ['20x20'],
    );
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_INTERNAL_ERROR');
    assert.equal(result.issues[0].retryable, false);
    assert.deepEqual(
      result.issues[0].previews.map((variant) => variant.sizeKey),
      ['20x20'],
    );
    assert.deepEqual(tasks.added, []);
    await assert.rejects(() => r.verify(), failed);
    await assert.rejects(() => r.verify(), failed);
    assert.equal(errors.length, 1, 'logged once');
    assert.match(String(errors[0][0]), logged);
    assert.ok(failed(errors[0][1]));
    return result;
  }

  test('invalid queue timing: reads serve stored previews, uploads and generate() work, prewarm() reports it, verify() rejects', async () => {
    const tasks = new MemoryTaskQueue({ timing: { leaseMs: 0 } });
    // Timing is a check of the queue name, not of the Resizer's start: the Dispatcher logs it once
    // per queue name, on the first read.
    const result = await assertDegraded(
      { tasks, locks: memoryLocks() },
      tasks,
      (e: unknown) =>
        e instanceof ResizeConfigError &&
        e.code === 'RESIZE_CONFIG_QUEUE_LEASE_INVALID',
      /cannot queue to 'default': its timing is invalid/,
    );
    assert.match(result.issues[0].message, /leaseMs/);
  });

  test('a task queue without gatesByTask and without locks: the same, and verify() is RESIZE_LOCKS_REQUIRED', async () => {
    const tasks = new PlainTaskQueue();
    const result = await assertDegraded(
      { tasks },
      tasks,
      (e: unknown) =>
        e instanceof ResizeSetupError &&
        e.code === 'RESIZE_LOCKS_REQUIRED' &&
        /SqsTaskQueue/.test(e.message) &&
        /FrameworkResizer/.test(e.message) &&
        /mongoParts/.test(e.message),
    );
    assert.match(result.issues[0].message, /no `locks`/);
  });

  test('a queue timing that becomes valid is used from the next call; an invalid timing is logged once per queue name', async () => {
    let timing: Record<string, unknown> = { leaseMs: 0 };
    const tasks = new MemoryTaskQueue();
    tasks.getTiming = () => timing as never;
    const errors: unknown[][] = [];
    const r = new Resizer({
      config: makeImageConfig({ formats: ['webp'] }),
      logger: {
        info() {},
        warn() {},
        error: (...args: unknown[]) => {
          errors.push(args);
        },
      },
      storage: {
        download: async () => Buffer.alloc(0),
        upload: async ({ key }) => ({ key }),
        publicUrl: (ref) => `https://cdn/${(ref as { key: string }).key}`,
      },
      media: fakeMedia(),
      locks: memoryLocks(),
      tasks,
    });
    await r.ready();
    await r.ready();
    // Building the Dispatcher reads no timing, so the first value is never read.
    assert.equal(errors.length, 0);
    // This test's media: the original's size, and its stored preview signed as the worker signs it.
    const seeded = () =>
      stampFresh(
        {
          ...media(),
          original: { storageRef: { key: 'o' }, width: 64, height: 48 },
        },
        { config: r.config },
      );
    timing = { maxAttempts: 0 };
    await r.resolve({ media: seeded(), sizes });
    await r.resolve({ media: seeded(), sizes });
    assert.equal(errors.length, 1, 'logged once per queue name');
    assert.match(
      String(errors[0][0]),
      /cannot queue to 'default': its timing is invalid/,
    );
    assert.ok(errors[0][1] instanceof ResizeConfigError);
    assert.match((errors[0][1] as Error).message, /maxAttempts/);
    assert.deepEqual(tasks.added, []);
    timing = {};
    const { decision } = await r.resolve({ media: seeded(), sizes });
    assert.deepEqual(
      decision.missing.map((variant) => variant.sizeKey),
      ['20x20'],
    );
    // Read through a call: the deepEqual(tasks.added, []) above narrowed `tasks.added` to never[].
    const added = () => tasks.added;
    assert.deepEqual(
      added().map((task) => task.previews.map((v) => v.sizeKey)),
      [['20x20']],
    );
    await r.verify();
    assert.equal(errors.length, 1);
  });
});

describe('a Resizer on a router', () => {
  const routed = (
    tasks: ResizerOptions['tasks'],
    over: Partial<ResizerOptions> = {},
  ) =>
    new Resizer({
      config: makeImageConfig({ formats: ['webp'] }),
      logger: { info() {}, warn() {}, error() {} },
      storage: fakeStorage(),
      media: fakeMedia(),
      tasks,
      ...over,
    });
  const cold = {
    id: 'm1',
    original: { storageRef: { key: 'o' } },
    previews: [],
  };
  const locksRequired = (e: unknown) =>
    e instanceof ResizeSetupError && e.code === 'RESIZE_LOCKS_REQUIRED';
  const leaseInvalid = (e: unknown) =>
    e instanceof ResizeConfigError &&
    e.code === 'RESIZE_CONFIG_QUEUE_LEASE_INVALID';

  test("a Resizer with a router builds its Dispatcher without a lock store; verify() checks the lock store only for its own queue's carrier", async () => {
    const memory = new MemoryTaskQueue();
    const plain = new PlainTaskQueue();
    const routes = { default: memory, bulk: plain };
    const own = routed(new RoutingTaskQueue(routes));
    await own.verify();
    const result = await own.prewarm({
      media: cold,
      sizes: [{ width: 10, height: 10 }],
    });
    assert.equal(result.status, 'accepted');
    assert.equal(memory.added.length, 1);
    const onPlain = routed(new RoutingTaskQueue(routes), {
      name: 'bulk',
      queueName: 'bulk',
    });
    await assert.rejects(() => onPlain.verify(), locksRequired);
  });

  test("verify() rejects with the unavailable reason of the Resizer's own queue", async () => {
    const tasks = new MemoryTaskQueue({ queues: ['default'] });
    const error = new ResizeSetupError('install @aws-sdk/client-sqs', {
      code: 'RESIZE_PEER_MISSING',
    });
    markUnavailable(tasks, ['bulk'], {
      driver: 'sqs',
      packages: ['@aws-sdk/client-sqs'],
      error,
    });
    const r = routed(tasks, { queueName: 'bulk' });
    await assert.rejects(
      () => r.verify(),
      (e: unknown) => e === error,
    );
  });

  test('verifyServicesOf builds no route and reads no timing; verifyRouteOf builds only the named one', async () => {
    const built: string[] = [];
    const timings: string[] = [];
    const builder = (name: string) => async () => {
      built.push(name);
      return new MemoryTaskQueue();
    };
    const r = routed(
      new RoutingTaskQueue(
        { default: builder('default'), bulk: builder('bulk') },
        {
          getTiming: (queue) => {
            timings.push(queue);
            return undefined;
          },
        },
      ),
    );
    await verifyServicesOf(r);
    assert.deepEqual(built, []);
    assert.deepEqual(timings, []);
    await verifyRouteOf(r, 'bulk');
    assert.deepEqual(built, ['bulk']);
    assert.deepEqual(timings, ['bulk']);
  });

  test('verify() of a router whose own name has invalid timing rejects with RESIZE_CONFIG_QUEUE_LEASE_INVALID; a call on its other name still queues', async () => {
    const bulk = new MemoryTaskQueue();
    const routers = [
      // The invalid timing is the object route's own.
      new RoutingTaskQueue({
        default: new MemoryTaskQueue({ timing: { leaseMs: 0 } }),
        bulk,
      }),
      // A builder route's timing is the router's option.
      new RoutingTaskQueue(
        { default: async () => new MemoryTaskQueue(), bulk },
        {
          getTiming: (queue) =>
            queue === 'default' ? { leaseMs: 0 } : undefined,
        },
      ),
    ];
    for (const [i, router] of routers.entries()) {
      resetResizerForTests();
      const r = routed(router);
      await assert.rejects(() => r.verify(), leaseInvalid);
      const result = await r.prewarm({
        media: cold,
        sizes: [{ width: 10, height: 10 }],
        queue: 'bulk',
      });
      assert.equal(result.status, 'accepted');
      assert.equal(bulk.added.length, i + 1);
    }
  });

  test('a supplied lock store is verified in the shared step, with no task queue and with a plain one, but not with a router', async () => {
    const cases: [string, ResizerOptions['tasks'], boolean][] = [
      ['no task queue', undefined, true],
      ['a plain task queue', new PlainTaskQueue(), true],
      [
        'a router',
        new RoutingTaskQueue({ default: new MemoryTaskQueue() }),
        false,
      ],
    ];
    for (const [label, tasks, verified] of cases) {
      resetResizerForTests();
      let checks = 0;
      const base = memoryLocks();
      const locks: LockStore = {
        acquire: base.acquire,
        extend: base.extend,
        release: base.release,
        verify: async () => {
          checks += 1;
          throw new Error('lock model missing');
        },
      };
      const r = routed(tasks, { locks });
      if (verified) {
        await assert.rejects(() => r.verify(), /lock model missing/, label);
      } else {
        await r.verify();
      }
      assert.equal(checks, verified ? 1 : 0, label);
    }
  });
});

describe('coordination', () => {
  const silent = { info() {}, warn() {}, error() {} };
  const media = () => ({
    id: 'm1',
    original: { storageRef: { key: 'o' } },
    previews: [],
  });
  const sizes = [{ width: 20, height: 20 }];
  const invalidCooldown = (e: unknown) =>
    e instanceof ResizeConfigError &&
    e.code === 'RESIZE_CONFIG_COORDINATION_INVALID' &&
    /cooldownMs/.test(e.message);

  test('a bad coordination degrades like a bad queue: ready() resolves, verify() rejects, resolve() queues nothing, prewarm() reports it', async () => {
    const errors: unknown[][] = [];
    const tasks = new MemoryTaskQueue();
    const r = new Resizer({
      config: makeImageConfig({ formats: ['webp'] }),
      logger: {
        info() {},
        warn() {},
        error: (...args: unknown[]) => {
          errors.push(args);
        },
      },
      storage: fakeStorage(),
      media: fakeMedia(),
      locks: memoryLocks(),
      tasks,
      coordination: { cooldownMs: 0 },
    });
    await r.ready();
    await assert.rejects(() => r.verify(), invalidCooldown);
    const { decision } = await r.resolve({ media: media(), sizes });
    assert.deepEqual(
      decision.missing.map((variant) => variant.sizeKey),
      ['20x20'],
    );
    assert.equal(tasks.added.length, 0);
    const result = await r.prewarm({ media: media(), sizes });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_INTERNAL_ERROR');
    assert.equal(result.issues[0].retryable, false);
    assert.match(result.issues[0].message, /cooldownMs/);
    assert.equal(tasks.added.length, 0);
    assert.equal(errors.length, 1, 'logged once');
    assert.match(String(errors[0][0]), /cannot use its task queue/);
    assert.ok(invalidCooldown(errors[0][1]));
  });

  test("a gateTtlMs below the task queue's lease is fine (a database queue with a long lease needs no coordination)", async () => {
    const r = new Resizer({
      logger: silent,
      storage: fakeStorage(),
      media: fakeMedia(),
      locks: memoryLocks(),
      tasks: new MemoryTaskQueue({ timing: { leaseMs: 1_200_000 } }),
      coordination: { gateTtlMs: 60_000 },
    });
    await r.verify();
    assert.equal(taskCoordinationOf(r).gateTtlMs, 60_000);
  });

  test('coordination given as a function is read once, when the task queue is set up; an eager-only Resizer never reads it', async () => {
    let reads = 0;
    const r = new Resizer({
      logger: silent,
      storage: fakeStorage(),
      media: fakeMedia(),
      locks: memoryLocks(),
      tasks: new MemoryTaskQueue(),
      coordination: () => {
        reads += 1;
        return { cooldownMs: 30_000 };
      },
    });
    assert.equal(reads, 0);
    await r.ready();
    assert.equal(reads, 1);
    await r.resolve({ media: media(), sizes });
    await r.prewarm({ media: media(), sizes });
    await r.verify();
    await r.ready();
    assert.equal(reads, 1);
    assert.equal(taskCoordinationOf(r).cooldownMs, 30_000);

    // Invalid, but never read: an eager-only Resizer has no task queue to coordinate.
    let eagerReads = 0;
    const eager = new Resizer({
      name: 'eager',
      logger: silent,
      storage: fakeStorage(),
      media: fakeMedia(),
      coordination: () => {
        eagerReads += 1;
        return { cooldownMs: 0 };
      },
    });
    await eager.ready();
    await eager.resolve({ media: media(), sizes });
    await eager.prewarm({ media: media(), sizes });
    await eager.verify();
    assert.equal(eagerReads, 0);
  });

  test('taskCoordinationOf gives the cooldown, the gate TTL and the lock store, or the defaults without a task queue', async () => {
    const locks = memoryLocks();
    const r = new Resizer({
      logger: silent,
      storage: fakeStorage(),
      media: fakeMedia(),
      locks,
      tasks: new MemoryTaskQueue(),
      coordination: { cooldownMs: 30_000, gateTtlMs: 90_000 },
    });
    assert.throws(
      () => taskCoordinationOf(r),
      (e: unknown) =>
        e instanceof ResizeSetupError && e.code === 'RESIZE_NOT_READY',
    );
    await r.ready();
    const own = taskCoordinationOf(r);
    assert.equal(own.cooldownMs, 30_000);
    assert.equal(own.gateTtlMs, 90_000);
    assert.equal(own.locks, locks);

    const eager = new Resizer({
      name: 'eager',
      logger: silent,
      storage: fakeStorage(),
      media: fakeMedia(),
      coordination: { cooldownMs: 30_000 },
    });
    await eager.ready();
    assert.deepEqual(taskCoordinationOf(eager), {
      cooldownMs: defaultCoordination.cooldownMs,
      gateTtlMs: defaultCoordination.gateTtlMs,
      locks: undefined,
    });

    // A task queue the Resizer cannot use: the defaults, and its lock store.
    const broken = new Resizer({
      name: 'broken',
      logger: silent,
      storage: fakeStorage(),
      media: fakeMedia(),
      locks,
      tasks: new MemoryTaskQueue(),
      coordination: { cooldownMs: 0 },
    });
    await broken.ready();
    const fallback = taskCoordinationOf(broken);
    assert.equal(fallback.cooldownMs, defaultCoordination.cooldownMs);
    assert.equal(fallback.gateTtlMs, defaultCoordination.gateTtlMs);
    assert.equal(fallback.locks, locks);
  });
});

describe('queueName', () => {
  const silent = { info() {}, warn() {}, error() {} };
  const queued = (opts: Partial<ResizerOptions> = {}) =>
    new Resizer({
      config: makeImageConfig({ formats: ['webp'] }),
      logger: silent,
      storage: fakeStorage(),
      media: fakeMedia(),
      tasks: new MemoryTaskQueue(),
      ...opts,
    });
  const cold = {
    id: 'm1',
    original: { storageRef: { key: 'o' } },
    previews: [],
  };
  const sizes = [{ width: 10, height: 10 }];

  test('queueName defaults to default and names the queue of every task', async () => {
    const own = new MemoryTaskQueue();
    const plain = queued({ tasks: own });
    assert.equal(plain.queueName, 'default');
    await plain.resolve({ media: cold, sizes });
    assert.equal(own.added[0].queue, 'default');
    const bulkTasks = new MemoryTaskQueue();
    const bulk = queued({ name: 'b', queueName: 'bulk', tasks: bulkTasks });
    await bulk.resolve({ media: cold, sizes });
    await bulk.prewarm({ media: { ...cold, id: 'm2' }, sizes });
    assert.deepEqual(
      bulkTasks.added.map((task) => task.queue),
      ['bulk', 'bulk'],
    );
  });

  test('a string queueName is readable at once; a function is read on first use', async () => {
    assert.equal(queued({ queueName: 'bulk' }).queueName, 'bulk');
    let calls = 0;
    const tasks = new MemoryTaskQueue();
    const lazy = queued({
      name: 'lazy',
      tasks,
      queueName: () => {
        calls += 1;
        return 'bulk';
      },
    });
    assert.throws(
      () => lazy.queueName,
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_NOT_READY' &&
        /queueName/.test(err.message),
    );
    assert.equal(calls, 0);
    await lazy.ready();
    assert.equal(lazy.queueName, 'bulk');
    await lazy.resolve({ media: cold, sizes });
    await lazy.ready();
    assert.equal(calls, 1);
    assert.equal(tasks.added[0].queue, 'bulk');
  });

  test('the old queue option is RESIZE_QUEUE_INVALID naming queueName', () => {
    for (const make of [
      () => queued({ queue: 'bulk' } as never),
      () => new FrameworkResizer({ ...baseOpts(), queue: 'bulk' } as never),
    ]) {
      assert.throws(
        make,
        (err: unknown) =>
          err instanceof ResizeSetupError &&
          err.code === 'RESIZE_QUEUE_INVALID' &&
          /`queue` is now `queueName`/.test(err.message),
      );
    }
    // A rejected construction never claims the name.
    assert.equal(queued().queueName, 'default');
  });

  test('an empty queueName is RESIZE_QUEUE_INVALID', async () => {
    for (const queueName of ['', '  ', 42]) {
      assert.throws(
        () => queued({ queueName } as never),
        (err: unknown) =>
          err instanceof ResizeSetupError &&
          err.code === 'RESIZE_QUEUE_INVALID' &&
          /`queueName` must be a non-empty string/.test(err.message),
      );
    }
    assert.throws(
      () => new FrameworkResizer({ ...baseOpts(), queueName: '' }),
      (err: unknown) =>
        err instanceof ResizeSetupError && err.code === 'RESIZE_QUEUE_INVALID',
    );
    // A function's result is checked on first use: ready() rejects, and the next call asks again.
    let name = '';
    const lazy = queued({ name: 'lazy', queueName: () => name });
    for (const call of [() => lazy.ready(), () => lazy.verify()]) {
      await assert.rejects(
        call,
        (err: unknown) =>
          err instanceof ResizeSetupError &&
          err.code === 'RESIZE_QUEUE_INVALID' &&
          /`queueName` must be a non-empty string/.test(err.message),
      );
    }
    name = 'bulk';
    await lazy.ready();
    assert.equal(lazy.queueName, 'bulk');
  });
});

describe('Resizer registry', () => {
  test('a second Resizer with the same name throws a clear error', () => {
    new FrameworkResizer(baseOpts());
    assert.throws(
      () => new FrameworkResizer(baseOpts()),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_DUPLICATE_RESIZER' &&
        err.message.includes("'default'"),
    );
  });

  test('Resizers with different names coexist and are found by name', () => {
    const media = new FrameworkResizer(baseOpts());
    const listings = new FrameworkResizer({
      ...baseOpts(),
      name: 'listings',
    });
    assert.equal(getResizer(), media);
    assert.equal(getResizer('default'), media);
    assert.equal(getResizer('listings'), listings);
    assert.equal(media.name, 'default');
    assert.equal(listings.name, 'listings');
  });

  test('each Resizer keeps its own config', () => {
    const a = new FrameworkResizer({
      ...baseOpts(),
      config: makeResizeConfig({ formats: ['webp'] }),
    });
    const b = new FrameworkResizer({
      ...baseOpts(),
      name: 'b',
      config: makeResizeConfig({ formats: ['jpeg'] }),
    });
    assert.deepEqual(a.config.formats, ['webp']);
    assert.deepEqual(b.config.formats, ['jpeg']);
  });

  test('getResizer() names the missing Resizer', () => {
    new FrameworkResizer({ ...baseOpts(), name: 'listings' });
    assert.throws(
      () => getResizer(),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_NO_RESIZER' &&
        err.message.includes("'default'"),
    );
  });

  test('an invalid config throws at construction and does not claim the name', () => {
    assert.throws(
      () =>
        new FrameworkResizer({
          ...baseOpts(),
          config: { mediaModelName: 'File', maxSize: 'big' } as never,
        }),
      (err: unknown) => err instanceof ResizeConfigError,
    );
    assert.doesNotThrow(() => new FrameworkResizer(baseOpts()));
  });

  test('a named Resizer may have a task queue', () => {
    const tasks = new MemoryTaskQueue();
    const listings = new FrameworkResizer({
      ...baseOpts(),
      name: 'listings',
      tasks,
    });
    assert.equal(listings.tasks, tasks);
  });

  test('listResizers() returns every registered Resizer in construction order', () => {
    const a = new FrameworkResizer(baseOpts());
    const b = new FrameworkResizer({ ...baseOpts(), name: 'b' });
    assert.deepEqual(listResizers(), [a, b]);
    resetResizerForTests();
    assert.deepEqual(listResizers(), []);
  });

  test('an empty name is rejected', () => {
    assert.throws(
      () => new FrameworkResizer({ ...baseOpts(), name: '' }),
      (err: unknown) =>
        err instanceof ResizeSetupError && err.code === 'RESIZE_NAME_INVALID',
    );
  });

  test('explicit config, logger and drivers need no framework app', () => {
    resetAppInstance();
    const media = fakeMedia();
    const r = new Resizer({
      storage: fakeStorage(),
      media,
      config: makeImageConfig(),
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(r.name, 'default');
    assert.equal(r.media, media);
    assert.equal(getResizer(), r);
  });

  test('a core Resizer requires a media store but not a task queue; config defaults', () => {
    resetAppInstance();
    const core = { storage: fakeStorage(), media: fakeMedia() };
    const rejects = (opts: unknown, code: string) =>
      assert.throws(
        () => new Resizer(opts as never),
        (err: unknown) => err instanceof ResizeSetupError && err.code === code,
      );
    rejects({ storage: core.storage }, 'RESIZE_MEDIA_REQUIRED');
    // None of the rejected constructions claimed the name; config defaults to the package's.
    const r = new Resizer(core);
    assert.equal(r.logger, console);
    assert.equal(r.tasks, undefined);
    assert.deepEqual(r.config.formats, ['jpeg', 'webp', 'avif']);
  });

  test('resetResizerForTests() forgets every Resizer', () => {
    const first = new FrameworkResizer(baseOpts());
    new FrameworkResizer({ ...baseOpts(), name: 'listings' });
    resetResizerForTests();
    const second = new FrameworkResizer(baseOpts());
    assert.notEqual(first, second);
    assert.equal(getResizer(), second);
    assert.throws(() => getResizer('listings'), /no Resizer named 'listings'/);
  });

  test('resetResizerForTests() forgets the shared parts', async () => {
    let builds = 0;
    const build = async () => {
      builds += 1;
      return builds;
    };
    assert.equal(await sharedPart('k', build), 1);
    assert.equal(await sharedPart('k', build), 1);
    resetResizerForTests();
    assert.equal(await sharedPart('k', build), 2);
  });
});

// ---------------------------------------------------------------------------
// Typed taps (04 · §9) — HookSignatures infers each tap; runtime behavior unchanged.
// (Type-level enforcement is compile-only; test files are excluded from tsc, so these
//  assert the RUNTIME contract with correctly-typed signatures.)
// ---------------------------------------------------------------------------

describe('typed hooks', () => {
  test('a correctly-typed constructor hook + late .hook() both run through the bus', async () => {
    installFakeApp();
    const injected: SizeInput = { width: 10, height: 10 };
    const r = new FrameworkResizer({
      ...baseOpts(),
      hooks: {
        resolveSizes: (sizes: SizeInput[]) => [...sizes, injected],
      },
    });
    // A second, late tap over the SAME name — typed (missing: MissingPreview[]).
    let seenMissing: MissingPreview[] | undefined;
    r.hook('beforeEnqueue', (missing: MissingPreview[]) => {
      seenMissing = missing;
      return missing;
    });
    const { decision } = await r.resolve({
      media: { id: 'm1', previews: [] },
      sizes: [],
      formats: ['webp'],
    });
    const expected: MissingPreview[] = [
      {
        sizeKey: '10x10',
        format: 'webp',
        requestedWidth: 10,
        requestedHeight: 10,
      },
    ];
    assert.deepEqual(seenMissing, expected);
    assert.deepEqual(decision.missing, expected);
  });
});

// ---------------------------------------------------------------------------
// Read/eager stubs — resolve landed in build step 5; generate lands in step 8
// ---------------------------------------------------------------------------

describe('resolve/generate stubs', () => {
  test('resolve delegates to the Reader (no longer a stub)', async () => {
    installFakeApp();
    const r = new FrameworkResizer(baseOpts());
    const { decision, output } = await r.resolve({
      media: {},
      sizes: [],
      formats: ['jpeg'],
    });
    assert.deepEqual(decision, { ready: [], missing: [] });
    assert.equal(output, undefined);
  });

  test('generate is wired (no longer a stub): empty sizes → empty created', async () => {
    // A config WITH mediaModelName so the Resizer's config validation does not throw.
    resetAppInstance();
    setAppInstance({
      getConfig: () => makeResizeConfig(),
      getModel: () => ({}),
      logger: { info() {}, warn() {}, error() {} },
    } as never);
    const r = new FrameworkResizer(baseOpts());
    const result = await r.generate({
      media: {
        id: 'm1',
        original: { storageRef: { key: 'o' }, contentType: 'image/jpeg' },
      },
      sizes: [],
    });
    assert.deepEqual(result.created, []);
    assert.equal(result.failed, 0);
  });
});

describe('metrics', () => {
  test('metrics: the default is a LogMetrics on the Resizer logger; the option wins; resizer.metrics is that sink', async () => {
    const info: unknown[] = [];
    const logger = {
      info: (msg: unknown) => {
        info.push(msg);
      },
      warn() {},
      error() {},
    };
    const byDefault = new Resizer({
      name: 'm1',
      storage: fakeStorage(),
      media: fakeMedia(),
      logger,
    });
    assert.ok(byDefault.metrics instanceof LogMetrics);
    byDefault.metrics.timing('resize.task', 5, { outcome: 'completed' });
    assert.equal(info.length, 1);
    assert.match(
      String(info[0]),
      /^resize: task \? of media \? completed in 5 ms/,
    );

    const sink = recordingMetrics();
    const given = new Resizer({
      name: 'm2',
      storage: fakeStorage(),
      media: fakeMedia(),
      metrics: sink,
      pipelines: { thumbs: {} },
    });
    assert.equal(given.metrics, sink);
    // The bound sink labels every call with the Resizer and its registered pipelines.
    const bound = metricsOf(given);
    bound.count('resize.read', 1, { pipeline: 'thumbs' });
    bound.count('resize.read', 1, { pipeline: 'retired' });
    assert.deepEqual(
      sink.calls.map((call) => [call.labels, call.context]),
      [
        [{ resizer: 'm2', pipeline: 'thumbs' }, {}],
        [{ resizer: 'm2', pipeline: 'unregistered' }, { pipeline: 'retired' }],
      ],
    );
    await bound.flush();
    assert.equal(sink.flushes, 1);
  });

  test('a metrics option without count and timing is RESIZE_METRICS_INVALID, and the name stays free', () => {
    for (const metrics of [{}, { count() {} }, null]) {
      assert.throws(
        () =>
          new Resizer({
            name: 'metered',
            storage: fakeStorage(),
            media: fakeMedia(),
            metrics: metrics as never,
          }),
        (e: unknown) =>
          e instanceof ResizeSetupError &&
          e.code === 'RESIZE_METRICS_INVALID' &&
          e.retryable === false &&
          e.message ===
            'resize: `metrics` must have count() and timing() functions — e.g. new LogMetrics(logger) or new NoopMetrics()',
      );
    }
    const r = new Resizer({
      name: 'metered',
      storage: fakeStorage(),
      media: fakeMedia(),
      metrics: new NoopMetrics(),
    });
    assert.equal(getResizer('metered'), r);
  });

  test('with the default metrics, 50 warm reads write no info line until the summary', async (t) => {
    // Restored by the test context when the test ends.
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const info: unknown[] = [];
    const logger = {
      info: (msg: unknown) => {
        info.push(msg);
      },
      warn() {},
      error() {},
    };
    const r = new Resizer({
      storage: Object.assign({}, fakeStorage(), {
        publicUrl: () => 'https://cdn/p',
      }),
      media: fakeMedia(),
      logger,
    });
    await r.ready();
    const media = stampFresh(
      {
        id: 'm1',
        original: { storageRef: { key: 'o' }, width: 64, height: 48 },
        previews: [
          {
            storageRef: { key: 'p' },
            contentType: 'image/webp',
            sizeKey: '10x10',
            format: 'webp',
          },
        ],
      },
      { config: r.config },
    );
    for (let i = 0; i < 50; i++) {
      const { decision } = await r.resolve({
        media,
        sizes: [{ width: 10, height: 10 }],
        formats: ['webp'],
      });
      assert.equal(decision.ready.length, 1);
    }
    assert.equal(info.length, 0);
    t.mock.timers.tick(60_000);
    assert.deepEqual(info, [
      "resize: Resizer 'default' over 60 s: reads 50 (ready 50)",
    ]);
  });

  test('resolve() on a Resizer that cannot start counts one failed read', async () => {
    const sink = recordingMetrics();
    const r = new Resizer({
      storage: async () => {
        throw new Error('storage down');
      },
      media: fakeMedia(),
      metrics: sink,
      logger: { info() {}, warn() {}, error() {} },
      pipelines: { thumbs: {} },
    });
    const sizes = [{ width: 10, height: 10 }];
    const { decision } = await r.resolve({
      media: { id: 'm1' },
      sizes,
      pipeline: 'thumbs',
    });
    assert.deepEqual(decision, { ready: [], missing: [] });
    await r.resolve({ media: { id: 'm1' }, sizes, pipeline: 'retired' });
    await r.resolve(undefined as never);
    assert.deepEqual(
      sink.calls.map((call) => [call.name, call.labels, call.context]),
      [
        [
          'resize.read',
          { resizer: 'default', pipeline: 'thumbs', outcome: 'failed' },
          { ready: 0, missing: 0, stale: 0 },
        ],
        [
          'resize.read',
          { resizer: 'default', pipeline: 'unregistered', outcome: 'failed' },
          { ready: 0, missing: 0, stale: 0, pipeline: 'retired' },
        ],
        [
          'resize.read',
          { resizer: 'default', pipeline: 'default', outcome: 'failed' },
          { ready: 0, missing: 0, stale: 0 },
        ],
      ],
    );
  });
});
