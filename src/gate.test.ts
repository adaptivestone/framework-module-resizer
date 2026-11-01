// The gate, end to end through Resizer.resolve() and runWorker(): at most one task is active per
// Resizer, media, pipeline and queue. However many reads of a cold media arrive at once, one task
// is queued; while that task waits for a retry, reads queue nothing for its media, pipeline and
// queue, not even for a new size. A task on another queue never blocks them. A task queue with gatesByTask
// (MemoryTaskQueue, like the database queue) keeps the gate in its task rows; beside one without it
// (PlainTaskQueue, the SQS shape) the gate is a lock that the worker holds through the backoff and
// releases once the task completes.
//
// These in-memory scenarios prove the gate's logic, not its atomicity: MemoryTaskQueue checks and
// stores in one synchronous step, so concurrent adds never interleave there. The proof under real
// interleaving is the MongoDB twin, 'the gate under concurrent reads (MongoDB)' in
// src/drivers/mongo/taskQueue.test.ts, against the real unique partial index.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import sharp from 'sharp';
import type { LockStore } from './contracts/locks.ts';
import type { TaskQueue } from './contracts/taskQueue.ts';
import { ResizeStorageError } from './errors.ts';
import { gateKey } from './lockKeys.ts';
import { Resizer, resetResizerForTests } from './resizer.ts';
import {
  clockLocks,
  fakeMedia,
  MemoryTaskQueue,
  PlainTaskQueue,
} from './testHelpers/fakes.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import type { MediaLike, SizeInput } from './types.d.ts';
import { runWorker } from './worker.ts';

const silent = { info() {}, warn() {}, error() {} };

const png = await sharp({
  create: {
    width: 64,
    height: 48,
    channels: 3,
    background: { r: 255, g: 0, b: 0 },
  },
})
  .png()
  .toBuffer();

const size: SizeInput = { width: 10, height: 10 };
const newSize: SizeInput = { width: 20, height: 20 };
const key = gateKey('default', 'default', 'm1', 'default');

afterEach(resetResizerForTests);

/**
 * Every scenario's Resizer: webp only, one cold media 'm1' (an original and no previews) that the
 * worker loads, and `read()` resolves it for one size (default 10×10). `download` defaults to a
 * PNG.
 */
function gated(opts: {
  tasks: TaskQueue;
  locks?: LockStore;
  download?: () => Promise<Buffer>;
}) {
  const media: MediaLike = { id: 'm1', original: { storageRef: { key: 'o' } } };
  const resizer = new Resizer({
    config: makeImageConfig({ formats: ['webp'] }),
    logger: silent,
    storage: {
      download: opts.download ?? (async () => png),
      upload: async () => ({ key: 'k' }),
      publicUrl: () => '',
    },
    media: fakeMedia({ load: async () => media }),
    locks: opts.locks,
    tasks: opts.tasks,
  });
  return {
    resizer,
    media,
    read: (sizes: SizeInput[] = [size]) => resizer.resolve({ media, sizes }),
  };
}

/** `count` reads at once: one of a new size, the rest of the queued one. */
function readsAtOnce(
  read: (sizes?: SizeInput[]) => Promise<unknown>,
  count: number,
): Promise<unknown[]> {
  return Promise.all([
    ...Array.from({ length: count - 1 }, () => read()),
    read([newSize]),
  ]);
}

/** Run the worker for `resizer` until `stop` aborts (an observer aborts it), or 5 s. */
async function work(resizer: Resizer, stop: AbortController): Promise<void> {
  const timer = setTimeout(() => stop.abort(), 5000);
  try {
    await runWorker({
      signal: stop.signal,
      logger: silent,
      resizers: [resizer],
    });
  } finally {
    clearTimeout(timer);
  }
}

