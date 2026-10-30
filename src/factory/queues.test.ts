import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { defaultQueueOptions } from '../config/resize.ts';
import type { QueueDriver, QueueEntry } from '../contracts/drivers.ts';
import { ResizeConfigError } from '../errors.ts';
import { validateSqsEntries } from '../helpers/queueSections.ts';
import { fakeQueueDriver } from '../testHelpers/fakes.ts';
import { resolveQueueEntries, validateQueueDrivers } from './queues.ts';

const WHERE = 'src/config/resize.ts (or its resize.<NODE_ENV>.ts override)';

const configError =
  (code: string, ...parts: Array<string | RegExp>) =>
  (err: unknown) =>
    err instanceof ResizeConfigError &&
    err.code === code &&
    parts.every((part) =>
      typeof part === 'string'
        ? err.message.includes(part)
        : part.test(err.message),
    );

describe('resolveQueueEntries', () => {
  test('no map is no entries; the entries come back in the map order, each with its section', () => {
    assert.deepEqual(resolveQueueEntries(undefined, WHERE), []);
    const bulk = { driver: 'sqs', queueUrl: 'https://sqs.example/bulk' };
    const entries = resolveQueueEntries(
      { default: { driver: 'database' }, bulk },
      WHERE,
    );
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ['default', 'bulk'],
    );
    assert.strictEqual(entries[1].section, bulk);
  });

  test('a map that is not an object is RESIZE_CONFIG_INVALID', () => {
    for (const queues of [[{ driver: 'database' }], 'database', null]) {
      assert.throws(
        () => resolveQueueEntries(queues, WHERE),
        configError(
          'RESIZE_CONFIG_INVALID',
          `resize config: \`queues\` in ${WHERE} must be an object of queue names`,
        ),
        JSON.stringify(queues),
      );
    }
  });

  test('an entry set to undefined is not defined', () => {
    // An environment file removes an entry that way: the framework's merge keeps the key.
    assert.deepEqual(
      resolveQueueEntries(
        { default: { driver: 'database' }, bulk: undefined },
        WHERE,
      ).map((entry) => entry.name),
      ['default'],
    );
  });

  test('a blank queue name is RESIZE_CONFIG_INVALID', () => {
    assert.throws(
      () => resolveQueueEntries({ ' ': { driver: 'database' } }, WHERE),
      configError(
        'RESIZE_CONFIG_INVALID',
        `\`queues\` in ${WHERE} has a blank queue name`,
      ),
    );
  });

  test('an entry needs an object with a driver name, any non-empty name', () => {
    const noDriver = `resize config: \`queues.bulk\` in ${WHERE} needs driver 'database' or 'sqs'`;
    for (const entry of [
      {},
      { driver: '' },
      { driver: ' ' },
      { driver: 1 },
      'database',
      null,
    ]) {
      assert.throws(
        () => resolveQueueEntries({ bulk: entry }, WHERE),
        configError('RESIZE_CONFIG_INVALID', noDriver),
        JSON.stringify(entry),
      );
    }
    // Which names are registered is the drivers' question (validateQueueDrivers).
    assert.equal(
      resolveQueueEntries({ bulk: { driver: 'redis' } }, WHERE)[0].section
        .driver,
      'redis',
    );
  });

  test('queues.<name>.lockTtlMs and queues.<name>.queues are RESIZE_CONFIG_REMOVED_KEY naming the entry', () => {
    for (const value of [{ failed: 600_000 }, undefined]) {
      assert.throws(
        () =>
          resolveQueueEntries(
            { bulk: { driver: 'database', lockTtlMs: value } },
            WHERE,
          ),
        configError(
          'RESIZE_CONFIG_REMOVED_KEY',
          '`queues.bulk.lockTtlMs`',
          WHERE,
          'coordination in the same file',
          'lockTtlMs.failed → cooldownMs',
          'lockTtlMs.dispatch → gateTtlMs',
          'drop lockTtlMs.worker',
        ),
        JSON.stringify(value),
      );
    }
    assert.throws(
      () =>
        resolveQueueEntries(
          {
            default: {
              driver: 'sqs',
              queueUrl: 'https://sqs.example/resize',
              queues: { bulk: 'https://sqs.example/bulk' },
            },
          },
          WHERE,
        ),
      configError(
        'RESIZE_CONFIG_REMOVED_KEY',
        '`queues.default.queues`',
        WHERE,
        'its own entry',
      ),
    );
  });

  test("each entry's timing fills the defaults and names the entry when invalid", () => {
    const [entry] = resolveQueueEntries(
      { default: { driver: 'database', maxAttempts: 3 } },
      WHERE,
    );
    assert.deepEqual(entry.timing, { ...defaultQueueOptions, maxAttempts: 3 });
    let error: unknown;
    try {
      resolveQueueEntries(
        {
          default: { driver: 'database' },
          bulk: { driver: 'database', leaseMs: 0 },
        },
        WHERE,
      );
    } catch (err) {
      error = err;
    }
    assert.ok(
      configError(
        'RESIZE_CONFIG_QUEUE_LEASE_INVALID',
        `resize config: \`queues.bulk\` in ${WHERE}: leaseMs must be a positive safe integer`,
      )(error),
      String(error),
    );
    const cause = (error as Error).cause;
    assert.ok(
      cause instanceof ResizeConfigError &&
        cause.code === 'RESIZE_CONFIG_QUEUE_LEASE_INVALID',
    );
    assert.throws(
      () =>
        resolveQueueEntries(
          { slow: { driver: 'database', maxAttempts: 0 } },
          WHERE,
        ),
      configError('RESIZE_CONFIG_QUEUE_INVALID', /queues\.slow/),
    );
  });
});

