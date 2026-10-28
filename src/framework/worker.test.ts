import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import defaultResizeConfig from '../config/resize.ts';
import { resetResizerForTests } from '../resizer.ts';
import { makeResizeConfig } from '../testHelpers/resizeConfig.ts';
import { defaultWorkerOptions } from './defaults.ts';
import { FrameworkResizer } from './resizer.ts';
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

  test('the worker reads worker from resize.ts, whatever file its Resizers read', async () => {
    const lines: string[] = [];
    const asked: string[] = [];
    setAppInstance({
      getConfig: (name: string) => {
        asked.push(name);
        return name === 'resize'
          ? { worker: { enabled: false } }
          : // Never read: a Resizer's own file holds no worker section.
            makeResizeConfig({ worker: { enabled: true } });
      },
      getModel: () => undefined,
      logger: { info: (m: string) => lines.push(m), warn() {}, error() {} },
    } as never);
    new FrameworkResizer({ name: 'listings', configName: 'resizeListings' });
    await runResizeWorker();
    assert.deepEqual(asked, ['resize']);
    assert.match(
      lines.join('\n'),
      /resize worker disabled — set worker: \{ enabled: true \} in src\/config\/resize\.ts \(or its resize\.<NODE_ENV>\.ts override\)/,
    );
  });

  test('configName (the old --config) is RESIZE_CONFIG_REMOVED_KEY, before any config is read', async () => {
    const asked: string[] = [];
    setAppInstance({
      getConfig: (name: string) => {
        asked.push(name);
        return {};
      },
      getModel: () => undefined,
      logger: { info() {}, warn() {}, error() {} },
    } as never);
    await assert.rejects(
      runResizeWorker({ configName: 'x' } as never),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, 'RESIZE_CONFIG_REMOVED_KEY');
        assert.equal(
          err.message,
          'resize worker: `configName` (the old `--config`) is removed — the worker reads `worker` and `queues` from src/config/resize.ts',
        );
        return true;
      },
    );
    assert.deepEqual(asked, []);
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
