// The framework-free Mongo drivers against a real MongoDB: models and indexes, the lock store, the
// media store.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { resizeMediaSchemaFragment } from '../../mediaFragment.ts';
import type { Preview } from '../../types.d.ts';
import {
  createResizeModels,
  MongoLockStore,
  MongoMediaStore,
} from './index.ts';

let server: MongoMemoryServer;
let connection: mongoose.Connection;

before(async () => {
  server = await MongoMemoryServer.create();
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

describe('MongoLockStore', () => {
  test('one holder at a time, release, and takeover of an expired lock', async () => {
    const { ResizeLock } = createResizeModels(connection);
    const locks = new MongoLockStore({ model: ResizeLock });
    assert.equal(await locks.acquire('k1', 60_000), true);
    assert.equal(await locks.acquire('k1', 60_000), false);
    await locks.release('k1');
    assert.equal(await locks.acquire('k1', 60_000), true);

    const expire = () =>
      ResizeLock.updateOne(
        { _id: 'k1' },
        { $set: { expiredAt: new Date(Date.now() - 1000) } },
      );
    await expire();
    assert.equal(await locks.acquire('k1', 60_000), true);

    await expire();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => locks.acquire('k1', 60_000)),
    );
    assert.equal(results.filter(Boolean).length, 1, 'one caller takes it over');
  });

  test('getModel is resolved on use', async () => {
    const { ResizeLock } = createResizeModels(connection);
    const locks = new MongoLockStore({ getModel: () => ResizeLock });
    assert.equal(await locks.acquire('k2', 1000), true);
    await locks.release('k2');
  });
});

describe('MongoMediaStore', () => {
  const Media = () =>
    connection.models.DriverMedia ??
    connection.model(
      'DriverMedia',
      new mongoose.Schema(
        { ...resizeMediaSchemaFragment },
        { minimize: false },
      ),
    );

  test('loads a document and appends previews with the dimension backfill', async () => {
    const doc = await Media().create({
      original: { storageRef: { path: 'o.png' }, format: 'png' },
      previews: [],
    });
    const store = new MongoMediaStore({ model: Media() });
    store.verify();
    const preview = {
      storageRef: { path: 'p.webp' },
      sizeKey: '16x16',
      format: 'webp',
      contentType: 'image/webp',
    } as Preview;
    await store.appendPreviews(String(doc._id), [preview], {
      width: 64,
      height: 48,
    });
    const loaded = await store.load(String(doc._id));
    assert.equal(loaded?.previews?.length, 1);
    assert.equal(loaded?.original?.width, 64);
    assert.equal(loaded?.original?.height, 48);
    assert.equal(await store.load(String(new mongoose.Types.ObjectId())), null);
  });

  test('a getter that resolves to no model fails verify() with a setup error', () => {
    const store = new MongoMediaStore({
      getModel: () => connection.models.MisspelledMedia,
    });
    assert.throws(
      () => store.verify(),
      (err: Error & { code?: string }) =>
        err.code === 'RESIZE_MONGO_MODEL_MISSING',
    );
  });

  test('needs exactly one of model or getModel', () => {
    assert.throws(
      () => new MongoMediaStore({}),
      (err: Error & { code?: string }) =>
        err.code === 'RESIZE_MONGO_MODEL_REQUIRED',
    );
    assert.throws(
      () => new MongoLockStore({}),
      (err: Error & { code?: string }) =>
        err.code === 'RESIZE_MONGO_MODEL_REQUIRED',
    );
  });
});
