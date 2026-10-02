// A host without @adaptivestone/framework: explicit config and drivers, no framework app. Eager
// generation uses hand-written in-memory drivers (any object of the contract's shape works); the
// queued flow uses only the shipped Mongo drivers, so a plain Node app writes no driver code.
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { resetAppInstance } from '@adaptivestone/framework/helpers/appInstance.js';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import sharp from 'sharp';
import defaultResizeConfig from './config/resize.ts';
import type { MediaStore } from './contracts/mediaStore.ts';
import type { ResizeStorage } from './contracts/storage.ts';
import {
  createResizeModels,
  MongoLockStore,
  MongoMediaStore,
  MongoTransport,
} from './drivers/mongo/index.ts';
import { Resizer, resetResizerForTests } from './index.ts';
import { resizeMediaSchemaFragment } from './mediaFragment.ts';
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

test('queued: the shipped Mongo drivers and the core worker, no framework app', async () => {
  resetAppInstance();
  const File = connection.model(
    'File',
    new mongoose.Schema({ ...resizeMediaSchemaFragment }, { minimize: false }),
  );
  const { ResizeTask, ResizeLock } = createResizeModels(connection);
  await Promise.all([File.init(), ResizeTask.init(), ResizeLock.init()]);

  const resizer = new Resizer({
    config: { ...defaultResizeConfig, formats: ['webp'] },
    logger: silent,
    storage: memoryStorage(),
    mediaStore: new MongoMediaStore({ model: File }),
    transport: new MongoTransport({
      model: ResizeTask,
      locks: new MongoLockStore({ model: ResizeLock }),
      lockTtlMs: { dispatch: 60_000, worker: 5000 },
      logger: silent,
      idlePollMs: 20,
      leaseMs: 5000,
    }),
  });
  const original = await resizer.uploadOriginal({
    body: png,
    visibility: 'private',
  });
  const file = await File.create({ original, previews: [] });
  const sizes = [{ width: 16, height: 16 }];
  assert.equal(
    (await resizer.prewarm({ media: file, sizes })).accepted.length,
    1,
  );

  const stop = new AbortController();
  const worker = runWorker({ signal: stop.signal, logger: silent });
  const until = Date.now() + 20_000;
  let stored = await File.findById(file.id);
  while ((stored?.previews?.length ?? 0) === 0) {
    assert.ok(Date.now() < until, 'the worker did not generate the preview');
    await new Promise((r) => setTimeout(r, 20));
    stored = await File.findById(file.id);
  }
  stop.abort();
  await worker;
  const { decision } = await resizer.resolve({
    media: stored as unknown as MediaLike,
    sizes,
  });
  assert.equal(decision.ready.length, 1);
  const task = await ResizeTask.findOne({}).lean();
  assert.equal(task?.status, 'completed');
});
