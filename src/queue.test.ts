// The core queue loop (consumeQueue) against the in-memory TaskQueue: the same lifecycle every
// backend gets — completion, retry with backoff, dead-lettering, terminal errors, crash loops,
// timeouts, lost leases, graceful shutdown and resilient claiming.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  ClaimedTask,
  LeasedTask,
  NewTask,
  TaskEvent,
} from './contracts/taskQueue.ts';
import {
  ResizeConfigError,
  ResizeError,
  ResizeGenerateError,
  ResizeMediaError,
  ResizeNoOriginalError,
} from './errors.ts';
import { backoffMs, consumeQueue, timingOf } from './queue.ts';
import { MemoryTaskQueue } from './testHelpers/fakes.ts';

const silent = { info() {}, warn() {}, error() {} };

/** The in-memory queue with `release`: the task is due at once and the delivery is not counted. */
class ReleasingTaskQueue extends MemoryTaskQueue {
  readonly releaseCalls: string[] = [];

  async release(task: ClaimedTask): Promise<boolean> {
    this.releaseCalls.push(task.taskId);
    const row = this.rows.find(
      (r) =>
        r.id === task.taskId &&
        r.status === 'processing' &&
        r.token === task.token,
    );
    if (!row) {
      return false;
    }
    row.status = 'pending';
    row.token = null;
    row.availableAt = 0;
    row.attempts -= 1;
    return true;
  }
}

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
  tasks: MemoryTaskQueue,
  handle: (
    task: LeasedTask,
    opts: { signal: AbortSignal },
  ) => Promise<void> = stoppedByShutdown,
) {
  const events: { event: TaskEvent; task: LeasedTask; error?: unknown }[] = [];
  const stop = new AbortController();
  let started = false;
  const loop = consumeQueue(tasks, {
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
  while (!started) {
    assert.ok(Date.now() < until, 'the handler never started');
    await new Promise((r) => setTimeout(r, 2));
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
  const loop = consumeQueue(tasks, {
    queue: 'default',
    signal: stop.signal,
    handle,
    onEvent: (event, task, error) => {
      events.push({ event, task, error });
    },
    logger,
  });
  const until = Date.now() + 5000;
  while (!done()) {
    assert.ok(
      Date.now() < until,
      'the queue loop did not reach the expected state',
    );
    await new Promise((r) => setTimeout(r, 5));
  }
  stop.abort();
  await loop;
  return events;
}

describe('consumeQueue', () => {
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
    assert.equal('attempts' in handled[0], false);
    assert.deepEqual(
      events.map((e) => e.event),
      ['completed'],
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

  for (const code of [
    'RESIZE_SOURCE_TOO_LARGE',
    'RESIZE_SOURCE_METADATA_MISSING',
  ]) {
    test(`an unusable source (${code}) is dead on the first failure`, async () => {
      const tasks = new MemoryTaskQueue({ timing: fastTiming });
      await tasks.add(newTask());
      const events = await runUntil(
        tasks,
        async () => {
          throw new ResizeMediaError('resize: unusable source', {
            mediaId: 'm1',
            code,
          });
        },
        () => tasks.rows[0].status === 'dead',
      );
      assert.equal(tasks.rows[0].attempts, 1);
      assert.deepEqual(
        events.map((e) => e.event),
        ['deadLettered'],
      );
      assert.equal((events[0].error as { code?: string }).code, code);
    });
  }

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
    const waitAfter = (i: number) => starts[i + 1] - ends[i];
    // 10, 20, 40, 80, then capped at 10 × idlePollMs = 100
    assert.ok(waitAfter(2) >= 38, `third retry waited ${waitAfter(2)} ms`);
    assert.ok(waitAfter(3) >= 78, `fourth retry waited ${waitAfter(3)} ms`);
    assert.ok(waitAfter(4) >= 98, `fifth retry waited ${waitAfter(4)} ms`);
    assert.ok(waitAfter(4) < 160, `the backoff is capped (${waitAfter(4)} ms)`);
    // After the successful (empty) claim the next failure starts again from idlePollMs.
    assert.ok(
      waitAfter(6) < 60,
      `reset after success: waited ${waitAfter(6)} ms`,
    );
    assert.match(errors[0], /failed \(1 in a row\) — retrying in 10 ms/);
    assert.match(errors[4], /failed \(5 in a row\) — retrying in 100 ms/);
    assert.match(errors[5], /failed \(1 in a row\)/);
  });

  test('an empty claim that already waited (a long poll) is retried at once; a quick one waits idlePollMs', async () => {
    for (const [claimWaitMs, expectGap] of [
      [80, 'none'],
      [0, 'idle'],
    ] as const) {
      const tasks = new MemoryTaskQueue({
        timing: { ...fastTiming, idlePollMs: 60 },
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
      const gap = starts[1] - ends[0];
      if (expectGap === 'none') {
        assert.ok(
          gap < 30,
          `a long poll is not followed by a sleep (${gap} ms)`,
        );
      } else {
        assert.ok(
          gap >= 55,
          `a quick empty claim waits idlePollMs (${gap} ms)`,
        );
      }
    }
  });

  test('a throwing observer is logged; the task state stands', async () => {
    const tasks = new MemoryTaskQueue({ timing: fastTiming });
    await tasks.add(newTask());
    const errors: unknown[][] = [];
    const stop = new AbortController();
    const loop = consumeQueue(tasks, {
      queue: 'default',
      signal: stop.signal,
      handle: async () => {},
      onEvent: () => {
        throw new Error('observer bug');
      },
      logger: { ...silent, error: (...a: unknown[]) => errors.push(a) },
    });
    while (tasks.rows[0].status !== 'completed') {
      await new Promise((r) => setTimeout(r, 5));
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
    await tasks.add(newTask({ requestKey: 'd' }));
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

describe('consumeQueue shutdown', () => {
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

  for (const code of [
    'RESIZE_NO_ORIGINAL',
    'RESIZE_SOURCE_METADATA_MISSING',
    'RESIZE_SOURCE_TOO_LARGE',
  ]) {
    test(`a terminal error (${code}) during shutdown is still dead-lettered, not given back`, async () => {
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
                    mediaId: 'm1',
                    code,
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
      assert.equal((events[0].error as { code?: string }).code, code);
      assert.equal(tasks.rows[0].status, 'dead');
      assert.deepEqual(tasks.releaseCalls, []);
    });
  }

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
    await consumeQueue(tasks, {
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
    await consumeQueue(tasks, {
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

describe('timingOf / backoffMs', () => {
  test('fills defaults, keeps set values, and is read once per queue', () => {
    let reads = 0;
    const tasks = new MemoryTaskQueue();
    tasks.getTiming = () => {
      reads += 1;
      return { leaseMs: 120_000, maxAttempts: undefined };
    };
    const timing = timingOf(tasks);
    assert.equal(timing.leaseMs, 120_000);
    assert.equal(timing.maxAttempts, 5);
    timingOf(tasks);
    assert.equal(reads, 1);
  });

  test('invalid timing is a config error (worker lock must fit the lease)', () => {
    const tasks = new MemoryTaskQueue({
      timing: { leaseMs: 1000, lockTtlMs: { dispatch: 1000, worker: 5000 } },
    });
    assert.throws(
      () => timingOf(tasks),
      (err: unknown) =>
        err instanceof ResizeConfigError &&
        err.code === 'RESIZE_CONFIG_LOCK_EXCEEDS_LEASE',
    );
  });

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
