import assert from 'node:assert/strict';
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  test,
} from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import ResizeTaskModel from '../models/ResizeTask.ts';
import { Resizer, resetResizerForTests } from '../resizer.ts';
import { MongoTransport } from './mongo.ts';

// Against mongodb-memory-server (real atomic semantics for lease/complete/fail/renew/sweep).
// The model is compiled from the REAL ResizeTaskModel schema + initHooks, exactly as the
// framework's BaseModel.initialize does (timestamps:true gives the createdAt the lease sorts
// by). The mongo transport reaches this model through the getApp() fake's getModel.

let server: MongoMemoryServer;
let M: mongoose.Model<Record<string, unknown>>;

before(async () => {
  // first run downloads mongod
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  const schema = new mongoose.Schema(ResizeTaskModel.modelSchema, {
    timestamps: true,
    minimize: false,
  });
  ResizeTaskModel.initHooks(schema);
  M = mongoose.model('ResizeTask', schema);
});

after(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await M.deleteMany({});
});

afterEach(() => {
  resetResizerForTests();
  resetAppInstance();
});

// ---------------------------------------------------------------------------
// Harness — small-timing config, recording observers via constructor hooks.
// ---------------------------------------------------------------------------

const fakeStorage = {
  download: async () => Buffer.alloc(0),
  upload: async () => ({ key: 'k' }),
  publicUrl: () => '',
};

// One instance drives the whole file — the class is option-less and stateless (every
// method reaches the model/config ambiently), so per-test construction would add
// nothing. The lifecycle methods are PUBLIC on the class (not part of the
// QueueTransport interface) precisely so these unit tests can drive them.
const transport = new MongoTransport();

function installFakeApp(getModelImpl?: (name: string) => unknown) {
  const errors: unknown[][] = [];
  setAppInstance({
    getConfig: () => ({
      mediaModelName: 'File',
      queue: {
        leaseMs: 300,
        idlePollMs: 20,
        maxAttempts: 3,
        retryBackoffMs: { base: 50, max: 200 },
        lockTtlMs: { dispatch: 60000, worker: 60000 },
      },
    }),
    getModel:
      getModelImpl ?? ((name: string) => (name === 'ResizeTask' ? M : null)),
    logger: {
      info() {},
      warn() {},
      error(...a: unknown[]) {
        errors.push(a);
      },
    },
  } as never);
  return { errors };
}

interface Rec {
  completed: unknown[][];
  failed: unknown[][];
  dead: unknown[][];
}
function makeResizer(): Rec {
  const rec: Rec = { completed: [], failed: [], dead: [] };
  new Resizer({
    storage: fakeStorage,
    transport,
    hooks: {
      afterTaskComplete: (...a: unknown[]) => {
        rec.completed.push(a);
      },
      onTaskFailed: (...a: unknown[]) => {
        rec.failed.push(a);
      },
      onTaskDeadLettered: (...a: unknown[]) => {
        rec.dead.push(a);
      },
    },
  });
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
    // Raw driver update bypasses mongoose timestamp management, for deterministic ordering.
    await M.collection.updateOne({ _id: doc._id }, { $set: { createdAt } });
  }
  return doc as unknown as Record<string, unknown>;
}