test('1000 concurrent reads of a cold media create one task (a queue that gates by task)', async () => {
  const tasks = new MemoryTaskQueue();
  const { read } = gated({ tasks });
  const results = await Promise.all(Array.from({ length: 1000 }, () => read()));
  assert.equal(
    results.filter(({ decision }) => decision.missing.length !== 1).length,
    0,
    'every read reports the one missing variant',
  );
  assert.equal(tasks.rows.length, 1);
  // Every read reached the queue: the gate, not the read path, kept the other 999 out.
  assert.equal(tasks.added.length, 1000);
});

test('1000 concurrent reads of a cold media create one task (a queue without gatesByTask)', async () => {
  const tasks = new PlainTaskQueue();
  const locks = clockLocks();
  const { read } = gated({ tasks, locks });
  const results = await Promise.all(Array.from({ length: 1000 }, () => read()));
  assert.equal(
    results.filter(({ decision }) => decision.missing.length !== 1).length,
    0,
    'every read reports the one missing variant',
  );
  assert.equal(tasks.rows.length, 1);
  // The other 999 found the gate lock held and never reached the queue.
  assert.equal(tasks.added.length, 1);
  assert.equal(locks.entry(key)?.owner, tasks.rows[0].task.gateOwner);
});

test('a task in retry backoff blocks new tasks for its media, pipeline and queue', async () => {
  const tasks = new MemoryTaskQueue({
    timing: { idlePollMs: 5, retryBackoffMs: { base: 60_000, max: 60_000 } },
  });
  const { resizer, read } = gated({
    tasks,
    download: async () => {
      throw new ResizeStorageError('resize: the bucket did not answer');
    },
  });
  const stop = new AbortController();
  const failed: number[] = [];
  let failedAt = 0;
  resizer.hook('onTaskFailed', (task) => {
    failed.push(task.attempts);
    failedAt = Date.now();
    stop.abort();
  });
  await read();
  assert.equal(tasks.rows.length, 1);
  const workStarted = Date.now();
  await work(resizer, stop);
  assert.deepEqual(failed, [1], 'the first delivery failed and will retry');
  // The task waits 60 s for its retry and keeps the gate meanwhile.
  await readsAtOnce(read, 10);
  assert.equal(tasks.rows.length, 1);
  assert.equal(tasks.rows[0].status, 'pending');
  // In a real backoff: the retry is due 60 s after the failure, not at once. Bounded by clock
  // readings taken before the worker started and after the failure, not by a margin a loaded
  // machine can use up (seconds pass between the failure and these lines there).
  const { availableAt } = tasks.rows[0];
  assert.ok(availableAt >= workStarted + 60_000, 'not due before the backoff');
  assert.ok(
    availableAt <= failedAt + 60_000,
    'due one backoff after the failure',
  );
  assert.equal(tasks.added.length, 11, 'the 10 reads reached the queue');
});

