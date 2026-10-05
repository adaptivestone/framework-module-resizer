// The framework-free Mongo database against a real MongoDB: models and indexes, locks, media,
// and factory wiring.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { resizeMediaSchemaFragment } from '../../mediaFragment.ts';
import type { Preview } from '../../types.d.ts';
import {
  createResizeModels,
  MongoDatabase,
  MongoTaskQueue,
  mongoDatabase,
} from './index.ts';

let server: MongoMemoryServer;
let connection: mongoose.Connection;

before(async () => {
  server = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  connection = await mongoose
    .createConnection(server.getUri(), {
      dbName: `resize_mongo_drivers_${process.pid}`,
    })
    .asPromise();
});

after(async () => {
  await connection.close();
  await server.stop();
});

const Media = () =>
  connection.models.DriverMedia ??
  connection.model(
    'DriverMedia',
    new mongoose.Schema({ ...resizeMediaSchemaFragment }, { minimize: false }),
  );

describe('createResizeModels', () => {
  test('registers ResizeTask and ResizeLock with the package indexes', async () => {
    const { ResizeTask, ResizeLock } = createResizeModels(connection, {
      mediaModelName: 'Media',
    });
    assert.equal(ResizeTask.modelName, 'ResizeTask');
    assert.equal(ResizeLock.modelName, 'ResizeLock');
    assert.equal(ResizeTask.schema.path('fileId').options.ref, 'Media');
    // The module never creates indexes at runtime; the host's migration does. Here: the test.
    await ResizeTask.createIndexes();
    await ResizeLock.createIndexes();
    const taskIndexes = await ResizeTask.collection.indexes();
    const dedupe = taskIndexes.find((i) => i.key.requestKey === 1);
    assert.equal(dedupe?.unique, true);
    assert.ok(
      taskIndexes.some((i) => i.key.queue === 1 && i.key.status === 1),
      'the lease index exists',
    );
    const lockIndexes = await ResizeLock.collection.indexes();
    assert.ok(lockIndexes.some((i) => i.expireAfterSeconds === 0));
  });

  test('returns the already registered models on a second call', () => {
    const first = createResizeModels(connection);
    const second = createResizeModels(connection);
    assert.equal(first.ResizeTask, second.ResizeTask);
    assert.equal(first.ResizeLock, second.ResizeLock);
  });
});

describe('MongoDatabase locks', () => {
  test('one holder at a time, release, and takeover of an expired lock', async () => {
    const { ResizeLock } = createResizeModels(connection);
    const db = new MongoDatabase({
      mediaModel: Media(),
      lockModel: ResizeLock,
    });
    assert.equal(await db.acquireLock('k1', 60_000), true);
    assert.equal(await db.acquireLock('k1', 60_000), false);
    await db.releaseLock('k1');
    assert.equal(await db.acquireLock('k1', 60_000), true);

    const expire = () =>
      ResizeLock.updateOne(
        { _id: 'k1' },
        { $set: { expiredAt: new Date(Date.now() - 1000) } },
      );
    await expire();
    assert.equal(await db.acquireLock('k1', 60_000), true);

    await expire();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => db.acquireLock('k1', 60_000)),
    );
    assert.equal(results.filter(Boolean).length, 1, 'one caller takes it over');
  });

  test('getLockModel is resolved on use', async () => {
    const { ResizeLock } = createResizeModels(connection);
    let calls = 0;
    const db = new MongoDatabase({
      mediaModel: Media(),
      getLockModel: () => {
        calls++;
        return ResizeLock;
      },
    });
    assert.equal(calls, 0);
    assert.equal(await db.acquireLock('k2', 1000), true);
    await db.releaseLock('k2');
    assert.equal(calls, 2);
  });
});

