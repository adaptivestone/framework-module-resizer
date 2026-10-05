// Worker core tests (07 · Worker + 11 · Modes). Real sharp on tiny in-memory fixtures
// generated with sharp itself; fakes for storage, database and task queues.
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
import type { ResizeDatabase } from './contracts/database.ts';
import type { LeasedTask, NewTask } from './contracts/taskQueue.ts';
import {
  ResizeConfigError,
  ResizeGenerateError,
  ResizeNoOriginalError,
  ResizeSetupError,
} from './errors.ts';
import ResizeWorker from './framework/ResizeWorkerCommand.ts';
import { FrameworkResizer } from './framework/resizer.ts';
import { runResizeWorker } from './framework/worker.ts';
import {
  type Pipeline,
  Resizer,
  type ResizeStorage,
  resetResizerForTests,
} from './resizer.ts';
import {
  type FakeLocks,
  fakeDb,
  MemoryTaskQueue,
} from './testHelpers/fakes.ts';
import { makeResizeConfig } from './testHelpers/resizeConfig.ts';
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

function makeDatabase(media: MediaLike | null): {
  db: ResizeDatabase;
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
  const db = fakeDb({
    load: async () => media,
    appendPreviews: async (mediaId, previews, backfillDims) => {
      appendCalls.push({ mediaId, previews, backfillDims });
    },
  });
  return { db, appendCalls };
}

