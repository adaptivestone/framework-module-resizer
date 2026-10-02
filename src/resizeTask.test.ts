// Worker core tests (07 · Worker + 11 · Modes). Real sharp on tiny in-memory fixtures
// generated with sharp itself; fakes for storage / mediaStore / lockProvider / transport.
// Fresh Resizer + fake ambient app per test (node:test = per-file process isolation).
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import sharp from 'sharp';
import type { LockStore } from './contracts/lockStore.ts';
import type { MediaStore } from './contracts/mediaStore.ts';
import {
  ResizeConfigError,
  ResizeGenerateError,
  ResizeNoOriginalError,
  ResizeSetupError,
} from './errors.ts';
import ResizeWorker from './framework/ResizeWorkerCommand.ts';
import { createFrameworkResizer } from './framework/resizer.ts';
import { runResizeWorker } from './framework/worker.ts';
import {
  type LeasedTask,
  type Pipeline,
  type QueueTransport,
  Resizer,
  type ResizeStorage,
  resetResizerForTests,
  type StartWorkerOpts,
} from './resizer.ts';
import { makeResizeConfig } from './testHelpers/resizeConfig.ts';
import { withLocks } from './testHelpers/withLocks.ts';
import type {
  MediaLike,
  MissingPreview,
  Original,
  Preview,
} from './types.d.ts';
import { processTask, runWorker } from './worker.ts';

// ---------------------------------------------------------------------------
// Fixtures — built ONCE with sharp. redPng (opaque), alphaPng (fully transparent),
// orientedJpeg (64×48 stored, EXIF orientation 6 → DISPLAY 48×64). EXIF orientation can
// only be written on jpeg, so orientation cases use jpeg fixtures.
// ---------------------------------------------------------------------------

const redPng = await sharp({
  create: {
    width: 64,
    height: 48,
    channels: 3,
    background: { r: 255, g: 0, b: 0 },
  },
})
  .png()
  .toBuffer();

const alphaPng = await sharp({
  create: {
    width: 40,
    height: 30,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .png()
  .toBuffer();

const smallSvg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
);

const orientedJpeg = await sharp({
  create: {
    width: 64,
    height: 48,
    channels: 3,
    background: { r: 0, g: 128, b: 255 },
  },
})
  .jpeg()
  .withMetadata({ orientation: 6 })
  .toBuffer();

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function installApp(configOverride: Record<string, unknown> = {}): {
  logs: { info: unknown[][]; warn: unknown[][]; error: unknown[][] };
  getModelCalls: () => number;
} {
  let modelCalls = 0;
  const logs = {
    info: [] as unknown[][],
    warn: [] as unknown[][],
    error: [] as unknown[][],
  };
  setAppInstance({
    getConfig: () => makeResizeConfig(configOverride),
    getModel: () => {
      modelCalls += 1;
      return {};
    },
    logger: {
      info(...a: unknown[]) {
        logs.info.push(a);
      },
      warn(...a: unknown[]) {
        logs.warn.push(a);
      },
      error(...a: unknown[]) {
        logs.error.push(a);
      },
    },
  } as never);
  return { logs, getModelCalls: () => modelCalls };
}

type Upload = {
  key: string;
  body: Buffer;
  contentType: string;
  visibility: string;
};

function makeStorage(
  fixture: Buffer,
  onUpload?: () => void,
): { storage: ResizeStorage; uploads: Upload[] } {
  const uploads: Upload[] = [];
  const storage: ResizeStorage = {
    download: async () => fixture,
    upload: async ({ key, body, contentType, visibility }) => {
      uploads.push({ key, body: Buffer.from(body), contentType, visibility });
      onUpload?.();
      return { bucket: 'previews', key };
    },
    publicUrl: (ref) => `https://cdn/${ref.key}`,
    canServeOriginalPublicly: (ref) => ref.bucket === 'previews',
  };
  return { storage, uploads };
}

function makeMediaStore(media: MediaLike | null): {
  mediaStore: MediaStore;
  appendCalls: Array<{
    mediaId: string;
    previews: Preview[];
    backfillDims?: { width: number; height: number };
  }>;
} {
  const appendCalls: Array<{
    mediaId: string;
    previews: Preview[];
    backfillDims?: { width: number; height: number };
  }> = [];
  const mediaStore: MediaStore = {
    load: async () => media,
    appendPreviews: async (mediaId, previews, backfillDims) => {
      appendCalls.push({ mediaId, previews, backfillDims });
    },
  };
  return { mediaStore, appendCalls };
}

function makeLocks(acquire: boolean | ((key: string) => boolean) = true): {
  lockProvider: LockStore;
  acquired: string[];
  released: string[];
} {
  const acquired: string[] = [];
  const released: string[] = [];
  const lockProvider: LockStore = {
    acquire: async (key) => {
      acquired.push(key);
      return typeof acquire === 'function' ? acquire(key) : acquire;
    },
    release: async (key) => {
      released.push(key);
    },
  };
  return { lockProvider, acquired, released };
}

function mediaDoc(
  over: {
    original?: Partial<Original>;
    previews?: Preview[];
    id?: string;
  } = {},
): MediaLike {
  return {
    id: over.id ?? 'm1',
    original: {
      storageRef: { key: 'uploads/orig' },
      ...(over.original ?? {}),
    } as Original,
    previews: over.previews ?? [],
  };
}

const task = (over: Partial<LeasedTask> = {}): LeasedTask => ({
  taskId: 't1',
  resizer: 'default',
  queue: 'default',
  mediaId: 'm1',
  pipeline: 'default',
  previews: [],
  ...over,
});

const variant = (over: Partial<MissingPreview> = {}): MissingPreview => ({
  sizeKey: '20x20',
  format: 'jpeg',
  requestedWidth: 20,
  requestedHeight: 20,
  ...over,
});

const fitVariant: MissingPreview = {
  sizeKey: 'fit',
  format: 'jpeg',
  fit: true,
};

afterEach(() => {
  resetResizerForTests();
  resetAppInstance();
});

// ---------------------------------------------------------------------------
// processTask — download / metadata / beforeSteps
// ---------------------------------------------------------------------------

describe('processTask — source handling', () => {
  test('no media doc → logged no-op success (nothing uploaded)', async () => {
    installApp();
    const { storage, uploads } = makeStorage(redPng);
    const { mediaStore, appendCalls } = makeMediaStore(null);
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
    });
    await processTask(task({ previews: [variant()] }));
    assert.equal(uploads.length, 0);
    assert.equal(appendCalls.length, 0);
  });

  test('persisted original without a key → ResizeNoOriginalError before download', async () => {
    installApp();
    const base = makeStorage(redPng);
    let downloadCalls = 0;
    const storage: ResizeStorage = {
      ...base.storage,
      download: async () => {
        downloadCalls += 1;
        return redPng;
      },
    };
    const { mediaStore } = makeMediaStore({
      id: 'm1',
      original: {},
      previews: [],
    } as MediaLike);
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
    });
    await assert.rejects(
      () => processTask(task({ previews: [variant()] })),
      (err: unknown) => {
        assert.ok(err instanceof ResizeNoOriginalError);
        assert.equal(err.code, 'RESIZE_NO_ORIGINAL');
        assert.equal(err.mediaId, 'm1');
        return true;
      },
    );
    assert.equal(downloadCalls, 0);
  });

  test('SVG original → raster preview persisted by the normal worker', async () => {
    installApp();
    const { storage, uploads } = makeStorage(smallSvg);
    const { mediaStore, appendCalls } = makeMediaStore(
      mediaDoc({
        original: {
          storageRef: { key: 'uploads/x.svg' },
          contentType: 'image/svg+xml',
        },
      }),
    );
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
    });
    await processTask(
      task({
        previews: [
          variant({
            sizeKey: '200x200',
            requestedWidth: 200,
            requestedHeight: 200,
          }),
        ],
      }),
    );
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].visibility, 'public');
    assert.equal(uploads[0].contentType, 'image/jpeg');
    assert.equal((await sharp(uploads[0].body).metadata()).width, 200);
    assert.equal(appendCalls.length, 1);
    assert.equal(appendCalls[0].previews[0].format, 'jpeg');
  });

  test('an undecodable source → throws (fails the task for retry/DLQ)', async () => {
    installApp();
    const { storage } = makeStorage(
      Buffer.from('this is definitely not an image'),
    );
    const { mediaStore } = makeMediaStore(mediaDoc());
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
    });
    await assert.rejects(() => processTask(task({ previews: [variant()] })));
  });

  test('sourcePixels guard → throws before any decode/upload', async () => {
    installApp({ limits: { sourcePixels: 10 } }); // redPng is 64×48 = 3072 px
    const { storage, uploads } = makeStorage(redPng);
    const { mediaStore } = makeMediaStore(mediaDoc());
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
    });
    await assert.rejects(
      () => processTask(task({ previews: [variant()] })),
      /sourcePixels/,
    );
    assert.equal(uploads.length, 0);
  });

  test('inputPixels < source → rejected consistently at the guarded decode (orientation-6 source)', async () => {
    // inputPixels below the source pixel count, but sourcePixels stays huge (default) so the
    // sourcePixels guard does NOT catch it — every worker sharp() call must carry
    // limitInputPixels (01 · §16), so the guarded metadata/normalize decode rejects it.
    installApp({ limits: { inputPixels: 100 } }); // orientedJpeg 64×48 = 3072 px > 100
    const { storage, uploads } = makeStorage(orientedJpeg);
    const { mediaStore, appendCalls } = makeMediaStore(mediaDoc());
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
    });
    await assert.rejects(
      () => processTask(task({ previews: [variant()] })),
      /pixel limit/i,
    );
    assert.equal(uploads.length, 0);
    assert.equal(appendCalls.length, 0);
  });

  test('beforeSteps run ONCE and see DISPLAY-orientation pixels (orientation-6 source)', async () => {
    installApp();
    const { storage } = makeStorage(orientedJpeg);
    let calls = 0;
    const seenDims: Array<{ w?: number; h?: number }> = [];
    const pipeline: Pipeline = {
      beforeSteps: [
        async (buf) => {
          calls += 1;
          const m = await sharp(buf).metadata();
          seenDims.push({ w: m.width, h: m.height });
          return buf;
        },
      ],
    };
    const { mediaStore } = makeMediaStore(mediaDoc());
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
      pipelines: { default: pipeline },
    });
    await processTask(task({ previews: [variant()] }));
    assert.equal(calls, 1);
    assert.deepEqual(seenDims, [{ w: 48, h: 64 }]); // swapped → display orientation
  });

  test('a beforeStep that round-trips sharp().toBuffer() keeps final orientation', async () => {
    installApp();
    const { storage, uploads } = makeStorage(orientedJpeg);
    const pipeline: Pipeline = {
      // NO .rotate() here — the EXIF-strip hazard: only safe because orientation is normalized
      // ONCE before beforeSteps, so the pixels are already display-oriented + EXIF-free.
      beforeSteps: [async (buf) => sharp(buf).toBuffer()],
    };
    const { mediaStore } = makeMediaStore(mediaDoc());
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
      pipelines: { default: pipeline },
    });
    await processTask(task({ previews: [fitVariant] }));
    const m = await sharp(uploads[0].body).metadata();
    assert.equal(m.width, 48);
    assert.equal(m.height, 64); // still portrait, not sideways
  });
});

