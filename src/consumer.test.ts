// The worker loop (Consumer) against the in-memory TaskQueue: the same lifecycle every backend
// gets — completion, retry with backoff, dead-lettering, non-retryable errors, crash loops,
// timeouts, lost leases, graceful shutdown and resilient claiming — plus the gate lock it holds on
// a queue without gatesByTask, the dead-letter cooldown it passes to a queue with it, and a host
// logger that throws.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { backoffMs, Consumer } from './consumer.ts';
import type { LockStore } from './contracts/locks.ts';
import type {
  ClaimedTask,
  ClaimOptions,
  LeasedTask,
  NewTask,
  TaskEvent,
  TaskQueue,
} from './contracts/taskQueue.ts';
import {
  ResizeError,
  ResizeGenerateError,
  ResizeMediaError,
  ResizeNoOriginalError,
} from './errors.ts';
import { gateKey } from './lockKeys.ts';
import { consume } from './testHelpers/consume.ts';
import {
  clockLocks,
  MemoryTaskQueue,
  PlainTaskQueue,
  ReleasingTaskQueue,
  recordingMetrics,
} from './testHelpers/fakes.ts';
import { timingOf } from './timing.ts';

const silent = { info() {}, warn() {}, error() {} };

// Like the worker on SIGTERM: the task signal aborts, the current variant ends, the remaining ones
// are skipped, and the handler rejects as incomplete.
const stoppedByShutdown = (
  _task: LeasedTask,
  { signal }: { signal: AbortSignal },
) =>
  new Promise<void>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () =>
        reject(
          new ResizeGenerateError({
            mediaId: 'm1',
            failed: 1,
            requested: 1,
            code: 'RESIZE_WORKER_INCOMPLETE',
          }),
        ),
      { once: true },
    );
  });

/** Run the loop until the handler has started, then shut it down and wait for it to return. */
async function shutDownMidTask(
  tasks: MemoryTaskQueue | PlainTaskQueue,
  handle: (
    task: LeasedTask,
    opts: { signal: AbortSignal },
  ) => Promise<void> = stoppedByShutdown,
) {
  const events: { event: TaskEvent; task: LeasedTask; error?: unknown }[] = [];
  const stop = new AbortController();
  let started = false;
  const loop = consume(tasks, {
    queue: 'default',
    signal: stop.signal,
    handle: (task, opts) => {
      started = true;
      return handle(task, opts);
    },
    onEvent: (event, task, error) => {
      events.push({ event, task, error });
    },
    logger: silent,
  });
  const until = Date.now() + 5000;
  try {
    while (!started) {
      assert.ok(Date.now() < until, 'the handler never started');
      await new Promise((r) => setTimeout(r, 2));
    }
  } catch (err) {
    // A failed wait still stops the loop, so the test file can exit; the assertion is the error.
    stop.abort();
    await loop.catch(() => {});
    throw err;
  }
  stop.abort();
  await loop;
  return events;
}

const newTask = (over: Partial<NewTask> = {}): NewTask => ({
  resizer: 'default',
  queue: 'default',
  mediaId: 'm1',
  pipeline: 'default',
  previews: [{ sizeKey: '10x10', format: 'webp' }],
  ...over,
});

const fastTiming = {
  leaseMs: 200,
  idlePollMs: 5,
  taskTimeoutMs: 2000,
  retryBackoffMs: { base: 10, max: 40 },
  maxAttempts: 3,
};

type ConsumeOptions = Parameters<typeof consume>[1];

/**
 * Run the loop until `done()` (or 5 s), then stop it and wait for it to return. `opts` go to the
 * Consumer (default logger: silent).
 */
async function runUntil(
  tasks: MemoryTaskQueue | PlainTaskQueue,
  handle: (task: LeasedTask, opts: { signal: AbortSignal }) => Promise<void>,
  done: () => boolean,
  opts: Pick<
    ConsumeOptions,
    'logger' | 'resizers' | 'coordinationOf' | 'metricsOf'
  > = {},
) {
  const events: { event: TaskEvent; task: LeasedTask; error?: unknown }[] = [];
  const stop = new AbortController();
  const loop = consume(tasks, {
    queue: 'default',
    signal: stop.signal,
    handle,
    onEvent: (event, task, error) => {
      events.push({ event, task, error });
    },
    logger: silent,
    ...opts,
  });
  const until = Date.now() + 5000;
  try {
    while (!done()) {
      assert.ok(
        Date.now() < until,
        'the queue loop did not reach the expected state',
      );
      await new Promise((r) => setTimeout(r, 5));
    }
  } catch (err) {
    // A failed wait still stops the loop, so the test file can exit; the assertion is the error.
    stop.abort();
    await loop.catch(() => {});
    throw err;
  }
  stop.abort();
  await loop;
  return events;
}