function makeLocks(acquire: boolean | ((key: string) => boolean) = true): {
  lockProvider: FakeLocks;
  acquired: string[];
  released: string[];
} {
  const acquired: string[] = [];
  const released: string[] = [];
  const lockProvider: FakeLocks = {
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

function fakeLockMethods(
  locks: FakeLocks,
): Pick<ResizeDatabase, 'acquireLock' | 'releaseLock'> {
  return { acquireLock: locks.acquire, releaseLock: locks.release };
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
    const { db, appendCalls } = makeDatabase(null);
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
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
    const { db } = makeDatabase({
      id: 'm1',
      original: {},
      previews: [],
    } as MediaLike);
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
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
    const { db, appendCalls } = makeDatabase(
      mediaDoc({
        original: {
          storageRef: { key: 'uploads/x.svg' },
          contentType: 'image/svg+xml',
        },
      }),
    );
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
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
    const { db } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
    });
    await assert.rejects(() => processTask(task({ previews: [variant()] })));
  });

  test('sourcePixels guard → throws before any decode/upload', async () => {
    installApp({ limits: { sourcePixels: 10 } }); // redPng is 64×48 = 3072 px
    const { storage, uploads } = makeStorage(redPng);
    const { db } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
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
    const { db, appendCalls } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
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
    const { db } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
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
    const { db } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
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
    const { db, appendCalls } = makeDatabase(
      mediaDoc({ previews: [existing] }),
    );
    const { lockProvider, released } = makeLocks(true);
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(lockProvider) },
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
    const { db, appendCalls } = makeDatabase(mediaDoc());
    const { lockProvider, acquired } = makeLocks(false); // acquire always fails
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(lockProvider) },
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
    const { db, appendCalls } = makeDatabase(mediaDoc());
    const released: string[] = [];
    const lockProvider: FakeLocks = {
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
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(lockProvider) },
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
    const { db } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
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
    const { db, appendCalls } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
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
    const { db, appendCalls } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
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
    const { db, appendCalls } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
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
    const { db, appendCalls } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
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
    const { db } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
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
    const { db, appendCalls } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
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
    const { db, appendCalls } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
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
    const { db, appendCalls } = makeDatabase(mediaDoc()); // no original dims
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
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
    const { db, appendCalls } = makeDatabase(
      mediaDoc({
        original: {
          storageRef: { key: 'uploads/orig' },
          width: 64,
          height: 48,
        },
      }),
    );
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
    });
    await processTask(task({ previews: [variant()] }));
    assert.equal(appendCalls.length, 1);
    assert.equal(appendCalls[0].backfillDims, undefined);
  });

  test('onPreviewGenerated fired once per pushed preview', async () => {
    installApp();
    const { storage } = makeStorage(redPng);
    const { db } = makeDatabase(mediaDoc());
    const fired: Preview[] = [];
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
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
    const { db, appendCalls } = makeDatabase(mediaDoc());
    const { lockProvider, released } = makeLocks(true);
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(lockProvider) },
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
    const { db, appendCalls } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
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
    const db: ResizeDatabase = {
      ...fakeDb(),
      loadMedia: async () => media,
      appendPreviews: async (_mediaId, previews) => {
        media.previews = [...(media.previews ?? []), ...previews];
      },
    };
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
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
    const db: ResizeDatabase = {
      ...fakeDb(),
      loadMedia: async () => {
        loads++;
        if (loads >= 2) {
          media.previews = [concurrent];
        }
        return media;
      },
      appendPreviews: async () => {},
    };
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks(false).lockProvider) },
    });
    await processTask(task({ previews: [variant()] }));
    assert.equal(uploads.length, 0);
  });

  test('deduplicates malformed task payloads by preview identity', async () => {
    installApp();
    const { storage, uploads } = makeStorage(redPng);
    const media = mediaDoc();
    const db: ResizeDatabase = {
      ...fakeDb(),
      loadMedia: async () => media,
      appendPreviews: async (_mediaId, previews) => {
        media.previews = [...(media.previews ?? []), ...previews];
      },
    };
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
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
    const { db } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
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
    const { db } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
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
    const { db } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
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
    const { db, appendCalls } = makeDatabase(null); // load unused in eager mode
    const r = new FrameworkResizer({ storage, db });
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
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
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
    const { db, appendCalls } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
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
    const { db, appendCalls } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
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
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
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
    const { db, appendCalls } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
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
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
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
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
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
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
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
    const r = new FrameworkResizer({ storage });
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
    const r = new FrameworkResizer({ storage });
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
    const { db } = makeDatabase(null);
    const storage: ResizeStorage = {
      download: async () => {
        downloadCalls += 1;
        return redPng;
      },
      upload: async () => ({ key: 'unused' }),
      publicUrl: () => '',
    };
    const r = new FrameworkResizer({ storage, db });
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
    const { db } = makeDatabase(null);
    const storage: ResizeStorage = {
      download: async () => redPng,
      upload: async () => {
        throw new Error('upload down');
      },
      publicUrl: () => '',
    };
    const r = new FrameworkResizer({ storage, db });
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
    const { db, appendCalls } = makeDatabase(null);
    const r = new FrameworkResizer({
      storage,
      db,
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
    const { db } = makeDatabase(null);
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
    const r = new FrameworkResizer({
      storage,
      db,
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

// Stop idle test queues deterministically after their queued work has been handled.
function observedQueue(onIdle: () => void = () => process.emit('SIGTERM')) {
  const tasks = new MemoryTaskQueue({ timing: { idlePollMs: 1 } });
  const claimedQueues: string[] = [];
  const claim = tasks.claim.bind(tasks);
  tasks.claim = async (queue, leaseMs) => {
    claimedQueues.push(queue);
    const next = await claim(queue, leaseMs);
    if (!next) {
      onIdle();
    }
    return next;
  };
  return { tasks, claimedQueues };
}

async function addTask(tasks: MemoryTaskQueue, over: Partial<NewTask> = {}) {
  const { taskId: _taskId, ...payload } = task();
  await tasks.add({ ...payload, requestKey: JSON.stringify(over), ...over });
}

describe('runResizeWorker', () => {
  test('worker.enabled=false → clean no-op (claim NOT called); log says how to enable', async () => {
    const { logs } = installApp();
    const { tasks, claimedQueues } = observedQueue();
    new FrameworkResizer({ storage: makeStorage(redPng).storage, tasks });
    await runResizeWorker();
    assert.deepEqual(claimedQueues, []);
    assert.ok(
      logs.info.some((l) => String(l[0]).includes('worker.enabled=true')),
    );
  });

  test('no task queue → logs an error and returns without preparing framework drivers', async () => {
    const { logs, getModelCalls } = installApp({ worker: { enabled: true } });
    new FrameworkResizer({ storage: makeStorage(redPng).storage });
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

  test('default database + unregistered mediaModelName → throws before claiming', async () => {
    setAppInstance({
      getConfig: () =>
        makeResizeConfig({
          mediaModelName: 'Media',
          worker: { enabled: true },
        }),
      getModel: () => false,
      logger: { info() {}, warn() {}, error() {} },
    } as never);
    const { tasks, claimedQueues } = observedQueue();
    new FrameworkResizer({ storage: makeStorage(redPng).storage, tasks });
    await assert.rejects(
      () => runResizeWorker(),
      (err: unknown) =>
        err instanceof ResizeConfigError &&
        err.code === 'RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN',
    );
    assert.deepEqual(claimedQueues, []);
  });

  test('custom database verify() runs before claim, and its failure stops the worker', async () => {
    installApp({ worker: { enabled: true } });
    const events: string[] = [];
    const { tasks } = observedQueue(() => {
      events.push('claim');
      process.emit('SIGTERM');
    });
    new FrameworkResizer({
      storage: makeStorage(redPng).storage,
      tasks,
      db: fakeDb({
        // async: a rejected promise stops the worker only if verify() is awaited
        async verify() {
          events.push('verify');
          throw new ResizeConfigError('custom database is misconfigured', {
            code: 'CUSTOM_STORE_INVALID',
          });
        },
      }),
    });
    await assert.rejects(
      () => runResizeWorker(),
      (err: unknown) =>
        err instanceof ResizeConfigError && err.code === 'CUSTOM_STORE_INVALID',
    );
    assert.deepEqual(events, ['verify']);
    resetResizerForTests();
    events.length = 0;
    new FrameworkResizer({
      storage: makeStorage(redPng).storage,
      tasks,
      db: fakeDb({
        async verify() {
          events.push('verify');
        },
      }),
    });
    await runResizeWorker();
    assert.deepEqual(events, ['verify', 'claim']);
  });

  test('enabled + task queue → a claimed task reaches processTask', async () => {
    installApp({ worker: { enabled: true } });
    const { tasks } = observedQueue();
    let loads = 0;
    new FrameworkResizer({
      storage: makeStorage(redPng).storage,
      tasks,
      db: fakeDb({
        load: async () => {
          loads++;
          return null;
        },
      }),
    });
    await addTask(tasks, { previews: [variant()] });
    await runResizeWorker();
    assert.equal(loads, 1);
    assert.equal(tasks.rows[0].status, 'completed');
  });
});

describe('one worker serves every Resizer', () => {
  function register(tasks: MemoryTaskQueue, name = 'default', db = fakeDb()) {
    return new FrameworkResizer({
      name,
      storage: makeStorage(redPng).storage,
      tasks,
      db,
    });
  }

  test('one task queue serves both Resizers, and each task runs with its own Resizer', async () => {
    installApp({ worker: { enabled: true } });
    const { tasks, claimedQueues } = observedQueue();
    const loadedBy: string[] = [];
    const labelled = (label: string) =>
      fakeDb({
        load: async () => {
          loadedBy.push(label);
          return null;
        },
      });
    register(tasks, 'default', labelled('default'));
    register(tasks, 'listings', labelled('listings'));
    await addTask(tasks, { resizer: 'listings' });
    await addTask(tasks);
    await runResizeWorker();
    assert.deepEqual(loadedBy, ['listings', 'default']);
    assert.deepEqual(claimedQueues, ['default', 'default', 'default']);
    assert.ok(tasks.rows.every((row) => row.status === 'completed'));
  });

  test('runResizeWorker({ queue }) consumes that queue only', async () => {
    installApp({ worker: { enabled: true } });
    const { tasks, claimedQueues } = observedQueue();
    register(tasks);
    await addTask(tasks);
    await addTask(tasks, { queue: 'bulk' });
    await runResizeWorker({ queue: 'bulk' });
    assert.deepEqual(claimedQueues, ['bulk', 'bulk']);
    assert.deepEqual(
      tasks.rows.map((row) => row.status),
      ['pending', 'completed'],
    );
  });

  test('Resizers with different task queues each get a worker loop on the queue', {
    timeout: 5000,
  }, async () => {
    installApp();
    const controller = new AbortController();
    let idle = 0;
    const stop = () => {
      if (++idle === 2) {
        controller.abort();
      }
    };
    const a = observedQueue(stop);
    const b = observedQueue(stop);
    register(a.tasks);
    register(b.tasks, 'listings');
    await runWorker({ queue: 'bulk', signal: controller.signal });
    assert.deepEqual(a.claimedQueues, ['bulk']);
    assert.deepEqual(b.claimedQueues, ['bulk']);
  });

  test('a failing claim retries while the sibling queue continues processing', async () => {
    const { logs } = installApp();
    const controller = new AbortController();
    const failing = new MemoryTaskQueue({ timing: { idlePollMs: 1 } });
    let attempts = 0;
    failing.claim = async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('queue unreachable');
      }
      controller.abort();
      return null;
    };
    const sibling = new MemoryTaskQueue();
    register(failing);
    register(sibling, 'listings');
    await addTask(sibling, { resizer: 'listings' });
    await runWorker({
      signal: controller.signal,
      logger: {
        info() {},
        warn() {},
        error: (...args) => {
          logs.error.push(args);
        },
      },
    });
    assert.equal(attempts, 2);
    assert.equal(sibling.rows[0].status, 'completed');
    assert.ok(
      logs.error.some((args) => String(args[1]).includes('queue unreachable')),
    );
  });

  test('a loop that fails stops the other loops, and its error rejects the worker', {
    timeout: 5000,
  }, async () => {
    installApp();
    let siblingAborted = false;
    const sibling = new MemoryTaskQueue();
    sibling.claim = (_queue, _leaseMs, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            siblingAborted = true;
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
    register(sibling);
    // Invalid timing (the worker lock outlives the lease), with verify() bypassed, so the
    // failure surfaces inside the running loop rather than at startup.
    const broken = new MemoryTaskQueue({
      timing: { leaseMs: 1000, lockTtlMs: { dispatch: 1000, worker: 2000 } },
    });
    const r = register(broken, 'listings');
    r.verify = async () => {};
    await assert.rejects(
      () => runWorker({ signal: new AbortController().signal }),
      (err: unknown) =>
        err instanceof ResizeConfigError &&
        err.code === 'RESIZE_CONFIG_LOCK_EXCEEDS_LEASE',
    );
    assert.equal(siblingAborted, true);
  });

  test('a sibling claim aborted during shutdown does not reject the worker', async () => {
    installApp();
    const controller = new AbortController();
    const waiting = new MemoryTaskQueue();
    let aborted = false;
    waiting.claim = (_queue, _leaseMs, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('aborted by sibling'));
          },
          { once: true },
        );
      });
    const stopping = observedQueue(() => controller.abort());
    register(waiting);
    register(stopping.tasks, 'listings');
    await runWorker({ signal: controller.signal });
    assert.equal(aborted, true);
  });

  test('a task queue that does not serve the queue is skipped; the others run', async () => {
    installApp();
    const controller = new AbortController();
    const served = observedQueue(() => controller.abort());
    const unserved = observedQueue(() => assert.fail('unserved queue claimed'));
    unserved.tasks.servesQueue = (queue) => queue === 'default';
    register(served.tasks);
    register(unserved.tasks, 'listings');
    await runWorker({ queue: 'bulk', signal: controller.signal });
    assert.deepEqual(served.claimedQueues, ['bulk']);
    assert.deepEqual(unserved.claimedQueues, []);
  });

  test('drivers given as functions are loaded before the worker groups its loops', {
    timeout: 5000,
  }, async () => {
    installApp();
    const controller = new AbortController();
    const { tasks, claimedQueues } = observedQueue(() => controller.abort());
    let loads = 0;
    new Resizer({
      storage: makeStorage(redPng).storage,
      db: async () =>
        fakeDb({
          load: async () => {
            loads++;
            return null;
          },
        }),
      tasks: async () => tasks,
    });
    await addTask(tasks);
    await runWorker({ signal: controller.signal });
    assert.deepEqual(claimedQueues, ['default', 'default']);
    assert.equal(loads, 1); // the task reached the lazily loaded database
    assert.equal(tasks.rows[0].status, 'completed');
  });

  test('a queue no task queue serves is a setup error', async () => {
    installApp();
    const tasks = new MemoryTaskQueue();
    tasks.servesQueue = () => false;
    register(tasks);
    await assert.rejects(
      () => runWorker({ queue: 'bulk', signal: new AbortController().signal }),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_QUEUE_NOT_SERVED',
    );
  });

  test('a task uses its owning database locks and the delivering queue lock TTL', async () => {
    installApp();
    const own = makeLocks();
    const ttls: number[] = [];
    register(
      new MemoryTaskQueue(),
      'default',
      fakeDb({
        load: async () => mediaDoc(),
        locks: {
          acquire: async (key, ttlMs) => {
            ttls.push(ttlMs);
            return own.lockProvider.acquire(key, ttlMs);
          },
          release: own.lockProvider.release,
        },
      }),
    );
    await processTask(
      task({ previews: [variant()] }),
      undefined,
      new MemoryTaskQueue({
        timing: { lockTtlMs: { dispatch: 1000, worker: 2000 } },
      }),
    );
    assert.deepEqual(own.acquired, [
      'resize_worker:m1:default:default:20x20:jpeg:none',
    ]);
    assert.deepEqual(ttls, [2000]);
  });

  test('the worker verifies each Resizer (a bad lazy config fails before leasing)', async () => {
    installApp();
    const controller = new AbortController();
    const { tasks, claimedQueues } = observedQueue(() => controller.abort());
    new Resizer({
      storage: makeStorage(redPng).storage,
      db: fakeDb(),
      tasks,
      config: () => ({ formats: [] }) as never,
    });
    await assert.rejects(
      () => runWorker({ signal: controller.signal }),
      (err: unknown) => err instanceof ResizeConfigError,
    );
    assert.deepEqual(claimedQueues, []);
  });

  test("task events reach only the owning Resizer's observers", async () => {
    installApp();
    const controller = new AbortController();
    const tasks = new MemoryTaskQueue({
      timing: {
        idlePollMs: 1,
        maxAttempts: 2,
        retryBackoffMs: { base: 1, max: 1 },
      },
    });
    const seen: unknown[][] = [];
    const boom = new Error('boom');
    new FrameworkResizer({
      storage: makeStorage(redPng).storage,
      db: fakeDb(),
      tasks,
      hooks: {
        afterTaskComplete: () => {
          seen.push(['default', 'completed']);
        },
      },
    });
    new FrameworkResizer({
      name: 'listings',
      storage: makeStorage(redPng).storage,
      tasks,
      db: fakeDb({
        load: async (id) => {
          if (id === 'bad') {
            throw boom;
          }
          return null;
        },
      }),
      hooks: {
        afterTaskComplete: () => {
          seen.push(['listings', 'completed']);
        },
        onTaskFailed: (_task, error) => {
          seen.push(['listings', 'failed', error]);
        },
        onTaskDeadLettered: (_task, error) => {
          seen.push(['listings', 'dead', error]);
          controller.abort();
        },
      },
    });
    await addTask(tasks, { resizer: 'listings' });
    await addTask(tasks, { resizer: 'listings', mediaId: 'bad' });
    await runWorker({ signal: controller.signal });
    assert.deepEqual(seen, [
      ['listings', 'completed'],
      ['listings', 'failed', boom],
      ['listings', 'dead', boom],
    ]);
    assert.deepEqual(
      tasks.rows.map((row) => row.status),
      ['completed', 'dead'],
    );
  });

  test('an event for an unknown Resizer is logged, not thrown', async () => {
    const { logs } = installApp({ worker: { enabled: true } });
    const { tasks } = observedQueue();
    register(tasks);
    await addTask(tasks, { resizer: 'ghost' });
    await runResizeWorker();
    assert.ok(logs.error.some((l) => String(l[0]).includes("'ghost'")));
    // logged by the worker's handler itself, not caught as a throwing event handler
    assert.ok(
      !logs.error.some((l) => String(l[0]).includes('event handler failed')),
    );
    assert.equal(tasks.rows[0].status, 'pending');
    assert.match(tasks.rows[0].error ?? '', /no Resizer named 'ghost'/);
  });

  test('a task for an unregistered Resizer fails with RESIZE_NO_RESIZER', async () => {
    installApp();
    register(new MemoryTaskQueue());
    await assert.rejects(
      () => processTask(task({ resizer: 'ghost' })),
      (err: unknown) =>
        err instanceof ResizeSetupError && err.code === 'RESIZE_NO_RESIZER',
    );
  });

  test('every Resizer verifies its database before the worker starts', async () => {
    installApp();
    const controller = new AbortController();
    const { tasks, claimedQueues } = observedQueue(() => controller.abort());
    register(tasks);
    new FrameworkResizer({
      name: 'listings',
      storage: makeStorage(redPng).storage,
      db: fakeDb({
        verify() {
          throw new ResizeConfigError('listings database is misconfigured', {
            code: 'LISTINGS_STORE_INVALID',
          });
        },
      }),
    });
    await assert.rejects(
      () => runWorker({ signal: controller.signal }),
      (err: unknown) =>
        err instanceof ResizeConfigError &&
        err.code === 'LISTINGS_STORE_INVALID',
    );
    assert.deepEqual(claimedQueues, []);
  });

  test('the ResizeWorker command passes --queue through', async () => {
    installApp({ worker: { enabled: true } });
    const { tasks, claimedQueues } = observedQueue();
    register(tasks);
    assert.equal(ResizeWorker.commandArguments.queue.type, 'string');
    assert.equal(await new ResizeWorker({}, {}, { queue: 'bulk' }).run(), true);
    assert.deepEqual(claimedQueues, ['bulk']);
    await new ResizeWorker({}, {}, {}).run();
    assert.deepEqual(claimedQueues, ['bulk', 'default']);
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
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
    const { created } = await r.generate({
      media: mediaDoc(),
      sizes: [{ width: 20, height: 20 }],
      formats: ['jpeg'],
    });
    assert.equal(created[0].resizer, 'default');
    assert.equal(created[0].pipeline, 'default');

    resetResizerForTests();
    const listings = new FrameworkResizer({
      name: 'listings',
      storage,
      db,
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
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
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
    const { db } = makeDatabase(media);
    const { lockProvider, acquired } = makeLocks(true);
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(lockProvider) },
    });
    await processTask(task({ pipeline: 'watermark', previews: [variant()] }));
    assert.ok(acquired.some((key) => key.includes(':watermark:')));
  });

  test('a default preview does not count as coverage for a watermark task', async () => {
    installApp();
    const { storage } = makeStorage(redPng);
    // The reloaded media has only the default rendering of the requested variant.
    const media = mediaDoc({ previews: [cleanPreview] });
    const { db } = makeDatabase(media);
    // The worker lock for the watermark variant is held elsewhere, so nothing is generated.
    const { lockProvider } = makeLocks(false);
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(lockProvider) },
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
    const controller = new AbortController();
    const { tasks, claimedQueues } = observedQueue(() => controller.abort());
    new FrameworkResizer({
      storage: makeStorage(redPng).storage,
      tasks,
      db: fakeDb(),
    });
    const logged: unknown[][] = [];
    await runWorker({
      signal: controller.signal,
      queue: 'bulk',
      logger: {
        info: (...a: unknown[]) => {
          logged.push(a);
        },
        warn() {},
        error() {},
      },
    });
    assert.deepEqual(claimedQueues, ['bulk']);
    assert.ok(logged.some((l) => String(l[0]).includes('stopped')));
  });
});
