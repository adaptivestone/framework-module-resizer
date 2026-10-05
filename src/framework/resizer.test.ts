import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import type { ResizeStorage } from '../contracts/storage.ts';
import { LocalFsStorage } from '../drivers/fs.ts';
import { MongoTaskQueue } from '../drivers/mongo/taskQueue.ts';
import { S3Storage } from '../drivers/s3.ts';
import { SqsTaskQueue } from '../drivers/sqs.ts';
import { ResizeConfigError, ResizeSetupError } from '../errors.ts';
import { timingOf } from '../queue.ts';
import { resetResizerForTests } from '../resizer.ts';
import { fakeDb, MemoryTaskQueue } from '../testHelpers/fakes.ts';
import { makeResizeConfig } from '../testHelpers/resizeConfig.ts';
import { FrameworkDatabase } from './database.ts';
import { FrameworkResizer } from './resizer.ts';

const storage: ResizeStorage = {
  download: async () => Buffer.alloc(0),
  upload: async ({ key }) => ({ key }),
  publicUrl: () => '',
};

const localStorage = {
  driver: 'local' as const,
  rootDir: './var/media',
  publicBaseUrl: '/media',
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
  const r = new FrameworkResizer({ storage });
  r.logger.info('hello');
  assert.deepEqual(seen, ['hello']); // the app logger, resolved at call time
  assert.deepEqual(r.config.formats, ['jpeg', 'webp', 'avif']);
  assert.ok(r.db instanceof FrameworkDatabase);
  await r.ready();
  assert.equal(r.tasks, undefined); // no `queue` section: eager only
  await r.db.loadMedia('m1');
  assert.deepEqual(asked, ['File']);
  await r.runObservers('onPreviewGenerated', 'preview', {});
  assert.deepEqual(emitted, [['resize:onPreviewGenerated', 'preview', {}]]);
});

test('storage comes from the config file: local', async () => {
  installApp({
    resize: makeResizeConfig({
      storage: { ...localStorage, privateRootDir: './var/originals' },
    }),
  });
  const r = new FrameworkResizer();
  assert.throws(
    () => r.storage,
    (err: unknown) =>
      err instanceof ResizeSetupError && err.code === 'RESIZE_NOT_READY',
  );
  await r.ready();
  assert.ok(r.storage instanceof LocalFsStorage);
  assert.equal(
    r.storage.publicUrl({ path: 'a/b.webp', visibility: 'public' }),
    '/media/a/b.webp',
  );
});

test('storage comes from the config file: s3, imported only when selected', async () => {
  installApp({
    resize: makeResizeConfig({
      storage: {
        driver: 's3',
        bucketPublic: 'cdn',
        bucketPrivate: 'originals',
        publicBaseUrl: 'https://cdn.example.com',
        region: 'eu-west-1',
      },
    }),
  });
  const r = new FrameworkResizer();
  await r.ready();
  assert.ok(r.storage instanceof S3Storage);
  assert.equal(
    r.storage.publicUrl({ bucket: 'cdn', key: 'p/x.webp' }),
    'https://cdn.example.com/p/x.webp',
  );
});

test("an environment file's driver switch does not pass the other driver's keys", async () => {
  // What the framework produces when resize.production.ts sets an s3 storage over a local one.
  installApp({
    resize: makeResizeConfig({
      storage: {
        ...localStorage,
        driver: 's3',
        bucketPublic: 'cdn',
        publicBaseUrl: 'https://cdn.example.com',
      } as never,
    }),
  });
  const r = new FrameworkResizer();
  await r.ready();
  assert.ok(r.storage instanceof S3Storage);
  assert.equal(
    r.storage.publicUrl({ bucket: 'cdn', key: 'x.webp' }),
    'https://cdn.example.com/x.webp',
  );
});