// ---------------------------------------------------------------------------
// processTask — per-variant resize / encode / persist
// ---------------------------------------------------------------------------

describe('processTask — variants', () => {
  test('skips an existing preview and releases its dispatch lock', async () => {
    installApp();
    const { storage, uploads } = makeStorage(redPng);
    const existing = {
      sizeKey: '20x20',
      format: 'jpeg',
      storageRef: { key: 'e' },
      contentType: 'image/jpeg',
    } as unknown as Preview;
    const { mediaStore, appendCalls } = makeMediaStore(
      mediaDoc({ previews: [existing] }),
    );
    const { lockProvider, released } = makeLocks(true);
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, lockProvider),
    });
    await processTask(task({ previews: [variant()] }));
    assert.equal(uploads.length, 0);
    assert.equal(appendCalls.length, 0);
    assert.deepEqual(released, [
      'resize_dispatch:m1:default:default:20x20:jpeg:none',
    ]);
  });

  test('worker lock not acquired → variant skipped, still missing, not persisted', async () => {
    installApp();
    const { storage, uploads } = makeStorage(redPng);
    const { mediaStore, appendCalls } = makeMediaStore(mediaDoc());
    const { lockProvider, acquired } = makeLocks(false); // acquire always fails
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, lockProvider),
    });
    await assert.rejects(
      () => processTask(task({ previews: [variant()] })),
      /incomplete/,
    );
    assert.deepEqual(acquired, [
      'resize_worker:m1:default:default:20x20:jpeg:none',
    ]);
    assert.equal(uploads.length, 0);
    assert.equal(appendCalls.length, 0);
  });

  test('a rejecting worker-lock acquire skips only that variant; others generate + persist + release', async () => {
    installApp();
    const { storage, uploads } = makeStorage(redPng);
    const { mediaStore, appendCalls } = makeMediaStore(mediaDoc());
    const released: string[] = [];
    const lockProvider: LockStore = {
      // The webp worker-lock acquire REJECTS — treated exactly like a not-acquired lock: skip the
      // variant (leave it missing), never reject the pool or skip persist/finally. The jpeg variant
      // is unaffected: generated, persisted, and its locks released (1.2a).
      acquire: async (key: string) => {
        if (key === 'resize_worker:m1:default:default:20x20:webp:none') {
          throw new Error('lock backend down');
        }
        return true;
      },
      release: async (key: string) => {
        released.push(key);
      },
    };
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, lockProvider),
    });
    await assert.rejects(
      () =>
        processTask(
          task({ previews: [variant(), variant({ format: 'webp' })] }),
        ),
      /incomplete/,
    );
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].key.split('.').pop(), 'jpeg');
    assert.equal(appendCalls.length, 1);
    assert.deepEqual(
      appendCalls[0].previews.map((p) => p.format),
      ['jpeg'],
    );
    assert.ok(
      released.includes('resize_worker:m1:default:default:20x20:jpeg:none'),
    );
    assert.ok(
      released.includes('resize_dispatch:m1:default:default:20x20:jpeg:none'),
    );
  });

  test('variantSteps receive { variant } (with filters) and run in registration order', async () => {
    installApp();
    const { storage } = makeStorage(redPng);
    const order: number[] = [];
    let seenFilters: unknown;
    const pipeline: Pipeline = {
      variantSteps: [
        async (img) => {
          order.push(1);
          return img;
        },
        async (img, { variant: v }) => {
          order.push(2);
          seenFilters = v.filters;
          return img;
        },
      ],
    };
    const { mediaStore } = makeMediaStore(mediaDoc());
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
      pipelines: { default: pipeline },
    });
    await processTask(task({ previews: [variant({ filters: { blur: 3 } })] }));
    assert.deepEqual(order, [1, 2]);
    assert.deepEqual(seenFilters, { blur: 3 });
  });

  test('a filtered variant produces a distinct preview row (filters persisted)', async () => {
    installApp();
    const { storage, uploads } = makeStorage(redPng);
    const pipeline: Pipeline = {
      variantSteps: [
        async (img, { variant: v }) =>
          v.filters?.blur ? img.blur(Number(v.filters.blur)) : img,
      ],
    };
    const { mediaStore, appendCalls } = makeMediaStore(mediaDoc());
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
      pipelines: { default: pipeline },
    });
    await processTask(
      task({
        previews: [variant(), variant({ filters: { blur: 5 } })],
      }),
    );
    assert.equal(uploads.length, 2);
    assert.equal(appendCalls.length, 1);
    assert.equal(appendCalls[0].previews.length, 2);
    const filtered = appendCalls[0].previews.find((p) => p.filters);
    assert.deepEqual(filtered?.filters, { blur: 5 });
  });

  test('per-format encode: bodies really are jpeg/webp/avif; dims + contentType from encoded info', async () => {
    installApp();
    const { storage, uploads } = makeStorage(redPng);
    const { mediaStore, appendCalls } = makeMediaStore(mediaDoc());
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
    });
    await processTask(
      task({
        previews: [
          variant({ format: 'jpeg' }),
          variant({ format: 'webp' }),
          variant({ format: 'avif' }),
        ],
      }),
    );
    const byExt = Object.fromEntries(
      uploads.map((u) => [u.key.split('.').pop() as string, u]),
    );
    assert.equal((await sharp(byExt.jpeg.body).metadata()).format, 'jpeg');
    assert.equal((await sharp(byExt.webp.body).metadata()).format, 'webp');
    // sharp reads AVIF back as its HEIF container ('heif' + compression 'av1') — this
    // proves the body really is AVIF-encoded.
    const avifMeta = await sharp(byExt.avif.body).metadata();
    assert.equal(avifMeta.format, 'heif');
    assert.equal(avifMeta.compression, 'av1');
    // contentType from the ACTUAL encoded info.format — with the one container
    // normalization: 'heif' from the AVIF encoder → the registered web type image/avif
    // (browser <picture type="image/avif"> negotiation breaks on image/heif).
    assert.equal(byExt.jpeg.contentType, 'image/jpeg');
    assert.equal(byExt.webp.contentType, 'image/webp');
    assert.equal(byExt.avif.contentType, 'image/avif');
    // The persisted row keeps format 'avif' (identity/encoder) with contentType image/avif.
    const avifRow = appendCalls[0].previews.find((p) => p.format === 'avif');
    assert.equal(avifRow?.format, 'avif');
    assert.equal(avifRow?.contentType, 'image/avif');
    // actualWidth/Height from encoded info — 20×20 cover on a 64×48 source.
    for (const p of appendCalls[0].previews) {
      assert.equal(p.actualWidth, 20);
      assert.equal(p.actualHeight, 20);
    }
  });

  test('encodes a TIFF selected and configured without a format-specific code branch', async () => {
    installApp({
      formats: ['tiff'],
      encode: { formats: { tiff: { compression: 'lzw' } } },
    });
    const { storage, uploads } = makeStorage(redPng);
    const { mediaStore, appendCalls } = makeMediaStore(mediaDoc());
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
    });

    await processTask(task({ previews: [variant({ format: 'tiff' })] }));

    assert.equal((await sharp(uploads[0].body).metadata()).format, 'tiff');
    assert.equal(uploads[0].contentType, 'image/tiff');
    assert.equal(appendCalls[0].previews[0].format, 'tiff');
  });

  test('labels HEIF configured with AV1 compression as an AVIF container', async () => {
    installApp({
      formats: ['heif'],
      encode: { formats: { heif: { compression: 'av1' } } },
    });
    const { storage, uploads } = makeStorage(redPng);
    const { mediaStore, appendCalls } = makeMediaStore(mediaDoc());
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
    });

    await processTask(task({ previews: [variant({ format: 'heif' })] }));

    const metadata = await sharp(uploads[0].body).metadata();
    assert.equal(metadata.format, 'heif');
    assert.equal(metadata.compression, 'av1');
    assert.match(uploads[0].key, /\.avif$/);
    assert.equal(uploads[0].contentType, 'image/avif');
    assert.equal(appendCalls[0].previews[0].format, 'heif');
    assert.equal(appendCalls[0].previews[0].contentType, 'image/avif');
  });

  test('transparent PNG → jpeg variant is flattened onto the background (not black)', async () => {
    installApp();
    const { storage, uploads } = makeStorage(alphaPng);
    const { mediaStore } = makeMediaStore(mediaDoc());
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
    });
    await processTask(
      task({
        previews: [
          variant({
            sizeKey: '10x10',
            requestedWidth: 10,
            requestedHeight: 10,
          }),
        ],
      }),
    );
    const px = await sharp(uploads[0].body)
      .extract({ left: 0, top: 0, width: 1, height: 1 })
      .raw()
      .toBuffer();
    assert.ok(px[0] > 200, `expected flattened white, got r=${px[0]}`);
  });

  test('cover branch clamps each side to limits.resultDimension', async () => {
    installApp({ limits: { resultDimension: 100 } });
    const { storage } = makeStorage(redPng);
    const { mediaStore, appendCalls } = makeMediaStore(mediaDoc());
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
    });
    await processTask(
      task({
        previews: [
          variant({
            sizeKey: '5000x5000',
            requestedWidth: 5000,
            requestedHeight: 5000,
          }),
        ],
      }),
    );
    const p = appendCalls[0].previews[0];
    assert.equal(p.actualWidth, 100);
    assert.equal(p.actualHeight, 100);
  });

  test('fit uses inside+withoutEnlargement — no upscale of a small source', async () => {
    installApp();
    const { storage } = makeStorage(redPng); // 64×48
    const { mediaStore, appendCalls } = makeMediaStore(mediaDoc());
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
    });
    await processTask(task({ previews: [fitVariant] }));
    const p = appendCalls[0].previews[0];
    assert.equal(p.actualWidth, 64); // ≤ maxSize box, and NOT the box (2000×1200)
    assert.equal(p.actualHeight, 48);
    assert.equal(p.fit, true);
  });
});

