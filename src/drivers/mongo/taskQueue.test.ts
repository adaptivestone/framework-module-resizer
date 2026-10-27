import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  test,
} from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import type {
  ClaimedTask,
  LeasedTask,
  NewTask,
  TaskAddResult,
  TaskEventHandler,
} from '../../contracts/taskQueue.ts';
import {
  ResizeGenerateError,
  ResizeNoOriginalError,
  ResizeSetupError,
} from '../../errors.ts';
import ResizeTaskModel from '../../framework/ResizeTaskModel.ts';
import { canonicalizeVariants } from '../../images.ts';
import { Resizer, resetResizerForTests } from '../../resizer.ts';
import { consume } from '../../testHelpers/consume.ts';
import { fakeMedia } from '../../testHelpers/fakes.ts';
import { makeImageConfig } from '../../testHelpers/resizeConfig.ts';
import { timingOf } from '../../timing.ts';
import type {
  MissingPreview,
  QueueTimingOptions,
  ResizeLogger,
} from '../../types.d.ts';
import { resizeTaskFields, resizeTaskIndexes } from './schemas.ts';
import { MongoTaskQueue } from './taskQueue.ts';

// Real MongoDB atomic semantics, using the same schema and indexes as framework hosts.
// Index preparation is explicitly the test fixture's host lifecycle.
let server: MongoMemoryServer;
let connection: mongoose.Connection;
let M: mongoose.Model<Record<string, unknown>>;
let tasks: MongoTaskQueue;
let logger: ResizeLogger;

before(async () => {
  server = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  connection = await mongoose
    .createConnection(server.getUri(), {
      autoIndex: false,
    })
    .asPromise();
  const schema = new mongoose.Schema(ResizeTaskModel.modelSchema, {
    timestamps: true,
    minimize: false,
    autoIndex: false,
  });
  ResizeTaskModel.initHooks(schema);
  M = connection.model('ResizeTask', schema);
  await M.createCollection();
  await M.createIndexes();
});

after(async () => {
  await connection.close();
  await server.stop();
});

const consumers = new Set<{ ctrl: AbortController; done: Promise<void> }>();
const openGates = new Set<() => void>();

// A handler gate that afterEach always opens, so a failing assertion fails the test instead of
// leaving its handler (and the afterEach that awaits the consumer) hanging.
function makeGate() {
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = () => {
      openGates.delete(releaseGate);
      resolve();
    };
  });
  openGates.add(releaseGate);
  return { gate, releaseGate };
}

beforeEach(async () => {
  await M.deleteMany({});
  configureQueue();
});

afterEach(async () => {
  for (const consumer of consumers) {
    consumer.ctrl.abort();
  }
  for (const release of [...openGates]) {
    release();
  }
  await Promise.all([...consumers].map(({ done }) => done));
  resetResizerForTests();
});

const fakeStorage = {
  download: async () => Buffer.alloc(0),
  upload: async () => ({ key: 'k' }),
  publicUrl: () => '',
};

function configureQueue(
  getModel?: () => unknown,
  override: Partial<QueueTimingOptions> = {},
) {
  const errors: unknown[][] = [];
  logger = {
    info() {},
    warn() {},
    error(...args: unknown[]) {
      errors.push(args);
    },
  };
  tasks = new MongoTaskQueue({
    ...(getModel ? { getModel } : { model: M }),
    timing: {
      leaseMs: 300,
      idlePollMs: 20,
      maxAttempts: 3,
      retryBackoffMs: { base: 50, max: 200 },
      ...override,
    },
    logger,
  });
  return { errors };
}

const fid = () => new mongoose.Types.ObjectId().toString();

function request(over: Partial<NewTask> = {}): NewTask {
  return {
    resizer: 'default',
    queue: 'default',
    mediaId: fid(),
    pipeline: 'default',
    previews: [{ sizeKey: '300x300', format: 'jpeg' }],
    ...over,
  };
}

// Add a task the queue must store, and return its task ID.
async function addedTaskId(task: NewTask): Promise<string> {
  const result = await tasks.add(task);
  assert.equal(result.status, 'added');
  return result.taskId;
}

// The task IDs of the adds that stored a task.
function addedIds(results: TaskAddResult[]): string[] {
  return results.flatMap((result) =>
    result.status === 'added' ? [result.taskId] : [],
  );
}

// A duplicate key on the gate index, shaped as the server reports it (the key order is the
// server's; the queue compares the key set).
function duplicateKey() {
  return Object.assign(new Error('E11000 duplicate key error'), {
    code: 11000,
    keyPattern: { pipeline: 1, resizer: 1, fileId: 1 },
  });
}

// A row written past the schema (so no defaults apply), as an older API or worker left it.
async function insertRaw(
  mediaId: string,
  row: Record<string, unknown>,
): Promise<string> {
  const { insertedId } = await M.collection.insertOne({
    fileId: new mongoose.Types.ObjectId(mediaId),
    resizer: 'default',
    queue: 'default',
    pipeline: 'default',
    previews: [],
    attempts: 1,
    availableAt: past(),
    ...row,
  });
  return String(insertedId);
}

interface Rec {
  completed: [LeasedTask, unknown?][];
  failed: [LeasedTask, unknown?][];
  dead: [LeasedTask, unknown?][];
  onEvent: TaskEventHandler;
}

function makeEvents(): Rec {
  const rec: Rec = {
    completed: [],
    failed: [],
    dead: [],
    onEvent: () => {},
  };
  rec.onEvent = (event, task, error) => {
    const row: [LeasedTask, unknown?] =
      error === undefined ? [task] : [task, error];
    if (event === 'completed') {
      rec.completed.push(row);
    } else if (event === 'failed') {
      rec.failed.push(row);
    } else {
      rec.dead.push(row);
    }
  };
  return rec;
}

function startConsumer(
  handle: (task: LeasedTask, opts: { signal: AbortSignal }) => Promise<void>,
  opts: { queue?: string; onEvent?: TaskEventHandler } = {},
) {
  const ctrl = new AbortController();
  const done = consume(tasks, {
    queue: opts.queue ?? 'default',
    signal: ctrl.signal,
    handle,
    onEvent: opts.onEvent,
    logger,
  });
  const consumer = { ctrl, done };
  consumers.add(consumer);
  void done.then(
    () => consumers.delete(consumer),
    () => consumers.delete(consumer),
  );
  return consumer;
}

async function consumeOne(
  handle: (task: LeasedTask, opts: { signal: AbortSignal }) => Promise<void>,
  rec: Rec = makeEvents(),
  queue = 'default',
) {
  const consumer = startConsumer(handle, {
    queue,
    onEvent: async (event, task, error) => {
      await rec.onEvent(event, task, error);
      consumer.ctrl.abort();
    },
  });
  const timeout = setTimeout(() => consumer.ctrl.abort(), 4000);
  try {
    await consumer.done;
  } finally {
    clearTimeout(timeout);
    consumer.ctrl.abort();
  }
  assert.equal(
    rec.completed.length + rec.failed.length + rec.dead.length,
    1,
    'one persisted task outcome should be reported',
  );
  return rec;
}

async function insert(
  over: Record<string, unknown> = {},
  createdAt?: Date,
): Promise<Record<string, unknown>> {
  const [doc] = await M.create(
    [
      {
        fileId: new mongoose.Types.ObjectId(),
        pipeline: 'default',
        previews: [{ sizeKey: '300x300', format: 'jpeg' }],
        status: 'pending',
        attempts: 0,
        ...over,
      },
    ],
    { writeConcern: { w: 'majority' } },
  );
  if (createdAt) {
    // Bypass Mongoose timestamp management for deterministic oldest-first ordering.
    await M.collection.updateOne({ _id: doc._id }, { $set: { createdAt } });
  }
  return doc as unknown as Record<string, unknown>;
}

const past = () => new Date(Date.now() - 60_000);
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(
  pred: () => boolean | Promise<boolean>,
  tries = 400,
  delay = 10,
) {
  for (let i = 0; i < tries; i++) {
    if (await pred()) {
      return;
    }
    await sleep(delay);
  }
  throw new Error('waitFor timed out');
}

