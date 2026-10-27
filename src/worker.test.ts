// The worker's task handler (processTask) inside the worker loop: a media error thrown while
// reading the source reaches the retry policy unwrapped, so an unusable source is dead-lettered
// on its first delivery instead of being downloaded and decoded again on every retry. After a
// dead-letter the worker holds the variants' dispatch locks for a cooldown, so reads stop queueing
// the same failing work. runWorker serves only the Resizers it starts with.
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import sharp from 'sharp';
import type { LockStore } from './contracts/locks.ts';
import type {
  LeasedTask,
  TaskEvent,
  TaskQueue,
} from './contracts/taskQueue.ts';
import {
  ResizeGenerateError,
  ResizeMediaError,
  ResizeSecurityError,
  ResizeSetupError,
} from './errors.ts';
import {
  Resizer,
  type ResizerOptions,
  resetResizerForTests,
} from './resizer.ts';
import { consume } from './testHelpers/consume.ts';
import {
  fakeMedia,
  MemoryTaskQueue,
  memoryLocks,
  ReleasingTaskQueue,
} from './testHelpers/fakes.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import type {
  MediaLike,
  Preview,
  QueueTimingOptions,
  SizeInput,
} from './types.d.ts';
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
    media: fakeMedia({
      load: async () => ({
        id: 'm1',
        original: { storageRef: { key: 'o' } },
        previews: [],
      }),
    }),
    locks: memoryLocks(),
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
  await consume(tasks, {
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
  assert.equal((events[0].error as { retryable?: boolean }).retryable, false);
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
    media: fakeMedia({ load: async () => media }),
    locks: memoryLocks(),
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
    await consume(tasks, {
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
  assert.equal(events[0].error.retryable, false);
  assert.equal(tasks.rows[0].status, 'dead');
  assert.equal(tasks.rows[0].attempts, 1);
  assert.equal(downloads, 1);
  assert.equal(uploads, 0);
  assert.deepEqual(media.previews, []);
});

/** Consume `tasks` with processTask until the first task event (or 5 s), and return the events. */
async function firstEvent(tasks: MemoryTaskQueue) {
  const events: { event: TaskEvent; error?: unknown }[] = [];
  const stop = new AbortController();
  const timeout = setTimeout(() => stop.abort(), 5000);
  try {
    await consume(tasks, {
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
  return events;
}

const webp10 = {
  sizeKey: '10x10',
  format: 'webp',
  requestedWidth: 10,
  requestedHeight: 10,
};

test('a storage.download security refusal is dead-lettered on its first delivery', async () => {
  const tasks = new MemoryTaskQueue({
    timing: { idlePollMs: 5, retryBackoffMs: { base: 5, max: 5 } },
  });
  let downloads = 0;
  new Resizer({
    config: makeImageConfig({ formats: ['webp'] }),
    logger: silent,
    storage: {
      download: async () => {
        downloads += 1;
        throw new ResizeSecurityError('resize: the ref leaves the bucket');
      },
      upload: async () => ({ key: 'k' }),
      publicUrl: () => '',
    },
    media: fakeMedia({
      load: async () => ({
        id: 'm1',
        original: { storageRef: { key: '../o' } },
        previews: [],
      }),
    }),
    locks: memoryLocks(),
    tasks,
  });
  await tasks.add({
    resizer: 'default',
    queue: 'default',
    mediaId: 'm1',
    pipeline: 'default',
    previews: [webp10],
    requestKey: 'security',
  });
  const events = await firstEvent(tasks);
  assert.deepEqual(
    events.map((e) => e.event),
    ['deadLettered'],
  );
  assert.ok(events[0].error instanceof ResizeSecurityError);
  assert.equal(events[0].error.retryable, false);
  assert.equal(tasks.rows[0].status, 'dead');
  assert.equal(tasks.rows[0].attempts, 1);
  assert.equal(downloads, 1);
});

test('a variant error with retryable: false fails only its variant; the task fails with the retryable RESIZE_WORKER_INCOMPLETE', async () => {
  const tasks = new MemoryTaskQueue({
    timing: { idlePollMs: 5, retryBackoffMs: { base: 60_000, max: 60_000 } },
  });
  const media: MediaLike = {
    id: 'm1',
    original: { storageRef: { key: 'o' } },
    previews: [],
  };
  const stored = new Map<string, Preview[]>();
  new Resizer({
    config: makeImageConfig({ formats: ['webp'] }),
    logger: silent,
    storage: {
      download: async () => png,
      upload: async () => ({ key: 'k' }),
      publicUrl: () => '',
    },
    media: fakeMedia({ load: async () => media, previews: stored }),
    locks: memoryLocks(),
    tasks,
    pipelines: {
      default: {
        variantSteps: [
          async (img, { variant }) => {
            if (variant.sizeKey === '20x20') {
              throw new ResizeMediaError(
                'resize: this variant cannot be made',
                {
                  code: 'TEST_VARIANT_REFUSED',
                  retryable: false,
                },
              );
            }
            return img;
          },
        ],
      },
    },
  });
  await tasks.add({
    resizer: 'default',
    queue: 'default',
    mediaId: 'm1',
    pipeline: 'default',
    previews: [
      webp10,
      {
        sizeKey: '20x20',
        format: 'webp',
        requestedWidth: 20,
        requestedHeight: 20,
      },
    ],
    requestKey: 'variant-refused',
  });
  const events = await firstEvent(tasks);
  assert.deepEqual(
    events.map((e) => e.event),
    ['failed'],
  );
  assert.ok(events[0].error instanceof ResizeGenerateError);
  assert.equal(events[0].error.code, 'RESIZE_WORKER_INCOMPLETE');
  assert.equal(events[0].error.retryable, true);
  assert.equal(tasks.rows[0].status, 'pending');
  assert.equal(tasks.rows[0].attempts, 1);
  // The other variant is stored.
  assert.deepEqual(
    (stored.get('m1') ?? []).map((preview) => preview.sizeKey),
    ['10x10'],
  );
});

// A Resizer named `name` on `tasks`. Its default media store has no docs, so each of its tasks is a
// no-op complete.
function queuedResizer(
  name: string,
  tasks: ResizerOptions['tasks'],
  media: ResizerOptions['media'] = fakeMedia(),
): Resizer {
  return new Resizer({
    name,
    config: makeImageConfig({ formats: ['webp'] }),
    logger: silent,
    storage: {
      download: async () => png,
      upload: async () => ({ key: 'k' }),
      publicUrl: () => '',
    },
    media,
    locks: memoryLocks(),
    tasks,
  });
}

const taskOf = (resizer: string) => ({
  resizer,
  queue: 'default',
  mediaId: 'm1',
  pipeline: 'default',
  previews: [{ sizeKey: '10x10', format: 'webp' }],
  requestKey: `${resizer}-request`,
});

/** Run the worker until `done()` (or 5 s), then stop it and wait for it to return. */
async function workUntil(
  opts: Omit<Parameters<typeof runWorker>[0], 'signal'>,
  done: () => boolean,
): Promise<void> {
  const stop = new AbortController();
  const working = runWorker({ ...opts, signal: stop.signal });
  const until = Date.now() + 5000;
  try {
    while (!done()) {
      assert.ok(
        Date.now() < until,
        'the worker never reached the expected state',
      );
      await new Promise((r) => setTimeout(r, 5));
    }
  } catch (err) {
    // A failed wait still stops the worker, so the test file can exit; the assertion is the error.
    stop.abort();
    await working.catch(() => {});
    throw err;
  }
  stop.abort();
  await working;
}

// A second TaskQueue object over the same rows, as two MongoTaskQueue instances on one collection
// are: the startup check compares task queue objects, so it cannot see that they share tasks.
const sameRows = (tasks: ReleasingTaskQueue): TaskQueue => ({
  add: (task) => tasks.add(task),
  claim: (queue, leaseMs) => tasks.claim(queue, leaseMs),
  renew: (task, leaseMs) => tasks.renew(task, leaseMs),
  complete: (task) => tasks.complete(task),
  fail: (task, next, error) => tasks.fail(task, next, error),
  release: (task) => tasks.release(task),
  getTiming: () => tasks.getTiming(),
});

test('a task of a Resizer the worker does not serve is given back, never run or dead-lettered, and logged once per Resizer', async () => {
  const tasks = new ReleasingTaskQueue({
    timing: { idlePollMs: 5, maxAttempts: 2 },
  });
  const a = queuedResizer('a', tasks);
  let loads = 0;
  queuedResizer('b', sameRows(tasks), async () => {
    loads += 1;
    return fakeMedia();
  });
  // Two tasks of 'b', older than a's, so they are claimed first.
  await tasks.add({ ...taskOf('b'), mediaId: 'b1', requestKey: 'b1' });
  await tasks.add({ ...taskOf('b'), mediaId: 'b2', requestKey: 'b2' });
  await tasks.add(taskOf('a'));
  const [b1, b2, aRow] = tasks.rows;
  const errors: unknown[][] = [];
  await workUntil(
    {
      logger: { ...silent, error: (...args) => errors.push(args) },
      resizers: [a],
    },
    // Each of b's tasks given back more often than maxAttempts allows deliveries.
    () =>
      aRow.status === 'completed' &&
      tasks.releaseCalls.filter((id) => id === b1.id).length > 2 &&
      tasks.releaseCalls.includes(b2.id),
  );
  for (const row of [b1, b2]) {
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 0);
    assert.equal(row.error, undefined);
  }
  assert.equal(loads, 0, "b's parts were never loaded");
  const aboutB = errors.filter((args) =>
    /Resizer 'b' is not served by this worker/.test(String(args[0])),
  );
  assert.equal(aboutB.length, 1, 'logged once for both tasks');
  assert.match(String(aboutB[0][0]), /given back to the queue/);
  assert.equal(aboutB[0].length, 1, 'the message alone');
});

test('runWorker({ resizers }) serves only the given Resizers; on a task queue without release, a task of another fails with RESIZE_NO_RESIZER', async () => {
  const tasks = new MemoryTaskQueue({ timing: { idlePollMs: 5 } });
  const a = queuedResizer('a', tasks);
  // Not listed, on its own task queue: it does not share a's queue, so the worker may start.
  queuedResizer('c', new MemoryTaskQueue());
  // Two tasks of Resizer 'b', which only another process constructs. They are the older ones, so
  // they are claimed first.
  await tasks.add({ ...taskOf('b'), mediaId: 'b1', requestKey: 'b1' });
  await tasks.add({ ...taskOf('b'), mediaId: 'b2', requestKey: 'b2' });
  await tasks.add(taskOf('a'));
  const [b1, b2, aRow] = tasks.rows;
  const errors: unknown[][] = [];
  await workUntil(
    {
      logger: { ...silent, error: (...args) => errors.push(args) },
      resizers: [a],
    },
    () => aRow.status === 'completed' && b1.attempts === 1 && b2.attempts === 1,
  );
  // Failed, so retried after a backoff (and dead-lettered after maxAttempts).
  for (const row of [b1, b2]) {
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    assert.match(row.error ?? '', /Resizer 'b' is not served by this worker/);
  }
  const said = errors.filter((args) =>
    /Resizer 'b' is not served by this worker.*cannot give tasks back, so its tasks fail with RESIZE_NO_RESIZER/.test(
      String(args[0]),
    ),
  );
  assert.equal(said.length, 1, 'logged once for both tasks');
});

test('runWorker({ resizers: [] }) fails with RESIZE_NO_RESIZER', async () => {
  queuedResizer('default', new MemoryTaskQueue());
  await assert.rejects(
    () =>
      runWorker({ signal: AbortSignal.abort(), logger: silent, resizers: [] }),
    (err: unknown) =>
      err instanceof ResizeSetupError &&
      err.code === 'RESIZE_NO_RESIZER' &&
      /the `resizers` list is empty/.test(err.message),
  );
});

test('runWorker accepts a Resizer listed twice', async () => {
  const a = queuedResizer('default', new MemoryTaskQueue());
  await runWorker({
    signal: AbortSignal.abort(),
    logger: silent,
    resizers: [a, a],
  });
});

test('two different Resizers listed under one name are RESIZE_DUPLICATE_RESIZER', async () => {
  const tasks = new MemoryTaskQueue();
  const first = queuedResizer('x', tasks);
  // The registry holds one Resizer per name; a list can hold two that were never registered together.
  resetResizerForTests();
  const second = queuedResizer('x', tasks);
  await assert.rejects(
    () =>
      runWorker({
        signal: AbortSignal.abort(),
        logger: silent,
        resizers: [first, second],
      }),
    (err: unknown) =>
      err instanceof ResizeSetupError &&
      err.code === 'RESIZE_DUPLICATE_RESIZER' &&
      /the `resizers` list names 'x' twice/.test(err.message),
  );
});

describe('a worker that serves only some of the Resizers on a task queue', () => {
  const unlisted = (err: unknown, names: RegExp) =>
    err instanceof ResizeSetupError &&
    err.code === 'RESIZE_QUEUE_SHARED_RESIZER_UNLISTED' &&
    /queue 'default'/.test(err.message) &&
    names.test(err.message);

  test('is refused at start, naming the queue and the unlisted Resizers, before any claim', async () => {
    const tasks = new MemoryTaskQueue({ timing: { idlePollMs: 5 } });
    let claims = 0;
    tasks.claim = async () => {
      claims += 1;
      return null;
    };
    const a = queuedResizer('a', tasks);
    queuedResizer('b', tasks);
    queuedResizer('c', tasks);
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 5000);
    try {
      await assert.rejects(
        () => runWorker({ signal: stop.signal, logger: silent, resizers: [a] }),
        (err: unknown) => unlisted(err, /'b', 'c'/),
      );
    } finally {
      clearTimeout(timer);
    }
    assert.equal(claims, 0);
  });

  test('a Resizer whose task queue is a function that has not run yet is loaded and compared', async () => {
    const tasks = new MemoryTaskQueue();
    const a = queuedResizer('a', tasks);
    queuedResizer('lazy', async () => tasks);
    await assert.rejects(
      () =>
        runWorker({
          signal: AbortSignal.abort(),
          logger: silent,
          resizers: [a],
        }),
      (err: unknown) => unlisted(err, /'lazy'/),
    );
  });

  // An unserved Resizer whose storage fails to load, and whose task queue part is `tasks`.
  const storageDown = (name: string, tasks: ResizerOptions['tasks']) =>
    new Resizer({
      name,
      config: makeImageConfig({ formats: ['webp'] }),
      logger: silent,
      storage: async () => {
        throw new Error('storage not up');
      },
      media: fakeMedia(),
      locks: memoryLocks(),
      tasks,
    });

  test('a Resizer whose other parts fail to load is still compared by its task queue', async () => {
    const tasks = new MemoryTaskQueue();
    const a = queuedResizer('a', tasks);
    // The storage fails first, while the task queue is still loading.
    storageDown('half', async () => {
      await new Promise((r) => setTimeout(r, 20));
      return tasks;
    });
    await assert.rejects(
      () =>
        runWorker({
          signal: AbortSignal.abort(),
          logger: silent,
          resizers: [a],
        }),
      (err: unknown) => unlisted(err, /'half'/),
    );
  });

  test('a Resizer whose task queue cannot be loaded fails startup: it may share one', async () => {
    const tasks = new MemoryTaskQueue();
    let claims = 0;
    tasks.claim = async () => {
      claims += 1;
      return null;
    };
    const a = queuedResizer('a', tasks);
    const queueDown = new Error('queue not up');
    queuedResizer('broken', async () => {
      throw queueDown;
    });
    // Its storage fails too: the task queue alone decides.
    storageDown('worse', async () => {
      throw queueDown;
    });
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 5000);
    try {
      await assert.rejects(
        () => runWorker({ signal: stop.signal, logger: silent, resizers: [a] }),
        (err: unknown) =>
          unlisted(err, /'broken', 'worse'/) &&
          /could not be determined/.test((err as Error).message) &&
          (err as Error).cause === queueDown,
      );
    } finally {
      clearTimeout(timer);
    }
    assert.equal(claims, 0);
  });

  test('an unserved Resizer on its own task queue, or eager-only, lets the worker start', async () => {
    const tasks = new MemoryTaskQueue();
    const a = queuedResizer('a', tasks);
    storageDown('own', async () => new MemoryTaskQueue());
    storageDown('eager', undefined);
    await runWorker({
      signal: AbortSignal.abort(),
      logger: silent,
      resizers: [a],
    });
  });
});

test('a listed Resizer whose ready() rejects makes runWorker reject at startup before any claim', async () => {
  const tasks = new MemoryTaskQueue({ timing: { idlePollMs: 5 } });
  let claims = 0;
  tasks.claim = async () => {
    claims += 1;
    return null;
  };
  const mediaDown = new ResizeSetupError('media store is down', {
    code: 'MEDIA_DOWN',
  });
  const healthy = queuedResizer('default', tasks);
  const broken = queuedResizer('broken', tasks, async () => {
    throw mediaDown;
  });
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 5000);
  try {
    await assert.rejects(
      () =>
        runWorker({
          signal: stop.signal,
          logger: silent,
          resizers: [healthy, broken],
        }),
      (err: unknown) => err === mediaDown,
    );
  } finally {
    clearTimeout(timer);
  }
  assert.equal(claims, 0);
});

test('a Resizer whose task queue cannot be used makes runWorker reject at startup before any claim', async () => {
  const cases: [
    Pick<ResizerOptions, 'locks'>,
    QueueTimingOptions | object,
    string,
  ][] = [
    [{}, {}, 'RESIZE_LOCKS_REQUIRED'],
    [
      { locks: memoryLocks() },
      { leaseMs: 0 },
      'RESIZE_CONFIG_QUEUE_LEASE_INVALID',
    ],
  ];
  for (const [locks, timing, code] of cases) {
    resetResizerForTests();
    const tasks = new MemoryTaskQueue({ timing: timing as never });
    let claims = 0;
    tasks.claim = async () => {
      claims += 1;
      return null;
    };
    new Resizer({
      config: makeImageConfig({ formats: ['webp'] }),
      logger: silent,
      storage: {
        download: async () => png,
        upload: async () => ({ key: 'k' }),
        publicUrl: () => '',
      },
      media: fakeMedia(),
      ...locks,
      tasks,
    });
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 5000);
    try {
      await assert.rejects(
        () => runWorker({ signal: stop.signal, logger: silent }),
        (err: unknown) => (err as { code?: string }).code === code,
      );
    } finally {
      clearTimeout(timer);
    }
    assert.equal(claims, 0, code);
  }
});

