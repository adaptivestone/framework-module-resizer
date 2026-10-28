import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { promisify } from 'node:util';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import type { ResizeStorage } from '../contracts/storage.ts';
import type { LeasedTask } from '../contracts/taskQueue.ts';
import { LocalFsStorage } from '../drivers/fs.ts';
import { MongoTaskQueue } from '../drivers/mongo/taskQueue.ts';
import { S3Storage } from '../drivers/s3.ts';
import { SqsTaskQueue } from '../drivers/sqs.ts';
import { ResizeConfigError, ResizeSetupError } from '../errors.ts';
import {
  processorOf,
  resetResizerForTests,
  taskCoordinationOf,
} from '../resizer.ts';
import {
  fakeMedia,
  MemoryTaskQueue,
  memoryLocks,
  PlainTaskQueue,
} from '../testHelpers/fakes.ts';
import { makeResizeConfig } from '../testHelpers/resizeConfig.ts';
import { timingOf } from '../timing.ts';
import type { QueueConfig } from '../types.d.ts';
import { getProcessConfig } from './config.ts';
import { FrameworkLockStore } from './locks.ts';
import { FrameworkMediaStore } from './media.ts';
import { backendKey, taskQueueOf } from './queue.ts';
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
  const processConfig = getProcessConfig();
  assert.equal(
    r.tasks,
    await taskQueueOf(
      processConfig.queues.get('default') as never,
      processConfig,
    ),
  );
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

// --- named queues in src/config/resize.ts: one task queue per backend ----------------------

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
test('prewarm({ queue }) naming a queue on another backend reports RESIZE_QUEUE_NOT_SERVED and touches no queue', async () => {
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

test('tasks from code never read queues: an undefined queue name in the file is no error', async () => {
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

  // Not even a broken queues section is read (the coordination comes from code too).
  installApp({
    resize: makeResizeConfig({
      storage: localStorage,
      queue: false,
      queues: { default: { driver: 'redis' } } as never,
    }),
  });
  const coded = new FrameworkResizer({
    tasks: new MemoryTaskQueue(),
    coordination: {},
  });
  await coded.verify();
  assert.equal(coded.queueName, 'default');
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
  assert.equal(backendKey(queues.default), backendKey(queues.bulk));
  assert.notEqual(backendKey(queues.default), backendKey(queues.audit));
  const media = new FrameworkResizer();
  const bulk = new FrameworkResizer({ name: 'bulk', configName: 'resizeBulk' });
  const audit = new FrameworkResizer({
    name: 'audit',
    configName: 'resizeAudit',
  });
  await Promise.all([media, bulk, audit].map((r) => r.ready()));
  assert.ok(media.tasks instanceof SqsTaskQueue);
  assert.equal(bulk.tasks, media.tasks);
  assert.ok(audit.tasks instanceof SqsTaskQueue);
  assert.notEqual(audit.tasks, media.tasks);
  assert.equal(media.tasks.servesQueue('bulk'), true);
  assert.equal(media.tasks.servesQueue('audit'), false);
  assert.equal(audit.tasks.servesQueue('audit'), true);
  assert.equal(audit.tasks.servesQueue('default'), false);
});

test('backendKey: one database backend; SQS by region, endpoint, dead-letter queue and effective long poll', () => {
  assert.equal(backendKey({ driver: 'database', leaseMs: 1 }), 'database');
  const sqs = { driver: 'sqs' as const, queueUrl: 'https://sqs.example/a' };
  assert.equal(backendKey(sqs), 'sqs:[null,null,null,10]');
  assert.equal(
    backendKey({
      ...sqs,
      queueUrl: 'https://sqs.example/b',
      maxAttempts: 3,
      waitTimeSeconds: 10,
    }),
    backendKey(sqs),
  );
  assert.equal(
    backendKey({
      ...sqs,
      region: 'eu-west-1',
      endpoint: 'http://localhost:4566',
      deadLetterQueueUrl: 'https://sqs.example/dead',
      waitTimeSeconds: 20,
    }),
    'sqs:["eu-west-1","http://localhost:4566","https://sqs.example/dead",20]',
  );
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
  assert.ok(nextSqs.tasks instanceof SqsTaskQueue);
  assert.notEqual(nextSqs.tasks, firstSqs.tasks);
});
