import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import type { ResizeStorage } from '../contracts/storage.ts';
import type { QueueTransport } from '../contracts/transport.ts';
import { MongoTransport } from '../drivers/mongo/transport.ts';
import { ResizeSetupError } from '../errors.ts';
import { resetResizerForTests } from '../resizer.ts';
import { makeResizeConfig } from '../testHelpers/resizeConfig.ts';
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
  enqueue: async () => ({ taskId: null }),
  startWorker: async () => {},
};

function installApp(configs: Record<string, unknown> = {}) {
  const asked: string[] = [];
  const logger = { info() {}, warn() {}, error() {} };
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
  const r = createFrameworkResizer({ storage });
  assert.equal(r.logger, logger);
  assert.deepEqual(r.config.formats, ['jpeg', 'webp', 'avif']);
  assert.ok(r.mediaStore instanceof FrameworkMediaStore);
  await r.mediaStore.load('m1');
  assert.deepEqual(asked, ['File']);
});

test('adds the framework lock provider only with a transport', () => {
  installApp();
  const eager = createFrameworkResizer({ storage });
  assert.ok(!(eager.lockProvider instanceof FrameworkLockStore));
  resetResizerForTests();
  const queued = createFrameworkResizer({ storage, transport });
  assert.ok(queued.lockProvider instanceof FrameworkLockStore);
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
    transport,
    config,
    logger,
    mediaStore,
    lockProvider,
  });
  assert.equal(r.config, config);
  assert.equal(r.logger, logger);
  assert.equal(r.mediaStore, mediaStore);
  assert.equal(r.lockProvider, lockProvider);
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
  assert.equal(createFrameworkMongoTransport({ leaseMs: 99 }).leaseMs, 99);
});

test('a core MongoTransport needs exactly one of model or getModel', () => {
  for (const opts of [{}, { model: {}, getModel: () => ({}) }]) {
    assert.throws(
      () => new MongoTransport(opts as never),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_MONGO_MODEL_REQUIRED',
    );
  }
  assert.equal(new MongoTransport({ model: {} }).leaseMs, 60_000);
});
