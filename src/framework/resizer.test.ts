import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { afterEach, mock, test } from 'node:test';
import { promisify } from 'node:util';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import sharp from 'sharp';
import defaultResizeConfig from '../config/resize.ts';
import type { ResizeStorage } from '../contracts/storage.ts';
import type { LeasedTask } from '../contracts/taskQueue.ts';
import { LocalFsStorage } from '../drivers/fs.ts';
import { MongoTaskQueue } from '../drivers/mongo/taskQueue.ts';
import { S3Storage } from '../drivers/s3.ts';
import { SqsTaskQueue } from '../drivers/sqs.ts';
import { ResizeConfigError, ResizeSetupError } from '../errors.ts';
import { sqsBackendKey } from '../helpers/queueSections.ts';
import { LogMetrics, NoopMetrics } from '../metrics.ts';
import {
  processorOf,
  resetResizerForTests,
  taskCoordinationOf,
} from '../resizer.ts';
import { carrierOf, RoutingTaskQueue } from '../routing.ts';
import {
  fakeMedia,
  fakeQueueDriver,
  MemoryTaskQueue,
  memoryLocks,
  memoryStorageDriver,
  PlainTaskQueue,
} from '../testHelpers/fakes.ts';
import { makeResizeConfig } from '../testHelpers/resizeConfig.ts';
import { timingOf } from '../timing.ts';
import type { Preview, QueueConfig } from '../types.d.ts';
import { FrameworkLockStore } from './locks.ts';
import { FrameworkMediaStore } from './media.ts';
import { FrameworkResizer } from './resizer.ts';
import { runResizeWorker } from './worker.ts';

const runNode = promisify(execFile);

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

// The queue the scaffold defines: one database queue named 'default'.
const databaseQueues = { default: { driver: 'database' as const } };

const OVERRIDE = '(or its resize.<NODE_ENV>.ts override)';

const sizes = [{ width: 10, height: 10 }];
const withOriginal = () => ({
  id: 'm1',
  original: { storageRef: { key: 'k' } },
});

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

const configError =
  (code: string, ...parts: string[]) =>
  (err: unknown) =>
    err instanceof ResizeConfigError &&
    err.code === code &&
    parts.every((part) => err.message.includes(part));

afterEach(() => {
  resetResizerForTests();
  resetAppInstance();
});

test('fills config, logger, events and the media store from the app; an eager-only Resizer has no lock store', async () => {
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
  assert.ok(r.media instanceof FrameworkMediaStore);
  await r.ready();
  assert.equal(r.tasks, undefined); // no `queues`: eager only
  assert.equal(r.locks, undefined);
  await r.media.loadMedia('m1');
  assert.deepEqual(asked, ['File']);
  // Observers reach the app's event bus.
  const done: LeasedTask = {
    taskId: 't1',
    resizer: 'default',
    queue: 'default',
    mediaId: 'm1',
    pipeline: 'default',
    previews: [],
    attempts: 1,
  };
  await processorOf(r).notify('completed', done);
  assert.deepEqual(emitted, [['resize:afterTaskComplete', done, {}]]);
});

test('the default metrics of a FrameworkResizer write debug lines through the app logger', () => {
  const { logger } = installApp();
  const debug: unknown[] = [];
  logger.debug = (msg: unknown) => {
    debug.push(msg);
  };
  const r = new FrameworkResizer({ storage });
  assert.ok(r.metrics instanceof LogMetrics);
  r.metrics.count('x', 1);
  assert.equal(debug.length, 1);
  assert.ok(String(debug[0]).startsWith('resize metric x 1'), String(debug[0]));
  // The host's sink wins.
  resetResizerForTests();
  const sink = new NoopMetrics();
  assert.equal(new FrameworkResizer({ storage, metrics: sink }).metrics, sink);
});

test('a FrameworkResizer rejects metrics: null as new Resizer does; only undefined means the default', () => {
  installApp();
  assert.throws(
    () => new FrameworkResizer({ storage, metrics: null as never }),
    (e: unknown) =>
      e instanceof ResizeSetupError &&
      e.code === 'RESIZE_METRICS_INVALID' &&
      e.retryable === false,
  );
  // The name stays free, and an undefined option is the default.
  const r = new FrameworkResizer({ storage, metrics: undefined });
  assert.ok(r.metrics instanceof LogMetrics);
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
  const { decision } = await r.resolve({ media: withOriginal(), sizes });
  assert.deepEqual(decision, { ready: [], missing: [] });
  assert.ok(errors.length >= 1);
  await assert.rejects(
    () => r.generate({ media: withOriginal(), sizes }),
    (err: unknown) =>
      err instanceof ResizeConfigError &&
      err.code === 'RESIZE_CONFIG_STORAGE_MISSING',
  );
});

test("a 'database' queue uses the app's ResizeTask queue and no lock store, so verify() needs no framework Lock model", async () => {
  const asked: string[] = [];
  setAppInstance({
    getConfig: () =>
      makeResizeConfig({
        storage: localStorage,
        queue: 'default',
        queues: databaseQueues,
      }),
    getModel: (name: string) => {
      asked.push(name);
      return name === 'Lock' ? undefined : { findById: async () => null };
    },
    logger: { info() {}, warn() {}, error() {} },
  } as never);
  const r = new FrameworkResizer();
  await r.verify();
  assert.ok(r.tasks instanceof MongoTaskQueue);
  const second = new FrameworkResizer({ name: 'second' });
  await second.ready();
  assert.equal(r.tasks, second.tasks);
  assert.equal(r.locks, undefined);
  assert.equal(asked.includes('Lock'), false);
});

