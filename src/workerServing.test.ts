// prepareServing, the wiring `runWorker()` and push delivery share: what it hands back, and the only
// things that differ for a pushed serving. That pull did not change is proved by src/worker.test.ts
// and src/framework/worker.test.ts, which pass untouched.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import sharp from 'sharp';
import type { ImageEngine } from './contracts/engine.ts';
import type { LeasedTask } from './contracts/taskQueue.ts';
import { ResizeSetupError } from './errors.ts';
import { NoopMetrics } from './metrics.ts';
import {
  Resizer,
  type ResizerOptions,
  resetResizerForTests,
} from './resizer.ts';
import {
  fakeMedia,
  memoryLocks,
  memoryStorage,
  PlainTaskQueue,
  ReleasingTaskQueue,
} from './testHelpers/fakes.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import {
  flushMetrics,
  prepareServing,
  type RunWorkerOptions,
  runWorker,
} from './worker.ts';

const silentLogger = { info() {}, warn() {}, error() {} };

const make = (options: Partial<ResizerOptions>): Resizer =>
  new Resizer({
    config: makeImageConfig(),
    storage: memoryStorage().storage,
    media: fakeMedia(),
    locks: memoryLocks(),
    metrics: new NoopMetrics(),
    logger: silentLogger,
    ...options,
  });

const other: LeasedTask = {
  taskId: 't',
  resizer: 'other',
  queue: 'default',
  mediaId: 'm',
  pipeline: 'default',
  previews: [],
  attempts: 1,
};

afterEach(resetResizerForTests);

test('a pushed serving never gives a task back: no accepts, and a task of another Resizer rejects with RESIZE_NO_RESIZER', async () => {
  const tasks = new ReleasingTaskQueue();
  const resizer = make({ tasks });
  const lines: string[] = [];
  const logger = {
    info() {},
    warn() {},
    error: (m: string) => lines.push(m),
  };
  const serving = await prepareServing({
    resizers: [resizer],
    pushed: true,
    logger,
  });
  assert.ok(serving);
  const deps = serving.depsOf('default', tasks, tasks);
  assert.equal(deps.accepts, undefined);
  await assert.rejects(
    deps.handle(other, { signal: new AbortController().signal }),
    { code: 'RESIZE_NO_RESIZER' },
  );
  assert.match(lines.join('\n'), /createSqsHandler\(\{ resizers \}\)/);
  assert.match(lines.join('\n'), /cannot go to another consumer/);
});

// `pushed` is prepareServing's switch, not a runWorker option. A JavaScript caller has no type to stop
// it, and in a worker it would dead-letter another worker's task instead of giving it back.
test('runWorker ignores a `pushed` it is passed: a task of another Resizer is given back, even at maxAttempts 1', async (t) => {
  const tasks = new ReleasingTaskQueue({
    timing: { maxAttempts: 1, idlePollMs: 1 },
  });
  const resizer = make({ tasks });
  await tasks.add({
    resizer: 'other',
    queue: 'default',
    mediaId: 'm',
    pipeline: 'default',
    previews: [],
  });
  const stop = new AbortController();
  const [row] = tasks.rows;
  const watch = setInterval(() => {
    if (tasks.releaseCalls.length >= 3 || row.status === 'dead') {
      stop.abort();
    }
  }, 1);
  t.after(() => clearInterval(watch));
  await runWorker({
    signal: stop.signal,
    resizers: [resizer],
    logger: silentLogger,
    pushed: true,
  } as RunWorkerOptions);
  assert.notEqual(row.status, 'dead');
  assert.ok(tasks.releaseCalls.length >= 3, `${tasks.releaseCalls.length}`);
});

test('a pulled serving keeps accepts on a queue that can give back', async () => {
  const tasks = new ReleasingTaskQueue();
  const serving = await prepareServing({
    resizers: [make({ tasks })],
    logger: silentLogger,
  });
  assert.equal(
    serving?.depsOf('default', tasks, tasks).accepts?.(other),
    false,
  );
});

