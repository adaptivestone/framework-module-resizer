import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import type { ResizeStorage } from '../contracts/storage.ts';
import { MongoTaskQueue } from '../drivers/mongo/taskQueue.ts';
import { ResizeConfigError, ResizeSetupError } from '../errors.ts';
import { timingOf } from '../queue.ts';
import { resetResizerForTests } from '../resizer.ts';
import { fakeDb, MemoryTaskQueue } from '../testHelpers/fakes.ts';
import { makeResizeConfig } from '../testHelpers/resizeConfig.ts';
import { FrameworkDatabase } from './database.ts';
import { createFrameworkResizer } from './resizer.ts';

const storage: ResizeStorage = {
  download: async () => Buffer.alloc(0),
  upload: async ({ key }) => ({ key }),
  publicUrl: () => '',
};

function installApp(configs: Record<string, unknown> = {}) {
  const asked: string[] = [];
  const logger: Record<string, (...a: unknown[]) => void> = {
    info() {},
    warn() {},
    error() {},
  };
  const events = { emit() {} };
  setAppInstance({
    getConfig: (name: string) => configs[name] ?? makeResizeConfig(),
    getModel: (name: string) => {
      asked.push(name);
      return { findById: async () => null };
    },
    logger,
    events,
  } as never);
  return { asked, logger, events };
}

afterEach(() => {
  resetResizerForTests();
  resetAppInstance();
});

test('fills config, logger, events and the database from the app', async () => {
  const { asked, logger, events } = installApp();
  const seen: unknown[] = [];
  const emitted: unknown[][] = [];
  logger.info = (msg: unknown) => {
    seen.push(msg);
  };
  events.emit = (...args: unknown[]) => {
    emitted.push(args);
  };
  const r = createFrameworkResizer({ storage });
  r.logger.info('hello');
  assert.deepEqual(seen, ['hello']); // the app logger, resolved at call time
  assert.deepEqual(r.config.formats, ['jpeg', 'webp', 'avif']);
  assert.ok(r.db instanceof FrameworkDatabase);
  assert.equal(r.tasks, undefined); // eager-only unless tasks are requested
  await r.db.loadMedia('m1');
  assert.deepEqual(asked, ['File']);
  await r.runObservers('onPreviewGenerated', 'preview', {});
  assert.deepEqual(emitted, [['resize:onPreviewGenerated', 'preview', {}]]);
});

test('tasks: true uses the database queue and coordinates through the framework Lock model', async () => {
  const calls: unknown[][] = [];
  setAppInstance({
    getConfig: () => makeResizeConfig(),
    getModel: (name: string) => {
      assert.equal(name, 'Lock');
      return {
        acquireLock: async (key: string, seconds: number) => {
          calls.push(['acquire', key, seconds]);
          return true;
        },
        releaseLock: async (key: string) => {
          calls.push(['release', key]);
        },
      };
    },
  } as never);
  const r = createFrameworkResizer({ storage, tasks: true });
  assert.ok(r.db instanceof FrameworkDatabase);
  assert.ok(r.tasks instanceof MongoTaskQueue);
  assert.equal(r.tasks, r.db.tasks);
  assert.equal(await r.db.acquireLock('variant', 1001), true);
  await r.db.releaseLock('variant');
  assert.deepEqual(calls, [
    ['acquire', 'variant', 2],
    ['release', 'variant'],
  ]);

  const tasks = new MemoryTaskQueue();
  const db = fakeDb({ tasks });
  const custom = createFrameworkResizer({
    name: 'custom',
    storage,
    db,
    tasks: true,
  });
  assert.equal(custom.db, db);
  assert.equal(custom.tasks, tasks);
});

test('configName selects the config file, including its media model', async () => {
  const { asked } = installApp({
    resizeListings: makeResizeConfig({
      formats: ['webp'],
      mediaModelName: 'Photo',
    }),
  });
  const listings = createFrameworkResizer({
    name: 'listings',
    configName: 'resizeListings',
    storage,
  });
  const media = createFrameworkResizer({ storage });
  assert.deepEqual(listings.config.formats, ['webp']);
  assert.deepEqual(media.config.formats, ['jpeg', 'webp', 'avif']);
  await listings.db.loadMedia('m1');
  await media.db.loadMedia('m2');
  assert.deepEqual(asked, ['Photo', 'File']);
});

test('explicit options win over every default', () => {
  installApp();
  const logger = { info() {}, warn() {}, error() {} };
  const events = { emit() {} };
  const db = fakeDb();
  const tasks = new MemoryTaskQueue();
  const config = makeResizeConfig({ formats: ['avif'] });
  const r = createFrameworkResizer({
    storage,
    tasks,
    config,
    logger,
    events,
    db,
  });
  assert.deepEqual(r.config.formats, ['avif']);
  assert.equal(r.config.encode, config.encode);
  assert.equal(r.logger, logger);
  assert.equal(r.db, db);
  assert.equal(r.tasks, tasks);
});