test("an 'sqs' queue takes its gate locks in the framework Lock model, which verify() requires", async () => {
  const calls: unknown[][] = [];
  let lockModel: unknown;
  setAppInstance({
    getConfig: () =>
      makeResizeConfig({
        storage: localStorage,
        queues: {
          default: { driver: 'sqs', queueUrl: 'https://sqs.example/resize' },
        },
      }),
    getModel: (name: string) => {
      if (name !== 'Lock') {
        return { findById: async () => null };
      }
      return lockModel;
    },
    logger: { info() {}, warn() {}, error() {} },
  } as never);
  const r = new FrameworkResizer();
  await r.ready();
  assert.ok(r.tasks instanceof SqsTaskQueue);
  assert.ok(r.locks instanceof FrameworkLockStore);
  await assert.rejects(
    () => r.verify(),
    (err: unknown) =>
      err instanceof ResizeSetupError &&
      err.code === 'RESIZE_MONGO_MODEL_MISSING',
  );
  // With the Lock model registered, the gate locks go through its collection.
  lockModel = {
    collection: {
      findOneAndUpdate: async (
        filter: { _id: string },
        update: { $set: { owner: string } },
        options: { upsert: boolean },
      ) => {
        calls.push(['upsert', filter._id, update.$set.owner, options]);
        return null;
      },
      updateOne: async () => ({ matchedCount: 0 }),
      deleteOne: async (filter: object) => {
        calls.push(['delete', filter]);
        return { deletedCount: 1 };
      },
    },
  };
  assert.equal(await r.locks.acquire('gate', 'A', 1001), true);
  assert.equal(await r.locks.release('gate', 'A'), true);
  assert.deepEqual(calls, [
    ['upsert', 'gate', 'A', { upsert: true }],
    ['delete', { _id: 'gate', owner: 'A' }],
  ]);
});

test('the tasks and locks parts share one queue build; a failed build is retried by the next call', async () => {
  // The file names a queue resize.ts does not define yet, so the first build rejects.
  const file = makeResizeConfig({
    storage: localStorage,
    queue: 'bulk',
    queues: databaseQueues,
  });
  installApp({ resize: file });
  const r = new FrameworkResizer();
  await assert.rejects(
    () => r.ready(),
    configError('RESIZE_CONFIG_QUEUE_UNKNOWN', "queues to 'bulk'"),
  );
  // What app.updateConfig() does: a new value assigned into the same object.
  Object.assign(file, {
    queues: { ...databaseQueues, bulk: { driver: 'database' } },
  });
  await r.ready();
  assert.ok(r.tasks instanceof MongoTaskQueue);
  assert.equal(r.queueName, 'bulk');
  assert.equal(r.locks, undefined);
});

test('a task queue passed in code gets the framework lock store only when it has no gatesByTask', () => {
  installApp();
  assert.equal(
    new FrameworkResizer({ storage, tasks: new MemoryTaskQueue() }).locks,
    undefined,
  );
  assert.ok(
    new FrameworkResizer({
      name: 'plain',
      storage,
      tasks: new PlainTaskQueue(),
    }).locks instanceof FrameworkLockStore,
  );
});

test("a 'database' entry's timing fills the defaults", async () => {
  installApp({
    // A resize.ts with only the process-wide sections, beside another Resizer's file.
    resize: {
      queues: {
        default: { driver: 'database', leaseMs: 1234, idlePollMs: 50 },
      },
    },
    resizeListings: makeResizeConfig({ storage: localStorage }),
  });
  const r = new FrameworkResizer({ configName: 'resizeListings' });
  await r.ready();
  assert.ok(r.tasks instanceof MongoTaskQueue);
  assert.equal(timingOf(r.tasks, 'default').leaseMs, 1234);
  assert.equal(timingOf(r.tasks, 'default').idlePollMs, 50);
  assert.equal(timingOf(r.tasks, 'default').maxAttempts, 5);
});

test("'sqs' entries build one SqsTaskQueue with their URLs, and each name keeps its timing", async () => {
  const connection = {
    deadLetterQueueUrl: 'https://sqs.example/dead',
    region: 'eu-west-1',
  };
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queues: {
        default: {
          driver: 'sqs',
          queueUrl: 'https://sqs.example/resize',
          maxAttempts: 3,
          ...connection,
        },
        bulk: {
          driver: 'sqs',
          queueUrl: 'https://sqs.example/bulk',
          ...connection,
        },
      },
    }),
  });
  const r = new FrameworkResizer();
  await r.ready();
  assert.ok(r.tasks instanceof SqsTaskQueue);
  assert.equal(r.tasks.servesQueue('default'), true);
  assert.equal(r.tasks.servesQueue('bulk'), true);
  assert.equal(r.tasks.servesQueue('other'), false);
  assert.equal(timingOf(r.tasks, 'default').maxAttempts, 3);
  assert.equal(timingOf(r.tasks, 'bulk').maxAttempts, 5);
  assert.ok(r.locks instanceof FrameworkLockStore); // locks stay in the framework Lock model
});

test('invalid storage or queues sections are config errors', async () => {
  for (const [override, message] of [
    [{ storage: { driver: 'ftp' } }, /storage.*'local' or 's3'/],
    [
      { queues: { default: { driver: 'redis' } } },
      /queues\.default.*'database' or 'sqs'/,
    ],
    [{ queues: { default: { driver: 'sqs' } } }, /queueUrl.*required/],
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
  await listings.media.loadMedia('m1');
  await media.media.loadMedia('m2');
  assert.deepEqual(asked, ['Photo', 'File']);
});

test('explicit options win over the config file', async () => {
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queue: 'default',
      queues: databaseQueues,
    }),
  });
  const logger = { info() {}, warn() {}, error() {} };
  const events = { emit() {} };
  const media = fakeMedia();
  const locks = memoryLocks();
  const tasks = new MemoryTaskQueue();
  const config = makeResizeConfig({ formats: ['avif'] });
  const r = new FrameworkResizer({
    storage,
    tasks,
    config,
    logger,
    events,
    media,
    locks,
  });
  assert.deepEqual(r.config.formats, ['avif']);
  assert.equal(r.config.encode, config.encode);
  assert.equal(r.logger, logger);
  assert.equal(r.media, media);
  assert.equal(r.locks, locks);
  assert.equal(r.storage, storage);
  assert.equal(r.tasks, tasks);
});

test('tasks: false is eager only, even when resize.ts defines queues', async () => {
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queue: 'default',
      queues: databaseQueues,
    }),
  });
  const r = new FrameworkResizer({ tasks: false });
  await r.ready();
  assert.equal(r.tasks, undefined);
});