describe('Consumer', () => {
  test('a Consumer completes a task with only its own deps', {
    timeout: 5000,
  }, async () => {
    const tasks = new MemoryTaskQueue({ timing: fastTiming });
    await tasks.add(newTask());
    const stop = new AbortController();
    const events: TaskEvent[] = [];
    await new Consumer({
      tasks,
      timing: timingOf(tasks, 'default'),
      handle: async () => {
        stop.abort();
      },
      events: (event) => {
        events.push(event);
      },
      logger: { info() {}, warn() {}, error() {} },
    }).run('default', stop.signal);
    assert.equal(tasks.rows[0].status, 'completed');
    assert.deepEqual(events, ['completed']);
  });

  test('a successful task is completed and reported, without its lease token', async () => {
    const tasks = new MemoryTaskQueue({ timing: fastTiming });
    await tasks.add(newTask());
    const handled: LeasedTask[] = [];
    const events = await runUntil(
      tasks,
      async (task) => {
        handled.push(task);
      },
      () => tasks.rows[0].status === 'completed',
    );
    assert.equal(handled.length, 1);
    assert.equal('token' in handled[0], false);
    assert.equal(handled[0].attempts, 1);
    assert.deepEqual(
      events.map((e) => e.event),
      ['completed'],
    );
  });

  test('task events carry the delivery count', async () => {
    const tasks = new MemoryTaskQueue({
      timing: { ...fastTiming, retryBackoffMs: { base: 1, max: 1 } },
    });
    await tasks.add(newTask());
    let calls = 0;
    const events = await runUntil(
      tasks,
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('once');
        }
      },
      () => tasks.rows[0].status === 'completed',
    );
    assert.deepEqual(
      events.map((e) => [e.event, e.task.attempts]),
      [
        ['failed', 1],
        ['completed', 2],
      ],
    );
  });

  test('a failing task is retried after its backoff, then dead after maxAttempts', async () => {
    const tasks = new MemoryTaskQueue({ timing: fastTiming });
    await tasks.add(newTask());
    let calls = 0;
    const events = await runUntil(
      tasks,
      async () => {
        calls += 1;
        throw new Error('sharp exploded');
      },
      () => tasks.rows[0].status === 'dead',
    );
    assert.equal(calls, 3);
    assert.deepEqual(
      events.map((e) => e.event),
      ['failed', 'failed', 'deadLettered'],
    );
    assert.match(tasks.rows[0].error ?? '', /sharp exploded/);
  });

  test('a retry waits for its backoff', async () => {
    const tasks = new MemoryTaskQueue({
      timing: { ...fastTiming, retryBackoffMs: { base: 60_000, max: 60_000 } },
    });
    await tasks.add(newTask());
    const before = Date.now();
    await runUntil(
      tasks,
      async () => {
        throw new Error('later');
      },
      () => tasks.rows[0].attempts === 1 && tasks.rows[0].status === 'pending',
    );
    assert.ok(tasks.rows[0].availableAt >= before + 60_000);
  });

  test('a media without an original is dead on the first failure', async () => {
    const tasks = new MemoryTaskQueue({ timing: fastTiming });
    await tasks.add(newTask());
    const events = await runUntil(
      tasks,
      async () => {
        throw new ResizeNoOriginalError('m1');
      },
      () => tasks.rows[0].status === 'dead',
    );
    assert.equal(tasks.rows[0].attempts, 1);
    assert.deepEqual(
      events.map((e) => e.event),
      ['deadLettered'],
    );
  });

  test('an error with retryable: false is dead on the first failure', async () => {
    const tasks = new MemoryTaskQueue({ timing: fastTiming });
    await tasks.add(newTask());
    const events = await runUntil(
      tasks,
      async () => {
        throw new ResizeMediaError('resize: unusable source', {
          mediaId: 'm1',
          code: 'RESIZE_ANY',
          retryable: false,
        });
      },
      () => tasks.rows[0].status === 'dead',
    );
    assert.equal(tasks.rows[0].attempts, 1);
    assert.deepEqual(
      events.map((e) => e.event),
      ['deadLettered'],
    );
  });

  test('a ResizeError from a duplicate copy of the package with retryable: false is dead on the first failure', async () => {
    const tasks = new MemoryTaskQueue({ timing: fastTiming });
    await tasks.add(newTask());
    const events = await runUntil(
      tasks,
      async () => {
        // Another copy's class, so not `instanceof` this one's ResizeError: only the shared brand.
        throw {
          [Symbol.for('@adaptivestone/framework-module-resize.error')]: true,
          code: 'RESIZE_ANY',
          retryable: false,
          message: 'thrown by a duplicate copy',
        };
      },
      () => tasks.rows[0].status === 'dead',
    );
    assert.equal(tasks.rows[0].status, 'dead');
    assert.equal(tasks.rows[0].attempts, 1);
    assert.deepEqual(
      events.map((e) => e.event),
      ['deadLettered'],
    );
  });

  test('an error from another library with retryable: false is retried', async () => {
    const tasks = new MemoryTaskQueue({
      timing: { ...fastTiming, retryBackoffMs: { base: 60_000, max: 60_000 } },
    });
    await tasks.add(newTask());
    const events = await runUntil(
      tasks,
      async () => {
        // E.g. an AWS SDK v2 error: its own `retryable` field means something else.
        throw Object.assign(new Error('AccessDenied'), {
          code: 'AccessDenied',
          retryable: false,
        });
      },
      () => tasks.rows[0].attempts === 1 && tasks.rows[0].status === 'pending',
    );
    assert.deepEqual(
      events.map((e) => e.event),
      ['failed'],
    );
  });

  test('a plain object with retryable: false and no ResizeError brand is retried', async () => {
    const tasks = new MemoryTaskQueue({
      timing: { ...fastTiming, retryBackoffMs: { base: 60_000, max: 60_000 } },
    });
    await tasks.add(newTask());
    const events = await runUntil(
      tasks,
      async () => {
        throw {
          code: 'RESIZE_ANY',
          retryable: false,
          message: 'fields only',
        };
      },
      () => tasks.rows[0].attempts === 1 && tasks.rows[0].status === 'pending',
    );
    assert.deepEqual(
      events.map((e) => e.event),
      ['failed'],
    );
  });

  test('a formerly terminal code without retryable: false is retried', async () => {
    const tasks = new MemoryTaskQueue({
      timing: { ...fastTiming, retryBackoffMs: { base: 60_000, max: 60_000 } },
    });
    await tasks.add(newTask());
    const events = await runUntil(
      tasks,
      async () => {
        throw new ResizeMediaError('x', { code: 'RESIZE_SOURCE_TOO_LARGE' });
      },
      () => tasks.rows[0].attempts === 1 && tasks.rows[0].status === 'pending',
    );
    assert.equal(tasks.rows[0].attempts, 1);
    assert.equal(tasks.rows[0].status, 'pending');
    assert.deepEqual(
      events.map((e) => e.event),
      ['failed'],
    );
  });

  for (const code of ['RESIZE_WORKER_INCOMPLETE', 'RESIZE_PIPELINE_UNKNOWN']) {
    test(`${code} stays a retryable failure`, async () => {
      const tasks = new MemoryTaskQueue({
        timing: {
          ...fastTiming,
          retryBackoffMs: { base: 60_000, max: 60_000 },
        },
      });
      await tasks.add(newTask());
      const events = await runUntil(
        tasks,
        async () => {
          throw new ResizeError('resize worker: not this time', { code });
        },
        () =>
          tasks.rows[0].attempts === 1 && tasks.rows[0].status === 'pending',
      );
      assert.deepEqual(
        events.map((e) => e.event),
        ['failed'],
      );
    });
  }

  test('a task delivered more than maxAttempts times (crash loop) is dead without running', async () => {
    const tasks = new MemoryTaskQueue({ timing: fastTiming });
    await tasks.add(newTask());
    // Its workers kept dying: three expired leases already.
    Object.assign(tasks.rows[0], {
      status: 'processing',
      attempts: 3,
      token: 'old',
      leaseUntil: Date.now() - 1,
    });
    let ran = false;
    const events = await runUntil(
      tasks,
      async () => {
        ran = true;
      },
      () => tasks.rows[0].status === 'dead',
    );
    assert.equal(ran, false);
    assert.equal(events[0].event, 'deadLettered');
    assert.equal(
      (events[0].error as { code?: string }).code,
      'RESIZE_TASK_MAX_ATTEMPTS',
    );
  });

  test('a hung task times out, its signal aborts, and it is retried', async () => {
    const tasks = new MemoryTaskQueue({
      timing: { ...fastTiming, taskTimeoutMs: 30 },
    });
    await tasks.add(newTask());
    let aborted = false;
    const events = await runUntil(
      tasks,
      (_task, { signal }) =>
        new Promise<void>(() => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
      () =>
        tasks.rows[0].attempts >= 1 && tasks.rows[0].status !== 'processing',
    );
    assert.equal(aborted, true);
    assert.equal(events[0].event, 'failed');
    assert.equal(
      (events[0].error as { code?: string }).code,
      'RESIZE_TASK_TIMEOUT',
    );
  });

  test('a lost lease aborts the running task', async () => {
    const tasks = new MemoryTaskQueue({
      timing: {
        ...fastTiming,
        leaseMs: 20,
      },
    });
    await tasks.add(newTask());
    tasks.renew = async () => false; // another worker took the task
    let aborted = false;
    await runUntil(
      tasks,
      (_task, { signal }) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        }),
      () => aborted,
    );
    assert.equal(aborted, true);
  });

  test('a claim error is logged and the loop keeps going', async () => {
    const tasks = new MemoryTaskQueue({ timing: fastTiming });
    await tasks.add(newTask());
    const errors: unknown[][] = [];
    const realClaim = tasks.claim.bind(tasks);
    let failures = 0;
    tasks.claim = async (...args: Parameters<MemoryTaskQueue['claim']>) => {
      if (failures < 2) {
        failures += 1;
        throw new Error('db blip');
      }
      return realClaim(...args);
    };
    await runUntil(
      tasks,
      async () => {},
      () => tasks.rows[0].status === 'completed',
      { logger: { ...silent, error: (...a: unknown[]) => errors.push(a) } },
    );
    assert.equal(errors.length, 2);
  });

  test('consecutive claim errors back off (doubling, capped) and reset after a successful claim', async () => {
    const tasks = new MemoryTaskQueue({
      timing: { ...fastTiming, idlePollMs: 10 },
    });
    // fail ×5, then empty (success), then fail once more, then empty for good
    const script = ['fail', 'fail', 'fail', 'fail', 'fail', 'empty', 'fail'];
    const starts: number[] = [];
    const ends: number[] = [];
    const errors: string[] = [];
    tasks.claim = async () => {
      starts.push(Date.now());
      const step = script[starts.length - 1] ?? 'empty';
      ends.push(Date.now());
      if (step === 'fail') {
        throw new Error('db down');
      }
      return null;
    };
    await runUntil(
      tasks,
      async () => {},
      () => starts.length >= script.length + 1,
      {
        logger: {
          ...silent,
          error: (msg: unknown) => errors.push(String(msg)),
        },
      },
    );
    // The delays the loop chose: 10, 20, 40, 80, then capped at 10 × idlePollMs = 100 (uncapped it
    // would be 160), and 10 again after the successful (empty) claim. The cap and the reset are read
    // from these, not from the wall clock: a loaded machine runs a timer late, never early.
    assert.deepEqual(
      errors.map((e) =>
        /\((\d+) in a row\) — retrying in (\d+) ms/.exec(e)?.slice(1),
      ),
      [
        ['1', '10'],
        ['2', '20'],
        ['3', '40'],
        ['4', '80'],
        ['5', '100'],
        ['1', '10'],
      ],
    );
    // ...and the loop waited at least that long.
    const waitAfter = (i: number) => starts[i + 1] - ends[i];
    assert.ok(waitAfter(2) >= 38, `third retry waited ${waitAfter(2)} ms`);
    assert.ok(waitAfter(3) >= 78, `fourth retry waited ${waitAfter(3)} ms`);
    assert.ok(waitAfter(4) >= 98, `fifth retry waited ${waitAfter(4)} ms`);
  });

  test('an empty claim that already waited (a long poll) is retried at once; a quick one waits idlePollMs', async () => {
    const idlePollMs = 60;
    for (const [claimWaitMs, expectGap] of [
      [80, 'none'],
      [0, 'idle'],
    ] as const) {
      const tasks = new MemoryTaskQueue({
        timing: { ...fastTiming, idlePollMs },
      });
      const starts: number[] = [];
      const ends: number[] = [];
      tasks.claim = async () => {
        starts.push(Date.now());
        await new Promise((r) => setTimeout(r, claimWaitMs));
        ends.push(Date.now());
        return null;
      };
      await runUntil(
        tasks,
        async () => {},
        () => starts.length >= 3,
      );
      if (expectGap === 'none') {
        const gap = starts[1] - ends[0];
        assert.ok(
          gap < 30,
          `a long poll is not followed by a sleep (${gap} ms)`,
        );
      } else {
        // The loop waits until idlePollMs has passed since the claim STARTED, so measure from
        // there (3 ms covers the clock tick between the loop's claimStarted and starts[0]).
        const idleGap = starts[1] - starts[0];
        assert.ok(
          idleGap >= idlePollMs - 3,
          `a quick empty claim waits idlePollMs (${idleGap} ms)`,
        );
      }
    }
  });

  test('a throwing observer is logged; the task state stands', async () => {
    const tasks = new MemoryTaskQueue({ timing: fastTiming });
    await tasks.add(newTask());
    const errors: unknown[][] = [];
    const stop = new AbortController();
    const loop = consume(tasks, {
      queue: 'default',
      signal: stop.signal,
      handle: async () => {},
      onEvent: () => {
        throw new Error('observer bug');
      },
      logger: { ...silent, error: (...a: unknown[]) => errors.push(a) },
    });
    const until = Date.now() + 5000;
    try {
      while (tasks.rows[0].status !== 'completed') {
        assert.ok(Date.now() < until, 'the task was never completed');
        await new Promise((r) => setTimeout(r, 5));
      }
    } catch (err) {
      stop.abort();
      await loop.catch(() => {});
      throw err;
    }
    stop.abort();
    await loop;
    assert.equal(errors.length, 1);
  });

  test('a lost lease when completing drops the result without an event', async () => {
    const tasks = new MemoryTaskQueue({ timing: fastTiming });
    await tasks.add(newTask());
    tasks.complete = async (_task: ClaimedTask) => false;
    let handled = false;
    const events = await runUntil(
      tasks,
      async () => {
        handled = true;
      },
      () => handled,
    );
    assert.deepEqual(events, []);
  });

  test('only tasks of the consumed queue are claimed', async () => {
    const tasks = new MemoryTaskQueue({ timing: fastTiming });
    await tasks.add(newTask({ queue: 'bulk' }));
    await tasks.add(newTask({ mediaId: 'm2' }));
    const seen: string[] = [];
    await runUntil(
      tasks,
      async (task) => {
        seen.push(task.queue);
      },
      () => tasks.rows[1].status === 'completed',
    );
    assert.deepEqual(seen, ['default']);
    assert.equal(tasks.rows[0].status, 'pending');
  });
});