test('the framework database queue takes timing from the selected config file', () => {
  installApp({
    resizeListings: makeResizeConfig({
      queue: { leaseMs: 1234, lockTtlMs: { dispatch: 60000, worker: 1000 } },
    }),
  });
  const r = createFrameworkResizer({
    storage,
    configName: 'resizeListings',
    tasks: true,
  });
  assert.ok(r.tasks instanceof MongoTaskQueue);
  assert.equal(timingOf(r.tasks).leaseMs, 1234);
  assert.deepEqual(timingOf(r.tasks).lockTtlMs, {
    dispatch: 60000,
    worker: 1000,
  });
  const custom = createFrameworkResizer({
    name: 'custom',
    storage,
    tasks: new MongoTaskQueue({
      model: {},
      timing: { leaseMs: 99, lockTtlMs: { dispatch: 60000, worker: 50 } },
    }),
  });
  assert.ok(custom.tasks);
  assert.equal(timingOf(custom.tasks).leaseMs, 99);
});

test('a core MongoTaskQueue needs one model, and the core validates its timing', () => {
  for (const opts of [{}, { model: {}, getModel: () => ({}) }]) {
    assert.throws(
      () => new MongoTaskQueue(opts as never),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_MONGO_MODEL_REQUIRED',
    );
  }
  // Locks come from the database; queue timing is validated by the core on first use.
  assert.throws(
    () =>
      timingOf(
        new MongoTaskQueue({
          model: {},
          timing: {
            leaseMs: 1000,
            lockTtlMs: { dispatch: 60000, worker: 2000 },
          },
        }),
      ),
    (err: unknown) =>
      err instanceof ResizeConfigError &&
      err.code === 'RESIZE_CONFIG_LOCK_EXCEEDS_LEASE',
  );
  const t = new MongoTaskQueue({ model: {} });
  assert.equal(timingOf(t).leaseMs, 60_000);
  assert.deepEqual(timingOf(t).lockTtlMs, {
    dispatch: 60_000,
    worker: 60_000,
  });
});

test('the framework resizer and its database queue read nothing until first use', () => {
  resetAppInstance();
  const r = createFrameworkResizer({ storage, tasks: true }); // no app yet: must not throw
  installApp({
    resize: makeResizeConfig({
      queue: { leaseMs: 4321, lockTtlMs: { dispatch: 60000, worker: 1000 } },
    }),
  });
  assert.ok(r.tasks);
  assert.equal(timingOf(r.tasks).leaseMs, 4321);
});

test('undefined values from getTiming never override the defaults', () => {
  const t = new MongoTaskQueue({
    model: {},
    getTiming: () => ({ leaseMs: undefined, maxAttempts: 7 }),
  });
  assert.equal(timingOf(t).leaseMs, 60_000);
  assert.equal(timingOf(t).maxAttempts, 7);
});

test('MongoTaskQueue.verify() fails when the task model is not registered', async () => {
  const t = new MongoTaskQueue({ getModel: () => undefined });
  assert.throws(
    () => t.verify(),
    (err: unknown) =>
      err instanceof ResizeSetupError &&
      err.code === 'RESIZE_MONGO_MODEL_MISSING',
  );
  // Through the framework: verify() at boot catches a missing src/models/ResizeTask.ts.
  setAppInstance({
    getConfig: () => makeResizeConfig(),
    getModel: (name: string) =>
      name === 'ResizeTask' ? false : { findById: async () => null },
    logger: { info() {}, warn() {}, error() {} },
  } as never);
  const r = createFrameworkResizer({
    storage,
    tasks: true,
  });
  await assert.rejects(
    () => r.verify(),
    (err: unknown) =>
      err instanceof ResizeSetupError &&
      err.code === 'RESIZE_MONGO_MODEL_MISSING',
  );
});

test('verify() fails when the task queue does not serve the Resizer queue', async () => {
  installApp();
  const tasks = new MemoryTaskQueue();
  Object.assign(tasks, { servesQueue: (queue: string) => queue === 'default' });
  const r = createFrameworkResizer({
    storage,
    queue: 'bulk',
    tasks,
  });
  await assert.rejects(
    () => r.verify(),
    (err: unknown) =>
      err instanceof ResizeSetupError && err.code === 'RESIZE_QUEUE_NOT_SERVED',
  );
});

test('prewarm reports a config error as a non-retryable issue', async () => {
  installApp({ resize: { mediaModelName: 'File', upload: null } });
  const r = createFrameworkResizer({ storage, tasks: new MemoryTaskQueue() });
  const result = await r.prewarm({
    media: { id: 'm1', original: { storageRef: { key: 'k' } } },
    sizes: [{ width: 10, height: 10 }],
  });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_INTERNAL_ERROR');
  assert.equal(result.issues[0].retryable, false);
});
