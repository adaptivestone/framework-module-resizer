// The core queue loop (consumeQueue) against the in-memory TaskQueue: the same lifecycle every
// backend gets — completion, retry with backoff, dead-lettering, terminal errors, crash loops,
// timeouts, lost leases and resilient claiming.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  ClaimedTask,
  LeasedTask,
  NewTask,
  TaskEvent,
} from './contracts/taskQueue.ts';
import { ResizeConfigError, ResizeNoOriginalError } from './errors.ts';
import { backoffMs, consumeQueue, timingOf } from './queue.ts';
import { MemoryTaskQueue } from './testHelpers/fakes.ts';

const silent = { info() {}, warn() {}, error() {} };

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
