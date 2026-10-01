import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import defaultResizeConfig from '../config/resize.ts';
import { resetResizerForTests } from '../resizer.ts';
import { runResizeWorker } from './worker.ts';

const installApp = (enabled: boolean) => {
  setAppInstance({
    getConfig: () => ({
      ...defaultResizeConfig,
      mediaModelName: 'File',
      worker: { ...defaultResizeConfig.worker, enabled },
    }),
    getModel: () => undefined,
    logger: { info() {}, warn() {}, error() {} },
  } as never);
};

describe('runResizeWorker', () => {
  beforeEach(() => {
    resetResizerForTests();
  });
  afterEach(() => {
    resetAppInstance();
  });

  test('returns without starting when worker.enabled is false', async () => {
    installApp(false);
    await runResizeWorker();
  });

  test('names the command fix when the worker process built no Resizer', async () => {
    installApp(true);
    await assert.rejects(
      runResizeWorker(),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, 'RESIZE_NO_RESIZER');
        assert.match(
          err.message,
          /src\/commands\/ResizeWorker\.ts must load src\/resizer\.ts/,
        );
        return true;
      },
    );
  });
});
