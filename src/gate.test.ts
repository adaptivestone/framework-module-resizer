// The gate, end to end through Resizer.resolve() and runWorker(): at most one task is active per
// Resizer, media, pipeline and queue. However many reads of a cold media arrive at once, one task
// is queued; while that task waits for a retry, reads queue nothing for its media and pipeline, not
// even for a new size. A task on another queue never blocks them. A task queue with gatesByTask (MemoryTaskQueue, like the database queue)
// keeps the gate in its task rows; beside one without it (PlainTaskQueue, the SQS shape) the gate
// is a lock that the worker holds through the backoff and releases once the task completes.
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

test('a task in retry backoff blocks new tasks for its media and pipeline', async () => {
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
  resizer.hook('onTaskFailed', (task) => {
    failed.push(task.attempts);
    stop.abort();
  });
  await read();
  assert.equal(tasks.rows.length, 1);
  await work(resizer, stop);
  assert.deepEqual(failed, [1], 'the first delivery failed and will retry');
  // The task waits 60 s for its retry and keeps the gate meanwhile.
  await readsAtOnce(read, 10);
  assert.equal(tasks.rows.length, 1);
  assert.equal(tasks.rows[0].status, 'pending');
  // In a real backoff: the retry is due about 60 s from now, not at once.
  assert.ok(tasks.rows[0].availableAt - Date.now() > 59_000);
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
  const locks = clockLocks();
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
  const atFailure: { left?: number; rows?: number } = {};
  const atCompletion: { lock?: unknown; rows?: number } = {};
  resizer.hook('onTaskFailed', async () => {
    const lock = locks.entry(key);
    atFailure.left = lock ? lock.expiresAt - Date.now() : undefined;
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
  // After the retry was scheduled: held for the 500 ms backoff plus one 400 ms lease, so more
  // than the 600 ms (a lease and a heartbeat) a running task holds it for.
  const { left } = atFailure;
  assert.ok(
    left !== undefined && left > 600 && left <= 900,
    `held for ${left} ms`,
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
