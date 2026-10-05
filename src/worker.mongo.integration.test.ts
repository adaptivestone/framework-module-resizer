// End-to-end worker routing on a real Mongo queue: one worker process serves two Resizers that
// share a task queue, and named queues are isolated from each other.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import LockModel from '@adaptivestone/framework/models/Lock.js';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import sharp from 'sharp';
import type { ResizeDatabase } from './contracts/database.ts';
import type { ResizeStorage } from './contracts/storage.ts';
import { FrameworkDatabase } from './framework/database.ts';
import ResizeTaskModel from './framework/ResizeTaskModel.ts';
import { createFrameworkResizer } from './framework/resizer.ts';
import { resetResizerForTests } from './resizer.ts';
import { fakeDb } from './testHelpers/fakes.ts';
import { makeResizeConfig } from './testHelpers/resizeConfig.ts';
import type { MediaLike, Preview } from './types.d.ts';
import { runWorker } from './worker.ts';

const png = await sharp({
  create: {
    width: 32,
    height: 32,
    channels: 3,
    background: { r: 0, g: 128, b: 255 },
  },
})
  .png()
  .toBuffer();

let server: MongoMemoryServer;
let connection: mongoose.Connection;
let taskModel: mongoose.Model<Record<string, unknown>>;
let lockModel: mongoose.Model<Record<string, unknown>>;

before(async () => {
  server = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  connection = await mongoose
    .createConnection(server.getUri(), {
      dbName: `resize_worker_${process.pid}`,
    })
    .asPromise();
  const taskSchema = new mongoose.Schema(ResizeTaskModel.modelSchema, {
    timestamps: true,
    minimize: false,
  });
  ResizeTaskModel.initHooks(taskSchema);
  const lockSchema = new mongoose.Schema(LockModel.modelSchema, {
    timestamps: true,
    minimize: false,
    statics: LockModel.modelStatics,
  });
  LockModel.initHooks(lockSchema);
  taskModel = connection.model('ResizeTask', taskSchema);
  lockModel = connection.model('Lock', lockSchema);
  await Promise.all([taskModel.init(), lockModel.init()]);
});

after(async () => {
  await connection.close();
  await server.stop();
});

function installApp() {
  resetResizerForTests();
  resetAppInstance();
  setAppInstance({
    getConfig: () =>
      makeResizeConfig({
        formats: ['webp'],
        worker: { enabled: true },
        queue: {
          leaseMs: 5000,
          idlePollMs: 20,
          lockTtlMs: { dispatch: 60000, worker: 5000 },
        },
      }),
    getModel: (name: string) =>
      name === 'ResizeTask' ? taskModel : name === 'Lock' ? lockModel : false,
    logger: { info() {}, warn() {}, error() {} },
  } as never);
}

// In-memory storage: every download returns the test PNG; uploads are recorded.
function memoryStorage(): { storage: ResizeStorage; uploads: string[] } {
  const uploads: string[] = [];
  const storage: ResizeStorage = {
    download: async () => png,
    upload: async ({ key }) => {
      uploads.push(key);
      return { key };
    },
    publicUrl: (ref) => `/m/${(ref as { key: string }).key}`,
  };
  return { storage, uploads };
}

// In-memory media with the shared database's real Mongo locks.
function memoryDatabase(
  media: MediaLike,
  shared: ResizeDatabase,
): ResizeDatabase {
  return fakeDb({
    load: async (id) => (id === media.id ? media : null),
    appendPreviews: async (_id, previews: Preview[]) => {
      media.previews = [...(media.previews ?? []), ...previews];
    },
    locks: {
      acquire: (key, ttlMs) => shared.acquireLock(key, ttlMs),
      release: (key) => shared.releaseLock(key),
    },
  });
}

function newMedia(): MediaLike {
  return {
    id: String(new mongoose.Types.ObjectId()),
    original: { storageRef: { key: 'originals/a.png' }, format: 'png' },
    previews: [],
  };
}

async function waitFor(pred: () => boolean, ms = 20000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) {
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sizes = [{ width: 16, height: 16 }];

test('one worker serves two Resizers that share a task queue', async () => {
  installApp();
  await taskModel.deleteMany({});
  const shared = new FrameworkDatabase();
  assert.ok(shared.tasks);
  const tasks = shared.tasks;
  const stop = new AbortController();
  const mediaA = newMedia();
  const mediaB = newMedia();
  const a = memoryStorage();
  const b = memoryStorage();
  const media = createFrameworkResizer({
    storage: a.storage,
    tasks,
    db: memoryDatabase(mediaA, shared),
  });
  const listings = createFrameworkResizer({
    name: 'listings',
    storage: b.storage,
    tasks,
    db: memoryDatabase(mediaB, shared),
  });

  assert.equal(
    (await media.prewarm({ media: mediaA, sizes })).accepted.length,
    1,
  );
  assert.equal(
    (await listings.prewarm({ media: mediaB, sizes })).accepted.length,
    1,
  );

  const done = runWorker({ signal: stop.signal });
  try {
    await waitFor(
      () =>
        (mediaA.previews?.length ?? 0) > 0 &&
        (mediaB.previews?.length ?? 0) > 0,
    );
  } finally {
    stop.abort();
    await done;
  }

  // Each media was generated through its own Resizer's storage.
  assert.equal(a.uploads.length, 1);
  assert.equal(b.uploads.length, 1);
  const rows = await taskModel.find({}).lean();
  assert.deepEqual(rows.map((r) => r.resizer).sort(), ['default', 'listings']);
  assert.ok(rows.every((r) => r.status === 'completed'));
});

test('a bulk-queue task waits for a bulk worker', async () => {
  installApp();
  await taskModel.deleteMany({});
  const media = newMedia();
  const memory = memoryStorage();
  const shared = new FrameworkDatabase();
  assert.ok(shared.tasks);
  const tasks = shared.tasks;

  const first = new AbortController();
  const resizer = createFrameworkResizer({
    storage: memory.storage,
    tasks,
    db: memoryDatabase(media, shared),
  });
  assert.equal(
    (await resizer.prewarm({ media, sizes, queue: 'bulk' })).accepted.length,
    1,
  );

  // The default-queue worker leaves the bulk task alone.
  const defaultWorker = runWorker({ signal: first.signal });
  try {
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    first.abort();
    await defaultWorker;
  }
  assert.equal(media.previews?.length ?? 0, 0);
  const pending = await taskModel.findOne({}).lean();
  assert.equal(pending?.status, 'pending');
  assert.equal(pending?.queue, 'bulk');

  // A bulk worker for the same Resizer and task queue processes it.
  const second = new AbortController();
  const bulkWorker = runWorker({ queue: 'bulk', signal: second.signal });
  try {
    await waitFor(() => (media.previews?.length ?? 0) > 0);
  } finally {
    second.abort();
    await bulkWorker;
  }
  const done = await taskModel.findOne({}).lean();
  assert.equal(done?.status, 'completed');
});