test('tasks: false builds no lock store, so verify() needs no framework Lock model', async () => {
  const asked: string[] = [];
  setAppInstance({
    getConfig: () =>
      makeResizeConfig({
        storage: localStorage,
        queue: 'default',
        queues: databaseQueues,
      }),
    getModel: (name: string) => {
      asked.push(name);
      return name === 'Lock' ? undefined : { findById: async () => null };
    },
    logger: { info() {}, warn() {}, error() {} },
  } as never);
  const r = new FrameworkResizer({ tasks: false });
  await r.verify();
  assert.equal(r.locks, undefined);
  assert.deepEqual(asked, ['File']);
  // A lock store given in code is kept.
  const locks = memoryLocks();
  assert.equal(
    new FrameworkResizer({ name: 'b', tasks: false, locks }).locks,
    locks,
  );
});

test("an explicit config names its queue; the queue's timing comes from resize.ts", async () => {
  installApp({
    resize: { queues: { bulk: { driver: 'database', leaseMs: 4000 } } },
  });
  const r = new FrameworkResizer({
    config: makeResizeConfig({ storage: localStorage, queue: 'bulk' }),
  });
  await r.ready();
  assert.ok(r.tasks instanceof MongoTaskQueue);
  assert.equal(r.queueName, 'bulk');
  assert.equal(timingOf(r.tasks, 'bulk').leaseMs, 4000);
});

test("resize.ts's coordination reaches every Resizer; the option wins", async () => {
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queue: 'default',
      queues: databaseQueues,
      coordination: { cooldownMs: 1234 },
    }),
    resizeListings: makeResizeConfig({ storage: localStorage }),
  });
  const fromFile = new FrameworkResizer();
  const listings = new FrameworkResizer({
    name: 'listings',
    configName: 'resizeListings',
  });
  const own = new FrameworkResizer({
    name: 'own',
    tasks: new MemoryTaskQueue(),
  });
  const fromOption = new FrameworkResizer({
    name: 'option',
    coordination: { cooldownMs: 99 },
  });
  for (const [resizer, cooldownMs] of [
    [fromFile, 1234],
    [listings, 1234],
    [own, 1234],
    [fromOption, 99],
  ] as const) {
    await resizer.ready();
    assert.equal(
      taskCoordinationOf(resizer).cooldownMs,
      cooldownMs,
      resizer.name,
    );
  }
  // An explicit config is a per-Resizer config: it cannot carry the section.
  assert.throws(
    () =>
      new FrameworkResizer({
        name: 'explicit',
        config: makeResizeConfig({
          storage: localStorage,
          coordination: { cooldownMs: 77 },
        }),
      }),
    configError(
      'RESIZE_CONFIG_INVALID',
      '`coordination` in the config passed to new FrameworkResizer() is process-wide',
    ),
  );
});

test("resize.ts's coordination: null is validated, not read as the defaults", async () => {
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queues: databaseQueues,
      coordination: null as never,
    }),
  });
  const r = new FrameworkResizer();
  await assert.rejects(
    () => r.verify(),
    (err: unknown) =>
      err instanceof ResizeConfigError &&
      err.code === 'RESIZE_CONFIG_COORDINATION_INVALID' &&
      /got null/.test(err.message),
  );
});

test('a broken config file fails as itself, before the task queue is set up: nothing is logged about the queue', async () => {
  const { logger } = installApp({
    resize: makeResizeConfig({
      mediaModelName: '',
      storage: localStorage,
      queue: 'default',
      queues: databaseQueues,
    }),
  });
  const errors: unknown[][] = [];
  logger.error = (...args: unknown[]) => {
    errors.push(args);
  };
  const r = new FrameworkResizer({
    storage,
    tasks: new MemoryTaskQueue(),
  });
  const mediaModelMissing = (err: unknown) =>
    err instanceof ResizeConfigError &&
    err.code === 'RESIZE_CONFIG_MEDIA_MODEL_MISSING';
  await assert.rejects(() => r.ready(), mediaModelMissing);
  await assert.rejects(() => r.verify(), mediaModelMissing);
  assert.deepEqual(
    errors.filter((args) => /task queue/.test(String(args[0]))),
    [],
  );
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
  // Queue timing is validated by the core on first use, not at construction.
  assert.throws(
    () =>
      timingOf(
        new MongoTaskQueue({ model: {}, timing: { leaseMs: 0 } }),
        'default',
      ),
    (err: unknown) =>
      err instanceof ResizeConfigError &&
      err.code === 'RESIZE_CONFIG_QUEUE_LEASE_INVALID',
  );
  const t = new MongoTaskQueue({ model: {} });
  assert.equal(timingOf(t, 'default').leaseMs, 60_000);
  assert.equal(timingOf(t, 'default').maxAttempts, 5);
});

test('nothing is read from the app until first use', async () => {
  resetAppInstance();
  const r = new FrameworkResizer(); // no app yet: must not throw
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queues: { default: { driver: 'database', leaseMs: 4321 } },
    }),
  });
  await r.ready();
  assert.ok(r.tasks);
  assert.equal(timingOf(r.tasks, 'default').leaseMs, 4321);
});

test('undefined values from getTiming never override the defaults', () => {
  const t = new MongoTaskQueue({
    model: {},
    getTiming: () => ({ leaseMs: undefined, maxAttempts: 7 }),
  });
  assert.equal(timingOf(t, 'default').leaseMs, 60_000);
  assert.equal(timingOf(t, 'default').maxAttempts, 7);
});