describe('Consumer shutdown', () => {
  for (const prior of [0, 2]) {
    test(`a shutdown mid-task gives the task back unprocessed (${prior} earlier attempts of 3)`, async () => {
      const tasks = new ReleasingTaskQueue({ timing: fastTiming });
      await tasks.add(newTask());
      tasks.rows[0].attempts = prior;
      const events = await shutDownMidTask(tasks);
      assert.deepEqual(events, []);
      assert.deepEqual(tasks.releaseCalls, ['task-1']);
      assert.equal(tasks.rows[0].status, 'pending');
      assert.equal(tasks.rows[0].attempts, prior);
      assert.ok(tasks.rows[0].availableAt <= Date.now(), 'claimable at once');
      assert.equal(tasks.rows[0].error, undefined);
    });
  }

  test('a non-retryable error during shutdown is still dead-lettered, not given back', async () => {
    const tasks = new ReleasingTaskQueue({ timing: fastTiming });
    await tasks.add(newTask());
    // The shutdown arrives while the handler inspects the source, which then proves unusable.
    const events = await shutDownMidTask(
      tasks,
      (_task, { signal }) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () =>
              reject(
                new ResizeMediaError('resize: unusable source', {
                  code: 'RESIZE_ANY',
                  retryable: false,
                }),
              ),
            { once: true },
          );
        }),
    );
    assert.deepEqual(
      events.map((e) => e.event),
      ['deadLettered'],
    );
    assert.equal(tasks.rows[0].status, 'dead');
    assert.deepEqual(tasks.releaseCalls, []);
  });

  test('an unbranded retryable: false during shutdown is given back like any stopped task', async () => {
    const tasks = new ReleasingTaskQueue({ timing: fastTiming });
    await tasks.add(newTask());
    const events = await shutDownMidTask(
      tasks,
      (_task, { signal }) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject({ code: 'AccessDenied', retryable: false }),
            { once: true },
          );
        }),
    );
    assert.deepEqual(events, []);
    assert.deepEqual(tasks.releaseCalls, ['task-1']);
    assert.equal(tasks.rows[0].status, 'pending');
  });

  test('a queue without release retries the stopped task at once, with no event and never dead', async () => {
    const tasks = new PlainTaskQueue({ timing: fastTiming });
    await tasks.add(newTask());
    tasks.rows[0].attempts = 2; // this delivery is the last one allowed
    const events = await shutDownMidTask(tasks);
    assert.deepEqual(events, []);
    assert.equal(tasks.rows[0].status, 'pending');
    // fail() cannot give the attempt back: the delivery counts.
    assert.equal(tasks.rows[0].attempts, 3);
    assert.ok(tasks.rows[0].availableAt <= Date.now(), 'no backoff');
    assert.match(tasks.rows[0].error ?? '', /shutdown/);
  });

  test('a handler that completes during shutdown is completed normally', async () => {
    const tasks = new ReleasingTaskQueue({ timing: fastTiming });
    await tasks.add(newTask());
    const events = await shutDownMidTask(
      tasks,
      (_task, { signal }) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    );
    assert.deepEqual(
      events.map((e) => e.event),
      ['completed'],
    );
    assert.equal(tasks.rows[0].status, 'completed');
    assert.deepEqual(tasks.releaseCalls, []);
  });

  test('a task claimed while the worker shuts down is given back without running', async () => {
    const tasks = new ReleasingTaskQueue({ timing: fastTiming });
    await tasks.add(newTask());
    const stop = new AbortController();
    const realClaim = tasks.claim.bind(tasks);
    // The claim was already in flight when the shutdown arrived.
    tasks.claim = async (...args: Parameters<MemoryTaskQueue['claim']>) => {
      const task = await realClaim(...args);
      stop.abort();
      return task;
    };
    let ran = false;
    const events: TaskEvent[] = [];
    await consume(tasks, {
      queue: 'default',
      signal: stop.signal,
      handle: async () => {
        ran = true;
      },
      onEvent: (event) => {
        events.push(event);
      },
      logger: silent,
    });
    assert.equal(ran, false);
    assert.deepEqual(events, []);
    assert.equal(tasks.rows[0].status, 'pending');
    assert.equal(tasks.rows[0].attempts, 0);
  });

  test('a task that times out during shutdown still fails as a timeout', async () => {
    const tasks = new ReleasingTaskQueue({
      timing: { ...fastTiming, taskTimeoutMs: 30 },
    });
    await tasks.add(newTask());
    const events = await shutDownMidTask(tasks, () => new Promise(() => {}));
    assert.deepEqual(
      events.map((e) => e.event),
      ['failed'],
    );
    assert.equal(
      (events[0].error as { code?: string }).code,
      'RESIZE_TASK_TIMEOUT',
    );
    assert.deepEqual(tasks.releaseCalls, []);
  });

  test('a task whose lease was lost before the shutdown is neither released nor failed', async () => {
    const tasks = new ReleasingTaskQueue({
      timing: {
        ...fastTiming,
        leaseMs: 20,
      },
    });
    await tasks.add(newTask());
    // Another worker took the task over.
    tasks.renew = async () => {
      tasks.rows[0].token = 'another-worker';
      return false;
    };
    const failCalls: string[] = [];
    const realFail = tasks.fail.bind(tasks);
    tasks.fail = async (...args: Parameters<MemoryTaskQueue['fail']>) => {
      failCalls.push(args[0].taskId);
      return realFail(...args);
    };
    const stop = new AbortController();
    const events: TaskEvent[] = [];
    await consume(tasks, {
      queue: 'default',
      signal: stop.signal,
      handle: (_task, { signal }) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              stop.abort(); // the deploy arrives right after the lease is gone
              reject(new Error('lease lost'));
            },
            { once: true },
          );
        }),
      onEvent: (event) => {
        events.push(event);
      },
      logger: silent,
    });
    // The lease was known to be lost: no terminal call at all, so the new holder keeps it.
    assert.deepEqual(tasks.releaseCalls, []);
    assert.deepEqual(failCalls, []);
    assert.deepEqual(events, []);
    assert.equal(tasks.rows[0].token, 'another-worker');
  });
});

