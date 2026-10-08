// The worker's task handler (processTask) inside the core queue loop: a media error thrown while
// reading the source reaches the retry policy unwrapped, so an unusable source is dead-lettered
// on its first delivery instead of being downloaded and decoded again on every retry. After a
// dead-letter the worker holds the variants' dispatch locks for a cooldown, so reads stop queueing
// the same failing work.
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import sharp from 'sharp';
import type { LeasedTask, TaskEvent } from './contracts/taskQueue.ts';
import { ResizeMediaError } from './errors.ts';
import { consumeQueue } from './queue.ts';
import { Resizer, resetResizerForTests } from './resizer.ts';
import {
  type FakeLocks,
  fakeDb,
  MemoryTaskQueue,
} from './testHelpers/fakes.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import type { MediaLike, QueueTimingOptions, SizeInput } from './types.d.ts';
import { processTask, runWorker } from './worker.ts';

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

afterEach(resetResizerForTests);

test('a source over limits.sourcePixels is dead-lettered on its first delivery', async () => {
  const tasks = new MemoryTaskQueue({
    timing: { idlePollMs: 5, retryBackoffMs: { base: 5, max: 5 } },
  });
  let downloads = 0;
  new Resizer({
    config: makeImageConfig({
      formats: ['webp'],
      limits: { sourcePixels: 100 },
    }),
    logger: silent,
    storage: {
      download: async () => {
        downloads += 1;
        return png;
      },
      upload: async () => ({ key: 'k' }),
      publicUrl: () => '',
    },
    db: fakeDb({
      load: async () => ({
        id: 'm1',
        original: { storageRef: { key: 'o' } },
        previews: [],
      }),
    }),
    tasks,
  });
  await tasks.add({
    resizer: 'default',
    queue: 'default',
    mediaId: 'm1',
    pipeline: 'default',
    previews: [
      {
        sizeKey: '10x10',
        format: 'webp',
        requestedWidth: 10,
        requestedHeight: 10,
      },
    ],
    requestKey: 'k1',
  });
  const events: { event: TaskEvent; task: LeasedTask; error?: unknown }[] = [];
  const stop = new AbortController();
  const timeout = setTimeout(() => stop.abort(), 5000);
  await consumeQueue(tasks, {
    queue: 'default',
    signal: stop.signal,
    handle: (task, opts) => processTask(task, opts, tasks),
    onEvent: (event, task, error) => {
      events.push({ event, task, error });
      stop.abort();
    },
    logger: silent,
  });
  clearTimeout(timeout);
  assert.deepEqual(
    events.map((e) => e.event),
    ['deadLettered'],
  );
  assert.equal(
    (events[0].error as { code?: string }).code,
    'RESIZE_SOURCE_TOO_LARGE',
  );
  assert.equal(tasks.rows[0].status, 'dead');
  assert.equal(tasks.rows[0].attempts, 1);
  assert.equal(downloads, 1);
});

test('a stored SVG with unsupported dimensions is dead-lettered on its first delivery', async () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="100000"><rect width="1" height="100000" fill="red"/></svg>',
  );
  const tasks = new MemoryTaskQueue({
    timing: { idlePollMs: 5, retryBackoffMs: { base: 5, max: 5 } },
  });
  let downloads = 0;
  let uploads = 0;
  const media: MediaLike = {
    id: 'm1',
    original: {
      storageRef: { key: 'original.svg' },
      format: 'svg',
      width: 1,
      height: 100000,
    },
    previews: [],
  };
  new Resizer({
    config: makeImageConfig({ formats: ['webp'] }),
    logger: silent,
    storage: {
      download: async () => {
        downloads += 1;
        return svg;
      },
      upload: async () => {
        uploads += 1;
        return { key: 'preview' };
      },
      publicUrl: () => '',
    },
    db: fakeDb({ load: async () => media }),
    tasks,
  });
  await tasks.add({
    resizer: 'default',
    queue: 'default',
    mediaId: 'm1',
    pipeline: 'default',
    previews: [
      {
        sizeKey: '10x10',
        format: 'webp',
        requestedWidth: 10,
        requestedHeight: 10,
      },
    ],
    requestKey: 'svg-geometry',
  });
  const events: { event: TaskEvent; error?: unknown }[] = [];
  const stop = new AbortController();
  const timeout = setTimeout(() => stop.abort(), 5000);
  try {
    await consumeQueue(tasks, {
      queue: 'default',
      signal: stop.signal,
      handle: (task, opts) => processTask(task, opts, tasks),
      onEvent: (event, _task, error) => {
        events.push({ event, error });
        stop.abort();
      },
      logger: silent,
    });
  } finally {
    clearTimeout(timeout);
  }
  assert.deepEqual(
    events.map(({ event }) => event),
    ['deadLettered'],
  );
  assert.ok(events[0].error instanceof ResizeMediaError);
  assert.equal(events[0].error.code, 'RESIZE_SVG_DIMENSIONS_UNSUPPORTED');
  assert.equal(tasks.rows[0].status, 'dead');
  assert.equal(tasks.rows[0].attempts, 1);
  assert.equal(downloads, 1);
  assert.equal(uploads, 0);
  assert.deepEqual(media.previews, []);
});

