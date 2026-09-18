import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import LockModel from '@adaptivestone/framework/models/Lock.js';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { getPreviewIdentity } from './images.ts';
import { FrameworkLockProvider } from './locks/framework.ts';
import ResizeTaskModel from './models/ResizeTask.ts';
import { Resizer, resetResizerForTests } from './resizer.ts';
import type { ResizeStorage } from './storage/AbstractStorage.ts';
import { MongoTransport } from './transports/mongo.ts';

const storage: ResizeStorage = {
  download: async () => Buffer.alloc(0),
  upload: async ({ key }) => ({ key }),
  publicUrl: () => '',
};

function hasExactKey(key: unknown, expected: Record<string, number>): boolean {
  return JSON.stringify(key) === JSON.stringify(expected);
}

async function createFixture(name: string) {
  const server = await MongoMemoryServer.create();
  const dbName = `resize_${name}_${process.pid}_${Date.now()}`;
  const connection = await mongoose
    .createConnection(server.getUri(), { autoIndex: false, dbName })
    .asPromise();

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
    `ResizeTask_${name}_${process.pid}`,
    taskSchema,
    `resize_tasks_${name}_${process.pid}`,
  );
  const lockModel = connection.model(
    `Lock_${name}_${process.pid}`,
    lockSchema,
    `locks_${name}_${process.pid}`,
  );
  await Promise.all([
    taskModel.createCollection(),
    lockModel.createCollection(),
  ]);

  setAppInstance({
    getConfig: () => ({ mediaModelName: 'File' }),
    getModel: (modelName: string) => {
      if (modelName === 'ResizeTask') {
        return taskModel;
      }
      if (modelName === 'Lock') {
        return lockModel;
      }
      return undefined;
    },
    logger: { info() {}, warn() {}, error() {} },
  } as never);

  return {
    server,
    connection,
    taskModel,
    lockModel,
    transport: new MongoTransport(),
    lockProvider: new FrameworkLockProvider(),
  };
}

async function closeFixture(
  fixture: Awaited<ReturnType<typeof createFixture>>,
) {
  resetResizerForTests();
  resetAppInstance();
  await fixture.connection.close().catch(() => {});
  await fixture.server.stop().catch(() => {});
}

test('resizer operations do not create secondary indexes when autoIndex is disabled', async () => {
  const fixture = await createFixture('no_effects');
  try {
    const mediaId = new mongoose.Types.ObjectId().toString();
    await fixture.transport.enqueue({
      mediaId,
      pipeline: 'default',
      previews: [{ sizeKey: '640x480', format: 'webp' }],
    });
    await fixture.lockProvider.acquire('resize_dispatch:test', 60_000);

    assert.deepEqual(
      (await fixture.taskModel.collection.listIndexes().toArray()).map(
        ({ key }) => key,
      ),
      [{ _id: 1 }],
    );
    assert.deepEqual(
      (await fixture.lockModel.collection.listIndexes().toArray()).map(
        ({ key }) => key,
      ),
      [{ _id: 1 }],
    );
  } finally {
    await closeFixture(fixture);
  }
});

test('prepared indexes preserve concurrent enqueue deduplication', async () => {
  const fixture = await createFixture('prepared');
  try {
    await Promise.all([
      fixture.taskModel.createIndexes(),
      fixture.lockModel.createIndexes(),
    ]);

    const taskIndexes = await fixture.taskModel.collection
      .listIndexes()
      .toArray();
    const dedupe = taskIndexes.find(({ key }) =>
      hasExactKey(key, { fileId: 1, pipeline: 1, requestKey: 1 }),
    );
    assert.ok(dedupe, 'fixture should create the active-request dedupe index');
    assert.equal(dedupe.unique, true);
    assert.deepEqual(dedupe.partialFilterExpression, {
      status: { $in: ['pending', 'processing'] },
      requestKey: { $exists: true },
    });

    const mediaId = new mongoose.Types.ObjectId().toString();
    const request = {
      mediaId,
      pipeline: 'default',
      previews: [{ sizeKey: '640x480', format: 'webp' as const }],
    };
    const receipts = await Promise.all(
      Array.from({ length: 20 }, () => fixture.transport.enqueue(request)),
    );
    const taskIds = receipts.map(({ taskId }) => taskId);
    assert.ok(taskIds.every((taskId) => typeof taskId === 'string' && taskId));
    assert.equal(new Set(taskIds).size, 1);
    assert.equal(
      await fixture.taskModel.countDocuments({
        fileId: mediaId,
        status: { $in: ['pending', 'processing'] },
      }),
      1,
    );
  } finally {
    await closeFixture(fixture);
  }
});

test('strict enqueue does not confirm a payload from a conflicting Mongo task', async () => {
  const fixture = await createFixture('strict_conflict');
  try {
    const mediaId = new mongoose.Types.ObjectId().toString();
    const conflictingPreviews = [
      { sizeKey: '30w', format: 'webp' as const, requestedWidth: 20 },
      { sizeKey: '30w', format: 'webp' as const, requestedWidth: 30 },
    ];
    await fixture.taskModel.create({
      fileId: mediaId,
      pipeline: 'default',
      requestKey: 'legacy-conflicting-payload',
      status: 'pending',
      previews: conflictingPreviews,
    });

    const identity = getPreviewIdentity('30w', 'webp');
    assert.equal(
      await fixture.lockProvider.acquire(
        `resize_dispatch:${mediaId}:${identity}`,
        60_000,
      ),
      true,
    );

    const resizer = new Resizer({
      storage,
      transport: fixture.transport,
      lockProvider: fixture.lockProvider,
    });
    const result = await resizer.enqueueRequired({
      media: { id: mediaId, original: { key: 'original.jpg' } },
      sizes: [{ width: 30 }],
      formats: ['webp'],
    });

    assert.equal(result.status, 'incomplete');
    assert.equal(result.accepted.length, 0);
    assert.equal(result.unconfirmed.length, 1);
    assert.equal(result.tasks.length, 0);
    assert.ok(
      result.issues.some(
        (issue) => issue.code === 'RESIZE_ENQUEUE_VARIANT_CONFLICT',
      ),
    );
  } finally {
    await closeFixture(fixture);
  }
});
