import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import { ResizeConfigError, ResizeSetupError } from './errors.ts';
import { FrameworkDatabase } from './framework/database.ts';
import { FrameworkResizer } from './framework/resizer.ts';
import {
  getResizer,
  listResizers,
  type Pipeline,
  Resizer,
  type ResizeStorage,
  resetResizerForTests,
} from './resizer.ts';
import { fakeDb, MemoryTaskQueue } from './testHelpers/fakes.ts';
import {
  makeImageConfig,
  makeResizeConfig,
} from './testHelpers/resizeConfig.ts';
import type { MissingPreview, SizeInput } from './types.d.ts';

// ---------------------------------------------------------------------------
// Fakes. The Resizer stores passed driver references verbatim (identity checks);
// FrameworkResizer fills omitted parts with framework-driver instances (instanceof
// checks) and takes the logger/events from the recording fake app installed here.
// ---------------------------------------------------------------------------

const fakeStorage = (): ResizeStorage => ({
  download: async () => Buffer.alloc(0),
  upload: async () => ({ key: 'k' }),
  publicUrl: () => '',
});

// A recording fake app: logger.error pushes to `errors`; events.emit (when present)
// pushes to `emitted` (or throws when emitThrows). The Resizer reads the app when it is
// constructed, so install this before constructing the Resizer.
function installFakeApp(
  opts: { withEvents?: boolean; emitThrows?: boolean } = {},
): { errors: unknown[][]; emitted: unknown[][] } {
  resetAppInstance();
  const errors: unknown[][] = [];
  const emitted: unknown[][] = [];
  const events = opts.withEvents
    ? {
        emit(name: string, ...args: unknown[]) {
          if (opts.emitThrows) {
            throw new Error('emit boom');
          }
          emitted.push([name, ...args]);
        },
      }
    : undefined;
  setAppInstance({
    getConfig: () => makeResizeConfig(),
    getModel: () => ({}),
    logger: {
      info() {},
      warn() {},
      error(...args: unknown[]) {
        errors.push(args);
      },
    },
    events,
  } as never);
  return { errors, emitted };
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
  test('FrameworkResizer fills the database; locks stay on the database', () => {
    const eager = new FrameworkResizer(baseOpts());
    assert.ok(eager.db instanceof FrameworkDatabase);
    resetResizerForTests();
    const tasks = new MemoryTaskQueue();
    const queued = new FrameworkResizer({ ...baseOpts(), tasks });
    assert.ok(queued.db instanceof FrameworkDatabase);
    assert.equal(queued.tasks, tasks);
    // the passed queue is used, not the database's own
    assert.notEqual(queued.tasks, queued.db.tasks);
  });

  test('keeps passed drivers (no defaulting when provided)', () => {
    const storage = fakeStorage();
    const tasks = new MemoryTaskQueue();
    const db = fakeDb();
    const r = new FrameworkResizer({
      storage,
      tasks,
      db,
    });
    assert.equal(r.storage, storage);
    assert.equal(r.tasks, tasks);
    assert.equal(r.db, db);
  });

  test('task queue is undefined when the config has no queue (eager-only host)', async () => {
    const r = new FrameworkResizer(baseOpts());
    await r.ready();
    assert.equal(r.tasks, undefined);
    assert.equal(
      new Resizer({ ...baseOpts(), name: 'core', db: fakeDb() }).tasks,
      undefined,
    );
  });

  test('throws a named error when storage is missing (JS host / half-filled wiring)', () => {
    // A JS host could omit the required `storage` — fail loudly at construction with a NAMED
    // error, not a downstream TypeError (02 · §6 review fix).
    assert.throws(
      () => new Resizer({ db: fakeDb() } as never),
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
          db: fakeDb(),
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

  test('the default database loads from the Resizer’s own media model', async () => {
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
    await photos.db.loadMedia('m1');
    await files.db.loadMedia('m2');
    assert.deepEqual(asked, ['Photo', 'File']);
  });

  test('seeds pipelines from options', () => {
    const photo: Pipeline = { beforeSteps: [] };
    const r = new FrameworkResizer({ ...baseOpts(), pipelines: { photo } });
    assert.equal(r.getPipeline('photo'), photo);
  });

  test('seeds hooks from options — single fn form threads through runWaterfall', async () => {
    installFakeApp();
    const r = new FrameworkResizer({
      ...baseOpts(),
      hooks: { resolveSizes: (v: number) => v + 1 },
    });
    assert.equal(await r.runWaterfall('resolveSizes', 1, {}), 2);
  });

  test('seeds hooks from options — array form runs every tap in order', async () => {
    installFakeApp();
    const r = new FrameworkResizer({
      ...baseOpts(),
      hooks: {
        resolveSizes: [(v: number) => v + 1, async (v: number) => v * 2],
      },
    });
    assert.equal(await r.runWaterfall('resolveSizes', 1, {}), 4); // (1+1)*2
  });
});

// ---------------------------------------------------------------------------
// Named registry: several Resizers per process, one per name
// ---------------------------------------------------------------------------

describe('drivers given as functions', () => {
  const silent = { info() {}, warn() {}, error() {} };

  test('are called once, on first use, sync or async — even under concurrent calls', async () => {
    const storage = fakeStorage();
    const db = fakeDb();
    const tasks = new MemoryTaskQueue();
    const calls: string[] = [];
    const r = new Resizer({
      logger: silent,
      storage: () => {
        calls.push('storage');
        return storage;
      },
      db: async () => {
        calls.push('db');
        return db;
      },
      tasks: async () => {
        calls.push('tasks');
        return tasks;
      },
    });
    assert.deepEqual(calls, []);
    for (const part of ['storage', 'db', 'tasks'] as const) {
      assert.throws(
        () => r[part],
        (err: unknown) =>
          err instanceof ResizeSetupError &&
          err.code === 'RESIZE_NOT_READY' &&
          err.message.includes(part),
      );
    }
    await Promise.all([r.ready(), r.ready(), r.verify()]);
    assert.deepEqual(calls.sort(), ['db', 'storage', 'tasks']);
    assert.equal(r.storage, storage);
    assert.equal(r.db, db);
    assert.equal(r.tasks, tasks);
    await r.ready();
    assert.equal(calls.length, 3);
  });

  test('a part given as an object is usable while another is still loading', () => {
    const db = fakeDb();
    const r = new Resizer({
      logger: silent,
      storage: async () => fakeStorage(),
      db,
    });
    assert.equal(r.db, db);
    assert.equal(r.tasks, undefined); // not given: eager only, nothing to wait for
    assert.throws(() => r.storage, /has not loaded `storage`/);
  });

  test('a failed load rejects, and the next call tries again', async () => {
    let attempts = 0;
    const storage = fakeStorage();
    const r = new Resizer({
      logger: silent,
      db: fakeDb(),
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
    let dbCalls = 0;
    const storage = fakeStorage();
    const db = fakeDb();
    const r = new Resizer({
      logger: silent,
      storage: async () => {
        storageCalls += 1;
        return storage;
      },
      db: async () => {
        dbCalls += 1;
        if (dbCalls === 1) {
          throw new Error('db not up');
        }
        return db;
      },
    });
    await assert.rejects(() => r.ready(), /db not up/);
    // Concurrent calls after the failure share one retry of the failed part.
    await Promise.all([r.ready(), r.ready()]);
    await r.ready();
    assert.equal(storageCalls, 1);
    assert.equal(dbCalls, 2);
    assert.equal(r.storage, storage);
    assert.equal(r.db, db);
  });

  test('a failed lazy task queue stays not ready until it loads', async () => {
    let taskCalls = 0;
    const tasks = new MemoryTaskQueue();
    const r = new Resizer({
      logger: silent,
      storage: fakeStorage(),
      db: fakeDb(),
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
      db: fakeDb(),
    });
    await assert.rejects(
      () => noStorage.ready(),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_STORAGE_REQUIRED',
    );
    const noDb = new Resizer({
      name: 'b',
      logger: silent,
      storage: fakeStorage(),
      db: async () => null as never,
    });
    await assert.rejects(
      () => noDb.ready(),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_DATABASE_REQUIRED',
    );
  });

  test('resolve() and prewarm() never throw when loading fails; generate() rejects', async () => {
    const errors: unknown[][] = [];
    const r = new Resizer({
      logger: { ...silent, error: (...args: unknown[]) => errors.push(args) },
      db: fakeDb(),
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
    const db = fakeDb();
    const r = new Resizer({
      storage: fakeStorage(),
      db,
      config: makeImageConfig(),
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(r.name, 'default');
    assert.equal(r.db, db);
    assert.equal(getResizer(), r);
  });

  test('a core Resizer requires a database but not a task queue; config defaults', () => {
    resetAppInstance();
    const core = { storage: fakeStorage(), db: fakeDb() };
    const rejects = (opts: unknown, code: string) =>
      assert.throws(
        () => new Resizer(opts as never),
        (err: unknown) => err instanceof ResizeSetupError && err.code === code,
      );
    rejects({ ...core, db: undefined }, 'RESIZE_DATABASE_REQUIRED');
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
});

// ---------------------------------------------------------------------------
// Named pipelines (04 · §8) — ported from registry.test.ts
// ---------------------------------------------------------------------------

describe('named pipelines', () => {
  test('a registered pipeline is retrievable', () => {
    const r = new FrameworkResizer(baseOpts());
    const p: Pipeline = { beforeSteps: [] };
    r.registerPipeline('photo', p);
    assert.equal(r.getPipeline('photo'), p);
  });

  test('re-registering a name replaces it (last-wins)', () => {
    const r = new FrameworkResizer(baseOpts());
    const p1: Pipeline = { beforeSteps: [] };
    const p2: Pipeline = { variantSteps: [] };
    r.registerPipeline('photo', p1);
    r.registerPipeline('photo', p2);
    assert.equal(r.getPipeline('photo'), p2);
  });

  test('unknown name → structurally empty pipeline {}, and frozen', () => {
    const r = new FrameworkResizer(baseOpts());
    const empty = r.getPipeline('nope');
    assert.deepEqual(empty, {});
    assert.equal(Object.isFrozen(empty), true);
  });
});

// ---------------------------------------------------------------------------
// Hook bus — waterfall (04 · §9) — ported from hooks.test.ts
// ---------------------------------------------------------------------------

describe('runWaterfall', () => {
  test('threads the value through taps in registration order', async () => {
    installFakeApp();
    const r = new FrameworkResizer(baseOpts());
    r.hook('resolveSizes', (v: number) => v + 1);
    r.hook('resolveSizes', async (v: number) => v * 2);
    const out = await r.runWaterfall('resolveSizes', 1, {});
    assert.equal(out, 4); // (1 + 1) * 2
  });

  test('threads ctx to each tap', async () => {
    installFakeApp();
    const r = new FrameworkResizer(baseOpts());
    const ctx = { entity: 'event' };
    let seen: unknown;
    r.hook('beforeEnqueue', (v: unknown, c: unknown) => {
      seen = c;
      return v;
    });
    await r.runWaterfall('beforeEnqueue', [], ctx);
    assert.equal(seen, ctx);
  });

  test('a throwing tap is logged and skipped (prior value kept); later taps still run', async () => {
    const { errors } = installFakeApp();
    const r = new FrameworkResizer(baseOpts());
    r.hook('resolveSizes', (v: number) => v + 1);
    r.hook('resolveSizes', () => {
      throw new Error('boom');
    });
    r.hook('resolveSizes', (v: number) => v + 10);
    const out = await r.runWaterfall('resolveSizes', 0, {});
    assert.equal(out, 11); // 0+1 → (throw → keep 1) → 1+10
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /resolveSizes/);
  });

  test('with no taps returns the input unchanged', async () => {
    installFakeApp();
    const r = new FrameworkResizer(baseOpts());
    const value = { a: 1 };
    assert.equal(await r.runWaterfall('formatPublicUrls', value, {}), value);
  });
});

// ---------------------------------------------------------------------------
// Hook bus — observers (04 · §9) — ported from hooks.test.ts
// ---------------------------------------------------------------------------

describe('runObservers', () => {
  test('awaits every tap in registration order', async () => {
    installFakeApp();
    const r = new FrameworkResizer(baseOpts());
    const order: number[] = [];
    r.hook('afterTaskComplete', async () => {
      await Promise.resolve();
      order.push(1);
    });
    r.hook('afterTaskComplete', () => {
      order.push(2);
    });
    await r.runObservers('afterTaskComplete', {}, {});
    assert.deepEqual(order, [1, 2]);
  });

  test('a throwing tap is logged and does not stop later taps', async () => {
    const { errors } = installFakeApp();
    const r = new FrameworkResizer(baseOpts());
    const seen: string[] = [];
    r.hook('onTaskFailed', () => {
      throw new Error('boom');
    });
    r.hook('onTaskFailed', () => {
      seen.push('second');
    });
    await r.runObservers('onTaskFailed', {}, new Error('x'), {});
    assert.deepEqual(seen, ['second']);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /onTaskFailed/);
  });

  test('mirrors onto app.events as resize:<name> BEFORE the taps run', async () => {
    const { emitted } = installFakeApp({ withEvents: true });
    const r = new FrameworkResizer(baseOpts());
    let emittedLenWhenTapRan = -1;
    r.hook('onPreviewGenerated', () => {
      emittedLenWhenTapRan = emitted.length;
    });
    await r.runObservers('onPreviewGenerated', 'preview-arg', {});
    assert.equal(emittedLenWhenTapRan, 1); // the emit already happened before the tap
    assert.deepEqual(emitted[0], [
      'resize:onPreviewGenerated',
      'preview-arg',
      {},
    ]);
  });

  test('a missing app.events is fine — taps still run', async () => {
    installFakeApp(); // no events
    const r = new FrameworkResizer(baseOpts());
    const seen: string[] = [];
    r.hook('afterTaskComplete', () => {
      seen.push('ran');
    });
    await r.runObservers('afterTaskComplete', {}, {});
    assert.deepEqual(seen, ['ran']);
  });

  test('a THROWING app.events.emit is caught (logged) and taps still run', async () => {
    const { errors } = installFakeApp({ withEvents: true, emitThrows: true });
    const r = new FrameworkResizer(baseOpts());
    const seen: string[] = [];
    r.hook('onTaskDeadLettered', () => {
      seen.push('ran');
    });
    await r.runObservers('onTaskDeadLettered', {}, new Error('x'), {});
    assert.deepEqual(seen, ['ran']);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /onTaskDeadLettered/);
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
    const sizes = (await r.runWaterfall('resolveSizes', [], {})) as SizeInput[];
    assert.deepEqual(sizes, [injected]);
    await r.runWaterfall(
      'beforeEnqueue',
      [{ sizeKey: 'fit', format: 'webp' }],
      {},
    );
    assert.deepEqual(seenMissing, [{ sizeKey: 'fit', format: 'webp' }]);
  });
});

// ---------------------------------------------------------------------------
// Read/eager stubs — resolve landed in build step 5; generate lands in step 8
// ---------------------------------------------------------------------------

describe('resolve/generate stubs', () => {
  test('resolve delegates to the engine (no longer a stub)', async () => {
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