describe('MongoDatabase media', () => {
  test('loads a document and appends previews with the dimension backfill', async () => {
    const doc = await Media().create({
      original: { storageRef: { path: 'o.png' }, format: 'png' },
      previews: [],
    });
    const db = new MongoDatabase({
      mediaModel: Media(),
      lockModel: createResizeModels(connection).ResizeLock,
    });
    db.verify();
    const preview = {
      storageRef: { path: 'p.webp' },
      sizeKey: '16x16',
      format: 'webp',
      contentType: 'image/webp',
    } as Preview;
    await db.appendPreviews(String(doc._id), [preview], {
      width: 64,
      height: 48,
    });
    const loaded = await db.loadMedia(String(doc._id));
    assert.equal(loaded?.previews?.length, 1);
    assert.equal(loaded?.original?.width, 64);
    assert.equal(loaded?.original?.height, 48);
    assert.equal(
      await db.loadMedia(String(new mongoose.Types.ObjectId())),
      null,
    );
  });

  test('a getter that resolves to no model fails verify() with a setup error', () => {
    const db = new MongoDatabase({
      getMediaModel: () => connection.models.MisspelledMedia,
    });
    assert.throws(
      () => db.verify(),
      (err: Error & { code?: string }) =>
        err.code === 'RESIZE_MONGO_MODEL_MISSING',
    );
  });

  test('no lock model fails verify() at boot, not every variant at run time', async () => {
    const db = new MongoDatabase({ mediaModel: Media() });
    assert.throws(
      () => db.verify(),
      (err: Error & { code?: string }) =>
        err.code === 'RESIZE_MONGO_MODEL_MISSING' &&
        /lock model/.test(err.message),
    );
    await assert.rejects(
      () => db.acquireLock('k3', 1000),
      (err: Error & { code?: string }) =>
        err.code === 'RESIZE_MONGO_MODEL_MISSING',
    );
  });

  test('needs exactly one of mediaModel or getMediaModel', () => {
    assert.throws(
      () => new MongoDatabase({}),
      (err: Error & { code?: string }) =>
        err.code === 'RESIZE_MONGO_MODEL_REQUIRED',
    );
    assert.throws(
      () => new MongoDatabase({ mediaModel: Media(), getMediaModel: Media }),
      (err: Error & { code?: string }) =>
        err.code === 'RESIZE_MONGO_MODEL_REQUIRED',
    );
  });
});

describe('mongoDatabase', () => {
  test('wires host media, package locks and the task queue with its timing', async () => {
    const factoryConnection = connection.useDb(`${connection.name}_factory`);
    const mediaModel = factoryConnection.model(
      'FactoryMedia',
      new mongoose.Schema(
        { ...resizeMediaSchemaFragment },
        { minimize: false },
      ),
    );
    const db = mongoDatabase(factoryConnection, {
      mediaModel,
      timing: { idlePollMs: 15 },
    });
    db.verify();
    assert.ok(db.tasks instanceof MongoTaskQueue);
    db.tasks.verify();
    assert.equal(db.tasks.getTiming().idlePollMs, 15);
    const { ResizeTask, ResizeLock } = createResizeModels(factoryConnection);
    assert.equal(ResizeTask.schema.path('fileId').options.ref, 'FactoryMedia');
    assert.equal(ResizeTask.schema.options.autoIndex, false);
    assert.equal(ResizeLock.schema.options.autoIndex, false);

    const doc = await mediaModel.create({
      original: { storageRef: { path: 'factory.png' }, format: 'png' },
      previews: [],
    });
    assert.equal((await db.loadMedia(String(doc._id)))?.id, String(doc._id));
    assert.equal(await db.acquireLock('factory', 60_000), true);
    assert.equal(await db.acquireLock('factory', 60_000), false);
    await db.releaseLock('factory');
    assert.equal(await ResizeLock.countDocuments({}), 0);

    const receipt = await db.tasks.add({
      resizer: 'default',
      queue: 'default',
      mediaId: String(doc._id),
      pipeline: 'default',
      previews: [],
      requestKey: 'factory-request',
    });
    assert.ok(receipt.taskId);
    assert.equal(await ResizeTask.countDocuments({ _id: receipt.taskId }), 1);
  });
});
