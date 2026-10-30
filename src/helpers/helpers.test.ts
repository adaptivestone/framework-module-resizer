// Direct unit coverage for the INTERNAL generic helpers. Behavior these express is also
// exercised through images/uploader/processor/consumer/mongo tests; we pin the utilities themselves
// (guards edge cases, hex shape, abortable sleep, bounded pool + abort, never-throwing logging, the
// SQS queue-entry checks and backend key) directly.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { defaultQueueOptions } from '../config/resize.ts';
import type { QueueEntry, QueueSection } from '../contracts/drivers.ts';
import { ResizeConfigError } from '../errors.ts';
import type { SqsQueueConfig } from '../types.d.ts';
import { runBounded } from './concurrency.ts';
import { isPositiveFinite } from './guards.ts';
import { logNeverThrow } from './log.ts';
import { sqsBackendKey, validateSqsEntries } from './queueSections.ts';
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

describe('logNeverThrow', () => {
  test('logs at the given level, error by default', () => {
    const calls: unknown[][] = [];
    const logger = {
      info: (...a: unknown[]) => calls.push(['info', ...a]),
      warn: (...a: unknown[]) => calls.push(['warn', ...a]),
      error: (...a: unknown[]) => calls.push(['error', ...a]),
    };
    const err = new Error('x');
    logNeverThrow(logger, 'a', err);
    logNeverThrow(logger, 'b', undefined, 'info');
    logNeverThrow(logger, 'c', err, 'warn');
    assert.deepEqual(calls, [
      ['error', 'a', err],
      ['info', 'b'],
      ['warn', 'c', err],
    ]);
  });

  test('a throwing logger falls back to the console method of the same level', (t) => {
    const fallback = t.mock.method(console, 'info', () => {});
    const throws = () => {
      throw new Error('log sink down');
    };
    logNeverThrow(
      { info: throws, warn: throws, error: throws },
      'stopped',
      undefined,
      'info',
    );
    assert.deepEqual(
      fallback.mock.calls.map((call) => call.arguments),
      [['stopped']],
    );
  });
});

describe('validateSqsEntries', () => {
  const WHERE = 'src/config/resize.ts (or its resize.<NODE_ENV>.ts override)';
  const entry = (
    name: string,
    section: QueueSection & Partial<SqsQueueConfig>,
  ): QueueEntry => ({
    name,
    section,
    timing: defaultQueueOptions,
  });
  const invalid = (message: string) => (err: unknown) =>
    err instanceof ResizeConfigError &&
    err.code === 'RESIZE_CONFIG_INVALID' &&
    err.message === message;

  test('each entry needs its own non-empty queueUrl', () => {
    const sections: Array<QueueSection & Partial<SqsQueueConfig>> = [
      { driver: 'sqs' },
      { driver: 'sqs', queueUrl: '' },
    ];
    for (const section of sections) {
      assert.throws(
        () => validateSqsEntries([entry('bulk', section)], { where: WHERE }),
        invalid(
          `resize config: \`queues.bulk.queueUrl\` in ${WHERE} is required for the 'sqs' driver`,
        ),
        JSON.stringify(section),
      );
    }
  });

  test('two names with one queueUrl are RESIZE_CONFIG_INVALID', () => {
    const url = 'https://sqs.example/resize';
    assert.throws(
      () =>
        validateSqsEntries(
          [
            entry('default', { driver: 'sqs', queueUrl: url }),
            entry('bulk', { driver: 'sqs', queueUrl: url }),
          ],
          { where: WHERE },
        ),
      invalid(
        `resize config: \`queues.default\` and \`queues.bulk\` in ${WHERE} have the same queueUrl ${url} — give each queue name its own SQS queue`,
      ),
    );
  });

  test('entries with their own URLs pass', () => {
    validateSqsEntries(
      [
        entry('default', { driver: 'sqs', queueUrl: 'https://sqs.example/a' }),
        entry('bulk', { driver: 'sqs', queueUrl: 'https://sqs.example/b' }),
      ],
      { where: WHERE },
    );
    validateSqsEntries([], { where: WHERE });
  });
});

describe('sqsBackendKey', () => {
  test('SQS entries share a backend by region, endpoint, dead-letter queue and effective long poll', () => {
    const sqs: SqsQueueConfig = {
      driver: 'sqs',
      queueUrl: 'https://sqs.example/a',
    };
    assert.equal(sqsBackendKey(sqs), 'sqs:[null,null,null,10]');
    // The default long poll written out, another URL and other timing: the same backend.
    const same: SqsQueueConfig = {
      ...sqs,
      queueUrl: 'https://sqs.example/b',
      maxAttempts: 3,
      waitTimeSeconds: 10,
    };
    assert.equal(sqsBackendKey(same), sqsBackendKey(sqs));
    const other: SqsQueueConfig = {
      ...sqs,
      region: 'eu-west-1',
      endpoint: 'http://localhost:4566',
      deadLetterQueueUrl: 'https://sqs.example/dead',
      waitTimeSeconds: 20,
    };
    assert.equal(
      sqsBackendKey(other),
      'sqs:["eu-west-1","http://localhost:4566","https://sqs.example/dead",20]',
    );
  });
});