describe('MongoTaskQueue setup', () => {
  test('requires exactly one model source', () => {
    for (const options of [undefined, {}, { model: M, getModel: () => M }]) {
      assert.throws(
        () => new MongoTaskQueue(options as never),
        (error: unknown) =>
          error instanceof ResizeSetupError &&
          error.code === 'RESIZE_MONGO_MODEL_REQUIRED',
      );
    }
  });

  test('resolves the model lazily and verifies registration', () => {
    let model: unknown;
    let reads = 0;
    const queue = new MongoTaskQueue({
      getModel: () => {
        reads += 1;
        return model;
      },
    });
    assert.equal(reads, 0);
    assert.throws(
      () => queue.verify(),
      (error: unknown) =>
        error instanceof ResizeSetupError &&
        error.code === 'RESIZE_MONGO_MODEL_MISSING',
    );
    model = M;
    assert.doesNotThrow(() => queue.verify());
    assert.equal(reads, 2);
  });

  test('reads lazy timing once through timingOf', () => {
    let reads = 0;
    const queue = new MongoTaskQueue({
      model: M,
      getTiming: () => {
        reads += 1;
        return { leaseMs: 123_000 };
      },
    });
    assert.equal(reads, 0);
    assert.equal(timingOf(queue).leaseMs, 123_000);
    assert.equal(timingOf(queue).maxAttempts, 5); // a default
    assert.equal(timingOf(queue).leaseMs, 123_000);
    assert.equal(reads, 1);
  });

  test('missing models make queue operations harmless soft failures', async () => {
    const { errors } = configureQueue(() => null);
    const claimed: ClaimedTask = {
      ...request(),
      taskId: new mongoose.Types.ObjectId().toString(),
      token: 'token',
      attempts: 1,
    };
    assert.deepEqual(await tasks.add(request()), { status: 'unconfirmed' });
    assert.equal(await tasks.claim('default', 300), null);
    assert.equal(await tasks.renew(claimed, 300), false);
    assert.equal(await tasks.complete(claimed), false);
    assert.equal(await tasks.fail(claimed, 'dead', 'error'), false);
    assert.equal(await tasks.release(claimed), false);
    assert.deepEqual(await tasks.findActive(claimed), []);
    assert.equal(errors.length, 7);
  });

  test('verify rejects a model without the fields the queue writes (an ejected 0.2 model)', () => {
    // Strict mode would silently drop these from every insert: each task would then read as
    // Resizer 'default' on queue 'default', and no task would hold the gate.
    const {
      resizer: _resizer,
      queue: _queue,
      availableAt: _availableAt,
      active: _active,
      cooldownUntil: _cooldownUntil,
      ...oldFields
    } = resizeTaskFields('File');
    const Old =
      connection.models.OldResizeTask ??
      connection.model(
        'OldResizeTask',
        new mongoose.Schema(oldFields, { timestamps: true, autoIndex: false }),
      );
    const queue = new MongoTaskQueue({ model: Old });
    assert.throws(
      () => queue.verify(),
      (error: unknown) =>
        error instanceof ResizeSetupError &&
        error.code === 'RESIZE_MONGO_MODEL_OUTDATED' &&
        /no resizer, queue, availableAt, active, cooldownUntil field/.test(
          error.message,
        ) &&
        /delete src\/models\/ResizeTask\.ts and re-run resize-scaffold/.test(
          error.message,
        ) &&
        /--eject/.test(error.message) &&
        /resizeTaskFields\(\)/.test(error.message) &&
        // --force would also overwrite the host's own resizer.ts and config file.
        !/--force/.test(error.message),
    );
  });

  test('verify rejects a model ejected before tasks carried availableAt', () => {
    // Without the path, strict mode drops every due time: retries would skip their backoff.
    const { availableAt: _availableAt, ...fields } = resizeTaskFields('File');
    const Old =
      connection.models.ResizeTaskWithoutDueTime ??
      connection.model(
        'ResizeTaskWithoutDueTime',
        new mongoose.Schema(fields, { timestamps: true, autoIndex: false }),
      );
    assert.throws(
      () => new MongoTaskQueue({ model: Old }).verify(),
      (error: unknown) =>
        error instanceof ResizeSetupError &&
        error.code === 'RESIZE_MONGO_MODEL_OUTDATED' &&
        /has no availableAt field/.test(error.message),
    );
  });

  test('verify rejects a model without active or cooldownUntil, naming the field', () => {
    // Without active every add would succeed: the gate is off. Without cooldownUntil a dead
    // task would give up the gate at once, whatever its cooldown.
    const { active: _active, ...withoutActive } = resizeTaskFields('File');
    const { cooldownUntil: _cooldownUntil, ...withoutCooldown } =
      resizeTaskFields('File');
    for (const [field, fields] of [
      ['active', withoutActive],
      ['cooldownUntil', withoutCooldown],
    ] as const) {
      const name = `ResizeTaskWithout_${field}`;
      const Old =
        connection.models[name] ??
        connection.model(
          name,
          new mongoose.Schema(fields, { timestamps: true, autoIndex: false }),
        );
      assert.throws(
        () => new MongoTaskQueue({ model: Old }).verify(),
        (error: unknown) =>
          error instanceof ResizeSetupError &&
          error.code === 'RESIZE_MONGO_MODEL_OUTDATED' &&
          error.message.includes(`has no ${field} field`),
      );
    }
  });

  test('verify accepts the package model and a model-shaped object without a schema', () => {
    assert.doesNotThrow(() => tasks.verify());
    const schemaless = new MongoTaskQueue({
      model: { findOneAndUpdate: async () => null },
    });
    assert.doesNotThrow(() => schemaless.verify());
  });
});

describe('MongoTaskQueue.add', () => {
  test('maps mediaId to fileId, stores the active task with pipeline and previews, returns the taskId', async () => {
    const payload = request({ pipeline: 'photo' });
    const before = Date.now();
    const taskId = await addedTaskId(payload);
    assert.ok(taskId);
    const doc = await M.findById(taskId).lean();
    assert.ok(doc, 'added task doc should exist');
    assert.equal(String(doc.fileId), payload.mediaId);
    assert.equal(doc.pipeline, 'photo');
    assert.equal(doc.status, 'pending');
    assert.equal(doc.attempts, 0);
    assert.equal((doc.previews as unknown[]).length, 1);
    assert.equal(doc.active, true);
    assert.equal(doc.cooldownUntil, undefined);
    assert.equal('requestKey' in doc, false);
    // Due at once.
    const availableAt = (doc.availableAt as Date).getTime();
    assert.ok(availableAt >= before && availableAt <= Date.now());
    assert.equal(doc.leaseExpiresAt, undefined);
  });

  for (const { name, preview, errorPath } of [
    {
      name: 'empty size key',
      preview: { sizeKey: '', format: 'jpeg' },
      errorPath: 'previews.0.sizeKey',
    },
    {
      name: 'empty format id',
      preview: { sizeKey: '300w', format: '' },
      errorPath: 'previews.0.format',
    },
  ]) {
    test(
      'rejects an invalid queued variant (' +
        name +
        ') without persisting a task',
      async () => {
        const { errors } = configureQueue();
        const result = await tasks.add(
          request({
            // Exercise validation for JavaScript callers and host hooks.
            previews: [preview as MissingPreview],
          }),
        );
        assert.deepEqual(result, { status: 'unconfirmed' });
        assert.equal(await M.countDocuments({}), 0);
        assert.equal(errors.length, 1);
        const error = errors[0][1];
        assert.ok(error instanceof mongoose.Error.ValidationError);
        assert.ok(error.errors[errorPath]);
      },
    );
  }

  test('a gate that opens between the insert and the read gives the task a second round', async () => {
    const stored = { _id: new mongoose.Types.ObjectId() };
    let creates = 0;
    let reads = 0;
    configureQueue(() => ({
      create: async () => {
        creates += 1;
        if (creates === 1) {
          throw duplicateKey();
        }
        return [stored];
      },
      findOne: async () => {
        reads += 1;
        return null;
      },
    }));
    assert.deepEqual(await tasks.add(request()), {
      status: 'added',
      taskId: String(stored._id),
    });
    assert.deepEqual([creates, reads], [2, 1]);
  });

  test('two rounds at most: a gate that keeps changing hands is reported in-flight', async () => {
    let creates = 0;
    let reads = 0;
    const { errors } = configureQueue(() => ({
      create: async () => {
        creates += 1;
        throw duplicateKey();
      },
      findOne: async () => {
        reads += 1;
        return null;
      },
    }));
    assert.deepEqual(await tasks.add(request()), { status: 'in-flight' });
    assert.deepEqual([creates, reads], [2, 2]);
    assert.equal(errors.length, 0, 'another add holds the gate: not an error');
  });

  test('a failed read after a duplicate key is logged and unconfirmed', async () => {
    const failure = new Error('read failed');
    const { errors } = configureQueue(() => ({
      create: async () => {
        throw duplicateKey();
      },
      findOne: async () => {
        throw failure;
      },
    }));
    assert.deepEqual(await tasks.add(request()), { status: 'unconfirmed' });
    assert.equal(errors.length, 1);
    assert.equal(errors[0][1], failure);
  });
});

