import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import { enqueue } from './enqueue.ts';
import type { LockProvider } from './locks.ts';
import {
  type QueueTransport,
  Resizer,
  type ResizeStorage,
  resetResizerForTests,
} from './resizer.ts';
import type { MissingPreview, StorageRef } from './types.d.ts';

// ---------------------------------------------------------------------------
// Harness — recording app + recording driver fakes (see engine.test.ts).
// ---------------------------------------------------------------------------

function installFakeApp() {
  const errors: unknown[][] = [];
  setAppInstance({
    getConfig: () => ({ mediaModelName: 'File' }),
    getModel: () => ({}),
    logger: {
      info() {},
      warn() {},
      error(...a: unknown[]) {
        errors.push(a);
      },
    },
  } as never);
  return { errors };
}

const storage: ResizeStorage = {
  download: async () => Buffer.alloc(0),
  upload: async () => ({ key: 'k' }),
  publicUrl: (ref: StorageRef) => `https://cdn/${ref.key}`,
};

type EnqueueTask = {
  mediaId: string;
  pipeline: string;
  previews: MissingPreview[];
};

function makeTransport(
  behavior?: (task: EnqueueTask) => { taskId: string | null },
) {
  const calls: EnqueueTask[] = [];
  const transport: QueueTransport = {
    enqueue: async (task) => {
      calls.push(task);
      return behavior ? behavior(task) : { taskId: 't1' };
    },
    startWorker: async () => {},
  };
  return { transport, calls };
}

function makeLocks(acquire: boolean | ((key: string) => boolean) = true) {
  const acquired: { key: string; ttl: number }[] = [];
  const released: string[] = [];
  const lockProvider: LockProvider = {
    acquire: async (key, ttl) => {
      acquired.push({ key, ttl });
      return typeof acquire === 'function' ? acquire(key) : acquire;
    },
    release: async (key) => {
      released.push(key);
    },
  };
  return { lockProvider, acquired, released };
}

function makeResizer(opts: {
  transport?: QueueTransport;
  lockProvider?: LockProvider;
}) {
  return new Resizer({ storage, ...opts });
}

const variant = (over: Partial<MissingPreview> = {}): MissingPreview => ({
  sizeKey: '300x300',
  format: 'jpeg',
  ...over,
});

afterEach(() => {
  resetResizerForTests();
  resetAppInstance();
});

// ---------------------------------------------------------------------------
// §18 enqueue algorithm
// ---------------------------------------------------------------------------

describe('enqueue', () => {
  test('dedups variants by identity before acquiring locks', async () => {
    installFakeApp();
    const { transport, calls } = makeTransport();
    const { lockProvider, acquired } = makeLocks(true);
    const r = makeResizer({ transport, lockProvider });
    await enqueue(r, 'm1', 'default', [variant(), variant()]);
    assert.equal(acquired.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].previews.length, 1);
  });

  test('acquires a dispatch lock per identity with the configured TTL', async () => {
    installFakeApp();
    const { transport } = makeTransport();
    const { lockProvider, acquired } = makeLocks(true);
    const r = makeResizer({ transport, lockProvider });
    await enqueue(r, 'm1', 'default', [variant(), variant({ format: 'webp' })]);
    assert.deepEqual(
      acquired.map((a) => a.key),
      [
        'resize_dispatch:m1:300x300:jpeg:none',
        'resize_dispatch:m1:300x300:webp:none',
      ],
    );
    assert.equal(acquired[0].ttl, 60000);
  });

  test('keeps only lock-winners; a held lock is skipped', async () => {
    installFakeApp();
    const { transport, calls } = makeTransport();
    const { lockProvider } = makeLocks(
      (key) => key.endsWith(':jpeg:none'), // only the jpeg lock is won
    );
    const r = makeResizer({ transport, lockProvider });
    await enqueue(r, 'm1', 'default', [variant(), variant({ format: 'webp' })]);
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0].previews.map((p) => p.format),
      ['jpeg'],
    );
  });

  test('does not call the transport when no lock survives', async () => {
    installFakeApp();
    const { transport, calls } = makeTransport();
    const { lockProvider } = makeLocks(false);
    const r = makeResizer({ transport, lockProvider });
    await enqueue(r, 'm1', 'default', [variant()]);
    assert.equal(calls.length, 0);
  });

  test('on success (non-null taskId) the survivor locks are NOT released', async () => {
    installFakeApp();
    const { transport } = makeTransport();
    const { lockProvider, released } = makeLocks(true);
    const r = makeResizer({ transport, lockProvider });
    await enqueue(r, 'm1', 'default', [variant()]);
    assert.equal(released.length, 0);
  });

  test('releases survivor locks when the transport throws (never rethrows)', async () => {
    const { errors } = installFakeApp();
    const { transport } = makeTransport(() => {
      throw new Error('down');
    });
    const { lockProvider, released } = makeLocks(true);
    const r = makeResizer({ transport, lockProvider });
    await enqueue(r, 'm1', 'default', [variant()]);
    assert.deepEqual(released, ['resize_dispatch:m1:300x300:jpeg:none']);
    assert.ok(errors.length >= 1);
  });

  test('releases survivor locks when taskId is null (soft failure)', async () => {
    const { errors } = installFakeApp();
    const { transport } = makeTransport(() => ({ taskId: null }));
    const { lockProvider, released } = makeLocks(true);
    const r = makeResizer({ transport, lockProvider });
    await enqueue(r, 'm1', 'default', [variant()]);
    assert.deepEqual(released, ['resize_dispatch:m1:300x300:jpeg:none']);
    assert.ok(errors.length >= 1);
  });

  test('passes mediaId + pipeline + survivors through to the transport', async () => {
    installFakeApp();
    const { transport, calls } = makeTransport();
    const { lockProvider } = makeLocks(true);
    const r = makeResizer({ transport, lockProvider });
    const v = variant({ requestedWidth: 300, requestedHeight: 300 });
    await enqueue(r, 'm1', 'photo', [v]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mediaId, 'm1');
    assert.equal(calls[0].pipeline, 'photo');
    assert.deepEqual(calls[0].previews, [v]);
  });
});