describe('dead-letter cooldown', () => {
  /**
   * Locks that expire, on a clock the test moves forward: `clock.ms` is added to real time. Owners
   * are checked like a real store: an expired lock is taken over by any owner, and `release` or
   * `extend` by another owner returns false and keeps the lock.
   */
  function expiringLocks(clock: { ms: number }) {
    const held = new Map<string, { owner: string; expiresAt: number }>();
    const calls: string[] = [];
    const locks: LockStore & { calls: string[] } = {
      calls,
      acquire: async (key, owner, ttlMs) => {
        calls.push(`acquire ${key} ${ttlMs}`);
        const now = Date.now() + clock.ms;
        if ((held.get(key)?.expiresAt ?? 0) > now) {
          return false;
        }
        held.set(key, { owner, expiresAt: now + ttlMs });
        return true;
      },
      extend: async (key, owner, ttlMs) => {
        const now = Date.now() + clock.ms;
        const lock = held.get(key);
        if (!lock || lock.owner !== owner || lock.expiresAt <= now) {
          return false;
        }
        lock.expiresAt = now + ttlMs;
        return true;
      },
      release: async (key, owner) => {
        calls.push(`release ${key}`);
        if (held.get(key)?.owner !== owner) {
          return false;
        }
        held.delete(key);
        return true;
      },
    };
    return locks;
  }

  const size: SizeInput = { width: 10, height: 10 };

  // A Resizer whose sources are all over limits.sourcePixels, so every task is dead-lettered on
  // its first delivery. Dispatch locks last 1 s, the cooldown 10 s.
  function setup(locks: LockStore, timing: Partial<QueueTimingOptions> = {}) {
    const tasks = new MemoryTaskQueue({
      timing: {
        idlePollMs: 5,
        lockTtlMs: { dispatch: 1000, worker: 1000, failed: 10_000 },
        ...timing,
      },
    });
    const docs = new Map<string, MediaLike>();
    // The Resizer's own errors (its Processor logs the cooldown's lock calls).
    const resizerErrors: unknown[][] = [];
    const resizer = new Resizer({
      config: makeImageConfig({
        formats: ['webp'],
        limits: { sourcePixels: 100 },
      }),
      logger: {
        info() {},
        warn() {},
        error: (...args: unknown[]) => {
          resizerErrors.push(args);
        },
      },
      storage: {
        download: async () => png,
        upload: async () => ({ key: 'k' }),
        publicUrl: () => '',
      },
      media: fakeMedia({ load: async (id) => docs.get(id) ?? null }),
      locks,
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
      resizerErrors,
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
      t.resizerErrors.some((args) => /cooldown/.test(String(args[0]))),
      "the failed cooldown is logged by the Resizer's logger",
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
    locks.release = async (key, owner) => {
      await gate;
      released = true;
      return release(key, owner);
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
      t.errors.some((args) =>
        /Resizer 'ghost' is not served by this worker/.test(String(args[0])),
      ),
    );
  });

  test('a Resizer constructed after the worker started is not served: its task fails with RESIZE_NO_RESIZER and its observers never fire', async () => {
    const t = setup(expiringLocks({ ms: 0 }));
    const working = t.work(); // runWorker has taken its list of Resizers
    // The worker routes tasks and events only among the Resizers it started with.
    let loads = 0;
    const late = queuedResizer('late', t.tasks, async () => {
      loads += 1;
      return fakeMedia();
    });
    const observed: string[] = [];
    late.hook('afterTaskComplete', () => {
      observed.push('completed');
    });
    late.hook('onTaskFailed', () => {
      observed.push('failed');
    });
    late.hook('onTaskDeadLettered', () => {
      observed.push('dead');
    });
    const { taskId } = await t.tasks.add(taskOf('late'));
    const [row] = t.tasks.rows;
    const until = Date.now() + 5000;
    try {
      // Claimed once, then failed (back to 'pending') or completed.
      while (row.attempts === 0 || row.status === 'processing') {
        assert.ok(Date.now() < until, 'the task was never settled');
        await new Promise((r) => setTimeout(r, 5));
      }
    } catch (err) {
      // A failed wait still stops the worker, so the test file can exit; the assertion is the error.
      t.stop.abort();
      await working.catch(() => {});
      throw err;
    }
    t.stop.abort();
    await working;
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    assert.match(
      row.error ?? '',
      /Resizer 'late' is not served by this worker/,
    );
    assert.deepEqual(observed, []);
    assert.equal(loads, 0, 'the worker never readied it');
    assert.ok(
      t.errors.some((args) =>
        String(args[0]).includes(
          `failed for task ${taskId} dropped — Resizer 'late' is not served by this worker`,
        ),
      ),
    );
  });
});
