// Worker core tests (07 · Worker + 11 · Modes). Real sharp on tiny in-memory fixtures
// generated with sharp itself; fakes for storage / mediaStore / lockProvider / transport.
// Fresh Resizer + fake ambient app per test (node:test = per-file process isolation).
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import sharp from 'sharp';
import { ResizeGenerateError, ResizeNoOriginalError } from './errors.ts';
import type { LockProvider } from './locks.ts';
import type { MediaStore } from './mediaStore.ts';
import {
  type LeasedTask,
  type Pipeline,
  type QueueTransport,
  Resizer,
  type ResizeStorage,
  resetResizerForTests,
} from './resizer.ts';
import { processTask } from './resizeTask.ts';
import type {
  MediaLike,
  MissingPreview,
  Original,
  Preview,
} from './types.d.ts';
import { runResizeWorker } from './worker.ts';

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
} {
  const logs = {
    info: [] as unknown[][],
    warn: [] as unknown[][],
    error: [] as unknown[][],
  };
  setAppInstance({
    getConfig: () => ({ mediaModelName: 'File', ...configOverride }),
    getModel: () => ({}),
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
  return { logs };
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
  lockProvider: LockProvider;
  acquired: string[];
  released: string[];
} {
  const acquired: string[] = [];
  const released: string[] = [];
  const lockProvider: LockProvider = {
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
    original: { key: 'uploads/orig', ...(over.original ?? {}) } as Original,
    previews: over.previews ?? [],
  };
}

const task = (over: Partial<LeasedTask> = {}): LeasedTask => ({
  taskId: 't1',
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
    new Resizer({
      storage,
      mediaStore,
      lockProvider: makeLocks().lockProvider,
    });
    await processTask(task({ previews: [variant()] }));
    assert.equal(uploads.length, 0);
    assert.equal(appendCalls.length, 0);
  });

  test('SVG original → no-op success (never rasterized)', async () => {
    installApp();
    const { storage, uploads } = makeStorage(redPng);
    const { mediaStore, appendCalls } = makeMediaStore(
      mediaDoc({
        original: { key: 'uploads/x.svg', contentType: 'image/svg+xml' },
      }),
    );
    new Resizer({
      storage,
      mediaStore,
      lockProvider: makeLocks().lockProvider,
    });
    await processTask(task({ previews: [variant()] }));
    assert.equal(uploads.length, 0);
    assert.equal(appendCalls.length, 0);
  });

  test('an undecodable source → throws (fails the task for retry/DLQ)', async () => {
    installApp();
    const { storage } = makeStorage(
      Buffer.from('this is definitely not an image'),
    );
    const { mediaStore } = makeMediaStore(mediaDoc());
    new Resizer({
      storage,
      mediaStore,
      lockProvider: makeLocks().lockProvider,
    });
    await assert.rejects(() => processTask(task({ previews: [variant()] })));
  });

  test('sourcePixels guard → throws before any decode/upload', async () => {
    installApp({ limits: { sourcePixels: 10 } }); // redPng is 64×48 = 3072 px
    const { storage, uploads } = makeStorage(redPng);
    const { mediaStore } = makeMediaStore(mediaDoc());
    new Resizer({
      storage,
      mediaStore,
      lockProvider: makeLocks().lockProvider,
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
    new Resizer({
      storage,
      mediaStore,
      lockProvider: makeLocks().lockProvider,
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
    new Resizer({
      storage,
      mediaStore,
      lockProvider: makeLocks().lockProvider,
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
    new Resizer({
      storage,
      mediaStore,
      lockProvider: makeLocks().lockProvider,
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
      key: 'e',
      contentType: 'image/jpeg',
    } as unknown as Preview;
    const { mediaStore, appendCalls } = makeMediaStore(
      mediaDoc({ previews: [existing] }),
    );
    const { lockProvider, released } = makeLocks(true);
    new Resizer({ storage, mediaStore, lockProvider });
    await processTask(task({ previews: [variant()] }));
    assert.equal(uploads.length, 0);
    assert.equal(appendCalls.length, 0);
    assert.deepEqual(released, ['resize_dispatch:m1:20x20:jpeg:none']);
  });

  test('worker lock not acquired → variant skipped, still missing, not persisted', async () => {
    installApp();
    const { storage, uploads } = makeStorage(redPng);
    const { mediaStore, appendCalls } = makeMediaStore(mediaDoc());
    const { lockProvider, acquired } = makeLocks(false); // acquire always fails
    new Resizer({ storage, mediaStore, lockProvider });
    await processTask(task({ previews: [variant()] }));
    assert.deepEqual(acquired, ['resize_worker:m1:20x20:jpeg:none']);
    assert.equal(uploads.length, 0);
    assert.equal(appendCalls.length, 0);
  });

  test('a rejecting worker-lock acquire skips only that variant; others generate + persist + release', async () => {
    installApp();
    const { storage, uploads } = makeStorage(redPng);
    const { mediaStore, appendCalls } = makeMediaStore(mediaDoc());
    const released: string[] = [];
    const lockProvider: LockProvider = {
      // The webp worker-lock acquire REJECTS — treated exactly like a not-acquired lock: skip the
      // variant (leave it missing), never reject the pool or skip persist/finally. The jpeg variant
      // is unaffected: generated, persisted, and its locks released (1.2a).
      acquire: async (key: string) => {
        if (key === 'resize_worker:m1:20x20:webp:none') {
          throw new Error('lock backend down');
        }
        return true;
      },
      release: async (key: string) => {
        released.push(key);
      },
    };
    new Resizer({ storage, mediaStore, lockProvider });
    await processTask(
      task({ previews: [variant(), variant({ format: 'webp' })] }),
    );
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].key.split('.').pop(), 'jpeg');
    assert.equal(appendCalls.length, 1);
    assert.deepEqual(
      appendCalls[0].previews.map((p) => p.format),
      ['jpeg'],
    );
    assert.ok(released.includes('resize_worker:m1:20x20:jpeg:none'));
    assert.ok(released.includes('resize_dispatch:m1:20x20:jpeg:none'));
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
    new Resizer({
      storage,
      mediaStore,
      lockProvider: makeLocks().lockProvider,
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
    new Resizer({
      storage,
      mediaStore,
      lockProvider: makeLocks().lockProvider,
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
    new Resizer({
      storage,
      mediaStore,
      lockProvider: makeLocks().lockProvider,
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

  test('transparent PNG → jpeg variant is flattened onto the background (not black)', async () => {
    installApp();
    const { storage, uploads } = makeStorage(alphaPng);
    const { mediaStore } = makeMediaStore(mediaDoc());
    new Resizer({
      storage,
      mediaStore,
      lockProvider: makeLocks().lockProvider,
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
    new Resizer({
      storage,
      mediaStore,
      lockProvider: makeLocks().lockProvider,
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
    new Resizer({
      storage,
      mediaStore,
      lockProvider: makeLocks().lockProvider,
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
    new Resizer({
      storage,
      mediaStore,
      lockProvider: makeLocks().lockProvider,
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
      mediaDoc({ original: { key: 'uploads/orig', width: 64, height: 48 } }),
    );
    new Resizer({
      storage,
      mediaStore,
      lockProvider: makeLocks().lockProvider,
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
    new Resizer({
      storage,
      mediaStore,
      lockProvider: makeLocks().lockProvider,
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
    new Resizer({
      storage,
      mediaStore,
      lockProvider,
      pipelines: { default: pipeline },
    });
    await assert.rejects(
      () => processTask(task({ previews: [variant()] })),
      /produced 0 previews/,
    );
    assert.equal(uploads.length, 0);
    assert.equal(appendCalls.length, 0);
    // both the worker lock and the dispatch lock for the processed variant are released
    assert.deepEqual([...released].sort(), [
      'resize_dispatch:m1:20x20:jpeg:none',
      'resize_worker:m1:20x20:jpeg:none',
    ]);
  });

  test('partial success (one good + one poison) → returns normally, good preview persisted', async () => {
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
    new Resizer({
      storage,
      mediaStore,
      lockProvider: makeLocks().lockProvider,
      pipelines: { default: pipeline },
    });
    await processTask(
      task({ previews: [variant(), variant({ filters: { poison: true } })] }),
    );
    assert.equal(uploads.length, 1);
    assert.equal(appendCalls.length, 1);
    assert.equal(appendCalls[0].previews.length, 1);
    assert.equal(appendCalls[0].previews[0].filters, undefined);
  });

  test('abort signal between variants stops launching new ones', async () => {
    installApp({ worker: { concurrency: 1 } });
    const controller = new AbortController();
    const { storage, uploads } = makeStorage(redPng, () => controller.abort());
    const { mediaStore } = makeMediaStore(mediaDoc());
    new Resizer({
      storage,
      mediaStore,
      lockProvider: makeLocks().lockProvider,
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
      { signal: controller.signal },
    );
    assert.equal(uploads.length, 1); // aborted after the first, launched no more
  });

  test('worker.concurrency=1 → variants run serially (no overlap)', async () => {
    installApp({ worker: { concurrency: 1 } });
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
    new Resizer({
      storage,
      mediaStore,
      lockProvider: makeLocks().lockProvider,
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

  test('worker.concurrency=2 → up to two variants run at once', async () => {
    installApp({ worker: { concurrency: 2 } });
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
    new Resizer({
      storage,
      mediaStore,
      lockProvider: makeLocks().lockProvider,
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
    const r = new Resizer({ storage, mediaStore });
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
    const r = new Resizer({ storage, mediaStore });
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
    const r = new Resizer({ storage, mediaStore });
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
      key: 'e',
      contentType: 'image/jpeg',
    } as unknown as Preview;
    const { mediaStore, appendCalls } = makeMediaStore(null);
    const r = new Resizer({ storage, mediaStore });
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
    const r = new Resizer({ storage, mediaStore });
    await assert.rejects(
      () =>
        r.generate({
          media: { original: { key: 'uploads/o', contentType: 'image/jpeg' } },
          sizes: [{ width: 20, height: 20 }],
          formats: ['jpeg'],
        }),
      /media has neither/,
    );
  });

  test('SVG original → log + { created: [], failed: 0 }, nothing uploaded or persisted', async () => {
    const { logs } = installApp();
    const { storage, uploads } = makeStorage(redPng);
    const { mediaStore, appendCalls } = makeMediaStore(null);
    const r = new Resizer({ storage, mediaStore });
    const result = await r.generate({
      media: mediaDoc({
        original: { key: 'uploads/x.svg', contentType: 'image/svg+xml' },
      }),
      sizes: [{ width: 20, height: 20 }],
      formats: ['jpeg'],
    });
    assert.deepEqual(result.created, []);
    assert.equal(result.failed, 0);
    assert.equal(uploads.length, 0);
    assert.equal(appendCalls.length, 0);
    assert.ok(logs.info.some((l) => String(l[0]).includes('SVG')));
  });

  test('no original → ResizeNoOriginalError', async () => {
    installApp();
    const { storage } = makeStorage(redPng);
    const { mediaStore } = makeMediaStore(null);
    const r = new Resizer({ storage, mediaStore });
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
    const r = new Resizer({ storage, mediaStore });
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
    const r = new Resizer({
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
    const r = new Resizer({
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
    enqueue: async () => ({ taskId: null }),
    startWorker: async (handle) => {
      onStart?.(handle);
    },
  });

  test('worker.enabled=false → clean no-op (startWorker NOT called); log says how to enable', async () => {
    const { logs } = installApp(); // default worker.enabled is false
    let started = false;
    new Resizer({
      storage: makeStorage(redPng).storage,
      transport: fakeTransport(() => {
        started = true;
      }),
    });
    await runResizeWorker();
    assert.equal(started, false);
    assert.ok(
      logs.info.some((l) => String(l[0]).includes('worker.enabled=true')),
    );
  });

  test('no transport → logs an error and returns', async () => {
    const { logs } = installApp({ worker: { enabled: true } });
    new Resizer({ storage: makeStorage(redPng).storage });
    await runResizeWorker();
    assert.ok(logs.error.length >= 1);
  });

  test('enabled + transport → startWorker gets a handler that reaches processTask', async () => {
    installApp({ worker: { enabled: true } });
    let handle:
      | ((task: LeasedTask, opts?: { signal: AbortSignal }) => Promise<void>)
      | undefined;
    const { mediaStore } = makeMediaStore(null); // processTask loads null → no-op
    new Resizer({
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