const past = () => new Date(Date.now() - 60_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

// ---------------------------------------------------------------------------
// enqueue (05 · §10.2)
// ---------------------------------------------------------------------------

describe('MongoTransport.enqueue', () => {
  test('maps mediaId→fileId, stores pipeline + previews, returns the taskId', async () => {
    installFakeApp();
    const mediaId = new mongoose.Types.ObjectId().toString();
    const previews = [{ sizeKey: '300x300', format: 'jpeg' as const }];
    const { taskId } = await transport.enqueue({
      mediaId,
      pipeline: 'photo',
      previews,
    });
    assert.ok(taskId);
    const doc = await M.findById(taskId).lean();
    assert.equal(String(doc?.fileId), mediaId);
    assert.equal(doc?.pipeline, 'photo');
    assert.equal(doc?.status, 'pending');
    assert.equal(doc?.attempts, 0);
    assert.equal((doc?.previews as unknown[]).length, 1);
  });

  test('returns { taskId: null } and logs when getModel is falsy (no TypeError)', async () => {
    const { errors } = installFakeApp(() => false);
    const res = await transport.enqueue({
      mediaId: new mongoose.Types.ObjectId().toString(),
      pipeline: 'p',
      previews: [],
    });
    assert.equal(res.taskId, null);
    assert.ok(errors.length >= 1);
  });
});

// ---------------------------------------------------------------------------
// lease (05 · §10.2)
// ---------------------------------------------------------------------------

describe('MongoTransport.lease', () => {
  test('claims the OLDEST pending task (createdAt asc)', async () => {
    installFakeApp();
    const older = await insert({}, new Date(1000));
    await insert({}, new Date(5000));
    const leased = await transport.lease();
    assert.ok(leased);
    assert.equal(String(leased._id), String(older._id));
    assert.equal(leased.status, 'processing');
    assert.equal(leased.attempts, 1);
    assert.ok(leased.leaseToken);
    assert.equal(leased.leasedBy, `resizer-${process.pid}`);
  });

  test('reclaims an EXPIRED processing lease (and bumps attempts)', async () => {
    installFakeApp();
    await insert({ status: 'processing', leaseExpiresAt: past(), attempts: 1 });
    const leased = await transport.lease();
    assert.ok(leased);
    assert.equal(leased.status, 'processing');
    assert.equal(leased.attempts, 2);
  });

  test('NEVER reclaims a task at attempts >= maxAttempts (pending or processing)', async () => {
    installFakeApp();
    await insert({ status: 'processing', leaseExpiresAt: past(), attempts: 3 });
    await insert({ status: 'pending', attempts: 3 });
    assert.equal(await transport.lease(), null);
  });

  test('two concurrent lease() calls never claim the same single task', async () => {
    installFakeApp();
    await insert();
    const [a, b] = await Promise.all([transport.lease(), transport.lease()]);
    // Exactly one claims it (atomic findOneAndUpdate); the other finds nothing.
    assert.equal((a === null) !== (b === null), true);
  });
});

// ---------------------------------------------------------------------------
// complete / fail / renew fencing (05 · §10.2)
// ---------------------------------------------------------------------------

describe('MongoTransport.complete (fencing)', () => {
  test('a valid token completes the task and fires afterTaskComplete', async () => {
    const rec = makeResizer();
    installFakeApp();
    await insert();
    const leased = await transport.lease();
    assert.ok(leased);
    const ok = await transport.complete(
      String(leased._id),
      String(leased.leaseToken),
    );
    assert.equal(ok, true);
    const doc = await M.findById(leased._id).lean();
    assert.equal(doc?.status, 'completed');
    assert.ok(doc?.completedAt);
    assert.equal(rec.completed.length, 1);
  });

  test('a STALE token 0-matches: no state change and afterTaskComplete NOT fired', async () => {
    const rec = makeResizer();
    installFakeApp();
    await insert();
    const leased = await transport.lease();
    assert.ok(leased);
    const ok = await transport.complete(String(leased._id), 'stale-token');
    assert.equal(ok, false);
    const doc = await M.findById(leased._id).lean();
    assert.equal(doc?.status, 'processing'); // untouched
    assert.equal(rec.completed.length, 0);
  });
});

describe('MongoTransport.fail (backoff → dead-letter)', () => {
  test('below maxAttempts → back to pending with a FUTURE leaseExpiresAt + onTaskFailed', async () => {
    const rec = makeResizer();
    installFakeApp();
    await insert();
    const leased = await transport.lease(); // attempts → 1
    assert.ok(leased);
    const before = Date.now();
    await transport.fail(
      String(leased._id),
      String(leased.leaseToken),
      new Error('boom'),
      1,
    );
    const doc = await M.findById(leased._id).lean();
    assert.equal(doc?.status, 'pending');
    assert.equal(doc?.leaseToken, null);
    // backoff(1) = base(50) * 2**0 = +50ms → strictly ahead of the fail time.
    assert.ok((doc?.leaseExpiresAt as Date).getTime() > before);
    assert.equal(rec.failed.length, 1);
    assert.equal(rec.dead.length, 0);
  });

  test('at maxAttempts → dead with stored error + onTaskDeadLettered', async () => {
    const rec = makeResizer();
    installFakeApp();
    await insert({ attempts: 2 });
    const leased = await transport.lease(); // attempts → 3 (= maxAttempts)
    assert.ok(leased);
    assert.equal(leased.attempts, 3);
    await transport.fail(
      String(leased._id),
      String(leased.leaseToken),
      new Error('permanent'),
      leased.attempts as number,
    );
    const doc = await M.findById(leased._id).lean();
    assert.equal(doc?.status, 'dead');
    assert.ok(doc?.deadAt);
    assert.match(String(doc?.error), /permanent/);
    assert.equal(rec.dead.length, 1);
    assert.equal(rec.failed.length, 0);
  });

  test('a pending task in its backoff window is NOT re-leasable until the backoff elapses', async () => {
    makeResizer();
    installFakeApp();
    await insert();
    const leased = await transport.lease();
    assert.ok(leased);
    await transport.fail(
      String(leased._id),
      String(leased.leaseToken),
      new Error('boom'),
      1,
    );
    // Immediately: leaseExpiresAt is ~50ms in the future → not eligible.
    assert.equal(await transport.lease(), null);
    // After the backoff elapses → re-leasable.
    await sleep(90);
    const relaeased = await transport.lease();
    assert.ok(relaeased);
    assert.equal(relaeased.attempts, 2);
  });
});

describe('MongoTransport.renew (fencing)', () => {
  test('a valid token extends leaseExpiresAt; a stale token 0-matches', async () => {
    installFakeApp();
    await insert();
    const leased = await transport.lease();
    assert.ok(leased);
    const firstExpiry = (leased.leaseExpiresAt as Date).getTime();
    await sleep(5);
    assert.equal(
      await transport.renew(String(leased._id), String(leased.leaseToken)),
      true,
    );
    const doc = await M.findById(leased._id).lean();
    assert.ok((doc?.leaseExpiresAt as Date).getTime() > firstExpiry);
    assert.equal(
      await transport.renew(String(leased._id), 'stale-token'),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// dead-letter sweep (05 · §10.2)
// ---------------------------------------------------------------------------

describe('MongoTransport.sweepDeadLetters', () => {
  test('flips a crash-looped task to dead exactly once and fires onTaskDeadLettered', async () => {
    const rec = makeResizer();
    installFakeApp();
    await insert({ status: 'processing', leaseExpiresAt: past(), attempts: 3 });
    await transport.sweepDeadLetters();
    const dead = await M.find({ status: 'dead' }).lean();
    assert.equal(dead.length, 1);
    assert.match(String(dead[0].error), /crash loop/);
    assert.equal(rec.dead.length, 1);
    // A second sweep finds nothing new → no double-fire.
    await transport.sweepDeadLetters();
    assert.equal(rec.dead.length, 1);
  });

  test('does not touch a still-live processing lease', async () => {
    makeResizer();
    installFakeApp();
    await insert({
      status: 'processing',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      attempts: 3,
    });
    await transport.sweepDeadLetters();
    assert.equal(await M.countDocuments({ status: 'dead' }), 0);
  });
});

// ---------------------------------------------------------------------------
// startWorker end-to-end + graceful stop (05 · §10.2, 07)
// ---------------------------------------------------------------------------

describe('MongoTransport.startWorker', () => {
  test('enqueue → worker leases → handleTask runs → completed + afterTaskComplete', async () => {
    const rec = makeResizer();
    installFakeApp();
    const mediaId = new mongoose.Types.ObjectId().toString();
    const { taskId } = await transport.enqueue({
      mediaId,
      pipeline: 'photo',
      previews: [{ sizeKey: '300x300', format: 'jpeg' }],
    });
    const seen: { mediaId: string; taskId: string }[] = [];
    const ctrl = new AbortController();
    const p = transport.startWorker(
      async (task) => {
        seen.push({ mediaId: task.mediaId, taskId: task.taskId });
      },
      { signal: ctrl.signal },
    );
    await waitFor(async () => {
      const d = await M.findById(taskId).lean();
      return d?.status === 'completed';
    });
    ctrl.abort();
    await p;
    assert.equal(seen.length, 1);
    assert.equal(seen[0].mediaId, mediaId);
    assert.equal(seen[0].taskId, String(taskId));
    assert.equal(rec.completed.length, 1);
  });

  test('graceful stop: an in-flight task finishes before the loop exits', async () => {
    const rec = makeResizer();
    installFakeApp();
    const mediaId = new mongoose.Types.ObjectId().toString();
    const { taskId } = await transport.enqueue({
      mediaId,
      pipeline: 'default',
      previews: [{ sizeKey: '1x1', format: 'jpeg' }],
    });
    let started = false;
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    const ctrl = new AbortController();
    const p = transport.startWorker(
      async () => {
        started = true;
        await gate;
      },
      { signal: ctrl.signal },
    );
    await waitFor(() => started); // task is in-flight
    ctrl.abort(); // request shutdown mid-task
    releaseGate(); // let the in-flight task complete
    await p; // worker stops gracefully
    const doc = await M.findById(taskId).lean();
    assert.equal(doc?.status, 'completed'); // in-flight task finished + was completed
    assert.equal(rec.completed.length, 1);
  });

  test('idle worker stops promptly when the signal aborts', async () => {
    makeResizer();
    installFakeApp();
    const ctrl = new AbortController();
    const p = transport.startWorker(async () => {}, {
      signal: ctrl.signal,
    });
    await sleep(30); // let it spin the idle poll a few times (idlePollMs=20)
    ctrl.abort();
    await p; // resolves (abortable idle sleep)
    assert.ok(true);
  });
});
