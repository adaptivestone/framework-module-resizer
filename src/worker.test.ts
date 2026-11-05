// The worker's task handler (processTask) inside the worker loop: a media error thrown while
// reading the source reaches the retry policy unwrapped, so an unusable source is dead-lettered
// on its first delivery instead of being downloaded and decoded again on every retry. After a
// dead-letter the gate of its media, pipeline and queue is held for the cooldown, so reads stop
// queueing the same failing work. runWorker serves only the Resizers it starts with, claims only their tasks
// on a task queue that filters claims, and runs each task with its own Resizer's coordination.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { ImageEngine } from './contracts/engine.ts';
import type { LockStore } from './contracts/locks.ts';
import type { ResizeStorage } from './contracts/storage.ts';
import type {
  ClaimedTask,
  LeasedTask,
  TaskEvent,
  TaskQueue,
} from './contracts/taskQueue.ts';
import { SharpEngine } from './engines/sharp.ts';
import {
  ResizeError,
  ResizeGenerateError,
  ResizeMediaError,
  ResizeSecurityError,
  ResizeSetupError,
  ResizeStorageError,
} from './errors.ts';
import { causeText } from './helpers/log.ts';
import { gateKey } from './lockKeys.ts';
import { NoopMetrics } from './metrics.ts';
import {
  Resizer,
  type ResizerOptions,
  resetResizerForTests,
} from './resizer.ts';
import { markUnavailable, RoutingTaskQueue } from './routing.ts';
import { consume } from './testHelpers/consume.ts';
import {
  clockLocks,
  fakeMedia,
  MemoryTaskQueue,
  memoryLocks,
  PlainTaskQueue,
  ReleasingTaskQueue,
  recordingMetrics,
} from './testHelpers/fakes.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import { workUntil } from './testHelpers/work.ts';
import type {
  CoordinationOptions,
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
  });
  const events: { event: TaskEvent; task: LeasedTask; error?: unknown }[] = [];
  const stop = new AbortController();
  const timeout = setTimeout(() => stop.abort(), 5000);
  await consume(tasks, {
    queue: 'default',
    signal: stop.signal,
    handle: (task, opts) => processTask(task, opts),
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
  });
  const events: { event: TaskEvent; error?: unknown }[] = [];
  const stop = new AbortController();
  const timeout = setTimeout(() => stop.abort(), 5000);
  try {
    await consume(tasks, {
      queue: 'default',
      signal: stop.signal,
      handle: (task, opts) => processTask(task, opts),
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
      handle: (task, opts) => processTask(task, opts),
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

test('a variant error with retryable: false fails only its variant, and a task with nothing else missing is dead-lettered at once', async () => {
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
  });
  const events = await firstEvent(tasks);
  assert.deepEqual(
    events.map((e) => e.event),
    ['deadLettered'],
  );
  assert.ok(events[0].error instanceof ResizeGenerateError);
  assert.equal(events[0].error.code, 'RESIZE_WORKER_INCOMPLETE');
  assert.equal(events[0].error.retryable, false);
  assert.equal(tasks.rows[0].status, 'dead');
  assert.equal(tasks.rows[0].attempts, 1);
  // The other variant is stored.
  assert.deepEqual(
    (stored.get('m1') ?? []).map((preview) => preview.sizeKey),
    ['10x10'],
  );
});

test('one variant failing with false and one with true stays retried', async () => {
  const tasks = new MemoryTaskQueue({
    timing: { idlePollMs: 5, retryBackoffMs: { base: 60_000, max: 60_000 } },
  });
  const media: MediaLike = {
    id: 'm1',
    original: { storageRef: { key: 'o' } },
    previews: [],
  };
  new Resizer({
    config: makeImageConfig({ formats: ['webp'] }),
    logger: silent,
    storage: {
      download: async () => png,
      upload: async () => ({ key: 'k' }),
      publicUrl: () => '',
    },
    media: fakeMedia({ load: async () => media }),
    locks: memoryLocks(),
    tasks,
    pipelines: {
      default: {
        variantSteps: [
          async (_img, { variant }) => {
            if (variant.sizeKey === '20x20') {
              throw new ResizeMediaError(
                'resize: this variant cannot be made',
                { code: 'TEST_VARIANT_REFUSED', retryable: false },
              );
            }
            throw new Error('a passing failure');
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
});

// A Resizer named `name` on `tasks`. Its default media store has no docs, so each of its tasks is a
// no-op complete. `over` replaces any other option (e.g. `locks: undefined` for none).
function queuedResizer(
  name: string,
  tasks: ResizerOptions['tasks'],
  media: ResizerOptions['media'] = fakeMedia(),
  over: Partial<ResizerOptions> = {},
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
    ...over,
  });
}

const taskOf = (resizer: string) => ({
  resizer,
  queue: 'default',
  mediaId: 'm1',
  pipeline: 'default',
  previews: [{ sizeKey: '10x10', format: 'webp' }],
});

// A second TaskQueue object over the same rows, as two MongoTaskQueue instances on one collection
// are: the startup check compares task queue objects, so it cannot see that they share tasks.
const sameRows = (tasks: ReleasingTaskQueue): TaskQueue => ({
  add: (task) => tasks.add(task),
  claim: (queue, leaseMs) => tasks.claim(queue, leaseMs),
  renew: (task, leaseMs) => tasks.renew(task, leaseMs),
  complete: (task) => tasks.complete(task),
  fail: (task, next, error) => tasks.fail(task, next, error),
  release: (task) => tasks.release(task),
  getTiming: (queue) => tasks.getTiming(queue),
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
  await tasks.add({ ...taskOf('b'), mediaId: 'b1' });
  await tasks.add({ ...taskOf('b'), mediaId: 'b2' });
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
  const tasks = new PlainTaskQueue({ timing: { idlePollMs: 5 } });
  const a = queuedResizer('a', tasks);
  // Not listed, on its own task queue: it does not share a's queue, so the worker may start.
  queuedResizer('c', new MemoryTaskQueue());
  // Two tasks of Resizer 'b', which only another process constructs. They are the older ones, so
  // they are claimed first.
  await tasks.add({ ...taskOf('b'), mediaId: 'b1' });
  await tasks.add({ ...taskOf('b'), mediaId: 'b2' });
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

test('task observers and their resize:<hook> events carry attempts', async () => {
  const tasks = new MemoryTaskQueue({
    timing: { idlePollMs: 5, retryBackoffMs: { base: 5, max: 5 } },
  });
  const emitted: { name: string; args: unknown[] }[] = [];
  let downloads = 0;
  const resizer = new Resizer({
    config: makeImageConfig({ formats: ['webp'] }),
    logger: silent,
    events: {
      emit: (name, ...args) => {
        emitted.push({ name, args });
      },
    },
    storage: {
      download: async () => {
        downloads += 1;
        if (downloads === 1) {
          throw new ResizeStorageError('resize: the bucket did not answer');
        }
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
  const failed: number[] = [];
  const completed: number[] = [];
  resizer.hook('onTaskFailed', (task) => {
    failed.push(task.attempts);
  });
  resizer.hook('afterTaskComplete', (task) => {
    completed.push(task.attempts);
  });
  await tasks.add({
    resizer: 'default',
    queue: 'default',
    mediaId: 'm1',
    pipeline: 'default',
    previews: [webp10],
  });
  await workUntil(
    { logger: silent, resizers: [resizer] },
    () => completed.length === 1,
  );
  assert.deepEqual(failed, [1]);
  assert.deepEqual(completed, [2]);
  const onFailed = emitted.find(({ name }) => name === 'resize:onTaskFailed');
  assert.ok(onFailed, 'the failure is mirrored on the event bus');
  assert.equal((onFailed.args[0] as LeasedTask).attempts, 1);
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

// On a task queue that does not filter claims (PlainTaskQueue, the SQS shape), the worker would
// claim the unlisted Resizers' tasks.
describe('a worker that serves only some of the Resizers on a task queue', () => {
  const unlisted = (err: unknown, names: RegExp) =>
    err instanceof ResizeSetupError &&
    err.code === 'RESIZE_QUEUE_SHARED_RESIZER_UNLISTED' &&
    /queue 'default'/.test(err.message) &&
    names.test(err.message);

  test('is refused at start, naming the queue and the unlisted Resizers, before any claim', async () => {
    const tasks = new PlainTaskQueue({ timing: { idlePollMs: 5 } });
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
    const tasks = new PlainTaskQueue();
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
    const tasks = new PlainTaskQueue();
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
    const tasks = new PlainTaskQueue();
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
    const tasks = new PlainTaskQueue();
    const a = queuedResizer('a', tasks);
    storageDown('own', async () => new PlainTaskQueue());
    storageDown('eager', undefined);
    await runWorker({
      signal: AbortSignal.abort(),
      logger: silent,
      resizers: [a],
    });
  });
});

test('on a task queue that filters claims, a worker starts beside unlisted Resizers and never claims their tasks', async () => {
  const tasks = new MemoryTaskQueue({ timing: { idlePollMs: 5 } });
  // Every task the worker claims, recorded: `pending` with no attempts would also describe a task
  // that was claimed and then given back, since a give-back does not count the delivery.
  const claimed: string[] = [];
  const claim = tasks.claim.bind(tasks);
  tasks.claim = async (queue, leaseMs, signal, opts) => {
    const task = await claim(queue, leaseMs, signal, opts);
    if (task) {
      claimed.push(task.taskId);
    }
    return task;
  };
  const a = queuedResizer('a', tasks);
  queuedResizer('b', tasks);
  // b's task is the older one, so a queue that ignored the filter would hand it out first.
  await tasks.add({ ...taskOf('b'), mediaId: 'b1' });
  await tasks.add(taskOf('a'));
  const [bRow, aRow] = tasks.rows;
  await workUntil(
    { logger: silent, resizers: [a] },
    () => aRow.status === 'completed',
  );
  assert.deepEqual(claimed, [aRow.id]);
  assert.equal(bRow.status, 'pending');
  assert.equal(bRow.attempts, 0);
  // Still first: a give-back would have moved it behind a's task.
  assert.equal(tasks.rows[0], bRow);
});

test('two Resizers on two names of one task queue: each lane is claimed by its own worker with its own lease', async () => {
  const tasks = new MemoryTaskQueue({
    queues: ['default', 'bulk'],
    queueTiming: { bulk: { leaseMs: 30_000 } },
  });
  const a = queuedResizer('a', tasks);
  const b = new Resizer({
    name: 'b',
    queueName: 'bulk',
    config: makeImageConfig({ formats: ['webp'] }),
    logger: silent,
    storage: {
      download: async () => png,
      upload: async () => ({ key: 'k' }),
      publicUrl: () => '',
    },
    // No docs, so b's task is a no-op complete.
    media: fakeMedia(),
    locks: memoryLocks(),
    tasks,
  });
  const cold = (id: string): MediaLike => ({
    id,
    original: { storageRef: { key: `o-${id}` }, contentType: 'image/png' },
    previews: [],
  });
  const sizes = [{ width: 10, height: 10 }];
  await a.resolve({ media: cold('m1'), sizes });
  await b.resolve({ media: cold('m2'), sizes });
  assert.deepEqual(
    tasks.rows.map((row) => ({
      queue: row.task.queue,
      resizer: row.task.resizer,
    })),
    [
      { queue: 'default', resizer: 'a' },
      { queue: 'bulk', resizer: 'b' },
    ],
  );
  const [aRow, bRow] = tasks.rows;
  await workUntil(
    { queue: 'bulk', logger: silent, resizers: [a, b] },
    () => bRow.status === 'completed',
  );
  assert.equal(aRow.status, 'pending');
  assert.equal(aRow.attempts, 0);
  assert.ok(tasks.claims.length > 0);
  for (const claim of tasks.claims) {
    assert.deepEqual(claim, { queue: 'bulk', leaseMs: 30_000 });
  }
});

test('a task queue that filters claims is not given accepts: a task of another Resizer it hands out anyway fails with RESIZE_NO_RESIZER', async () => {
  const tasks = new MemoryTaskQueue({ timing: { idlePollMs: 5 } });
  // A broken queue that ignores the filter.
  const claim = tasks.claim.bind(tasks);
  tasks.claim = (queue, leaseMs, signal) => claim(queue, leaseMs, signal);
  const a = queuedResizer('a', tasks);
  await tasks.add({ ...taskOf('b'), mediaId: 'b1' });
  await tasks.add(taskOf('a'));
  const [bRow, aRow] = tasks.rows;
  const errors: unknown[][] = [];
  await workUntil(
    {
      logger: { ...silent, error: (...args) => errors.push(args) },
      resizers: [a],
    },
    // Failed, not given back: a release would leave its attempts at 0.
    () =>
      aRow.status === 'completed' &&
      bRow.status === 'pending' &&
      bRow.attempts === 1,
  );
  assert.match(bRow.error ?? '', /Resizer 'b' is not served by this worker/);
  assert.ok(
    errors.some((args) =>
      /although it filters claims, so its tasks fail with RESIZE_NO_RESIZER/.test(
        String(args[0]),
      ),
    ),
  );
});

test('when every consumed task queue filters claims, an unserved Resizer whose task queue cannot be loaded does not stop the start', async () => {
  const tasks = new MemoryTaskQueue();
  const a = queuedResizer('a', tasks);
  queuedResizer('broken', async () => {
    throw new Error('queue not up');
  });
  await runWorker({
    signal: AbortSignal.abort(),
    logger: silent,
    resizers: [a],
  });
});

// A Resizer whose every source is over limits.sourcePixels, so each of its tasks is dead-lettered
// on its first delivery.
function tooLargeResizer(
  name: string,
  tasks: ResizerOptions['tasks'],
  over: Pick<ResizerOptions, 'coordination' | 'locks'>,
): Resizer {
  return new Resizer({
    name,
    config: makeImageConfig({
      formats: ['webp'],
      limits: { sourcePixels: 100 },
    }),
    coordination: over.coordination,
    logger: silent,
    storage: {
      download: async () => png,
      upload: async () => ({ key: 'k' }),
      publicUrl: () => '',
    },
    media: fakeMedia({
      load: async (id) => ({
        id,
        original: { storageRef: { key: `o-${id}` } },
        previews: [],
      }),
    }),
    locks: over.locks ?? memoryLocks(),
    tasks,
  });
}

test("each dead-letter gets the cooldown of the task's own Resizer", async () => {
  const tasks = new MemoryTaskQueue({
    now: () => 0,
    timing: { idlePollMs: 5 },
  });
  const a = tooLargeResizer('a', tasks, {
    coordination: { cooldownMs: 30_000 },
  });
  const b = tooLargeResizer('b', tasks, {
    coordination: { cooldownMs: 90_000 },
  });
  await tasks.add({ ...taskOf('a'), previews: [webp10] });
  await tasks.add({ ...taskOf('b'), previews: [webp10] });
  const [aRow, bRow] = tasks.rows;
  await workUntil(
    { logger: silent, resizers: [a, b] },
    () => aRow.status === 'dead' && bRow.status === 'dead',
  );
  assert.equal(aRow.cooldownUntil, 30_000);
  assert.equal(bRow.cooldownUntil, 90_000);
});

test("on a queue without gatesByTask, the gate lock lives in the task's Resizer's lock store", async () => {
  const tasks = new PlainTaskQueue({ timing: { idlePollMs: 5 } });
  const locks = clockLocks();
  const resizer = tooLargeResizer('default', tasks, {
    coordination: { cooldownMs: 30_000 },
    locks,
  });
  const deadLettered: LeasedTask[] = [];
  resizer.hook('onTaskDeadLettered', (task) => {
    deadLettered.push(task);
  });
  // The lock the Dispatcher takes when it queues the task, under the owner the task carries.
  const key = gateKey('default', 'default', 'm1', 'default');
  assert.equal(await locks.acquire(key, 'g1', 60_000), true);
  await tasks.add({
    ...taskOf('default'),
    previews: [webp10],
    gateOwner: 'g1',
  });
  await workUntil(
    { logger: silent, resizers: [resizer] },
    () => deadLettered.length === 1,
  );
  const held = locks.entry(key);
  assert.equal(held?.owner, 'g1');
  const left = (held?.expiresAt ?? 0) - Date.now();
  assert.ok(left > 29_000 && left <= 30_000, `held for ${left} ms`);
});

test('on a queue without gatesByTask, the task of a Resizer the worker does not serve touches no lock, even with a gateOwner', async () => {
  const tasks = new PlainTaskQueue({ timing: { idlePollMs: 5 } });
  // One lock store for both Resizers, recording every call the worker makes.
  const store = clockLocks();
  const calls: string[] = [];
  const locks: LockStore = {
    acquire: (key, owner, ttlMs) => {
      calls.push(`acquire ${key}`);
      return store.acquire(key, owner, ttlMs);
    },
    extend: (key, owner, ttlMs) => {
      calls.push(`extend ${key}`);
      return store.extend(key, owner, ttlMs);
    },
    release: (key, owner) => {
      calls.push(`release ${key}`);
      return store.release(key, owner);
    },
  };
  const withLocks = (name: string) =>
    new Resizer({
      name,
      config: makeImageConfig({ formats: ['webp'] }),
      logger: silent,
      storage: {
        download: async () => png,
        upload: async () => ({ key: 'k' }),
        publicUrl: () => '',
      },
      media: fakeMedia({
        load: async (id) => ({
          id,
          original: { storageRef: { key: 'o' } },
          previews: [],
        }),
      }),
      locks,
      tasks,
    });
  const a = withLocks('a');
  const aKey = gateKey('a', 'default', 'm1', 'default');
  const ghostKey = gateKey('ghost', 'default', 'm1', 'default');
  // The gate locks their Dispatchers took, set in the store directly: `calls` lists the worker's.
  assert.equal(await store.acquire(ghostKey, 'g-ghost', 60_000), true);
  assert.equal(await store.acquire(aKey, 'g-a', 60_000), true);
  const ghostLock = store.entry(ghostKey);
  // The ghost's task is the older one, so it is claimed first.
  await tasks.add({ ...taskOf('ghost'), gateOwner: 'g-ghost' });
  await tasks.add({ ...taskOf('a'), gateOwner: 'g-a' });
  const [ghostRow, aRow] = tasks.rows;
  const stop = new AbortController();
  const working = runWorker({
    signal: stop.signal,
    logger: silent,
    resizers: [a],
  });
  // Constructed after the worker took its list, on the same lock store: it is not served.
  withLocks('ghost');
  const until = Date.now() + 5000;
  try {
    // a's task completed; the ghost's was claimed once and failed (PlainTaskQueue has no release).
    while (
      aRow.status !== 'completed' ||
      ghostRow.attempts === 0 ||
      ghostRow.status === 'processing'
    ) {
      assert.ok(Date.now() < until, 'the tasks were never settled');
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
  assert.equal(ghostRow.status, 'pending');
  assert.equal(ghostRow.attempts, 1);
  assert.match(
    ghostRow.error ?? '',
    /Resizer 'ghost' is not served by this worker/,
  );
  assert.deepEqual(
    calls.filter((call) => call.endsWith(ghostKey)),
    [],
    "the ghost's gate lock was never extended or released",
  );
  assert.deepEqual(store.entry(ghostKey), ghostLock);
  // The same store holds the gate lock of a's task: extended while it ran, then released.
  const aCalls = calls.filter((call) => call.endsWith(aKey));
  assert.ok(aCalls.includes(`extend ${aKey}`), aCalls.join(', '));
  assert.equal(aCalls.at(-1), `release ${aKey}`);
  assert.equal(store.entry(aKey), undefined);
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
    typeof MemoryTaskQueue | typeof PlainTaskQueue,
  ][] = [
    // A task queue without gatesByTask needs a lock store for its gate locks.
    [{}, {}, 'RESIZE_LOCKS_REQUIRED', PlainTaskQueue],
    [
      { locks: memoryLocks() },
      { leaseMs: 0 },
      'RESIZE_CONFIG_QUEUE_LEASE_INVALID',
      MemoryTaskQueue,
    ],
  ];
  for (const [locks, timing, code, Queue] of cases) {
    resetResizerForTests();
    const tasks = new Queue({ timing: timing as never });
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
  const size: SizeInput = { width: 10, height: 10 };

  // A Resizer whose sources are all over limits.sourcePixels, so every task is dead-lettered on
  // its first delivery. A test whose unserved task must fail, not be given back, passes
  // PlainTaskQueue (a queue without release). `extra` sets MemoryTaskQueue's cooldown clock and
  // the Resizer's coordination.
  function setup(
    locks: LockStore | undefined,
    Queue: typeof MemoryTaskQueue | typeof PlainTaskQueue = MemoryTaskQueue,
    extra: { now?: () => number; coordination?: CoordinationOptions } = {},
  ) {
    const tasks = new Queue({
      timing: { idlePollMs: 5 },
      ...(extra.now ? { now: extra.now } : {}),
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
      media: fakeMedia({ load: async (id) => docs.get(id) ?? null }),
      locks,
      tasks,
      coordination: extra.coordination,
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

  test('after a dead-letter on a queue that gates by task, reads queue nothing for that media, pipeline and queue until cooldownMs ends', async () => {
    let now = 0;
    const t = setup(undefined, MemoryTaskQueue, {
      now: () => now,
      coordination: { cooldownMs: 10_000 },
    });
    const m1 = t.media('m1');
    await t.read(m1);
    assert.equal(t.tasks.rows.length, 1);
    await t.work();
    assert.equal(t.deadLettered.length, 1);
    assert.equal(t.tasks.rows[0].status, 'dead');
    // Inside the 10 s cooldown the dead task holds the gate of m1 and its pipeline, for every
    // variant.
    now = 5000;
    await t.read(m1);
    await t.read(m1, [{ width: 20, height: 20 }]);
    assert.equal(t.tasks.rows.length, 1, 'nothing is queued for m1');
    // Another media is not held.
    await t.read(t.media('m2'));
    assert.equal(t.tasks.rows.length, 2);
    now = 10_000;
    await t.read(m1);
    assert.equal(t.tasks.rows.length, 3, 'queued again once the cooldown ends');
  });

  test('after a dead-letter on a queue without gatesByTask, reads queue nothing for that media, pipeline and queue until cooldownMs ends', async () => {
    let now = 0;
    const t = setup(
      clockLocks(() => now),
      PlainTaskQueue,
      { coordination: { cooldownMs: 10_000 } },
    );
    const m1 = t.media('m1');
    await t.read(m1);
    assert.equal(t.tasks.rows.length, 1);
    await t.work();
    assert.equal(t.deadLettered.length, 1);
    assert.equal(t.tasks.rows[0].status, 'dead');
    // Inside the 10 s cooldown the gate lock of m1 and its pipeline is held, for every variant.
    now = 5000;
    await t.read(m1);
    await t.read(m1, [{ width: 20, height: 20 }]);
    assert.equal(t.tasks.rows.length, 1, 'nothing is queued for m1');
    now = 10_001;
    await t.read(m1);
    assert.equal(t.tasks.rows.length, 2, 'queued again once the cooldown ends');
  });

  test('a Resizer constructed after the worker started is not served: its task fails with RESIZE_NO_RESIZER and its observers never fire', async () => {
    const t = setup(clockLocks(), PlainTaskQueue);
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
    const added = await t.tasks.add(taskOf('late'));
    assert.equal(added.status, 'added');
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
          `failed for task ${added.taskId} dropped — Resizer 'late' is not served by this worker`,
        ),
      ),
    );
  });
});

// One Resizer, queues on two backends through one router: 'default' on a queue that gates by task
// (the database shape), 'bulk' on one that does not (the SQS shape), or the other way round. Each
// worker consumes the backend that carries its queue, with that backend's gate.
describe('a worker on a router', () => {
  const fast = { idlePollMs: 5 };
  const onBulk = (resizer = 'default') => ({
    ...taskOf(resizer),
    queue: 'bulk',
  });
  const unlisted = (err: unknown) =>
    err instanceof ResizeSetupError &&
    err.code === 'RESIZE_QUEUE_SHARED_RESIZER_UNLISTED';
  const sourceMedia = (id: string): MediaLike => ({
    id,
    original: { storageRef: { key: `o-${id}` } },
    previews: [],
  });

  test("a worker for bulk consumes the plain route of a Resizer's router", async () => {
    const memory = new MemoryTaskQueue({ timing: fast });
    const plain = new PlainTaskQueue({ timing: fast });
    const resizer = queuedResizer(
      'default',
      new RoutingTaskQueue({ default: memory, bulk: plain }),
    );
    await plain.add(onBulk());
    const [row] = plain.rows;
    await workUntil(
      { queue: 'bulk', logger: silent, resizers: [resizer] },
      () => row.status === 'completed',
    );
    assert.deepEqual(memory.claims, []);
  });

  test('the startup check compares routes: an unserved Resizer routing bulk to the consumed plain queue is RESIZE_QUEUE_SHARED_RESIZER_UNLISTED', async () => {
    const plain = new PlainTaskQueue({ timing: fast });
    const a = queuedResizer(
      'a',
      new RoutingTaskQueue({ default: new MemoryTaskQueue(), bulk: plain }),
    );
    queuedResizer('b', new RoutingTaskQueue({ bulk: plain }));
    await assert.rejects(
      () =>
        runWorker({
          queue: 'bulk',
          signal: AbortSignal.abort(),
          logger: silent,
          resizers: [a],
        }),
      (err: unknown) =>
        unlisted(err) &&
        /'b'/.test((err as Error).message) &&
        /queue 'bulk'/.test((err as Error).message),
    );
    assert.deepEqual(plain.claims, []);
  });

  // A Resizer whose downloads fail (retried) or whose sources are over the limit (dead-lettered at
  // once), on `default` (gates by task) and `bulk` (gate locks in `locks`) of one router.
  function twoBackends(fails: 'retry' | 'dead') {
    const timing = {
      idlePollMs: 5,
      retryBackoffMs: { base: 60_000, max: 60_000 },
    };
    const memory = new MemoryTaskQueue({ timing });
    const plain = new PlainTaskQueue({ timing });
    const locks = clockLocks();
    const resizer = queuedResizer(
      'default',
      new RoutingTaskQueue({ default: memory, bulk: plain }),
      fakeMedia({ load: async (id) => sourceMedia(id) }),
      {
        locks,
        coordination: { cooldownMs: 30_000 },
        ...(fails === 'dead'
          ? {
              config: makeImageConfig({
                formats: ['webp'],
                limits: { sourcePixels: 100 },
              }),
            }
          : {
              storage: {
                download: async () => {
                  throw new Error('storage down');
                },
                upload: async () => ({ key: 'k' }),
                publicUrl: () => '',
              },
            }),
      },
    );
    const prewarm = (queue: string) =>
      resizer.prewarm({
        media: sourceMedia('m1'),
        sizes: [{ width: 10, height: 10 }],
        queue,
      });
    return { memory, plain, locks, resizer, prewarm };
  }

  test('on a router, a failed task retries on its own backend: the plain route keeps the gate lock until the retry, the gating route keeps its row active', async () => {
    const { memory, plain, locks, resizer, prewarm } = twoBackends('retry');
    assert.equal((await prewarm('bulk')).status, 'accepted');
    assert.equal((await prewarm('default')).status, 'accepted');
    const [bulkRow] = plain.rows;
    const [defaultRow] = memory.rows;
    const key = gateKey('default', 'bulk', 'm1', 'default');
    await workUntil(
      { queue: 'bulk', logger: silent, resizers: [resizer] },
      () => bulkRow.attempts === 1 && bulkRow.status === 'pending',
    );
    const held = locks.entry(key);
    assert.equal(held?.owner, bulkRow.task.gateOwner);
    assert.ok(
      (held?.expiresAt ?? 0) - Date.now() > 50_000,
      'held until the retry',
    );
    await workUntil(
      { queue: 'default', logger: silent, resizers: [resizer] },
      () => defaultRow.attempts === 1 && defaultRow.status === 'pending',
    );
    assert.equal(defaultRow.active, true);
    assert.equal(defaultRow.task.gateOwner, undefined);
    assert.equal(
      locks.entry(gateKey('default', 'default', 'm1', 'default')),
      undefined,
    );
  });

  test('on a router, a dead-letter cools down on its own backend: a gate lock for the plain route, the row for the gating route', async () => {
    const { memory, plain, locks, resizer, prewarm } = twoBackends('dead');
    await prewarm('bulk');
    await prewarm('default');
    const [bulkRow] = plain.rows;
    const [defaultRow] = memory.rows;
    await workUntil(
      { queue: 'bulk', logger: silent, resizers: [resizer] },
      () => bulkRow.status === 'dead',
    );
    const held = locks.entry(gateKey('default', 'bulk', 'm1', 'default'));
    assert.equal(held?.owner, bulkRow.task.gateOwner);
    const left = (held?.expiresAt ?? 0) - Date.now();
    assert.ok(left > 29_000 && left <= 30_000, `held for ${left} ms`);
    await workUntil(
      { queue: 'default', logger: silent, resizers: [resizer] },
      () => defaultRow.status === 'dead',
    );
    const cooling = (defaultRow.cooldownUntil ?? 0) - Date.now();
    assert.ok(cooling > 29_000 && cooling <= 30_000, `cools for ${cooling} ms`);
    assert.equal(
      locks.entry(gateKey('default', 'default', 'm1', 'default')),
      undefined,
    );
  });

  test('on a router, a stopped worker gives a plain task back with release and keeps its gate lock', async () => {
    const releasing = new ReleasingTaskQueue({ timing: fast });
    const locks = clockLocks();
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let stopTask: (err: Error) => void = () => {};
    const resizer = queuedResizer(
      'default',
      new RoutingTaskQueue({ default: new MemoryTaskQueue(), bulk: releasing }),
      fakeMedia({
        load: () => {
          started();
          return new Promise((_resolve, reject) => {
            stopTask = reject;
          });
        },
      }),
      { locks },
    );
    await resizer.prewarm({
      media: sourceMedia('m1'),
      sizes: [{ width: 10, height: 10 }],
      queue: 'bulk',
    });
    const [row] = releasing.rows;
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 5000);
    try {
      const working = runWorker({
        queue: 'bulk',
        signal: stop.signal,
        logger: silent,
        resizers: [resizer],
      });
      await running;
      stop.abort();
      stopTask(new Error('stopped'));
      await working;
    } finally {
      clearTimeout(timer);
    }
    assert.deepEqual(releasing.releaseCalls, [row.id]);
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 0);
    const held = locks.entry(gateKey('default', 'bulk', 'm1', 'default'));
    assert.equal(held?.owner, row.task.gateOwner);
    assert.ok((held?.expiresAt ?? 0) > Date.now(), 'the gate lock is kept');
  });

  test('worker start needs a lock store for a consumed route without gatesByTask', async () => {
    const plain = new PlainTaskQueue({ timing: fast });
    const resizer = queuedResizer(
      'default',
      new RoutingTaskQueue({ default: new MemoryTaskQueue(), bulk: plain }),
      fakeMedia(),
      { locks: undefined },
    );
    await assert.rejects(
      () =>
        runWorker({
          queue: 'bulk',
          signal: AbortSignal.abort(),
          logger: silent,
          resizers: [resizer],
        }),
      (err: unknown) =>
        err instanceof ResizeSetupError && err.code === 'RESIZE_LOCKS_REQUIRED',
    );
    assert.deepEqual(plain.claims, []);
    // The gating route needs none.
    await runWorker({
      queue: 'default',
      signal: AbortSignal.abort(),
      logger: silent,
      resizers: [resizer],
    });
  });

  test("a worker for bulk starts although the served Resizer's own queue default cannot be used", async () => {
    const down = new ResizeSetupError('install @aws-sdk/client-sqs', {
      code: 'RESIZE_PEER_MISSING',
    });
    let builds = 0;
    const bulk = new MemoryTaskQueue({ timing: fast });
    const resizer = queuedResizer(
      'default',
      new RoutingTaskQueue({
        default: async () => {
          builds += 1;
          throw down;
        },
        bulk,
      }),
      fakeMedia(),
      { locks: undefined },
    );
    await bulk.add(onBulk());
    const [row] = bulk.rows;
    await workUntil(
      { queue: 'bulk', logger: silent, resizers: [resizer] },
      () => row.status === 'completed',
    );
    assert.equal(builds, 0);
    await assert.rejects(
      () => resizer.verify(),
      (err: unknown) => err === down,
    );
  });

  test('a worker for a healthy bulk starts while default has invalid timing', async () => {
    const broken = new MemoryTaskQueue({ timing: { leaseMs: 0 } });
    const bulk = new MemoryTaskQueue({ timing: fast });
    const resizer = queuedResizer(
      'default',
      new RoutingTaskQueue({ default: broken, bulk }),
    );
    await bulk.add(onBulk());
    const [row] = bulk.rows;
    await workUntil(
      { queue: 'bulk', logger: silent, resizers: [resizer] },
      () => row.status === 'completed',
    );
    await assert.rejects(
      () =>
        runWorker({
          signal: AbortSignal.abort(),
          logger: silent,
          resizers: [resizer],
        }),
      (err: unknown) =>
        (err as { code?: string }).code === 'RESIZE_CONFIG_QUEUE_LEASE_INVALID',
    );
    assert.deepEqual(broken.claims, []);
  });

  test('a worker whose consumed backend fails to build rejects with that very error, logged once naming the queue, and claims nothing', async () => {
    const downs = [
      new Error('sdk not up'),
      new ResizeError('no bucket', {
        code: 'GCS_BUCKET_MISSING',
        retryable: false,
      }),
    ];
    for (const down of downs) {
      resetResizerForTests();
      const memory = new MemoryTaskQueue({ timing: fast });
      const resizer = queuedResizer(
        'default',
        new RoutingTaskQueue({
          default: memory,
          bulk: async () => {
            throw down;
          },
        }),
      );
      const errors: unknown[][] = [];
      await assert.rejects(
        () =>
          runWorker({
            queue: 'bulk',
            signal: AbortSignal.abort(),
            logger: { ...silent, error: (...args) => errors.push(args) },
            resizers: [resizer],
          }),
        (err: unknown) => err === down,
      );
      assert.equal(errors.length, 1);
      assert.match(
        String(errors[0][0]),
        /queue 'bulk' of Resizer 'default': its backend could not be built/,
      );
      assert.equal(errors[0][1], down);
      assert.deepEqual(memory.claims, []);
    }
    // The branded error keeps its own code and retryable.
    assert.equal((downs[1] as ResizeError).code, 'GCS_BUCKET_MISSING');
    assert.equal((downs[1] as ResizeError).retryable, false);
  });

  test('a worker given a name marked unavailable fails with RESIZE_QUEUE_NOT_SERVED naming the queue and the package', async () => {
    const tasks = new MemoryTaskQueue({ queues: ['default'] });
    markUnavailable(tasks, ['bulk'], {
      driver: 'sqs',
      packages: ['@aws-sdk/client-sqs'],
      error: new ResizeSetupError('peer missing', {
        code: 'RESIZE_PEER_MISSING',
      }),
    });
    const resizer = queuedResizer('default', tasks);
    await assert.rejects(
      () =>
        runWorker({
          queue: 'bulk',
          signal: AbortSignal.abort(),
          logger: silent,
          resizers: [resizer],
        }),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_QUEUE_NOT_SERVED' &&
        /'bulk'/.test(err.message) &&
        /driver 'sqs' needs @aws-sdk\/client-sqs/.test(err.message),
    );
  });

  test('two routers whose cold builders return one shared plain queue: a worker serving only the first refuses to start', async () => {
    const start = (a: Resizer) =>
      runWorker({
        queue: 'bulk',
        signal: AbortSignal.abort(),
        logger: silent,
        resizers: [a],
      });
    // b's route was never built, yet it is the same queue object.
    const shared = new PlainTaskQueue({ queues: ['bulk'] });
    const a = queuedResizer(
      'a',
      new RoutingTaskQueue({ bulk: async () => shared }),
    );
    queuedResizer('b', new RoutingTaskQueue({ bulk: async () => shared }));
    await assert.rejects(
      () => start(a),
      (err: unknown) => unlisted(err) && /'b'/.test((err as Error).message),
    );
    assert.deepEqual(shared.claims, []);

    // b's route cannot be built: it may be the shared queue.
    resetResizerForTests();
    const notUp = new Error('queue not up');
    const a2 = queuedResizer(
      'a',
      new RoutingTaskQueue({ bulk: async () => shared }),
    );
    queuedResizer(
      'b',
      new RoutingTaskQueue({
        bulk: async () => {
          throw notUp;
        },
      }),
    );
    await assert.rejects(
      () => start(a2),
      (err: unknown) =>
        unlisted(err) &&
        /'b' failed to load/.test((err as Error).message) &&
        /could not be determined/.test((err as Error).message) &&
        (err as Error).cause === notUp,
    );

    // A shared queue that filters claims may be shared: b's route is never built.
    resetResizerForTests();
    const filtering = new MemoryTaskQueue({ queues: ['bulk'] });
    let builds = 0;
    const a3 = queuedResizer(
      'a',
      new RoutingTaskQueue({ bulk: async () => filtering }),
    );
    queuedResizer(
      'b',
      new RoutingTaskQueue({
        bulk: async () => {
          builds += 1;
          return filtering;
        },
      }),
    );
    await start(a3);
    assert.equal(builds, 0);
  });
});

describe('a worker for several queues', () => {
  const fast = { idlePollMs: 5 };
  const sizes = [{ width: 10, height: 10 }];
  const sourceOf = (id: string): MediaLike => ({
    id,
    original: { storageRef: { key: `o-${id}` }, contentType: 'image/png' },
    previews: [],
  });
  // A storage that records the keys of the files it receives.
  const recordingStorage = () => {
    const keys: string[] = [];
    return {
      keys,
      storage: {
        download: async () => png,
        upload: async (opts: { key: string }) => {
          keys.push(opts.key);
          return { key: opts.key };
        },
        publicUrl: () => '',
      },
    };
  };

  test('one worker runs two Resizers on two queues of two backends', async () => {
    const memory = new MemoryTaskQueue({ timing: fast, queues: ['default'] });
    const plain = new PlainTaskQueue({ timing: fast, queues: ['bulk'] });
    const aStorage = recordingStorage();
    const listingsStorage = recordingStorage();
    const aPreviews = new Map<string, Preview[]>();
    const listingsPreviews = new Map<string, Preview[]>();
    const a = queuedResizer(
      'a',
      memory,
      fakeMedia({ load: async () => sourceOf('m1'), previews: aPreviews }),
      { storage: aStorage.storage },
    );
    const listings = queuedResizer(
      'listings',
      plain,
      fakeMedia({
        load: async () => sourceOf('m2'),
        previews: listingsPreviews,
      }),
      { storage: listingsStorage.storage, queueName: 'bulk' },
    );
    assert.equal(
      (await a.prewarm({ media: sourceOf('m1'), sizes })).status,
      'accepted',
    );
    assert.equal(
      (await listings.prewarm({ media: sourceOf('m2'), sizes })).status,
      'accepted',
    );
    await workUntil(
      { queue: ['default', 'bulk'], logger: silent, resizers: [a, listings] },
      () =>
        (aPreviews.get('m1')?.length ?? 0) > 0 &&
        (listingsPreviews.get('m2')?.length ?? 0) > 0,
    );
    assert.equal(aStorage.keys.length, 1);
    assert.equal(listingsStorage.keys.length, 1);
    assert.deepEqual(
      memory.leases.map((t) => [t.queue, t.resizer]),
      [['default', 'a']],
    );
    assert.deepEqual(
      plain.leases.map((t) => [t.queue, t.resizer]),
      [['bulk', 'listings']],
    );
  });

  test('a listed queue that no task queue serves is RESIZE_QUEUE_NOT_SERVED naming it, before any claim', async () => {
    const memory = new MemoryTaskQueue({ timing: fast, queues: ['default'] });
    const resizer = queuedResizer('default', memory);
    await assert.rejects(
      () =>
        runWorker({
          queue: ['default', 'typo'],
          signal: AbortSignal.timeout(2000), // only stops a worker that wrongly started
          logger: silent,
          resizers: [resizer],
        }),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_QUEUE_NOT_SERVED' &&
        /'typo'/.test(err.message),
    );
    assert.deepEqual(memory.claims, []);
  });

  test('a listed queue whose route fails to build rejects start naming it; a worker for the other queue never builds it', async () => {
    const down = new ResizeSetupError('install @aws-sdk/client-sqs', {
      code: 'RESIZE_PEER_MISSING',
    });
    let builds = 0;
    const memory = new MemoryTaskQueue({ timing: fast });
    const resizer = queuedResizer(
      'default',
      new RoutingTaskQueue({
        default: memory,
        bulk: async () => {
          builds += 1;
          throw down;
        },
      }),
    );
    const errors: unknown[][] = [];
    await assert.rejects(
      () =>
        runWorker({
          queue: ['default', 'bulk'],
          signal: AbortSignal.timeout(2000), // only stops a worker that wrongly started
          logger: { ...silent, error: (...args) => errors.push(args) },
          resizers: [resizer],
        }),
      (err: unknown) => err === down,
    );
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /queue 'bulk'/);
    assert.deepEqual(memory.claims, []);
    assert.equal(builds, 1);
    await memory.add(taskOf('default'));
    const [row] = memory.rows;
    await workUntil(
      { queue: ['default'], logger: silent, resizers: [resizer] },
      () => row.status === 'completed',
    );
    assert.equal(builds, 1);
  });

  test('an empty queue list, or a blank name in it, is RESIZE_QUEUE_INVALID', async () => {
    const memory = new MemoryTaskQueue({ timing: fast });
    const resizer = queuedResizer('default', memory);
    const fail = () => {
      throw new Error('not formattable');
    };
    const cases = [
      [],
      ['default', ''],
      ['  '],
      '',
      ['default', 42],
      [1n],
      [Object.create(null)],
      // A host value whose own inspector throws: it is never called.
      [{ [Symbol.for('nodejs.util.inspect.custom')]: fail }],
      // A value that even inspect() cannot read (a prototype whose every trap throws).
      [
        Object.create(
          new Proxy(
            {},
            {
              get: fail,
              getOwnPropertyDescriptor: fail,
              getPrototypeOf: fail,
              has: fail,
              ownKeys: fail,
            },
          ),
        ),
      ],
    ];
    for (const [index, queue] of cases.entries()) {
      await assert.rejects(
        () =>
          runWorker({
            queue: queue as never,
            signal: AbortSignal.timeout(2000), // only stops a worker that wrongly started
            logger: silent,
            resizers: [resizer],
          }),
        (err: unknown) =>
          err instanceof ResizeSetupError &&
          err.code === 'RESIZE_QUEUE_INVALID',
        `case ${index}`,
      );
    }
    assert.deepEqual(memory.claims, []);
  });

  test('a queue listed twice is consumed by one Consumer', {
    timeout: 5000,
  }, async () => {
    // A long poll: with nothing due, claim waits until the worker stops. It records how many claim
    // calls run at once, and wakes the test when a claim waits after the task completed.
    let inFlight = 0;
    let mostInFlight = 0;
    let idleAfterDone: () => void = () => {};
    const idle = new Promise<void>((resolve) => {
      idleAfterDone = resolve;
    });
    class LongPollQueue extends PlainTaskQueue {
      async claim(
        queue: string,
        leaseMs: number,
        signal?: AbortSignal,
      ): Promise<ClaimedTask | null> {
        inFlight += 1;
        mostInFlight = Math.max(mostInFlight, inFlight);
        try {
          const next = await super.claim(queue, leaseMs, signal);
          if (next || !signal || signal.aborted) {
            return next;
          }
          if (this.rows.every((row) => row.status === 'completed')) {
            idleAfterDone();
          }
          await new Promise((resolve) =>
            signal.addEventListener('abort', resolve, { once: true }),
          );
          return null;
        } finally {
          inFlight -= 1;
        }
      }
    }
    const tasks = new LongPollQueue({ timing: fast });
    const resizer = queuedResizer('default', tasks);
    await tasks.add(taskOf('default'));
    const stop = new AbortController();
    const working = runWorker({
      queue: ['default', 'default'],
      signal: stop.signal,
      logger: silent,
      resizers: [resizer],
    });
    await idle;
    assert.equal(tasks.rows[0].status, 'completed');
    assert.equal(tasks.leases.length, 1);
    assert.equal(mostInFlight, 1);
    stop.abort();
    await working;
  });

  test('a worker does not start on an engine that cannot write a configured format', async () => {
    const engine: ImageEngine = {
      id: 'none',
      formats: ['png'],
      animatedFormats: [],
      resize: async (frame) => frame,
      encode: async () => {
        throw new Error('not used');
      },
    };
    const r = queuedResizer(
      'a',
      new PlainTaskQueue({ timing: fast }),
      fakeMedia(),
      { locks: memoryLocks(), engine },
    );
    await assert.rejects(
      runWorker({
        queue: ['default'],
        signal: AbortSignal.abort(),
        logger: silent,
        resizers: [r],
      }),
      { code: 'RESIZE_ENGINE_FORMAT_UNSUPPORTED' },
    );
  });

  test('a worker renders each task through the engine of its own Resizer', async () => {
    const inner = new SharpEngine();
    /** A SharpEngine that says who encoded a file, in the file's own bytes. */
    const stamped = (id: string): ImageEngine => ({
      id,
      formats: inner.formats,
      animatedFormats: inner.animatedFormats,
      resize: (frame, req, opts) => inner.resize(frame, req, opts),
      encode: async (raster) => ({
        data: Buffer.from(id),
        format: 'webp',
        contentType: 'image/webp',
        width: raster.info.width,
        height: raster.info.height,
      }),
    });
    const tasks = new MemoryTaskQueue({ timing: fast });
    const stores = new Map<string, Map<string, Preview[]>>();
    const uploaded = new Map<string, string>();
    const resizerOn = (name: string, engineId: string) => {
      const previews = new Map<string, Preview[]>();
      stores.set(name, previews);
      return queuedResizer(
        name,
        tasks,
        fakeMedia({
          load: async (id) => ({
            id,
            original: { storageRef: { key: id } },
            previews: [],
          }),
          previews,
        }),
        {
          engine: stamped(engineId),
          storage: {
            download: async () => png,
            upload: async ({ key, body }) => {
              uploaded.set(key, body.toString());
              return { key };
            },
            publicUrl: () => '',
          },
        },
      );
    };
    const resizers = [resizerOn('a', 'engine-a'), resizerOn('b', 'engine-b')];
    for (const name of ['a', 'b']) {
      await tasks.add(taskOf(name));
    }
    await workUntil({ logger: silent, resizers }, () =>
      tasks.rows.every((row) => row.status === 'completed'),
    );
    for (const [name, engineId] of [
      ['a', 'engine-a'],
      ['b', 'engine-b'],
    ]) {
      const [row] = stores.get(name)?.get('m1') ?? [];
      const { key } = row.storageRef as { key: string };
      assert.equal(uploaded.get(key), engineId);
      assert.equal(row.format, 'webp');
    }
  });

  test('Resizers that share a router or a task queue verify its carrier and their lock store once at worker start', async () => {
    let carrierVerifies = 0;
    let lockVerifies = 0;
    const locks: LockStore = Object.assign({}, memoryLocks(), {
      verify: async () => {
        lockVerifies += 1;
      },
    });
    const plain = new PlainTaskQueue({ timing: fast });
    plain.verify = async () => {
      carrierVerifies += 1;
    };
    const router = new RoutingTaskQueue({ default: plain });
    for (const tasks of [router, plain]) {
      resetResizerForTests();
      carrierVerifies = 0;
      lockVerifies = 0;
      const label = tasks === router ? 'router' : 'plain';
      const a = queuedResizer('a', tasks, fakeMedia(), { locks });
      const b = queuedResizer('b', tasks, fakeMedia(), { locks });
      await runWorker({
        queue: ['default'],
        signal: AbortSignal.abort(),
        logger: silent,
        resizers: [a, b],
      });
      assert.equal(carrierVerifies, 1, label);
      assert.equal(lockVerifies, 1, label);
      // verify() itself shares nothing: each Resizer checks its own parts.
      await a.verify();
      await b.verify();
      assert.equal(carrierVerifies, 3, label);
      assert.equal(lockVerifies, 3, label);
    }
  });
});

describe('the start line and what runWorker resolves', () => {
  const recording = () => {
    const infos: string[] = [];
    const errors: string[] = [];
    return {
      infos,
      errors,
      logger: {
        info: (line: string) => infos.push(line),
        warn() {},
        error: (line: string) => errors.push(line),
      },
    };
  };
  const stopped = () => AbortSignal.abort();

  test('the worker logs one start line naming its queues and Resizers', async () => {
    const tasks = new MemoryTaskQueue();
    queuedResizer('default', tasks);
    queuedResizer('listings', tasks);
    const { infos, logger } = recording();
    await runWorker({
      queue: ['default', 'bulk'],
      signal: stopped(),
      logger,
    });
    assert.equal(
      infos.filter((l) => l.startsWith('resize worker started')).length,
      1,
    );
    assert.ok(
      infos.includes(
        "resize worker started: queues 'default', 'bulk'; Resizers 'default', 'listings'",
      ),
      infos.join('\n'),
    );
    // Before anything is claimed: it comes first, and the stop line last.
    assert.equal(infos[0].startsWith('resize worker started'), true);
    assert.equal(infos.at(-1), 'resize worker stopped');
  });

  test('a worker whose start check fails writes no start line', async () => {
    const { infos, logger } = recording();
    queuedResizer('default', new MemoryTaskQueue({ queues: ['default'] }));
    await assert.rejects(
      runWorker({ queue: 'nobody', signal: stopped(), logger }),
      { code: 'RESIZE_QUEUE_NOT_SERVED' },
    );
    const started = () =>
      infos.filter((l) => l.startsWith('resize worker started'));
    assert.deepEqual(started(), []);

    // The last check of the start, one that passes every earlier one.
    resetResizerForTests();
    const tasks = new MemoryTaskQueue();
    tasks.verify = async () => {
      throw new ResizeSetupError('test: the queue is not ready', {
        code: 'RESIZE_MONGO_INDEX_MISSING',
      });
    };
    queuedResizer('default', tasks);
    await assert.rejects(runWorker({ signal: stopped(), logger }), {
      code: 'RESIZE_MONGO_INDEX_MISSING',
    });
    assert.deepEqual(started(), []);
  });

  test('runWorker resolves true after a run', async () => {
    queuedResizer('default', new MemoryTaskQueue());
    assert.equal(await runWorker({ signal: stopped(), logger: silent }), true);
  });

  test('an eager-only worker keeps its error line, writes no start line, and resolves false', async () => {
    queuedResizer('default', undefined);
    const { infos, errors, logger } = recording();
    assert.equal(await runWorker({ signal: stopped(), logger }), false);
    assert.deepEqual(errors, [
      'resize worker: no Resizer has a task queue (eager-only wiring)',
    ]);
    assert.deepEqual(infos, []);
  });
});

describe('worker metrics', () => {
  const fast = { idlePollMs: 5, retryBackoffMs: { base: 5, max: 5 } };

  /** A logger that keeps each level's first arguments. */
  const recordingLogger = () => {
    const lines = {
      info: [] as string[],
      warn: [] as string[],
      error: [] as string[],
    };
    return {
      lines,
      info: (msg: unknown) => {
        lines.info.push(String(msg));
      },
      warn: (msg: unknown) => {
        lines.warn.push(String(msg));
      },
      error: (msg: unknown) => {
        lines.error.push(String(msg));
      },
    };
  };

  /** A Resizer on `tasks` whose media m1 has an original, with `opts` on top. */
  const resizerOn = (
    tasks: TaskQueue,
    opts: Partial<ResizerOptions> & { failDownloads?: boolean } = {},
  ) => {
    const { failDownloads, ...rest } = opts;
    return new Resizer({
      config: makeImageConfig({ formats: ['webp'] }),
      logger: silent,
      storage: {
        download: async () => {
          if (failDownloads) {
            throw new ResizeStorageError('resize: the bucket did not answer');
          }
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
      ...rest,
    });
  };

  const addTask = (
    tasks: MemoryTaskQueue,
    over: { resizer?: string; pipeline?: string } = {},
  ) =>
    tasks.add({
      resizer: 'default',
      queue: 'default',
      mediaId: 'm1',
      pipeline: 'default',
      previews: [webp10],
      ...over,
    });

  test('with the default metrics each task outcome writes one info line', async () => {
    const tasks = new MemoryTaskQueue({ timing: fast });
    const logger = recordingLogger();
    const resizer = resizerOn(tasks, { logger });
    await addTask(tasks);
    await workUntil(
      { logger: silent, resizers: [resizer] },
      () => tasks.rows[0].status === 'completed',
    );
    const taskLines = logger.lines.info.filter((line) =>
      /^resize: task \S+ of media m1 completed in \d+ ms/.test(line),
    );
    assert.equal(taskLines.length, 1, logger.lines.info.join('\n'));

    resetResizerForTests();
    const failing = new MemoryTaskQueue({
      timing: { ...fast, maxAttempts: 2 },
    });
    const failingLogger = recordingLogger();
    const broken = resizerOn(failing, {
      logger: failingLogger,
      failDownloads: true,
    });
    await addTask(failing);
    await workUntil(
      { logger: silent, resizers: [broken] },
      () => failing.rows[0].status === 'dead',
    );
    const outcomes = failingLogger.lines.info
      .filter((line) => line.startsWith('resize: task '))
      .map((line) => /of media m1 (\w+) in \d+ ms/.exec(line)?.[1]);
    assert.deepEqual(outcomes, ['failed', 'dead']);
  });

  test('a completed task that rendered fewer than it names says so, from the render to the line', async () => {
    const tasks = new MemoryTaskQueue({ timing: fast });
    const logger = recordingLogger();
    // No document: a no-op complete, so nothing of the task's one variant was rendered.
    const resizer = resizerOn(tasks, {
      logger,
      media: fakeMedia({ load: async () => null }),
    });
    await addTask(tasks);
    await workUntil(
      { logger: silent, resizers: [resizer] },
      () => tasks.rows[0].status === 'completed',
    );
    assert.equal(
      logger.lines.info.filter((line) =>
        /^resize: task \S+ of media m1 completed in \d+ ms \(.*variants 0 of 1\)$/.test(
          line,
        ),
      ).length,
      1,
      logger.lines.info.join('\n'),
    );
  });

  test('a dead task under NoopMetrics still writes its dead line', async () => {
    const tasks = new MemoryTaskQueue({ timing: fast });
    const logger = recordingLogger();
    const resizer = resizerOn(tasks, {
      metrics: new NoopMetrics(),
      // No original: the task fails with retryable: false, so it is dead at once.
      media: fakeMedia({ load: async () => ({ id: 'm1', previews: [] }) }),
    });
    await addTask(tasks);
    // The line goes to the worker's logger, not to the Resizer's or the sink's.
    await workUntil(
      { logger, resizers: [resizer] },
      () => tasks.rows[0].status === 'dead',
    );
    assert.match(
      logger.lines.error.join('\n'),
      /is dead \(attempt 1 of \d+, code /,
    );
  });

  test('a damaged source is dead-lettered on its first delivery, and the line names limits.failOn', async () => {
    const tasks = new MemoryTaskQueue({ timing: fast });
    const logger = recordingLogger();
    const whole = await sharp({
      create: {
        width: 400,
        height: 300,
        channels: 3,
        background: '#808080',
        noise: { type: 'gaussian', mean: 128, sigma: 60 },
      },
    })
      .jpeg()
      .toBuffer();
    const cut = whole.subarray(0, Math.floor(whole.length / 2));
    let downloads = 0;
    const resizer = resizerOn(tasks, {
      storage: {
        download: async () => {
          downloads += 1;
          return cut;
        },
        upload: async () => ({ key: 'k' }),
        publicUrl: () => '',
      },
    });
    await addTask(tasks);
    await workUntil(
      { logger, resizers: [resizer] },
      () => tasks.rows[0].status === 'dead',
    );
    assert.equal(downloads, 1);
    assert.match(
      logger.lines.error.join('\n'),
      /is dead \(attempt 1 of \d+, code RESIZE_SOURCE_DAMAGED, not retryable\).*limits\.failOn 'error'/,
    );
  });

  test('a task of an unregistered pipeline is labelled unregistered', async () => {
    const tasks = new MemoryTaskQueue({ timing: { ...fast, maxAttempts: 1 } });
    const rec = recordingMetrics();
    const resizer = resizerOn(tasks, { metrics: rec });
    await addTask(tasks, { pipeline: 'ghost' });
    await workUntil(
      { logger: silent, resizers: [resizer] },
      () => tasks.rows[0].status === 'dead',
    );
    const outcomes = rec.calls.filter((call) => call.name === 'resize.task');
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].labels.pipeline, 'unregistered');
    assert.equal(outcomes[0].labels.outcome, 'dead');
    assert.equal(outcomes[0].context.pipeline, 'ghost');
  });

  test('a hung task observer of one Resizer: another Resizer on the loop is served, and the stop logs and flushes', async () => {
    const tasks = new MemoryTaskQueue({
      timing: { ...fast, taskTimeoutMs: 300 },
    });
    const rec = recordingMetrics();
    const logs = recordingLogger();
    const a = resizerOn(tasks, { metrics: rec });
    const b = resizerOn(tasks, { name: 'b', metrics: rec });
    a.hook('afterTaskComplete', () => new Promise<void>(() => {}));
    await addTask(tasks);
    await addTask(tasks, { resizer: 'b' });
    await workUntil({ logger: logs, resizers: [a, b] }, () =>
      tasks.rows.every((row) => row.status === 'completed'),
    );
    assert.equal(rec.flushes, 1);
    assert.ok(logs.lines.info.includes('resize worker stopped'));
    assert.equal(
      logs.lines.warn.filter((line) => /observers of task/.test(line)).length,
      1,
    );
  });

  test('SIGTERM on a real worker whose task observer never settles: the process exits, and the stop is logged', async () => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--import',
        fileURLToPath(new URL('./testHelpers/noAws.ts', import.meta.url)),
        fileURLToPath(
          new URL('./testHelpers/hungObserverWorker.ts', import.meta.url),
        ),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stderr.on('data', (chunk) => {
      err += String(chunk);
    });
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        resolve(code);
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = setTimeout(
          () => reject(new Error(`the tap never ran: ${out} ${err}`)),
          20_000,
        );
        child.stdout.on('data', (chunk) => {
          out += String(chunk);
          if (out.includes('the tap is hanging')) {
            clearTimeout(failed);
            resolve();
          }
        });
      });
      const stopped = performance.now();
      child.kill('SIGTERM');
      const code = await Promise.race([
        exited,
        new Promise((resolve) => {
          setTimeout(resolve, 20_000, 'still running');
        }),
      ]);
      assert.equal(code, 0, err);
      assert.ok(performance.now() - stopped < 8000);
      assert.match(out, /resize worker stopped/);
      assert.match(out, /the completed observers of task .+ did not settle/);
    } finally {
      child.kill('SIGKILL');
    }
  });

  test("the worker awaits each served sink's flush once when it stops", async () => {
    const tasks = new MemoryTaskQueue({ timing: fast });
    const rec = recordingMetrics();
    let flushed = false;
    rec.flush = () => {
      rec.flushes += 1;
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          flushed = true;
          resolve();
        }, 20);
      });
    };
    const a = resizerOn(tasks, { metrics: rec });
    const b = resizerOn(tasks, { name: 'b', metrics: rec });
    await addTask(tasks);
    await workUntil(
      { logger: silent, resizers: [a, b] },
      () => tasks.rows[0].status === 'completed',
    );
    assert.equal(rec.flushes, 1);
    assert.equal(flushed, true, 'the stop waited for the flush');
  });

  test('a metrics sink that throws or rejects never stops the worker', async () => {
    const rejections: unknown[] = [];
    const record = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', record);
    try {
      const tasks = new MemoryTaskQueue({ timing: fast });
      const logger = recordingLogger();
      const resizer = resizerOn(tasks, {
        logger,
        metrics: {
          count() {
            throw new Error('count down');
          },
          async timing() {
            throw new Error('timing down');
          },
          async flush() {
            throw new Error('flush down');
          },
        },
      });
      await addTask(tasks);
      await workUntil(
        { logger: silent, resizers: [resizer] },
        () => tasks.rows[0].status === 'completed',
      );
      await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(rejections, []);
      const sinkErrors = logger.lines.error.filter((line) =>
        line.startsWith("resize: the metrics sink of Resizer 'default' failed"),
      );
      assert.deepEqual(
        sinkErrors
          .map((line) => /of (\w+)\(\) are not logged/.exec(line)?.[1])
          .sort(),
        ['count', 'flush', 'timing'],
      );
    } finally {
      process.off('unhandledRejection', record);
    }
  });
});

describe('what a variant failure leaves behind', () => {
  const fast = { idlePollMs: 5, retryBackoffMs: { base: 5, max: 5 } };
  const logged = () => {
    const lines = {
      info: [] as string[],
      warn: [] as string[],
      error: [] as string[],
    };
    // What each `warn` got as its second argument, in line order.
    const warned: unknown[] = [];
    return {
      lines,
      warned,
      logger: {
        info: (msg: unknown) => void lines.info.push(String(msg)),
        warn: (msg: unknown, err?: unknown) => {
          lines.warn.push(String(msg));
          warned.push(err);
        },
        error: (msg: unknown) => void lines.error.push(String(msg)),
      },
    };
  };
  const sized = (side: number) => ({
    sizeKey: `${side}x${side}`,
    format: 'webp',
    requestedWidth: side,
    requestedHeight: side,
  });
  /** A Resizer whose media m1 has an original, one variant at a time, each logging to `logger`. */
  const denying = (
    tasks: TaskQueue,
    logger: ResizerOptions['logger'],
    upload: ResizeStorage['upload'],
  ) =>
    new Resizer({
      config: makeImageConfig({ formats: ['webp'], concurrency: 1 }),
      logger,
      storage: { download: async () => png, upload, publicUrl: () => '' },
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
  const accessDenied = () =>
    Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });

  test('with preview uploads denied, the row and each line say why', async () => {
    const tasks = new MemoryTaskQueue({
      timing: { ...fast, maxAttempts: 2 },
    });
    const { lines, logger } = logged();
    const resizer = denying(tasks, logger, async () => {
      throw accessDenied();
    });
    await tasks.add({
      resizer: 'default',
      queue: 'default',
      mediaId: 'm1',
      pipeline: 'default',
      previews: [sized(10)],
    });
    await workUntil(
      { logger, resizers: [resizer] },
      () => tasks.rows[0].status === 'dead',
    );
    const reason = '(cause: AccessDenied: Access Denied)';
    assert.ok(
      tasks.rows[0].error?.endsWith(reason),
      String(tasks.rows[0].error),
    );
    const retried = lines.warn.find((l) => l.includes('retrying in'));
    assert.ok(retried?.endsWith(reason), String(retried));
    const dead = lines.error.find((l) => l.includes(' is dead '));
    assert.ok(dead?.endsWith(reason), String(dead));
    // One variant: the text has no count of others.
    assert.doesNotMatch(String(tasks.rows[0].error), /variants failed/);
  });

  test('with several variants failing differently, the first failure is the cause and the text counts them', async () => {
    const tasks = new MemoryTaskQueue({
      timing: { ...fast, maxAttempts: 1 },
    });
    const { logger } = logged();
    let uploads = 0;
    const resizer = denying(tasks, logger, async () => {
      uploads += 1;
      throw new Error(`failure ${uploads}`);
    });
    await tasks.add({
      resizer: 'default',
      queue: 'default',
      mediaId: 'm1',
      pipeline: 'default',
      previews: [sized(10), sized(20), sized(30)],
    });
    await workUntil(
      { logger, resizers: [resizer] },
      () => tasks.rows[0].status === 'dead',
    );
    assert.equal(uploads, 3);
    const text = String(tasks.rows[0].error);
    assert.match(text, /3 variants failed, the first is the cause/);
    assert.ok(text.endsWith('(cause: Error: failure 1)'), text);
    assert.doesNotMatch(text, /failure 2|failure 3/);
  });

  test('a long list of missing variants does not push the reason off the row', async () => {
    const tasks = new MemoryTaskQueue({
      timing: { ...fast, maxAttempts: 1 },
    });
    const { logger } = logged();
    const resizer = denying(tasks, logger, async () => {
      throw accessDenied();
    });
    await tasks.add({
      resizer: 'default',
      queue: 'default',
      mediaId: 'm1',
      pipeline: 'default',
      previews: Array.from({ length: 48 }, (_, i) => sized(i + 1)),
    });
    await workUntil(
      { logger, resizers: [resizer] },
      () => tasks.rows[0].status === 'dead',
    );
    const text = String(tasks.rows[0].error);
    assert.equal(text.length, 1000);
    assert.ok(text.endsWith('(cause: AccessDenied: Access Denied)'), text);
  });

  test('one dead task writes one error line: its variants warn, on every attempt', async () => {
    const tasks = new MemoryTaskQueue({
      timing: { ...fast, maxAttempts: 3 },
    });
    const { lines, warned, logger } = logged();
    const resizer = denying(tasks, logger, async () => {
      throw accessDenied();
    });
    await tasks.add({
      resizer: 'default',
      queue: 'default',
      mediaId: 'm1',
      pipeline: 'default',
      previews: [sized(10), sized(20), sized(30), sized(40)],
    });
    await workUntil(
      { logger, resizers: [resizer] },
      () => tasks.rows[0].status === 'dead',
    );
    assert.equal(lines.error.length, 1, lines.error.join('\n---\n'));
    assert.match(lines.error[0], / is dead \(attempt 3 of 3, /);
    const variantErrors = warned.filter((_, index) =>
      /^resize worker: variant \S+ failed for media m1$/.test(
        lines.warn[index],
      ),
    );
    assert.equal(variantErrors.length, 4 * 3);
    assert.ok(
      variantErrors.every((err) => (err as Error).name === 'AccessDenied'),
    );
  });

  test('a variant of an unconfigured format warns too', async () => {
    const tasks = new MemoryTaskQueue({
      timing: { ...fast, maxAttempts: 2 },
    });
    const { lines, logger } = logged();
    const resizer = denying(tasks, logger, async () => ({ key: 'k' }));
    await tasks.add({
      resizer: 'default',
      queue: 'default',
      mediaId: 'm1',
      pipeline: 'default',
      previews: [{ ...sized(10), format: 'jpg' }],
    });
    await workUntil(
      { logger, resizers: [resizer] },
      () => tasks.rows[0].status === 'dead',
    );
    assert.equal(lines.error.length, 1, lines.error.join('\n---\n'));
    assert.match(lines.error[0], / is dead /);
    assert.equal(
      lines.warn.filter((l) => /^resize worker: variant \S+ failed/.test(l))
        .length,
      2,
    );
    // The row says why too: a rolling deploy can add the format, so it was retried.
    assert.match(String(tasks.rows[0].error), /have no encode\.formats entry/);
  });

  test('generate() writes no error line: the caller has the failed count or the throw', async () => {
    const { lines, warned, logger } = logged();
    const r = new Resizer({
      config: makeImageConfig({ formats: ['webp'] }),
      logger,
      storage: {
        download: async () => png,
        upload: async () => {
          throw accessDenied();
        },
        publicUrl: () => '',
      },
      media: fakeMedia(),
    });
    await assert.rejects(
      () =>
        r.generate({
          media: { id: 'm1', original: { storageRef: { key: 'o' } } },
          sizes: [{ width: 10, height: 10 }],
        }),
      { code: 'RESIZE_GENERATE_FAILED' },
    );
    assert.deepEqual(lines.error, []);
    assert.equal(lines.warn.length, 1);
    assert.match(lines.warn[0], /^resize generate: variant \S+ failed/);
    assert.equal((warned[0] as Error).name, 'AccessDenied');
  });

  test("generate()'s error names the first failure as its cause, and keeps it out of its message", async () => {
    let uploads = 0;
    const r = denying(
      new MemoryTaskQueue({ timing: fast }),
      logged().logger,
      async () => {
        uploads += 1;
        throw new Error(`failure ${uploads} at https://bucket/secret`);
      },
    );
    const err = await r
      .generate({
        media: { id: 'm1', original: { storageRef: { key: 'o' } } },
        sizes: [
          { width: 10, height: 10 },
          { width: 20, height: 20 },
          { width: 30, height: 30 },
        ],
      })
      .then(
        () => assert.fail('generate() should reject'),
        (rejected: ResizeGenerateError) => rejected,
      );
    assert.ok(err instanceof ResizeGenerateError);
    assert.equal(err.code, 'RESIZE_GENERATE_FAILED');
    assert.equal(err.failed, 3);
    assert.equal(
      (err.cause as Error).message,
      'failure 1 at https://bucket/secret',
    );
    assert.match(causeText(err), /\(cause: Error: failure 1 at /);
    // A handler may answer with `err.message`, so a driver's text does not reach it.
    assert.doesNotMatch(err.message, /failure 1|bucket/);
  });

  test("generate()'s final error keeps its final cause", async () => {
    const refusal = new ResizeSecurityError(
      'resize: this preview may not be stored',
      {
        code: 'TEST_UPLOAD_REFUSED',
      },
    );
    const r = denying(
      new MemoryTaskQueue({ timing: fast }),
      logged().logger,
      async () => {
        throw refusal;
      },
    );
    await assert.rejects(
      () =>
        r.generate({
          media: { id: 'm1', original: { storageRef: { key: 'o' } } },
          sizes: [{ width: 10, height: 10 }],
        }),
      (err: ResizeGenerateError) => {
        assert.equal(err.retryable, false);
        assert.equal(err.cause, refusal);
        return true;
      },
    );
  });
});

describe('a final failure of an original that was replaced meanwhile', () => {
  const fast = {
    idlePollMs: 5,
    retryBackoffMs: { base: 5, max: 5 },
    maxAttempts: 3,
  };
  const sizes = [{ width: 10, height: 10 }];
  const refused = () =>
    new ResizeSecurityError('resize: this preview may not be stored', {
      code: 'TEST_UPLOAD_REFUSED',
    });

  /**
   * A live media whose preview upload for original `old` waits for `release()` and then refuses,
   * while one for any other original is stored; `prewarm()` puts the first task on the queue.
   */
  const scene = (
    // A copy, as a store's load is: the task's snapshot must not see the replacement.
    load: (media: MediaLike, previews: Preview[]) => MediaLike = (
      media,
      previews,
    ) => ({ ...media, previews }),
  ) => {
    const tasks = new MemoryTaskQueue({ timing: fast });
    const media: MediaLike = {
      id: 'm1',
      original: { storageRef: { key: 'old' }, width: 64, height: 48 },
      previews: [],
    };
    const { promise: started, resolve: start } = Promise.withResolvers<void>();
    const { promise: released, resolve: release } =
      Promise.withResolvers<void>();
    const rows = new Map<string, Preview[]>();
    const parents: string[] = [];
    const resizer = new Resizer({
      config: makeImageConfig({ formats: ['webp'] }),
      logger: silent,
      storage: {
        download: async () => png,
        upload: async ({ key, parentRef }) => {
          const parent = (parentRef as { key: string }).key;
          parents.push(parent);
          if (parent === 'old') {
            start();
            await released;
            throw refused();
          }
          return { key };
        },
        publicUrl: () => '',
      },
      media: fakeMedia({
        previews: rows,
        load: async () => load(media, rows.get('m1') ?? []),
      }),
      locks: memoryLocks(),
      tasks,
    });
    return { tasks, media, started, release, rows, parents, resizer };
  };

  test('prewarm stays accepted, the task is retried, and the next delivery renders the new original', async () => {
    const s = scene();
    const first = await s.resizer.prewarm({ media: s.media, sizes });
    assert.equal(first.status, 'accepted');
    const done = workUntil(
      { logger: silent, resizers: [s.resizer] },
      () => s.tasks.rows[0].status !== 'processing' && s.rows.has('m1'),
    );
    await s.started;
    // Replaced while the old preview uploads; the same size is asked for, and held by this task.
    s.media.original = {
      storageRef: { key: 'new' },
      width: 64,
      height: 48,
    };
    const second = await s.resizer.prewarm({ media: s.media, sizes });
    assert.equal(second.status, 'accepted');
    assert.equal(s.tasks.rows.length, 1);
    s.release();
    await done;
    assert.equal(s.tasks.rows[0].status, 'completed');
    assert.equal(s.tasks.rows[0].attempts, 2);
    assert.deepEqual(s.parents, ['old', 'new']);
    assert.equal(s.rows.get('m1')?.length, 1);
    // What is stored is fresh for the new original: nothing more to do.
    const read = await s.resizer.resolve({
      media: { ...s.media, previews: s.rows.get('m1') },
      sizes,
    });
    assert.deepEqual(read.decision.missing, []);
    assert.equal(read.decision.ready.length, 1);
  });

  test('a cached document, and a ref changed in place, read as replaced too', async () => {
    const sets: [
      (media: MediaLike, previews: Preview[]) => MediaLike,
      (media: MediaLike) => void,
    ][] = [
      [
        (media, previews) => {
          media.previews = previews;
          return media;
        },
        (media) => {
          media.original = {
            storageRef: { key: 'new' },
            width: 64,
            height: 48,
          };
        },
      ],
      [
        (media, previews) => ({ ...media, previews }),
        (media) => {
          (media.original as { storageRef: { key: string } }).storageRef.key =
            'new';
        },
      ],
    ];
    for (const [load, replace] of sets) {
      resetResizerForTests();
      const s = scene(load);
      assert.equal(
        (await s.resizer.prewarm({ media: s.media, sizes })).status,
        'accepted',
      );
      const done = workUntil(
        { logger: silent, resizers: [s.resizer] },
        () => s.tasks.rows[0].status !== 'processing' && s.rows.has('m1'),
      );
      await s.started;
      replace(s.media);
      s.release();
      await done;
      assert.equal(s.tasks.rows[0].status, 'completed');
      assert.equal(s.tasks.rows[0].attempts, 2);
      assert.deepEqual(s.parents, ['old', 'new']);
    }
  });

  test('the original unchanged: the same failure is final, on the first delivery', async () => {
    const s = scene();
    assert.equal(
      (await s.resizer.prewarm({ media: s.media, sizes })).status,
      'accepted',
    );
    s.release();
    const events: { event: TaskEvent; error?: unknown }[] = [];
    const stop = new AbortController();
    await consume(s.tasks, {
      queue: 'default',
      signal: stop.signal,
      handle: (task, opts) => processTask(task, opts),
      onEvent: (event, _task, error) => {
        events.push({ event, error });
        stop.abort();
      },
      logger: silent,
    });
    assert.deepEqual(
      events.map((e) => e.event),
      ['deadLettered'],
    );
    assert.ok(events[0].error instanceof ResizeGenerateError);
    assert.equal(events[0].error.code, 'RESIZE_WORKER_INCOMPLETE');
    assert.equal(events[0].error.retryable, false);
    assert.equal(s.tasks.rows[0].status, 'dead');
    assert.equal(s.tasks.rows[0].attempts, 1);
    assert.match(
      String(s.tasks.rows[0].error),
      /\(cause: ResizeSecurityError: resize: this preview may not be stored\)$/,
    );
  });

  test('a replacement that only changes the stored size counts too; a backfill of the same size does not', async () => {
    const refuseEvery = async () => {
      throw refused();
    };
    const run = async (
      loaded: MediaLike['original'],
      reloaded: MediaLike['original'],
    ) => {
      resetResizerForTests();
      const tasks = new MemoryTaskQueue({ timing: fast });
      let loads = 0;
      new Resizer({
        config: makeImageConfig({ formats: ['webp'] }),
        logger: silent,
        storage: {
          download: async () => png,
          upload: refuseEvery,
          publicUrl: () => '',
        },
        media: fakeMedia({
          load: async () => {
            loads += 1;
            return {
              id: 'm1',
              original: loads === 1 ? loaded : reloaded,
              previews: [],
            };
          },
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
      });
      const events = await firstEvent(tasks);
      return (events[0].error as ResizeGenerateError).retryable;
    };
    const ref = { key: 'same' };
    // The same storage ref with another stored size: new bytes may be behind it.
    assert.equal(
      await run(
        { storageRef: ref, width: 64, height: 48 },
        { storageRef: ref, width: 128, height: 96 },
      ),
      true,
    );
    // Dimensions the persist backfilled, the very ones the render measured: the same original.
    assert.equal(
      await run(
        { storageRef: ref },
        { storageRef: ref, width: 64, height: 48 },
      ),
      false,
    );
    // A store that drops the backfill: still the same original.
    assert.equal(await run({ storageRef: ref }, { storageRef: ref }), false);
    // The original gone from the reloaded media: the next delivery says so.
    assert.equal(
      await run({ storageRef: ref, width: 64, height: 48 }, undefined),
      true,
    );
  });
});

describe('a final failure of the whole task, on an original that was replaced meanwhile', () => {
  const fast = {
    idlePollMs: 5,
    retryBackoffMs: { base: 5, max: 5 },
    maxAttempts: 3,
  };
  const sizes = [{ width: 10, height: 10 }];
  const wholeJpeg = () =>
    sharp({
      create: {
        width: 400,
        height: 300,
        channels: 3,
        background: '#808080',
        noise: { type: 'gaussian', mean: 128, sigma: 60 },
      },
    })
      .jpeg()
      .toBuffer();

  /**
   * A cut JPEG whose download waits for its replacement, then a second `prewarm()`. `load` is what
   * the store gives for the media, and `replace` how the host changes it.
   */
  const replacedDuringDownload = async (
    load: (media: MediaLike, previews: Preview[]) => MediaLike,
    replace: (media: MediaLike) => void,
  ) => {
    const whole = await wholeJpeg();
    const cut = whole.subarray(0, Math.floor(whole.length / 2));
    const tasks = new MemoryTaskQueue({ timing: fast });
    const media: MediaLike = {
      id: 'm1',
      original: { storageRef: { key: 'old' }, width: 400, height: 300 },
      previews: [],
    };
    const { promise: started, resolve: start } = Promise.withResolvers<void>();
    const { promise: released, resolve: release } =
      Promise.withResolvers<void>();
    const rows = new Map<string, Preview[]>();
    const downloaded: string[] = [];
    const parents: string[] = [];
    const resizer = new Resizer({
      config: makeImageConfig({ formats: ['webp'] }),
      logger: silent,
      storage: {
        download: async (ref) => {
          const { key } = ref as { key: string };
          downloaded.push(key);
          if (key !== 'old') {
            return whole;
          }
          start();
          await released;
          return cut;
        },
        upload: async ({ key, parentRef }) => {
          parents.push((parentRef as { key: string }).key);
          return { key };
        },
        publicUrl: () => '',
      },
      media: fakeMedia({
        previews: rows,
        load: async () => load(media, rows.get('m1') ?? []),
      }),
      locks: memoryLocks(),
      tasks,
    });
    const first = await resizer.prewarm({ media, sizes });
    assert.equal(first.status, 'accepted');
    const done = workUntil(
      { logger: silent, resizers: [resizer] },
      () => tasks.rows[0].status !== 'processing' && rows.has('m1'),
    );
    await started;
    replace(media);
    const second = await resizer.prewarm({ media, sizes });
    assert.equal(second.status, 'accepted');
    assert.equal(tasks.rows.length, 1);
    release();
    await done;
    assert.equal(tasks.rows[0].status, 'completed');
    assert.equal(tasks.rows[0].attempts, 2);
    assert.deepEqual(downloaded, ['old', 'new']);
    assert.deepEqual(parents, ['new']);
    const read = await resizer.resolve({
      media: { ...media, previews: rows.get('m1') },
      sizes,
    });
    assert.deepEqual(read.decision.missing, []);
    assert.equal(read.decision.ready.length, 1);
  };
  const toNew = (media: MediaLike) => {
    media.original = {
      storageRef: { key: 'new' },
      width: 400,
      height: 300,
    };
  };
  const refInPlace = (media: MediaLike) => {
    (media.original as { storageRef: { key: string } }).storageRef.key = 'new';
  };

  test('a damaged original replaced during its task: prewarm stays accepted, and the next delivery renders the new one', async () => {
    // A copy, as most stores' load is: the task's document cannot see the replacement.
    await replacedDuringDownload(
      (media, previews) => ({
        ...media,
        original: {
          ...media.original,
          storageRef: { ...(media.original?.storageRef as object) },
        } as MediaLike['original'],
        previews,
      }),
      toNew,
    );
  });

  test('a cached document whose original is replaced during the task', async () => {
    await replacedDuringDownload((media, previews) => {
      media.previews = previews;
      return media;
    }, toNew);
  });

  test('a shallow-copied document whose ref changes in place during the task', async () => {
    await replacedDuringDownload(
      (media, previews) => ({ ...media, previews }),
      refInPlace,
    );
  });

  test('a cached document whose ref changes in place during the task', async () => {
    await replacedDuringDownload((media, previews) => {
      media.previews = previews;
      return media;
    }, refInPlace);
  });

  /** The task's first delivery on a cut JPEG: the first load gives `loaded`, each later one `reload()`. */
  const deliver = async (
    loaded: MediaLike['original'],
    reload: () => Promise<MediaLike | null>,
  ) => {
    resetResizerForTests();
    const whole = await wholeJpeg();
    const tasks = new MemoryTaskQueue({ timing: fast });
    let loads = 0;
    new Resizer({
      config: makeImageConfig({ formats: ['webp'] }),
      logger: silent,
      storage: {
        download: async () => whole.subarray(0, Math.floor(whole.length / 2)),
        upload: async ({ key }) => ({ key }),
        publicUrl: () => '',
      },
      media: fakeMedia({
        load: async () => {
          loads += 1;
          return loads === 1
            ? { id: 'm1', original: loaded, previews: [] }
            : reload();
        },
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
    });
    const [{ event, error }] = await firstEvent(tasks);
    return { event, error: error as ResizeError, row: tasks.rows[0], loads };
  };
  const ref = { key: 'same' };
  const mediaWith = (original: MediaLike['original']) => async () => ({
    id: 'm1',
    original,
    previews: [],
  });

  test('the retry keeps the reason on the row, under RESIZE_WORKER_INCOMPLETE', async () => {
    const { event, error, row } = await deliver(
      { storageRef: { key: 'old' }, width: 400, height: 300 },
      mediaWith({ storageRef: { key: 'new' }, width: 400, height: 300 }),
    );
    assert.notEqual(event, 'deadLettered');
    assert.ok(error instanceof ResizeGenerateError);
    assert.equal(error.code, 'RESIZE_WORKER_INCOMPLETE');
    assert.equal(error.retryable, true);
    assert.deepEqual(error.missing, ['default:default:10x10:webp:none']);
    assert.equal((error.cause as ResizeError).code, 'RESIZE_SOURCE_DAMAGED');
    assert.equal((error.cause as ResizeError).retryable, false);
    assert.match(
      String(row.error),
      /is incomplete \(its original was replaced while it ran\);.*\(cause: ResizeMediaError: resize: the source is damaged/,
    );
  });

  test('the original unchanged: dead on the first delivery, at the cost of one read', async () => {
    const { event, error, row, loads } = await deliver(
      { storageRef: ref, width: 400, height: 300 },
      mediaWith({ storageRef: ref, width: 400, height: 300 }),
    );
    assert.equal(event, 'deadLettered');
    assert.equal(error.code, 'RESIZE_SOURCE_DAMAGED');
    assert.equal(error.retryable, false);
    assert.equal(row.status, 'dead');
    assert.equal(row.attempts, 1);
    assert.equal(loads, 2);
  });

  test('what counts as another original', async () => {
    const stored = { storageRef: ref, width: 400, height: 300 };
    const bare = { storageRef: ref };
    const retried = async (
      loaded: MediaLike['original'],
      reloaded: MediaLike['original'],
    ) => (await deliver(loaded, mediaWith(reloaded))).error.retryable;
    // The same storage ref with another stored size: new bytes may be behind it.
    assert.equal(
      await retried(stored, { storageRef: ref, width: 800, height: 600 }),
      true,
    );
    assert.equal(
      await retried(stored, {
        storageRef: { key: 'other' },
        width: 400,
        height: 300,
      }),
      true,
    );
    assert.equal(await retried(bare, { storageRef: { key: 'other' } }), true);
    // The original gone from a live media: the next delivery says so.
    assert.equal(await retried(stored, undefined), true);
    // A stored size only one side holds is a backfill, not a replacement.
    assert.equal(await retried(bare, stored), false);
    assert.equal(await retried(stored, bare), false);
    assert.equal(await retried(bare, bare), false);
  });

  test('a reload that fails, and a media that is gone, keep the final error', async () => {
    const stored = { storageRef: ref, width: 400, height: 300 };
    for (const reload of [
      async () => {
        throw new Error('database down');
      },
      // Not an async function: a store of the same shape may throw before it returns a promise.
      () => {
        throw new Error('database down');
      },
      async () => null,
      // A ref that cannot be signed: nothing proves the original changed.
      async () => ({
        id: 'm1',
        original: { storageRef: { key: 1n } },
        previews: [],
      }),
    ]) {
      const { event, error } = await deliver(stored, reload);
      assert.equal(event, 'deadLettered');
      assert.equal(error.code, 'RESIZE_SOURCE_DAMAGED');
      assert.equal(error.retryable, false);
    }
  });

  test('a failure that is not final, and a task that succeeds, cost no read of their own', async () => {
    const run = async (download: ResizeStorage['download']) => {
      resetResizerForTests();
      const tasks = new MemoryTaskQueue({ timing: fast });
      let loads = 0;
      new Resizer({
        config: makeImageConfig({ formats: ['webp'] }),
        logger: silent,
        storage: {
          download,
          upload: async ({ key }) => ({ key }),
          publicUrl: () => '',
        },
        media: fakeMedia({
          load: async () => {
            loads += 1;
            return {
              id: 'm1',
              original: { storageRef: { key: 'old' } },
              previews: [],
            };
          },
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
      });
      const [{ error }] = await firstEvent(tasks);
      return { error, loads };
    };
    const retryable = new ResizeStorageError('storage down');
    const plain = new Error('not ours');
    const first = await run(async () => {
      throw retryable;
    });
    assert.equal(first.error, retryable);
    assert.equal(first.loads, 1);
    const second = await run(async () => {
      throw plain;
    });
    assert.equal(second.error, plain);
    assert.equal(second.loads, 1);
    const ok = await run(async () => png);
    assert.equal(ok.error, undefined);
    // The load, and the coverage re-read every task makes.
    assert.equal(ok.loads, 2);
  });
});
