import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { QueueEntry } from '../contracts/drivers.ts';
import { ResizeConfigError } from '../errors.ts';
import {
  fakeDatabaseParts,
  fakeMedia,
  silentLogger,
} from '../testHelpers/fakes.ts';
import type { DatabaseQueueConfig } from '../types.d.ts';
import { databaseQueueDriver } from './databaseQueue.ts';
import { resolveQueueEntries } from './queues.ts';

const WHERE = 'the config passed to createResizer()';

const entries = () =>
  resolveQueueEntries(
    {
      default: { driver: 'database', maxAttempts: 4 },
      bulk: { driver: 'database', leaseMs: 120_000 },
    },
    WHERE,
  ) as QueueEntry<DatabaseQueueConfig>[];

const configInvalid = (message: string) => (err: unknown) =>
  err instanceof ResizeConfigError &&
  err.code === 'RESIZE_CONFIG_INVALID' &&
  err.message === message;

describe('databaseQueueDriver', () => {
  test('the database queue driver needs a database section', async () => {
    // No grouping: every database entry is one backend, the database's own task collection.
    assert.equal(databaseQueueDriver.backendOf, undefined);
    await assert.rejects(
      async () =>
        databaseQueueDriver.fromConfig(entries(), {
          logger: silentLogger,
          where: WHERE,
          database: undefined,
        }),
      configInvalid(
        "resize config: `queues.default` in the config passed to createResizer() uses driver 'database', which needs a `database` section",
      ),
    );
    // A database driver that builds no task queue cannot carry these names either.
    await assert.rejects(
      async () =>
        databaseQueueDriver.fromConfig(entries(), {
          logger: silentLogger,
          where: WHERE,
          database: { media: fakeMedia() },
        }),
      configInvalid(
        "resize config: `queues.default` in the config passed to createResizer() uses driver 'database', but the `database` section's driver builds no task queue",
      ),
    );
  });

  test('the database queue driver gives every name one task queue from the database parts', async () => {
    const database = fakeDatabaseParts();
    const given = entries();
    const tasks = await databaseQueueDriver.fromConfig(given, {
      logger: silentLogger,
      where: WHERE,
      database,
    });
    assert.equal(database.taskQueueCalls.length, 1);
    assert.strictEqual(tasks, database.built[0]);
    const [opts] = database.taskQueueCalls;
    assert.deepEqual(opts.queues, ['default', 'bulk']);
    assert.strictEqual(opts.getTiming('default'), given[0].timing);
    assert.strictEqual(opts.getTiming('bulk'), given[1].timing);
    assert.equal(opts.getTiming('default')?.maxAttempts, 4);
    assert.equal(opts.getTiming('bulk')?.leaseMs, 120_000);
    assert.equal(opts.getTiming('other'), undefined);
    assert.strictEqual(opts.logger, silentLogger);
    assert.equal(tasks.servesQueue?.('bulk'), true);
    assert.equal(tasks.servesQueue?.('other'), false);
  });
});