test('prepareServing names the lanes and the served Resizers, and finds the owner of a task', async () => {
  const tasks = new PlainTaskQueue();
  const resizer = make({ tasks });
  const serving = await prepareServing({
    queue: ['default', 'default'],
    logger: silentLogger,
  });
  assert.deepEqual(serving?.queues, ['default']);
  assert.deepEqual(serving?.resizers, [resizer]);
  assert.deepEqual([...(serving?.lanes[0].carriers.keys() ?? [])], [tasks]);
  assert.equal(serving?.ownerOf({ ...other, resizer: resizer.name }), resizer);
  assert.equal(serving?.ownerOf(other), undefined);
});

test('prepareServing writes no start line: that one is the worker process', async () => {
  const infos: string[] = [];
  await prepareServing({
    resizers: [make({ tasks: new PlainTaskQueue() })],
    logger: { info: (m: string) => infos.push(m), warn() {}, error() {} },
  });
  assert.deepEqual(
    infos.filter((m) => m.startsWith('resize worker started')),
    [],
  );
});

test('prepareServing resolves undefined and logs when no Resizer has a task queue', async () => {
  const lines: string[] = [];
  const logger = {
    info() {},
    warn() {},
    error: (m: string) => lines.push(m),
  };
  assert.equal(
    await prepareServing({ resizers: [make({})], logger }),
    undefined,
  );
  assert.match(lines.join('\n'), /no Resizer has a task queue/);
});

test('prepareServing tunes Sharp last: a start check that fails leaves it as it is', async (t) => {
  const before = sharp.concurrency();
  t.after(() => sharp.concurrency(before));
  // The task queue's own verify() is the last check of all, so tuning anywhere before it fails here.
  const tasks = new PlainTaskQueue();
  let broken = true;
  tasks.verify = async () => {
    if (broken) {
      throw new ResizeSetupError('the last check');
    }
  };
  const resizer = make({ tasks });
  const tuned = { concurrency: before + 1, cache: true };
  await assert.rejects(
    prepareServing({
      resizers: [resizer],
      sharp: tuned,
      logger: silentLogger,
    }),
    { message: 'the last check' },
  );
  assert.equal(sharp.concurrency(), before);
  broken = false;
  await prepareServing({
    resizers: [resizer],
    sharp: tuned,
    logger: silentLogger,
  });
  assert.equal(sharp.concurrency(), before + 1);
});

test('flushMetrics waits at most the bound it is given', async () => {
  const hung = make({
    tasks: new PlainTaskQueue(),
    metrics: {
      count() {},
      timing() {},
      flush: () => new Promise<void>(() => {}),
    },
  });
  await hung.ready();
  const started = performance.now();
  await flushMetrics([hung], 50);
  assert.ok(performance.now() - started < 1000);
});

test('flushMetrics never waits past its own 5 s bound, whatever it is given', async (t) => {
  const hung = make({
    tasks: new PlainTaskQueue(),
    metrics: {
      count() {},
      timing() {},
      flush: () => new Promise<void>(() => {}),
    },
  });
  await hung.ready();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  void flushMetrics([hung], 60_000).then(() => {
    settled = true;
  });
  t.mock.timers.tick(5_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, true);
});

test('a pushed serving with no Resizer says where to import them', async () => {
  await assert.rejects(prepareServing({ pushed: true, logger: silentLogger }), {
    code: 'RESIZE_NO_RESIZER',
    message: /handler's file/,
  });
});

// Phase D's start check: a Lambda handler gets it through prepareServing, at its first invocation.
test('a pushed serving keeps the start checks: an engine that cannot write a configured format', async () => {
  const engine: ImageEngine = {
    id: 'none',
    formats: ['png'],
    animatedFormats: [],
    resize: async (frame) => frame,
    encode: async () => {
      throw new Error('not used');
    },
  };
  await assert.rejects(
    prepareServing({
      resizers: [make({ tasks: new PlainTaskQueue(), engine })],
      pushed: true,
      logger: silentLogger,
    }),
    { code: 'RESIZE_ENGINE_FORMAT_UNSUPPORTED' },
  );
});
