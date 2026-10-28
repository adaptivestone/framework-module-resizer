// A task queue's timing: its own keys over the defaults, validated and read once per queue
// instance. Lock TTLs are not timing: they moved to the Resizer's coordination.
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

  test("lockTtlMs in a task queue's timing is RESIZE_CONFIG_REMOVED_KEY, pointing to coordination", () => {
    // Built outside assert.throws: the queue takes any timing, the core rejects it when it reads it.
    const tasks = new MemoryTaskQueue({
      timing: { lockTtlMs: { failed: 1 } } as never,
    });
    assert.throws(
      () => timingOf(tasks),
      (err: unknown) =>
        err instanceof ResizeConfigError &&
        err.code === 'RESIZE_CONFIG_REMOVED_KEY' &&
        /`lockTtlMs`/.test(err.message) &&
        /coordination/.test(err.message) &&
        /lockTtlMs\.failed → cooldownMs/.test(err.message) &&
        /lockTtlMs\.dispatch → gateTtlMs/.test(err.message) &&
        /drop lockTtlMs\.worker/.test(err.message),
    );
  });

  test('the filled timing has no lock TTLs', () => {
    assert.deepEqual(Object.keys(timingOf(new MemoryTaskQueue())).sort(), [
      'idlePollMs',
      'leaseMs',
      'maxAttempts',
      'retryBackoffMs',
      'taskTimeoutMs',
    ]);
  });

  test('invalid timing is a config error naming the key', () => {
    const tasks = new MemoryTaskQueue({ timing: { leaseMs: 0 } });
    assert.throws(
      () => timingOf(tasks),
      (err: unknown) =>
        err instanceof ResizeConfigError &&
        err.code === 'RESIZE_CONFIG_QUEUE_LEASE_INVALID' &&
        /leaseMs/.test(err.message),
    );
  });
});
