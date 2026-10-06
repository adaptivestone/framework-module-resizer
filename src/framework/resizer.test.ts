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
import { runWorker } from '../worker.ts';
import { FrameworkDatabase } from './database.ts';
import { FrameworkResizer } from './resizer.ts';
import { runResizeWorker } from './worker.ts';

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

test("queue { driver: 'database' } uses the database's own queue and the framework Lock model", async () => {
  const calls: unknown[][] = [];
  setAppInstance({
    getConfig: () =>
      makeResizeConfig({
        storage: localStorage,
        queue: { driver: 'database' },
      }),
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

test("a queue section without a driver is the database's queue; its timing fills the defaults", async () => {
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
  assert.equal(timingOf(r.tasks).lockTtlMs.dispatch, 60000);
  assert.equal(timingOf(r.tasks).lockTtlMs.worker, 1000);
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
    [{ queue: { driver: 'redis' } }, /queue.*'database' or 'sqs'/],
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
      queue: { driver: 'database' },
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
      queue: { driver: 'database' },
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

test("the 'database' queue needs a database with its own queue", async () => {
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queue: { driver: 'database' },
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
  assert.equal(timingOf(t).lockTtlMs.dispatch, 60_000);
  assert.equal(timingOf(t).lockTtlMs.worker, 60_000);
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
      makeResizeConfig({
        storage: localStorage,
        queue: { driver: 'database' },
      }),
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

// --- one task queue per backend -------------------------------------------------------------

const conflictBetween =
  (files: string[], keys: string[], same: string[] = []) =>
  (err: unknown) =>
    err instanceof ResizeConfigError &&
    err.code === 'RESIZE_CONFIG_QUEUE_TIMING_CONFLICT' &&
    files.every((file) => err.message.includes(file)) &&
    keys.every((key) => err.message.includes(key)) &&
    same.every((key) => !err.message.includes(key));

test('Resizers and databases with default wiring share one database task queue', async () => {
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queue: { driver: 'database' },
    }),
    resizeListings: makeResizeConfig({
      storage: localStorage,
      formats: ['webp'],
      queue: {},
    }),
  });
  const media = new FrameworkResizer();
  const listings = new FrameworkResizer({
    name: 'listings',
    configName: 'resizeListings',
  });
  const direct = new FrameworkDatabase({ configName: 'resizeListings' });
  await Promise.all([media.ready(), listings.ready()]);
  assert.ok(media.tasks instanceof MongoTaskQueue);
  assert.notEqual(media.db, listings.db); // each Resizer keeps its own media model and config
  assert.equal(listings.tasks, media.tasks);
  assert.equal(media.db.tasks, media.tasks);
  assert.equal(direct.tasks, media.tasks);
});

test('config files sharing a task queue with different timing conflict on first use, in verify() and at worker start', async () => {
  resetAppInstance();
  // Construction reads nothing, so it cannot see the conflict (and must not throw).
  const media = new FrameworkResizer();
  const listings = new FrameworkResizer({
    name: 'listings',
    configName: 'resizeListings',
  });
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      worker: { enabled: true },
      queue: {
        maxAttempts: 3,
        idlePollMs: 50,
        lockTtlMs: { dispatch: 60000, worker: 5000 },
      },
    }),
    resizeListings: makeResizeConfig({
      storage: localStorage,
      formats: ['webp'], // image settings may differ
      queue: {
        driver: 'database',
        maxAttempts: 7,
        idlePollMs: 50,
        lockTtlMs: { worker: 5000, dispatch: 60000 }, // same values, other key order
        taskTimeoutMs: 1000,
      },
    }),
  });
  const conflict = conflictBetween(
    ['src/config/resize.ts', 'src/config/resizeListings.ts'],
    ['maxAttempts', 'taskTimeoutMs'],
    ['idlePollMs', 'lockTtlMs'],
  );
  await assert.rejects(() => media.verify(), conflict);
  await assert.rejects(() => listings.verify(), conflict);
  await assert.rejects(
    () =>
      media.generate({
        media: { id: 'm1', original: { storageRef: { key: 'k' } } },
        sizes: [{ width: 10, height: 10 }],
      }),
    conflict,
  );
  await assert.rejects(() => runResizeWorker(), conflict);
  await assert.rejects(
    () => runWorker({ signal: AbortSignal.abort() }),
    conflict,
  );
});

