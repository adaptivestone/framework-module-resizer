import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import { ResizeConfigError } from '../errors.ts';
import { makeResizeConfig } from '../testHelpers/resizeConfig.ts';
import ResizeWorker from './ResizeWorkerCommand.ts';

afterEach(resetAppInstance);

// A fake app recording which config files the command reads.
function installApp(): string[] {
  const asked: string[] = [];
  setAppInstance({
    getConfig(name: string) {
      asked.push(name);
      return name === 'resize' ? makeResizeConfig() : {};
    },
    logger: { info() {}, warn() {}, error() {} },
  } as never);
  return asked;
}

describe('ResizeWorker CLI contract', () => {
  test('still declares --config, so the parser accepts it and run() can name the fix', () => {
    assert.equal(ResizeWorker.commandArguments.config.type, 'string');
    assert.match(ResizeWorker.commandArguments.config.description, /removed/i);
    assert.match(
      ResizeWorker.commandArguments.config.description,
      /src\/config\/resize\.ts/,
    );
  });

  for (const args of [undefined, {}, { queue: 'bulk' }]) {
    test(`reads worker settings from src/config/resize.ts (args ${JSON.stringify(args)})`, async () => {
      const asked = installApp();
      const command = new ResizeWorker(undefined, undefined, args);
      assert.equal(await command.run(), true);
      assert.deepEqual(asked, ['resize']);
    });
  }

  test('--config is RESIZE_CONFIG_REMOVED_KEY', async () => {
    const asked = installApp();
    const command = new ResizeWorker(undefined, undefined, {
      queue: 'bulk',
      config: 'resizeListings',
    });
    await assert.rejects(
      () => command.run(),
      (err: unknown) =>
        err instanceof ResizeConfigError &&
        err.code === 'RESIZE_CONFIG_REMOVED_KEY' &&
        err.message ===
          'resize worker: `--config` is removed — the worker reads `worker` and `queues` from src/config/resize.ts',
    );
    assert.deepEqual(asked, []);
  });

  test('provides the Mongo connection name expected by BaseCli', () => {
    // BaseCli lowercases the command name and passes parsedArgs.values as the second argument.
    const connectionName = ResizeWorker.getMongoConnectionName('resizeworker', {
      help: false,
    });

    assert.equal(connectionName, 'CLI: ResizeWorker');
  });

  test('keeps the connection name stable when CLI arguments change', () => {
    assert.equal(
      ResizeWorker.getMongoConnectionName('resizeworker', { help: false }),
      ResizeWorker.getMongoConnectionName('resizeworker', {
        maxWaitMin: 5,
        verbose: true,
      }),
    );
  });
});
