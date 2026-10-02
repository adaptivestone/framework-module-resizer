import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import type { ResizeStorage } from '../contracts/storage.ts';
import type { QueueTransport } from '../contracts/transport.ts';
import { MongoTransport } from '../drivers/mongo/transport.ts';
import { ResizeConfigError, ResizeSetupError } from '../errors.ts';
import { resetResizerForTests } from '../resizer.ts';
import { makeResizeConfig } from '../testHelpers/resizeConfig.ts';
import { withLocks } from '../testHelpers/withLocks.ts';
import { FrameworkLockStore } from './lockStore.ts';
import { FrameworkMediaStore } from './mediaStore.ts';
import {
  createFrameworkMongoTransport,
  createFrameworkResizer,
} from './resizer.ts';

const storage: ResizeStorage = {
  download: async () => Buffer.alloc(0),
  upload: async ({ key }) => ({ key }),
  publicUrl: () => '',
};
const transport: QueueTransport = {
  locks: { acquire: async () => true, release: async () => {} },
  enqueue: async () => ({ taskId: null }),
  startWorker: async () => {},
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

test('fills config, logger, events and the media store from the app', async () => {
  const { asked, logger } = installApp();
  const seen: unknown[] = [];
  logger.info = (msg: unknown) => {
    seen.push(msg);
  };
  const r = createFrameworkResizer({ storage });
  r.logger.info('hello');
  assert.deepEqual(seen, ['hello']); // the app logger, resolved at call time
  assert.deepEqual(r.config.formats, ['jpeg', 'webp', 'avif']);
  assert.ok(r.mediaStore instanceof FrameworkMediaStore);
  await r.mediaStore.load('m1');
  assert.deepEqual(asked, ['File']);
});

test('createFrameworkMongoTransport coordinates through the framework Lock model', () => {
  installApp();
  assert.ok(
    createFrameworkMongoTransport().locks instanceof FrameworkLockStore,
  );
  const locks = { acquire: async () => true, release: async () => {} };
  assert.equal(createFrameworkMongoTransport({ locks }).locks, locks);
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
  await listings.mediaStore.load('m1');
  await media.mediaStore.load('m2');
  assert.deepEqual(asked, ['Photo', 'File']);
});

test('explicit options win over every default', () => {
  installApp();
  const logger = { info() {}, warn() {}, error() {} };
  const mediaStore = { load: async () => null, appendPreviews: async () => {} };
  const lockProvider = { acquire: async () => true, release: async () => {} };
  const config = makeResizeConfig({ formats: ['avif'] });
  const r = createFrameworkResizer({
    storage,
    transport: withLocks(transport, lockProvider),
    config,
    logger,
    mediaStore,
  });
  assert.deepEqual(r.config.formats, ['avif']);
  assert.equal(r.config.encode, config.encode);
  assert.equal(r.logger, logger);
  assert.equal(r.mediaStore, mediaStore);
  assert.equal(r.transport?.locks, lockProvider);
});

test('createFrameworkMongoTransport takes timing from the config file', () => {
  installApp({
    resize: makeResizeConfig({
      queue: { leaseMs: 1234, lockTtlMs: { dispatch: 60000, worker: 1000 } },
    }),
  });
  const t = createFrameworkMongoTransport();
  assert.ok(t instanceof MongoTransport);
  assert.equal(t.leaseMs, 1234);
  assert.deepEqual(t.getLockTtlMs(), { dispatch: 60000, worker: 1000 });
  assert.equal(
    createFrameworkMongoTransport({
      leaseMs: 99,
      lockTtlMs: { dispatch: 60000, worker: 50 },
    }).leaseMs,
    99,
  );
});

test('a core MongoTransport needs one model and locks, and validates its timing', () => {
  const locks = { acquire: async () => true, release: async () => {} };
  for (const opts of [{ locks }, { model: {}, getModel: () => ({}), locks }]) {
    assert.throws(
      () => new MongoTransport(opts as never),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_MONGO_MODEL_REQUIRED',
    );
  }
  assert.throws(
    () => new MongoTransport({ model: {} } as never),
    (err: unknown) =>
      err instanceof ResizeSetupError && err.code === 'RESIZE_LOCKS_REQUIRED',
  );
  // A worker lock must expire within the lease (checked here now, not by the worker).
  assert.throws(
    () =>
      new MongoTransport({
        model: {},
        locks,
        leaseMs: 1000,
        lockTtlMs: { dispatch: 60000, worker: 2000 },
      }),
    (err: unknown) =>
      err instanceof ResizeConfigError &&
      err.code === 'RESIZE_CONFIG_LOCK_EXCEEDS_LEASE',
  );
  const t = new MongoTransport({ model: {}, locks });
  assert.equal(t.leaseMs, 60_000);
  assert.deepEqual(t.getLockTtlMs(), { dispatch: 60_000, worker: 60_000 });
});

test('createFrameworkMongoTransport reads nothing until first use', () => {
  resetAppInstance();
  const t = createFrameworkMongoTransport(); // no app yet: must not throw
  installApp({
    resize: makeResizeConfig({
      queue: { leaseMs: 4321, lockTtlMs: { dispatch: 60000, worker: 1000 } },
    }),
  });
  assert.equal(t.leaseMs, 4321);
});

test('undefined values from getTiming never override the defaults', () => {
  const locks = { acquire: async () => true, release: async () => {} };
  const t = new MongoTransport({
    model: {},
    locks,
    getTiming: () => ({ leaseMs: undefined, maxAttempts: 7 }),
  });
  assert.equal(t.leaseMs, 60_000);
});