test('a host-built FrameworkDatabase is checked against the Resizers that share its queue', async () => {
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queue: { maxAttempts: 3 },
    }),
    resizeHost: makeResizeConfig({ queue: { maxAttempts: 4 } }),
  });
  const media = new FrameworkResizer();
  const db = new FrameworkDatabase({ configName: 'resizeHost' });
  const conflict = conflictBetween(
    ['src/config/resize.ts', 'src/config/resizeHost.ts'],
    ['maxAttempts'],
  );
  await assert.rejects(() => media.verify(), conflict);
  assert.throws(() => db.verify(), conflict);
  assert.ok(db.tasks);
  assert.throws(() => timingOf(db.tasks as MongoTaskQueue), conflict);
});

test('two config files with the same timing share the queue and its timing', async () => {
  const queue = {
    maxAttempts: 3,
    lockTtlMs: { dispatch: 60000, worker: 5000 },
    leaseMs: 5000,
  };
  installApp({
    resize: makeResizeConfig({ storage: localStorage, queue }),
    resizeListings: makeResizeConfig({
      storage: localStorage,
      formats: ['webp'],
      queue: { driver: 'database', ...queue },
    }),
  });
  const media = new FrameworkResizer();
  const listings = new FrameworkResizer({
    name: 'listings',
    configName: 'resizeListings',
  });
  await media.verify();
  await listings.verify();
  assert.ok(media.tasks);
  assert.equal(timingOf(media.tasks).maxAttempts, 3);
  assert.equal(timingOf(media.tasks).leaseMs, 5000);
});

test('timing is compared only between configs that use the same task queue', async () => {
  const withQueue = (queue: unknown) =>
    makeResizeConfig({ storage: localStorage, queue: queue as never });
  installApp({
    resize: withQueue({ maxAttempts: 3 }),
    resizeEager: withQueue({ maxAttempts: 4 }), // tasks: false in code
    resizeOwn: withQueue({ maxAttempts: 5 }), // explicit tasks in code
    resizeSqs: withQueue({
      driver: 'sqs',
      queueUrl: 'https://sqs.example/resize',
      maxAttempts: 6,
    }),
    resizeOff: withQueue(false),
  });
  const own = new MemoryTaskQueue();
  const media = new FrameworkResizer();
  const eager = new FrameworkResizer({
    name: 'eager',
    configName: 'resizeEager',
    tasks: false,
  });
  const explicit = new FrameworkResizer({
    name: 'own',
    configName: 'resizeOwn',
    tasks: own,
  });
  const sqs = new FrameworkResizer({ name: 'sqs', configName: 'resizeSqs' });
  const off = new FrameworkResizer({ name: 'off', configName: 'resizeOff' });
  for (const r of [media, eager, explicit, sqs, off]) {
    await r.verify();
  }
  assert.ok(media.tasks instanceof MongoTaskQueue);
  assert.equal(timingOf(media.tasks).maxAttempts, 3);
  assert.equal(eager.tasks, undefined);
  assert.equal(off.tasks, undefined);
  assert.equal(explicit.tasks, own); // an explicit queue is never shared or replaced
  assert.ok(sqs.tasks instanceof SqsTaskQueue);
  assert.equal(timingOf(sqs.tasks).maxAttempts, 6);
});

