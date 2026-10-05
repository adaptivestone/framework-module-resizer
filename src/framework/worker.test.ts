import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import defaultResizeConfig, { defaultWorkerOptions } from '../config/resize.ts';
import { resetResizerForTests } from '../resizer.ts';
import { runResizeWorker } from './worker.ts';

const installApp = (enabled: boolean) => {
  setAppInstance({
    getConfig: () => ({
      ...defaultResizeConfig,
      mediaModelName: 'File',
      worker: { ...defaultWorkerOptions, enabled },
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

  test('the disabled message names the config file the worker read', async () => {
    const lines: string[] = [];
    setAppInstance({
      getConfig: () => ({
        ...defaultResizeConfig,
        mediaModelName: 'File',
        worker: { ...defaultWorkerOptions, enabled: false },
      }),
      getModel: () => undefined,
      logger: { info: (m: string) => lines.push(m), warn() {}, error() {} },
    } as never);
    await runResizeWorker({ configName: 'resizeListings' });
    assert.match(lines.join('\n'), /src\/config\/resizeListings\.ts/);
    lines.length = 0;
    await runResizeWorker();
    assert.match(lines.join('\n'), /src\/config\/resize\.ts/);
  });

  test('names the command fix when the worker process built no Resizer', async () => {
    installApp(true);
    await assert.rejects(
      runResizeWorker(),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, 'RESIZE_NO_RESIZER');
        assert.match(
          err.message,
          /src\/commands\/ResizeWorker\.ts must import src\/resizer\.ts/,
        );
        return true;
      },
    );
  });
});
