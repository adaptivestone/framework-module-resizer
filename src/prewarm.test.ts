import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import {
  type LockProvider,
  type QueueTransport,
  Resizer,
  type ResizeStorage,
  resetResizerForTests,
} from './resizer.ts';
import type { MediaLike, MissingPreview, StorageRef } from './types.d.ts';

// ---------------------------------------------------------------------------
// Harness — recording app + recording driver fakes (mirrors engine.test.ts). prewarm reads
// logger/config via getApp() at CALL time, so installing the fake before each run is enough.
// ---------------------------------------------------------------------------

function installFakeApp() {
  const info: unknown[][] = [];
  const warn: unknown[][] = [];
  const errors: unknown[][] = [];
  setAppInstance({
    getConfig: () => ({ mediaModelName: 'File' }),
    getModel: () => ({}),
    logger: {
      info(...a: unknown[]) {
        info.push(a);
      },
      warn(...a: unknown[]) {
        warn.push(a);
      },
      error(...a: unknown[]) {
        errors.push(a);
      },
    },
  } as never);
  return { info, warn, errors };
}

function makeStorage(o: Partial<ResizeStorage> = {}): ResizeStorage {
  return {
    download: async () => Buffer.alloc(0),
    upload: async () => ({ key: 'k' }),
    publicUrl: (ref: StorageRef) => `https://cdn/${ref.key}`,
    ...o,
  };
}

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

afterEach(() => {
  resetResizerForTests();
  resetAppInstance();
});

// ---------------------------------------------------------------------------
// §11.1b prewarm — expand sizes×formats → enqueue via the dispatch-lock path, never throw
// ---------------------------------------------------------------------------

