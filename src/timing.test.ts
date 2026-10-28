// A queue name's timing on a task queue: its own keys over the defaults, validated and read once
// per task queue and name. Lock TTLs are not timing: they moved to the Resizer's coordination.
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
    const timing = timingOf(tasks, 'default');
    assert.equal(timing.leaseMs, 120_000);
    assert.equal(timing.maxAttempts, 5);
    timingOf(tasks, 'default');
    assert.equal(reads, 1);
  });

  test("lockTtlMs in a task queue's timing is RESIZE_CONFIG_REMOVED_KEY, pointing to coordination", () => {
    // Built outside assert.throws: the queue takes any timing, the core rejects it when it reads it.
    const tasks = new MemoryTaskQueue({
      timing: { lockTtlMs: { failed: 1 } } as never,
    });
    assert.throws(
      () => timingOf(tasks, 'default'),
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
    assert.deepEqual(
      Object.keys(timingOf(new MemoryTaskQueue(), 'default')).sort(),
      [
        'idlePollMs',
        'leaseMs',
        'maxAttempts',
        'retryBackoffMs',
        'taskTimeoutMs',
      ],
    );
  });

  test('invalid timing is a config error naming the key and the queue', () => {
    const tasks = new MemoryTaskQueue({ timing: { leaseMs: 0 } });
    assert.throws(
      () => timingOf(tasks, 'default'),
      (err: unknown) =>
        err instanceof ResizeConfigError &&
        err.code === 'RESIZE_CONFIG_QUEUE_LEASE_INVALID' &&
        /leaseMs/.test(err.message) &&
        /'default'/.test(err.message),
    );
  });

  test('timingOf reads each queue name once and keeps the names apart', () => {
    const reads: string[] = [];
    const tasks = new MemoryTaskQueue();
    tasks.getTiming = (queue) => {
      reads.push(queue);
      return queue === 'bulk' ? { leaseMs: 30_000 } : {};
    };
    assert.equal(timingOf(tasks, 'bulk').leaseMs, 30_000);
    assert.equal(timingOf(tasks, 'default').leaseMs, 60_000);
    assert.equal(timingOf(tasks, 'bulk').leaseMs, 30_000);
    assert.deepEqual(
      reads,
      ['bulk', 'default'],
      'a second bulk read asks nothing',
    );
  });

  test("one name's invalid timing throws for that name only", () => {
    const reads: string[] = [];
    const tasks = new MemoryTaskQueue();
    tasks.getTiming = (queue) => {
      reads.push(queue);
      return queue === 'bad' ? { leaseMs: 0 } : {};
    };
    const invalidBad = (err: unknown) =>
      err instanceof ResizeConfigError &&
      err.code === 'RESIZE_CONFIG_QUEUE_LEASE_INVALID' &&
      /leaseMs/.test(err.message) &&
      /'bad'/.test(err.message);
    assert.throws(() => timingOf(tasks, 'bad'), invalidBad);
    assert.throws(() => timingOf(tasks, 'bad'), invalidBad);
    assert.deepEqual(reads, ['bad', 'bad'], 'an invalid timing is not cached');
    assert.equal(timingOf(tasks, 'default').leaseMs, 60_000);
  });

  test('a getTiming that ignores the name gives every name the same timing', () => {
    const tasks = new MemoryTaskQueue();
    // The shape of a queue with one timing, as the framework adapter's is.
    tasks.getTiming = () => ({ leaseMs: 45_000 });
    assert.equal(timingOf(tasks, 'default').leaseMs, 45_000);
    assert.deepEqual(timingOf(tasks, 'bulk'), timingOf(tasks, 'default'));
  });
});