test('configs that select the same SQS queue share one SqsTaskQueue; another queue gets its own', async () => {
  const sqs = (queue: Record<string, unknown>) =>
    makeResizeConfig({
      storage: localStorage,
      queue: {
        driver: 'sqs',
        queueUrl: 'https://sqs.example/resize',
        region: 'eu-west-1',
        deadLetterQueueUrl: 'https://sqs.example/dead',
        ...queue,
      } as never,
    });
  installApp({
    resize: sqs({
      queues: {
        bulk: 'https://sqs.example/bulk',
        slow: 'https://sqs.example/slow',
      },
    }),
    resizeListings: sqs({
      queues: {
        slow: 'https://sqs.example/slow',
        bulk: 'https://sqs.example/bulk',
      },
    }),
    resizeOther: sqs({ queueUrl: 'https://sqs.example/other' }),
    resizeRegion: sqs({
      queues: {
        bulk: 'https://sqs.example/bulk',
        slow: 'https://sqs.example/slow',
      },
      region: 'us-east-1',
    }),
  });
  const media = new FrameworkResizer();
  const listings = new FrameworkResizer({
    name: 'listings',
    configName: 'resizeListings',
  });
  const other = new FrameworkResizer({
    name: 'other',
    configName: 'resizeOther',
  });
  const region = new FrameworkResizer({
    name: 'region',
    configName: 'resizeRegion',
  });
  await Promise.all([media, listings, other, region].map((r) => r.ready()));
  assert.ok(media.tasks instanceof SqsTaskQueue);
  assert.equal(listings.tasks, media.tasks);
  assert.ok(other.tasks instanceof SqsTaskQueue);
  assert.notEqual(other.tasks, media.tasks);
  assert.notEqual(region.tasks, media.tasks);
});

test('configs that share an SQS queue with different timing conflict', async () => {
  const sqs = (queue: Record<string, unknown>) =>
    makeResizeConfig({
      storage: localStorage,
      worker: { enabled: true },
      queue: {
        driver: 'sqs',
        queueUrl: 'https://sqs.example/resize',
        ...queue,
      } as never,
    });
  installApp({
    resize: sqs({ maxAttempts: 3, waitTimeSeconds: 10 }),
    resizeListings: sqs({ maxAttempts: 3, waitTimeSeconds: 20 }),
  });
  const media = new FrameworkResizer();
  const listings = new FrameworkResizer({
    name: 'listings',
    configName: 'resizeListings',
  });
  const conflict = conflictBetween(
    ['src/config/resize.ts', 'src/config/resizeListings.ts'],
    ['waitTimeSeconds'],
    ['maxAttempts'],
  );
  await assert.rejects(() => listings.verify(), conflict);
  await assert.rejects(() => media.verify(), conflict);
  await assert.rejects(() => runResizeWorker(), conflict);
});

test("an omitted SQS waitTimeSeconds equals the driver's default, so it is no conflict", async () => {
  const sqs = (queue: Record<string, unknown>) =>
    makeResizeConfig({
      storage: localStorage,
      queue: {
        driver: 'sqs',
        queueUrl: 'https://sqs.example/resize',
        ...queue,
      } as never,
    });
  installApp({
    resize: sqs({}),
    resizeListings: sqs({ waitTimeSeconds: 10 }),
  });
  const media = new FrameworkResizer();
  const listings = new FrameworkResizer({
    name: 'listings',
    configName: 'resizeListings',
  });
  await media.verify();
  await listings.verify();
  assert.ok(media.tasks instanceof SqsTaskQueue);
  assert.equal(listings.tasks, media.tasks);
});

test('resetResizerForTests forgets the shared task queues and the configs that used them', async () => {
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queue: { maxAttempts: 3 },
    }),
    resizeListings: makeResizeConfig({
      storage: localStorage,
      queue: { maxAttempts: 4 },
    }),
    resizeSqs: makeResizeConfig({
      storage: localStorage,
      queue: { driver: 'sqs', queueUrl: 'https://sqs.example/resize' },
    }),
  });
  const first = new FrameworkResizer();
  const firstSqs = new FrameworkResizer({
    name: 'sqs',
    configName: 'resizeSqs',
  });
  await Promise.all([first.ready(), firstSqs.ready()]);
  assert.ok(first.tasks);
  assert.equal(timingOf(first.tasks).maxAttempts, 3);

  resetResizerForTests();
  // A forgotten Resizer's config no longer takes part, and the queues are new objects.
  const next = new FrameworkResizer({ configName: 'resizeListings' });
  const nextSqs = new FrameworkResizer({
    name: 'sqs',
    configName: 'resizeSqs',
  });
  await next.verify();
  await nextSqs.verify();
  assert.ok(next.tasks);
  assert.notEqual(next.tasks, first.tasks);
  assert.equal(timingOf(next.tasks).maxAttempts, 4);
  assert.notEqual(nextSqs.tasks, firstSqs.tasks);
});
