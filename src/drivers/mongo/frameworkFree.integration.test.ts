// A host without @adaptivestone/framework: explicit config and drivers, no framework app. Eager
// generation uses hand-written in-memory drivers (any object of the contract's shape works); the
// queued flow uses only the shipped Mongo drivers, so a plain Node app writes no driver code.
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { resetAppInstance } from '@adaptivestone/framework/helpers/appInstance.js';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import sharp from 'sharp';
import defaultResizeConfig from '../../config/resize.ts';
import type { MediaStore } from '../../contracts/media.ts';
import type { ResizeStorage } from '../../contracts/storage.ts';
import { Resizer, resetResizerForTests } from '../../index.ts';
import type { MediaLike, Preview } from '../../types.d.ts';
import { runWorker } from '../../worker.ts';
import { mongoParts } from './index.ts';
import { resizeMediaSchemaFragment } from './mediaFragment.ts';

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

function memoryMedia(docs: Map<string, MediaLike>): MediaStore {
  return {
    loadMedia: async (id) => docs.get(id) ?? null,
    appendPreviews: async (id, previews: Preview[]) => {
      const doc = docs.get(id);
      if (!doc) {
        return [];
      }
      doc.previews = [...(doc.previews ?? []), ...previews];
      return previews;
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
    media: memoryMedia(docs),
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
  server = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
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
  const parts = mongoParts(connection, {
    mediaModel: File,
    timing: { idlePollMs: 20, leaseMs: 5000 },
    logger: silent,
  });
  const { ResizeTask, ResizeLock } = connection.models;
  await Promise.all([
    File.init(),
    ResizeTask.createIndexes(),
    ResizeLock.createIndexes(),
  ]);

  const resizer = new Resizer({
    config: { ...defaultResizeConfig, formats: ['webp'] },
    logger: silent,
    storage: memoryStorage(),
    ...parts,
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
  const timeout = setTimeout(() => stop.abort(), 20_000);
  let stored = await File.findById(file.id);
  try {
    const until = Date.now() + 20_000;
    while (
      (stored?.previews?.length ?? 0) === 0 ||
      (await ResizeTask.findOne({}).lean())?.status !== 'completed'
    ) {
      assert.ok(
        Date.now() < until,
        'the worker did not complete the preview task',
      );
      await new Promise((r) => setTimeout(r, 20));
      stored = await File.findById(file.id);
    }
  } finally {
    clearTimeout(timeout);
    stop.abort();
    await worker;
  }
  const { decision } = await resizer.resolve({
    media: stored as unknown as MediaLike,
    sizes,
  });
  assert.equal(decision.ready.length, 1);
  const task = await ResizeTask.findOne({}).lean();
  assert.equal(task?.status, 'completed');
});

test('invalidate on MongoDB removes one pipeline in one write; the next resolve queues it again', async () => {
  resetAppInstance();
  const updates: boolean[] = [];
  const schema = new mongoose.Schema(
    { ...resizeMediaSchemaFragment },
    { minimize: false },
  );
  schema.pre(
    'findOneAndUpdate',
    function (this: mongoose.Query<unknown, unknown>) {
      updates.push(Array.isArray(this.getUpdate()));
    },
  );
  const File = connection.model('InvalidateFile', schema);
  const parts = mongoParts(connection, {
    mediaModel: File,
    timing: { idlePollMs: 20, leaseMs: 5000 },
    logger: silent,
  });
  const { ResizeTask } = connection.models;
  await Promise.all([File.init(), ResizeTask.createIndexes()]);

  const resizer = new Resizer({
    name: 'invalidating',
    config: { ...defaultResizeConfig, formats: ['webp'] },
    logger: silent,
    storage: memoryStorage(),
    pipelines: { wm: {} },
    ...parts,
  });
  const original = await resizer.uploadOriginal({
    body: png,
    visibility: 'private',
  });
  const file = await File.create({ original, previews: [] });
  const sizes = [
    { width: 16, height: 16 },
    { width: 8, height: 8 },
  ];
  const { created: defaults } = await resizer.generate({ media: file, sizes });
  const { created: watermarked } = await resizer.generate({
    media: file,
    sizes,
    pipeline: 'wm',
  });
  assert.equal(defaults.length, 2);
  assert.equal(watermarked.length, 2);
  updates.length = 0;

  const refs = await resizer.invalidate({ media: file, pipeline: 'wm' });

  assert.deepEqual(
    refs,
    watermarked.map((row) => row.storageRef),
  );
  // One write, an update pipeline.
  assert.deepEqual(updates, [true]);
  const kept = (
    (await File.findById(file.id).lean()) as unknown as { previews: Preview[] }
  ).previews;
  assert.deepEqual(
    kept.map((row) => [row.pipeline, row.storageRef]),
    defaults.map((row) => ['default', row.storageRef]),
  );

  // The in-memory media lost the rows too, so a same-request read queues the pipeline again.
  const { decision } = await resizer.resolve({
    media: file as unknown as MediaLike,
    sizes,
    pipeline: 'wm',
  });
  assert.deepEqual(decision.ready, []);
  assert.deepEqual(
    decision.missing.map((variant) => [variant.sizeKey, variant.format]),
    [
      ['16x16', 'webp'],
      ['8x8', 'webp'],
    ],
  );
  const tasks = await ResizeTask.find({ fileId: file._id }).lean();
  assert.deepEqual(
    tasks.map((task) => [task.resizer, task.pipeline, task.previews.length]),
    [['invalidating', 'wm', 2]],
  );
});