describe('MongoTaskQueue.add: one active task per Resizer, media and pipeline', () => {
  test('a second add is in-flight with the active task id; another pipeline, Resizer or media is a new task', async () => {
    const mediaId = fid();
    const first = await addedTaskId(request({ mediaId }));
    // Whatever it asks for, and on whichever queue, a request for the same media and pipeline
    // waits for the active task.
    for (const over of [
      { previews: [{ sizeKey: '600x600', format: 'webp' }] },
      { queue: 'bulk' },
    ]) {
      assert.deepEqual(await tasks.add(request({ mediaId, ...over })), {
        status: 'in-flight',
        taskId: first,
      });
    }
    const others = [
      await addedTaskId(request({ mediaId, pipeline: 'photo' })),
      await addedTaskId(request({ mediaId, resizer: 'listings' })),
      await addedTaskId(request()),
    ];
    assert.equal(new Set([first, ...others]).size, 4);
    assert.equal(await M.countDocuments({ fileId: mediaId }), 3);
  });

  test('fifty concurrent adds store one active row; the others are in-flight with its id', async () => {
    const mediaId = fid();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => tasks.add(request({ mediaId }))),
    );
    const winners = addedIds(results);
    assert.equal(winners.length, 1);
    assert.deepEqual(
      results.filter((result) => result.status !== 'added'),
      Array.from({ length: 49 }, () => ({
        status: 'in-flight',
        taskId: winners[0],
      })),
    );
    assert.equal(await M.countDocuments({ fileId: mediaId, active: true }), 1);
    assert.equal(await M.countDocuments({ fileId: mediaId }), 1);
  });

  test('a task in retry backoff, or given back, keeps the gate', async (t) => {
    const mediaId = fid();
    const taskId = await addedTaskId(request({ mediaId }));
    const inFlight = { status: 'in-flight', taskId };
    const leased = await tasks.claim('default', 60_000);
    assert.equal(leased?.taskId, taskId);
    assert.ok(leased);
    assert.deepEqual(await tasks.add(request({ mediaId })), inFlight);
    assert.equal(
      await tasks.fail(leased, { retryAt: new Date(Date.now() + 60_000) }, 'x'),
      true,
    );
    assert.deepEqual(await tasks.add(request({ mediaId })), inFlight);
    // The backoff passes, and the next delivery is given back (a worker shutting down).
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 61_000 });
    const again = await tasks.claim('default', 60_000);
    assert.equal(again?.taskId, taskId);
    assert.ok(again);
    assert.equal(await tasks.release(again), true);
    assert.deepEqual(await tasks.add(request({ mediaId })), inFlight);
    assert.equal(await M.countDocuments({ fileId: mediaId }), 1);
  });

  test('complete opens the gate: the next add is a new task', async () => {
    const mediaId = fid();
    const first = await addedTaskId(request({ mediaId }));
    const leased = await tasks.claim('default', 300);
    assert.ok(leased);
    assert.equal(await tasks.complete(leased), true);
    const row = await M.findById(first).lean();
    assert.equal(row?.status, 'completed');
    assert.equal(row?.active, false);
    const next = await addedTaskId(request({ mediaId }));
    assert.notEqual(next, first);
    assert.equal(await M.countDocuments({ fileId: mediaId, active: true }), 1);
  });

  test('a dead task holds the gate for cooldownMs; then one of twenty adds takes it over and the dead row keeps its error', async () => {
    const mediaId = fid();
    const dead = await addedTaskId(request({ mediaId }));
    const leased = await tasks.claim('default', 300);
    assert.ok(leased);
    const before = Date.now();
    assert.equal(
      await tasks.fail(leased, 'dead', 'boom', { cooldownMs: 1000 }),
      true,
    );
    const cooldownUntil = (await M.findById(dead).lean())
      ?.cooldownUntil as Date;
    assert.ok(cooldownUntil.getTime() >= before + 1000);
    assert.ok(cooldownUntil.getTime() <= Date.now() + 1000);
    assert.deepEqual(await tasks.add(request({ mediaId })), {
      status: 'in-flight',
      taskId: dead,
    });
    await sleep(1050);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => tasks.add(request({ mediaId }))),
    );
    const winners = addedIds(results);
    assert.equal(winners.length, 1);
    assert.notEqual(winners[0], dead);
    assert.deepEqual(
      results.filter((result) => result.status !== 'added'),
      Array.from({ length: 19 }, () => ({
        status: 'in-flight',
        taskId: winners[0],
      })),
    );
    const row = await M.findById(dead).lean();
    assert.equal(row?.status, 'dead');
    assert.equal(row?.active, false);
    assert.equal(row?.error, 'boom');
    assert.equal(await M.countDocuments({ fileId: mediaId, active: true }), 1);
  });

  test('a dead-letter without cooldownMs opens the gate at once', async () => {
    const mediaId = fid();
    const dead = await addedTaskId(request({ mediaId }));
    const leased = await tasks.claim('default', 300);
    assert.ok(leased);
    assert.equal(await tasks.fail(leased, 'dead', 'boom'), true);
    assert.notEqual(await addedTaskId(request({ mediaId })), dead);
  });

  test('a row completed or dead-lettered by a worker from before the gate does not hold it', async () => {
    for (const status of ['completed', 'dead']) {
      const mediaId = fid();
      // The new API inserted it as the gate; an older worker finished it without touching
      // `active`, and a dead one got no cooldownUntil.
      const old = await insertRaw(mediaId, { status, active: true });
      const added = await addedTaskId(request({ mediaId }));
      assert.notEqual(added, old);
      const row = await M.findById(old).lean();
      assert.equal(row?.status, status);
      assert.equal(row?.active, false);
      assert.equal(
        await M.countDocuments({ fileId: mediaId, active: true }),
        1,
      );
    }
  });

  test('a row written before the gate, without active, does not hold it', async () => {
    const mediaId = fid();
    const old = await insertRaw(mediaId, { status: 'pending', attempts: 0 });
    const added = await addedTaskId(request({ mediaId }));
    assert.notEqual(added, old);
    assert.equal(await M.countDocuments({ fileId: mediaId }), 2);
  });

  test('a write error other than a duplicate key is logged and unconfirmed; a missing model is unconfirmed', async () => {
    const failure = new Error('MongoDB offline');
    const { errors } = configureQueue(() => ({
      create: async () => {
        throw failure;
      },
    }));
    assert.deepEqual(await tasks.add(request()), { status: 'unconfirmed' });
    assert.equal(errors.length, 1);
    assert.equal(errors[0][1], failure);
    for (const missing of [null, false]) {
      const logged = configureQueue(() => missing);
      assert.deepEqual(await tasks.add(request()), { status: 'unconfirmed' });
      assert.equal(logged.errors.length, 1);
    }
  });

  test('a duplicate key on another unique index is logged and unconfirmed, not in-flight', async () => {
    // A host model with one more unique index. Every task gets the same `tenant`, so the second
    // add collides on it, for another media: the gate index is not involved.
    const schema = new mongoose.Schema(
      {
        ...resizeTaskFields('File'),
        tenant: { type: String, default: 'acme' },
      },
      { timestamps: true, minimize: false, autoIndex: false },
    );
    for (const [keys, options] of resizeTaskIndexes) {
      schema.index(keys, options);
    }
    schema.index({ tenant: 1 }, { unique: true });
    const Host =
      connection.models.ResizeTaskWithTenant ??
      connection.model('ResizeTaskWithTenant', schema);
    await Host.createIndexes();
    await Host.deleteMany({});
    const { errors } = configureQueue(() => Host);
    assert.equal((await tasks.add(request())).status, 'added');
    assert.deepEqual(await tasks.add(request()), { status: 'unconfirmed' });
    assert.equal(errors.length, 1);
    assert.equal((errors[0][1] as { code?: unknown }).code, 11000);
    assert.equal(await Host.countDocuments({ active: true }), 1);
  });

  test('a duplicate key that does not name exactly the gate index keys is a write error', async () => {
    const message =
      'E11000 duplicate key error index: resizer_1_fileId_1_pipeline_1';
    for (const failure of [
      Object.assign(new Error(message), { code: 11000 }), // no keyPattern
      Object.assign(new Error(message), {
        code: 11000,
        keyPattern: { resizer: 1, fileId: 1 },
      }),
      Object.assign(new Error(message), {
        code: 11000,
        keyPattern: { resizer: 1, fileId: 1, pipeline: 1, queue: 1 },
      }),
      new Error(message), // only the message says so
    ]) {
      const { errors } = configureQueue(() => ({
        create: async () => {
          throw failure;
        },
      }));
      assert.deepEqual(await tasks.add(request()), { status: 'unconfirmed' });
      assert.equal(errors.length, 1);
      assert.equal(errors[0][1], failure);
    }
  });
});

