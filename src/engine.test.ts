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
import { makeResizeConfig } from './testHelpers/resizeConfig.ts';
import type { MediaLike, MissingPreview, StorageRef } from './types.d.ts';

// ---------------------------------------------------------------------------
// Harness — a recording ambient app (getConfig('resize') → { mediaModelName },
// recording logger) + recording driver fakes. Engine reads logger/config via
// getApp() at CALL time, so installing the fake before each run is enough.
// ---------------------------------------------------------------------------

function installFakeApp() {
  const info: unknown[][] = [];
  const warn: unknown[][] = [];
  const errors: unknown[][] = [];
  setAppInstance({
    getConfig: () => makeResizeConfig(),
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
    // The default fake models a storage driver whose originals are public. Tests that need to
    // exercise private-original behavior override this explicitly with `false` or omit it.
    canServeOriginalPublicly: () => true,
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
// §17 read-path — ready vs missing partitioning
// ---------------------------------------------------------------------------

describe('resolve — partitioning', () => {
  test('partitions existing previews to ready and absent ones to missing', async () => {
    installFakeApp();
    const r = new Resizer({ storage: makeStorage() });
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
    const { decision } = await r.resolve({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
      enqueueMissing: false,
    });
    assert.equal(decision.ready.length, 1);
    assert.deepEqual(decision.ready[0], {
      sizeKey: '300x300',
      format: 'jpeg',
      url: 'https://cdn/p1',
      preview: media.previews?.[0],
      contentType: 'image/jpeg',
    });
    assert.equal(decision.missing.length, 1);
    assert.deepEqual(decision.missing[0], {
      sizeKey: '300x300',
      format: 'webp',
      requestedWidth: 300,
      requestedHeight: 300,
    });
  });

  test('a null original preserves cached previews, missing variants, and the formatting hook', async () => {
    const { errors } = installFakeApp();
    const { transport, calls } = makeTransport();
    const { lockProvider, acquired } = makeLocks(true);
    const r = new Resizer({
      storage: makeStorage(),
      transport,
      lockProvider,
      hooks: {
        formatPublicUrls: (decision) =>
          decision.ready.map((entry) => entry.url),
      },
    });
    // Plain/lean Mongo records can carry BSON null for this optional nested field.
    const media = {
      id: 'm1',
      original: null,
      previews: [
        {
          key: 'cached.jpg',
          contentType: 'image/jpeg',
          sizeKey: '300x300',
          format: 'jpeg',
        },
      ],
    } as unknown as MediaLike;

    const { decision, output } = await r.resolve({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
    });

    assert.equal(decision.ready.length, 1);
    assert.equal(decision.ready[0].url, 'https://cdn/cached.jpg');
    assert.deepEqual(decision.missing, [
      {
        sizeKey: '300x300',
        format: 'webp',
        requestedWidth: 300,
        requestedHeight: 300,
      },
    ]);
    assert.deepEqual(output, ['https://cdn/cached.jpg']);
    assert.equal(calls.length, 0);
    assert.equal(acquired.length, 0);
    assert.equal(errors.length, 0);
  });

  test('a throwing original visibility check behaves like a private original and later missing variants enqueue', async () => {
    const run = async (check: () => boolean) => {
      resetResizerForTests();
      resetAppInstance();
      const { errors } = installFakeApp();
      const { transport, calls } = makeTransport();
      const { lockProvider } = makeLocks(true);
      const r = new Resizer({
        storage: makeStorage({ canServeOriginalPublicly: check }),
        transport,
        lockProvider,
      });
      const { decision } = await r.resolve({
        media: {
          id: 'm1',
          original: { key: 'legacy-origin.jpg', bucket: 'retired-bucket' },
          previews: [
            {
              key: 'public-preview.jpg',
              contentType: 'image/jpeg',
              sizeKey: '300x300',
              format: 'jpeg',
            },
          ],
        },
        sizes: [
          { width: 300, height: 300 },
          { width: 100, height: 100 },
        ],
        formats: ['jpeg'],
      });
      return { calls, decision, errors };
    };

    const throwing = await run(() => {
      throw new Error('original bucket is no longer allowlisted');
    });
    const privateOriginal = await run(() => false);

    assert.deepEqual(throwing.decision, privateOriginal.decision);
    assert.equal(throwing.decision.ready.length, 1);
    assert.equal(
      throwing.decision.ready[0]?.url,
      'https://cdn/public-preview.jpg',
    );
    assert.deepEqual(
      throwing.decision.missing.map((m) => m.sizeKey),
      ['100x100'],
    );
    assert.deepEqual(throwing.calls, privateOriginal.calls);
    assert.deepEqual(
      throwing.calls[0]?.previews.map((p) => p.sizeKey),
      ['100x100'],
    );
    assert.equal(throwing.errors.length, 1);
    assert.equal(privateOriginal.errors.length, 0);
  });

  test('a filtered variant is distinct from the unfiltered same size', async () => {
    installFakeApp();
    const r = new Resizer({ storage: makeStorage() });
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
    const { decision } = await r.resolve({
      media,
      sizes: [
        { width: 300, height: 300 },
        { width: 300, height: 300, filters: { blur: 40 } },
      ],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.equal(decision.ready.length, 1);
    assert.equal(decision.ready[0].url, 'https://cdn/p1');
    assert.equal(decision.missing.length, 1);
    assert.deepEqual(decision.missing[0], {
      sizeKey: '300x300',
      format: 'jpeg',
      filters: { blur: 40 },
      requestedWidth: 300,
      requestedHeight: 300,
    });
  });

  test('a getSizeKey-throwing size is skipped; others are processed', async () => {
    installFakeApp();
    const r = new Resizer({ storage: makeStorage() });
    const { decision } = await r.resolve({
      media: { id: 'm1' },
      sizes: [{}, { width: 300, height: 300 }],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.equal(decision.ready.length, 0);
    assert.equal(decision.missing.length, 1);
    assert.equal(decision.missing[0].sizeKey, '300x300');
  });
});

// ---------------------------------------------------------------------------
// §17 read-path — hooks (resolveSizes / formatPublicUrls / beforeEnqueue)
// ---------------------------------------------------------------------------

describe('resolve — waterfall hooks', () => {
  test('resolveSizes tap expands the size list fed to the loop', async () => {
    installFakeApp();
    const r = new Resizer({
      storage: makeStorage(),
      hooks: {
        resolveSizes: () => [
          { width: 100, height: 100 },
          { width: 200, height: 200 },
        ],
      },
    });
    const { decision } = await r.resolve({
      media: { id: 'm1' },
      sizes: [],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.equal(decision.missing.length, 2);
    assert.deepEqual(decision.missing.map((m) => m.sizeKey).sort(), [
      '100x100',
      '200x200',
    ]);
  });

  test('formatPublicUrls tap output is returned as `output`', async () => {
    installFakeApp();
    const r = new Resizer({
      storage: makeStorage(),
      hooks: { formatPublicUrls: () => ({ shaped: true }) },
    });
    const { decision, output } = await r.resolve({
      media: { id: 'm1' },
      sizes: [],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.deepEqual(output, { shaped: true });
    assert.deepEqual(decision, { ready: [], missing: [] });
  });

  test('with no formatPublicUrls tap, output === undefined', async () => {
    installFakeApp();
    const r = new Resizer({ storage: makeStorage() });
    const { decision, output } = await r.resolve({
      media: { id: 'm1' },
      sizes: [],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.deepEqual(decision, { ready: [], missing: [] });
    assert.equal(output, undefined);
  });

  test('a throwing formatPublicUrls tap yields output === undefined (does not leak the decision)', async () => {
    const { errors } = installFakeApp();
    const r = new Resizer({
      storage: makeStorage(),
      hooks: {
        formatPublicUrls: () => {
          throw new Error('dto boom');
        },
      },
    });
    const { decision, output } = await r.resolve({
      media: { id: 'm1' },
      sizes: [],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.deepEqual(decision, { ready: [], missing: [] });
    assert.equal(output, undefined);
    assert.ok(errors.length >= 1);
  });

  test('a throwing beforeEnqueue tap is skipped (missing kept intact)', async () => {
    const { errors } = installFakeApp();
    const r = new Resizer({
      storage: makeStorage(),
      hooks: {
        beforeEnqueue: () => {
          throw new Error('boom');
        },
      },
    });
    const { decision } = await r.resolve({
      media: { id: 'm1' },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.equal(decision.missing.length, 1);
    assert.ok(errors.length >= 1);
  });
});

// ---------------------------------------------------------------------------
// §17 step 9 → §18 — enqueue wiring
// ---------------------------------------------------------------------------

describe('resolve — enqueue wiring', () => {
  test('threads the pipeline name and enqueues only the missing variants', async () => {
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
    await r.resolve({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
      pipeline: 'photo',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mediaId, 'm1');
    assert.equal(calls[0].pipeline, 'photo');
    assert.deepEqual(
      calls[0].previews.map((p) => `${p.sizeKey}:${p.format}`),
      ['300x300:webp'],
    );
  });

  test('nothing is enqueued when nothing is missing', async () => {
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
    await r.resolve({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(calls.length, 0);
  });

  test('uses String(media._id) for the dispatch lock when id is absent', async () => {
    installFakeApp();
    const { transport } = makeTransport();
    const { lockProvider, acquired } = makeLocks(true);
    const r = new Resizer({ storage: makeStorage(), transport, lockProvider });
    await r.resolve({
      media: {
        _id: { toString: () => 'abc123' },
        original: { key: 'orig.jpg' },
      },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(acquired.length, 1);
    assert.equal(acquired[0].key, 'resize_dispatch:abc123:300x300:jpeg:none');
  });

  test('resolve does not throw when transport.enqueue throws; survivor locks released', async () => {
    installFakeApp();
    const { transport } = makeTransport(() => {
      throw new Error('transport down');
    });
    const { lockProvider, released } = makeLocks(true);
    const r = new Resizer({ storage: makeStorage(), transport, lockProvider });
    const { decision } = await r.resolve({
      media: { id: 'm1', original: { key: 'orig.jpg' } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(decision.missing.length, 1);
    assert.deepEqual(released, ['resize_dispatch:m1:300x300:jpeg:none']);
  });

  test('resolve does not throw when transport returns taskId null; locks released', async () => {
    installFakeApp();
    const { transport } = makeTransport(() => ({ taskId: null }));
    const { lockProvider, released } = makeLocks(true);
    const r = new Resizer({ storage: makeStorage(), transport, lockProvider });
    await r.resolve({
      media: { id: 'm1', original: { key: 'orig.jpg' } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.deepEqual(released, ['resize_dispatch:m1:300x300:jpeg:none']);
  });

  test('an original without a key leaves variants missing without enqueueing or locking', async () => {
    const { info } = installFakeApp();
    const { transport, calls } = makeTransport();
    const { lockProvider, acquired } = makeLocks(true);
    const r = new Resizer({ storage: makeStorage(), transport, lockProvider });
    const { decision } = await r.resolve({
      media: { id: 'm1', original: {} as MediaLike['original'] },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(decision.missing.length, 1);
    assert.equal(calls.length, 0);
    assert.equal(acquired.length, 0);
    assert.equal(info.length, 1);
  });

  test('an absent original leaves variants missing without enqueueing or locking', async () => {
    const { info } = installFakeApp();
    const { transport, calls } = makeTransport();
    const { lockProvider, acquired } = makeLocks(true);
    const r = new Resizer({ storage: makeStorage(), transport, lockProvider });
    const { decision } = await r.resolve({
      media: { id: 'm1' },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(decision.missing.length, 1);
    assert.equal(calls.length, 0);
    assert.equal(acquired.length, 0);
    assert.equal(info.length, 1);
  });
});

describe('prewarm — missing original key', () => {
  test('returns zero without enqueueing or locking', async () => {
    const { info } = installFakeApp();
    const { transport, calls } = makeTransport();
    const { lockProvider, acquired } = makeLocks(true);
    const r = new Resizer({ storage: makeStorage(), transport, lockProvider });
    const result = await r.prewarm({
      media: { id: 'm1', original: {} as MediaLike['original'] },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.deepEqual(result, { enqueued: 0 });
    assert.equal(calls.length, 0);
    assert.equal(acquired.length, 0);
    assert.equal(info.length, 1);
  });
});

// ---------------------------------------------------------------------------
// §17 step 9 — no transport on the instance
// ---------------------------------------------------------------------------

describe('resolve — no transport (eager-only host)', () => {
  test('defaults enqueueMissing to false: missing intact, no warn', async () => {
    const { warn } = installFakeApp();
    const r = new Resizer({ storage: makeStorage() });
    const { decision } = await r.resolve({
      media: { id: 'm1' },
      sizes: [
        { width: 300, height: 300 },
        { width: 100, height: 100 },
      ],
      formats: ['jpeg'],
    });
    assert.equal(decision.missing.length, 2);
    assert.equal(warn.length, 0);
  });

  test('explicit enqueueMissing:true with no transport still warns once', async () => {
    const { warn } = installFakeApp();
    const r = new Resizer({ storage: makeStorage() });
    const { decision } = await r.resolve({
      media: { id: 'm1', original: { key: 'orig.jpg' } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
      enqueueMissing: true,
    });
    assert.equal(decision.missing.length, 1);
    assert.equal(warn.length, 1);
  });
});

// ---------------------------------------------------------------------------
// §17 step 6 — SVG pass-through
// ---------------------------------------------------------------------------

describe('resolve — SVG pass-through', () => {
  test('serves the original at every size×format, missing empty, no transport call', async () => {
    installFakeApp();
    const { transport, calls } = makeTransport();
    const { lockProvider } = makeLocks(true);
    const r = new Resizer({ storage: makeStorage(), transport, lockProvider });
    const media: MediaLike = {
      id: 'm1',
      original: { key: 'logo.svg', contentType: 'image/svg+xml' },
    };
    const { decision } = await r.resolve({
      media,
      sizes: [
        { width: 300, height: 300 },
        { width: 100, height: 100 },
      ],
      formats: ['jpeg', 'webp'],
    });
    assert.equal(decision.ready.length, 4);
    assert.equal(decision.missing.length, 0);
    assert.equal(calls.length, 0);
    for (const entry of decision.ready) {
      assert.equal(entry.url, 'https://cdn/logo.svg');
      assert.equal(entry.isOriginal, true);
      assert.equal(entry.preview, undefined);
    }
    // requested format recorded, but never used to pick a raster preview
    assert.deepEqual(decision.ready.map((e) => e.format).sort(), [
      'jpeg',
      'jpeg',
      'webp',
      'webp',
    ]);
  });

  test('a private SVG served to an owner uses signedUrl (same original-URL rule as the fast-path)', async () => {
    installFakeApp();
    const storage = makeStorage({
      signedUrl: async (ref, ttl) => `https://signed/${ref.key}?ttl=${ttl}`,
    });
    const r = new Resizer({ storage });
    const media: MediaLike = {
      id: 'm1',
      original: { key: 'private/logo.svg', contentType: 'image/svg+xml' },
    };
    const owned = await r.resolve({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
      ctx: { isOwner: true },
      enqueueMissing: false,
    });
    assert.equal(
      owned.decision.ready[0].url,
      'https://signed/private/logo.svg?ttl=300',
    );
    // No owner ctx → the pure public URL.
    const anon = await r.resolve({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.equal(anon.decision.ready[0].url, 'https://cdn/private/logo.svg');
  });

  test('serves a public SVG copy while keeping the original private', async () => {
    installFakeApp();
    let signedCalls = 0;
    const r = new Resizer({
      storage: makeStorage({
        canServeOriginalPublicly: (ref) => ref.bucket === 'public',
        signedUrl: async () => {
          signedCalls++;
          return 'https://signed/private.svg';
        },
      }),
    });
    const media: MediaLike = {
      id: 'm1',
      original: {
        key: 'private/logo.svg',
        bucket: 'private',
        contentType: 'image/svg+xml',
        publicCopy: { key: 'published/logo.svg', bucket: 'public' },
      },
    };
    for (const ctx of [{}, { isOwner: true }]) {
      const { decision } = await r.resolve({
        media,
        sizes: [{ width: 300, height: 300 }, { fit: true }],
        formats: ['jpeg', 'webp'],
        ctx,
      });
      assert.equal(decision.ready.length, 4);
      assert.deepEqual(decision.missing, []);
      for (const entry of decision.ready) {
        assert.equal(entry.url, 'https://cdn/published/logo.svg');
        assert.equal(entry.contentType, 'image/svg+xml');
      }
    }
    assert.equal(signedCalls, 0);
    assert.equal(media.original?.key, 'private/logo.svg');
  });

  test('does not expose a supposed SVG copy unless storage proves it is public', async () => {
    installFakeApp();
    const r = new Resizer({
      storage: makeStorage({
        canServeOriginalPublicly: (ref) => ref.bucket === 'public',
      }),
    });
    const { decision } = await r.resolve({
      media: {
        id: 'm1',
        original: {
          key: 'private/logo.svg',
          bucket: 'private',
          format: 'svg',
          publicCopy: { key: 'wrong/logo.svg', bucket: 'private' },
        },
      },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.deepEqual(decision.ready, []);
    assert.equal(decision.missing.length, 1);
  });

  test('detects SVG via original.format === "svg" too', async () => {
    installFakeApp();
    const r = new Resizer({ storage: makeStorage() });
    const media: MediaLike = {
      id: 'm1',
      original: { key: 'logo', format: 'svg' },
    };
    const { decision } = await r.resolve({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.equal(decision.ready.length, 1);
    assert.equal(decision.ready[0].isOriginal, true);
    assert.equal(decision.ready[0].url, 'https://cdn/logo');
    assert.equal(decision.missing.length, 0);
  });

  test('a private SVG is missing for anonymous reads and queues publication work', async () => {
    installFakeApp();
    const { transport, calls } = makeTransport();
    const { lockProvider } = makeLocks(true);
    const r = new Resizer({
      storage: makeStorage({ canServeOriginalPublicly: () => false }),
      transport,
      lockProvider,
    });
    const { decision } = await r.resolve({
      media: {
        id: 'm1',
        original: { key: 'private/logo.svg', contentType: 'image/svg+xml' },
      },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
    });
    assert.deepEqual(decision.ready, []);
    assert.equal(decision.missing.length, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].previews.length, 2);
  });
});

// ---------------------------------------------------------------------------
// §17 step 7 — "original already fits" fast-path
// ---------------------------------------------------------------------------

describe('resolve — original-fits fast-path', () => {
  const fitsMedia = (): MediaLike => ({
    id: 'm1',
    original: {
      key: 'orig.jpg',
      contentType: 'image/jpeg',
      width: 200,
      height: 150,
    },
  });

  test('serves the original (isOriginal, no preview) when it fits both dims', async () => {
    installFakeApp();
    const r = new Resizer({ storage: makeStorage() });
    const { decision } = await r.resolve({
      media: fitsMedia(),
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.equal(decision.missing.length, 0);
    assert.equal(decision.ready.length, 1);
    assert.deepEqual(decision.ready[0], {
      sizeKey: '300x300',
      format: 'jpeg',
      url: 'https://cdn/orig.jpg',
      isOriginal: true,
      contentType: 'image/jpeg',
    });
  });

  test('does NOT fire when only one dim fits — becomes missing', async () => {
    installFakeApp();
    const r = new Resizer({ storage: makeStorage() });
    const media: MediaLike = {
      id: 'm1',
      original: { key: 'orig.jpg', width: 200, height: 400 },
    };
    const { decision } = await r.resolve({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.equal(decision.ready.length, 0);
    assert.equal(decision.missing.length, 1);
  });

  test('does NOT fire when filters are present — becomes missing', async () => {
    installFakeApp();
    const r = new Resizer({ storage: makeStorage() });
    const media: MediaLike = {
      id: 'm1',
      original: { key: 'orig.jpg', width: 100, height: 100 },
    };
    const { decision } = await r.resolve({
      media,
      sizes: [{ width: 300, height: 300, filters: { blur: 40 } }],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.equal(decision.ready.length, 0);
    assert.equal(decision.missing.length, 1);
    assert.deepEqual(decision.missing[0].filters, { blur: 40 });
  });

  test('does NOT fire for a width-only size — becomes missing', async () => {
    installFakeApp();
    const r = new Resizer({ storage: makeStorage() });
    const media: MediaLike = {
      id: 'm1',
      original: { key: 'orig.jpg', width: 100, height: 100 },
    };
    const { decision } = await r.resolve({
      media,
      sizes: [{ width: 300 }],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.equal(decision.ready.length, 0);
    assert.equal(decision.missing.length, 1);
    assert.equal(decision.missing[0].sizeKey, '300w');
  });

  test('does NOT fire when original dims are unknown — becomes missing', async () => {
    installFakeApp();
    const r = new Resizer({ storage: makeStorage() });
    const media: MediaLike = {
      id: 'm1',
      original: { key: 'orig.jpg', contentType: 'image/jpeg' },
    };
    const { decision } = await r.resolve({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.equal(decision.ready.length, 0);
    assert.equal(decision.missing.length, 1);
  });

  test('uses signedUrl for an owner/admin when the driver supports it', async () => {
    installFakeApp();
    const signedCalls: { ref: StorageRef; ttl: number }[] = [];
    const storage = makeStorage({
      signedUrl: async (ref, ttl) => {
        signedCalls.push({ ref, ttl });
        return `https://signed/${ref.key}?ttl=${ttl}`;
      },
    });
    const r = new Resizer({ storage });
    const { decision } = await r.resolve({
      media: fitsMedia(),
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
      ctx: { isOwner: true },
      enqueueMissing: false,
    });
    assert.equal(decision.ready.length, 1);
    assert.equal(decision.ready[0].isOriginal, true);
    assert.match(decision.ready[0].url, /^https:\/\/signed\/orig\.jpg/);
    assert.equal(signedCalls.length, 1);
    assert.equal(signedCalls[0].ref.key, 'orig.jpg');
  });

  test('falls back to publicUrl when signedUrl throws for a public original', async () => {
    installFakeApp();
    const storage = makeStorage({
      signedUrl: async () => {
        throw new Error('presign down');
      },
    });
    const r = new Resizer({ storage });
    const { decision } = await r.resolve({
      media: fitsMedia(),
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
      ctx: { isAdmin: true },
      enqueueMissing: false,
    });
    assert.equal(decision.ready.length, 1);
    assert.equal(decision.ready[0].url, 'https://cdn/orig.jpg');
    assert.equal(decision.ready[0].isOriginal, true);
  });

  test('a private raster original stays missing for an anonymous reader', async () => {
    installFakeApp();
    const r = new Resizer({
      storage: makeStorage({ canServeOriginalPublicly: () => false }),
    });
    const { decision } = await r.resolve({
      media: fitsMedia(),
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.equal(decision.ready.length, 0);
    assert.equal(decision.missing.length, 1);
    assert.equal(decision.missing[0].sizeKey, '300x300');
  });

  test('a private original does not fall back to publicUrl when signing fails', async () => {
    installFakeApp();
    let publicUrlCalls = 0;
    const r = new Resizer({
      storage: makeStorage({
        canServeOriginalPublicly: () => false,
        signedUrl: async () => {
          throw new Error('presign down');
        },
        publicUrl: (ref: StorageRef) => {
          publicUrlCalls += 1;
          return `https://cdn/${ref.key}`;
        },
      }),
    });
    const { decision } = await r.resolve({
      media: fitsMedia(),
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
      ctx: { isAdmin: true },
      enqueueMissing: false,
    });
    assert.equal(decision.ready.length, 0);
    assert.equal(decision.missing.length, 1);
    assert.equal(publicUrlCalls, 0);
  });

  test('a custom storage without canServeOriginalPublicly has no original fast-path', async () => {
    installFakeApp();
    const storage: ResizeStorage = {
      download: async () => Buffer.alloc(0),
      upload: async () => ({ key: 'k' }),
      publicUrl: (ref: StorageRef) => `https://cdn/${ref.key}`,
    };
    const r = new Resizer({ storage });
    const { decision } = await r.resolve({
      media: fitsMedia(),
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.equal(decision.ready.length, 0);
    assert.equal(decision.missing.length, 1);
  });
});

// ---------------------------------------------------------------------------
// §17 never-throw guarantee
// ---------------------------------------------------------------------------

describe('resolve — never throws', () => {
  test('a mid-loop storage.publicUrl throw yields the safe value (ready-so-far, empty missing)', async () => {
    const { errors } = installFakeApp();
    const storage = makeStorage({
      publicUrl: (ref: StorageRef) => {
        if (ref.key === 'p2') {
          throw new Error('cdn boom');
        }
        return `https://cdn/${ref.key}`;
      },
    });
    const r = new Resizer({ storage });
    const media: MediaLike = {
      id: 'm1',
      previews: [
        {
          key: 'p1',
          contentType: 'image/jpeg',
          sizeKey: '300x300',
          format: 'jpeg',
        },
        {
          key: 'p2',
          contentType: 'image/jpeg',
          sizeKey: '100x100',
          format: 'jpeg',
        },
      ],
    };
    const { decision, output } = await r.resolve({
      media,
      sizes: [
        { width: 300, height: 300 },
        { width: 100, height: 100 },
      ],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.equal(decision.ready.length, 1);
    assert.equal(decision.ready[0].url, 'https://cdn/p1');
    assert.equal(decision.missing.length, 0);
    assert.equal(output, undefined);
    assert.ok(errors.length >= 1);
  });

  test('media with no id/_id → logged safe empty decision (never-throw wrapper absorbs requireMediaId)', async () => {
    const { errors } = installFakeApp();
    const r = new Resizer({ storage: makeStorage() });
    const { decision, output } = await r.resolve({
      media: { original: { key: 'orig.jpg', contentType: 'image/jpeg' } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.deepEqual(decision, { ready: [], missing: [] });
    assert.equal(output, undefined);
    assert.ok(errors.length >= 1);
  });
});