// ---------------------------------------------------------------------------
// processTask — persistence, observers, poison guard, backfill, abort, concurrency
// ---------------------------------------------------------------------------

describe('processTask — persistence & failure handling', () => {
  test('ONE appendPreviews call; backfill dims are display-swapped when original dims missing', async () => {
    installApp();
    const { storage } = makeStorage(orientedJpeg); // display 48×64
    const { mediaStore, appendCalls } = makeMediaStore(mediaDoc()); // no original dims
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
    });
    await processTask(
      task({
        previews: [
          variant({
            sizeKey: '10x10',
            requestedWidth: 10,
            requestedHeight: 10,
          }),
        ],
      }),
    );
    assert.equal(appendCalls.length, 1);
    assert.deepEqual(appendCalls[0].backfillDims, { width: 48, height: 64 });
  });

  test('no dims backfill when the original already carries width/height', async () => {
    installApp();
    const { storage } = makeStorage(redPng);
    const { mediaStore, appendCalls } = makeMediaStore(
      mediaDoc({
        original: {
          storageRef: { key: 'uploads/orig' },
          width: 64,
          height: 48,
        },
      }),
    );
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
    });
    await processTask(task({ previews: [variant()] }));
    assert.equal(appendCalls.length, 1);
    assert.equal(appendCalls[0].backfillDims, undefined);
  });

  test('onPreviewGenerated fired once per pushed preview', async () => {
    installApp();
    const { storage } = makeStorage(redPng);
    const { mediaStore } = makeMediaStore(mediaDoc());
    const fired: Preview[] = [];
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
      hooks: {
        onPreviewGenerated: (preview: unknown) => {
          fired.push(preview as Preview);
        },
      },
    });
    await processTask(
      task({
        previews: [variant({ format: 'jpeg' }), variant({ format: 'webp' })],
      }),
    );
    assert.equal(fired.length, 2);
  });

  test('poison variant with zero successes → processTask THROWS and locks are released', async () => {
    installApp();
    const { storage, uploads } = makeStorage(redPng);
    const pipeline: Pipeline = {
      variantSteps: [
        async () => {
          throw new Error('poison');
        },
      ],
    };
    const { mediaStore, appendCalls } = makeMediaStore(mediaDoc());
    const { lockProvider, released } = makeLocks(true);
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, lockProvider),
      pipelines: { default: pipeline },
    });
    await assert.rejects(
      () => processTask(task({ previews: [variant()] })),
      /incomplete/,
    );
    assert.equal(uploads.length, 0);
    assert.equal(appendCalls.length, 0);
    // both the worker lock and the dispatch lock for the processed variant are released
    assert.deepEqual([...released].sort(), [
      'resize_dispatch:m1:default:default:20x20:jpeg:none',
      'resize_worker:m1:default:default:20x20:jpeg:none',
    ]);
  });

  test('partial success persists the good preview but throws so the task is retried', async () => {
    installApp();
    const { storage, uploads } = makeStorage(redPng);
    const pipeline: Pipeline = {
      variantSteps: [
        async (img, { variant: v }) => {
          if (v.filters?.poison) {
            throw new Error('poison');
          }
          return img;
        },
      ],
    };
    const { mediaStore, appendCalls } = makeMediaStore(mediaDoc());
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
      pipelines: { default: pipeline },
    });
    await assert.rejects(
      () =>
        processTask(
          task({
            previews: [variant(), variant({ filters: { poison: true } })],
          }),
        ),
      (error: unknown) =>
        error instanceof ResizeGenerateError &&
        error.code === 'RESIZE_WORKER_INCOMPLETE' &&
        error.missing.includes('default:default:20x20:jpeg:poison:true'),
    );
    assert.equal(uploads.length, 1);
    assert.equal(appendCalls.length, 1);
    assert.equal(appendCalls[0].previews.length, 1);
    assert.equal(appendCalls[0].previews[0].filters, undefined);
  });

  test('the next delivery generates only variants still missing after partial persistence', async () => {
    installApp();
    const { storage, uploads } = makeStorage(redPng);
    let poison = true;
    const pipeline: Pipeline = {
      variantSteps: [
        async (img, { variant: v }) => {
          if (poison && v.filters?.retry) {
            throw new Error('temporary encoder failure');
          }
          return img;
        },
      ],
    };
    const media = mediaDoc();
    const mediaStore: MediaStore = {
      load: async () => media,
      appendPreviews: async (_mediaId, previews) => {
        media.previews = [...(media.previews ?? []), ...previews];
      },
    };
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
      pipelines: { default: pipeline },
    });
    const queued = task({
      previews: [variant(), variant({ filters: { retry: true } })],
    });

    await assert.rejects(() => processTask(queued), /incomplete/);
    assert.equal(media.previews?.length, 1);
    assert.equal(uploads.length, 1);

    poison = false;
    await processTask(queued);
    assert.equal(media.previews?.length, 2);
    assert.equal(uploads.length, 2, 'ready identity was not uploaded again');
    assert.equal(
      new Set(
        media.previews?.map(
          (preview) =>
            `${preview.sizeKey}:${preview.format}:${JSON.stringify(preview.filters ?? {})}`,
        ),
      ).size,
      2,
    );
  });

  test('a worker-lock loser is complete only after a concurrent preview becomes visible', async () => {
    installApp();
    const { storage, uploads } = makeStorage(redPng);
    const media = mediaDoc();
    let loads = 0;
    const concurrent = {
      storageRef: { key: 'concurrent.jpg' },
      contentType: 'image/jpeg',
      sizeKey: '20x20',
      format: 'jpeg' as const,
    };
    const mediaStore: MediaStore = {
      load: async () => {
        loads++;
        if (loads >= 2) {
          media.previews = [concurrent];
        }
        return media;
      },
      appendPreviews: async () => {},
    };
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks(false).lockProvider),
    });
    await processTask(task({ previews: [variant()] }));
    assert.equal(uploads.length, 0);
  });

  test('deduplicates malformed task payloads by preview identity', async () => {
    installApp();
    const { storage, uploads } = makeStorage(redPng);
    const media = mediaDoc();
    const mediaStore: MediaStore = {
      load: async () => media,
      appendPreviews: async (_mediaId, previews) => {
        media.previews = [...(media.previews ?? []), ...previews];
      },
    };
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
    });
    await processTask(
      task({
        previews: [
          variant(),
          variant({ requestedWidth: 999, requestedHeight: 999 }),
        ],
      }),
    );
    assert.equal(uploads.length, 1);
    assert.equal(media.previews?.length, 1);
  });

  test('abort signal between variants stops launching new ones', async () => {
    installApp({ concurrency: 1 });
    const controller = new AbortController();
    const { storage, uploads } = makeStorage(redPng, () => controller.abort());
    const { mediaStore } = makeMediaStore(mediaDoc());
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
    });
    await assert.rejects(
      () =>
        processTask(
          task({
            previews: [
              variant({
                sizeKey: '10x10',
                requestedWidth: 10,
                requestedHeight: 10,
              }),
              variant({
                sizeKey: '11x11',
                requestedWidth: 11,
                requestedHeight: 11,
              }),
              variant({
                sizeKey: '12x12',
                requestedWidth: 12,
                requestedHeight: 12,
              }),
            ],
          }),
          { signal: controller.signal },
        ),
      /incomplete/,
    );
    assert.equal(uploads.length, 1); // aborted after the first, launched no more
  });

  test('concurrency=1 → variants run serially (no overlap)', async () => {
    installApp({ concurrency: 1 });
    const { storage } = makeStorage(redPng);
    let active = 0;
    let maxActive = 0;
    const pipeline: Pipeline = {
      variantSteps: [
        async (img) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 5));
          active -= 1;
          return img;
        },
      ],
    };
    const { mediaStore } = makeMediaStore(mediaDoc());
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
      pipelines: { default: pipeline },
    });
    await processTask(
      task({
        previews: [
          variant({
            sizeKey: '10x10',
            requestedWidth: 10,
            requestedHeight: 10,
          }),
          variant({
            sizeKey: '11x11',
            requestedWidth: 11,
            requestedHeight: 11,
          }),
          variant({
            sizeKey: '12x12',
            requestedWidth: 12,
            requestedHeight: 12,
          }),
        ],
      }),
    );
    assert.equal(maxActive, 1);
  });

  test('concurrency=2 → up to two variants run at once', async () => {
    installApp({ concurrency: 2 });
    const { storage } = makeStorage(redPng);
    let active = 0;
    let maxActive = 0;
    const pipeline: Pipeline = {
      variantSteps: [
        async (img) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 5));
          active -= 1;
          return img;
        },
      ],
    };
    const { mediaStore } = makeMediaStore(mediaDoc());
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, makeLocks().lockProvider),
      pipelines: { default: pipeline },
    });
    await processTask(
      task({
        previews: [
          variant({
            sizeKey: '10x10',
            requestedWidth: 10,
            requestedHeight: 10,
          }),
          variant({
            sizeKey: '11x11',
            requestedWidth: 11,
            requestedHeight: 11,
          }),
          variant({
            sizeKey: '12x12',
            requestedWidth: 12,
            requestedHeight: 12,
          }),
        ],
      }),
    );
    assert.equal(maxActive, 2);
  });
});

