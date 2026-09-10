import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import ResizeWorker from './ResizeWorker.ts';

describe('ResizeWorker CLI contract', () => {
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
