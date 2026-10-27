import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import sharp from 'sharp';
import { defaultCoordination } from './config/resize.ts';
import type { MediaStore } from './contracts/media.ts';
import type { Pipeline } from './contracts/pipeline.ts';
import type { ResizeStorage } from './contracts/storage.ts';
import { ResizeConfigError, ResizeSetupError } from './errors.ts';
import { FrameworkLockStore } from './framework/locks.ts';
import { FrameworkMediaStore } from './framework/media.ts';
import { FrameworkResizer } from './framework/resizer.ts';
import {
  getResizer,
  listResizers,
  onResetResizerForTests,
  Resizer,
  type ResizerOptions,
  resetResizerForTests,
  taskCoordinationOf,
} from './resizer.ts';
import {
  fakeMedia,
  MemoryTaskQueue,
  memoryLocks,
} from './testHelpers/fakes.ts';
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
  test('FrameworkResizer fills the media and lock stores', () => {
    const eager = new FrameworkResizer(baseOpts());
    assert.ok(eager.media instanceof FrameworkMediaStore);
    assert.ok(eager.locks instanceof FrameworkLockStore);
    resetResizerForTests();
    const tasks = new MemoryTaskQueue();
    const queued = new FrameworkResizer({ ...baseOpts(), tasks });
    assert.ok(queued.media instanceof FrameworkMediaStore);
    assert.ok(queued.locks instanceof FrameworkLockStore);
    assert.equal(queued.tasks, tasks);
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

  test('a lazy locks part that resolves to nothing beside a task queue: ready() resolves, verify() is RESIZE_LOCKS_REQUIRED', async () => {
    const r = new Resizer({
      logger: silent,
      storage,
      media: fakeMedia(),
      locks: () => undefined,
      tasks: new MemoryTaskQueue(),
    });
    await r.ready();
    assert.equal(r.locks, undefined);
    await assert.rejects(() => r.verify(), locksRequired);
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
   * prewarm() reports the failure, verify() rejects with it, and it is logged once, not per call.
   */
  async function assertDegraded(
    parts: Pick<ResizerOptions, 'locks' | 'tasks'>,
    tasks: MemoryTaskQueue,
    failed: (e: unknown) => boolean,
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
    for (let read = 0; read < 2; read += 1) {
      const { decision } = await r.resolve({ media: media(), sizes });
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
      media: media(),
      sizes,
      persist: false,
    });
    assert.deepEqual(
      created.map((preview) => preview.sizeKey),
      ['20x20'],
    );
    const result = await r.prewarm({ media: media(), sizes });
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
    assert.equal(errors.length, 1, 'logged once, when the Resizer started');
    assert.match(String(errors[0][0]), /cannot use its task queue/);
    assert.ok(failed(errors[0][1]));
    return result;
  }

  test('invalid queue timing: reads serve stored previews, uploads and generate() work, prewarm() reports it, verify() rejects', async () => {
    const tasks = new MemoryTaskQueue({ timing: { leaseMs: 0 } });
    const result = await assertDegraded(
      { tasks, locks: memoryLocks() },
      tasks,
      (e: unknown) =>
        e instanceof ResizeConfigError &&
        e.code === 'RESIZE_CONFIG_QUEUE_LEASE_INVALID',
    );
    assert.match(result.issues[0].message, /leaseMs/);
  });

  test('a task queue without locks: the same, and verify() is RESIZE_LOCKS_REQUIRED', async () => {
    const tasks = new MemoryTaskQueue();
    const result = await assertDegraded(
      { tasks },
      tasks,
      (e: unknown) =>
        e instanceof ResizeSetupError &&
        e.code === 'RESIZE_LOCKS_REQUIRED' &&
        /FrameworkResizer/.test(e.message) &&
        /mongoParts/.test(e.message),
    );
    assert.match(result.issues[0].message, /no `locks`/);
  });

  test('a queue timing that becomes valid is used from the next call, and the failure is logged again only when it changes', async () => {
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
    assert.equal(errors.length, 1);
    timing = { maxAttempts: 0 };
    await r.resolve({ media: media(), sizes });
    await r.resolve({ media: media(), sizes });
    assert.equal(errors.length, 2, 'a different failure is logged once more');
    assert.deepEqual(tasks.added, []);
    timing = {};
    const { decision } = await r.resolve({ media: media(), sizes });
    assert.deepEqual(
      decision.missing.map((variant) => variant.sizeKey),
      ['20x20'],
    );
    assert.deepEqual(
      tasks.added.map((task) => task.previews.map((v) => v.sizeKey)),
      [['20x20']],
    );
    await r.verify();
    assert.equal(errors.length, 2);
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

  test("the gate is checked against the lease of the Resizer's own task queue", async () => {
    const r = new Resizer({
      logger: silent,
      storage: fakeStorage(),
      media: fakeMedia(),
      locks: memoryLocks(),
      tasks: new MemoryTaskQueue({ timing: { leaseMs: 120_000 } }),
      coordination: { gateTtlMs: 60_000 },
    });
    await r.ready();
    await assert.rejects(
      () => r.verify(),
      (e: unknown) =>
        e instanceof ResizeConfigError &&
        e.code === 'RESIZE_CONFIG_GATE_TTL_BELOW_LEASE',
    );
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

  test('taskCoordinationOf gives the cooldown and the lock store, or the defaults without a task queue', async () => {
    const locks = memoryLocks();
    const r = new Resizer({
      logger: silent,
      storage: fakeStorage(),
      media: fakeMedia(),
      locks,
      tasks: new MemoryTaskQueue(),
      coordination: { cooldownMs: 30_000 },
    });
    assert.throws(
      () => taskCoordinationOf(r),
      (e: unknown) =>
        e instanceof ResizeSetupError && e.code === 'RESIZE_NOT_READY',
    );
    await r.ready();
    const own = taskCoordinationOf(r);
    assert.equal(own.cooldownMs, 30_000);
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
    assert.equal(fallback.locks, locks);
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
          config: { mediaModelName: 'File' } as never,
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

  test('queue defaults to "default" and can be set per Resizer', () => {
    const media = new FrameworkResizer(baseOpts());
    const bulk = new FrameworkResizer({
      ...baseOpts(),
      name: 'bulk',
      queue: 'bulk',
    });
    assert.equal(media.queue, 'default');
    assert.equal(bulk.queue, 'bulk');
  });

  test('an empty queue name is rejected', () => {
    assert.throws(
      () => new FrameworkResizer({ ...baseOpts(), queue: '' }),
      (err: unknown) =>
        err instanceof ResizeSetupError && err.code === 'RESIZE_QUEUE_INVALID',
    );
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

  test('resetResizerForTests() runs every onResetResizerForTests hook', () => {
    // A hook cannot be removed, so it counts only while this test runs: every later reset (each
    // afterEach) leaves it a no-op.
    let active = true;
    let resets = 0;
    onResetResizerForTests(() => {
      if (active) {
        resets += 1;
      }
    });
    try {
      resetResizerForTests();
    } finally {
      active = false;
    }
    assert.equal(resets, 1);
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
