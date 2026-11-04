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

const DISABLED =
  'resize worker disabled — this process consumes no tasks; set worker: { enabled: true } in src/config/resize.ts (or its resize.<NODE_ENV>.ts override) to run it';

const installApp = (enabled: boolean) => {
  const warns: string[] = [];
  const errors: string[] = [];
  setAppInstance({
    getConfig: () => ({
      ...defaultResizeConfig,
      mediaModelName: 'File',
      worker: { ...defaultWorkerOptions, enabled },
    }),
    getModel: () => undefined,
    logger: {
      info() {},
      warn: (m: string) => warns.push(m),
      error: (m: string) => errors.push(m),
    },
  } as never);
  return { warns, errors };
};

const stubStorage = {
  download: async () => Buffer.alloc(0),
  upload: async () => ({ key: 'k' }),
  publicUrl: () => '',
};

describe('runResizeWorker', () => {
  beforeEach(() => {
    resetResizerForTests();
  });
  afterEach(() => {
    resetAppInstance();
  });

  test('returns false without starting when worker.enabled is false, and says so at warn', async () => {
    const { warns } = installApp(false);
    assert.equal(await runResizeWorker(), false);
    assert.deepEqual(warns, [DISABLED]);
  });

  test('runResizeWorker resolves true after a run', {
    timeout: 10_000,
  }, async () => {
    installApp(true);
    const { tasks } = observedQueue(sigtermOnceClaimed(['default']));
    new FrameworkResizer({
      storage: stubStorage,
      media: fakeMedia(),
      locks: memoryLocks(),
      tasks,
    });
    assert.equal(await runResizeWorker(), true);
  });

  test('runResizeWorker resolves false for eager-only wiring', async () => {
    const { errors } = installApp(true);
    new FrameworkResizer({ storage: stubStorage, media: fakeMedia() });
    assert.equal(await runResizeWorker(), false);
    assert.deepEqual(errors, [
      'resize worker: no Resizer has a task queue (eager-only wiring)',
    ]);
  });

  test('the worker reads worker from resize.ts, whatever file its Resizers read', async () => {
    const warns: string[] = [];
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
      logger: { info() {}, warn: (m: string) => warns.push(m), error() {} },
    } as never);
    new FrameworkResizer({ name: 'listings', configName: 'resizeListings' });
    assert.equal(await runResizeWorker(), false);
    assert.deepEqual(asked, ['resize']);
    assert.deepEqual(warns, [DISABLED]);
  });

  test('a disabled worker logs that it is disabled, even beside a queue driver no Resizer registers', async () => {
    const warns: string[] = [];
    setAppInstance({
      getConfig: () => ({
        worker: { enabled: false },
        queues: { default: { driver: 'redis' } },
      }),
      getModel: () => undefined,
      logger: { info() {}, warn: (m: string) => warns.push(m), error() {} },
    } as never);
    assert.equal(await runResizeWorker(), false);
    assert.deepEqual(warns, [DISABLED]);
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
      storage: stubStorage,
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