test('verify() fails at boot when the ResizeTask model is not registered', async () => {
  const t = new MongoTaskQueue({ getModel: () => undefined });
  await assert.rejects(
    t.verify(),
    (err: unknown) =>
      err instanceof ResizeSetupError &&
      err.code === 'RESIZE_MONGO_MODEL_MISSING',
  );
  // Through the framework: verify() at boot catches a missing src/models/ResizeTask.ts.
  setAppInstance({
    getConfig: () =>
      makeResizeConfig({
        storage: localStorage,
        queues: databaseQueues,
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

test('verify() fails when the task queue does not serve the Resizer queueName', async () => {
  installApp();
  const tasks = new MemoryTaskQueue();
  Object.assign(tasks, { servesQueue: (queue: string) => queue === 'default' });
  const r = new FrameworkResizer({
    storage,
    queueName: 'bulk',
    tasks,
  });
  await assert.rejects(
    () => r.verify(),
    (err: unknown) =>
      err instanceof ResizeSetupError &&
      err.code === 'RESIZE_QUEUE_NOT_SERVED' &&
      /'bulk' \(its `queueName`\)/.test(err.message),
  );
});

test('prewarm reports a config error as a non-retryable issue', async () => {
  installApp({ resize: { mediaModelName: 'File', upload: null } });
  const r = new FrameworkResizer({ storage, tasks: new MemoryTaskQueue() });
  const result = await r.prewarm({ media: withOriginal(), sizes });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_INTERNAL_ERROR');
  assert.equal(result.issues[0].retryable, false);
});

// --- named queues in src/config/resize.ts: one task queue per backend, routed by name -------

test('two Resizers on two database queue names share one task queue; each name keeps its timing and lane', async () => {
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queues: {
        default: { driver: 'database' },
        bulk: { driver: 'database', leaseMs: 30_000 },
      },
    }),
    listings: makeResizeConfig({ storage: localStorage, queue: 'bulk' }),
  });
  const a = new FrameworkResizer();
  const b = new FrameworkResizer({ name: 'listings', configName: 'listings' });
  await a.ready();
  await b.ready();
  assert.ok(a.tasks instanceof MongoTaskQueue);
  assert.equal(a.tasks, b.tasks);
  assert.notEqual(a.media, b.media); // each Resizer keeps its own media model and config
  assert.equal(a.queueName, 'default');
  assert.equal(b.queueName, 'bulk');
  assert.equal(a.tasks.servesQueue('default'), true);
  assert.equal(a.tasks.servesQueue('bulk'), true);
  assert.equal(a.tasks.servesQueue('nope'), false);
  assert.equal(timingOf(a.tasks, 'bulk').leaseMs, 30_000);
  assert.equal(timingOf(a.tasks, 'default').leaseMs, 60_000);
  await a.verify();
  await b.verify();
});

// In a child process with the SQS SDK made missing, so importing the SQS driver would show.
test('prewarm({ queue }) naming a queue whose backend lacks its SDK reports RESIZE_QUEUE_NOT_SERVED and touches no queue', async () => {
  const href = (path: string) =>
    JSON.stringify(new URL(path, import.meta.url).href);
  const { stdout } = await runNode(process.execPath, [
    '--experimental-strip-types',
    '--input-type=module',
    '-e',
    `
      import { registerHooks } from 'node:module';
      import { setAppInstance } from '@adaptivestone/framework/helpers/appInstance.js';
      import { FrameworkResizer } from ${href('./resizer.ts')};
      import { makeResizeConfig } from ${href('../testHelpers/resizeConfig.ts')};
      const sqsDriver = [];
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === '@aws-sdk/client-sqs') {
            throw Object.assign(new Error("Cannot find package '@aws-sdk/client-sqs' imported from driver"), { code: 'ERR_MODULE_NOT_FOUND' });
          }
          const resolved = nextResolve(specifier, context);
          if (resolved.url.endsWith('/drivers/sqs.ts')) {
            sqsDriver.push(resolved.url);
          }
          return resolved;
        },
      });
      const configs = {
        resize: makeResizeConfig({
          storage: { driver: 'local', rootDir: './var/media', publicBaseUrl: '/media' },
          queues: {
            default: { driver: 'database' },
            bulk: { driver: 'sqs', queueUrl: 'https://sqs.example/bulk' },
          },
        }),
      };
      const models = [];
      setAppInstance({
        getConfig: (name) => configs[name] ?? {},
        getModel: (name) => {
          models.push(name);
          return { findById: async () => null };
        },
        logger: { info() {}, warn() {}, error() {} },
      });
      const resizer = new FrameworkResizer();
      const result = await resizer.prewarm({
        media: { id: 'm1', original: { storageRef: { key: 'k' }, format: 'png' } },
        sizes: [{ width: 10, height: 10 }],
        queue: 'bulk',
      });
      console.log(JSON.stringify({
        status: result.status,
        requested: result.requested.length,
        unconfirmed: result.unconfirmed.length,
        tasks: result.tasks.length,
        issues: result.issues.map(({ code, retryable }) => ({ code, retryable })),
        queue: resizer.tasks.constructor.name,
        models,
        sqsDriver,
      }));
    `,
  ]);
  const seen = JSON.parse(stdout);
  assert.equal(seen.status, 'incomplete');
  assert.ok(seen.requested > 0);
  assert.equal(seen.unconfirmed, seen.requested);
  assert.equal(seen.tasks, 0);
  assert.deepEqual(seen.issues, [
    { code: 'RESIZE_QUEUE_NOT_SERVED', retryable: false },
  ]);
  assert.equal(seen.queue, 'MongoTaskQueue'); // the Resizer's own queue, 'default'
  assert.equal(seen.models.includes('ResizeTask'), false);
  assert.deepEqual(seen.sqsDriver, []); // so no RESIZE_PEER_MISSING either
});

test('an old-shape queue section fails first use, verify() and worker start with RESIZE_CONFIG_REMOVED_KEY; resolve() still never throws', async () => {
  const { logger } = installApp({
    resize: {
      ...makeResizeConfig({ storage: localStorage }),
      queue: { driver: 'database' },
    },
    resizeListings: makeResizeConfig({ storage: localStorage }),
  });
  logger.error = () => {};
  const removed = (err: unknown) =>
    err instanceof ResizeConfigError &&
    err.code === 'RESIZE_CONFIG_REMOVED_KEY' &&
    /queues: \{ default: \{ driver: 'database'/.test(err.message) &&
    /queue: 'default'/.test(err.message);
  const r = new FrameworkResizer();
  await assert.rejects(() => r.ready(), removed);
  await assert.rejects(() => r.verify(), removed);
  const { decision } = await r.resolve({ media: withOriginal(), sizes });
  assert.deepEqual(decision, { ready: [], missing: [] });
  // Another Resizer's queue is looked up in resize.ts, so it fails as well.
  const listings = new FrameworkResizer({
    name: 'listings',
    configName: 'resizeListings',
  });
  await assert.rejects(() => listings.verify(), removed);
  await assert.rejects(() => runResizeWorker(), removed);
});

test("a file without queue uses 'default'; without a 'default' entry that is RESIZE_CONFIG_QUEUE_UNKNOWN", async () => {
  installApp({
    resize: makeResizeConfig({ storage: localStorage, queues: databaseQueues }),
    resizeListings: makeResizeConfig({ storage: localStorage, queue: 'nope' }),
  });
  const r = new FrameworkResizer();
  await r.ready();
  assert.equal(r.queueName, 'default');
  assert.ok(r.tasks instanceof MongoTaskQueue);
  const listings = new FrameworkResizer({
    name: 'listings',
    configName: 'resizeListings',
  });
  await assert.rejects(
    () => listings.ready(),
    configError(
      'RESIZE_CONFIG_QUEUE_UNKNOWN',
      "resize config: Resizer 'listings' queues to 'nope', which `queues` in src/config/resize.ts does not define — add queues.nope, set `queue` to a defined name, or queue: false for eager only",
    ),
  );
  // A name from the `queueName` option: the fix names the option (it wins over the file).
  const byOption = new FrameworkResizer({
    name: 'byOption',
    queueName: 'nope',
  });
  await assert.rejects(
    () => byOption.ready(),
    configError(
      'RESIZE_CONFIG_QUEUE_UNKNOWN',
      "resize config: Resizer 'byOption' queues to 'nope', which `queues` in src/config/resize.ts does not define — add queues.nope, set `queueName` to a defined name, or pass tasks: false for eager only",
    ),
  );
  resetResizerForTests();
  resetAppInstance();

  const { logger } = installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queues: { bulk: { driver: 'database' } },
    }),
  });
  logger.error = () => {};
  const implied = new FrameworkResizer();
  await assert.rejects(
    () => implied.verify(),
    configError(
      'RESIZE_CONFIG_QUEUE_UNKNOWN',
      `resize config: Resizer 'default' queues to 'default' (the default when src/config/resize.ts ${OVERRIDE} sets no \`queue\`), which \`queues\` in src/config/resize.ts does not define — add queues.default, set \`queue\` to a defined name, or queue: false for eager only`,
    ),
  );
  const { decision } = await implied.resolve({ media: withOriginal(), sizes });
  assert.deepEqual(decision, { ready: [], missing: [] });
});

