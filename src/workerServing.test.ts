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
import { RoutingTaskQueue } from './routing.ts';
import {
  fakeMedia,
  memoryLocks,
  memoryStorage,
  PlainTaskQueue,
  ReleasingTaskQueue,
} from './testHelpers/fakes.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import type { ResizeLogger } from './types.d.ts';
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

// A Lambda host has no worker to be told about, and a worker host's lines are what its alerts match:
// every message prepareServing can write comes in both forms, and each is pinned whole. (The one line
// left out, on a coordination that cannot be read, has no way to fire: see coordinationOf.)
interface Wording {
  what: string;
  // Rejects, or logs, or both: the test reads the lines it logged, then what it rejected with.
  run: (opts: { pushed: boolean; logger: ResizeLogger }) => Promise<unknown>;
  worker: string[];
  handler: string[];
}
const notServedTask = async ({
  pushed,
  logger,
}: {
  pushed: boolean;
  logger: ResizeLogger;
}) => {
  const tasks = new PlainTaskQueue();
  const serving = await prepareServing({
    resizers: [make({ tasks })],
    pushed,
    logger,
  });
  assert.ok(serving);
  return serving.depsOf('default', tasks, tasks);
};
const NOT_SERVED_BY_WORKER =
  "Resizer 'other' is not served by this worker (pass it in runWorker({ resizers }) or construct it before the worker starts)";
const NOT_SERVED_BY_HANDLER =
  "Resizer 'other' is not served by this handler (pass it in createSqsHandler({ resizers }) or construct it before the first invocation)";
