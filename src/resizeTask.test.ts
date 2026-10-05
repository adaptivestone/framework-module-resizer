// Worker core tests (07 · Worker + 11 · Modes). Real sharp on tiny in-memory fixtures
// generated with sharp itself; fakes for storage, database and task queues.
// Fresh Resizer + fake ambient app per test (node:test = per-file process isolation).
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, mock, test } from 'node:test';
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
  ResizeMediaError,
  ResizeNoOriginalError,
  ResizeSetupError,
} from './errors.ts';
import ResizeWorker from './framework/ResizeWorkerCommand.ts';
import { FrameworkResizer } from './framework/resizer.ts';
import { runResizeWorker } from './framework/worker.ts';
import { getSizeKey, toMissingPreview } from './images.ts';
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

/** Raw RGB frames of one solid colour each, stacked vertically (sharp's animation layout). */
function solidFrames(colours: number[][], width: number, height: number) {
  return Buffer.concat(
    colours.map((colour) => {
      const frame = Buffer.alloc(width * height * 3);
      for (let i = 0; i < width * height; i++) {
        frame.set(colour, i * 3);
      }
      return frame;
    }),
  );
}

const RGB = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
];

// Three 20×20 frames: red, green, blue.
const animatedGif = await sharp(solidFrames(RGB, 20, 20), {
  raw: { width: 20, height: 60, channels: 3, pageHeight: 20 },
})
  .gif({ delay: [100, 100, 100] })
  .toBuffer();

// Three 20×10 frames with EXIF orientation 6 → displayed 10×20.
const orientedAnimatedWebp = await sharp(solidFrames(RGB, 20, 10), {
  raw: { width: 20, height: 30, channels: 3, pageHeight: 10 },
})
  .webp({ delay: [100, 100, 100] })
  .withMetadata({ orientation: 6 })
  .toBuffer();

const tallPng = await sharp({
  create: { width: 1, height: 100, channels: 3, background: '#808080' },
})
  .png()
  .toBuffer();

const widePng = await sharp({
  create: { width: 100, height: 1, channels: 3, background: '#808080' },
})
  .png()
  .toBuffer();

// A 1×5000 SVG: at the density a 300×300 cover needs, its long side would exceed librsvg's
// 32767-pixel limit.
const tallSvg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="5000"><rect width="1" height="5000" fill="red"/></svg>',
);

