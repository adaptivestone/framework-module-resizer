// The framework-free Mongo drivers against a real MongoDB: models and indexes, locks, and the
// mongoParts wiring.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { resizeMediaSchemaFragment } from '../../mediaFragment.ts';
import { timingOf } from '../../queue.ts';
import {
  createResizeModels,
  MongoLockStore,
  MongoMediaStore,
  MongoTaskQueue,
  mongoParts,
  resizeLockFields,
} from './index.ts';

let server: MongoMemoryServer;
let connection: mongoose.Connection;

before(async () => {
  // The TTL monitor is off: its sweep (every 60 s) could delete a lock a test has just expired
  // before the test reads it. The index tests only check that the TTL index exists.
  server = await MongoMemoryServer.create({
    instance: {
      ip: '127.0.0.1',
      args: ['--setParameter', 'ttlMonitorEnabled=false'],
    },
  });
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

describe('MongoLockStore', () => {
  let ResizeLock: ReturnType<typeof createResizeModels>['ResizeLock'];
  let store: MongoLockStore;
  before(() => {
    ({ ResizeLock } = createResizeModels(connection));
    store = new MongoLockStore({ model: ResizeLock });
  });
  const expire = (key: string) =>
    ResizeLock.updateOne(
      { _id: key },
      { $set: { expiredAt: new Date(Date.now() - 1000) } },
    );

  test("one owner at a time; the owner's release frees the lock", async () => {
    assert.equal(await store.acquire('l1', 'A', 60_000), true);
    assert.equal(await store.acquire('l1', 'B', 60_000), false);
    assert.equal(await store.release('l1', 'A'), true);
    assert.equal(await store.acquire('l1', 'B', 60_000), true);
  });

  test('a live lock blocks even its own owner', async () => {
    assert.equal(await store.acquire('l7', 'A', 60_000), true);
    assert.equal(await store.acquire('l7', 'A', 60_000), false);
  });

  test('another owner can neither release nor extend the lock', async () => {
    assert.equal(await store.acquire('l2', 'A', 60_000), true);
    assert.equal(await store.release('l2', 'B'), false);
    assert.equal(await store.extend('l2', 'B', 60_000), false);
    assert.equal(await store.acquire('l2', 'C', 60_000), false);
  });

  test("extend moves a live lock's expiry; an expired lock cannot be extended", async () => {
    assert.equal(await store.acquire('l3', 'A', 1000), true);
    assert.equal(await store.extend('l3', 'A', 120_000), true);
    const lock = await ResizeLock.findById('l3').lean();
    assert.ok(lock.expiredAt.getTime() - Date.now() > 100_000);
    await expire('l3');
    assert.equal(await store.extend('l3', 'A', 1000), false);
  });

  test("an expired lock goes to one caller, and the old owner's late release leaves it", async () => {
    assert.equal(await store.acquire('l4', 'A', 60_000), true);
    await expire('l4');
    const owners = ['B0', 'B1', 'B2', 'B3', 'B4'];
    const results = await Promise.all(
      owners.map((owner) => store.acquire('l4', owner, 60_000)),
    );
    assert.equal(results.filter(Boolean).length, 1, 'one caller takes it over');
    assert.equal(await store.release('l4', 'A'), false);
    assert.equal(
      (await ResizeLock.findById('l4').lean()).owner,
      owners[results.indexOf(true)],
    );
  });

  test('the owner releases its own expired lock while nobody took it over', async () => {
    assert.equal(await store.acquire('l5', 'A', 60_000), true);
    await expire('l5');
    assert.equal(await store.release('l5', 'A'), true);
    assert.equal(await ResizeLock.findById('l5').lean(), null);
  });

  test('getModel is resolved on use; an unresolved model fails verify()', async () => {
    let calls = 0;
    const lazy = new MongoLockStore({
      getModel: () => {
        calls++;
        return ResizeLock;
      },
    });
    assert.equal(calls, 0);
    assert.equal(await lazy.acquire('l6', 'A', 1000), true);
    assert.equal(await lazy.release('l6', 'A'), true);
    assert.equal(calls, 2);
    assert.throws(
      () => new MongoLockStore({ getModel: () => null }).verify(),
      (err: Error & { code?: string }) =>
        err.code === 'RESIZE_MONGO_MODEL_MISSING' &&
        /lock model/.test(err.message),
    );
  });

  test('needs exactly one of model or getModel', () => {
    assert.throws(
      () => new MongoLockStore({}),
      (err: Error & { code?: string }) =>
        err.code === 'RESIZE_MONGO_MODEL_REQUIRED',
    );
    assert.throws(
      () =>
        new MongoLockStore({ model: ResizeLock, getModel: () => ResizeLock }),
      (err: Error & { code?: string }) =>
        err.code === 'RESIZE_MONGO_MODEL_REQUIRED',
    );
  });

  test('a create error other than a duplicate key is rethrown', async () => {
    const failure = { code: 1 };
    const updates: object[] = [];
    const failing = new MongoLockStore({
      model: {
        create: () => Promise.reject(failure),
        updateOne: async (filter) => {
          updates.push(filter);
          return { matchedCount: 1 };
        },
        deleteOne: async () => ({ deletedCount: 0 }),
      },
    });
    await assert.rejects(
      () => failing.acquire('l8', 'A', 1000),
      (err: unknown) => err === failure,
    );
    assert.deepEqual(updates, [], 'no takeover is tried');
  });

  test('the ResizeLock schema stores the owner', () => {
    assert.deepEqual(resizeLockFields.owner, { type: String });
  });
});

describe('mongoParts', () => {
  test('returns exactly the Resizer options media, locks and tasks, on the package models', async () => {
    const parts = mongoParts(connection, {
      mediaModel: Media(),
      timing: { maxAttempts: 2 },
    });
    assert.deepEqual(Object.keys(parts).sort(), ['locks', 'media', 'tasks']);
    assert.ok(
      parts.media instanceof MongoMediaStore &&
        parts.locks instanceof MongoLockStore &&
        parts.tasks instanceof MongoTaskQueue,
    );
    assert.equal(timingOf(parts.tasks).maxAttempts, 2);
    assert.equal(await parts.locks.acquire('p1', 'A', 1000), true);
    assert.equal(
      (await connection.models.ResizeLock.findById('p1').lean())?.owner,
      'A',
    );
  });

  test('each call makes its own task queue (call it once per process)', () => {
    assert.notEqual(
      mongoParts(connection, { mediaModel: Media() }).tasks,
      mongoParts(connection, { mediaModel: Media() }).tasks,
    );
  });

  test('registers the package models on its connection, referring to the host media model', async () => {
    // A fresh connection: the tests above already registered the models on the shared one.
    const fresh = await mongoose
      .createConnection(server.getUri(), {
        dbName: `resize_mongo_parts_${process.pid}`,
      })
      .asPromise();
    try {
      const mediaModel = fresh.model(
        'PartsMedia',
        new mongoose.Schema(
          { ...resizeMediaSchemaFragment },
          { minimize: false },
        ),
      );
      assert.equal(fresh.models.ResizeTask, undefined);
      assert.equal(fresh.models.ResizeLock, undefined);
      mongoParts(fresh, { mediaModel });
      const { ResizeTask, ResizeLock } = fresh.models;
      assert.ok(ResizeTask && ResizeLock);
      assert.equal(ResizeTask.schema.path('fileId').options.ref, 'PartsMedia');
      assert.equal(ResizeTask.schema.options.autoIndex, false);
      assert.equal(ResizeLock.schema.options.autoIndex, false);
    } finally {
      await fresh.close();
    }
  });
});
