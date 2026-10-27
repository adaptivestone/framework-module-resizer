// FrameworkLockStore against a real MongoDB, over the framework's own Lock model. The owner is
// stored in each lock document, so two stores (the API process and the worker) see each other's
// owners, and the framework's own Lock statics still see the locks this store takes.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import Lock from '@adaptivestone/framework/models/Lock.js';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { gateKey } from '../lockKeys.ts';
import { FrameworkLockStore } from './locks.ts';

// The framework Lock model as the app registers it: its strict schema and its statics.
type LockDoc = { _id: string; expiredAt?: Date };
type LockModelType = mongoose.Model<LockDoc> & {
  acquireLock(name: string, ttlSeconds?: number): Promise<boolean>;
};

let server: MongoMemoryServer;
let connection: mongoose.Connection;
let LockModel: LockModelType;

before(async () => {
  server = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  connection = await mongoose
    .createConnection(server.getUri(), {
      dbName: `resize_framework_locks_${process.pid}`,
    })
    .asPromise();
  const schema = new mongoose.Schema(Lock.modelSchema);
  Object.assign(schema.statics, Lock.modelStatics);
  LockModel = connection.model<LockDoc, LockModelType>('Lock', schema);
  await LockModel.createCollection();
  setAppInstance({ getModel: () => LockModel } as never);
});

after(async () => {
  resetAppInstance();
  await connection.close();
  await server.stop();
});

test('two stores (two processes) share one lock and check owners', async () => {
  const a = new FrameworkLockStore();
  const b = new FrameworkLockStore();
  assert.equal(await a.acquire('k1', 'A', 60_000), true);
  assert.equal(await b.acquire('k1', 'B', 60_000), false);
  // B does not own the lock, so it cannot release it.
  assert.equal(await b.release('k1', 'B'), false);
  assert.equal(await a.release('k1', 'A'), true);
  assert.equal(await b.acquire('k1', 'B', 60_000), true);
  // Any store extends a lock for its owner: the owner lives in the database, not in the store.
  assert.equal(await a.extend('k1', 'A', 60_000), false);
  assert.equal(await a.extend('k1', 'B', 60_000), true);
});

test('a gate lock taken by one store (the API) is extended and released by another (the worker) with the owner from the task', async () => {
  const api = new FrameworkLockStore();
  const worker = new FrameworkLockStore();
  const key = gateKey('default', 'm1', 'default');
  assert.equal(await api.acquire(key, 'g1', 60_000), true);
  // The worker knows the owner only from the task's gateOwner.
  assert.equal(await worker.extend(key, 'g1', 600_000), true);
  const held = await LockModel.findById(key).lean();
  assert.ok(
    (held?.expiredAt?.getTime() ?? 0) > Date.now() + 500_000,
    'extended to the new TTL',
  );
  assert.equal(await api.acquire(key, 'g2', 60_000), false);
  assert.equal(await worker.release(key, 'g1'), true);
  assert.equal(await api.acquire(key, 'g2', 60_000), true);
});

test('the owner is stored despite the strict schema, and the framework statics still see the lock', async () => {
  const a = new FrameworkLockStore();
  assert.equal(await a.acquire('k3', 'A', 60_000), true);
  const stored = await LockModel.collection.findOne({ _id: 'k3' });
  assert.equal(stored?.owner, 'A');
  assert.equal(await LockModel.acquireLock('k3', 30), false);
});

test('a lock without an expiry, or an expired one, is taken over; a live one blocks', async () => {
  const a = new FrameworkLockStore();
  await LockModel.collection.insertOne({ _id: 'k4' });
  assert.equal(await a.acquire('k4', 'A', 60_000), true);
  assert.equal(await a.acquire('k4', 'B', 60_000), false);
  await LockModel.collection.updateOne(
    { _id: 'k4' },
    { $set: { expiredAt: new Date(Date.now() - 1000) } },
  );
  assert.equal(await a.acquire('k4', 'B', 60_000), true);
  assert.equal((await LockModel.collection.findOne({ _id: 'k4' }))?.owner, 'B');
  // The framework model's strict schema has no owner; the store writes around it, so verify()
  // checks only that the model is registered.
  new FrameworkLockStore().verify();
});