// Six turbulence-filtered rects: librsvg needs more than 10 s for this 488-byte SVG, inside one
// native call that sharp's `.timeout()` cannot interrupt.
const heavySvg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><filter id="f" x="0" y="0" width="1" height="1"><feTurbulence baseFrequency="0.02" numOctaves="10"/></filter>${'<rect width="100%" height="100%" filter="url(#f)"/>'.repeat(6)}</svg>`,
);

// Larger than the boxes the fractional-size and cap tests request, so they still crop.
const bigPng = await sharp({
  create: { width: 400, height: 300, channels: 3, background: '#3366cc' },
})
  .png()
  .toBuffer();

// 100×80 photo-like JPEG carrying EXIF, including a GPS position.
const exifJpeg = await sharp(texture(100, 80), {
  raw: { width: 100, height: 80, channels: 3 },
})
  .jpeg({ quality: 90 })
  .withExif({
    IFD0: { Artist: 'Someone', Copyright: 'Someone' },
    IFD3: {
      GPSLatitudeRef: 'N',
      GPSLatitude: '51/1 30/1 0/1',
      GPSLongitudeRef: 'W',
      GPSLongitude: '0/1 7/1 0/1',
    },
  })
  .toBuffer();

// Photo-like texture (smooth waves plus fine noise), so re-encoding loss is measurable.
function texture(width: number, height: number): Buffer {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const v =
        128 +
        50 * Math.sin(x / 7) * Math.cos(y / 11) +
        30 * Math.sin((x + y) / 3.3) +
        ((((x * 73856093) ^ (y * 19349663)) >>> 0) % 21) -
        10;
      raw[i] = Math.max(0, Math.min(255, v));
      raw[i + 1] = Math.max(0, Math.min(255, 255 - v * 0.8));
      raw[i + 2] = Math.max(0, Math.min(255, v * 0.5 + 60));
    }
  }
  return raw;
}

// Identical stored pixels (300×200); only the EXIF orientation tag differs.
const texturedJpeg = (orientation: number) =>
  sharp(texture(300, 200), { raw: { width: 300, height: 200, channels: 3 } })
    .jpeg({ quality: 95 })
    .withMetadata({ orientation })
    .toBuffer();

/** Peak signal-to-noise ratio of two same-size images (Infinity when identical). */
async function psnr(a: Buffer, b: Buffer): Promise<number> {
  const x = await sharp(a).removeAlpha().raw().toBuffer();
  const y = await sharp(b).removeAlpha().raw().toBuffer();
  assert.equal(x.length, y.length);
  let squared = 0;
  for (let i = 0; i < x.length; i++) {
    squared += (x[i] - y[i]) ** 2;
  }
  return squared === 0
    ? Number.POSITIVE_INFINITY
    : 10 * Math.log10((255 * 255 * x.length) / squared);
}

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
  mock.restoreAll();
});

/** Count SVG render processes (svgRaster spawns one node child per render). */
function countRenders(): () => number {
  const spawn = mock.method(childProcess, 'spawn');
  return () => spawn.mock.callCount();
}

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
    // 400×300 is larger than the requested 300×300 box, so it is cover-cropped, to the cap.
    const { storage } = makeStorage(bigPng);
    const { db, appendCalls } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
    });
    await processTask(
      task({
        previews: [
          variant({
            sizeKey: '300x300',
            requestedWidth: 300,
            requestedHeight: 300,
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
// Pipelines: an unregistered name never renders
// ---------------------------------------------------------------------------

describe('unknown pipeline', () => {
  function countingStorage(fixture: Buffer) {
    const base = makeStorage(fixture);
    let downloads = 0;
    const storage: ResizeStorage = {
      ...base.storage,
      download: async () => {
        downloads += 1;
        return fixture;
      },
    };
    return { storage, uploads: base.uploads, downloads: () => downloads };
  }

  const isUnknownPipeline = (err: unknown) =>
    err instanceof ResizeSetupError &&
    err.code === 'RESIZE_PIPELINE_UNKNOWN' &&
    err.message.includes("'watermark-v2'");

  test('a queued task for an unregistered pipeline fails before download; nothing is stored', async () => {
    installApp();
    const { storage, uploads, downloads } = countingStorage(redPng);
    const { db, appendCalls } = makeDatabase(mediaDoc());
    const { lockProvider, acquired } = makeLocks(true);
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(lockProvider) },
      pipelines: { watermark: {} },
    });
    await assert.rejects(
      () =>
        processTask(task({ pipeline: 'watermark-v2', previews: [variant()] })),
      isUnknownPipeline,
    );
    assert.equal(downloads(), 0);
    assert.equal(uploads.length, 0);
    assert.equal(appendCalls.length, 0);
    assert.deepEqual(acquired, []);
  });

  test('generate() with an unregistered pipeline throws before download', async () => {
    installApp();
    const { storage, uploads, downloads } = countingStorage(redPng);
    const { db, appendCalls } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
    await assert.rejects(
      () =>
        r.generate({
          media: mediaDoc(),
          sizes: [{ width: 20, height: 20 }],
          formats: ['jpeg'],
          pipeline: 'watermark-v2',
        }),
      isUnknownPipeline,
    );
    assert.equal(downloads(), 0);
    assert.equal(uploads.length, 0);
    assert.equal(appendCalls.length, 0);
  });

  test("'default' renders without being registered", async () => {
    installApp();
    const { storage, uploads } = makeStorage(redPng);
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db, pipelines: {} });
    const { created } = await r.generate({
      media: mediaDoc(),
      sizes: [{ width: 20, height: 20 }],
      formats: ['jpeg'],
    });
    assert.equal(created.length, 1);
    assert.equal(uploads.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Animated sources (config.animated)
// ---------------------------------------------------------------------------

describe('animated sources', () => {
  const formats = ['webp', 'gif', 'avif', 'jpeg', 'png'];
  const widthOnly = (format: string) =>
    variant({
      sizeKey: '10w',
      format,
      requestedWidth: 10,
      requestedHeight: undefined,
    });

  async function framesOf(body: Buffer) {
    const meta = await sharp(body, { animated: true }).metadata();
    return {
      pages: meta.pages ?? 1,
      frameHeight: meta.pageHeight ?? meta.height,
    };
  }

  async function pixelAt(body: Buffer, left: number, top: number) {
    return [
      ...(await sharp(body)
        .removeAlpha()
        .extract({ left, top, width: 1, height: 1 })
        .raw()
        .toBuffer()),
    ];
  }

  const topLeftPixel = (body: Buffer) => pixelAt(body, 0, 0);

  test('a 3-frame GIF: webp and gif keep every frame, other formats get the first frame', async () => {
    installApp({
      animated: true,
      encode: { formats: { gif: {}, png: {} } },
    });
    const { storage, uploads } = makeStorage(animatedGif);
    const { db, appendCalls } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
    });
    await processTask(task({ previews: formats.map(widthOnly) }));

    assert.equal(uploads.length, formats.length);
    const bodies = new Map(uploads.map((u) => [u.key, u.body]));
    const expectedPages: Record<string, number> = {
      webp: 3,
      gif: 3,
      avif: 1,
      jpeg: 1,
      png: 1,
    };
    for (const row of appendCalls[0].previews) {
      const { format } = row;
      const body = bodies.get((row.storageRef as { key: string }).key);
      assert.ok(body, `${format} uploaded`);
      const { pages, frameHeight } = await framesOf(body);
      assert.equal(pages, expectedPages[format], `${format} pages`);
      assert.equal(frameHeight, 10, `${format} frame height`);
      // Per-frame size recorded, not the height of all frames stacked.
      assert.equal(row.actualWidth, 10, `${format} actualWidth`);
      assert.equal(row.actualHeight, 10, `${format} actualHeight`);
      if (expectedPages[format] === 1) {
        const [r, g, b] = await topLeftPixel(body);
        assert.ok(
          r > 200 && g < 60 && b < 60,
          `${format} is the first (red) frame`,
        );
      }
    }
    assert.deepEqual(
      appendCalls[0].previews.map((p) => p.format).sort(),
      [...formats].sort(),
    );
  });

  test('an animation above limits.animationFrames keeps only the first frames', async () => {
    installApp({ animated: true, limits: { animationFrames: 2 } });
    const { storage, uploads } = makeStorage(animatedGif);
    const { db, appendCalls } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
    });
    await processTask(
      task({ previews: [widthOnly('webp'), variant({ format: 'webp' })] }),
    );
    assert.equal(uploads.length, 2);
    for (const upload of uploads) {
      assert.equal((await framesOf(upload.body)).pages, 2);
    }
    const cover = appendCalls[0].previews.find((p) => p.sizeKey === '20x20');
    assert.equal(cover?.actualWidth, 20);
    assert.equal(cover?.actualHeight, 20);
  });

  test('animated: false (default) decodes only the first frame', async () => {
    installApp();
    const { storage, uploads } = makeStorage(animatedGif);
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
    await r.generate({
      media: mediaDoc(),
      sizes: [{ width: 10 }],
      formats: ['webp'],
    });
    assert.deepEqual(await framesOf(uploads[0].body), {
      pages: 1,
      frameHeight: 10,
    });
  });

  test('an animation with an EXIF orientation renders upright from its first frame', async () => {
    // libvips cannot rotate a multi-page image, so orientation wins over the animation.
    installApp({ animated: true });
    const { storage, uploads } = makeStorage(orientedAnimatedWebp);
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
    const { created, failed } = await r.generate({
      media: mediaDoc(),
      sizes: [{ fit: true }],
      formats: ['webp'],
    });
    assert.equal(failed, 0);
    assert.equal(created[0].actualWidth, 10);
    assert.equal(created[0].actualHeight, 20);
    assert.deepEqual(await framesOf(uploads[0].body), {
      pages: 1,
      frameHeight: 20,
    });
  });

  test('a pipeline with variantSteps renders the first frame, so a watermark lands on every output', async () => {
    installApp({ animated: true, encode: { formats: { gif: {} } } });
    const mark = await sharp({
      create: { width: 6, height: 6, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const { storage, uploads } = makeStorage(animatedGif);
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({
      storage,
      db,
      pipelines: {
        default: {
          variantSteps: [
            async (img) =>
              img.composite([{ input: mark, gravity: 'southeast' }]),
          ],
        },
      },
    });
    const { created, failed } = await r.generate({
      media: mediaDoc(),
      sizes: [{ width: 20, height: 20 }],
      formats: ['webp', 'gif'],
    });
    assert.equal(failed, 0);
    assert.equal(created.length, 2);
    for (const upload of uploads) {
      assert.deepEqual(await framesOf(upload.body), {
        pages: 1,
        frameHeight: 20,
      });
      const [r0, g0, b0] = await topLeftPixel(upload.body);
      assert.ok(r0 > 200 && g0 < 60 && b0 < 60, 'the first (red) frame');
      const [r1, g1, b1] = await pixelAt(upload.body, 18, 18);
      assert.ok(r1 > 200 && g1 > 200 && b1 > 200, 'the overlay is present');
    }
  });

  test('limits.sourcePixels counts frames only when an output is animated', async () => {
    // 20×20 frames: one frame (400 px) fits 800, all three (1200 px) do not.
    installApp({ animated: true, limits: { sourcePixels: 800 } });
    const { storage, uploads } = makeStorage(animatedGif);
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
    const { created, failed } = await r.generate({
      media: mediaDoc(),
      sizes: [{ width: 10 }],
      formats: ['jpeg', 'avif'],
    });
    assert.equal(failed, 0);
    assert.equal(created.length, 2);
    for (const upload of uploads) {
      assert.equal((await framesOf(upload.body)).pages, 1);
    }
  });

  test('an animation over limits.sourcePixels is shortened to the frames that fit', async () => {
    installApp({ animated: true, limits: { sourcePixels: 800 } });
    const { storage, uploads } = makeStorage(animatedGif);
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
    const { created, failed } = await r.generate({
      media: mediaDoc(),
      sizes: [{ width: 10 }],
      formats: ['webp'],
    });
    assert.equal(failed, 0);
    assert.equal(created[0].actualHeight, 10);
    assert.deepEqual(await framesOf(uploads[0].body), {
      pages: 2,
      frameHeight: 10,
    });
  });

  test('a single animation frame over limits.sourcePixels is still refused', async () => {
    installApp({ animated: true, limits: { sourcePixels: 300 } });
    const { storage, uploads } = makeStorage(animatedGif);
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
    await assert.rejects(
      () =>
        r.generate({
          media: mediaDoc(),
          sizes: [{ width: 10 }],
          formats: ['webp'],
        }),
      (err: unknown) =>
        err instanceof ResizeMediaError &&
        err.code === 'RESIZE_SOURCE_TOO_LARGE',
    );
    assert.equal(uploads.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Cover sizes: the derived side, fractional sizes
// ---------------------------------------------------------------------------

describe('cover sizes', () => {
  test('width-only on a 1×100 source: the derived height is cropped to limits.resultDimension', async () => {
    installApp({ limits: { resultDimension: 200 } });
    const { storage, uploads } = makeStorage(tallPng);
    const { db, appendCalls } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
    });
    await processTask(
      task({
        previews: [
          variant({
            sizeKey: '100w',
            requestedWidth: 100,
            requestedHeight: undefined,
          }),
        ],
      }),
    );
    const meta = await sharp(uploads[0].body).metadata();
    assert.deepEqual([meta.width, meta.height], [100, 200]);
    assert.equal(appendCalls[0].previews[0].actualWidth, 100);
    assert.equal(appendCalls[0].previews[0].actualHeight, 200);
  });

  test('height-only on a 100×1 source: the derived width is cropped to limits.resultDimension', async () => {
    installApp({ limits: { resultDimension: 200 } });
    const { storage, uploads } = makeStorage(widePng);
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
    const { created } = await r.generate({
      media: mediaDoc(),
      sizes: [{ height: 100 }],
      formats: ['jpeg'],
    });
    const meta = await sharp(uploads[0].body).metadata();
    assert.deepEqual([meta.width, meta.height], [200, 100]);
    assert.equal(created[0].sizeKey, '100h');
  });

  test('width-only within the cap keeps the source aspect ratio', async () => {
    installApp();
    const { storage } = makeStorage(redPng); // 64×48
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
    const { created } = await r.generate({
      media: mediaDoc(),
      sizes: [{ width: 32 }],
      formats: ['jpeg'],
    });
    assert.equal(created[0].actualWidth, 32);
    assert.equal(created[0].actualHeight, 24);
  });

  test('a fractional size generates through generate()', async () => {
    installApp();
    const { storage } = makeStorage(bigPng);
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
    const { created, failed } = await r.generate({
      media: mediaDoc(),
      sizes: [{ width: 300.5, height: 200 }],
      formats: ['jpeg'],
    });
    assert.equal(failed, 0);
    assert.equal(created[0].sizeKey, '301x200');
    assert.equal(created[0].actualWidth, 301);
    assert.equal(created[0].actualHeight, 200);
  });

  test('a fractional size generates through the queued path', async () => {
    installApp();
    const { storage } = makeStorage(bigPng);
    const { db, appendCalls } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
    });
    const size = { width: 300.5, height: 200 };
    await processTask(
      task({ previews: [toMissingPreview(size, getSizeKey(size), 'jpeg')] }),
    );
    const row = appendCalls[0].previews[0];
    assert.equal(row.sizeKey, '301x200');
    assert.equal(row.actualWidth, 301);
    assert.equal(row.actualHeight, 200);
  });

  test('an old task payload with fractional dimensions is rounded before sharp', async () => {
    installApp();
    const { storage } = makeStorage(bigPng);
    const { db, appendCalls } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
    });
    await processTask(
      task({
        previews: [
          variant({
            sizeKey: '301x200',
            requestedWidth: 300.5,
            requestedHeight: 199.8,
          }),
        ],
      }),
    );
    const row = appendCalls[0].previews[0];
    assert.equal(row.actualWidth, 301);
    assert.equal(row.actualHeight, 200);
    assert.equal(row.requestedWidth, 301);
    assert.equal(row.requestedHeight, 200);
  });

  test('fit on an extreme aspect ratio keeps each side at least 1 pixel', async () => {
    installApp();
    // 1×5000 into the 2000×1200 box: scale 0.24 rounds the width to 0.
    const needle = await sharp({
      create: { width: 1, height: 5000, channels: 3, background: '#808080' },
    })
      .png()
      .toBuffer();
    const { storage } = makeStorage(needle);
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
    const { created, failed } = await r.generate({
      media: mediaDoc(),
      sizes: [{ fit: true }],
      formats: ['jpeg'],
    });
    assert.equal(failed, 0);
    assert.equal(created[0].actualWidth, 1);
    assert.equal(created[0].actualHeight, 1200);
  });
});

// ---------------------------------------------------------------------------
// Per-call formats must be configured encoders
// ---------------------------------------------------------------------------

describe('unconfigured formats', () => {
  test('generate() rejects formats without an encode.formats entry before any work', async () => {
    installApp();
    let downloads = 0;
    const base = makeStorage(alphaPng);
    const storage: ResizeStorage = {
      ...base.storage,
      download: async () => {
        downloads += 1;
        return alphaPng;
      },
    };
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
    await assert.rejects(
      () =>
        r.generate({
          media: mediaDoc(),
          sizes: [{ width: 20, height: 20 }],
          formats: ['jpeg', 'jpg', 'raw', 'toString'],
        }),
      (err: unknown) => {
        // A wrong per-call argument is a wiring error at the call site, not a boot-time config.
        assert.ok(err instanceof ResizeSetupError);
        assert.equal(err.code, 'RESIZE_FORMAT_NOT_CONFIGURED');
        assert.match(err.message, /\[jpg, raw, toString\]/);
        return true;
      },
    );
    assert.equal(downloads, 0);
    assert.equal(base.uploads.length, 0);
  });

  test('a queued variant with an unconfigured format fails alone and is logged', async () => {
    const { logs } = installApp();
    const { storage, uploads } = makeStorage(alphaPng);
    const { db, appendCalls } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
    });
    await assert.rejects(
      () =>
        processTask(
          task({ previews: [variant(), variant({ format: 'jpg' })] }),
        ),
      (err: unknown) =>
        err instanceof ResizeGenerateError &&
        err.missing.includes('default:default:20x20:jpg:none'),
    );
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].contentType, 'image/jpeg');
    assert.deepEqual(
      appendCalls[0].previews.map((p) => p.format),
      ['jpeg'],
    );
    assert.ok(
      logs.error.some(
        (entry) =>
          entry[1] instanceof ResizeSetupError &&
          entry[1].code === 'RESIZE_FORMAT_NOT_CONFIGURED',
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// EXIF orientation: no lossy re-encode of the original
// ---------------------------------------------------------------------------

describe('EXIF orientation quality', () => {
  const sizes = [{ width: 100, height: 120 }, { fit: true }, { width: 100 }];

  /** Generate PNG (lossless) previews and score each against a rotate-first reference. */
  async function score(source: Buffer, pipeline?: Pipeline) {
    resetResizerForTests();
    resetAppInstance();
    installApp({ encode: { formats: { png: {} } } });
    const { storage, uploads } = makeStorage(source);
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({
      storage,
      db,
      ...(pipeline ? { pipelines: { default: pipeline } } : {}),
    });
    const { created } = await r.generate({
      media: mediaDoc(),
      sizes,
      formats: ['png'],
    });
    const scores = new Map<string, { dims: string; psnr: number }>();
    for (const preview of created) {
      const body = uploads.find(
        (u) => u.key === (preview.storageRef as { key: string }).key,
      )?.body as Buffer;
      const reference = await (preview.fit
        ? sharp(source)
            .rotate()
            .resize(2000, 1200, { fit: 'inside', withoutEnlargement: true })
            .toColorspace('srgb')
        : sharp(source)
            .rotate()
            .resize(preview.requestedWidth, preview.requestedHeight, {
              fit: 'cover',
              position: 'center',
            })
            .toColorspace('srgb')
            .sharpen()
      )
        .png()
        .toBuffer();
      const out = await sharp(body).metadata();
      const ref = await sharp(reference).metadata();
      assert.deepEqual([out.width, out.height], [ref.width, ref.height]);
      scores.set(preview.sizeKey, {
        dims: `${out.width}x${out.height}`,
        psnr: await psnr(body, reference),
      });
    }
    return scores;
  }

  test('orientation 6 without beforeSteps: same dims and pixels as rotating first, no added loss', async () => {
    const rotated = await score(await texturedJpeg(6));
    const upright = await score(await texturedJpeg(1));
    assert.deepEqual(
      [...rotated].map(([key, s]) => `${key}=${s.dims}`).sort(),
      ['100w=100x150', '100x120=100x120', 'fit=200x300'],
    );
    for (const [key, { psnr: db }] of rotated) {
      assert.ok(db >= 50, `${key}: ${db.toFixed(2)} dB vs rotate-first`);
      const baseline = upright.get(key)?.psnr ?? 0;
      assert.ok(
        db >= baseline - 0.5,
        `${key}: ${db.toFixed(2)} dB vs orientation-1 ${baseline.toFixed(2)} dB`,
      );
    }
  });

  test('orientation 6 with beforeSteps: normalised first, without visible loss', async () => {
    let seen: { width?: number; height?: number } = {};
    const scores = await score(await texturedJpeg(6), {
      beforeSteps: [
        async (buf) => {
          const meta = await sharp(buf).metadata();
          seen = { width: meta.width, height: meta.height };
          return buf;
        },
      ],
    });
    assert.deepEqual(seen, { width: 200, height: 300 });
    assert.equal(scores.size, 3);
    for (const [key, { psnr: db }] of scores) {
      // A default-quality JPEG round trip of this texture scores about 35 dB.
      assert.ok(db >= 45, `${key}: ${db.toFixed(2)} dB vs rotate-first`);
    }
  });

  test('an oriented WebP with beforeSteps is normalised with a fast lossy encode', async () => {
    // Lossless WebP of a large photo takes seconds and tens of MB; quality 95 is enough for
    // an intermediate.
    const source = await sharp(texture(300, 200), {
      raw: { width: 300, height: 200, channels: 3 },
    })
      .webp({ quality: 95 })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    let chunk = '';
    let seen: { width?: number; height?: number } = {};
    installApp({ encode: { formats: { png: {} } } });
    const { storage } = makeStorage(source);
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({
      storage,
      db,
      pipelines: {
        default: {
          beforeSteps: [
            async (buf) => {
              // Simple-format WebP: the first chunk names the codec (VP8 lossy, VP8L lossless).
              chunk = Buffer.from(buf).toString('ascii', 12, 16);
              const meta = await sharp(buf).metadata();
              seen = { width: meta.width, height: meta.height };
              return buf;
            },
          ],
        },
      },
    });
    const { created } = await r.generate({
      media: mediaDoc(),
      sizes: [{ width: 100 }],
      formats: ['png'],
    });
    assert.equal(chunk, 'VP8 ');
    assert.deepEqual(seen, { width: 200, height: 300 });
    assert.equal(created[0].actualHeight, 150);
  });
});

// ---------------------------------------------------------------------------
// SVG rasterization stays within librsvg's side limit
// ---------------------------------------------------------------------------

describe('SVG raster size', () => {
  test('a 1×5000 SVG renders cover and fit variants', async () => {
    installApp();
    const { storage } = makeStorage(tallSvg);
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
    const { created, failed } = await r.generate({
      media: mediaDoc({
        original: { storageRef: { key: 'uploads/x.svg' }, format: 'svg' },
      }),
      sizes: [{ width: 300, height: 300 }, { fit: true }],
      formats: ['jpeg'],
    });
    assert.equal(failed, 0);
    const dims = Object.fromEntries(
      created.map((p) => [p.sizeKey, `${p.actualWidth}x${p.actualHeight}`]),
    );
    assert.deepEqual(dims, { '300x300': '300x300', fit: '1x1200' });
  });

  test('an SVG wider than the side limit keeps its exact fit size', async () => {
    // 40000 px wide at 72 dpi: the cover decode drops below 72 dpi, fit must not.
    installApp();
    const wideSvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="40000" height="300"><rect width="40000" height="300" fill="red"/></svg>',
    );
    const { storage } = makeStorage(wideSvg);
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
    const { created, failed } = await r.generate({
      media: mediaDoc({
        original: { storageRef: { key: 'uploads/x.svg' }, format: 'svg' },
      }),
      sizes: [{ fit: true }, { width: 300, height: 300 }, { height: 25 }],
      formats: ['jpeg'],
    });
    assert.equal(failed, 0);
    const dims = Object.fromEntries(
      created.map((p) => [p.sizeKey, `${p.actualWidth}x${p.actualHeight}`]),
    );
    // 25 × 40000 / 300 = 3333.3: exact although the pixel limit allows only a coarse size read.
    assert.deepEqual(dims, {
      fit: '2000x15',
      '300x300': '300x300',
      '25h': '3333x25',
    });
  });

  test('a 1×40000 SVG renders its fit variant (no 72 dpi decode over the side limit)', async () => {
    installApp();
    const needleSvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="40000"><rect width="1" height="40000" fill="red"/></svg>',
    );
    const { storage } = makeStorage(needleSvg);
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
    const { created, failed } = await r.generate({
      media: mediaDoc({
        original: { storageRef: { key: 'uploads/x.svg' }, format: 'svg' },
      }),
      sizes: [{ fit: true }, { width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(failed, 0);
    const dims = Object.fromEntries(
      created.map((p) => [p.sizeKey, `${p.actualWidth}x${p.actualHeight}`]),
    );
    assert.deepEqual(dims, { fit: '1x1200', '300x300': '300x300' });
  });
});

// ---------------------------------------------------------------------------
// A failed persist names what was uploaded
// ---------------------------------------------------------------------------

describe('persist failure', () => {
  test('logs the uploaded but unrecorded storage refs, then rethrows', async () => {
    const { logs } = installApp();
    const { storage, uploads } = makeStorage(redPng);
    const dbDown = new Error('db down');
    const db = fakeDb({
      appendPreviews: async () => {
        throw dbDown;
      },
    });
    const r = new FrameworkResizer({ storage, db });
    await assert.rejects(
      () =>
        r.generate({
          media: mediaDoc(),
          sizes: [{ width: 20, height: 20 }],
          formats: ['jpeg', 'webp'],
        }),
      (err: unknown) => err === dbDown,
    );
    assert.equal(uploads.length, 2);
    const entry = logs.error.find((l) => l[1] === dbDown);
    assert.ok(entry, 'the persist failure is logged');
    for (const upload of uploads) {
      assert.ok(
        String(entry[0]).includes(upload.key),
        `${upload.key} is named in the log`,
      );
    }
  });

  /** A database that stores the first preview, then fails (a write of one row at a time). */
  function failsAfterFirst(reload: () => Promise<MediaLike | null>) {
    const media = mediaDoc();
    const dbDown = new Error('db down after one row');
    const db: ResizeDatabase = {
      ...fakeDb(),
      loadMedia: reload,
      appendPreviews: async (_mediaId, previews) => {
        media.previews = [previews[0]];
        throw dbDown;
      },
    };
    return { db, media, dbDown };
  }

  test('a write that stopped part-way names only the uploads that are not stored', async () => {
    const { logs } = installApp();
    const { storage, uploads } = makeStorage(redPng);
    const state: { media?: MediaLike } = {};
    const { db, media, dbDown } = failsAfterFirst(
      async () => state.media ?? null,
    );
    state.media = media;
    const r = new FrameworkResizer({ storage, db });
    await assert.rejects(
      () =>
        r.generate({
          media: mediaDoc(),
          sizes: [{ width: 20, height: 20 }],
          formats: ['jpeg', 'webp'],
        }),
      (err: unknown) => err === dbDown,
    );
    const entry = logs.error.find((l) => l[1] === dbDown);
    assert.ok(entry);
    const storedRef = media.previews?.[0]?.storageRef as
      | { key: string }
      | undefined;
    assert.ok(storedRef, 'the first row was stored');
    const storedKey = storedRef.key;
    const unstored = uploads.filter((u) => u.key !== storedKey);
    assert.equal(unstored.length, 1);
    assert.ok(String(entry[0]).includes(unstored[0].key), 'unstored is named');
    assert.ok(
      !String(entry[0]).includes(storedKey),
      'a stored row is never offered for deletion',
    );
  });

  test('a failing reload after a failed write names every upload', async () => {
    const { logs } = installApp();
    const { storage, uploads } = makeStorage(redPng);
    const { db, dbDown } = failsAfterFirst(async () => {
      throw new Error('reload failed too');
    });
    const r = new FrameworkResizer({ storage, db });
    await assert.rejects(
      () =>
        r.generate({
          media: mediaDoc(),
          sizes: [{ width: 20, height: 20 }],
          formats: ['jpeg', 'webp'],
        }),
      (err: unknown) => err === dbDown,
    );
    const entry = logs.error.find((l) => l[1] === dbDown);
    assert.ok(entry);
    for (const upload of uploads) {
      assert.ok(String(entry[0]).includes(upload.key), upload.key);
    }
  });
});

// ---------------------------------------------------------------------------
// SVG: rendered once per task, in a child process with a hard time limit
// ---------------------------------------------------------------------------

describe('SVG rendering', () => {
  const svgDoc = () =>
    mediaDoc({
      original: { storageRef: { key: 'uploads/x.svg' }, format: 'svg' },
    });

  /** True while a process with `pid` exists (signal 0 only checks). */
  function isRunning(pid: number | undefined): boolean {
    if (pid === undefined) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  test('eager: one render however many sizes and formats are requested', async () => {
    installApp();
    const renders = countRenders();
    const { storage, uploads } = makeStorage(smallSvg);
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
    const { created, failed } = await r.generate({
      media: svgDoc(),
      sizes: [{ width: 200, height: 200 }, { width: 50 }, { fit: true }],
      formats: ['jpeg', 'webp', 'avif'],
    });
    assert.equal(failed, 0);
    assert.equal(created.length, 9);
    assert.equal(uploads.length, 9);
    assert.equal(renders(), 1);
  });

  test('queued: one render per task', async () => {
    installApp();
    const renders = countRenders();
    const { storage, uploads } = makeStorage(smallSvg);
    const { db, appendCalls } = makeDatabase(svgDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
    });
    await processTask(
      task({
        previews: [
          variant(),
          variant({ format: 'webp' }),
          variant({
            sizeKey: '40w',
            requestedWidth: 40,
            requestedHeight: undefined,
          }),
          fitVariant,
        ],
      }),
    );
    assert.equal(uploads.length, 4);
    assert.equal(appendCalls[0].previews.length, 4);
    assert.equal(renders(), 1);
  });

  test('eager: a render over limits.processingTimeoutSeconds is killed (RESIZE_SVG_RENDER_TIMEOUT)', {
    timeout: 8000,
  }, async () => {
    installApp({ limits: { processingTimeoutSeconds: 1 } });
    const spawn = mock.method(childProcess, 'spawn');
    const { storage, uploads } = makeStorage(heavySvg);
    const { db, appendCalls } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
    const started = Date.now();
    await assert.rejects(
      () =>
        r.generate({
          media: svgDoc(),
          sizes: [{ width: 300, height: 300 }, { fit: true }],
          formats: ['jpeg', 'webp'],
        }),
      (err: unknown) =>
        err instanceof ResizeMediaError &&
        err.code === 'RESIZE_SVG_RENDER_TIMEOUT' &&
        err.mediaId === 'm1',
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3500, `settled after ${elapsed} ms`);
    assert.equal(spawn.mock.callCount(), 1);
    assert.equal(
      isRunning((spawn.mock.calls[0].result as { pid?: number }).pid),
      false,
    );
    assert.equal(uploads.length, 0);
    assert.equal(appendCalls.length, 0);
  });

  test('queued: a render over the time limit fails the task (RESIZE_SVG_RENDER_TIMEOUT); nothing is stored', {
    timeout: 8000,
  }, async () => {
    installApp({ limits: { processingTimeoutSeconds: 1 } });
    const { storage, uploads } = makeStorage(heavySvg);
    const { db, appendCalls } = makeDatabase(svgDoc());
    const { lockProvider, acquired } = makeLocks(true);
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(lockProvider) },
    });
    await assert.rejects(
      () => processTask(task({ previews: [variant(), fitVariant] })),
      (err: unknown) =>
        err instanceof ResizeMediaError &&
        err.code === 'RESIZE_SVG_RENDER_TIMEOUT',
    );
    assert.equal(uploads.length, 0);
    assert.equal(appendCalls.length, 0);
    assert.deepEqual(acquired, []);
  });

  /** Red, green and blue of the pixel at x, y. */
  async function rgbAt(body: Buffer, x: number, y: number) {
    return [
      ...(await sharp(body)
        .removeAlpha()
        .extract({ left: x, top: y, width: 1, height: 1 })
        .raw()
        .toBuffer()),
    ];
  }
  const isRed = ([r, g, b]: number[]) => r > 200 && g < 60 && b < 60;
  const isBlue = ([r, g, b]: number[]) => b > 200 && r < 60 && g < 60;

  test('beforeSteps receive the rendered PNG: one render, and a large size stays sharp', async () => {
    installApp({ encode: { formats: { png: {} } } });
    const renders = countRenders();
    // Left half red, right half blue. A 2000 px preview upscaled from the 20×10 natural size
    // would blur the edge over about 100 px.
    const { storage, uploads } = makeStorage(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="10" height="10" fill="red"/><rect x="10" width="10" height="10" fill="blue"/></svg>',
      ),
    );
    const { db } = makeDatabase(null);
    const seen: Array<{ head: string; format?: string; width?: number }> = [];
    const r = new FrameworkResizer({
      storage,
      db,
      pipelines: {
        default: {
          beforeSteps: [
            async (buf, { metadata }) => {
              seen.push({
                head: Buffer.from(buf).subarray(0, 8).toString('latin1'),
                format: metadata.format,
                width: metadata.width,
              });
              // A step that decodes: it must get pixels, not SVG markup to render in-process.
              return sharp(buf).toBuffer();
            },
          ],
        },
      },
    });
    const { created, failed } = await r.generate({
      media: svgDoc(),
      sizes: [{ width: 2000 }],
      formats: ['png'],
    });
    assert.equal(failed, 0);
    assert.equal(renders(), 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].head, '\x89PNG\r\n\x1a\n');
    assert.equal(seen[0].format, 'png');
    assert.equal(seen[0].width, 2000);
    assert.deepEqual(
      [created[0].actualWidth, created[0].actualHeight],
      [2000, 1000],
    );
    assert.ok(isRed(await rgbAt(uploads[0].body, 990, 500)), 'sharp edge');
    assert.ok(isBlue(await rgbAt(uploads[0].body, 1010, 500)), 'sharp edge');
  });

  test('a derived side over the cap is cropped, even when the SVG size rounds it under', async () => {
    // 1000×0.6 reports as 1000×1: at height 5 the real width is 8333, over the cap of 5000, so
    // the preview is a 5000×5 crop of the middle, not the whole SVG squeezed into 5000×5.
    installApp({ encode: { formats: { png: {} } } });
    const { storage, uploads } = makeStorage(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="0.6"><rect width="300" height="0.6" fill="red"/><rect x="300" width="700" height="0.6" fill="blue"/></svg>',
      ),
    );
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
    const { created, failed } = await r.generate({
      media: svgDoc(),
      sizes: [{ height: 5 }],
      formats: ['png'],
    });
    assert.equal(failed, 0);
    assert.deepEqual(
      [created[0].actualWidth, created[0].actualHeight],
      [5000, 5],
    );
    // Cropped: x = 1200 shows SVG x ≈ 344 (blue). Squeezed it would show x = 240 (red).
    assert.ok(isBlue(await rgbAt(uploads[0].body, 1200, 2)));
  });

  test('a derived side follows the SVG, not the rounded raster', async () => {
    // 620w alone renders at density 223: the raster is 619×310 (619.4×309.7), from which a
    // width-only resize would derive 310.5 → 311.
    installApp();
    const { storage } = makeStorage(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="red"/></svg>',
      ),
    );
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
    const { created, failed } = await r.generate({
      media: svgDoc(),
      sizes: [{ width: 620 }, { height: 25 }],
      formats: ['jpeg'],
    });
    assert.equal(failed, 0);
    const dims = Object.fromEntries(
      created.map((p) => [p.sizeKey, `${p.actualWidth}x${p.actualHeight}`]),
    );
    assert.deepEqual(dims, { '620w': '620x310', '25h': '50x25' });
  });

  test('a normal SVG keeps its output sizes for cover, fit, width-only and height-only sizes', async () => {
    // A derived side (width-only, height-only) is the nearest whole pixel to the SVG's real
    // aspect ratio, whatever density the shared raster was rendered at. The per-variant
    // re-render this replaces usually agreed; where it was off by one, the comment says so.
    const cases: Array<[string, Record<string, string>]> = [
      [
        'width="200" height="100"',
        {
          fit: '200x100',
          // 620 × 100 / 200 = 310 exactly (the raster is 619×310 at this density).
          '620w': '620x310',
          '100w': '100x50',
          '400h': '800x400',
          '25h': '50x25',
          '300x300': '300x300',
        },
      ],
      [
        'width="300" height="200"',
        {
          fit: '300x200',
          '620w': '620x413',
          '100w': '100x67',
          '400h': '600x400',
          '25h': '38x25',
          '300x300': '300x300',
        },
      ],
      [
        'width="8" height="8"',
        {
          fit: '8x8',
          '620w': '620x620',
          '100w': '100x100',
          '400h': '400x400',
          '25h': '25x25',
          '300x300': '300x300',
        },
      ],
      [
        'width="1000" height="10"',
        {
          fit: '1000x10',
          '620w': '620x6',
          '100w': '100x1',
          '400h': '5000x400',
          '25h': '2500x25', // 25 × 1000 / 10; the re-render gave 2497

          '300x300': '300x300',
        },
      ],
      [
        'width="37" height="91"',
        {
          fit: '37x91',
          '620w': '620x1525', // 620 × 91 / 37 = 1524.86; the re-render gave 1524

          '100w': '100x246',
          '400h': '163x400',
          '25h': '10x25',
          '300x300': '300x300',
        },
      ],
      [
        'width="333.3" height="77.7"',
        {
          fit: '333x78',
          '620w': '620x145', // 620 × 77.7 / 333.3 = 144.54
          '100w': '100x23',
          '400h': '1716x400', // 400 × 333.3 / 77.7 = 1715.83; the re-render gave 1717
          '25h': '107x25',
          '300x300': '300x300',
        },
      ],
      [
        'viewBox="0 0 100 50"',
        {
          fit: '100x50',
          '620w': '620x310',
          '100w': '100x50',
          '400h': '800x400',
          '25h': '50x25',
          '300x300': '300x300',
        },
      ],
      [
        'width="3000" height="2000"',
        {
          fit: '1800x1200',
          '620w': '620x413',
          '100w': '100x67',
          '400h': '600x400',
          '25h': '38x25',
          '300x300': '300x300',
        },
      ],
    ];
    for (const [attributes, expected] of cases) {
      resetResizerForTests();
      resetAppInstance();
      installApp();
      const { storage, uploads } = makeStorage(
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}><rect width="100%" height="100%" fill="red"/></svg>`,
        ),
      );
      const { db } = makeDatabase(null);
      const r = new FrameworkResizer({ storage, db });
      const { created, failed } = await r.generate({
        media: svgDoc(),
        sizes: [
          { fit: true },
          { width: 620 },
          { width: 100 },
          { height: 400 },
          { height: 25 },
          { width: 300, height: 300 },
        ],
        formats: ['jpeg'],
      });
      assert.equal(failed, 0, attributes);
      const dims = Object.fromEntries(
        created.map((p) => [p.sizeKey, `${p.actualWidth}x${p.actualHeight}`]),
      );
      assert.deepEqual(dims, expected, attributes);
      for (const upload of uploads) {
        assert.equal((await sharp(upload.body).metadata()).format, 'jpeg');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// One preview row per identity: the database reports what it stored
// ---------------------------------------------------------------------------

describe('one preview row per identity', () => {
  /**
   * A database that stores only the previews `keep` accepts, as if another worker won the rest.
   * `load` answers every loadMedia (the worker's first read, then its reloads).
   */
  function partialDb(
    load: () => MediaLike | null,
    keep: (p: Preview) => boolean,
  ) {
    const appended: Preview[][] = [];
    const db: ResizeDatabase = {
      ...fakeDb({ load: async () => load() }),
      appendPreviews: async (_mediaId, previews) => {
        appended.push(previews);
        return previews.filter(keep);
      },
    };
    return { db, appended };
  }

  // The webp row another worker stored first.
  const otherWorkersWebp: Preview = {
    storageRef: { bucket: 'previews', key: 'other-worker.webp' },
    identity: 'default:default:20x20:webp:none',
    sizeKey: '20x20',
    format: 'webp',
    contentType: 'image/webp',
  };

  /** The media without previews on the first read, with the other worker's row afterwards. */
  function racedMedia() {
    let loads = 0;
    return () => {
      loads += 1;
      return mediaDoc({ previews: loads === 1 ? [] : [otherWorkersWebp] });
    };
  }

  test('every generated preview carries its identity', async () => {
    installApp();
    const { storage } = makeStorage(redPng);
    const { db, appendCalls } = makeDatabase(mediaDoc());
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
      pipelines: { watermark: {} },
    });
    await processTask(
      task({
        pipeline: 'watermark',
        previews: [variant({ filters: { blur: 3 } }), fitVariant],
      }),
    );
    assert.deepEqual(appendCalls[0].previews.map((p) => p.identity).sort(), [
      'default:watermark:20x20:jpeg:blur:3',
      'default:watermark:fit:jpeg:none',
    ]);

    resetResizerForTests();
    const r = new FrameworkResizer({ storage, db, name: 'listings' });
    const { created } = await r.generate({
      media: mediaDoc(),
      sizes: [{ width: 20, height: 20 }],
      formats: ['webp'],
    });
    assert.equal(created[0].identity, 'listings:default:20x20:webp:none');
  });

  test('eager: rows the database left out are not created, not appended and logged once', async () => {
    const { logs } = installApp();
    const { storage, uploads } = makeStorage(redPng);
    // Eager generate never loads first: every read is the reload after the write.
    const { db } = partialDb(
      () => mediaDoc({ previews: [otherWorkersWebp] }),
      (p) => p.format === 'jpeg',
    );
    const fired: Preview[] = [];
    const r = new FrameworkResizer({
      storage,
      db,
      hooks: {
        onPreviewGenerated: (preview: unknown) => {
          fired.push(preview as Preview);
        },
      },
    });
    const media = mediaDoc();
    const { created, failed } = await r.generate({
      media,
      sizes: [{ width: 20, height: 20 }],
      formats: ['jpeg', 'webp'],
    });
    assert.equal(failed, 0);
    assert.deepEqual(
      created.map((p) => p.format),
      ['jpeg'],
    );
    assert.deepEqual(
      media.previews?.map((p) => p.format),
      ['jpeg'],
    );
    assert.deepEqual(
      fired.map((p) => p.format),
      ['jpeg'],
    );
    const webpKey = uploads.find((u) => u.contentType === 'image/webp')?.key;
    assert.ok(webpKey);
    const mentions = [...logs.warn, ...logs.error, ...logs.info].filter((l) =>
      String(l[0]).includes(webpKey),
    );
    assert.equal(mentions.length, 1, 'the unrecorded upload is logged once');
    assert.match(String(mentions[0][0]), /another worker/);
    assert.equal(logs.error.length, 0);
  });

  test('queued: an identity another worker stored first counts as covered', async () => {
    installApp();
    const { storage } = makeStorage(redPng);
    const { db, appended } = partialDb(
      racedMedia(),
      (p) => p.format === 'jpeg',
    );
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
    });
    await processTask(
      task({ previews: [variant(), variant({ format: 'webp' })] }),
    );
    assert.equal(appended.length, 1);
    assert.equal(appended[0].length, 2);
  });

  test('queued: a row left out that the reload does not show is not stored: the task is incomplete', async () => {
    const { logs } = installApp();
    const { storage, uploads } = makeStorage(redPng);
    const { db } = partialDb(
      () => mediaDoc(),
      (p) => p.format === 'jpeg',
    );
    new FrameworkResizer({
      storage,
      db: { ...db, ...fakeLockMethods(makeLocks().lockProvider) },
    });
    await assert.rejects(
      () =>
        processTask(
          task({ previews: [variant(), variant({ format: 'webp' })] }),
        ),
      (err: unknown) =>
        err instanceof ResizeGenerateError &&
        err.code === 'RESIZE_WORKER_INCOMPLETE' &&
        err.missing.includes('default:default:20x20:webp:none'),
    );
    const webpKey = uploads.find((u) => u.contentType === 'image/webp')?.key;
    assert.ok(webpKey);
    const entry = logs.error.find((l) => String(l[0]).includes(webpKey));
    assert.ok(entry, 'the unrecorded upload is named');
    assert.doesNotMatch(String(entry[0]), /another worker/);
  });

  test('rows left out because the media no longer exists are reported as such', async () => {
    const { logs } = installApp();
    const { storage, uploads } = makeStorage(redPng);
    // A driver resolves with an empty list when the media document is gone.
    const { db } = partialDb(
      () => null,
      () => false,
    );
    const r = new FrameworkResizer({ storage, db });
    const { created, failed } = await r.generate({
      media: mediaDoc(),
      sizes: [{ width: 20, height: 20 }],
      formats: ['jpeg', 'webp'],
    });
    assert.equal(failed, 0);
    assert.deepEqual(created, []);
    const entries = logs.warn.filter((l) =>
      /no longer exists/.test(String(l[0])),
    );
    assert.equal(entries.length, 1);
    for (const upload of uploads) {
      assert.ok(String(entries[0][0]).includes(upload.key), upload.key);
    }
    assert.ok(
      ![...logs.warn, ...logs.error].some((l) =>
        /another worker/.test(String(l[0])),
      ),
    );
  });

  test('a database that resolves with nothing stored every row', async () => {
    installApp();
    const { storage } = makeStorage(redPng);
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
    const media = mediaDoc();
    const { created } = await r.generate({
      media,
      sizes: [{ width: 20, height: 20 }],
      formats: ['jpeg', 'webp'],
    });
    assert.equal(created.length, 2);
    assert.equal(media.previews?.length, 2);
  });
});