describe('a task the Consumer does not accept', () => {
  /**
   * Run the loop with `accepts` returning false, until the second claim starts. Resolves with the
   * gap between the two claims, the events, the logger's messages and the tasks `accepts` saw.
   */
  async function declineOnce(tasks: MemoryTaskQueue | PlainTaskQueue) {
    const claimedAt: number[] = [];
    const logged: unknown[][] = [];
    const seen: LeasedTask[] = [];
    let handled = 0;
    const stop = new AbortController();
    const realClaim = tasks.claim.bind(tasks);
    tasks.claim = async (...args: Parameters<MemoryTaskQueue['claim']>) => {
      claimedAt.push(Date.now());
      if (claimedAt.length === 2) {
        stop.abort();
        return null;
      }
      return realClaim(...args);
    };
    const events: TaskEvent[] = [];
    const record = (...args: unknown[]) => {
      logged.push(args);
    };
    const timer = setTimeout(() => stop.abort(), 5000);
    try {
      await new Consumer({
        tasks,
        timing: timingOf(tasks, 'default'),
        accepts: (task) => {
          seen.push(task);
          return false;
        },
        handle: async () => {
          handled += 1;
        },
        events: (event) => {
          events.push(event);
        },
        logger: { info: record, warn: record, error: record },
      }).run('default', stop.signal);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(claimedAt.length, 2, 'the loop claimed again');
    assert.equal(handled, 0, 'the handler never ran');
    return { gapMs: claimedAt[1] - claimedAt[0], events, logged, seen };
  }

  const idlePollMs = 40;

  test('is released unprocessed, even past maxAttempts, with no event or log; the next claim waits idlePollMs', async () => {
    const tasks = new ReleasingTaskQueue({
      timing: { ...fastTiming, idlePollMs },
    });
    await tasks.add(newTask());
    // This claim is one more than maxAttempts allows, yet the task is not dead-lettered here.
    tasks.rows[0].attempts = fastTiming.maxAttempts;
    const { gapMs, events, logged, seen } = await declineOnce(tasks);
    assert.deepEqual(tasks.releaseCalls, ['task-1']);
    assert.equal(tasks.rows[0].status, 'pending');
    assert.equal(
      tasks.rows[0].attempts,
      fastTiming.maxAttempts,
      'the delivery is not counted',
    );
    assert.equal(tasks.rows[0].error, undefined);
    assert.deepEqual(events, []);
    assert.deepEqual(logged, []);
    assert.equal(seen.length, 1);
    assert.equal('token' in seen[0], false, 'accepts sees no lease token');
    assert.ok(gapMs >= idlePollMs - 1, `claimed again after ${gapMs} ms`);
  });

  test('on a queue without release it is retried at once through fail: the delivery counts', async () => {
    const tasks = new PlainTaskQueue({
      timing: { ...fastTiming, idlePollMs },
    });
    await tasks.add(newTask());
    tasks.rows[0].attempts = fastTiming.maxAttempts;
    const { gapMs, events } = await declineOnce(tasks);
    assert.equal(tasks.rows[0].status, 'pending', 'never dead-lettered here');
    assert.equal(tasks.rows[0].attempts, fastTiming.maxAttempts + 1);
    assert.ok(tasks.rows[0].availableAt <= Date.now(), 'no backoff');
    assert.match(tasks.rows[0].error ?? '', /does not accept/);
    assert.deepEqual(events, []);
    assert.ok(gapMs >= idlePollMs - 1, `claimed again after ${gapMs} ms`);
  });

  test('a task it accepts runs as usual', async () => {
    const tasks = new ReleasingTaskQueue({ timing: fastTiming });
    await tasks.add(newTask());
    const stop = new AbortController();
    await new Consumer({
      tasks,
      timing: timingOf(tasks, 'default'),
      accepts: () => true,
      handle: async () => {
        stop.abort();
      },
      logger: silent,
    }).run('default', stop.signal);
    assert.equal(tasks.rows[0].status, 'completed');
    assert.deepEqual(tasks.releaseCalls, []);
  });
});

/** A LockStore that records every call and holds nothing. */
function recordingLocks() {
  const calls: string[] = [];
  const locks: LockStore = {
    acquire: async (key) => {
      calls.push(`acquire ${key}`);
      return true;
    },
    extend: async (key) => {
      calls.push(`extend ${key}`);
      return true;
    },
    release: async (key) => {
      calls.push(`release ${key}`);
      return true;
    },
  };
  return { locks, calls };
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the gate lock on a task queue without gatesByTask', () => {
  const gateTiming = {
    ...fastTiming,
    leaseMs: 200,
    idlePollMs: 5,
    retryBackoffMs: { base: 60_000, max: 60_000 },
  };
  const key = gateKey('default', 'default', 'm1', 'default');

  /** A queue (default: a PlainTaskQueue) with one task of owner 'g1', whose gate lock is held for ttlMs. */
  async function gatedTask<Q extends PlainTaskQueue>(
    locks: LockStore,
    tasks: Q = new PlainTaskQueue({ timing: gateTiming }) as Q,
    ttlMs = 50,
  ): Promise<Q> {
    assert.equal(await locks.acquire(key, 'g1', ttlMs), true);
    await tasks.add({ ...newTask(), gateOwner: 'g1' });
    return tasks;
  }

  test('is extended when the task starts and on every heartbeat, and released on completion', async () => {
    const locks = clockLocks();
    const tasks = await gatedTask(locks);
    const left: number[] = [];
    const remaining = () => (locks.entry(key)?.expiresAt ?? 0) - Date.now();
    const events = await runUntil(
      tasks,
      async () => {
        left.push(remaining());
        await sleepMs(250); // past the first lease: only heartbeats keep it
        left.push(remaining());
      },
      () => tasks.rows[0].status === 'completed',
      {
        coordinationOf: () => ({
          cooldownMs: 30_000,
          gateTtlMs: 600_000,
          locks,
        }),
      },
    );
    assert.ok(left[0] > 100, `held for ${left[0]} ms when the task started`);
    assert.ok(left[1] > 0, `held for ${left[1]} ms after 250 ms`);
    assert.equal(locks.entry(key), undefined, 'released on completion');
    assert.deepEqual(
      events.map((e) => e.event),
      ['completed'],
    );
  });

  test('a retry holds it for the backoff plus one lease', async () => {
    const locks = clockLocks();
    // A 1 s lease, so the window below is wide and still tells the lease apart.
    const tasks = await gatedTask(
      locks,
      new PlainTaskQueue({ timing: { ...gateTiming, leaseMs: 1000 } }),
    );
    const events = await runUntil(
      tasks,
      async () => {
        throw new Error('once');
      },
      () => tasks.rows[0].attempts === 1 && tasks.rows[0].status === 'pending',
      {
        coordinationOf: () => ({
          cooldownMs: 30_000,
          gateTtlMs: 600_000,
          locks,
        }),
      },
    );
    assert.deepEqual(
      events.map((e) => e.event),
      ['failed'],
    );
    const left = (locks.entry(key)?.expiresAt ?? 0) - Date.now();
    // More than the 60 s backoff alone, at most the backoff plus the lease.
    assert.ok(left > 60_000 && left <= 61_000, `held for ${left} ms`);
  });

  test("a dead-letter holds it for the Resizer's cooldownMs", async () => {
    const locks = clockLocks();
    const tasks = await gatedTask(locks);
    const events = await runUntil(
      tasks,
      async () => {
        throw new ResizeMediaError('x', { retryable: false });
      },
      () => tasks.rows[0].status === 'dead',
      {
        coordinationOf: () => ({
          cooldownMs: 30_000,
          gateTtlMs: 600_000,
          locks,
        }),
      },
    );
    assert.deepEqual(
      events.map((e) => e.event),
      ['deadLettered'],
    );
    const left = (locks.entry(key)?.expiresAt ?? 0) - Date.now();
    // The cooldown, not the 300 ms a running task holds it for.
    assert.ok(left > 29_000 && left <= 30_000, `held for ${left} ms`);
  });

  test('the cooldown hold is in place before the deadLettered event fires', async () => {
    const locks = clockLocks();
    const tasks = await gatedTask(locks);
    // What the observer sees of the gate lock, read inside the event handler.
    const seen: { event: TaskEvent; owner?: string; left: number }[] = [];
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 5000);
    try {
      await consume(tasks, {
        queue: 'default',
        signal: stop.signal,
        handle: async () => {
          throw new ResizeMediaError('x', { retryable: false });
        },
        onEvent: (event) => {
          const lock = locks.entry(key);
          seen.push({
            event,
            owner: lock?.owner,
            left: (lock?.expiresAt ?? 0) - Date.now(),
          });
          stop.abort();
        },
        coordinationOf: () => ({
          cooldownMs: 30_000,
          gateTtlMs: 600_000,
          locks,
        }),
        logger: silent,
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(seen.length, 1);
    const [{ event, owner, left }] = seen;
    assert.equal(event, 'deadLettered');
    assert.equal(owner, 'g1');
    // The cooldown, not the 200 ms lease the task started with.
    assert.ok(
      left > 29_000 && left <= 30_000,
      `held for ${left} ms when the event fired`,
    );
  });

  test('a lock another request took over after it expired stays theirs', async () => {
    let t = 0;
    const locks = clockLocks(() => t);
    const tasks = new PlainTaskQueue({ timing: gateTiming });
    assert.equal(await locks.acquire(key, 'g1', 10), true);
    await tasks.add({ ...newTask(), gateOwner: 'g1' });
    t = 100; // g1's lock expired, and a new request took the gate
    assert.equal(await locks.acquire(key, 'g2', 10_000), true);
    const events = await runUntil(
      tasks,
      async () => {},
      () => tasks.rows[0].status === 'completed',
      {
        coordinationOf: () => ({
          cooldownMs: 30_000,
          gateTtlMs: 600_000,
          locks,
        }),
      },
    );
    assert.equal(tasks.rows[0].status, 'completed');
    assert.deepEqual(
      events.map((e) => e.event),
      ['completed'],
    );
    assert.deepEqual(locks.entry(key), { owner: 'g2', expiresAt: 10_100 });
  });

  test('a rejecting lock store is logged and never changes the outcome', async () => {
    const locks = clockLocks();
    const tasks = await gatedTask(locks);
    locks.extend = async () => {
      throw new Error('lock store down');
    };
    locks.release = async () => {
      throw new Error('lock store down');
    };
    const errors: unknown[][] = [];
    const events = await runUntil(
      tasks,
      async () => {},
      () => tasks.rows[0].status === 'completed',
      {
        coordinationOf: () => ({
          cooldownMs: 30_000,
          gateTtlMs: 600_000,
          locks,
        }),
        logger: { ...silent, error: (...a: unknown[]) => errors.push(a) },
      },
    );
    assert.equal(tasks.rows[0].status, 'completed');
    assert.deepEqual(
      events.map((e) => e.event),
      ['completed'],
    );
    assert.ok(errors.length > 0, 'the failures are logged');
    for (const [message, err] of errors) {
      assert.match(String(message), /gate/);
      assert.match(String(err), /lock store down/);
    }
  });

  test('a task without gateOwner touches no lock', async () => {
    const { locks, calls } = recordingLocks();
    const tasks = new PlainTaskQueue({ timing: gateTiming });
    await tasks.add(newTask());
    await tasks.add(newTask({ mediaId: 'm2' }));
    const events = await runUntil(
      tasks,
      async (task) => {
        if (task.mediaId === 'm2') {
          throw new ResizeMediaError('x', { retryable: false });
        }
        await sleepMs(150); // past a heartbeat
      },
      () => tasks.rows[1].status === 'dead',
      {
        coordinationOf: () => ({
          cooldownMs: 30_000,
          gateTtlMs: 600_000,
          locks,
        }),
      },
    );
    assert.deepEqual(
      events.map((e) => e.event),
      ['completed', 'deadLettered'],
    );
    assert.deepEqual(calls, []);
  });

  test('a task whose lease was lost leaves it to the new holder after the start', async () => {
    const { locks, calls } = recordingLocks();
    const tasks = new PlainTaskQueue({ timing: gateTiming });
    await tasks.add({ ...newTask(), gateOwner: 'g1' });
    // Another worker took the task over: no heartbeat extends the lock, and fail() is fenced.
    tasks.renew = async () => {
      tasks.rows[0].token = 'another-worker';
      return false;
    };
    let aborted = false;
    const events = await runUntil(
      tasks,
      (_task, { signal }) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('lease lost'));
            },
            { once: true },
          );
        }),
      () => aborted,
      {
        coordinationOf: () => ({
          cooldownMs: 30_000,
          gateTtlMs: 600_000,
          locks,
        }),
      },
    );
    assert.deepEqual(events, []);
    assert.deepEqual(calls, [`extend ${key}`]);
  });

  for (const outcome of ['resolves', 'rejects'] as const) {
    test(`after a known lease loss a handler that ${outcome} leads to no terminal call, no gate call and no event`, async () => {
      const base = clockLocks();
      const lockCalls: string[] = [];
      const locks: LockStore = {
        acquire: (lockKey, owner, ttlMs) => {
          lockCalls.push('acquire');
          return base.acquire(lockKey, owner, ttlMs);
        },
        extend: (lockKey, owner, ttlMs) => {
          lockCalls.push('extend');
          return base.extend(lockKey, owner, ttlMs);
        },
        release: (lockKey, owner) => {
          lockCalls.push('release');
          return base.release(lockKey, owner);
        },
      };
      const tasks = new PlainTaskQueue({ timing: gateTiming });
      assert.equal(await base.acquire(key, 'g1', 60_000), true);
      await tasks.add({ ...newTask(), gateOwner: 'g1' });
      // The renewal says the lease is gone, although the stale lease would still accept a write
      // (as SQS accepts the delete of an old receipt): only the Consumer can hold back.
      tasks.renew = async () => false;
      const terminal: string[] = [];
      for (const op of ['complete', 'fail'] as const) {
        const real = tasks[op].bind(tasks) as (
          ...a: unknown[]
        ) => Promise<boolean>;
        tasks[op] = (async (...args: unknown[]) => {
          terminal.push(op);
          return real(...args);
        }) as never;
      }
      const warned: unknown[][] = [];
      let settled = false;
      let atStart: { owner: string; expiresAt: number } | undefined;
      const events = await runUntil(
        tasks,
        (_task, { signal }) =>
          new Promise<void>((resolve, reject) => {
            atStart = base.entry(key);
            signal.addEventListener(
              'abort',
              () => {
                settled = true;
                if (outcome === 'resolves') {
                  resolve();
                } else {
                  reject(new Error('lease lost'));
                }
              },
              { once: true },
            );
          }),
        () => settled && warned.length > 0,
        {
          coordinationOf: () => ({
            cooldownMs: 30_000,
            gateTtlMs: 600_000,
            locks,
          }),
          logger: { ...silent, warn: (...a: unknown[]) => warned.push(a) },
        },
      );
      const lock = base.entry(key);
      assert.deepEqual(terminal, []);
      assert.deepEqual(lockCalls, ['extend'], 'only the extend at the start');
      assert.equal(lock?.owner, 'g1');
      assert.deepEqual(lock, atStart, 'the gate entry is as the start left it');
      assert.equal(tasks.rows[0].status, 'processing');
      assert.deepEqual(events, []);
      assert.equal(warned.length, 1);
      assert.match(
        String(warned[0][0]),
        /lost its lease — left to its next delivery/,
      );
    });
  }

  test('a task given back at shutdown holds it for gateTtlMs, as a freshly queued task does', async () => {
    const locks = clockLocks();
    const replaced = await gatedTask(
      locks,
      new ReleasingTaskQueue({ timing: gateTiming }),
    );
    const stop = new AbortController();
    await consume(replaced, {
      queue: 'default',
      signal: stop.signal,
      handle: (task, opts) => {
        const stopped = stoppedByShutdown(task, opts);
        stop.abort();
        return stopped;
      },
      logger: silent,
      coordinationOf: () => ({ cooldownMs: 30_000, gateTtlMs: 45_000, locks }),
    });
    assert.deepEqual(replaced.releaseCalls, ['task-1']);
    const lock = locks.entry(key);
    assert.equal(lock?.owner, 'g1');
    const left = (lock?.expiresAt ?? 0) - Date.now();
    // gateTtlMs, not the lease and heartbeat (300 ms) the task started with.
    assert.ok(left > 44_000 && left <= 45_000, `held for ${left} ms`);
  });

  test('a task the worker does not accept holds it for gateTtlMs when it goes back', async () => {
    const locks = clockLocks();
    // No start extend runs for it: the Dispatcher's lock must still be live at the give-back.
    const replaced = await gatedTask(
      locks,
      new ReleasingTaskQueue({ timing: gateTiming }),
      5_000,
    );
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 5000);
    try {
      await new Consumer({
        tasks: replaced,
        timing: timingOf(replaced, 'default'),
        accepts: () => {
          stop.abort();
          return false;
        },
        handle: async () => {},
        coordinationOf: () => ({
          cooldownMs: 30_000,
          gateTtlMs: 45_000,
          locks,
        }),
        logger: silent,
      }).run('default', stop.signal);
    } finally {
      clearTimeout(timer);
    }
    assert.deepEqual(replaced.releaseCalls, ['task-1']);
    const left = (locks.entry(key)?.expiresAt ?? 0) - Date.now();
    assert.ok(left > 44_000 && left <= 45_000, `held for ${left} ms`);
  });

  describe('a gate lock that lapsed is taken back under the task owner', () => {
    // The lock the Dispatcher took expired before the worker got to the task; nobody took it.
    async function lapsed() {
      const clock = { t: 0 };
      const locks = clockLocks(() => clock.t);
      const tasks = new PlainTaskQueue({ timing: gateTiming });
      assert.equal(await locks.acquire(key, 'g1', 10), true);
      await tasks.add({ ...newTask(), gateOwner: 'g1' });
      clock.t = 100;
      return { clock, locks, tasks };
    }
    const coordinationOf = (locks: LockStore) => () => ({
      cooldownMs: 30_000,
      gateTtlMs: 600_000,
      locks,
    });

    test('at task start', async () => {
      const { locks, tasks } = await lapsed();
      let atStart: { owner: string; expiresAt: number } | undefined;
      await runUntil(
        tasks,
        async () => {
          await sleepMs(5); // the start's extend, then its acquire
          atStart = locks.entry(key);
        },
        () => tasks.rows[0].status === 'completed',
        { coordinationOf: coordinationOf(locks) },
      );
      // Taken back for the lease and one heartbeat, then released on completion.
      assert.deepEqual(atStart, { owner: 'g1', expiresAt: 100 + 200 + 100 });
      assert.equal(locks.entry(key), undefined);
    });

    test('for the retry hold', async () => {
      const { clock, locks, tasks } = await lapsed();
      await runUntil(
        tasks,
        async () => {
          clock.t = 10_000; // past what the start took back
          throw new Error('once');
        },
        () =>
          tasks.rows[0].attempts === 1 && tasks.rows[0].status === 'pending',
        { coordinationOf: coordinationOf(locks) },
      );
      const lock = locks.entry(key);
      assert.equal(lock?.owner, 'g1');
      // The 60 s backoff plus one 200 ms lease, from the moved clock.
      const held = (lock?.expiresAt ?? 0) - 10_000;
      assert.ok(held > 60_000 && held <= 60_200, `held for ${held} ms`);
    });

    test('for the cooldown hold after a dead-letter', async () => {
      const { clock, locks, tasks } = await lapsed();
      await runUntil(
        tasks,
        async () => {
          clock.t = 10_000;
          throw new ResizeMediaError('x', { retryable: false });
        },
        () => tasks.rows[0].status === 'dead',
        { coordinationOf: coordinationOf(locks) },
      );
      assert.deepEqual(locks.entry(key), {
        owner: 'g1',
        expiresAt: 10_000 + 30_000,
      });
    });

    test('for the cooldown of a task past maxAttempts', async () => {
      const { locks, tasks } = await lapsed();
      tasks.rows[0].attempts = gateTiming.maxAttempts; // the next claim is one too many
      let handled = 0;
      await runUntil(
        tasks,
        async () => {
          handled += 1;
        },
        () => tasks.rows[0].status === 'dead',
        { coordinationOf: coordinationOf(locks) },
      );
      assert.equal(handled, 0);
      assert.deepEqual(locks.entry(key), {
        owner: 'g1',
        expiresAt: 100 + 30_000,
      });
    });
  });

  test('after a worker crash the redelivery finds its gate still held', async () => {
    // The lease (600 ms) and the gate lock are moved by the same heartbeat tick, every 300 ms.
    const timing = { ...gateTiming, leaseMs: 600 };
    const base = clockLocks();
    const calls: { op: string; held: boolean }[] = [];
    const locks: LockStore = {
      acquire: async (lockKey, owner, ttlMs) => {
        const held = await base.acquire(lockKey, owner, ttlMs);
        calls.push({ op: 'acquire', held });
        return held;
      },
      extend: async (lockKey, owner, ttlMs) => {
        const held = await base.extend(lockKey, owner, ttlMs);
        calls.push({ op: 'extend', held });
        return held;
      },
      release: base.release,
    };
    const tasks = new PlainTaskQueue({ timing });
    // The Dispatcher's lock, short, so the workers' extends decide how long it lasts.
    assert.equal(await base.acquire(key, 'g1', 50), true);
    await tasks.add({ ...newTask(), gateOwner: 'g1' });
    const coordination = { cooldownMs: 30_000, gateTtlMs: 600_000, locks };

    // The first worker claims the task, extends the gate at the start, and dies: its heartbeat
    // never gets an answer again, so neither its lease nor its gate lock is extended.
    const dying: TaskQueue = {
      add: (task) => tasks.add(task),
      claim: (...args) => tasks.claim(...args),
      renew: () => new Promise<boolean>(() => {}),
      complete: (task) => tasks.complete(task),
      fail: (...args) => tasks.fail(...args),
      getTiming: () => timing,
    };
    const crashed = new AbortController();
    let firstStarted = false;
    const first = new Consumer({
      tasks: dying,
      timing: timingOf(tasks, 'default'),
      handle: (_task, { signal }) => {
        firstStarted = true;
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('gone')));
        });
      },
      coordinationOf: () => coordination,
      logger: silent,
    }).run('default', crashed.signal);
    const until = Date.now() + 5000;
    while (!firstStarted) {
      assert.ok(Date.now() < until, 'the first worker never started');
      await sleepMs(2);
    }
    const startCalls = calls.length;

    // Once the lease has ended, the next worker gets the task again.
    let atRedelivery: { live: boolean; owner?: string; taken?: boolean } = {
      live: false,
    };
    try {
      await runUntil(
        tasks,
        async () => {
          const lock = base.entry(key);
          atRedelivery = {
            live: (lock?.expiresAt ?? 0) > Date.now(),
            owner: lock?.owner,
            // Another request trying to queue a task for the media now.
            taken: await base.acquire(key, 'another request', 60_000),
          };
        },
        () => tasks.rows[0].status === 'completed',
        { coordinationOf: () => coordination },
      );
    } finally {
      crashed.abort();
      await first;
    }
    // The dead worker's late shutdown (its handler stopped at last) took nothing back.
    assert.equal(base.entry(key), undefined);
    assert.equal(tasks.rows[0].attempts, 2, 'redelivered once');
    assert.deepEqual(atRedelivery, { live: true, owner: 'g1', taken: false });
    // The redelivery's start extend found the lock still held: nothing had to take it back.
    assert.deepEqual(calls.slice(startCalls, startCalls + 1), [
      { op: 'extend', held: true },
    ]);
    assert.equal(
      calls.some(({ op }) => op === 'acquire'),
      false,
    );
  });

  test('a task given back at shutdown leaves the lock to its next holder once it is back', async () => {
    const { locks, calls } = recordingLocks();
    const tasks = new ReleasingTaskQueue({ timing: gateTiming });
    await tasks.add({ ...newTask(), gateOwner: 'g1' });
    const stop = new AbortController();
    await consume(tasks, {
      queue: 'default',
      signal: stop.signal,
      handle: (task, opts) => {
        const stopped = stoppedByShutdown(task, opts);
        stop.abort();
        return stopped;
      },
      logger: silent,
      coordinationOf: () => ({ cooldownMs: 30_000, gateTtlMs: 600_000, locks }),
    });
    assert.deepEqual(tasks.releaseCalls, ['task-1']);
    // The start extend and the give-back hold, made before the task went back; no release.
    assert.deepEqual(calls, [`extend ${key}`, `extend ${key}`]);
  });

  test('a slow lock store gets one heartbeat extend at a time, and the release follows the task', async () => {
    // Each extend takes longer than a heartbeat (100 ms), and less than the gate bound (200 ms).
    const latencyMs = 150;
    const handlerMs = 600;
    const base = clockLocks();
    const calls: { op: 'extend' | 'release'; at: number }[] = [];
    const slow: LockStore = {
      acquire: base.acquire,
      extend: async (lockKey, owner, ttlMs) => {
        calls.push({ op: 'extend', at: Date.now() });
        const held = await base.extend(lockKey, owner, ttlMs);
        await sleepMs(latencyMs);
        return held;
      },
      release: async (lockKey, owner) => {
        calls.push({ op: 'release', at: Date.now() });
        return base.release(lockKey, owner);
      },
    };
    const tasks = new PlainTaskQueue({
      timing: {
        ...fastTiming,
        leaseMs: 200,
      },
    });
    assert.equal(await slow.acquire(key, 'g1', 1000), true);
    await tasks.add({ ...newTask(), gateOwner: 'g1' });
    let handlerEnded = 0;
    await runUntil(
      tasks,
      async () => {
        await sleepMs(handlerMs);
        handlerEnded = Date.now();
      },
      () => tasks.rows[0].status === 'completed',
      {
        coordinationOf: () => ({
          cooldownMs: 30_000,
          gateTtlMs: 600_000,
          locks: slow,
        }),
      },
    );
    const extendCalls = calls.filter((call) => call.op === 'extend');
    // The extends run one after another and each takes latencyMs, so while the handler runs at
    // most handlerMs / latencyMs of them start after the start extend, and at most one more is
    // pending when it ends: 1 + 600 / 150 = 5 at most. One extend per heartbeat would make about
    // 1 + 600 / 100 = 7.
    assert.ok(
      extendCalls.length >= 2 && extendCalls.length <= 5,
      `${extendCalls.length} extends`,
    );
    const release = calls.find((call) => call.op === 'release');
    assert.ok(release, 'the gate lock is released');
    // The release waits for at most the one pending extend (latencyMs; 350 leaves room for slow
    // timers). A backlog of one extend per heartbeat would delay it by about a second.
    const gapMs = release.at - handlerEnded;
    assert.ok(gapMs < 350, `released ${gapMs} ms after the handler ended`);
    assert.equal(base.entry(key), undefined);
  });
});