test('a queues entry set to undefined (an environment file removing it) is not defined: a Resizer naming it is RESIZE_CONFIG_QUEUE_UNKNOWN', async () => {
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queues: { ...databaseQueues, bulk: undefined },
    }),
    resizeBulk: makeResizeConfig({ storage: localStorage, queue: 'bulk' }),
  });
  const r = new FrameworkResizer();
  await r.ready();
  assert.equal(r.queueName, 'default');
  const bulk = new FrameworkResizer({ name: 'bulk', configName: 'resizeBulk' });
  await assert.rejects(
    () => bulk.ready(),
    configError(
      'RESIZE_CONFIG_QUEUE_UNKNOWN',
      "Resizer 'bulk' queues to 'bulk', which `queues` in src/config/resize.ts does not define",
    ),
  );
});

test('without queues a Resizer is eager only; queue: false is eager only beside queues', async () => {
  installApp({ resize: makeResizeConfig({ storage: localStorage }) });
  const none = new FrameworkResizer();
  await none.verify();
  assert.equal(none.tasks, undefined);
  assert.equal(none.locks, undefined);
  assert.equal(none.queueName, 'default');
  resetResizerForTests();
  resetAppInstance();

  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queue: false,
      queues: databaseQueues,
    }),
    resizeListings: makeResizeConfig({ storage: localStorage }),
  });
  const off = new FrameworkResizer();
  await off.verify();
  assert.equal(off.tasks, undefined);
  assert.equal(off.locks, undefined);
  assert.equal(off.queueName, 'default');
  // queue: false belongs to its own file: a Resizer whose file sets no queue still queues.
  const listings = new FrameworkResizer({
    name: 'listings',
    configName: 'resizeListings',
  });
  await listings.verify();
  assert.ok(listings.tasks instanceof MongoTaskQueue);
});

test('tasks from code never choose a lane from queues: an undefined queue name in the file is no error', async () => {
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queue: 'nope',
      queues: databaseQueues,
    }),
  });
  const tasks = new MemoryTaskQueue();
  const own = new FrameworkResizer({ tasks });
  await own.verify();
  assert.equal(own.queueName, 'nope');
  assert.equal(own.tasks, tasks);
  const eager = new FrameworkResizer({ name: 'eager', tasks: false });
  await eager.verify();
  assert.equal(eager.queueName, 'nope');
  assert.equal(eager.tasks, undefined);
  resetResizerForTests();
  resetAppInstance();

  // No resize.ts is needed: the lane comes from code, and a missing file has no coordination.
  installApp({
    resize: {},
    resizeListings: makeResizeConfig({ storage: localStorage }),
  });
  const listings = new FrameworkResizer({
    name: 'listings',
    configName: 'resizeListings',
    tasks: new MemoryTaskQueue(),
  });
  await listings.verify();
  assert.equal(listings.queueName, 'default');
  resetResizerForTests();
  resetAppInstance();

  // A present resize.ts is validated as a whole whenever it is read (Ruling S2b-6): the
  // coordination comes from the same file, so a broken queues section still fails verify().
  // Only with the coordination from code too is the process-wide part never read.
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queue: false,
      queues: { default: { driver: 'redis' } } as never,
    }),
  });
  const broken = new FrameworkResizer({ tasks: new MemoryTaskQueue() });
  await assert.rejects(
    broken.verify(),
    configError(
      'RESIZE_CONFIG_INVALID',
      '`queues.default` in src/config/resize.ts',
    ),
  );
  const coded = new FrameworkResizer({
    name: 'coded',
    tasks: new MemoryTaskQueue(),
    coordination: {},
  });
  await coded.verify();
  assert.equal(coded.queueName, 'default');
});

