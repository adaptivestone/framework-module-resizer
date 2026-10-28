// A Resizer's coordination policy: its own values over the defaults, each a positive safe integer.
// No value depends on the task queue's lease: the worker extends a running task's gate per lease.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultCoordination } from './config/resize.ts';
import { fillCoordination } from './coordination.ts';
import { ResizeConfigError } from './errors.ts';

const invalidCoordination = (pattern: RegExp) => (err: unknown) =>
  err instanceof ResizeConfigError &&
  err.code === 'RESIZE_CONFIG_COORDINATION_INVALID' &&
  pattern.test(err.message);

test('fills the defaults and keeps the values that are set', () => {
  assert.deepEqual(fillCoordination(undefined), defaultCoordination);
  assert.deepEqual(fillCoordination({}), defaultCoordination);
  assert.deepEqual(fillCoordination({ cooldownMs: 5 }), {
    gateTtlMs: 600_000,
    cooldownMs: 5,
  });
  assert.deepEqual(
    fillCoordination({ gateTtlMs: 90_000, cooldownMs: 30_000 }),
    { gateTtlMs: 90_000, cooldownMs: 30_000 },
  );
});

test('a value that is not a positive safe integer is RESIZE_CONFIG_COORDINATION_INVALID, naming the key', () => {
  for (const key of ['gateTtlMs', 'cooldownMs']) {
    for (const value of [0, -1, 1.5, '600000', null]) {
      assert.throws(
        () => fillCoordination({ [key]: value }),
        invalidCoordination(new RegExp(`${key} must be .*, got `)),
        `${key}: ${JSON.stringify(value)}`,
      );
    }
  }
  assert.throws(
    () => fillCoordination({ gateTtlMs: 0 }),
    invalidCoordination(
      /^resize coordination: gateTtlMs must be a positive safe integer \(ms\), got 0$/,
    ),
  );
  for (const section of ['x', null, [], 600_000]) {
    assert.throws(
      () => fillCoordination(section),
      invalidCoordination(/coordination must be an object/),
      JSON.stringify(section),
    );
  }
});

test('gateTtlMs below the lease is fine: a running task is held per lease by the worker', () => {
  assert.deepEqual(fillCoordination({ gateTtlMs: 1_000 }), {
    gateTtlMs: 1_000,
    cooldownMs: 600_000,
  });
});