const WORDINGS: Wording[] = [
  {
    what: 'an empty queue list',
    run: (opts) => prepareServing({ ...opts, queue: [] }),
    worker: [
      'resize worker: `queue` must be a queue name or a non-empty list of them',
    ],
    handler: [
      'resize lambda: `queue` must be a queue name or a non-empty list of them',
    ],
  },
  {
    what: 'a blank queue name',
    run: (opts) => prepareServing({ ...opts, queue: [''] }),
    worker: [
      "resize worker: every queue name must be a non-empty string (got '')",
    ],
    handler: [
      "resize lambda: every queue name must be a non-empty string (got '')",
    ],
  },
  {
    what: 'an empty resizers list',
    run: (opts) => prepareServing({ ...opts, resizers: [] }),
    worker: [
      'resize worker: the `resizers` list is empty — pass the Resizers this worker serves',
    ],
    handler: [
      'resize lambda: the `resizers` list is empty — pass the Resizers this handler serves',
    ],
  },
  {
    what: 'no Resizer constructed',
    run: (opts) => prepareServing(opts),
    worker: [
      'resize worker: no Resizer constructed — construct your Resizers in the worker process before starting it',
    ],
    handler: [
      "resize lambda: no Resizer constructed — import the file that constructs your Resizers in the handler's file, before the first invocation",
    ],
  },
  {
    what: 'two Resizers under one name',
    run: (opts) => {
      const first = make({ name: 'x', tasks: new PlainTaskQueue() });
      resetResizerForTests();
      const second = make({ name: 'x', tasks: new PlainTaskQueue() });
      return prepareServing({ ...opts, resizers: [first, second] });
    },
    worker: [
      "resize worker: the `resizers` list names 'x' twice — list each Resizer once",
    ],
    handler: [
      "resize lambda: the `resizers` list names 'x' twice — list each Resizer once",
    ],
  },
  {
    what: 'no task queue at all',
    run: (opts) => prepareServing({ ...opts, resizers: [make({})] }),
    worker: ['resize worker: no Resizer has a task queue (eager-only wiring)'],
    handler: ['resize lambda: no Resizer has a task queue (eager-only wiring)'],
  },
  {
    what: 'a name no task queue serves',
    run: (opts) =>
      prepareServing({
        ...opts,
        queue: 'bulk',
        resizers: [
          make({ tasks: new PlainTaskQueue({ queues: ['default'] }) }),
        ],
      }),
    worker: [
      "resize worker: a task queue does not serve queue 'bulk' — skipping it",
      "resize worker: no task queue serves queue 'bulk'",
    ],
    handler: [
      "resize lambda: a task queue does not serve queue 'bulk' — skipping it",
      "resize lambda: no task queue serves queue 'bulk'",
    ],
  },
  {
    what: 'a backend that cannot be built',
    run: (opts) =>
      prepareServing({
        ...opts,
        resizers: [
          make({
            tasks: new RoutingTaskQueue({
              default: async () => {
                throw new Error('no backend');
              },
            }),
          }),
        ],
      }),
    worker: [
      "resize worker: queue 'default' of Resizer 'default': its backend could not be built",
      'no backend',
    ],
    handler: [
      "resize lambda: queue 'default' of Resizer 'default': its backend could not be built",
      'no backend',
    ],
  },
  {
    what: 'an unlisted Resizer on the same task queue',
    run: (opts) => {
      const tasks = new PlainTaskQueue();
      const served = make({ tasks });
      make({ name: 'other', tasks });
      return prepareServing({ ...opts, resizers: [served] });
    },
    worker: [
      "resize worker: Resizer(s) 'other' share a task queue this worker consumes for queue 'default' but are not in the `resizers` list — the worker would claim their tasks without running them; list them too, or give them their own task queue",
    ],
    handler: [
      "resize lambda: Resizer(s) 'other' share a task queue this handler consumes for queue 'default' but are not in the `resizers` list — their messages would reach this handler, which cannot run them; list them too, or give them their own task queue",
    ],
  },
  {
    what: 'an unlisted Resizer whose task queue does not load',
    run: (opts) => {
      const served = make({ tasks: new PlainTaskQueue() });
      make({
        name: 'other',
        tasks: async () => {
          throw new Error('no load');
        },
      });
      return prepareServing({ ...opts, resizers: [served] });
    },
    worker: [
      "resize worker: the task queue of Resizer(s) 'other' failed to load, so whether it is one this worker consumes for queue 'default' could not be determined — fix that task queue (the load error is the cause)",
    ],
    handler: [
      "resize lambda: the task queue of Resizer(s) 'other' failed to load, so whether it is one this handler consumes for queue 'default' could not be determined — fix that task queue (the load error is the cause)",
    ],
  },
  {
    what: 'a task of a Resizer not served',
    run: async (opts) =>
      (await notServedTask(opts)).handle(other, {
        signal: new AbortController().signal,
      }),
    worker: [
      `resize worker: ${NOT_SERVED_BY_WORKER} — this task queue cannot give tasks back, so its tasks fail with RESIZE_NO_RESIZER (they retry, then dead-letter)`,
      `resize worker: ${NOT_SERVED_BY_WORKER}`,
    ],
    handler: [
      `resize lambda: ${NOT_SERVED_BY_HANDLER} — a pushed message cannot go to another consumer, so its tasks fail with RESIZE_NO_RESIZER (they retry, then dead-letter)`,
      `resize lambda: ${NOT_SERVED_BY_HANDLER}`,
    ],
  },
  {
    what: 'an event of a Resizer not served',
    run: async (opts) => (await notServedTask(opts)).events?.('failed', other),
    worker: [
      `resize worker: failed for task t dropped — ${NOT_SERVED_BY_WORKER}`,
    ],
    handler: [
      `resize lambda: failed for task t dropped — ${NOT_SERVED_BY_HANDLER}`,
    ],
  },
];

for (const { what, run, worker, handler } of WORDINGS) {
  test(`what is said about ${what}: a worker's text stays, and a handler's names no worker`, async () => {
    const said = async (pushed: boolean): Promise<string[]> => {
      resetResizerForTests();
      const lines: string[] = [];
      const line = (message: string) => {
        lines.push(message);
      };
      await run({
        pushed,
        logger: { info: line, warn: line, error: line },
      }).catch((err: Error) => line(err.message));
      return lines;
    };
    assert.deepEqual(await said(false), worker);
    const pushedLines = await said(true);
    assert.deepEqual(pushedLines, handler);
    assert.doesNotMatch(pushedLines.join('\n'), /worker/);
  });
}

test('a worker that can give a task back still says so, in its own words', async () => {
  const lines: string[] = [];
  const line = (message: string) => {
    lines.push(message);
  };
  const tasks = new ReleasingTaskQueue();
  const serving = await prepareServing({
    resizers: [make({ tasks })],
    logger: { info: line, warn: line, error: line },
  });
  serving?.depsOf('default', tasks, tasks).accepts?.(other);
  assert.deepEqual(lines, [
    `resize worker: ${NOT_SERVED_BY_WORKER} — its tasks are given back to the queue for a worker that serves it`,
  ]);
});
