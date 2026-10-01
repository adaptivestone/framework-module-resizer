// A host without @adaptivestone/framework: explicit config, logger and drivers, no framework app
// installed anywhere. Covers eager generation + reads and the queued Mongo flow with the core
// worker runner.
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { resetAppInstance } from '@adaptivestone/framework/helpers/appInstance.js';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import sharp from 'sharp';
import defaultResizeConfig from './config/resize.ts';
import { Resizer, resetResizerForTests } from './index.ts';
import type { LockProvider } from './locks/AbstractLockProvider.ts';
import type { MediaStore } from './mediaStore/AbstractMediaStore.ts';
import type { ResizeStorage } from './storage/AbstractStorage.ts';
import { MongoTransport } from './transports/mongo.ts';
import type { MediaLike, Preview } from './types.d.ts';
import { runWorker } from './worker.ts';

const png = await sharp({
  create: { width: 64, height: 48, channels: 3, background: '#3366cc' },
})
  .png()
  .toBuffer();

const silent = { info() {}, warn() {}, error() {} };

function memoryStorage(): ResizeStorage {
  const objects = new Map<string, Buffer>();
  let next = 0;
  return {
    download: async (ref) => {
      const bytes = objects.get((ref as { id: string }).id);
      if (!bytes) {
        throw new Error('not found');
      }
      return bytes;
    },
    upload: async ({ body }) => {
      next += 1;
      const id = `o${next}`;
      objects.set(id, Buffer.from(body));
      return { id };
    },
    publicUrl: (ref) => `/m/${(ref as { id: string }).id}`,
  };
}

function memoryMediaStore(docs: Map<string, MediaLike>): MediaStore {
  return {
    load: async (id) => docs.get(id) ?? null,
    appendPreviews: async (id, previews: Preview[]) => {
      const doc = docs.get(id);
      if (doc) {
        doc.previews = [...(doc.previews ?? []), ...previews];
      }
    },
  };
}

function memoryLocks(): LockProvider {
  const held = new Set<string>();
  return {
    acquire: async (key) => {
      if (held.has(key)) {
        return false;
      }
      held.add(key);
      return true;
    },
    release: async (key) => {
      held.delete(key);
    },
  };
}

afterEach(() => {
  resetResizerForTests();
});

test('eager: upload, generate and resolve with no framework app', async () => {
  resetAppInstance();
  const docs = new Map<string, MediaLike>();
  const resizer = new Resizer({
    config: { ...defaultResizeConfig, formats: ['webp'] },
    logger: silent,
    storage: memoryStorage(),
    mediaStore: memoryMediaStore(docs),
  });
  const media: MediaLike = {
    id: 'm1',
    original: await resizer.uploadOriginal({
      body: png,
      visibility: 'private',
    }),
    previews: [],
  };
  docs.set('m1', media);
  const sizes = [{ width: 16, height: 16 }];
  const { created } = await resizer.generate({ media, sizes });
  assert.equal(created.length, 1);
  const { decision } = await resizer.resolve({ media, sizes });
  assert.equal(decision.ready.length, 1);
  assert.match(decision.ready[0].url, /^\/m\/o\d+$/);
});

let server: MongoMemoryServer;
let connection: mongoose.Connection;

before(async () => {
  server = await MongoMemoryServer.create();
  connection = await mongoose
    .createConnection(server.getUri(), {
      dbName: `resize_framework_free_${process.pid}`,
    })
    .asPromise();
});

after(async () => {
  await connection.close();
  await server.stop();
});

test('queued: a Mongo task processed by the core worker, no framework app', async () => {
  resetAppInstance();
  // A host-defined ResizeTask model: the fields and lease index the Mongo transport uses.
  const schema = new mongoose.Schema(
    {
      fileId: { type: String, required: true },
      resizer: { type: String, default: 'default' },
      queue: { type: String, default: 'default' },
      pipeline: { type: String, default: 'default' },
      requestKey: { type: String },
      previews: [{ type: mongoose.Schema.Types.Mixed }],
      status: { type: String, default: 'pending' },
      attempts: { type: Number, default: 0 },
      leasedBy: { type: String },
      leaseToken: { type: String },
      leaseExpiresAt: { type: Date },
      completedAt: { type: Date },
      deadAt: { type: Date },
      error: { type: String },
    },
    { timestamps: true, minimize: false },
  );
  schema.index({ queue: 1, status: 1, createdAt: 1 });
  const ResizeTask = connection.model('ResizeTask', schema);
  await ResizeTask.init();

  const docs = new Map<string, MediaLike>();
  const transport = new MongoTransport({
    model: ResizeTask,
    logger: silent,
    idlePollMs: 20,
    leaseMs: 5000,
  });
  const resizer = new Resizer({
    config: {
      ...defaultResizeConfig,
      formats: ['webp'],
      queue: {
        ...defaultResizeConfig.queue,
        lockTtlMs: { dispatch: 60_000, worker: 5000 },
      },
    },
    logger: silent,
    storage: memoryStorage(),
    mediaStore: memoryMediaStore(docs),
    transport,
    lockProvider: memoryLocks(),
  });
  const media: MediaLike = {
    id: 'm2',
    original: await resizer.uploadOriginal({
      body: png,
      visibility: 'private',
    }),
    previews: [],
  };
  docs.set('m2', media);
  const sizes = [{ width: 16, height: 16 }];
  assert.equal((await resizer.prewarm({ media, sizes })).enqueued, 1);

  const stop = new AbortController();
  const worker = runWorker({ signal: stop.signal, logger: silent });
  const until = Date.now() + 20_000;
  while ((media.previews?.length ?? 0) === 0) {
    assert.ok(Date.now() < until, 'the worker did not generate the preview');
    await new Promise((r) => setTimeout(r, 20));
  }
  stop.abort();
  await worker;
  const { decision } = await resizer.resolve({ media, sizes });
  assert.equal(decision.ready.length, 1);
  const task = await ResizeTask.findOne({}).lean();
  assert.equal(task?.status, 'completed');
});