describe('prewarm — happy path', () => {
  test('expands N sizes × M formats, enqueues the survivors once, returns their count', async () => {
    installFakeApp();
    const { transport, calls } = makeTransport();
    const { lockProvider } = makeLocks(true);
    const r = new Resizer({ storage: makeStorage(), transport, lockProvider });
    const { enqueued } = await r.prewarm({
      media: { id: 'm1' },
      sizes: [
        { width: 300, height: 300 },
        { width: 100, height: 100 },
      ],
      formats: ['jpeg', 'webp'],
      pipeline: 'photo',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mediaId, 'm1');
    assert.equal(calls[0].pipeline, 'photo');
    assert.equal(calls[0].previews.length, 4);
    assert.equal(enqueued, 4);
    assert.deepEqual(
      calls[0].previews.map((p) => `${p.sizeKey}:${p.format}`).sort(),
      ['100x100:jpeg', '100x100:webp', '300x300:jpeg', '300x300:webp'],
    );
  });

  test('carries requestedWidth/Height/filters/fit onto the enqueued variants', async () => {
    installFakeApp();
    const { transport, calls } = makeTransport();
    const { lockProvider } = makeLocks(true);
    const r = new Resizer({ storage: makeStorage(), transport, lockProvider });
    await r.prewarm({
      media: { id: 'm1' },
      sizes: [
        { width: 300, height: 300, filters: { blur: 40 } },
        { fit: true },
      ],
      formats: ['jpeg'],
    });
    assert.deepEqual(calls[0].previews, [
      {
        sizeKey: '300x300',
        format: 'jpeg',
        filters: { blur: 40 },
        requestedWidth: 300,
        requestedHeight: 300,
      },
      { sizeKey: 'fit', format: 'jpeg', fit: true },
    ]);
  });
});

describe('prewarm — skip existing & dedup', () => {
  test('identities already in media.previews are not enqueued', async () => {
    installFakeApp();
    const { transport, calls } = makeTransport();
    const { lockProvider } = makeLocks(true);
    const r = new Resizer({ storage: makeStorage(), transport, lockProvider });
    const media: MediaLike = {
      id: 'm1',
      original: { key: 'orig.jpg', contentType: 'image/jpeg' },
      previews: [
        {
          key: 'p1',
          contentType: 'image/jpeg',
          sizeKey: '300x300',
          format: 'jpeg',
        },
      ],
    };
    const { enqueued } = await r.prewarm({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
    });
    assert.equal(enqueued, 1);
    assert.deepEqual(
      calls[0].previews.map((p) => `${p.sizeKey}:${p.format}`),
      ['300x300:webp'],
    );
  });

  test('duplicate sizes within the request are deduped to one identity', async () => {
    installFakeApp();
    const { transport, calls } = makeTransport();
    const { lockProvider } = makeLocks(true);
    const r = new Resizer({ storage: makeStorage(), transport, lockProvider });
    const { enqueued } = await r.prewarm({
      media: { id: 'm1' },
      sizes: [
        { width: 300, height: 300 },
        { width: 300, height: 300 },
      ],
      formats: ['jpeg'],
    });
    assert.equal(enqueued, 1);
    assert.equal(calls[0].previews.length, 1);
  });

  test('a getSizeKey-throwing size is skipped; the others still enqueue', async () => {
    installFakeApp();
    const { transport, calls } = makeTransport();
    const { lockProvider } = makeLocks(true);
    const r = new Resizer({ storage: makeStorage(), transport, lockProvider });
    const { enqueued } = await r.prewarm({
      media: { id: 'm1' },
      sizes: [{}, { width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(enqueued, 1);
    assert.equal(calls[0].previews[0].sizeKey, '300x300');
  });
});

describe('prewarm — SVG original is a no-op', () => {
  test('SVG (contentType) → { enqueued: 0 } and the transport is never touched', async () => {
    installFakeApp();
    const { transport, calls } = makeTransport();
    const { lockProvider, acquired } = makeLocks(true);
    const r = new Resizer({ storage: makeStorage(), transport, lockProvider });
    const { enqueued } = await r.prewarm({
      media: {
        id: 'm1',
        original: { key: 'logo.svg', contentType: 'image/svg+xml' },
      },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
    });
    assert.equal(enqueued, 0);
    assert.equal(calls.length, 0);
    assert.equal(acquired.length, 0);
  });

  test('SVG detected via original.format === "svg" too', async () => {
    installFakeApp();
    const { transport, calls } = makeTransport();
    const { lockProvider } = makeLocks(true);
    const r = new Resizer({ storage: makeStorage(), transport, lockProvider });
    const { enqueued } = await r.prewarm({
      media: { id: 'm1', original: { key: 'logo', format: 'svg' } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(enqueued, 0);
    assert.equal(calls.length, 0);
  });
});

describe('prewarm — waterfall hooks', () => {
  test('resolveSizes tap expands the set fed to the expansion', async () => {
    installFakeApp();
    const { transport, calls } = makeTransport();
    const { lockProvider } = makeLocks(true);
    const r = new Resizer({
      storage: makeStorage(),
      transport,
      lockProvider,
      hooks: {
        resolveSizes: () => [
          { width: 100, height: 100 },
          { width: 200, height: 200 },
        ],
      },
    });
    const { enqueued } = await r.prewarm({
      media: { id: 'm1' },
      sizes: [],
      formats: ['jpeg'],
    });
    assert.equal(enqueued, 2);
    assert.deepEqual(calls[0].previews.map((p) => p.sizeKey).sort(), [
      '100x100',
      '200x200',
    ]);
  });

  test('beforeEnqueue tap filters the remainder (assign-back semantics)', async () => {
    installFakeApp();
    const { transport, calls } = makeTransport();
    const { lockProvider } = makeLocks(true);
    const r = new Resizer({
      storage: makeStorage(),
      transport,
      lockProvider,
      hooks: {
        // drop everything but the jpeg 300x300 variant
        beforeEnqueue: (missing: MissingPreview[]) =>
          missing.filter((m) => m.sizeKey === '300x300' && m.format === 'jpeg'),
      },
    });
    const { enqueued } = await r.prewarm({
      media: { id: 'm1' },
      sizes: [
        { width: 300, height: 300 },
        { width: 100, height: 100 },
      ],
      formats: ['jpeg', 'webp'],
    });
    assert.equal(enqueued, 1);
    assert.deepEqual(
      calls[0].previews.map((p) => `${p.sizeKey}:${p.format}`),
      ['300x300:jpeg'],
    );
  });

  test('a beforeEnqueue tap that empties the set → { enqueued: 0 }, no transport call', async () => {
    installFakeApp();
    const { transport, calls } = makeTransport();
    const { lockProvider } = makeLocks(true);
    const r = new Resizer({
      storage: makeStorage(),
      transport,
      lockProvider,
      hooks: { beforeEnqueue: () => [] },
    });
    const { enqueued } = await r.prewarm({
      media: { id: 'm1' },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(enqueued, 0);
    assert.equal(calls.length, 0);
  });
});

describe('prewarm — no transport (eager-only host)', () => {
  test('warns once and returns { enqueued: 0 } without throwing', async () => {
    const { warn } = installFakeApp();
    const r = new Resizer({ storage: makeStorage() });
    const { enqueued } = await r.prewarm({
      media: { id: 'm1' },
      sizes: [
        { width: 300, height: 300 },
        { width: 100, height: 100 },
      ],
      formats: ['jpeg'],
    });
    assert.equal(enqueued, 0);
    assert.equal(warn.length, 1);
  });
});

describe('prewarm — dispatch-lock survivors only', () => {
  test('lock losers are not counted; enqueued reflects the winners handed to the transport', async () => {
    installFakeApp();
    const { transport, calls } = makeTransport();
    // Only the jpeg dispatch lock is won; the webp one is already in flight elsewhere.
    const { lockProvider } = makeLocks((key) => key.endsWith(':jpeg:none'));
    const r = new Resizer({ storage: makeStorage(), transport, lockProvider });
    const { enqueued } = await r.prewarm({
      media: { id: 'm1' },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
    });
    assert.equal(enqueued, 1);
    assert.deepEqual(
      calls[0].previews.map((p) => p.format),
      ['jpeg'],
    );
  });

  test('no lock survives → { enqueued: 0 } and the transport is not called', async () => {
    installFakeApp();
    const { transport, calls } = makeTransport();
    const { lockProvider } = makeLocks(false);
    const r = new Resizer({ storage: makeStorage(), transport, lockProvider });
    const { enqueued } = await r.prewarm({
      media: { id: 'm1' },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(enqueued, 0);
    assert.equal(calls.length, 0);
  });
});

describe('prewarm — never throws', () => {
  test('transport.enqueue throwing → { enqueued: 0 }, dispatch locks released, no reject', async () => {
    installFakeApp();
    const { transport } = makeTransport(() => {
      throw new Error('transport down');
    });
    const { lockProvider, released } = makeLocks(true);
    const r = new Resizer({ storage: makeStorage(), transport, lockProvider });
    const { enqueued } = await r.prewarm({
      media: { id: 'm1' },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(enqueued, 0);
    assert.deepEqual(released, ['resize_dispatch:m1:300x300:jpeg:none']);
  });

  test('an internal error (lockProvider.acquire throws) is caught → { enqueued: 0 }, logged', async () => {
    const { errors } = installFakeApp();
    const { transport } = makeTransport();
    const lockProvider: LockProvider = {
      acquire: async () => {
        throw new Error('lock backend down');
      },
      release: async () => {},
    };
    const r = new Resizer({ storage: makeStorage(), transport, lockProvider });
    const { enqueued } = await r.prewarm({
      media: { id: 'm1' },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(enqueued, 0);
    assert.ok(errors.length >= 1);
  });

  test('a throwing resolveSizes tap does not reject; prewarm proceeds on the prior value', async () => {
    const { errors } = installFakeApp();
    const { transport, calls } = makeTransport();
    const { lockProvider } = makeLocks(true);
    const r = new Resizer({
      storage: makeStorage(),
      transport,
      lockProvider,
      hooks: {
        resolveSizes: () => {
          throw new Error('boom');
        },
      },
    });
    const { enqueued } = await r.prewarm({
      media: { id: 'm1' },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(enqueued, 1);
    assert.equal(calls[0].previews[0].sizeKey, '300x300');
    assert.ok(errors.length >= 1);
  });

  test('media with no id/_id → logged { enqueued: 0 } (never-throw wrapper absorbs requireMediaId)', async () => {
    const { errors } = installFakeApp();
    const { transport, calls } = makeTransport();
    const { lockProvider } = makeLocks(true);
    const r = new Resizer({ storage: makeStorage(), transport, lockProvider });
    const { enqueued } = await r.prewarm({
      media: { original: { key: 'orig.jpg' } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(enqueued, 0);
    assert.equal(calls.length, 0);
    assert.ok(errors.length >= 1);
  });
});

describe('prewarm — fast-path is NOT consulted', () => {
  test('a size the original already fits still gets enqueued (generation decision, not serving)', async () => {
    installFakeApp();
    const { transport, calls } = makeTransport();
    const { lockProvider } = makeLocks(true);
    const r = new Resizer({ storage: makeStorage(), transport, lockProvider });
    const media: MediaLike = {
      id: 'm1',
      // original (200×150) fits inside the 300×300 box — resolve() would serve the original,
      // but prewarm generates the preview regardless (11 · §11.1b step 2).
      original: {
        key: 'orig.jpg',
        contentType: 'image/jpeg',
        width: 200,
        height: 150,
      },
    };
    const { enqueued } = await r.prewarm({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(enqueued, 1);
    assert.deepEqual(
      calls[0].previews.map((p) => `${p.sizeKey}:${p.format}`),
      ['300x300:jpeg'],
    );
  });
});
