// Direct unit coverage for the four INTERNAL generic helpers. Behavior these express is also
// exercised through images/engine/resizeTask/mongo tests; here we pin the utilities themselves
// (guards edge cases, hex shape, abortable sleep, bounded pool + abort) at their new location.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { runBounded } from './concurrency.ts';
import { isPositiveFinite } from './guards.ts';
import { randomHex } from './random.ts';
import { sleep } from './sleep.ts';

describe('isPositiveFinite', () => {
  test('true only for finite numbers > 0', () => {
    assert.equal(isPositiveFinite(1), true);
    assert.equal(isPositiveFinite(0.5), true);
    assert.equal(isPositiveFinite(1e9), true);
  });

  test('false for zero, negative, NaN, Infinity and undefined', () => {
    assert.equal(isPositiveFinite(0), false);
    assert.equal(isPositiveFinite(-1), false);
    assert.equal(isPositiveFinite(Number.NaN), false);
    assert.equal(isPositiveFinite(Number.POSITIVE_INFINITY), false);
    assert.equal(isPositiveFinite(Number.NEGATIVE_INFINITY), false);
    assert.equal(isPositiveFinite(undefined), false);
  });
});

describe('randomHex', () => {
  test('default is 16 bytes → 32 lowercase hex chars', () => {
    const s = randomHex();
    assert.equal(s.length, 32);
    assert.match(s, /^[0-9a-f]+$/);
  });

  test('honours the byte count (2 hex chars per byte)', () => {
    assert.equal(randomHex(8).length, 16);
    assert.equal(randomHex(1).length, 2);
    assert.equal(randomHex(0).length, 0);
  });

  test('successive calls differ (uniqueness smoke)', () => {
    const seen = new Set(Array.from({ length: 100 }, () => randomHex()));
    assert.equal(seen.size, 100);
  });
});

describe('sleep', () => {
  test('resolves on timeout', async () => {
    const start = Date.now();
    await sleep(20, new AbortController().signal);
    assert.ok(Date.now() - start >= 15);
  });

  test('resolves immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    await sleep(10_000, controller.signal);
    assert.ok(Date.now() - start < 100); // did not wait the full 10s
  });

  test('resolves early when aborted mid-sleep', async () => {
    const controller = new AbortController();
    const start = Date.now();
    const p = sleep(10_000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await p;
    assert.ok(Date.now() - start < 100);
  });

  // The wrapper swallows ONLY the AbortError and re-throws anything else. That re-throw path is not
  // cleanly reachable: node:timers/promises rejects exclusively with an AbortError (even a custom
  // controller.abort(reason) still surfaces as name 'AbortError' / code 'ABORT_ERR', verified on
  // Node 26), so forcing a non-abort rejection needs experimental module mocking. Skipped, not
  // silently dropped.
  test.skip(
    're-throws non-AbortError rejections (only reachable by mocking node:timers/promises)',
  );
});

describe('runBounded', () => {
  test('never exceeds the concurrency bound and runs every item', async () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7];
    const done: number[] = [];
    let inFlight = 0;
    let peak = 0;
    await runBounded(items, 3, undefined, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(5, new AbortController().signal);
      done.push(n);
      inFlight -= 1;
    });
    assert.equal(peak, 3);
    assert.deepEqual(
      done.sort((a, b) => a - b),
      items,
    );
  });

  test('concurrency is clamped to at least 1 even for an empty bound', async () => {
    const done: number[] = [];
    await runBounded([1, 2], 0, undefined, async (n) => {
      done.push(n);
    });
    assert.deepEqual(done, [1, 2]);
  });

  test('an aborted signal stops launching new items', async () => {
    const controller = new AbortController();
    const items = [0, 1, 2, 3, 4];
    const processed: number[] = [];
    await runBounded(items, 1, controller.signal, async (n) => {
      processed.push(n);
      controller.abort(); // lose the lease after the first variant
    });
    assert.equal(processed.length, 1); // no further items were launched
  });

  test('a pre-aborted signal processes nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    const processed: number[] = [];
    await runBounded([1, 2, 3], 2, controller.signal, async (n) => {
      processed.push(n);
    });
    assert.equal(processed.length, 0);
  });
});