describe('validateQueueDrivers', () => {
  const entries = (queues: Record<string, unknown>): QueueEntry[] =>
    resolveQueueEntries(queues, WHERE);
  const builtIns = (): Record<string, QueueDriver> => ({
    database: fakeQueueDriver(),
    sqs: fakeQueueDriver(validateSqsEntries),
  });
  const none = new Set<QueueDriver['validate']>();

  test("an unregistered driver is RESIZE_CONFIG_INVALID with today's text, custom names listed after the built-in ones", () => {
    const redis = entries({
      default: { driver: 'database' },
      bulk: { driver: 'redis' },
    });
    assert.throws(
      () => validateQueueDrivers(redis, builtIns(), WHERE, none),
      configError(
        'RESIZE_CONFIG_INVALID',
        `resize config: \`queues.bulk\` in ${WHERE} needs driver 'database' or 'sqs'`,
      ),
    );
    assert.throws(
      () =>
        validateQueueDrivers(
          redis,
          { ...builtIns(), plain: fakeQueueDriver() },
          WHERE,
          none,
        ),
      configError(
        'RESIZE_CONFIG_INVALID',
        `\`queues.bulk\` in ${WHERE} needs driver 'database', 'sqs' or 'plain'`,
      ),
    );
    // A name inherited from Object.prototype is not a registered driver.
    assert.throws(
      () =>
        validateQueueDrivers(
          entries({ bulk: { driver: 'toString' } }),
          builtIns(),
          WHERE,
          none,
        ),
      configError('RESIZE_CONFIG_INVALID', '`queues.bulk`'),
    );
    // Every entry's driver is checked before any driver's own checks run.
    let ran = 0;
    assert.throws(
      () =>
        validateQueueDrivers(
          entries({ default: { driver: 'plain' }, bulk: { driver: 'redis' } }),
          {
            plain: fakeQueueDriver(() => {
              ran += 1;
            }),
          },
          WHERE,
          none,
        ),
      configError('RESIZE_CONFIG_INVALID', "needs driver 'plain'"),
    );
    assert.equal(ran, 0);
  });

  test("each driver's validate runs once on all its entries, unless that same function was already run", () => {
    const calls: Array<{ names: string[]; where: string }> = [];
    const validate: QueueDriver['validate'] = (given, ctx) => {
      calls.push({ names: given.map((entry) => entry.name), where: ctx.where });
    };
    const drivers = { ...builtIns(), plain: fakeQueueDriver(validate) };
    const mixed = entries({
      a: { driver: 'plain' },
      b: { driver: 'database' },
      c: { driver: 'plain' },
    });
    validateQueueDrivers(mixed, drivers, WHERE, none);
    assert.deepEqual(calls, [{ names: ['a', 'c'], where: WHERE }]);
    validateQueueDrivers(mixed, drivers, WHERE, new Set([validate]));
    assert.equal(calls.length, 1);
    // A driver without validate, and a registered driver no entry selects, are fine.
    validateQueueDrivers(
      entries({ b: { driver: 'database' } }),
      drivers,
      WHERE,
      none,
    );
    assert.equal(calls.length, 1);
    // The built-in SQS checks run through the same path.
    assert.throws(
      () =>
        validateQueueDrivers(
          entries({ bulk: { driver: 'sqs' } }),
          drivers,
          WHERE,
          none,
        ),
      configError('RESIZE_CONFIG_INVALID', '`queues.bulk.queueUrl`'),
    );
    validateQueueDrivers(
      entries({ bulk: { driver: 'sqs' } }),
      drivers,
      WHERE,
      new Set([validateSqsEntries]),
    );
  });

  test('a host driver registered under sqs has its own validate run, even when validateSqsEntries is marked as run', () => {
    const sqs = fakeQueueDriver(() => {
      throw new ResizeConfigError('custom', { code: 'X_INVALID' });
    });
    assert.throws(
      () =>
        validateQueueDrivers(
          entries({ bulk: { driver: 'sqs', queueUrl: 'u' } }),
          { ...builtIns(), sqs },
          WHERE,
          new Set([validateSqsEntries]),
        ),
      configError('X_INVALID', 'custom'),
    );
  });
});
