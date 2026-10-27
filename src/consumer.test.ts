// The worker loop (Consumer) against the in-memory TaskQueue: the same lifecycle every backend
// gets — completion, retry with backoff, dead-lettering, non-retryable errors, crash loops,
// timeouts, lost leases, graceful shutdown and resilient claiming.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { backoffMs, Consumer } from './consumer.ts';
import type {
  ClaimedTask,
  LeasedTask,
  NewTask,
  TaskEvent,
} from './contracts/taskQueue.ts';
import {
  ResizeError,
  ResizeGenerateError,
  ResizeMediaError,
  ResizeNoOriginalError,
} from './errors.ts';
import { consume } from './testHelpers/consume.ts';
import {
  MemoryTaskQueue,
  type PlainTaskQueue,
  ReleasingTaskQueue,
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
  requestKey: 'k1',
  ...over,
});

const fastTiming = {
  leaseMs: 200,
  lockTtlMs: { dispatch: 1000, worker: 200 },
  idlePollMs: 5,
  taskTimeoutMs: 2000,
  retryBackoffMs: { base: 10, max: 40 },
  maxAttempts: 3,
};

/** Run the loop until `done()` (or 5 s), then stop it and wait for it to return. */
async function runUntil(
  tasks: MemoryTaskQueue,
  handle: (task: LeasedTask, opts: { signal: AbortSignal }) => Promise<void>,
  done: () => boolean,
  logger: { info(): void; warn(): void; error(...a: unknown[]): void } = silent,
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
    logger,
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
      timing: timingOf(tasks),
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
        lockTtlMs: { dispatch: 1000, worker: 20 },
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
      { ...silent, error: (...a: unknown[]) => errors.push(a) },
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
      { ...silent, error: (msg: unknown) => errors.push(String(msg)) },
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
    await tasks.add(newTask({ queue: 'bulk', requestKey: 'b' }));
    await tasks.add(newTask({ mediaId: 'm2', requestKey: 'd' }));
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
    const tasks = new MemoryTaskQueue({ timing: fastTiming });
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

  test('a task whose lease was lost before the shutdown is not released', async () => {
    const tasks = new ReleasingTaskQueue({
      timing: {
        ...fastTiming,
        leaseMs: 20,
        lockTtlMs: { dispatch: 1000, worker: 20 },
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
    assert.deepEqual(tasks.releaseCalls, []);
    assert.deepEqual(failCalls, ['task-1']); // fenced: the new holder keeps it
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
        timing: timingOf(tasks),
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
    const tasks = new MemoryTaskQueue({
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
      timing: timingOf(tasks),
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

describe('backoffMs', () => {
  test('backoff doubles per attempt up to the maximum', () => {
    const timing = timingOf(
      new MemoryTaskQueue({
        timing: { retryBackoffMs: { base: 100, max: 350 } },
      }),
    );
    assert.deepEqual(
      [1, 2, 3, 4].map((n) => backoffMs(n, timing)),
      [100, 200, 350, 350],
    );
  });
});