describe('a lock store that never answers', () => {
  // The gate bound is min(leaseMs, 30 s): 300 ms here.
  const leaseMs = 300;
  const hangingTiming = {
    ...fastTiming,
    leaseMs,
    retryBackoffMs: { base: 60_000, max: 60_000 },
  };

  /** clockLocks whose extend never settles; acquire and release answer. */
  function hangingExtend() {
    const base = clockLocks();
    let extends_ = 0;
    const locks: LockStore = {
      acquire: base.acquire,
      extend: () => {
        extends_ += 1;
        return new Promise<boolean>(() => {});
      },
      release: base.release,
    };
    return { base, locks, extends: () => extends_ };
  }

  test('each task completes about one bound after its handler, and the loop keeps consuming', async () => {
    const { base, locks, extends: extendCount } = hangingExtend();
    const tasks = new PlainTaskQueue({ timing: hangingTiming });
    for (const [mediaId, owner] of [
      ['m1', 'g1'],
      ['m2', 'g2'],
    ]) {
      const gate = gateKey('default', 'default', mediaId, 'default');
      assert.equal(await base.acquire(gate, owner, 60_000), true);
      await tasks.add({ ...newTask({ mediaId }), gateOwner: owner });
    }
    const handled: Record<string, number> = {};
    const completed: Record<string, number> = {};
    const errors: unknown[][] = [];
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 5000);
    try {
      await consume(tasks, {
        queue: 'default',
        signal: stop.signal,
        handle: async (task) => {
          handled[task.mediaId] = Date.now();
        },
        onEvent: (event, task) => {
          if (event === 'completed') {
            completed[task.mediaId] = Date.now();
          }
          if (Object.keys(completed).length === 2) {
            stop.abort();
          }
        },
        coordinationOf: () => ({
          cooldownMs: 30_000,
          gateTtlMs: 600_000,
          locks,
        }),
        logger: { ...silent, error: (...a: unknown[]) => errors.push(a) },
      });
    } finally {
      clearTimeout(timer);
    }
    assert.deepEqual(
      tasks.rows.map(({ status }) => status),
      ['completed', 'completed'],
    );
    for (const mediaId of ['m1', 'm2']) {
      // The start extend hangs; the end waits for it one bound at most, then releases.
      const waited = completed[mediaId] - handled[mediaId];
      assert.ok(
        waited <= leaseMs + 150,
        `${mediaId} completed ${waited} ms after its handler`,
      );
      assert.equal(
        base.entry(gateKey('default', 'default', mediaId, 'default')),
        undefined,
        'released',
      );
    }
    assert.ok(extendCount() >= 2);
    // The log names the wait that was applied, at most the 300 ms bound.
    const waits = errors.flatMap(([message]) => {
      const found = /timed out: gave up waiting after (\d+) ms/.exec(
        String(message),
      );
      return found ? [Number(found[1])] : [];
    });
    assert.ok(waits.length > 0, 'a timed-out call is logged');
    for (const waited of waits) {
      assert.ok(waited <= leaseMs, `${waited} ms`);
    }
    assert.ok(
      errors.some(([message]) =>
        /extending the gate lock of task task-1 timed out/.test(
          String(message),
        ),
      ),
    );
  });

  test('the task timeout aborts the handler at once, while a gate call hangs', async () => {
    const { locks } = hangingExtend();
    const tasks = new PlainTaskQueue({
      timing: { ...hangingTiming, taskTimeoutMs: 50 },
    });
    await tasks.add({ ...newTask(), gateOwner: 'g1' });
    let startedAt = 0;
    let abortedAt = 0;
    const events = await runUntil(
      tasks,
      (_task, { signal }) =>
        new Promise<void>(() => {
          startedAt = Date.now();
          signal.addEventListener('abort', () => {
            abortedAt = Date.now();
          });
        }),
      () => tasks.rows[0].status === 'pending' && tasks.rows[0].attempts === 1,
      {
        coordinationOf: () => ({
          cooldownMs: 30_000,
          gateTtlMs: 600_000,
          locks,
        }),
      },
    );
    // Aborted at the timeout (50 ms), not after the hanging start extend's bound (300 ms).
    assert.ok(abortedAt > 0, 'the handler was aborted');
    assert.ok(
      abortedAt - startedAt < 250,
      `aborted ${abortedAt - startedAt} ms after the start`,
    );
    assert.deepEqual(
      events.map(({ event, error }) => [
        event,
        (error as { code?: string }).code,
      ]),
      [['failed', 'RESIZE_TASK_TIMEOUT']],
    );
  });

  test('run() resolves within one bound after the shutdown', async () => {
    const { locks } = hangingExtend();
    const tasks = new ReleasingTaskQueue({ timing: hangingTiming });
    await tasks.add({ ...newTask(), gateOwner: 'g1' });
    const stop = new AbortController();
    let stoppedAt = 0;
    const loop = consume(tasks, {
      queue: 'default',
      signal: stop.signal,
      handle: (task, opts) => {
        const stopped = stoppedByShutdown(task, opts);
        // The deploy arrives while the start extend hangs.
        setTimeout(() => {
          stoppedAt = Date.now();
          stop.abort();
        }, 50);
        return stopped;
      },
      coordinationOf: () => ({ cooldownMs: 30_000, gateTtlMs: 600_000, locks }),
      logger: silent,
    });
    const timer = setTimeout(() => stop.abort(), 5000);
    try {
      await loop;
    } finally {
      clearTimeout(timer);
    }
    const tookMs = Date.now() - stoppedAt;
    assert.ok(
      tookMs <= leaseMs + 150,
      `run() resolved ${tookMs} ms after the abort`,
    );
    assert.deepEqual(tasks.releaseCalls, ['task-1']);
  });
});

