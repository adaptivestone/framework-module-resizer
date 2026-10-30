import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import defaultResizeConfig from '../config/resize.ts';
import { resetResizerForTests } from '../resizer.ts';
import {
  fakeMedia,
  memoryLocks,
  observedQueue,
  sigtermOnceClaimed,
} from '../testHelpers/fakes.ts';
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

  test('a disabled worker logs that it is disabled, even beside a queue driver no Resizer registers', async () => {
    const lines: string[] = [];
    setAppInstance({
      getConfig: () => ({
        worker: { enabled: false },
        queues: { default: { driver: 'redis' } },
      }),
      getModel: () => undefined,
      logger: { info: (m: string) => lines.push(m), warn() {}, error() {} },
    } as never);
    await runResizeWorker();
    assert.match(lines.join('\n'), /resize worker disabled/);
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

  test('runResizeWorker passes a queue list to runWorker', {
    timeout: 10_000,
  }, async () => {
    installApp(true);
    const queues = ['default', 'bulk'];
    const { tasks, claimedQueues } = observedQueue(sigtermOnceClaimed(queues));
    new FrameworkResizer({
      storage: {
        download: async () => Buffer.alloc(0),
        upload: async () => ({ key: 'k' }),
        publicUrl: () => '',
      },
      media: fakeMedia(),
      locks: memoryLocks(),
      tasks,
    });
    await runResizeWorker({ queue: queues });
    assert.deepEqual([...new Set(claimedQueues)].sort(), ['bulk', 'default']);
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