// ---------------------------------------------------------------------------
// Eager mode — resizer.generate (11 · §11.1)
// ---------------------------------------------------------------------------

describe('generate (eager)', () => {
  test('persists via appendPreviews by default', async () => {
    installApp();
    const { storage, uploads } = makeStorage(redPng);
    const { mediaStore, appendCalls } = makeMediaStore(null); // load unused in eager mode
    const r = createFrameworkResizer({ storage, mediaStore });
    const result = await r.generate({
      media: mediaDoc(),
      sizes: [{ width: 20, height: 20 }],
      formats: ['jpeg'],
    });
    assert.equal(result.created.length, 1);
    assert.equal(result.failed, 0);
    assert.equal(uploads.length, 1);
    assert.equal(appendCalls.length, 1);
  });

  test('appends created onto media.previews so a same-request resolve sees them', async () => {
    installApp();
    const { storage } = makeStorage(redPng);
    const { mediaStore } = makeMediaStore(null);
    const r = createFrameworkResizer({ storage, mediaStore });
    const media = mediaDoc();
    const { created } = await r.generate({
      media,
      sizes: [{ width: 20, height: 20 }],
      formats: ['jpeg'],
    });
    assert.equal(media.previews?.length, 1);
    assert.equal(media.previews?.[0], created[0]);
  });

  test('persist:false → returns previews without persisting (but still uploads)', async () => {
    installApp();
    const { storage, uploads } = makeStorage(redPng);
    const { mediaStore, appendCalls } = makeMediaStore(null);
    const r = createFrameworkResizer({ storage, mediaStore });
    const media = mediaDoc();
    const { created } = await r.generate({
      media,
      sizes: [{ width: 20, height: 20 }],
      formats: ['jpeg'],
      persist: false,
    });
    assert.equal(created.length, 1);
    assert.equal(media.previews?.length ?? 0, 0);
    assert.equal(uploads.length, 1);
    assert.equal(appendCalls.length, 0);
  });

  test('skip-existing → idempotent re-run generates nothing', async () => {
    installApp();
    const { storage, uploads } = makeStorage(redPng);
    const existing = {
      sizeKey: '20x20',
      format: 'jpeg',
      storageRef: { key: 'e' },
      contentType: 'image/jpeg',
    } as unknown as Preview;
    const { mediaStore, appendCalls } = makeMediaStore(null);
    const r = createFrameworkResizer({ storage, mediaStore });
    const result = await r.generate({
      media: mediaDoc({ previews: [existing] }),
      sizes: [{ width: 20, height: 20 }],
      formats: ['jpeg'],
    });
    assert.deepEqual(result.created, []);
    assert.equal(result.failed, 0);
    assert.equal(uploads.length, 0);
    assert.equal(appendCalls.length, 0);
  });

  test('throws a named error when media has neither id nor _id (host-facing)', async () => {
    installApp();
    const { storage } = makeStorage(redPng);
    const { mediaStore } = makeMediaStore(null);
    const r = createFrameworkResizer({ storage, mediaStore });
    await assert.rejects(
      () =>
        r.generate({
          media: {
            original: {
              storageRef: { key: 'uploads/o' },
              contentType: 'image/jpeg',
            },
          },
          sizes: [{ width: 20, height: 20 }],
          formats: ['jpeg'],
        }),
      /media has neither/,
    );
  });

  test('SVG original → eager JPEG/WebP/AVIF previews', async () => {
    installApp();
    const { storage, uploads } = makeStorage(smallSvg);
    const { mediaStore, appendCalls } = makeMediaStore(null);
    const r = createFrameworkResizer({ storage, mediaStore });
    const result = await r.generate({
      media: mediaDoc({
        original: {
          storageRef: { key: 'uploads/x.svg' },
          contentType: 'image/svg+xml',
        },
      }),
      sizes: [{ width: 80, height: 80 }],
      formats: ['jpeg', 'webp', 'avif'],
    });
    assert.equal(result.created.length, 3);
    assert.equal(result.failed, 0);
    assert.equal(uploads.length, 3);
    assert.deepEqual(
      new Set(uploads.map((upload) => upload.contentType)),
      new Set(['image/jpeg', 'image/webp', 'image/avif']),
    );
    for (const upload of uploads) {
      const metadata = await sharp(upload.body).metadata();
      assert.equal(metadata.width, 80);
      assert.equal(metadata.height, 80);
      assert.notEqual(metadata.format, 'svg');
    }
    assert.equal(appendCalls.length, 1);
  });

  test('SVG fit keeps the original size when a cover sibling needs high density', async () => {
    installApp();
    const { storage, uploads } = makeStorage(smallSvg);
    const { mediaStore } = makeMediaStore(null);
    const r = createFrameworkResizer({ storage, mediaStore });
    const result = await r.generate({
      media: mediaDoc({
        original: { storageRef: { key: 'uploads/x.svg' }, format: 'svg' },
      }),
      sizes: [{ width: 200, height: 200 }, { fit: true }],
      formats: ['webp'],
    });
    assert.equal(result.created.length, 2);
    const byKey = new Map(
      result.created.map((preview) => [preview.sizeKey, preview]),
    );
    const cover = uploads.find(
      (upload) =>
        upload.key ===
        (byKey.get('200x200')?.storageRef as { key: string })?.key,
    );
    const fit = uploads.find(
      (upload) =>
        upload.key === (byKey.get('fit')?.storageRef as { key: string })?.key,
    );
    assert.ok(cover);
    assert.ok(fit);
    assert.equal((await sharp(cover.body).metadata()).width, 200);
    assert.equal((await sharp(fit.body).metadata()).width, 8);
  });

  test('SVG rasterization never loads external file, URL or CSS references', async (t) => {
    installApp();
    const dir = await mkdtemp(join(tmpdir(), 'resize-svg-refs-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const redPath = join(dir, 'red.png');
    await writeFile(redPath, redPng);
    let requests = 0;
    const server = createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(redPng);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    t.after(() => server.close());
    const { port } = server.address() as AddressInfo;
    const remote = `http://127.0.0.1:${port}/red.png`;
    // A green canvas covered by red external images: any loaded reference turns pixels red.
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="8" height="8">
        <style>@import url("http://127.0.0.1:${port}/x.css");</style>
        <rect width="8" height="8" fill="#00ff00"/>
        <image href="file://${redPath}" width="8" height="8"/>
        <image href="red.png" width="8" height="8"/>
        <image href="${remote}" width="8" height="8"/>
        <image xlink:href="${remote}" width="8" height="8"/>
        <use href="file://${redPath}#x"/>
      </svg>`,
    );
    const { storage, uploads } = makeStorage(svg);
    const { mediaStore } = makeMediaStore(null);
    const r = createFrameworkResizer({ storage, mediaStore });
    const result = await r.generate({
      media: mediaDoc({
        original: { storageRef: { key: 'uploads/x.svg' }, format: 'svg' },
      }),
      sizes: [{ width: 32, height: 32 }],
      formats: ['jpeg'],
    });
    assert.equal(result.created.length, 1);
    assert.equal(requests, 0);
    const { data, info } = await sharp(uploads[0].body)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const center = (16 * info.width + 16) * info.channels;
    assert.ok(data[center] < 60, `red channel ${data[center]}`);
    assert.ok(data[center + 1] > 200, `green channel ${data[center + 1]}`);
  });

  test('no original → ResizeNoOriginalError', async () => {
    installApp();
    const { storage } = makeStorage(redPng);
    const { mediaStore } = makeMediaStore(null);
    const r = createFrameworkResizer({ storage, mediaStore });
    await assert.rejects(
      () =>
        r.generate({
          media: { id: 'm1' },
          sizes: [{ width: 20, height: 20 }],
          formats: ['jpeg'],
        }),
      (err: unknown) => {
        assert.ok(err instanceof ResizeNoOriginalError);
        assert.equal(err.mediaId, 'm1');
        return true;
      },
    );
  });

  test('eager generation passes a falsy scalar original and persists a falsy preview ref', async () => {
    installApp();
    const refs: unknown[] = [];
    const storage: ResizeStorage = {
      download: async (ref) => {
        refs.push(ref);
        return redPng;
      },
      upload: async () => false,
      publicUrl: () => '/preview',
    };
    const r = createFrameworkResizer({ storage });
    const result = await r.generate({
      media: { id: 'scalar', original: { storageRef: 0 } },
      sizes: [{ width: 20, height: 20 }],
      formats: ['jpeg'],
      persist: false,
    });
    assert.deepEqual(refs, [0]);
    assert.equal(result.created[0]?.storageRef, false);
  });

  test('rejects a nullish preview ref instead of appending it', async () => {
    installApp();
    const storage: ResizeStorage = {
      download: async () => redPng,
      upload: async () => null,
      publicUrl: () => '/preview',
    };
    const r = createFrameworkResizer({ storage });
    await assert.rejects(
      () =>
        r.generate({
          media: { id: 'bad-ref', original: { storageRef: 0 } },
          sizes: [{ width: 20, height: 20 }],
          formats: ['jpeg'],
          persist: false,
        }),
      (error: unknown) => error instanceof ResizeGenerateError,
    );
  });

  test('truthy but unpersisted original object → ResizeNoOriginalError before download', async () => {
    installApp();
    let downloadCalls = 0;
    const { mediaStore } = makeMediaStore(null);
    const storage: ResizeStorage = {
      download: async () => {
        downloadCalls += 1;
        return redPng;
      },
      upload: async () => ({ key: 'unused' }),
      publicUrl: () => '',
    };
    const r = createFrameworkResizer({ storage, mediaStore });
    await assert.rejects(
      () =>
        r.generate({
          media: {
            id: 'm1',
            original: {},
          },
          sizes: [{ width: 20, height: 20 }],
          formats: ['jpeg'],
        }),
      (err: unknown) => {
        assert.ok(err instanceof ResizeNoOriginalError);
        assert.equal(err.code, 'RESIZE_NO_ORIGINAL');
        assert.equal(err.mediaId, 'm1');
        return true;
      },
    );
    assert.equal(downloadCalls, 0);
  });

  test('every requested variant fails → ResizeGenerateError', async () => {
    installApp();
    const { mediaStore } = makeMediaStore(null);
    const storage: ResizeStorage = {
      download: async () => redPng,
      upload: async () => {
        throw new Error('upload down');
      },
      publicUrl: () => '',
    };
    const r = createFrameworkResizer({ storage, mediaStore });
    await assert.rejects(
      () =>
        r.generate({
          media: mediaDoc(),
          sizes: [{ width: 20, height: 20 }],
          formats: ['jpeg'],
        }),
      (err: unknown) => {
        assert.ok(err instanceof ResizeGenerateError);
        assert.equal(err.failed, 1);
        assert.equal(err.requested, 1);
        return true;
      },
    );
  });

  test('partial failure: no throw, failed > 0, created has the successes', async () => {
    installApp();
    const { storage } = makeStorage(redPng);
    const { mediaStore, appendCalls } = makeMediaStore(null);
    const r = createFrameworkResizer({
      storage,
      mediaStore,
      pipelines: {
        default: {
          variantSteps: [
            async (img, { variant }) => {
              if (variant.format === 'webp') {
                throw new Error('webp boom');
              }
              return img;
            },
          ],
        },
      },
    });
    const result = await r.generate({
      media: mediaDoc(),
      sizes: [{ width: 20, height: 20 }],
      formats: ['jpeg', 'webp'],
    });
    assert.equal(result.created.length, 1);
    assert.equal(result.created[0].format, 'jpeg');
    assert.equal(result.failed, 1);
    assert.equal(appendCalls.length, 1);
  });

  test('real ctx reaches beforeSteps and variantSteps', async () => {
    installApp();
    const { storage } = makeStorage(redPng);
    const { mediaStore } = makeMediaStore(null);
    let beforeMarker: unknown;
    let variantMarker: unknown;
    const pipeline: Pipeline = {
      beforeSteps: [
        async (buf, { ctx }) => {
          beforeMarker = ctx.marker;
          return buf;
        },
      ],
      variantSteps: [
        async (img, { ctx }) => {
          variantMarker = ctx.marker;
          return img;
        },
      ],
    };
    const r = createFrameworkResizer({
      storage,
      mediaStore,
      pipelines: { photo: pipeline },
    });
    await r.generate({
      media: mediaDoc(),
      sizes: [{ width: 20, height: 20 }],
      formats: ['jpeg'],
      pipeline: 'photo',
      ctx: { marker: 'from-request' },
    });
    assert.equal(beforeMarker, 'from-request');
    assert.equal(variantMarker, 'from-request');
  });
});

// ---------------------------------------------------------------------------
// runResizeWorker (07 · §11)
// ---------------------------------------------------------------------------

describe('runResizeWorker', () => {
  const fakeTransport = (
    onStart?: (
      handle: (
        task: LeasedTask,
        opts?: { signal: AbortSignal },
      ) => Promise<void>,
    ) => void,
  ): QueueTransport => ({
    locks: makeLocks().lockProvider,
    enqueue: async () => ({ taskId: null }),
    startWorker: async (handle) => {
      onStart?.(handle);
    },
  });

  test('worker.enabled=false → clean no-op (startWorker NOT called); log says how to enable', async () => {
    const { logs } = installApp(); // default worker.enabled is false
    let started = false;
    createFrameworkResizer({
      storage: makeStorage(redPng).storage,
      transport: {
        ...fakeTransport(() => {
          started = true;
        }),
      },
    });
    await runResizeWorker();
    assert.equal(started, false);
    assert.ok(
      logs.info.some((l) => String(l[0]).includes('worker.enabled=true')),
    );
  });

  test('no transport → logs an error and returns without preparing framework drivers', async () => {
    const { logs, getModelCalls } = installApp({
      worker: { enabled: true },
    });
    createFrameworkResizer({ storage: makeStorage(redPng).storage });
    await runResizeWorker();
    assert.ok(logs.error.length >= 1);
    assert.equal(getModelCalls(), 0);
  });

  test('a worker with no Resizers fails before leasing', async () => {
    installApp({ worker: { enabled: true } });
    await assert.rejects(
      () => runResizeWorker(),
      (err: unknown) =>
        err instanceof ResizeSetupError && err.code === 'RESIZE_NO_RESIZER',
    );
  });

  test('default media store + unregistered mediaModelName → throws before startWorker', async () => {
    resetAppInstance();
    setAppInstance({
      getConfig: () =>
        makeResizeConfig({
          mediaModelName: 'Media',
          worker: { enabled: true },
        }),
      getModel: () => false,
      logger: { info() {}, warn() {}, error() {} },
    } as never);
    let started = false;
    createFrameworkResizer({
      storage: makeStorage(redPng).storage,
      transport: fakeTransport(() => {
        started = true;
      }),
    });
    await assert.rejects(
      () => runResizeWorker(),
      (err: unknown) =>
        err instanceof ResizeConfigError &&
        err.code === 'RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN',
    );
    assert.equal(started, false);
  });

  test('custom media store verify() runs before startWorker, and its failure stops the worker', async () => {
    installApp({ worker: { enabled: true } });
    const events: string[] = [];
    const { mediaStore } = makeMediaStore(null);
    createFrameworkResizer({
      storage: makeStorage(redPng).storage,
      transport: fakeTransport(() => {
        events.push('startWorker');
      }),
      mediaStore: {
        ...mediaStore,
        async verify() {
          events.push('verify');
          throw new ResizeConfigError('custom store is misconfigured', {
            code: 'CUSTOM_STORE_INVALID',
          });
        },
      },
    });
    await assert.rejects(
      () => runResizeWorker(),
      (err: unknown) =>
        err instanceof ResizeConfigError && err.code === 'CUSTOM_STORE_INVALID',
    );
    assert.deepEqual(events, ['verify']);

    resetResizerForTests();
    events.length = 0;
    createFrameworkResizer({
      storage: makeStorage(redPng).storage,
      transport: fakeTransport(() => {
        events.push('startWorker');
      }),
      mediaStore: {
        ...mediaStore,
        verify() {
          events.push('verify');
        },
      },
    });
    await runResizeWorker();
    assert.deepEqual(events, ['verify', 'startWorker']);
  });

  test('enabled + transport → startWorker gets a handler that reaches processTask', async () => {
    installApp({ worker: { enabled: true } });
    let handle:
      | ((task: LeasedTask, opts?: { signal: AbortSignal }) => Promise<void>)
      | undefined;
    const { mediaStore } = makeMediaStore(null); // processTask loads null → no-op
    createFrameworkResizer({
      storage: makeStorage(redPng).storage,
      transport: fakeTransport((h) => {
        handle = h;
      }),
      mediaStore,
    });
    await runResizeWorker();
    assert.equal(typeof handle, 'function');
    // driving the handler reaches processTask without throwing (media load → null no-op)
    await handle?.(task({ previews: [variant()] }));
  });
});

// ---------------------------------------------------------------------------
// One worker process serves every registered Resizer, for one named queue
// ---------------------------------------------------------------------------

describe('one worker serves every Resizer', () => {
  type Handle = (
    task: LeasedTask,
    opts?: { signal: AbortSignal },
  ) => Promise<void>;

  function capturingTransport(): {
    transport: QueueTransport;
    captured: { handle?: Handle; opts?: StartWorkerOpts; calls: number };
  } {
    const captured: { handle?: Handle; opts?: StartWorkerOpts; calls: number } =
      { calls: 0 };
    const transport: QueueTransport = {
      enqueue: async () => ({ taskId: null }),
      startWorker: async (handle, opts) => {
        captured.handle = handle;
        captured.opts = opts;
        captured.calls += 1;
      },
    };
    return { transport, captured };
  }

  // A media store that records which Resizer loaded the media (null = deleted-media no-op).
  function labelledStore(label: string, loadedBy: string[]): MediaStore {
    return {
      load: async () => {
        loadedBy.push(label);
        return null;
      },
      appendPreviews: async () => {},
    };
  }

  test('one transport serves both Resizers, and each task runs with its own Resizer', async () => {
    installApp({ worker: { enabled: true } });
    const { transport, captured } = capturingTransport();
    const loadedBy: string[] = [];
    createFrameworkResizer({
      storage: makeStorage(redPng).storage,
      transport: withLocks(transport, makeLocks().lockProvider),
      mediaStore: labelledStore('default', loadedBy),
    });
    createFrameworkResizer({
      name: 'listings',
      storage: makeStorage(redPng).storage,
      transport: withLocks(transport, makeLocks().lockProvider),
      mediaStore: labelledStore('listings', loadedBy),
    });
    await runResizeWorker();
    assert.equal(captured.calls, 1);
    assert.equal(captured.opts?.queue, 'default');
    await captured.handle?.(task({ resizer: 'listings' }));
    await captured.handle?.(task());
    assert.deepEqual(loadedBy, ['listings', 'default']);
  });

  test('runResizeWorker({ queue }) consumes that queue only', async () => {
    installApp({ worker: { enabled: true } });
    const { transport, captured } = capturingTransport();
    createFrameworkResizer({
      storage: makeStorage(redPng).storage,
      transport: withLocks(transport, makeLocks().lockProvider),
      mediaStore: makeMediaStore(null).mediaStore,
    });
    await runResizeWorker({ queue: 'bulk' });
    assert.equal(captured.opts?.queue, 'bulk');
  });

  test('Resizers with different transports each get a worker loop on the queue', async () => {
    installApp({ worker: { enabled: true } });
    const a = capturingTransport();
    const b = capturingTransport();
    createFrameworkResizer({
      storage: makeStorage(redPng).storage,
      transport: withLocks(a.transport, makeLocks().lockProvider),
      mediaStore: makeMediaStore(null).mediaStore,
    });
    createFrameworkResizer({
      name: 'listings',
      storage: makeStorage(redPng).storage,
      transport: withLocks(b.transport, makeLocks().lockProvider),
      mediaStore: makeMediaStore(null).mediaStore,
    });
    await runResizeWorker({ queue: 'bulk' });
    assert.equal(a.captured.calls, 1);
    assert.equal(b.captured.calls, 1);
    assert.equal(a.captured.opts?.queue, 'bulk');
    assert.equal(b.captured.opts?.queue, 'bulk');
  });

  test('one failing transport loop stops the others and the worker rejects with its error', async () => {
    installApp({ worker: { enabled: true } });
    let otherStopped = false;
    const failing: QueueTransport = {
      locks: makeLocks().lockProvider,
      enqueue: async () => ({ taskId: null }),
      startWorker: async () => {
        throw new Error('queue unreachable');
      },
    };
    const waiting: QueueTransport = {
      locks: makeLocks().lockProvider,
      enqueue: async () => ({ taskId: null }),
      startWorker: (_handle, opts) =>
        new Promise<void>((done) => {
          opts.signal.addEventListener('abort', () => {
            otherStopped = true;
            done();
          });
        }),
    };
    createFrameworkResizer({
      storage: makeStorage(redPng).storage,
      transport: failing,
      mediaStore: makeMediaStore(null).mediaStore,
    });
    createFrameworkResizer({
      name: 'listings',
      storage: makeStorage(redPng).storage,
      transport: waiting,
      mediaStore: makeMediaStore(null).mediaStore,
    });
    await assert.rejects(() => runResizeWorker(), /queue unreachable/);
    assert.equal(otherStopped, true);
  });

  test('a transport that does not serve the queue is skipped; the others run', async () => {
    installApp({ worker: { enabled: true } });
    const served = capturingTransport();
    let unservedStarted = false;
    const unserved: QueueTransport = {
      locks: makeLocks().lockProvider,
      servesQueue: (queue) => queue === 'default',
      enqueue: async () => ({ taskId: null }),
      startWorker: async () => {
        unservedStarted = true;
      },
    };
    createFrameworkResizer({
      storage: makeStorage(redPng).storage,
      transport: withLocks(served.transport, makeLocks().lockProvider),
      mediaStore: makeMediaStore(null).mediaStore,
    });
    createFrameworkResizer({
      name: 'listings',
      storage: makeStorage(redPng).storage,
      transport: unserved,
      mediaStore: makeMediaStore(null).mediaStore,
    });
    await runResizeWorker({ queue: 'bulk' });
    assert.equal(served.captured.calls, 1);
    assert.equal(unservedStarted, false);
  });

  test('a queue no transport serves is a setup error', async () => {
    installApp({ worker: { enabled: true } });
    createFrameworkResizer({
      storage: makeStorage(redPng).storage,
      transport: {
        locks: makeLocks().lockProvider,
        servesQueue: () => false,
        enqueue: async () => ({ taskId: null }),
        startWorker: async () => {},
      },
      mediaStore: makeMediaStore(null).mediaStore,
    });
    await assert.rejects(
      () => runResizeWorker({ queue: 'bulk' }),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_QUEUE_NOT_SERVED',
    );
  });

  test('a task uses the locks of the transport that delivered it', async () => {
    installApp();
    const { storage } = makeStorage(redPng);
    const { mediaStore } = makeMediaStore(mediaDoc());
    const own = makeLocks();
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, own.lockProvider),
    });
    const delivering = makeLocks();
    await processTask(
      task({ previews: [variant()] }),
      undefined,
      withLocks(undefined, delivering.lockProvider),
    );
    assert.deepEqual(own.acquired, []);
    assert.deepEqual(delivering.acquired, [
      'resize_worker:m1:default:default:20x20:jpeg:none',
    ]);
  });

  test('the worker verifies each Resizer (a bad lazy config fails before leasing)', async () => {
    installApp({ worker: { enabled: true } });
    const { transport, captured } = capturingTransport();
    new Resizer({
      storage: makeStorage(redPng).storage,
      mediaStore: makeMediaStore(null).mediaStore,
      transport: withLocks(transport, makeLocks().lockProvider),
      config: () => ({ formats: [] }) as never,
    });
    await assert.rejects(
      () => runResizeWorker(),
      (err: unknown) => err instanceof ResizeConfigError,
    );
    assert.equal(captured.calls, 0);
  });

  test("task events reach only the owning Resizer's observers", async () => {
    installApp({ worker: { enabled: true } });
    const { transport, captured } = capturingTransport();
    const seen: unknown[][] = [];
    createFrameworkResizer({
      storage: makeStorage(redPng).storage,
      transport: withLocks(transport, makeLocks().lockProvider),
      mediaStore: makeMediaStore(null).mediaStore,
      hooks: {
        afterTaskComplete: () => {
          seen.push(['default', 'completed']);
        },
      },
    });
    createFrameworkResizer({
      name: 'listings',
      storage: makeStorage(redPng).storage,
      transport: withLocks(transport, makeLocks().lockProvider),
      mediaStore: makeMediaStore(null).mediaStore,
      hooks: {
        afterTaskComplete: () => {
          seen.push(['listings', 'completed']);
        },
        onTaskFailed: (_task, error) => {
          seen.push(['listings', 'failed', error]);
        },
        onTaskDeadLettered: (_task, error) => {
          seen.push(['listings', 'dead', error]);
        },
      },
    });
    await runResizeWorker();
    const boom = new Error('boom');
    await captured.opts?.onEvent?.('completed', task({ resizer: 'listings' }));
    await captured.opts?.onEvent?.(
      'failed',
      task({ resizer: 'listings' }),
      boom,
    );
    await captured.opts?.onEvent?.(
      'deadLettered',
      task({ resizer: 'listings' }),
      boom,
    );
    assert.deepEqual(seen, [
      ['listings', 'completed'],
      ['listings', 'failed', boom],
      ['listings', 'dead', boom],
    ]);
  });

  test('an event for an unknown Resizer is logged, not thrown', async () => {
    const { logs } = installApp({ worker: { enabled: true } });
    const { transport, captured } = capturingTransport();
    createFrameworkResizer({
      storage: makeStorage(redPng).storage,
      transport: withLocks(transport, makeLocks().lockProvider),
      mediaStore: makeMediaStore(null).mediaStore,
    });
    await runResizeWorker();
    await captured.opts?.onEvent?.('completed', task({ resizer: 'ghost' }));
    assert.ok(logs.error.some((l) => String(l[0]).includes("'ghost'")));
  });

  test('a task for an unregistered Resizer fails with RESIZE_NO_RESIZER', async () => {
    installApp({ worker: { enabled: true } });
    const { transport, captured } = capturingTransport();
    createFrameworkResizer({
      storage: makeStorage(redPng).storage,
      transport: withLocks(transport, makeLocks().lockProvider),
      mediaStore: makeMediaStore(null).mediaStore,
    });
    await runResizeWorker();
    await assert.rejects(
      () => captured.handle?.(task({ resizer: 'ghost' })) ?? Promise.resolve(),
      (err: unknown) =>
        err instanceof ResizeSetupError && err.code === 'RESIZE_NO_RESIZER',
    );
    await assert.rejects(
      () => processTask(task({ resizer: 'ghost' })),
      (err: unknown) =>
        err instanceof ResizeSetupError && err.code === 'RESIZE_NO_RESIZER',
    );
  });

  test('every Resizer verifies its media store before the worker starts', async () => {
    installApp({ worker: { enabled: true } });
    const { transport, captured } = capturingTransport();
    createFrameworkResizer({
      storage: makeStorage(redPng).storage,
      transport: withLocks(transport, makeLocks().lockProvider),
      mediaStore: makeMediaStore(null).mediaStore,
    });
    createFrameworkResizer({
      name: 'listings',
      storage: makeStorage(redPng).storage,
      mediaStore: {
        ...makeMediaStore(null).mediaStore,
        verify() {
          throw new ResizeConfigError('listings store is misconfigured', {
            code: 'LISTINGS_STORE_INVALID',
          });
        },
      },
    });
    await assert.rejects(
      () => runResizeWorker(),
      (err: unknown) =>
        err instanceof ResizeConfigError &&
        err.code === 'LISTINGS_STORE_INVALID',
    );
    assert.equal(captured.calls, 0);
  });

  test('the ResizeWorker command passes --queue through', async () => {
    installApp({ worker: { enabled: true } });
    const { transport, captured } = capturingTransport();
    createFrameworkResizer({
      storage: makeStorage(redPng).storage,
      transport: withLocks(transport, makeLocks().lockProvider),
      mediaStore: makeMediaStore(null).mediaStore,
    });
    assert.equal(ResizeWorker.commandArguments.queue.type, 'string');
    assert.equal(await new ResizeWorker({}, {}, { queue: 'bulk' }).run(), true);
    assert.equal(captured.opts?.queue, 'bulk');
    await new ResizeWorker({}, {}, {}).run();
    assert.equal(captured.opts?.queue, 'default');
  });
});

// ---------------------------------------------------------------------------
// Generation and worker coverage are scoped per Resizer and pipeline
// ---------------------------------------------------------------------------

describe('scoped generation', () => {
  const cleanPreview: Preview = {
    storageRef: { bucket: 'previews', key: 'clean.jpeg' },
    sizeKey: '20x20',
    format: 'jpeg',
    contentType: 'image/jpeg',
  };

  test('generate records the Resizer and pipeline on every created preview', async () => {
    installApp();
    const { storage } = makeStorage(redPng);
    const { mediaStore } = makeMediaStore(null);
    const r = createFrameworkResizer({ storage, mediaStore });
    const { created } = await r.generate({
      media: mediaDoc(),
      sizes: [{ width: 20, height: 20 }],
      formats: ['jpeg'],
    });
    assert.equal(created[0].resizer, 'default');
    assert.equal(created[0].pipeline, 'default');

    resetResizerForTests();
    const listings = createFrameworkResizer({
      name: 'listings',
      storage,
      mediaStore,
    });
    const watermarked = await listings.generate({
      media: mediaDoc(),
      sizes: [{ width: 20, height: 20 }],
      formats: ['jpeg'],
      pipeline: 'watermark',
    });
    assert.equal(watermarked.created[0].resizer, 'listings');
    assert.equal(watermarked.created[0].pipeline, 'watermark');
  });

  test('a default preview does not stop generation for another pipeline', async () => {
    installApp();
    const { storage, uploads } = makeStorage(redPng);
    const { mediaStore } = makeMediaStore(null);
    const r = createFrameworkResizer({ storage, mediaStore });
    const media = mediaDoc({ previews: [cleanPreview] });
    const same = await r.generate({
      media,
      sizes: [{ width: 20, height: 20 }],
      formats: ['jpeg'],
    });
    assert.equal(same.created.length, 0);
    const other = await r.generate({
      media,
      sizes: [{ width: 20, height: 20 }],
      formats: ['jpeg'],
      pipeline: 'watermark',
    });
    assert.equal(other.created.length, 1);
    assert.equal(uploads.length, 1);
  });

  test('worker lock keys carry the pipeline', async () => {
    installApp();
    const { storage } = makeStorage(redPng);
    const media = mediaDoc();
    const { mediaStore } = makeMediaStore(media);
    const { lockProvider, acquired } = makeLocks(true);
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, lockProvider),
    });
    await processTask(task({ pipeline: 'watermark', previews: [variant()] }));
    assert.ok(acquired.some((key) => key.includes(':watermark:')));
  });

  test('a default preview does not count as coverage for a watermark task', async () => {
    installApp();
    const { storage } = makeStorage(redPng);
    // The reloaded media has only the default rendering of the requested variant.
    const media = mediaDoc({ previews: [cleanPreview] });
    const { mediaStore } = makeMediaStore(media);
    // The worker lock for the watermark variant is held elsewhere, so nothing is generated.
    const { lockProvider } = makeLocks(false);
    createFrameworkResizer({
      storage,
      mediaStore,
      transport: withLocks(undefined, lockProvider),
    });
    await assert.rejects(
      () => processTask(task({ pipeline: 'watermark', previews: [variant()] })),
      (err: unknown) =>
        err instanceof ResizeGenerateError &&
        err.code === 'RESIZE_WORKER_INCOMPLETE',
    );
  });
});

describe('runWorker (core)', () => {
  test('runs with an explicit signal and logger, without the framework worker switch', async () => {
    installApp(); // worker.enabled is false: only the framework entry checks it
    let seenQueue: string | undefined;
    const transport: QueueTransport = {
      enqueue: async () => ({ taskId: null }),
      startWorker: async (_handle, opts) => {
        seenQueue = opts.queue;
      },
    };
    createFrameworkResizer({
      storage: makeStorage(redPng).storage,
      transport: withLocks(transport, makeLocks().lockProvider),
      mediaStore: makeMediaStore(null).mediaStore,
    });
    const logged: unknown[][] = [];
    await runWorker({
      signal: new AbortController().signal,
      queue: 'bulk',
      logger: {
        info: (...a: unknown[]) => {
          logged.push(a);
        },
        warn() {},
        error() {},
      },
    });
    assert.equal(seenQueue, 'bulk');
    assert.ok(logged.some((l) => String(l[0]).includes('stopped')));
  });
});
