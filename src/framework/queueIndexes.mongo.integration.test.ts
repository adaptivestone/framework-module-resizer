import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import LockModel from '@adaptivestone/framework/models/Lock.js';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import type { ResizeStorage } from '../contracts/storage.ts';
import { DEFAULT_SCOPE, getPreviewIdentity } from '../images.ts';
import { DISPATCH_LOCK_OWNER } from '../lockKeys.ts';
import { resetResizerForTests } from '../resizer.ts';
import { makeResizeConfig } from '../testHelpers/resizeConfig.ts';
import { FrameworkLockStore } from './locks.ts';
import { appTaskQueue } from './queue.ts';
import ResizeTaskModel from './ResizeTaskModel.ts';
import { FrameworkResizer } from './resizer.ts';

const storage: ResizeStorage = {
  download: async () => Buffer.alloc(0),
  upload: async ({ key }) => ({ key }),
  publicUrl: () => '',
};

function hasExactKey(key: unknown, expected: Record<string, number>): boolean {
  return JSON.stringify(key) === JSON.stringify(expected);
}

async function createFixture(name: string) {
  const server = await MongoMemoryServer.create({
    instance: { ip: '127.0.0.1' },
  });
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
    getConfig: () => makeResizeConfig(),
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
    locks: new FrameworkLockStore(),
    tasks: appTaskQueue(),
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
    const added = await fixture.tasks.add({
      resizer: 'default',
      queue: 'default',
      mediaId,
      pipeline: 'default',
      previews: [{ sizeKey: '640x480', format: 'webp' }],
    });
    assert.equal(added.status, 'added');
    assert.ok(added.taskId);
    fixture.tasks.verify();
    assert.equal(
      await fixture.locks.acquire(
        'resize_dispatch:test',
        DISPATCH_LOCK_OWNER,
        60_000,
      ),
      true,
    );
    const claimed = await fixture.tasks.claim('default', 60_000);
    assert.ok(claimed);
    assert.equal(await fixture.tasks.renew(claimed, 60_000), true);
    assert.equal(
      await fixture.tasks.fail(
        claimed,
        { retryAt: new Date(Date.now() - 1000) },
        'retry',
      ),
      true,
    );
    const retried = await fixture.tasks.claim('default', 60_000);
    assert.ok(retried);
    assert.equal(await fixture.tasks.complete(retried), true);
    assert.equal(
      await fixture.locks.release('resize_dispatch:test', DISPATCH_LOCK_OWNER),
      true,
    );

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

test('prepared indexes enforce the gate: concurrent adds create one active row', async () => {
  const fixture = await createFixture('prepared');
  try {
    await Promise.all([
      fixture.taskModel.createIndexes(),
      fixture.lockModel.createIndexes(),
    ]);

    const taskIndexes = await fixture.taskModel.collection
      .listIndexes()
      .toArray();
    const gate = taskIndexes.find(({ key }) =>
      hasExactKey(key, { resizer: 1, fileId: 1, pipeline: 1 }),
    );
    assert.ok(gate, 'fixture should create the gate index');
    assert.equal(
      taskIndexes.some(({ key }) =>
        hasExactKey(key, { fileId: 1, pipeline: 1, requestKey: 1 }),
      ),
      false,
      'the request-key index is gone',
    );
    assert.ok(
      taskIndexes.some(({ key }) =>
        hasExactKey(key, { queue: 1, status: 1, availableAt: 1 }),
      ),
      'fixture should create the queue-scoped claim index',
    );
    for (const old of [
      { queue: 1, status: 1, createdAt: 1 },
      { status: 1, createdAt: 1 },
    ]) {
      assert.equal(
        taskIndexes.some(({ key }) => hasExactKey(key, old)),
        false,
        `the old lease index ${JSON.stringify(old)} is gone`,
      );
    }
    assert.equal(gate.unique, true);
    assert.deepEqual(gate.partialFilterExpression, { active: true });

    const mediaId = new mongoose.Types.ObjectId().toString();
    const request = {
      resizer: 'default',
      queue: 'default',
      mediaId,
      pipeline: 'default',
      previews: [{ sizeKey: '640x480', format: 'webp' as const }],
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => fixture.tasks.add(request)),
    );
    const added = results.flatMap((result) =>
      result.status === 'added' ? [result.taskId] : [],
    );
    assert.equal(added.length, 1);
    assert.deepEqual(
      results.filter((result) => result.status !== 'added'),
      Array.from({ length: 19 }, () => ({
        status: 'in-flight',
        taskId: added[0],
      })),
    );
    assert.equal(
      await fixture.taskModel.countDocuments({ fileId: mediaId, active: true }),
      1,
    );
    assert.equal(
      await fixture.taskModel.countDocuments({ fileId: mediaId }),
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
    // The active task of this media holds two payloads for one preview identity.
    await fixture.taskModel.create({
      fileId: mediaId,
      pipeline: 'default',
      active: true,
      status: 'pending',
      previews: conflictingPreviews,
    });

    const identity = getPreviewIdentity(DEFAULT_SCOPE, '30w', 'webp');
    assert.equal(
      await fixture.locks.acquire(
        `resize_dispatch:${mediaId}:${identity}`,
        DISPATCH_LOCK_OWNER,
        60_000,
      ),
      true,
    );

    const resizer = new FrameworkResizer({
      storage,
      locks: fixture.locks,
      tasks: fixture.tasks,
    });
    const result = await resizer.prewarm({
      media: { id: mediaId, original: { storageRef: { key: 'original.jpg' } } },
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