describe('a late answer never undoes the end of a task', () => {
  // The gate bound is min(leaseMs, 30 s): 200 ms here; the heartbeat runs every 100 ms.
  const lateTiming = {
    ...fastTiming,
    leaseMs: 200,
    retryBackoffMs: { base: 60_000, max: 60_000 },
  };
  const key = gateKey('default', 'default', 'm1', 'default');

  /**
   * clockLocks whose call number `slowCall` (counting extends and acquires together) answers
   * `delayMs` late, and is applied to the lock only then, as a store that is slow to write.
   * `landed` resolves once that call has been applied.
   */
  function slowOnce(slowCall: number, delayMs: number) {
    const base = clockLocks();
    let calls = 0;
    let markLanded!: () => void;
    const landed = new Promise<void>((resolve) => {
      markLanded = resolve;
    });
    const slow =
      <A extends unknown[]>(op: (...args: A) => Promise<boolean>) =>
      async (...args: A) => {
        calls += 1;
        if (calls !== slowCall) {
          return op(...args);
        }
        await sleepMs(delayMs);
        const held = await op(...args);
        markLanded();
        return held;
      };
    const locks: LockStore = {
      acquire: slow(base.acquire),
      extend: slow(base.extend),
      release: base.release,
    };
    return { base, locks, landed };
  }

  test("a dead-letter's cooldown hold survives a heartbeat extend that lands after it", async () => {
    // Call 1 is the start extend; call 2, the first heartbeat's, lands 450 ms late (past the bound).
    const { base, locks, landed } = slowOnce(2, 450);
    const tasks = new PlainTaskQueue({ timing: lateTiming });
    assert.equal(await base.acquire(key, 'g1', 600_000), true);
    await tasks.add({ ...newTask(), gateOwner: 'g1' });
    const events = await runUntil(
      tasks,
      async () => {
        await sleepMs(150); // one heartbeat runs while the task does
        throw new ResizeMediaError('x', { retryable: false });
      },
      () => tasks.rows[0].status === 'dead',
      {
        coordinationOf: () => ({
          cooldownMs: 30_000,
          gateTtlMs: 600_000,
          locks,
        }),
      },
    );
    assert.deepEqual(
      events.map((e) => e.event),
      ['deadLettered'],
    );
    await landed;
    await sleepMs(50); // the cooldown hold, made again after the late extend
    const lock = base.entry(key);
    assert.equal(lock?.owner, 'g1');
    const left = (lock?.expiresAt ?? 0) - Date.now();
    // The cooldown, not the 300 ms the late heartbeat extend set.
    assert.ok(left > 29_000 && left <= 30_000, `held for ${left} ms`);
  });

  test("a completed task's lock stays released when a slow re-take lands after the release", async () => {
    // The Dispatcher's lock lapsed before the task started: the start extend is refused (call 1),
    // and its re-take (call 2) lands 400 ms late, after the completion released the gate.
    const { base, locks, landed } = slowOnce(2, 400);
    const tasks = new PlainTaskQueue({ timing: lateTiming });
    assert.equal(await base.acquire(key, 'g1', 10), true);
    await tasks.add({ ...newTask(), gateOwner: 'g1' });
    await sleepMs(30);
    const events = await runUntil(
      tasks,
      async () => {},
      () => tasks.rows[0].status === 'completed',
      {
        coordinationOf: () => ({
          cooldownMs: 30_000,
          gateTtlMs: 600_000,
          locks,
        }),
      },
    );
    assert.deepEqual(
      events.map((e) => e.event),
      ['completed'],
    );
    await landed;
    await sleepMs(50); // the release, made again after the late re-take
    assert.equal(base.entry(key), undefined, 'the gate stays open');
  });

  /** The timers that keep the process alive now (an unref'd timer is not one of them). */
  const refedTimers = () =>
    process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout')
      .length;

  test('a final action made again does not keep the process alive after run() resolved', async () => {
    const baseline = refedTimers();
    const base = clockLocks();
    let extendCalls = 0;
    let markLanded!: () => void;
    const landed = new Promise<void>((resolve) => {
      markLanded = resolve;
    });
    let markAgain!: () => void;
    const madeAgain = new Promise<void>((resolve) => {
      markAgain = resolve;
    });
    const locks: LockStore = {
      acquire: base.acquire,
      release: base.release,
      extend: async (lockKey, owner, ttlMs) => {
        extendCalls += 1;
        if (extendCalls === 2) {
          // The first heartbeat's extend lands after the cooldown hold.
          await sleepMs(450);
          const held = await base.extend(lockKey, owner, ttlMs);
          markLanded();
          return held;
        }
        if (extendCalls >= 4) {
          // The cooldown hold made again: the store never answers it.
          markAgain();
          return new Promise<boolean>(() => {});
        }
        return base.extend(lockKey, owner, ttlMs);
      },
    };
    const tasks = new PlainTaskQueue({ timing: lateTiming });
    assert.equal(await base.acquire(key, 'g1', 600_000), true);
    await tasks.add({ ...newTask(), gateOwner: 'g1' });
    await runUntil(
      tasks,
      async () => {
        await sleepMs(150);
        throw new ResizeMediaError('x', { retryable: false });
      },
      () => tasks.rows[0].status === 'dead',
      {
        coordinationOf: () => ({
          cooldownMs: 30_000,
          gateTtlMs: 600_000,
          locks,
        }),
      },
    );
    // run() has resolved; the late extend lands, and the hold made again waits for its answer.
    await landed;
    await madeAgain;
    await sleepMs(10);
    assert.equal(
      refedTimers(),
      baseline,
      "only an unref'd timer waits for the answer",
    );
  });

  test('a renewal that never answers uses up the gate bound: it is logged, and the gate calls are not blamed on the lock store', async () => {
    const base = clockLocks();
    let markReleased!: () => void;
    const releaseLanded = new Promise<void>((resolve) => {
      markReleased = resolve;
    });
    let landed = false;
    const locks: LockStore = {
      acquire: base.acquire,
      extend: base.extend,
      release: async (lockKey, owner) => {
        try {
          await sleepMs(20);
          const released = await base.release(lockKey, owner);
          landed = true;
          return released;
        } finally {
          markReleased();
        }
      },
    };
    const tasks = new PlainTaskQueue({ timing: lateTiming });
    assert.equal(await base.acquire(key, 'g1', 600_000), true);
    await tasks.add({ ...newTask(), gateOwner: 'g1' });
    let renewSent!: () => void;
    const sent = new Promise<void>((resolve) => {
      renewSent = resolve;
    });
    tasks.renew = () => {
      renewSent();
      return new Promise<boolean>(() => {});
    };
    const lines: string[] = [];
    const record = (...a: unknown[]) => {
      lines.push(String(a[0]));
    };
    const events = await runUntil(
      tasks,
      async () => {
        await sent;
      },
      () => tasks.rows[0].status === 'completed',
      {
        coordinationOf: () => ({
          cooldownMs: 30_000,
          gateTtlMs: 600_000,
          locks,
        }),
        logger: { info() {}, warn: record, error: record },
      },
    );
    assert.equal(landed, false, 'the worker stopped before the release landed');
    await releaseLanded; // the release lands after the worker stopped waiting for it
    assert.deepEqual(
      events.map((e) => e.event),
      ['completed'],
    );
    assert.ok(
      lines.some((line) =>
        /the lease renewal of task task-1 did not answer within 200 ms — the task ends without its answer; no time left after the lease renewal/.test(
          line,
        ),
      ),
      lines.join('\n'),
    );
    assert.ok(
      lines.some((line) =>
        /releasing the gate lock of task task-1 was sent with no time left to wait for it/.test(
          line,
        ),
      ),
      lines.join('\n'),
    );
    assert.equal(
      lines.some((line) => /gave up waiting after 0 ms/.test(line)),
      false,
    );
    assert.equal(base.entry(key), undefined, 'released all the same');
  });

  test('nothing is made again once a renewal reported the lease lost', async () => {
    const base = clockLocks();
    let extendCalls = 0;
    let markLanded!: () => void;
    const landed = new Promise<void>((resolve) => {
      markLanded = resolve;
    });
    let releases = 0;
    const locks: LockStore = {
      acquire: base.acquire,
      extend: async (lockKey, owner, ttlMs) => {
        extendCalls += 1;
        if (extendCalls === 2) {
          // The first heartbeat's extend lands after the completion's release.
          await sleepMs(600);
          const held = await base.extend(lockKey, owner, ttlMs);
          markLanded();
          return held;
        }
        return base.extend(lockKey, owner, ttlMs);
      },
      release: async (lockKey, owner) => {
        releases += 1;
        return base.release(lockKey, owner);
      },
    };
    const tasks = new PlainTaskQueue({ timing: lateTiming });
    assert.equal(await base.acquire(key, 'g1', 600_000), true);
    await tasks.add({ ...newTask(), gateOwner: 'g1' });
    // The first renewal holds the lease; the second reports it lost, after the task completed.
    let renewCalls = 0;
    tasks.renew = async () => {
      renewCalls += 1;
      if (renewCalls === 1) {
        return true;
      }
      await sleepMs(300);
      return false;
    };
    await runUntil(
      tasks,
      async () => {
        await sleepMs(250);
      },
      () => tasks.rows[0].status === 'completed',
      {
        coordinationOf: () => ({
          cooldownMs: 30_000,
          gateTtlMs: 600_000,
          locks,
        }),
      },
    );
    await landed;
    await sleepMs(50);
    assert.equal(
      releases,
      1,
      'the completion released it; nothing after the loss',
    );
  });

  test('a renewal that reports the lease lost after the handler resolved stops the completion', async () => {
    const base = clockLocks();
    const tasks = new PlainTaskQueue({ timing: lateTiming });
    assert.equal(await base.acquire(key, 'g1', 600_000), true);
    await tasks.add({ ...newTask(), gateOwner: 'g1' });
    // The first renewal is in flight when the handler resolves, and answers 50 ms later.
    let renewSent!: () => void;
    const sent = new Promise<void>((resolve) => {
      renewSent = resolve;
    });
    let answerRenew!: (held: boolean) => void;
    tasks.renew = () => {
      renewSent();
      return new Promise<boolean>((resolve) => {
        answerRenew = resolve;
      });
    };
    const completeCalls: string[] = [];
    const realComplete = tasks.complete.bind(tasks);
    tasks.complete = async (task: ClaimedTask) => {
      completeCalls.push(task.taskId);
      return realComplete(task);
    };
    const warned: unknown[][] = [];
    let atStart: { owner: string; expiresAt: number } | undefined;
    const events = await runUntil(
      tasks,
      async () => {
        atStart = base.entry(key);
        await sent;
        setTimeout(() => answerRenew(false), 50);
      },
      () => warned.length > 0,
      {
        coordinationOf: () => ({
          cooldownMs: 30_000,
          gateTtlMs: 600_000,
          locks: base,
        }),
        logger: { ...silent, warn: (...a: unknown[]) => warned.push(a) },
      },
    );
    assert.deepEqual(completeCalls, []);
    assert.deepEqual(events, []);
    assert.equal(tasks.rows[0].status, 'processing');
    assert.deepEqual(
      base.entry(key),
      atStart,
      'the gate is as the start left it',
    );
    assert.match(
      String(warned[0][0]),
      /lost its lease — left to its next delivery/,
    );
  });
});