describe('MongoTaskQueue.findActive', () => {
  test('returns the one pending or processing task, and [] for a dead row that still holds the gate', async () => {
    const payload = request({ pipeline: 'photo' });
    const taskId = await addedTaskId(payload);
    const query = {
      resizer: 'default',
      mediaId: payload.mediaId,
      pipeline: 'photo',
    };
    const receipt = [
      { taskId, previews: canonicalizeVariants(payload.previews) },
    ];
    const active = async () =>
      (await tasks.findActive(query)).map(({ taskId, previews }) => ({
        taskId,
        previews: canonicalizeVariants(previews),
      }));
    assert.deepEqual(await active(), receipt);
    const leased = await tasks.claim('default', 300);
    assert.ok(leased);
    assert.deepEqual(await active(), receipt);
    for (const other of [
      { ...query, pipeline: 'default' },
      { ...query, mediaId: fid() },
    ]) {
      assert.deepEqual(await tasks.findActive(other), []);
    }
    assert.equal(
      await tasks.fail(leased, 'dead', 'boom', { cooldownMs: 60_000 }),
      true,
    );
    assert.deepEqual(await tasks.findActive(query), []);
    // The dead row is still the gate: nothing will run, and nothing is reported.
    assert.deepEqual(await tasks.add(payload), {
      status: 'in-flight',
      taskId,
    });
  });

  test('reports neither a row left active by a worker from before the gate nor a row written before it', async () => {
    const mediaId = fid();
    await insertRaw(mediaId, { status: 'completed', active: true });
    await insertRaw(mediaId, { status: 'pending', attempts: 0 });
    assert.deepEqual(
      await tasks.findActive({
        resizer: 'default',
        mediaId,
        pipeline: 'default',
      }),
      [],
    );
  });

  test('only returns the task of the asking Resizer, on any queue', async () => {
    const mediaId = fid();
    const payload = request({ mediaId, pipeline: 'photo' });
    await addedTaskId(request({ ...payload, resizer: 'listings' }));
    const bulk = await addedTaskId(request({ ...payload, queue: 'bulk' }));
    const active = await tasks.findActive({
      resizer: 'default',
      mediaId,
      pipeline: 'photo',
    });
    assert.deepEqual(
      active.map(({ taskId, previews }) => ({
        taskId,
        previews: canonicalizeVariants(previews),
      })),
      [{ taskId: bulk, previews: canonicalizeVariants(payload.previews) }],
    );
  });

  test('prewarm confirms the active Mongo task through findActive', async () => {
    const payload = request({
      previews: [
        {
          sizeKey: '300x300',
          format: 'jpeg',
          requestedWidth: 300,
          requestedHeight: 300,
        },
      ],
    });
    const existing = await addedTaskId(payload);
    // A queue that gates by task needs no lock store: the active task is the gate.
    const resizer = new Resizer({
      storage: fakeStorage,
      config: makeImageConfig(),
      tasks,
      media: fakeMedia(),
      logger,
    });
    const result = await resizer.prewarm({
      media: {
        id: payload.mediaId,
        original: { storageRef: { key: 'original.jpg' } },
      },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(result.status, 'accepted');
    assert.equal(result.tasks[0].taskId, existing);
    assert.equal(await M.countDocuments({ fileId: payload.mediaId }), 1);
  });
});

// The read path against the real gate index: Resizer.resolve() on this file's queue, no lock store.
describe('the gate under concurrent reads (MongoDB)', () => {
  const size = { width: 10, height: 10 };

  /** A Resizer on this file's queue and a cold media (an original, no previews) to read. */
  function reader() {
    const resizer = new Resizer({
      storage: fakeStorage,
      config: makeImageConfig({ formats: ['webp'] }),
      tasks,
      media: fakeMedia(),
      logger,
    });
    const fileId = fid();
    const media = { id: fileId, original: { storageRef: { key: 'o' } } };
    return {
      fileId,
      read: (sizes = [size]) => resizer.resolve({ media, sizes }),
    };
  }

  test('1000 concurrent reads of a cold media create one task row', async () => {
    const { errors } = configureQueue();
    const { fileId, read } = reader();
    const results = await Promise.all(
      Array.from({ length: 1000 }, () => read()),
    );
    assert.equal(
      results.filter(({ decision }) => decision.missing.length !== 1).length,
      0,
      'every read reports the one missing variant',
    );
    assert.equal(await M.countDocuments({ fileId }), 1);
    // The other 999 adds met the gate index and were in flight, never a write error.
    assert.deepEqual(errors, []);
  });

  test('a task in retry backoff blocks new tasks', async () => {
    const { fileId, read } = reader();
    await read();
    const leased = await tasks.claim('default', 60_000);
    assert.ok(leased);
    assert.equal(
      await tasks.fail(leased, { retryAt: new Date(Date.now() + 60_000) }, 'x'),
      true,
    );
    // Ten reads, one of them of a new size: the gate is per media and pipeline.
    await Promise.all([
      ...Array.from({ length: 9 }, () => read()),
      read([{ width: 20, height: 20 }]),
    ]);
    assert.equal(await M.countDocuments({ fileId }), 1);
    const row = await M.findOne({ fileId }).lean();
    assert.equal(row?.status, 'pending');
  });
});

describe('MongoTaskQueue.claim', () => {
  test('claims the task that became due first; while leased it is due when the lease ends', async () => {
    // The later-due row is older and goes in first: _id, createdAt and due order disagree.
    await insert({ availableAt: new Date(Date.now() - 1000) }, new Date(1000));
    const first = await insert(
      { availableAt: new Date(Date.now() - 5000) },
      new Date(5000),
    );
    const leased = await tasks.claim('default', 300);
    assert.ok(leased);
    assert.equal(leased.taskId, String(first._id));
    assert.equal(leased.attempts, 1);
    assert.ok(leased.token);
    const row = await M.findById(leased.taskId).lean();
    assert.ok(row);
    assert.equal(row.status, 'processing');
    // Which pod holds the lease: every container's main process is pid 1.
    assert.equal(row.leasedBy, `${hostname().slice(0, 64)}:${process.pid}`);
    assert.equal(
      (row.availableAt as Date).getTime(),
      (row.leaseExpiresAt as Date).getTime(),
    );
  });

  test('a task in backoff is not claimed before its availableAt', async () => {
    await insert({ availableAt: new Date(Date.now() + 60_000) });
    const due = await insert({ availableAt: past() });
    assert.equal((await tasks.claim('default', 300))?.taskId, String(due._id));
    assert.equal(await tasks.claim('default', 300), null);
  });

  test('a legacy pending row keeps its retry time from leaseExpiresAt', async (t) => {
    // Written by the previous code: the retry time five minutes ahead, no availableAt.
    const start = Date.now();
    const legacy = await insert({
      leaseExpiresAt: new Date(start + 5 * 60_000),
    });
    await M.collection.updateOne(
      { _id: legacy._id },
      { $unset: { availableAt: '' } },
    );
    assert.equal(await tasks.claim('default', 300), null);
    t.mock.timers.enable({ apis: ['Date'], now: start + 5 * 60_000 + 1000 });
    assert.equal(
      (await tasks.claim('default', 300))?.taskId,
      String(legacy._id),
    );
  });

  test('a retry written by an older worker (availableAt passed, leaseExpiresAt ahead) waits', async () => {
    const retried = await insert({
      availableAt: past(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(await tasks.claim('default', 300), null);
    await M.updateOne(
      { _id: retried._id },
      { $set: { leaseExpiresAt: past() } },
    );
    assert.equal(
      (await tasks.claim('default', 300))?.taskId,
      String(retried._id),
    );
  });

  test('rows written before availableAt existed: pending is due at once, processing once its lease ends', async () => {
    const pending = await insert({});
    const expired = await insert({
      status: 'processing',
      leaseExpiresAt: past(),
    });
    await insert({
      status: 'processing',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    await M.collection.updateMany({}, { $unset: { availableAt: '' } });
    const claimed = [
      (await tasks.claim('default', 300))?.taskId,
      (await tasks.claim('default', 300))?.taskId,
    ];
    assert.deepEqual(
      claimed.sort(),
      [String(pending._id), String(expired._id)].sort(),
    );
    assert.equal(await tasks.claim('default', 300), null);
  });

  test('a live lease is respected even when its availableAt was not moved (an older worker)', async () => {
    const leased = await insert({
      status: 'processing',
      availableAt: past(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(await tasks.claim('default', 300), null);
    await M.updateOne(
      { _id: leased._id },
      { $set: { leaseExpiresAt: past() } },
    );
    assert.equal(
      (await tasks.claim('default', 300))?.taskId,
      String(leased._id),
    );
  });

  test('reclaims an expired processing lease and bumps attempts', async () => {
    await insert({
      status: 'processing',
      leaseExpiresAt: past(),
      availableAt: past(),
      attempts: 1,
    });
    const leased = await tasks.claim('default', 300);
    assert.ok(leased);
    assert.equal(leased.attempts, 2);
    assert.equal(
      (await M.findById(leased.taskId).lean())?.status,
      'processing',
    );
  });

  test('claims exhausted pending and expired processing tasks so the core can dead-letter them', async () => {
    const expired = await insert({
      status: 'processing',
      leaseExpiresAt: past(),
      availableAt: past(),
      attempts: 3,
    });
    const pending = await insert({
      status: 'pending',
      availableAt: new Date(Date.now() - 1000),
      attempts: 3,
    });
    const a = await tasks.claim('default', 300);
    const b = await tasks.claim('default', 300);
    assert.equal(a?.taskId, String(expired._id));
    assert.equal(b?.taskId, String(pending._id));
    assert.equal(a?.attempts, 4);
    assert.equal(b?.attempts, 4);
  });

  test('two concurrent claims never claim the same single task', async () => {
    await insert();
    const [a, b] = await Promise.all([
      tasks.claim('default', 300),
      tasks.claim('default', 300),
    ]);
    assert.equal((a === null) !== (b === null), true);
  });

  test('claim with resizers takes only their tasks; a row without a resizer belongs to default', async () => {
    const own = await addedTaskId(request());
    const listings = await addedTaskId(request({ resizer: 'listings' }));
    // Written before tasks recorded their Resizer (and before the gate).
    const { insertedId } = await M.collection.insertOne({
      fileId: new mongoose.Types.ObjectId(),
      queue: 'default',
      pipeline: 'default',
      previews: [],
      status: 'pending',
      attempts: 0,
      availableAt: past(),
    });
    const claimFor = async (resizers: string[]) =>
      (await tasks.claim('default', 300, undefined, { resizers }))?.taskId;
    assert.equal(await claimFor(['listings']), listings);
    assert.equal(await claimFor(['listings']), undefined);
    assert.deepEqual(
      [await claimFor(['default']), await claimFor(['default'])].sort(),
      [own, String(insertedId)].sort(),
    );
    assert.equal(await claimFor(['default']), undefined);
  });

  // The claim's own filter and sort, explained against thousands of tasks that are not due: tasks
  // in backoff and live leases must stay outside the index bounds, so after an outage a claim
  // still reads about one document, with no in-memory sort.
  async function explainClaim(): Promise<{
    docs: number;
    keys: number;
    plan: string;
  }> {
    let captured:
      | { filter: object; update: object; options: { sort?: object } }
      | undefined;
    const recording = new Proxy(M, {
      get(target, property, receiver) {
        if (property === 'findOneAndUpdate') {
          return async (
            filter: object,
            update: object,
            options: { sort?: object },
          ) => {
            captured = { filter, update, options };
            return null;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    await new MongoTaskQueue({ model: recording }).claim('default', 300);
    assert.ok(captured && connection.db);
    const explained = await connection.db.command({
      explain: {
        findAndModify: M.collection.collectionName,
        query: captured.filter,
        sort: captured.options.sort,
        update: captured.update,
      },
      verbosity: 'executionStats',
    });
    return {
      docs: explained.executionStats.totalDocsExamined,
      keys: explained.executionStats.totalKeysExamined,
      plan: JSON.stringify(explained.queryPlanner.winningPlan),
    };
  }

  async function seedNotDue() {
    const row = (status: string, at: number, extra: object = {}) => ({
      fileId: new mongoose.Types.ObjectId(),
      queue: 'default',
      resizer: 'default',
      pipeline: 'default',
      previews: [],
      status,
      attempts: 1,
      availableAt: new Date(at),
      ...extra,
    });
    const later = Date.now() + 300_000;
    const leaseEnd = Date.now() + 60_000;
    await M.collection.insertMany([
      ...Array.from({ length: 2000 }, () => row('pending', later)),
      ...Array.from({ length: 50 }, () =>
        row('processing', leaseEnd, { leaseExpiresAt: new Date(leaseEnd) }),
      ),
      ...Array.from({ length: 500 }, () => row('completed', 0)),
    ]);
  }

  for (const scenario of ['a due task', 'an expired lease'] as const) {
    test(`claiming ${scenario} among 2000 tasks in backoff and 50 live leases reads one document`, async () => {
      await seedNotDue();
      const due =
        scenario === 'a due task'
          ? await insert({ availableAt: past() })
          : await insert({
              status: 'processing',
              availableAt: past(),
              leaseExpiresAt: past(),
            });
      const { docs, keys, plan } = await explainClaim();
      assert.ok(docs <= 1, `documents examined: ${docs}`);
      assert.ok(keys <= 10, `index keys examined: ${keys}`);
      assert.doesNotMatch(plan, /"stage":"SORT"/, 'no in-memory sort');
      assert.doesNotMatch(plan, /COLLSCAN/);
      assert.match(plan, /"availableAt":1/);
      assert.equal(
        (await tasks.claim('default', 300))?.taskId,
        String(due._id),
      );
    });
  }

  test('when nothing is due, a claim reads no document', async () => {
    await seedNotDue();
    const { docs, plan } = await explainClaim();
    assert.equal(docs, 0);
    assert.doesNotMatch(plan, /"stage":"SORT"/);
    assert.equal(await tasks.claim('default', 300), null);
  });
});

describe('MongoTaskQueue named queues and task events', () => {
  test('claim takes only the requested queue; rows without a queue read as default', async () => {
    await insert({ queue: 'bulk' }, past());
    const legacy = await insert({}, past());
    await M.collection.updateOne(
      { _id: legacy._id },
      { $unset: { queue: '', resizer: '' } },
    );
    const fromDefault = await tasks.claim('default', 300);
    assert.equal(fromDefault?.taskId, String(legacy._id));
    assert.equal((await tasks.claim('bulk', 300))?.queue, 'bulk');
    assert.equal(await tasks.claim('default', 300), null);
  });

  test('the default queue claim ignores tasks waiting on bulk', async () => {
    // The new atomic API makes the queue argument explicit.
    await insert({ queue: 'bulk' }, past());
    assert.equal(await tasks.claim('default', 300), null);
  });

  test('add stores resizer and queue; the same request on another queue waits for that task', async () => {
    const payload = request({
      resizer: 'listings',
      queue: 'bulk',
      previews: [{ sizeKey: '300x300', format: 'webp' }],
    });
    const taskId = await addedTaskId(payload);
    assert.deepEqual(
      await tasks.add(request({ ...payload, queue: 'default' })),
      {
        status: 'in-flight',
        taskId,
      },
    );
    const row = await M.findById(taskId).lean();
    assert.equal(row?.resizer, 'listings');
    assert.equal(row?.queue, 'bulk');
  });

  test('a completed task event reports its resizer and queue', async () => {
    await insert({ resizer: 'listings', queue: 'bulk' }, past());
    const rec = await consumeOne(async () => {}, makeEvents(), 'bulk');
    const [[task]] = rec.completed;
    assert.equal(task.resizer, 'listings');
    assert.equal(task.queue, 'bulk');
  });

  test('a legacy task event reports resizer and queue default', async () => {
    const legacy = await insert({}, past());
    await M.collection.updateOne(
      { _id: legacy._id },
      { $unset: { queue: '', resizer: '' } },
    );
    const rec = await consumeOne(async () => {});
    const [[task]] = rec.completed;
    assert.equal(task.resizer, 'default');
    assert.equal(task.queue, 'default');
  });

  test('a throwing onEvent does not undo completion', async () => {
    const { errors } = configureQueue();
    const inserted = await insert({}, past());
    const consumer = startConsumer(async () => {}, {
      onEvent: () => {
        consumer.ctrl.abort();
        throw new Error('observer bug');
      },
    });
    await consumer.done;
    assert.equal((await M.findById(inserted._id).lean())?.status, 'completed');
    assert.ok(
      errors.some((error) =>
        String(error[0]).includes('completed event handler'),
      ),
    );
  });

  test('a throwing onEvent does not stop the worker loop', async () => {
    const first = await insert({}, new Date(1000));
    const second = await insert({}, new Date(2000));
    const seen: string[] = [];
    const consumer = startConsumer(
      async (task) => {
        seen.push(task.taskId);
      },
      {
        onEvent: async (_event, task) => {
          if (task.taskId === String(second._id)) {
            consumer.ctrl.abort();
          }
          throw new Error('observer bug');
        },
      },
    );
    await consumer.done;
    assert.deepEqual(seen, [String(first._id), String(second._id)]);
    assert.equal((await M.findById(second._id).lean())?.status, 'completed');
  });

  test('the Consumer consumes only its queue', async () => {
    const bulk = await insert({ queue: 'bulk' }, new Date(1000));
    const own = await insert({}, new Date(2000));
    const seen: string[] = [];
    const consumer = startConsumer(async (task) => {
      seen.push(task.taskId);
    });
    await waitFor(
      async () => (await M.findById(own._id).lean())?.status === 'completed',
    );
    await sleep(40);
    consumer.ctrl.abort();
    await consumer.done;
    assert.deepEqual(seen, [String(own._id)]);
    assert.equal((await M.findById(bulk._id).lean())?.status, 'pending');
  });
});

describe('MongoTaskQueue.complete fencing', () => {
  test('a valid token completes the task and reports a LeasedTask event', async () => {
    const inserted = await insert();
    const rec = await consumeOne(async () => {});
    const task = rec.completed[0][0];
    const row = await M.findById(task.taskId).lean();
    assert.equal(row?.status, 'completed');
    assert.ok(row?.completedAt);
    assert.equal(task.mediaId, String(inserted.fileId));
    assert.equal(task.taskId, String(inserted._id));
    assert.equal('fileId' in task, false);
    assert.equal('leaseToken' in task, false);
    assert.equal('token' in task, false);
    assert.equal(task.attempts, 1);
  });

  test('a lapsed but unreclaimed lease can still complete because the token fences writes', async () => {
    await insert();
    const leased = await tasks.claim('default', 300);
    assert.ok(leased);
    await M.updateOne(
      { _id: leased.taskId },
      { $set: { leaseExpiresAt: past() } },
    );
    assert.equal(await tasks.complete(leased), true);
    assert.equal((await M.findById(leased.taskId).lean())?.status, 'completed');
  });

  test('a reclaimed lease with a new token rejects the old token', async () => {
    await insert();
    const first = await tasks.claim('default', 300);
    assert.ok(first);
    // The lease ends: it is next claimable then.
    await M.updateOne(
      { _id: first.taskId },
      { $set: { leaseExpiresAt: past(), availableAt: past() } },
    );
    const second = await tasks.claim('default', 300);
    assert.ok(second);
    assert.notEqual(second.token, first.token);
    assert.equal(await tasks.complete(first), false);
    assert.equal((await M.findById(first.taskId).lean())?.status, 'processing');
  });

  test('a stale token causes no state change and no completed event', async () => {
    const inserted = await insert();
    const rec = makeEvents();
    const consumer = startConsumer(
      async (task) => {
        await M.updateOne(
          { _id: task.taskId },
          { $set: { leaseToken: 'another-worker' } },
        );
        consumer.ctrl.abort();
      },
      { onEvent: rec.onEvent },
    );
    await consumer.done;
    assert.equal((await M.findById(inserted._id).lean())?.status, 'processing');
    assert.equal(rec.completed.length, 0);
  });

  test('a completed task cannot be completed, renewed, or failed again', async () => {
    await insert();
    const leased = await tasks.claim('default', 300);
    assert.ok(leased);
    assert.equal(await tasks.complete(leased), true);
    assert.equal(await tasks.complete(leased), false);
    assert.equal(await tasks.renew(leased, 300), false);
    assert.equal(await tasks.fail(leased, 'dead', 'late failure'), false);
    const row = await M.findById(leased.taskId).lean();
    assert.equal(row?.status, 'completed');
    assert.equal(row?.deadAt, undefined);
    assert.equal(row?.error, undefined);
  });
});

describe('MongoTaskQueue.fail and the Consumer retry policy', () => {
  test('below maxAttempts returns to pending with a future retry date and failed event', async () => {
    const inserted = await insert();
    const before = Date.now();
    const rec = await consumeOne(async () => {
      throw new Error('boom');
    });
    const row = await M.findById(inserted._id).lean();
    assert.ok(row);
    assert.equal(row.status, 'pending');
    assert.equal(row.leaseToken, null);
    assert.equal(row.leaseExpiresAt, null);
    assert.ok((row.availableAt as Date).getTime() > before);
    assert.equal(rec.failed.length, 1);
    assert.equal(rec.dead.length, 0);
  });

  test('RESIZE_NO_ORIGINAL is dead-lettered on the first failure', async () => {
    const inserted = await insert();
    const rec = await consumeOne(async (task) => {
      throw new ResizeNoOriginalError(task.mediaId);
    });
    const row = await M.findById(inserted._id).lean();
    assert.equal(row?.status, 'dead');
    assert.equal(row?.attempts, 1);
    assert.ok(row?.deadAt);
    assert.match(String(row?.error), /no original/i);
    assert.equal(rec.dead.length, 1);
    assert.equal(rec.failed.length, 0);
  });

  test('RESIZE_NO_ORIGINAL with a stale token is a fenced no-op with no event', async () => {
    const inserted = await insert();
    const rec = makeEvents();
    // Stop once the fenced fail has run (a shutdown before it would give the task back instead).
    const failResults: boolean[] = [];
    const realFail = tasks.fail.bind(tasks);
    tasks.fail = async (...args) => {
      const held = await realFail(...args);
      failResults.push(held);
      consumer.ctrl.abort();
      return held;
    };
    const consumer = startConsumer(
      async (task) => {
        await M.updateOne(
          { _id: task.taskId },
          { $set: { leaseToken: 'another-worker' } },
        );
        throw new ResizeNoOriginalError(task.mediaId);
      },
      { onEvent: rec.onEvent },
    );
    await consumer.done;
    assert.deepEqual(failResults, [false]);
    const row = await M.findById(inserted._id).lean();
    assert.equal(row?.status, 'processing');
    assert.equal(row?.deadAt, undefined);
    assert.equal(rec.dead.length, 0);
    assert.equal(rec.failed.length, 0);
  });

  test('at maxAttempts the task dies with its stored error and dead-letter event', async () => {
    const inserted = await insert({ attempts: 2 });
    const rec = await consumeOne(async () => {
      throw new Error('permanent');
    });
    const row = await M.findById(inserted._id).lean();
    assert.equal(row?.status, 'dead');
    assert.equal(row?.attempts, 3);
    assert.ok(row?.deadAt);
    assert.match(String(row?.error), /permanent/);
    assert.equal(rec.dead.length, 1);
    assert.equal(rec.failed.length, 0);
  });

  test('a permanently incomplete variant reaches dead-letter with its identity', async () => {
    const inserted = await insert({ attempts: 2 });
    const rec = await consumeOne(async (task) => {
      throw new ResizeGenerateError({
        mediaId: task.mediaId,
        failed: 1,
        requested: 2,
        missing: ['300x300:webp:none'],
        message: 'resize worker incomplete: 300x300:webp:none',
        code: 'RESIZE_WORKER_INCOMPLETE',
      });
    });
    const row = await M.findById(inserted._id).lean();
    assert.equal(row?.status, 'dead');
    assert.match(String(row?.error), /300x300:webp:none/);
    assert.equal(rec.dead.length, 1);
  });

  test('a pending retry cannot be claimed until its backoff elapses', async () => {
    await insert();
    const leased = await tasks.claim('default', 300);
    assert.ok(leased);
    const retryAt = new Date(Date.now() + 150);
    assert.equal(await tasks.fail(leased, { retryAt }, 'boom'), true);
    const row = await M.findById(leased.taskId).lean();
    assert.ok(row);
    assert.equal((row.availableAt as Date).getTime(), retryAt.getTime());
    assert.equal(row.leaseExpiresAt, null); // no lease while it waits
    assert.equal(row?.leaseToken, null);
    assert.equal(row?.error, 'boom');
    assert.equal(await tasks.claim('default', 300), null);
    await waitFor(() => Date.now() > retryAt.getTime());
    const reclaimed = await tasks.claim('default', 300);
    assert.ok(reclaimed);
    assert.equal(reclaimed.taskId, leased.taskId);
    assert.equal(reclaimed.attempts, 2);
    assert.notEqual(reclaimed.token, leased.token);
  });

  for (const next of [
    { retryAt: new Date(Date.now() + 60_000) },
    'dead',
  ] as const) {
    test(
      'fail fences a stale token for ' +
        (next === 'dead' ? 'dead-letter' : 'retry'),
      async () => {
        await insert();
        const leased = await tasks.claim('default', 300);
        assert.ok(leased);
        assert.equal(
          await tasks.fail({ ...leased, token: 'stale' }, next, 'stale error'),
          false,
        );
        const row = await M.findById(leased.taskId).lean();
        assert.equal(row?.status, 'processing');
        assert.equal(row?.leaseToken, leased.token);
        assert.equal(row?.error, undefined);
      },
    );
  }

  test('direct dead-letter stores the supplied error and deadAt', async () => {
    await insert();
    const leased = await tasks.claim('default', 300);
    assert.ok(leased);
    assert.equal(await tasks.fail(leased, 'dead', 'fatal error'), true);
    const row = await M.findById(leased.taskId).lean();
    assert.equal(row?.status, 'dead');
    assert.equal(row?.error, 'fatal error');
    assert.ok(row?.deadAt instanceof Date);
    assert.equal(await tasks.fail(leased, 'dead', 'again'), false);
  });
});

describe('MongoTaskQueue.release', () => {
  test('returns a claimed task to pending, due at once, without counting the delivery', async () => {
    const inserted = await insert({ attempts: 2, error: 'earlier failure' });
    const leased = await tasks.claim('default', 60_000);
    assert.ok(leased);
    assert.equal(leased.attempts, 3);
    assert.equal(await tasks.release(leased), true);
    const row = await M.findById(inserted._id).lean();
    assert.equal(row?.status, 'pending');
    assert.equal(row?.attempts, 2);
    assert.equal(row?.leaseToken, null);
    assert.equal(row?.leaseExpiresAt, null);
    assert.ok(row && (row.availableAt as Date).getTime() <= Date.now());
    assert.equal(row?.error, 'earlier failure');
    const again = await tasks.claim('default', 300);
    assert.equal(again?.taskId, leased.taskId);
    assert.equal(again?.attempts, 3);
    assert.notEqual(again?.token, leased.token);
  });

  test('a stale token releases nothing', async () => {
    await insert();
    const leased = await tasks.claim('default', 300);
    assert.ok(leased);
    assert.equal(await tasks.release({ ...leased, token: 'stale' }), false);
    const row = await M.findById(leased.taskId).lean();
    assert.equal(row?.status, 'processing');
    assert.equal(row?.leaseToken, leased.token);
    assert.equal(row?.attempts, 1);
    assert.equal(await tasks.complete(leased), true);
    assert.equal(await tasks.release(leased), false);
  });
});

describe('MongoTaskQueue.renew fencing', () => {
  test('a valid token extends the lease; a stale token does not match', async () => {
    await insert();
    const leased = await tasks.claim('default', 300);
    assert.ok(leased);
    const initial = await M.findById(leased.taskId).lean();
    assert.ok(initial);
    const firstExpiry = (initial.leaseExpiresAt as Date).getTime();
    assert.equal(await tasks.renew(leased, 1000), true);
    const row = await M.findById(leased.taskId).lean();
    assert.ok(row);
    const expiry = (row.leaseExpiresAt as Date).getTime();
    assert.ok(expiry > firstExpiry);
    // The task stays unclaimable until the renewed lease ends.
    assert.equal((row.availableAt as Date).getTime(), expiry);
    assert.equal(await tasks.renew({ ...leased, token: 'stale' }, 2000), false);
    const unchanged = await M.findById(leased.taskId).lean();
    assert.ok(unchanged);
    assert.equal((unchanged.leaseExpiresAt as Date).getTime(), expiry);
    assert.equal((unchanged.availableAt as Date).getTime(), expiry);
  });
});

describe('Consumer with exhausted Mongo leases', () => {
  test('a crash-looped task dies exactly once with a dead-letter event and no handler call', async () => {
    const inserted = await insert({
      status: 'processing',
      leaseExpiresAt: past(),
      attempts: 3,
    });
    const rec = await consumeOne(async () => {
      assert.fail('a task above maxAttempts must never reach the handler');
    });
    const dead = await M.find({ status: 'dead' }).lean();
    assert.equal(dead.length, 1);
    assert.equal(String(dead[0]._id), String(inserted._id));
    assert.equal(dead[0].attempts, 4);
    assert.match(String(dead[0].error), /exceeded maxAttempts/);
    assert.equal(rec.dead.length, 1);
    assert.equal(
      (rec.dead[0][1] as { code?: string }).code,
      'RESIZE_TASK_MAX_ATTEMPTS',
    );
    const task = rec.dead[0][0];
    assert.ok(task.mediaId);
    assert.equal('fileId' in task, false);
    const consumer = startConsumer(
      async () => {
        assert.fail('a dead task cannot be delivered again');
      },
      { onEvent: rec.onEvent },
    );
    await sleep(40);
    consumer.ctrl.abort();
    await consumer.done;
    assert.equal(rec.dead.length, 1);
  });

  test('does not touch a still-live processing lease even at maxAttempts', async () => {
    await insert({
      status: 'processing',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      attempts: 3,
    });
    assert.equal(await tasks.claim('default', 300), null);
    assert.equal(await M.countDocuments({ status: 'dead' }), 0);
  });
});

describe('Consumer with MongoTaskQueue', () => {
  test('add, claim, handle, and complete report the completed task', async () => {
    const payload = request({ pipeline: 'photo' });
    const taskId = await addedTaskId(payload);
    const seen: { mediaId: string; taskId: string }[] = [];
    const rec = await consumeOne(async (task) => {
      seen.push({ mediaId: task.mediaId, taskId: task.taskId });
    });
    assert.deepEqual(seen, [{ mediaId: payload.mediaId, taskId }]);
    assert.equal((await M.findById(taskId).lean())?.status, 'completed');
    assert.equal(rec.completed.length, 1);
  });

  test('graceful stop waits for an in-flight handler to finish', {
    timeout: 10_000,
  }, async () => {
    const taskId = await addedTaskId(
      request({
        previews: [{ sizeKey: '1x1', format: 'jpeg' }],
      }),
    );
    const rec = makeEvents();
    let started = false;
    const { gate, releaseGate } = makeGate();
    const consumer = startConsumer(
      async () => {
        started = true;
        await gate;
      },
      { onEvent: rec.onEvent },
    );
    await waitFor(() => started);
    consumer.ctrl.abort();
    releaseGate();
    await consumer.done;
    assert.equal((await M.findById(taskId).lean())?.status, 'completed');
    assert.equal(rec.completed.length, 1);
  });

  test('a hung handler times out, fails, and leaves the worker responsive', {
    timeout: 10_000,
  }, async () => {
    configureQueue(undefined, { taskTimeoutMs: 40 });
    const taskId = await addedTaskId(
      request({
        previews: [{ sizeKey: '1x1', format: 'jpeg' }],
      }),
    );
    const { gate, releaseGate } = makeGate();
    const rec = makeEvents();
    const consumer = startConsumer(
      async () => {
        await gate;
      },
      {
        onEvent: (event, task, error) => {
          rec.onEvent(event, task, error);
          consumer.ctrl.abort();
        },
      },
    );
    await consumer.done;
    releaseGate();
    assert.equal(rec.failed.length, 1);
    assert.equal(rec.completed.length, 0);
    assert.equal(
      (rec.failed[0][1] as { code: string }).code,
      'RESIZE_TASK_TIMEOUT',
    );
    assert.equal((await M.findById(taskId).lean())?.status, 'pending');
  });

  test('a rejecting claim is logged and the loop survives to process the next task', async () => {
    const { errors } = configureQueue();
    const realClaim = tasks.claim.bind(tasks);
    let claimCalls = 0;
    tasks.claim = async (queue, leaseMs) => {
      claimCalls += 1;
      if (claimCalls === 1) {
        throw new Error('transient mongo blip');
      }
      return realClaim(queue, leaseMs);
    };
    const taskId = await addedTaskId(request());
    const rec = await consumeOne(async () => {});
    assert.ok(claimCalls >= 2);
    assert.ok(errors.length >= 1);
    assert.equal(rec.completed.length, 1);
    assert.equal((await M.findById(taskId).lean())?.status, 'completed');
  });

  test('worker-wide shutdown aborts the in-flight task signal', {
    timeout: 10_000,
  }, async () => {
    await tasks.add(request());
    let capturedSignal: AbortSignal | undefined;
    const { gate, releaseGate } = makeGate();
    const consumer = startConsumer(async (_task, opts) => {
      capturedSignal = opts.signal;
      await gate;
    });
    await waitFor(() => capturedSignal !== undefined);
    assert.equal(capturedSignal?.aborted, false);
    consumer.ctrl.abort();
    await waitFor(() => capturedSignal?.aborted === true);
    releaseGate();
    await consumer.done;
  });

  for (const prior of [0, 2]) {
    test(`a shutdown mid-task releases the task without counting it (${prior} earlier attempts of 3)`, {
      timeout: 10_000,
    }, async () => {
      const inserted = await insert({ attempts: prior });
      const rec = makeEvents();
      let started = false;
      const consumer = startConsumer(
        // Like the worker: on abort it skips the remaining variants and rejects as incomplete.
        (task, { signal }) =>
          new Promise<void>((_resolve, reject) => {
            started = true;
            signal.addEventListener(
              'abort',
              () =>
                reject(
                  new ResizeGenerateError({
                    mediaId: task.mediaId,
                    failed: 1,
                    requested: 1,
                    code: 'RESIZE_WORKER_INCOMPLETE',
                  }),
                ),
              { once: true },
            );
          }),
        { onEvent: rec.onEvent },
      );
      await waitFor(() => started);
      consumer.ctrl.abort();
      await consumer.done;
      const row = await M.findById(inserted._id).lean();
      assert.equal(row?.status, 'pending');
      assert.equal(row?.attempts, prior);
      assert.equal(row?.leaseToken, null);
      assert.equal(row?.deadAt, undefined);
      assert.equal(row?.error, undefined);
      assert.deepEqual(
        [rec.completed.length, rec.failed.length, rec.dead.length],
        [0, 0, 0],
      );
      // The next worker takes it at once, as the same attempt.
      const next = await tasks.claim('default', 300);
      assert.equal(next?.taskId, String(inserted._id));
      assert.equal(next?.attempts, prior + 1);
    });
  }

  test('an idle worker stops promptly when its signal aborts', async () => {
    configureQueue(undefined, { idlePollMs: 10_000 });
    const consumer = startConsumer(async () => {});
    await sleep(30);
    const before = Date.now();
    consumer.ctrl.abort();
    await consumer.done;
    assert.ok(Date.now() - before < 1000, 'abort wakes an idle poll');
  });

  test('heartbeat renews a real Mongo lease and prevents another claimant taking it', {
    timeout: 10_000,
  }, async () => {
    configureQueue(undefined, { leaseMs: 100 });
    const taskId = await addedTaskId(request());
    const rec = makeEvents();
    const { gate, releaseGate } = makeGate();
    let started = false;
    const consumer = startConsumer(
      async () => {
        started = true;
        await gate;
      },
      { onEvent: rec.onEvent },
    );
    await waitFor(() => started);
    const initialRow = await M.findById(taskId).lean();
    assert.ok(initialRow);
    const initial = initialRow.leaseExpiresAt as Date;
    await waitFor(async () => {
      const row = await M.findById(taskId).lean();
      assert.ok(row);
      return (row.leaseExpiresAt as Date).getTime() > initial.getTime();
    });
    // Three lease periods later the heartbeat must still hold it (not just its first renewal).
    await sleep(300);
    assert.equal(await tasks.claim('default', 100), null);
    consumer.ctrl.abort();
    releaseGate();
    await consumer.done;
    assert.equal(rec.completed.length, 1);
  });

  test('heartbeat lease loss aborts the handler and fences its completion event', {
    timeout: 10_000,
  }, async () => {
    configureQueue(undefined, { leaseMs: 100 });
    const taskId = await addedTaskId(request());
    let capturedSignal: AbortSignal | undefined;
    const { gate, releaseGate } = makeGate();
    const rec = makeEvents();
    const consumer = startConsumer(
      async (_task, opts) => {
        capturedSignal = opts.signal;
        await gate;
      },
      { onEvent: rec.onEvent },
    );
    await waitFor(() => capturedSignal !== undefined);
    await M.updateOne(
      { _id: taskId },
      { $set: { leaseToken: 'new-worker-token' } },
    );
    await waitFor(() => capturedSignal?.aborted === true);
    consumer.ctrl.abort();
    releaseGate();
    await consumer.done;
    assert.equal((await M.findById(taskId).lean())?.status, 'processing');
    assert.equal(rec.completed.length, 0);
    assert.equal(rec.failed.length, 0);
    assert.equal(rec.dead.length, 0);
  });
});