test('with tasks in code, a broken process section is the degraded mode: stored previews are served, nothing is queued, generate() and invalidate() work, prewarm() and verify() report it', async () => {
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      worker: { enabled: 'yes' } as never,
    }),
  });
  const red = await sharp({
    create: { width: 32, height: 32, channels: 3, background: '#f00' },
  })
    .png()
    .toBuffer();
  const tasks = new MemoryTaskQueue();
  // The media store holds the rows generate() writes, and loads them back for invalidate().
  const stored = new Map<string, Preview[]>();
  const store = fakeMedia({
    previews: stored,
    load: async (id) =>
      stored.has(id) ? { id, previews: [...(stored.get(id) ?? [])] } : null,
  });
  const replace = mock.method(store, 'replacePreviews');
  const r = new FrameworkResizer({
    storage: {
      download: async () => red,
      upload: async ({ key }) => ({ key }),
      publicUrl: () => '',
    },
    media: store,
    tasks,
  });
  await r.ready();
  const media = {
    id: 'm1',
    original: {
      storageRef: { key: 'k' },
      format: 'png',
      width: 32,
      height: 32,
    },
  };

  const { created, failed } = await r.generate({
    media,
    sizes,
    formats: ['webp'],
  });
  assert.equal(created.length, 1);
  assert.equal(failed, 0);
  assert.equal(stored.get('m1')?.length, 1);

  const { decision } = await r.resolve({
    media,
    sizes: [...sizes, { width: 20, height: 20 }],
    formats: ['webp'],
  });
  assert.equal(decision.ready.length, 1);
  assert.equal(decision.missing.length, 1);
  assert.deepEqual(tasks.added, []);
  // prewarm() reports it; invalidate() works.
  const warmed = await r.prewarm({ media, sizes: [{ width: 20, height: 20 }] });
  assert.equal(warmed.status, 'incomplete');
  assert.equal(warmed.issues[0]?.retryable, false);
  assert.match(warmed.issues[0]?.message ?? '', /`worker\.enabled`/);
  assert.deepEqual(tasks.added, []);
  assert.deepEqual(await r.invalidate({ media }), [created[0].storageRef]);
  assert.equal(replace.mock.callCount(), 1);
  assert.deepEqual(stored.get('m1'), []);

  await assert.rejects(
    r.verify(),
    configError('RESIZE_CONFIG_INVALID', 'worker'),
  );
});

test('a queueName option is readable before first use; a name from the file is RESIZE_NOT_READY until then', async () => {
  resetAppInstance();
  const byOption = new FrameworkResizer({ queueName: 'bulk' });
  assert.equal(byOption.queueName, 'bulk'); // no app yet
  const byFile = new FrameworkResizer({ name: 'file' });
  assert.throws(
    () => byFile.queueName,
    (err: unknown) =>
      err instanceof ResizeSetupError && err.code === 'RESIZE_NOT_READY',
  );
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queue: 'bulk',
      queues: { ...databaseQueues, bulk: { driver: 'database' } },
    }),
  });
  await byFile.ready();
  assert.equal(byFile.queueName, 'bulk');
  await byOption.ready();
  assert.equal(byOption.queueName, 'bulk');
  assert.equal(byOption.tasks, byFile.tasks);
});

test('SQS entries with the same connection settings share one SqsTaskQueue; a different dead-letter queue is another backend', async () => {
  const connection = {
    driver: 'sqs' as const,
    region: 'eu-west-1',
    deadLetterQueueUrl: 'https://sqs.example/dead',
  };
  const queues: Record<string, QueueConfig> = {
    default: { ...connection, queueUrl: 'https://sqs.example/resize' },
    // The driver's default long poll, written out: the same backend.
    bulk: {
      ...connection,
      queueUrl: 'https://sqs.example/bulk',
      waitTimeSeconds: 10,
    },
    audit: {
      ...connection,
      queueUrl: 'https://sqs.example/audit',
      deadLetterQueueUrl: 'https://sqs.example/dead-audit',
    },
  };
  installApp({
    resize: makeResizeConfig({ storage: localStorage, queues }),
    resizeBulk: makeResizeConfig({ storage: localStorage, queue: 'bulk' }),
    resizeAudit: makeResizeConfig({ storage: localStorage, queue: 'audit' }),
  });
  assert.equal(sqsBackendKey(queues.default), sqsBackendKey(queues.bulk));
  assert.notEqual(sqsBackendKey(queues.default), sqsBackendKey(queues.audit));
  const media = new FrameworkResizer();
  const bulk = new FrameworkResizer({ name: 'bulk', configName: 'resizeBulk' });
  const audit = new FrameworkResizer({
    name: 'audit',
    configName: 'resizeAudit',
  });
  await Promise.all([media, bulk, audit].map((r) => r.ready()));
  // The two backends route: every Resizer shares one router.
  assert.ok(media.tasks);
  assert.equal(bulk.tasks, media.tasks);
  assert.equal(audit.tasks, media.tasks);
  const shared = await carrierOf(media.tasks, 'default');
  assert.ok(shared instanceof SqsTaskQueue);
  assert.equal(await carrierOf(media.tasks, 'bulk'), shared);
  const other = await carrierOf(media.tasks, 'audit');
  assert.ok(other instanceof SqsTaskQueue);
  assert.notEqual(other, shared);
  assert.equal(media.tasks.servesQueue?.('audit'), true);
});

// In a child process, where the SQS driver has not been imported yet: its first import fails.
test('a per-backend task queue whose build failed is built again on the next call', async () => {
  const href = (path: string) =>
    JSON.stringify(new URL(path, import.meta.url).href);
  const { stdout } = await runNode(process.execPath, [
    '--experimental-strip-types',
    '--input-type=module',
    '-e',
    `
      import { registerHooks } from 'node:module';
      import { setAppInstance } from '@adaptivestone/framework/helpers/appInstance.js';
      import { FrameworkResizer } from ${href('./resizer.ts')};
      import { makeResizeConfig } from ${href('../testHelpers/resizeConfig.ts')};
      let imports = 0;
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === '../drivers/sqs.ts' && context.parentURL?.endsWith('/factory/builtins.ts')) {
            imports += 1;
            if (imports === 1) {
              throw Object.assign(new Error('the first import fails'), { code: 'ERR_TEST_TRANSIENT' });
            }
          }
          return nextResolve(specifier, context);
        },
      });
      const configs = {
        resize: makeResizeConfig({
          storage: { driver: 'local', rootDir: './var/media', publicBaseUrl: '/media' },
          queues: { default: { driver: 'sqs', queueUrl: 'https://sqs.example/resize' } },
        }),
      };
      setAppInstance({
        getConfig: (name) => configs[name] ?? {},
        getModel: () => ({ findById: async () => null }),
        logger: { info() {}, warn() {}, error() {} },
      });
      const resizer = new FrameworkResizer();
      const first = await resizer.ready().then(() => 'resolved', (err) => err.code);
      await resizer.ready();
      // A build that succeeded is kept: another Resizer on the backend shares it.
      const other = new FrameworkResizer({ name: 'other' });
      await other.ready();
      console.log(JSON.stringify({
        first,
        imports,
        queue: resizer.tasks.constructor.name,
        shared: other.tasks === resizer.tasks,
      }));
    `,
  ]);
  const seen = JSON.parse(stdout);
  assert.equal(seen.first, 'ERR_TEST_TRANSIENT');
  assert.equal(seen.imports, 2);
  assert.equal(seen.queue, 'SqsTaskQueue');
  assert.equal(seen.shared, true);
});