describe('dead-letter cooldown', () => {
  /** Locks that expire, on a clock the test moves forward: `clock.ms` is added to real time. */
  function expiringLocks(clock: { ms: number }) {
    const expiry = new Map<string, number>();
    const calls: string[] = [];
    const locks: FakeLocks & { calls: string[] } = {
      calls,
      acquire: async (key, ttlMs) => {
        calls.push(`acquire ${key} ${ttlMs}`);
        const now = Date.now() + clock.ms;
        if ((expiry.get(key) ?? 0) > now) {
          return false;
        }
        expiry.set(key, now + ttlMs);
        return true;
      },
      release: async (key) => {
        calls.push(`release ${key}`);
        expiry.delete(key);
      },
    };
    return locks;
  }

  const size: SizeInput = { width: 10, height: 10 };

  // A Resizer whose sources are all over limits.sourcePixels, so every task is dead-lettered on
  // its first delivery. Dispatch locks last 1 s, the cooldown 10 s.
  function setup(locks: FakeLocks, timing: Partial<QueueTimingOptions> = {}) {
    const tasks = new MemoryTaskQueue({
      timing: {
        idlePollMs: 5,
        lockTtlMs: { dispatch: 1000, worker: 1000, failed: 10_000 },
        ...timing,
      },
    });
    const docs = new Map<string, MediaLike>();
    const resizer = new Resizer({
      config: makeImageConfig({
        formats: ['webp'],
        limits: { sourcePixels: 100 },
      }),
      logger: silent,
      storage: {
        download: async () => png,
        upload: async () => ({ key: 'k' }),
        publicUrl: () => '',
      },
      db: fakeDb({ load: async (id) => docs.get(id) ?? null, locks }),
      tasks,
    });
    const errors: unknown[][] = [];
    const deadLettered: LeasedTask[] = [];
    const stop = new AbortController();
    resizer.hook('onTaskDeadLettered', (task) => {
      deadLettered.push(task);
      stop.abort();
    });
    return {
      tasks,
      resizer,
      errors,
      deadLettered,
      stop,
      media(id: string): MediaLike {
        const doc: MediaLike = {
          id,
          original: {
            storageRef: { key: `o-${id}` },
            contentType: 'image/png',
          },
          previews: [],
        };
        docs.set(id, doc);
        return doc;
      },
      read: (media: MediaLike, sizes: SizeInput[] = [size]) =>
        resizer.resolve({ media, sizes }),
      queued: () => tasks.added.length,
      // Run the worker until the first dead-letter (or 5 s).
      async work() {
        const timer = setTimeout(() => stop.abort(), 5000);
        try {
          await runWorker({
            signal: stop.signal,
            logger: { ...silent, error: (...args) => errors.push(args) },
          });
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }

  test('after a dead-letter, reads do not queue that variant again until the cooldown ends', async () => {
    const clock = { ms: 0 };
    const t = setup(expiringLocks(clock));
    const m1 = t.media('m1');
    await t.read(m1);
    assert.equal(t.queued(), 1);
    await t.work();
    assert.equal(t.deadLettered.length, 1);
    // Past the 1 s dispatch lock, inside the 10 s cooldown.
    clock.ms = 5000;
    await t.read(m1);
    assert.equal(t.queued(), 1, 'the dead variant is not queued again');
    // Another variant of that media, and the same variant of another media, are not held.
    await t.read(m1, [{ width: 20, height: 20 }]);
    await t.read(t.media('m2'));
    assert.equal(t.queued(), 3);
    clock.ms = 10_001;
    await t.read(m1);
    assert.equal(t.queued(), 4, 'queued again once the cooldown ends');
  });

  test('a failing lock call is logged; nothing throws and the observer still fires', async () => {
    const locks = expiringLocks({ ms: 0 });
    const t = setup(locks);
    await t.read(t.media('m1'));
    locks.release = async () => {
      throw new Error('lock store down');
    };
    await t.work();
    assert.equal(t.deadLettered.length, 1);
    assert.ok(
      t.errors.some((args) => /cooldown/.test(String(args[0]))),
      'the failed cooldown is logged',
    );
  });

  test('the observer does not wait for the cooldown; the worker returns only after it', async () => {
    const locks = expiringLocks({ ms: 0 });
    const t = setup(locks);
    await t.read(t.media('m1'));
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let released = false;
    const release = locks.release;
    locks.release = async (key) => {
      await gate;
      released = true;
      await release(key);
    };
    let returned = false;
    const working = t.work().then(() => {
      returned = true;
    });
    while (t.deadLettered.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(
      released,
      false,
      'the observer fired before the lock calls ended',
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(
      returned,
      false,
      'the worker waits for the cooldown to be written',
    );
    openGate();
    await working;
    assert.equal(released, true);
  });

  test('a dead task of a Resizer unknown in this process takes no lock', async () => {
    const locks = expiringLocks({ ms: 0 });
    const t = setup(locks, { maxAttempts: 1 });
    await t.tasks.add({
      resizer: 'ghost',
      queue: 'default',
      mediaId: 'm1',
      pipeline: 'default',
      previews: [{ sizeKey: '10x10', format: 'webp' }],
      requestKey: 'ghost-request',
    });
    const working = t.work();
    while (t.tasks.rows[0].status !== 'dead') {
      await new Promise((r) => setTimeout(r, 5));
    }
    t.stop.abort();
    await working;
    assert.deepEqual(locks.calls, []);
    assert.ok(
      t.errors.some((args) => /unknown Resizer 'ghost'/.test(String(args[0]))),
    );
  });
});
