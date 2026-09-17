import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import LockModel from '@adaptivestone/framework/models/Lock.js';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { FrameworkLockProvider } from './locks/framework.ts';
import ResizeTaskModel from './models/ResizeTask.ts';
import { Resizer, resetResizerForTests } from './resizer.ts';
import { MongoTransport } from './transports/mongo.ts';

const fakeStorage = {
  download: async () => Buffer.alloc(0),
  upload: async () => ({ key: 'unused' }),
  publicUrl: () => '',
};

function hasExactKey(key: unknown, expected: Record<string, number>): boolean {
  return JSON.stringify(key) === JSON.stringify(expected);
}

test('prepareQueue creates real Mongo queue and lock indexes idempotently', async (t) => {
  let server: MongoMemoryServer | undefined;
  let connection: mongoose.Connection | undefined;

  t.after(async () => {
    resetResizerForTests();
    resetAppInstance();
    await connection?.close().catch(() => {});
    await server?.stop().catch(() => {});
  });

  server = await MongoMemoryServer.create();
  const dbName = `prepare_queue_${process.pid}_${Date.now()}`;
  connection = await mongoose
    .createConnection(server.getUri(), { autoIndex: false, dbName })
    .asPromise();

  // Mirror BaseModel.initialize with the real package/framework model definitions.
  // autoIndex stays explicitly disabled so only prepareQueue may create secondaries.
  const taskSchema = new mongoose.Schema(ResizeTaskModel.modelSchema, {
    timestamps: true,
    minimize: false,
    autoIndex: false,
    statics: ResizeTaskModel.modelStatics,
  });
  ResizeTaskModel.initHooks(taskSchema);
  const lockSchema = new mongoose.Schema(LockModel.modelSchema, {
    timestamps: true,
    minimize: false,
    autoIndex: false,
    statics: LockModel.modelStatics,
  });
  LockModel.initHooks(lockSchema);

  const taskModel = connection.model(
    `PrepareQueueResizeTask_${process.pid}`,
    taskSchema,
    'resize_tasks',
  );
  const lockModel = connection.model(
    `PrepareQueueLock_${process.pid}`,
    lockSchema,
    'locks',
  );
  await Promise.all([
    taskModel.createCollection(),
    lockModel.createCollection(),
  ]);

  assert.deepEqual(
    (await taskModel.collection.listIndexes().toArray()).map(({ key }) => key),
    [{ _id: 1 }],
  );
  assert.deepEqual(
    (await lockModel.collection.listIndexes().toArray()).map(({ key }) => key),
    [{ _id: 1 }],
  );

  setAppInstance({
    getConfig: () => ({ mediaModelName: 'File' }),
    getModel: (name: string) => {
      if (name === 'ResizeTask') {
        return taskModel;
      }
      if (name === 'Lock') {
        return lockModel;
      }
      return undefined;
    },
    logger: { info() {}, warn() {}, error() {} },
  } as never);

  const transport = new MongoTransport();
  const makeResizer = () =>
    new Resizer({
      storage: fakeStorage,
      transport,
      lockProvider: new FrameworkLockProvider(),
    });

  const resizer = makeResizer();
  await resizer.prepareQueue();

  const taskIndexes = await taskModel.collection.listIndexes().toArray();
  const dedupe = taskIndexes.find(({ key }) =>
    hasExactKey(key, { fileId: 1, pipeline: 1, requestKey: 1 }),
  );
  assert.ok(dedupe, 'active-request dedupe index should exist');
  assert.deepEqual(dedupe.key, { fileId: 1, pipeline: 1, requestKey: 1 });
  assert.equal(dedupe.unique, true);
  assert.deepEqual(dedupe.partialFilterExpression, {
    status: { $in: ['pending', 'processing'] },
    requestKey: { $exists: true },
  });

  const lockIndexes = await lockModel.collection.listIndexes().toArray();
  const ttl = lockIndexes.find(({ key }) => hasExactKey(key, { expiredAt: 1 }));
  assert.ok(ttl, 'framework Lock TTL index should exist');
  assert.deepEqual(ttl.key, { expiredAt: 1 });
  assert.equal(ttl.expireAfterSeconds, 0);

  const mediaId = new mongoose.Types.ObjectId().toString();
  const request = {
    mediaId,
    pipeline: 'default',
    previews: [{ sizeKey: '640x480', format: 'webp' as const }],
  };
  const receipts = await Promise.all(
    Array.from({ length: 20 }, () => transport.enqueue(request)),
  );
  const taskIds = receipts.map(({ taskId }) => taskId);
  assert.ok(taskIds.every((taskId) => typeof taskId === 'string' && taskId));
  assert.equal(new Set(taskIds).size, 1);
  assert.equal(
    await taskModel.countDocuments({
      fileId: mediaId,
      status: { $in: ['pending', 'processing'] },
    }),
    1,
  );

  // Same instance memoizes preparation; a fresh singleton must exercise both
  // drivers again against the already-indexed database and remain successful.
  await resizer.prepareQueue();
  resetResizerForTests();
  const secondResizer = makeResizer();
  await secondResizer.prepareQueue();

  const intactTaskIndexes = await taskModel.collection.listIndexes().toArray();
  assert.ok(
    intactTaskIndexes.some(
      ({ key, unique }) =>
        hasExactKey(key, { fileId: 1, pipeline: 1, requestKey: 1 }) &&
        unique === true,
    ),
  );
  assert.ok(
    (await lockModel.collection.listIndexes().toArray()).some(
      ({ key, expireAfterSeconds }) =>
        hasExactKey(key, { expiredAt: 1 }) && expireAfterSeconds === 0,
    ),
  );
});