test('resetResizerForTests forgets the per-backend task queues', async () => {
  const file = makeResizeConfig({
    storage: localStorage,
    queues: {
      default: { driver: 'database', maxAttempts: 3 },
      sqs: { driver: 'sqs', queueUrl: 'https://sqs.example/resize' },
    },
  });
  installApp({
    resize: file,
    resizeSqs: makeResizeConfig({ storage: localStorage, queue: 'sqs' }),
  });
  const first = new FrameworkResizer();
  const firstSqs = new FrameworkResizer({
    name: 'sqs',
    configName: 'resizeSqs',
  });
  await Promise.all([first.ready(), firstSqs.ready()]);
  assert.ok(first.tasks);
  assert.equal(timingOf(first.tasks, 'default').maxAttempts, 3);

  resetResizerForTests();
  // The same app with a changed file: the queues are new objects built from it.
  Object.assign(file, {
    queues: {
      default: { driver: 'database', maxAttempts: 4 },
      sqs: { driver: 'sqs', queueUrl: 'https://sqs.example/resize' },
    },
  });
  const next = new FrameworkResizer();
  const nextSqs = new FrameworkResizer({
    name: 'sqs',
    configName: 'resizeSqs',
  });
  await next.verify();
  await nextSqs.verify();
  assert.ok(next.tasks);
  assert.notEqual(next.tasks, first.tasks);
  assert.equal(timingOf(next.tasks, 'default').maxAttempts, 4);
  assert.ok((await carrierOf(nextSqs.tasks, 'sqs')) instanceof SqsTaskQueue);
  assert.notEqual(nextSqs.tasks, firstSqs.tasks);
});

// --- the factory under the adapter: routes, host drivers and the merged config --------------

test('a database Resizer beside an unused SQS entry with its SDK: verify() needs no Lock model, and the SQS backend is never built', async (t) => {
  const built = t.mock.method(SqsTaskQueue, 'fromConfig');
  const asked: string[] = [];
  setAppInstance({
    getConfig: () =>
      makeResizeConfig({
        storage: localStorage,
        queues: {
          default: { driver: 'database' },
          bulk: { driver: 'sqs', queueUrl: 'https://sqs.example/bulk' },
        },
      }),
    getModel: (name: string) => {
      asked.push(name);
      return name === 'Lock' ? undefined : { findById: async () => null };
    },
    logger: { info() {}, warn() {}, error() {} },
  } as never);
  const r = new FrameworkResizer();
  await r.verify();
  assert.ok(r.tasks instanceof RoutingTaskQueue);
  assert.ok((await carrierOf(r.tasks, 'default')) instanceof MongoTaskQueue);
  assert.equal(asked.includes('Lock'), false);
  assert.equal(built.mock.callCount(), 0);
});

test('a host driver registered under sqs has its own validate run after the built-in SQS checks of the file', async () => {
  const seen: string[][] = [];
  const sqs = {
    validate(entries: ReadonlyArray<{ name: string }>) {
      seen.push(entries.map((entry) => entry.name));
      throw new ResizeConfigError('custom', { code: 'X_INVALID' } as never);
    },
    fromConfig: () => new PlainTaskQueue(),
  };
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queues: {
        default: { driver: 'sqs', queueUrl: 'https://sqs.example/resize' },
      },
    }),
  });
  const r = new FrameworkResizer({ drivers: { queue: { sqs } } });
  await assert.rejects(r.verify(), configError('X_INVALID', 'custom'));
  assert.deepEqual(seen.at(-1), ['default']);
  resetResizerForTests();
  resetAppInstance();

  // The built-in SQS checks run when the file is read, before the host's validate.
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queues: { default: { driver: 'sqs' } } as never,
    }),
  });
  const calls = seen.length;
  const missingUrl = new FrameworkResizer({ drivers: { queue: { sqs } } });
  await assert.rejects(
    missingUrl.verify(),
    configError('RESIZE_CONFIG_INVALID', '`queues.default.queueUrl`'),
  );
  assert.equal(seen.length, calls);
});

test('a custom storage driver named in the config file', async () => {
  installApp({
    resize: makeResizeConfig({
      storage: { driver: 'gcs', bucket: 'b' } as never,
    }),
  });
  const gcs = memoryStorageDriver();
  const r = new FrameworkResizer({ drivers: { storage: { gcs } } });
  await r.ready();
  assert.equal(gcs.built.length, 1);
  assert.equal(r.storage, gcs.built[0]);
  // Without it registered, the name is refused, listing the registered ones.
  const unregistered = new FrameworkResizer({ name: 'unregistered' });
  await assert.rejects(
    unregistered.verify(),
    configError(
      'RESIZE_CONFIG_INVALID',
      `\`storage\` in src/config/resize.ts ${OVERRIDE} needs driver 'local' or 's3'`,
    ),
  );
});

test('an unregistered storage driver in the `config` option throws at construction, as in rc.2, even with every part in code', () => {
  installApp();
  const config = makeResizeConfig({ storage: { driver: 'gcs' } as never });
  const unregistered = configError(
    'RESIZE_CONFIG_INVALID',
    "resize config: `storage` in the config passed to new FrameworkResizer() needs driver 'local' or 's3'",
  );
  assert.throws(() => new FrameworkResizer({ config }), unregistered);
  assert.throws(
    () =>
      new FrameworkResizer({
        config,
        storage,
        tasks: new MemoryTaskQueue(),
        queueName: 'default',
      }),
    unregistered,
  );
  // The name stays free.
  assert.equal(new FrameworkResizer({ storage }).name, 'default');
});

