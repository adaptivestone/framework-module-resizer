// A Resizer's coordination policy: its own values over the defaults, each a positive safe integer,
// and a gate that lasts at least one lease of its task queue.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultCoordination } from './config/resize.ts';
import { fillCoordination } from './coordination.ts';
import { ResizeConfigError } from './errors.ts';
import { MemoryTaskQueue } from './testHelpers/fakes.ts';
import { timingOf } from './timing.ts';

const timing = timingOf(new MemoryTaskQueue()); // leaseMs 60 000

const invalidCoordination = (pattern: RegExp) => (err: unknown) =>
  err instanceof ResizeConfigError &&
  err.code === 'RESIZE_CONFIG_COORDINATION_INVALID' &&
  pattern.test(err.message);

test('fills the defaults and keeps the values that are set', () => {
  assert.deepEqual(fillCoordination(undefined, timing), defaultCoordination);
  assert.deepEqual(fillCoordination({}, timing), defaultCoordination);
  assert.deepEqual(fillCoordination({ cooldownMs: 5 }, timing), {
    gateTtlMs: 600_000,
    cooldownMs: 5,
  });
  assert.deepEqual(
    fillCoordination({ gateTtlMs: 90_000, cooldownMs: 30_000 }, timing),
    { gateTtlMs: 90_000, cooldownMs: 30_000 },
  );
});

test('a value that is not a positive safe integer is RESIZE_CONFIG_COORDINATION_INVALID, naming the key', () => {
  for (const key of ['gateTtlMs', 'cooldownMs']) {
    for (const value of [0, -1, 1.5, '600000', null]) {
      assert.throws(
        () => fillCoordination({ [key]: value }, timing),
        invalidCoordination(new RegExp(`${key} must be .*, got `)),
        `${key}: ${JSON.stringify(value)}`,
      );
    }
  }
  assert.throws(
    () => fillCoordination({ gateTtlMs: 0 }, timing),
    invalidCoordination(
      /^resize coordination: gateTtlMs must be a positive safe integer \(ms\), got 0$/,
    ),
  );
  for (const section of ['x', null, [], 600_000]) {
    assert.throws(
      () => fillCoordination(section, timing),
      invalidCoordination(/coordination must be an object/),
      JSON.stringify(section),
    );
  }
});

test('gateTtlMs below the lease is RESIZE_CONFIG_GATE_TTL_BELOW_LEASE; equal to it is fine', () => {
  const long = timingOf(new MemoryTaskQueue({ timing: { leaseMs: 120_000 } }));
  assert.throws(
    () => fillCoordination({ gateTtlMs: 60_000 }, long),
    (err: unknown) =>
      err instanceof ResizeConfigError &&
      err.code === 'RESIZE_CONFIG_GATE_TTL_BELOW_LEASE' &&
      /60000/.test(err.message) &&
      /120000/.test(err.message),
  );
  assert.deepEqual(fillCoordination({ gateTtlMs: 120_000 }, long), {
    gateTtlMs: 120_000,
    cooldownMs: 600_000,
  });
});