test('the SQS path holds the gate through the backoff and releases it on completion', async () => {
  const tasks = new PlainTaskQueue({
    timing: {
      leaseMs: 400,
      idlePollMs: 5,
      retryBackoffMs: { base: 500, max: 500 },
    },
  });
  const base = clockLocks();
  // Every extend, with the clock reading when the Consumer called it and the TTL it asked for.
  const extendCalls: { at: number; ttlMs: number }[] = [];
  const locks = {
    ...base,
    extend: (lockKey: string, owner: string, ttlMs: number) => {
      extendCalls.push({ at: Date.now(), ttlMs });
      return base.extend(lockKey, owner, ttlMs);
    },
  };
  // When the retry was recorded, and how many extends came before: the Consumer reads the clock
  // for the hold after this, and its next extend is the hold.
  let failedAt = 0;
  let holdCall = -1;
  const fail = tasks.fail;
  tasks.fail = async (...args: Parameters<typeof fail>) => {
    const done = await fail.apply(tasks, args);
    if (!failedAt) {
      failedAt = Date.now();
      holdCall = extendCalls.length;
    }
    return done;
  };
  let downloads = 0;
  const { resizer, read } = gated({
    tasks,
    locks,
    download: async () => {
      downloads += 1;
      if (downloads === 1) {
        throw new ResizeStorageError('resize: the bucket did not answer');
      }
      return png;
    },
  });
  const stop = new AbortController();
  // Observers swallow their own errors, so they record what they see, and the test asserts after.
  const atFailure: {
    pastRetry?: number;
    hold?: { at: number; ttlMs: number };
    retryAt?: number;
    rows?: number;
  } = {};
  const atCompletion: { lock?: unknown; rows?: number } = {};
  resizer.hook('onTaskFailed', async () => {
    const lock = locks.entry(key);
    atFailure.retryAt = tasks.rows[0].availableAt;
    atFailure.pastRetry = lock ? lock.expiresAt - atFailure.retryAt : undefined;
    atFailure.hold = extendCalls[holdCall];
    await readsAtOnce(read, 10);
    atFailure.rows = tasks.rows.length;
  });
  resizer.hook('afterTaskComplete', async () => {
    atCompletion.lock = locks.entry(key) ?? null;
    await read([newSize]);
    atCompletion.rows = tasks.rows.length;
    stop.abort();
  });
  await read();
  assert.equal(tasks.rows.length, 1);
  await work(resizer, stop);
  // After the retry was scheduled: held through the 500 ms backoff and one 400 ms lease after the
  // retry is due (or after the hold was made, when a loaded machine made it once the retry was
  // already due), so longer than the 600 ms (a lease and a heartbeat from its start) a running
  // task holds it for, and far less than a gateTtlMs or cooldown hold. Read against the retry
  // time in the row, not against the observer's clock, which a loaded machine reaches late.
  const { pastRetry, hold, retryAt = 0 } = atFailure;
  assert.ok(
    pastRetry !== undefined && pastRetry >= 400,
    `held ${pastRetry} ms past the retry time`,
  );
  // One lease, exactly: the hold's end is its TTL from a clock reading the Consumer took after the
  // retry was recorded (failedAt) and before it called extend (hold.at), so the end lies between
  // those two readings plus the TTL, and must not pass one lease after the later of the retry time
  // and the call.
  assert.ok(hold, 'the retry hold extended the gate lock');
  assert.ok(
    hold.at + hold.ttlMs >= retryAt + 400,
    `held until ${hold.at + hold.ttlMs - retryAt} ms or less past the retry time`,
  );
  assert.ok(
    failedAt + hold.ttlMs <= Math.max(hold.at, retryAt) + 400,
    `held until ${failedAt + hold.ttlMs - Math.max(hold.at, retryAt)} ms or more past the retry time or the call, not one 400 ms lease`,
  );
  assert.equal(atFailure.rows, 1, 'reads during the backoff queue nothing');
  // After the retry completed: released, so a read of a new size queues a second task.
  assert.equal(atCompletion.lock, null, 'the gate lock is released');
  assert.equal(atCompletion.rows, 2);
  assert.equal(tasks.rows[0].status, 'completed');
  assert.equal(downloads, 2, 'the failed delivery, then its retry');
});

test('a task waiting on another queue with no worker does not block reads on the default queue', async () => {
  const tasks = new MemoryTaskQueue({ timing: { idlePollMs: 5 } });
  const { resizer, media, read } = gated({ tasks });
  const stop = new AbortController();
  const completed: string[] = [];
  resizer.hook('afterTaskComplete', (task) => {
    completed.push(task.queue);
    stop.abort();
  });
  // Pre-warmed on a bulk queue that no worker consumes.
  const prewarmed = await resizer.prewarm({
    media,
    sizes: [size],
    queue: 'bulk',
  });
  assert.equal(prewarmed.status, 'accepted');
  // A read on the default queue queues its own task, and the default worker runs it.
  await read();
  assert.deepEqual(
    tasks.rows.map(({ task }) => task.queue),
    ['bulk', 'default'],
  );
  await work(resizer, stop);
  assert.deepEqual(completed, ['default']);
  assert.deepEqual(
    tasks.rows.map(({ status }) => status),
    ['pending', 'completed'],
  );
});