test('a partial config file is merged over the package defaults; a complete one reaches the Resizer with the same objects', async () => {
  const complete = makeResizeConfig({ storage: localStorage });
  installApp({
    resize: { mediaModelName: 'File', storage: localStorage },
    resizeComplete: complete,
    resizeWebp: {
      mediaModelName: 'File',
      storage: localStorage,
      formats: ['webp'],
      encode: { formats: { webp: {} } },
    },
  });
  const partial = new FrameworkResizer();
  assert.deepEqual(partial.config, defaultResizeConfig);
  const whole = new FrameworkResizer({
    name: 'complete',
    configName: 'resizeComplete',
  });
  assert.equal(whole.config.formats, complete.formats);
  assert.equal(whole.config.encode, complete.encode);
  assert.equal(whole.config.limits, complete.limits);
  // `encode.formats` replaces as a whole: a per-call jpeg is not configured.
  const webp = new FrameworkResizer({
    name: 'webp',
    configName: 'resizeWebp',
    tasks: new MemoryTaskQueue(),
  });
  assert.deepEqual(
    webp.config.encode.sharpen,
    defaultResizeConfig.encode.sharpen,
  );
  const result = await webp.prewarm({
    media: withOriginal(),
    sizes,
    formats: ['jpeg'],
  });
  assert.equal(result.issues[0]?.code, 'RESIZE_FORMAT_NOT_CONFIGURED');
  assert.equal(result.unconfirmed.length, result.requested.length);
});

test('resizer.media is readable before first use, as before', async () => {
  resetAppInstance();
  const r = new FrameworkResizer();
  assert.ok(r.media instanceof FrameworkMediaStore);
  const explicit = new FrameworkResizer({
    name: 'explicit',
    config: makeResizeConfig({ mediaModelName: 'Photo' }),
  });
  assert.ok(explicit.media instanceof FrameworkMediaStore);
  // A lock store computed from a task queue in code is readable at once too.
  const plain = new FrameworkResizer({
    name: 'plain',
    tasks: new PlainTaskQueue(),
  });
  assert.ok(plain.locks instanceof FrameworkLockStore);
  const { asked } = installApp();
  await explicit.media.loadMedia('m1');
  await r.media.loadMedia('m2');
  assert.deepEqual(asked, ['Photo', 'File']);
});

test('two FrameworkResizers share one queue set built with the app logger; a different queue driver map is RESIZE_DRIVER_CONFLICT from the constructor', async () => {
  const { logger: app } = installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queues: {
        default: { driver: 'sqs', queueUrl: 'https://sqs.example/resize' },
      },
    }),
    resizeB: makeResizeConfig({ storage: localStorage }),
  });
  const appWarnings: unknown[] = [];
  app.warn = (msg: unknown) => {
    appWarnings.push(msg);
  };
  const ownWarnings: unknown[] = [];
  const plain = fakeQueueDriver();
  const sqs = {
    fromConfig: (
      entries: Parameters<typeof plain.fromConfig>[0],
      ctx: Parameters<typeof plain.fromConfig>[1],
    ) => {
      ctx.logger.warn('built');
      return plain.fromConfig(entries, ctx);
    },
  };
  const a = new FrameworkResizer({
    drivers: { queue: { sqs } },
    logger: {
      info() {},
      warn: (msg: unknown) => {
        ownWarnings.push(msg);
      },
      error() {},
    },
  });
  // Another map object holding the same drivers is no conflict.
  const b = new FrameworkResizer({
    name: 'b',
    configName: 'resizeB',
    drivers: { queue: { sqs } },
  });
  await a.ready();
  await b.ready();
  assert.ok(a.tasks instanceof PlainTaskQueue);
  assert.equal(b.tasks, a.tasks);
  assert.equal(plain.built.length, 1);
  assert.deepEqual(appWarnings, ['built']);
  assert.deepEqual(ownWarnings, []);
  const conflict = (key: string) => (err: unknown) =>
    err instanceof ResizeSetupError &&
    err.code === 'RESIZE_DRIVER_CONFLICT' &&
    err.retryable === false &&
    err.message.includes(`\`drivers.queue.${key}\``);
  assert.throws(
    () =>
      new FrameworkResizer({
        name: 'c',
        drivers: { queue: { sqs: fakeQueueDriver() } },
      }),
    conflict('sqs'),
  );
  assert.throws(() => new FrameworkResizer({ name: 'c' }), conflict('sqs'));
  assert.throws(
    () =>
      new FrameworkResizer({
        name: 'c',
        drivers: { queue: { sqs, plain: fakeQueueDriver() } },
      }),
    conflict('plain'),
  );
  // The name stays free.
  assert.equal(
    new FrameworkResizer({ name: 'c', drivers: { queue: { sqs } } }).name,
    'c',
  );
  resetResizerForTests();

  // The other order: a Resizer without drivers first.
  new FrameworkResizer();
  assert.throws(
    () => new FrameworkResizer({ name: 'd', drivers: { queue: { sqs } } }),
    conflict('sqs'),
  );
});

test('the queue drivers are recorded only by a construction that succeeds, as they were passed then', () => {
  installApp();
  const sqs = fakeQueueDriver();
  // A construction that fails after the drivers are checked records nothing.
  assert.throws(
    () => new FrameworkResizer({ name: '', drivers: { queue: { sqs } } }),
    (err: unknown) =>
      err instanceof ResizeSetupError && err.code === 'RESIZE_NAME_INVALID',
  );
  assert.equal(new FrameworkResizer({ storage }).name, 'default');
  resetResizerForTests();

  // A host that changes its map object later changes nothing that is compared.
  const queue: Record<string, unknown> = { sqs };
  new FrameworkResizer({ drivers: { queue } as never });
  queue.sqs = fakeQueueDriver();
  queue.plain = fakeQueueDriver();
  assert.equal(
    new FrameworkResizer({ name: 'b', drivers: { queue: { sqs } } }).name,
    'b',
  );
});
