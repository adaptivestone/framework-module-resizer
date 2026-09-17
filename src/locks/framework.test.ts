import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import { ResizeError, ResizeSetupError } from '../errors.ts';
import { FrameworkLockProvider } from './framework.ts';

// One stateless instance drives the whole file (option-less constructor; the
// driver reaches the framework `Lock` model ambiently through getApp()).
const provider = new FrameworkLockProvider();

// A recording fake `Lock` model installed via getModel('Lock'). The ms→seconds
// conversion is the framework's Lock TTL contract (02 · §4) and must live here.
function installLock(lock: {
  createIndexes?: () => unknown;
  acquireLock?: (key: string, ttl: number) => unknown;
  releaseLock?: (key: string) => unknown;
}) {
  setAppInstance({
    getConfig: () => ({}),
    getModel: (name: string) => (name === 'Lock' ? lock : undefined),
    logger: { info() {}, warn() {}, error() {} },
  } as never);
}

afterEach(() => {
  resetAppInstance();
});

describe('FrameworkLockProvider.prepare', () => {
  test('requests Lock and waits for its createIndexes call', async () => {
    const names: string[] = [];
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let completed = false;
    setAppInstance({
      getConfig: () => ({}),
      getModel: (name: string) => {
        names.push(name);
        return {
          createIndexes: async () => {
            await pending;
            completed = true;
          },
        };
      },
      logger: { info() {}, warn() {}, error() {} },
    } as never);

    const preparing = provider.prepare();
    await Promise.resolve();
    assert.deepEqual(names, ['Lock']);
    assert.equal(completed, false);
    finish();
    await preparing;
    assert.equal(completed, true);
  });

  for (const [name, model] of [
    ['missing model', undefined],
    ['model without createIndexes', {}],
  ] as const) {
    test(`rejects a ${name} as a setup error`, async () => {
      setAppInstance({
        getConfig: () => ({}),
        getModel: () => model,
        logger: { info() {}, warn() {}, error() {} },
      } as never);
      await assert.rejects(provider.prepare(), (error: unknown) => {
        assert.ok(error instanceof ResizeSetupError);
        assert.equal(error.code, 'RESIZE_LOCK_MODEL_REQUIRED');
        assert.match(error.message, /register.*Lock/i);
        return true;
      });
    });
  }

  test('wraps an operational createIndexes failure and retains its cause', async () => {
    const cause = new Error('database unavailable');
    installLock({
      createIndexes: async () => {
        throw cause;
      },
    });
    await assert.rejects(provider.prepare(), (error: unknown) => {
      assert.ok(error instanceof ResizeError);
      assert.equal(error.code, 'RESIZE_QUEUE_PREPARE_FAILED');
      assert.equal(error.cause, cause);
      assert.match(error.message, /FrameworkLockProvider.*Lock/);
      return true;
    });
  });

  test('preserves an existing ResizeError from createIndexes', async () => {
    const existing = new ResizeError('known failure', { code: 'KNOWN' });
    installLock({
      createIndexes: async () => {
        throw existing;
      },
    });
    await assert.rejects(provider.prepare(), (error) => error === existing);
  });
});

describe('FrameworkLockProvider.acquire', () => {
  test('passes SECONDS to Lock.acquireLock (60000ms → 60) and returns the boolean', async () => {
    const calls: Array<[string, number]> = [];
    installLock({
      acquireLock: (key, ttl) => {
        calls.push([key, ttl]);
        return true;
      },
    });
    const ok = await provider.acquire('dispatch:1', 60000);
    assert.equal(ok, true);
    assert.deepEqual(calls, [['dispatch:1', 60]]);
  });

  test('rounds partial seconds UP (1500ms → 2)', async () => {
    const calls: Array<[string, number]> = [];
    installLock({
      acquireLock: (_key, ttl) => {
        calls.push(['k', ttl]);
        return true;
      },
    });
    await provider.acquire('k', 1500);
    assert.equal(calls[0][1], 2);
  });

  test('coerces a falsy acquireLock result to boolean false', async () => {
    installLock({ acquireLock: () => 0 });
    const ok = await provider.acquire('k', 1000);
    assert.strictEqual(ok, false);
    assert.equal(typeof ok, 'boolean');
  });
});

describe('FrameworkLockProvider.release', () => {
  test('calls Lock.releaseLock with the key', async () => {
    const released: string[] = [];
    installLock({
      acquireLock: () => true,
      releaseLock: (key) => {
        released.push(key);
      },
    });
    await provider.release('dispatch:1');
    assert.deepEqual(released, ['dispatch:1']);
  });
});