test('a missing storage section is a config error at verify(), and resolve() still never throws', async () => {
  const { logger } = installApp();
  const errors: unknown[][] = [];
  logger.error = (...args: unknown[]) => {
    errors.push(args);
  };
  const r = new FrameworkResizer();
  await assert.rejects(
    () => r.verify(),
    (err: unknown) =>
      err instanceof ResizeConfigError &&
      err.code === 'RESIZE_CONFIG_STORAGE_MISSING' &&
      err.message.includes('src/config/resize.ts'),
  );
  const { decision } = await r.resolve({
    media: { id: 'm1', original: { storageRef: { key: 'k' } } },
    sizes: [{ width: 10, height: 10 }],
  });
  assert.deepEqual(decision, { ready: [], missing: [] });
  assert.ok(errors.length >= 1);
  await assert.rejects(
    () =>
      r.generate({
        media: { id: 'm1', original: { storageRef: { key: 'k' } } },
        sizes: [{ width: 10, height: 10 }],
      }),
    (err: unknown) =>
      err instanceof ResizeConfigError &&
      err.code === 'RESIZE_CONFIG_STORAGE_MISSING',
  );
});

test("queue { driver: 'mongo' } uses the database's queue and the framework Lock model", async () => {
  const calls: unknown[][] = [];
  setAppInstance({
    getConfig: () =>
      makeResizeConfig({ storage: localStorage, queue: { driver: 'mongo' } }),
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
  const r = new FrameworkResizer();
  await r.ready();
  assert.ok(r.db instanceof FrameworkDatabase);
  assert.ok(r.tasks instanceof MongoTaskQueue);
  assert.equal(r.tasks, r.db.tasks);
  assert.equal(await r.db.acquireLock('variant', 1001), true);
  await r.db.releaseLock('variant');
  assert.deepEqual(calls, [
    ['acquire', 'variant', 2],
    ['release', 'variant'],
  ]);
});

test('a queue section without a driver is the Mongo queue; its timing fills the defaults', async () => {
  installApp({
    resizeListings: makeResizeConfig({
      storage: localStorage,
      queue: { leaseMs: 1234, lockTtlMs: { dispatch: 60000, worker: 1000 } },
    }),
  });
  const r = new FrameworkResizer({ configName: 'resizeListings' });
  await r.ready();
  assert.ok(r.tasks instanceof MongoTaskQueue);
  assert.equal(timingOf(r.tasks).leaseMs, 1234);
  assert.deepEqual(timingOf(r.tasks).lockTtlMs, {
    dispatch: 60000,
    worker: 1000,
  });
  assert.equal(timingOf(r.tasks).maxAttempts, 5);
});

test("queue { driver: 'sqs' } builds an SqsTaskQueue with the config's URLs and timing", async () => {
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queue: {
        driver: 'sqs',
        queueUrl: 'https://sqs.example/resize',
        queues: { bulk: 'https://sqs.example/bulk' },
        deadLetterQueueUrl: 'https://sqs.example/dead',
        region: 'eu-west-1',
        maxAttempts: 3,
      },
    }),
  });
  const r = new FrameworkResizer();
  await r.ready();
  assert.ok(r.tasks instanceof SqsTaskQueue);
  assert.equal(r.tasks.servesQueue('default'), true);
  assert.equal(r.tasks.servesQueue('bulk'), true);
  assert.equal(r.tasks.servesQueue('other'), false);
  assert.equal(timingOf(r.tasks).maxAttempts, 3);
  assert.notEqual(r.tasks, r.db.tasks); // media and locks stay in the database
});

test('invalid storage or queue sections are config errors', async () => {
  for (const [override, message] of [
    [{ storage: { driver: 'ftp' } }, /storage.*'local' or 's3'/],
    [{ queue: { driver: 'redis' } }, /queue.*'mongo' or 'sqs'/],
    [{ queue: { driver: 'sqs' } }, /queueUrl.*required/],
  ] as const) {
    installApp({ resize: { ...makeResizeConfig(), ...override } });
    const r = new FrameworkResizer({ storage });
    await assert.rejects(
      () => r.verify(),
      (err: unknown) =>
        err instanceof ResizeConfigError &&
        err.code === 'RESIZE_CONFIG_INVALID' &&
        message.test(err.message),
    );
    resetResizerForTests();
    resetAppInstance();
  }
});