describe('the dead-letter cooldown on a task queue with gatesByTask', () => {
  const deadOnce = async () => {
    throw new ResizeMediaError('x', { retryable: false });
  };

  test("fail('dead') receives the Resizer's cooldownMs, and no lock is touched", async () => {
    const { locks, calls } = recordingLocks();
    const tasks = new MemoryTaskQueue({ timing: fastTiming, now: () => 1_000 });
    // Even with a gateOwner: the task row is the gate here.
    await tasks.add({ ...newTask(), gateOwner: 'g1' });
    const events = await runUntil(
      tasks,
      deadOnce,
      () => tasks.rows[0].status === 'dead',
      {
        coordinationOf: () => ({
          cooldownMs: 30_000,
          gateTtlMs: 600_000,
          locks,
        }),
      },
    );
    assert.deepEqual(
      events.map((e) => e.event),
      ['deadLettered'],
    );
    assert.equal(tasks.rows[0].cooldownUntil, 31_000);
    assert.deepEqual(calls, []);
  });

  for (const [label, opts] of [
    ['coordinationOf gives none', { coordinationOf: () => undefined }],
    ['the Consumer has no coordinationOf', {}],
  ] as const) {
    test(`without coordination for the task, a dead-letter gets the default cooldown (${label})`, async () => {
      const tasks = new MemoryTaskQueue({
        timing: fastTiming,
        now: () => 1_000,
      });
      await tasks.add(newTask());
      await runUntil(
        tasks,
        deadOnce,
        () => tasks.rows[0].status === 'dead',
        opts,
      );
      assert.equal((tasks.rows[0].cooldownUntil ?? 0) - 1_000, 600_000);
    });
  }
});

