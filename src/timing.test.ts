// A task queue's timing: its own keys over the defaults, the default dead-letter cooldown, and
// validation, read once per queue instance.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ResizeConfigError } from './errors.ts';
import { MemoryTaskQueue } from './testHelpers/fakes.ts';
import { timingOf } from './timing.ts';

describe('timingOf', () => {
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

  test('the dead-letter cooldown lockTtlMs.failed defaults to 10 minutes, also beside set lock TTLs', () => {
    assert.equal(timingOf(new MemoryTaskQueue()).lockTtlMs.failed, 600_000);
    const own = timingOf(
      new MemoryTaskQueue({
        timing: { lockTtlMs: { dispatch: 1000, worker: 1000 } },
      }),
    );
    assert.deepEqual(own.lockTtlMs, {
      dispatch: 1000,
      worker: 1000,
      failed: 600_000,
    });
    const set = timingOf(
      new MemoryTaskQueue({
        timing: { lockTtlMs: { dispatch: 1000, worker: 1000, failed: 5000 } },
      }),
    );
    assert.equal(set.lockTtlMs.failed, 5000);
  });

  for (const failed of [0, -1, 1.5, '600000', null]) {
    test(`lockTtlMs.failed ${JSON.stringify(failed)} is a config error`, () => {
      const tasks = new MemoryTaskQueue({
        timing: {
          lockTtlMs: { dispatch: 1000, worker: 1000, failed } as never,
        },
      });
      assert.throws(
        () => timingOf(tasks),
        (err: unknown) =>
          err instanceof ResizeConfigError &&
          err.code === 'RESIZE_CONFIG_QUEUE_LOCK_TTL_INVALID' &&
          /lockTtlMs\.failed/.test(err.message),
      );
    });
  }

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
});
