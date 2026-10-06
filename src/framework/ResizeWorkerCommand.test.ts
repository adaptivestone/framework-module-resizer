import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import { makeResizeConfig } from '../testHelpers/resizeConfig.ts';
import ResizeWorker from './ResizeWorkerCommand.ts';

afterEach(resetAppInstance);

describe('ResizeWorker CLI contract', () => {
  test('exposes the config file selector as a string argument', () => {
    assert.equal(ResizeWorker.commandArguments.config.type, 'string');
    assert.match(ResizeWorker.commandArguments.config.description, /worker/);
    assert.match(
      ResizeWorker.commandArguments.config.description,
      /default 'resize'/,
    );
  });

  for (const config of [undefined, 'resizeListings']) {
    test(`reads worker settings from ${config ?? 'resize'} config`, async () => {
      const asked: string[] = [];
      setAppInstance({
        getConfig(name: string) {
          asked.push(name);
          return name === (config ?? 'resize') ? makeResizeConfig() : {};
        },
        logger: { info() {}, warn() {}, error() {} },
      } as never);
      const command = new ResizeWorker(
        undefined,
        undefined,
        config === undefined ? {} : { queue: 'bulk', config },
      );
      assert.equal(await command.run(), true);
      assert.deepEqual(asked, [config ?? 'resize']);
    });
  }

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