// ---------------------------------------------------------------------------
// A source no larger than a WxH box: a cleaned preview at its own size
// ---------------------------------------------------------------------------

describe('a source smaller than the box', () => {
  test('a 100×80 JPEG with EXIF and GPS at 300×300 gives 100×80 in every format, without EXIF', async () => {
    installApp();
    assert.ok((await sharp(exifJpeg).metadata()).exif, 'fixture has EXIF');
    const { storage, uploads } = makeStorage(exifJpeg);
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
    const { created, failed } = await r.generate({
      media: mediaDoc(),
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp', 'avif'],
    });
    assert.equal(failed, 0);
    assert.equal(created.length, 3);
    for (const preview of created) {
      assert.equal(preview.sizeKey, '300x300');
      assert.equal(preview.actualWidth, 100, preview.format);
      assert.equal(preview.actualHeight, 80, preview.format);
    }
    for (const upload of uploads) {
      const meta = await sharp(upload.body).metadata();
      assert.deepEqual([meta.width, meta.height], [100, 80], upload.key);
      assert.equal(meta.exif, undefined, `${upload.key} has no EXIF`);
    }
  });

  test('a pipeline with variantSteps keeps the full box its steps were written for', async () => {
    // A 200×50 watermark composited onto a 150×150 own-size image would fail every time.
    installApp();
    const mark = await sharp({
      create: { width: 200, height: 50, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const small = await sharp(texture(150, 150), {
      raw: { width: 150, height: 150, channels: 3 },
    })
      .jpeg()
      .withExif({ IFD0: { Artist: 'Someone' } })
      .toBuffer();
    const { storage, uploads } = makeStorage(small);
    const { db } = makeDatabase(null);
    let steps = 0;
    const r = new FrameworkResizer({
      storage,
      db,
      pipelines: {
        default: {
          variantSteps: [
            async (img) => {
              steps += 1;
              return img.composite([{ input: mark, gravity: 'southeast' }]);
            },
          ],
        },
      },
    });
    const { created, failed } = await r.generate({
      media: mediaDoc(),
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
    });
    assert.equal(failed, 0);
    assert.equal(steps, 2);
    for (const preview of created) {
      assert.deepEqual([preview.actualWidth, preview.actualHeight], [300, 300]);
    }
    for (const upload of uploads) {
      const meta = await sharp(upload.body).metadata();
      assert.deepEqual([meta.width, meta.height], [300, 300]);
      assert.equal(meta.exif, undefined);
      const corner = await sharp(upload.body)
        .extract({ left: 290, top: 290, width: 1, height: 1 })
        .raw()
        .toBuffer();
      assert.ok(
        corner[0] > 200 && corner[1] > 200 && corner[2] > 200,
        'overlay',
      );
    }
  });

  test('fitting is decided against the requested box, then the cap still applies', async () => {
    // 120×60 fits the requested 200×200 box; the cap of 100 then scales it to 100×50 instead of
    // cropping it to the capped 100×100.
    installApp({ limits: { resultDimension: 100 } });
    const source = await sharp({
      create: { width: 120, height: 60, channels: 3, background: '#808080' },
    })
      .png()
      .toBuffer();
    const { storage } = makeStorage(source);
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
    const { created } = await r.generate({
      media: mediaDoc(),
      sizes: [{ width: 200, height: 200 }],
      formats: ['jpeg'],
    });
    assert.deepEqual(
      [created[0].actualWidth, created[0].actualHeight],
      [100, 50],
    );
  });

  test('an image that is not scaled is not sharpened either', async () => {
    installApp({ encode: { formats: { png: {} } } });
    const { storage, uploads } = makeStorage(exifJpeg);
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
    await r.generate({
      media: mediaDoc(),
      sizes: [{ width: 300, height: 300 }],
      formats: ['png'],
    });
    // Lossless output of an unscaled, unsharpened image: the decoded source pixels.
    assert.equal(
      await psnr(uploads[0].body, exifJpeg),
      Number.POSITIVE_INFINITY,
    );
  });

  test('a source larger than the box in one direction is still cover-cropped', async () => {
    installApp();
    const wide = await sharp({
      create: { width: 1000, height: 200, channels: 3, background: '#808080' },
    })
      .png()
      .toBuffer();
    const { storage } = makeStorage(wide);
    const { db } = makeDatabase(null);
    const r = new FrameworkResizer({ storage, db });
    const { created } = await r.generate({
      media: mediaDoc(),
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.deepEqual(
      [created[0].actualWidth, created[0].actualHeight],
      [300, 300],
    );
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
      pipelines: { watermark: {} },
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
    const r = new FrameworkResizer({
      storage,
      db,
      pipelines: { watermark: {} },
    });
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
      pipelines: { watermark: {} },
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
      pipelines: { watermark: {} },
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