test('claim receives the served Resizer names', async () => {
  const tasks = new MemoryTaskQueue({ timing: fastTiming });
  const seen: (ClaimOptions | undefined)[] = [];
  const stop = new AbortController();
  tasks.claim = async (_queue, _leaseMs, _signal, opts) => {
    seen.push(opts);
    stop.abort();
    return null;
  };
  await new Consumer({
    tasks,
    timing: timingOf(tasks, 'default'),
    resizers: ['a', 'b'],
    handle: async () => {},
    logger: silent,
  }).run('default', stop.signal);
  assert.deepEqual(seen, [{ resizers: ['a', 'b'] }]);
});

test('a throwing logger never stops the loop or fails a task', async (t) => {
  // The fallback writes to the console: keep the test output clean, and count the lines.
  const fallback = t.mock.method(console, 'error', () => {});
  const tasks = new MemoryTaskQueue({ timing: fastTiming });
  await tasks.add(newTask());
  const realClaim = tasks.claim.bind(tasks);
  let claims = 0;
  tasks.claim = async (...args: Parameters<MemoryTaskQueue['claim']>) => {
    claims += 1;
    if (claims === 1) {
      throw new Error('db blip');
    }
    return realClaim(...args);
  };
  const logSinkDown = () => {
    throw new Error('log sink down');
  };
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 5000);
  try {
    await new Consumer({
      tasks,
      timing: timingOf(tasks, 'default'),
      handle: async () => {
        stop.abort();
      },
      events: () => {
        throw new Error('observer bug');
      },
      logger: { info: logSinkDown, warn: logSinkDown, error: logSinkDown },
    }).run('default', stop.signal);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(tasks.rows[0].status, 'completed');
  // The claim failure and the observer failure, each written to the console instead.
  assert.equal(fallback.mock.callCount(), 2);
});

describe('Consumer metrics', () => {
  // The calls of one metric, as [value, labels, context].
  const callsOf = (sink: ReturnType<typeof recordingMetrics>, name: string) =>
    sink.calls
      .filter((call) => call.name === name)
      .map((call) => [call.value, call.labels, call.context] as const);

  test('a claimed task records its wait, and its completion records the run', async () => {
    const tasks = new MemoryTaskQueue({ timing: fastTiming });
    await tasks.add(newTask());
    const rec = recordingMetrics();
    await runUntil(
      tasks,
      async () => {},
      () => tasks.rows[0].status === 'completed',
      { metricsOf: () => rec },
    );
    assert.deepEqual(
      rec.calls.map((call) => [
        call.kind,
        call.name,
        call.labels,
        call.context,
      ]),
      [
        ['timing', 'resize.claim', { queue: 'default' }, { taskId: 'task-1' }],
        [
          'timing',
          'resize.task',
          { queue: 'default', pipeline: 'default', outcome: 'completed' },
          { taskId: 'task-1', mediaId: 'm1', attempts: 1, variants: 1 },
        ],
      ],
    );
    for (const call of rec.calls) {
      assert.ok(Number.isFinite(call.value) && call.value >= 0, call.name);
    }
  });

  test('a retried task records failed with the error code, its last attempt records dead', async () => {
    const timing = {
      ...fastTiming,
      maxAttempts: 2,
      retryBackoffMs: { base: 1, max: 1 },
    };
    const branded = new MemoryTaskQueue({ timing });
    await branded.add(newTask());
    const rec = recordingMetrics();
    await runUntil(
      branded,
      async () => {
        throw new ResizeMediaError('x', {
          code: 'RESIZE_SOURCE_DECODE_FAILED',
        });
      },
      () => branded.rows[0].status === 'dead',
      { metricsOf: () => rec },
    );
    assert.deepEqual(
      callsOf(rec, 'resize.task').map(([, labels, context]) => [
        labels.outcome,
        labels.code,
        context.attempts,
      ]),
      [
        ['failed', 'RESIZE_SOURCE_DECODE_FAILED', 1],
        ['dead', 'RESIZE_SOURCE_DECODE_FAILED', 2],
      ],
    );
    assert.equal(callsOf(rec, 'resize.claim').length, 2);

    // An error without the brand has no code label.
    const plain = new MemoryTaskQueue({ timing });
    await plain.add(newTask());
    const plainRec = recordingMetrics();
    await runUntil(
      plain,
      async () => {
        throw new Error('sharp exploded');
      },
      () => plain.rows[0].status === 'dead',
      { metricsOf: () => plainRec },
    );
    const outcomes = callsOf(plainRec, 'resize.task');
    assert.deepEqual(
      outcomes.map(([, labels]) => labels.outcome),
      ['failed', 'dead'],
    );
    for (const [, labels] of outcomes) {
      assert.equal('code' in labels, false);
    }
  });

  test('a task delivered past maxAttempts records dead, timed from its claim', async () => {
    const tasks = new MemoryTaskQueue({ timing: fastTiming });
    await tasks.add(newTask());
    tasks.rows[0].attempts = 3;
    // The dead-letter call takes a while: the outcome's time includes it.
    const fail = tasks.fail.bind(tasks);
    tasks.fail = async (...args: Parameters<typeof fail>) => {
      await sleepMs(30);
      return fail(...args);
    };
    const rec = recordingMetrics();
    let handled = 0;
    await runUntil(
      tasks,
      async () => {
        handled += 1;
      },
      () => tasks.rows[0].status === 'dead',
      { metricsOf: () => rec },
    );
    assert.equal(handled, 0);
    const outcomes = callsOf(rec, 'resize.task');
    assert.equal(outcomes.length, 1);
    const [ms] = outcomes[0];
    assert.ok(Number.isFinite(ms) && ms >= 25, `recorded ${ms} ms`);
    assert.deepEqual(outcomes, [
      [
        ms,
        {
          queue: 'default',
          pipeline: 'default',
          outcome: 'dead',
          code: 'RESIZE_TASK_MAX_ATTEMPTS',
        },
        { taskId: 'task-1', mediaId: 'm1', attempts: 4, variants: 1 },
      ],
    ]);
  });

  test('a task given back at shutdown records no outcome', async () => {
    const tasks = new ReleasingTaskQueue({ timing: fastTiming });
    await tasks.add(newTask());
    const rec = recordingMetrics();
    const stop = new AbortController();
    let started = false;
    const loop = consume(tasks, {
      queue: 'default',
      signal: stop.signal,
      handle: (task, opts) => {
        started = true;
        return stoppedByShutdown(task, opts);
      },
      logger: silent,
      metricsOf: () => rec,
    });
    const until = Date.now() + 5000;
    while (!started && Date.now() < until) {
      await sleepMs(2);
    }
    stop.abort();
    await loop;
    assert.equal(started, true, 'the handler started');
    assert.deepEqual(tasks.releaseCalls, ['task-1']);
    // The claim is recorded (the sink is wired); the give-back records no outcome.
    assert.deepEqual(
      rec.calls.map((call) => call.name),
      ['resize.claim'],
    );
  });

  test('a failed claim does not restart the wait: it spans the failure and the retry delay', async () => {
    const tasks = new MemoryTaskQueue({
      timing: { ...fastTiming, idlePollMs: 60 },
    });
    await tasks.add(newTask());
    const claim = tasks.claim.bind(tasks);
    let claims = 0;
    tasks.claim = async (...args: Parameters<typeof claim>) => {
      claims += 1;
      if (claims === 1) {
        throw new Error('database down');
      }
      return claim(...args);
    };
    const rec = recordingMetrics();
    await runUntil(
      tasks,
      async () => {},
      () => tasks.rows[0].status === 'completed',
      { metricsOf: () => rec },
    );
    const [claimed] = callsOf(rec, 'resize.claim');
    assert.ok(claimed, 'the claim is recorded');
    assert.ok(claimed[0] >= 50, `waited ${claimed[0]} ms`);
  });

  test('a claim records the wait since the previous task ended, across empty polls', async () => {
    const tasks = new MemoryTaskQueue({ timing: fastTiming });
    const rec = recordingMetrics();
    const stop = new AbortController();
    const loop = consume(tasks, {
      queue: 'default',
      signal: stop.signal,
      handle: async () => {},
      logger: silent,
      metricsOf: () => rec,
    });
    await sleepMs(60); // several empty polls
    await tasks.add(newTask());
    const until = Date.now() + 5000;
    while (tasks.rows[0].status !== 'completed' && Date.now() < until) {
      await sleepMs(2);
    }
    stop.abort();
    await loop;
    const [claim] = callsOf(rec, 'resize.claim');
    assert.ok(claim, 'the claim is recorded');
    assert.ok(claim[0] >= 50, `waited ${claim[0]} ms`);
  });
});

describe('backoffMs', () => {
  test('backoff doubles per attempt up to the maximum', () => {
    const timing = timingOf(
      new MemoryTaskQueue({
        timing: { retryBackoffMs: { base: 100, max: 350 } },
      }),
      'default',
    );
    assert.deepEqual(
      [1, 2, 3, 4].map((n) => backoffMs(n, timing)),
      [100, 200, 350, 350],
    );
  });
});
