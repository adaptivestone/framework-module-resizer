// A host without @adaptivestone/framework: explicit config and drivers, no framework app. Eager
// generation uses hand-written in-memory drivers (any object of the contract's shape works); the
// queued flow uses only the shipped Mongo drivers, so a plain Node app writes no driver code; and
// createResizer builds the same from one config object.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { resetAppInstance } from '@adaptivestone/framework/helpers/appInstance.js';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import sharp from 'sharp';
import defaultResizeConfig from '../../config/resize.ts';
import type { MediaStore } from '../../contracts/media.ts';
import {
  createResizer,
  hasOriginal,
  Resizer,
  resetResizerForTests,
} from '../../index.ts';
import { encodeSignature } from '../../signatures.ts';
import { fakeS3 } from '../../testHelpers/fakeS3.ts';
import { memoryStorage } from '../../testHelpers/fakes.ts';
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
    replacePreviews: async (id, identities, rows) => {
      const doc = docs.get(id);
      if (!doc) {
        return { stored: [], removed: [] };
      }
      const replaced = new Set(identities);
      const kept = doc.previews ?? [];
      const removed = kept.filter(
        (row) => row.identity !== undefined && replaced.has(row.identity),
      );
      doc.previews = [...kept.filter((row) => !removed.includes(row)), ...rows];
      return { stored: rows, removed };
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
    storage: memoryStorage().storage,
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
  assert.match(decision.ready[0].url, /^\/m\/.+\.webp$/);
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
    storage: memoryStorage().storage,
    ...parts,
  });
  const original = await resizer.uploadOriginal({
    body: png,
    visibility: 'private',
  });
  const file = await File.create({ original, previews: [] });
  const sizes = [{ width: 16, height: 16 }];
  assert.equal(
    (await resizer.prewarm({ media: file as MediaLike, sizes })).accepted
      .length,
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
    storage: memoryStorage().storage,
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
  const { created: defaults } = await resizer.generate({
    media: file as MediaLike,
    sizes,
  });
  const { created: watermarked } = await resizer.generate({
    media: file as MediaLike,
    sizes,
    pipeline: 'wm',
  });
  assert.equal(defaults.length, 2);
  assert.equal(watermarked.length, 2);
  updates.length = 0;

  const refs = await resizer.invalidate({
    media: file as MediaLike,
    pipeline: 'wm',
  });

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

test('createResizer: a config object and one call on MongoDB, with no framework app', async () => {
  resetAppInstance();
  const File = connection.model(
    'FactoryFile',
    new mongoose.Schema({ ...resizeMediaSchemaFragment }, { minimize: false }),
  );
  await File.init();
  const root = await mkdtemp(join(tmpdir(), 'resize-factory-'));
  try {
    const resizer = createResizer(
      {
        formats: ['webp'],
        storage: {
          driver: 'local',
          rootDir: join(root, 'public'),
          publicBaseUrl: '/media',
        },
        database: { driver: 'mongo', connection, mediaModel: File },
        queues: {
          default: { driver: 'database', idlePollMs: 20, leaseMs: 5000 },
        },
      },
      { name: 'factory', logger: silent },
    );
    // The database parts register the package models on first use; the host creates the indexes.
    await resizer.ready();
    await connection.models.ResizeTask.createIndexes();
    await resizer.verify();
    assert.equal(resizer.locks, undefined); // the database queue keeps its gate in its rows

    const original = await resizer.uploadOriginal({
      body: png,
      visibility: 'private',
    });
    const file = await File.create({ original, previews: [] });
    const sizes = [{ width: 16, height: 16 }];
    const warm = await resizer.prewarm({ media: file as MediaLike, sizes });
    assert.equal(warm.status, 'accepted');

    const { ResizeTask } = connection.models;
    const stop = new AbortController();
    const worker = runWorker({
      signal: stop.signal,
      logger: silent,
      resizers: [resizer],
    });
    let stored = await File.findById(file.id);
    try {
      const until = Date.now() + 20_000;
      while (
        (stored?.previews?.length ?? 0) === 0 ||
        (await ResizeTask.findOne({ fileId: file._id }).lean())?.status !==
          'completed'
      ) {
        assert.ok(
          Date.now() < until,
          'the worker did not complete the preview task',
        );
        await new Promise((r) => setTimeout(r, 20));
        stored = await File.findById(file.id);
      }
    } finally {
      stop.abort();
      await worker;
    }
    const { decision } = await resizer.resolve({
      media: stored as unknown as MediaLike,
      sizes,
    });
    assert.equal(decision.ready.length, 1);
    assert.deepEqual(decision.missing, []);
    assert.match(decision.ready[0].url, /^\/media\/.+\.webp$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a stale preview is replaced in the media document', async () => {
  resetAppInstance();
  const File = connection.model(
    'StaleFile',
    new mongoose.Schema({ ...resizeMediaSchemaFragment }, { minimize: false }),
  );
  await File.init();
  const { storage } = memoryStorage();
  const resizerAt = (quality: number) =>
    createResizer(
      {
        formats: ['webp'],
        encode: { formats: { webp: { quality } } },
        database: { driver: 'mongo', connection, mediaModel: File },
      },
      { name: 'stale', logger: silent, storage },
    );
  const sizes = [{ width: 16, height: 16 }];
  const identity = 'stale:default:16x16:webp:none';

  const before = resizerAt(80);
  const original = await before.uploadOriginal({
    body: png,
    visibility: 'private',
  });
  const file = await File.create({ original, previews: [] });
  const { created: old } = await before.generate({
    media: file as MediaLike,
    sizes,
  });
  assert.equal(old.length, 1);
  resetResizerForTests();

  const after = resizerAt(70);
  const media = (await File.findById(file.id)) as unknown as MediaLike;
  const { created, replaced } = await after.generate({ media, sizes });
  assert.equal(created.length, 1);
  assert.deepEqual(replaced, [old[0].storageRef]);
  const rows = (
    (await File.findById(file.id).lean()) as unknown as { previews: Preview[] }
  ).previews.filter((row) => row.identity === identity);
  assert.equal(rows.length, 1);
  assert.equal(
    rows[0].encodeSig,
    encodeSignature(after.config, { format: 'webp', fit: false }),
  );
  assert.notEqual(rows[0].encodeSig, old[0].encodeSig);
  assert.deepEqual(rows[0].storageRef, created[0].storageRef);
});

/** Run a worker for `resizer` until the task of this media has completed, and reload the media. */
async function renderQueued(
  resizer: Resizer,
  File: mongoose.Model<unknown>,
  fileId: unknown,
): Promise<MediaLike> {
  const { ResizeTask } = connection.models;
  const stop = new AbortController();
  const worker = runWorker({
    signal: stop.signal,
    logger: silent,
    resizers: [resizer],
  });
  try {
    const until = Date.now() + 20_000;
    while (
      (await ResizeTask.findOne({ fileId }).lean())?.status !== 'completed'
    ) {
      assert.ok(
        Date.now() < until,
        'the worker did not complete the preview task',
      );
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    stop.abort();
    await worker;
  }
  return (await File.findById(fileId)) as unknown as MediaLike;
}

/** A model with a host's own field beside the module's, and a Resizer on the shipped Mongo drivers. */
async function adoptingOn(modelName: string, backing?: Resizer['storage']) {
  const File = connection.model(
    modelName,
    new mongoose.Schema(
      { name: String, ...resizeMediaSchemaFragment },
      { minimize: false },
    ),
  );
  const parts = mongoParts(connection, {
    mediaModel: File,
    timing: { idlePollMs: 20, leaseMs: 5000 },
    logger: silent,
  });
  await Promise.all([
    File.init(),
    connection.models.ResizeTask.createIndexes(),
  ]);
  const { storage, files } = memoryStorage();
  files.set('legacy/photo of a cat.png', png);
  const resizer = new Resizer({
    name: modelName,
    config: { ...defaultResizeConfig, formats: ['webp'] },
    logger: silent,
    storage: backing ?? storage,
    ...parts,
  });
  return {
    File: File as unknown as mongoose.Model<unknown>,
    resizer,
    storageRef: { key: 'legacy/photo of a cat.png' },
    sizes: [{ width: 16, height: 16 }],
  };
}

test('hasOriginal and the backfill filter on real documents', async () => {
  resetAppInstance();
  const File = connection.model(
    'BackfillFile',
    new mongoose.Schema(
      { name: String, ...resizeMediaSchemaFragment },
      { minimize: false },
    ),
  );
  await File.init();
  const created = new File({ name: 'new' });
  assert.equal(hasOriginal(created), false);
  // Why `if (doc.original)` is the wrong test.
  assert.equal(Boolean(created.original), true);
  await created.save();
  await File.collection.insertMany([
    { name: 'empty', original: {} },
    { name: 'none' },
    { name: 'adopted', original: { storageRef: { key: 'k' } } },
  ]);
  const names = async (filter: object) =>
    (await File.find(filter).lean()).map((row) => row.name).sort();
  assert.deepEqual(await names({ 'original.storageRef': null }), [
    'empty',
    'new',
    'none',
  ]);
  // Why `$exists: false` is the wrong filter: saving a new document writes `original: {}`.
  assert.deepEqual(await names({ original: { $exists: false } }), ['none']);

  assert.equal(hasOriginal(await File.findOne({ name: 'adopted' })), true);
  assert.equal(hasOriginal(await File.findOne({ name: 'empty' })), false);
  assert.equal(hasOriginal(await File.findOne({ name: 'none' })), false);
  // Not loaded reads the same as not adopted, so a list query must load the module's fields.
  const projected = await File.findOne({ name: 'adopted' }).select('name');
  assert.equal(hasOriginal(projected), false);
});

test('adopt, then save: a queued task renders, and writing the same Original again leaves no stale row', async () => {
  resetAppInstance();
  const { File, resizer, storageRef, sizes } = await adoptingOn('AdoptedFile');
  const file = (await File.create({ name: 'x' })) as unknown as MediaLike & {
    _id: unknown;
    original: unknown;
    save(): Promise<unknown>;
  };
  file.original = await resizer.adoptOriginal({ storageRef });
  await file.save();
  const warm = await resizer.prewarm({ media: file, sizes });
  assert.equal(warm.status, 'accepted');

  const stored = await renderQueued(resizer, File, file._id);
  assert.equal(stored.previews?.length, 1);
  const first = await resizer.resolve({ media: stored, sizes });
  assert.equal(first.decision.ready.length, 1);
  assert.equal(first.decision.ready[0].stale, undefined);
  assert.deepEqual(first.decision.missing, []);

  await File.updateOne(
    { _id: file._id },
    { $set: { original: await resizer.adoptOriginal({ storageRef }) } },
  );
  const again = await resizer.resolve({
    media: (await File.findById(file._id)) as unknown as MediaLike,
    sizes,
  });
  assert.equal(again.decision.ready.length, 1);
  assert.equal(again.decision.ready[0].stale, undefined);
  assert.equal(again.decision.stale, undefined);
  assert.deepEqual(again.decision.missing, []);
  assert.equal(
    await connection.models.ResizeTask.countDocuments({ fileId: file._id }),
    1,
    'nothing was queued again',
  );
});

test('a ref built with namespace: undefined: the value holds no such key, a real $set stores no null, and the task completes', async (t) => {
  resetAppInstance();
  const s3 = await fakeS3();
  t.after(() => s3.close());
  s3.objects.set('priv/a.png', png);
  const { File, resizer, sizes } = await adoptingOn(
    'UndefinedNamespaceFile',
    s3.storage(),
  );
  const { _id } = (await File.create({ name: 'x' })) as unknown as {
    _id: unknown;
  };
  const original = await resizer.adoptOriginal({
    storageRef: { bucket: 'priv', key: 'a.png', namespace: undefined },
  });
  const storageRef = { bucket: 'priv', key: 'a.png' };
  assert.deepStrictEqual(original.storageRef, storageRef);
  await File.updateOne({ _id }, { $set: { original } });
  const raw = await File.collection.findOne({ _id } as never);
  assert.deepStrictEqual(raw?.original.storageRef, storageRef);

  const media = (await File.findById(_id)) as unknown as MediaLike;
  const warm = await resizer.prewarm({ media, sizes });
  assert.equal(warm.status, 'accepted');
  const stored = await renderQueued(resizer, File, _id);
  assert.equal(stored.previews?.length, 1);
  const { decision } = await resizer.resolve({ media: stored, sizes });
  assert.equal(decision.ready.length, 1);
  assert.equal(decision.ready[0].stale, undefined);
  // The stored row can be adopted again, and that changes nothing.
  assert.deepStrictEqual(
    (await resizer.adoptOriginal({ storageRef: raw?.original.storageRef }))
      .storageRef,
    storageRef,
  );
});

test('a bare ref written by hand: the worker renders and backfills, and adopting it later leaves no stale row', async () => {
  resetAppInstance();
  const { File, resizer, storageRef, sizes } = await adoptingOn('BareRefFile');
  const { _id } = (await File.create({ name: 'x' })) as unknown as {
    _id: unknown;
  };
  await File.updateOne(
    { _id },
    { $set: { 'original.storageRef': storageRef } },
  );
  const bare = (await File.findById(_id)) as unknown as MediaLike;
  assert.equal(hasOriginal(bare), true);
  assert.equal(bare.original?.width, undefined);
  const warm = await resizer.prewarm({ media: bare, sizes });
  assert.equal(warm.status, 'accepted');

  const stored = await renderQueued(resizer, File, _id);
  assert.equal(stored.original?.width, 64);
  assert.equal(stored.original?.height, 48);
  const first = await resizer.resolve({ media: stored, sizes });
  assert.equal(first.decision.ready.length, 1);
  assert.equal(first.decision.ready[0].stale, undefined);

  await File.updateOne(
    { _id },
    { $set: { original: await resizer.adoptOriginal({ storageRef }) } },
  );
  const adopted = (await File.findById(_id)) as unknown as MediaLike;
  assert.equal(adopted.original?.format, 'png');
  assert.equal(adopted.original?.size, png.byteLength);
  const after = await resizer.resolve({ media: adopted, sizes });
  assert.equal(after.decision.ready.length, 1);
  assert.equal(after.decision.ready[0].stale, undefined);
  assert.equal(after.decision.stale, undefined);
  assert.deepEqual(after.decision.missing, []);
  assert.equal(
    await connection.models.ResizeTask.countDocuments({ fileId: _id }),
    1,
    'nothing was queued again',
  );
});