test('configName selects the config file, including its media model', async () => {
  const { asked } = installApp({
    resizeListings: makeResizeConfig({
      formats: ['webp'],
      mediaModelName: 'Photo',
    }),
  });
  const listings = new FrameworkResizer({
    name: 'listings',
    configName: 'resizeListings',
    storage,
  });
  const media = new FrameworkResizer({ storage });
  assert.deepEqual(listings.config.formats, ['webp']);
  assert.deepEqual(media.config.formats, ['jpeg', 'webp', 'avif']);
  await listings.db.loadMedia('m1');
  await media.db.loadMedia('m2');
  assert.deepEqual(asked, ['Photo', 'File']);
});

test('explicit options win over the config file', async () => {
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queue: { driver: 'mongo' },
    }),
  });
  const logger = { info() {}, warn() {}, error() {} };
  const events = { emit() {} };
  const db = fakeDb();
  const tasks = new MemoryTaskQueue();
  const config = makeResizeConfig({ formats: ['avif'] });
  const r = new FrameworkResizer({
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
  assert.equal(r.storage, storage);
  assert.equal(r.tasks, tasks);
});

test('tasks: false is eager only, even when the config has a queue', async () => {
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queue: { driver: 'mongo' },
    }),
  });
  const r = new FrameworkResizer({ tasks: false });
  await r.ready();
  assert.equal(r.tasks, undefined);
});

test('an explicit config also feeds the database queue timing', async () => {
  installApp();
  const r = new FrameworkResizer({
    config: makeResizeConfig({
      storage: localStorage,
      queue: { leaseMs: 4000, lockTtlMs: { dispatch: 60000, worker: 4000 } },
    }),
  });
  await r.ready();
  assert.ok(r.tasks instanceof MongoTaskQueue);
  assert.equal(timingOf(r.tasks).leaseMs, 4000);
});

test('the Mongo queue needs a database with its own queue', async () => {
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queue: { driver: 'mongo' },
    }),
  });
  const r = new FrameworkResizer({ db: fakeDb() });
  await assert.rejects(
    () => r.ready(),
    (err: unknown) =>
      err instanceof ResizeConfigError &&
      err.code === 'RESIZE_CONFIG_INVALID' &&
      /has no task queue/.test(err.message),
  );
  const tasks = new MemoryTaskQueue();
  resetResizerForTests();
  const own = new FrameworkResizer({ db: fakeDb({ tasks }) });
  await own.ready();
  assert.equal(own.tasks, tasks);
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

test('nothing is read from the app until first use', async () => {
  resetAppInstance();
  const r = new FrameworkResizer(); // no app yet: must not throw
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queue: { leaseMs: 4321, lockTtlMs: { dispatch: 60000, worker: 1000 } },
    }),
  });
  await r.ready();
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

test('verify() fails at boot when the ResizeTask model is not registered', async () => {
  const t = new MongoTaskQueue({ getModel: () => undefined });
  assert.throws(
    () => t.verify(),
    (err: unknown) =>
      err instanceof ResizeSetupError &&
      err.code === 'RESIZE_MONGO_MODEL_MISSING',
  );
  // Through the framework: verify() at boot catches a missing src/models/ResizeTask.ts.
  setAppInstance({
    getConfig: () =>
      makeResizeConfig({ storage: localStorage, queue: { driver: 'mongo' } }),
    getModel: (name: string) =>
      name === 'ResizeTask' ? false : { findById: async () => null },
    logger: { info() {}, warn() {}, error() {} },
  } as never);
  const r = new FrameworkResizer();
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
  const r = new FrameworkResizer({
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
  const r = new FrameworkResizer({ storage, tasks: new MemoryTaskQueue() });
  const result = await r.prewarm({
    media: { id: 'm1', original: { storageRef: { key: 'k' } } },
    sizes: [{ width: 10, height: 10 }],
  });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_INTERNAL_ERROR');
  assert.equal(result.issues[0].retryable, false);
});
