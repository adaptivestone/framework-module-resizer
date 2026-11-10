import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import sharp from 'sharp';
import type {
  DecodeBox,
  Raster,
  RenderOptions,
  SourceDecoder,
  SourceInfo,
} from './contracts/decoder.ts';
import type { ResizeStorage, StorageUploadArgs } from './contracts/storage.ts';
import { createDecoderSet, DecoderSet } from './decoderSet.ts';
import { SvgDecoder } from './decoders/svg.ts';
import { LocalFsStorage } from './drivers/fs.ts';
import {
  ResizeError,
  ResizeMediaError,
  ResizeOriginalError,
  ResizeSecurityError,
  ResizeSetupError,
  ResizeStorageError,
} from './errors.ts';
import { FrameworkResizer } from './framework/resizer.ts';
import { resetResizerForTests } from './resizer.ts';
import {
  MemoryTaskQueue,
  memoryStorage,
  recordingMetrics,
  refKey,
} from './testHelpers/fakes.ts';
import {
  makeImageConfig,
  makeResizeConfig,
} from './testHelpers/resizeConfig.ts';
import { Uploader } from './uploader.ts';

const png = await sharp({
  create: {
    width: 32,
    height: 24,
    channels: 4,
    background: { r: 12, g: 34, b: 56, alpha: 0.5 },
  },
})
  .png()
  .toBuffer();

const png64x48 = await sharp({
  create: {
    width: 64,
    height: 48,
    channels: 3,
    background: { r: 200, g: 100, b: 50 },
  },
})
  .png()
  .toBuffer();

const orientedJpeg = await sharp({
  create: {
    width: 40,
    height: 20,
    channels: 3,
    background: { r: 1, g: 2, b: 3 },
  },
})
  .jpeg()
  .withMetadata({ orientation: 6 })
  .toBuffer();

const webp = await sharp(png).webp().toBuffer();
const avif = await sharp(png).avif().toBuffer();

// Distinct frames prevent the encoder from collapsing the animation into one frame.
const animation = sharp(
  Buffer.concat([Buffer.alloc(300, 0), Buffer.alloc(300, 255)]),
  { raw: { width: 10, height: 20, channels: 3, pageHeight: 10 } },
);
const animatedOriginals = {
  gif: await animation
    .clone()
    .gif({ delay: [100, 100] })
    .toBuffer(),
  webp: await animation
    .clone()
    .webp({ delay: [100, 100] })
    .toBuffer(),
};

/** Noise, so a cut lands in image data and not in one long run of the same bytes. */
const noisy = () =>
  sharp({
    create: {
      width: 400,
      height: 300,
      channels: 3,
      background: '#808080',
      noise: { type: 'gaussian', mean: 128, sigma: 60 },
    },
  });

const cut = (body: Buffer) => body.subarray(0, Math.floor(body.length / 2));

function installApp(config: Record<string, unknown> = {}) {
  setAppInstance({
    getConfig: () => makeResizeConfig(config),
    getModel: () => ({}),
    logger: { info() {}, warn() {}, error() {} },
  } as never);
}

function recordingStorage() {
  const uploads: Array<{
    key: string;
    body: Buffer;
    contentType: string;
    visibility: 'public' | 'private';
  }> = [];
  const storage: ResizeStorage = {
    download: async () => Buffer.alloc(0),
    upload: async (args) => {
      uploads.push({ ...args, body: Buffer.from(args.body) });
      return { key: args.key, bucket: 'originals' };
    },
    publicUrl: (ref) => `/media/${refKey(ref)}`,
  };
  return { storage, uploads };
}

afterEach(() => {
  resetResizerForTests();
  resetAppInstance();
});

test('an Uploader stores an original with only storage, decoders and config', async () => {
  const uploads: StorageUploadArgs[] = [];
  const storage: ResizeStorage = {
    download: async () => Buffer.alloc(0),
    upload: async (args) => {
      uploads.push(args);
      return { key: args.key };
    },
    publicUrl: () => '',
  };
  const original = await new Uploader({
    storage,
    decoders: createDecoderSet(),
    config: makeImageConfig(),
  }).upload({ body: png64x48, visibility: 'private' });
  assert.match(uploads[0].key, /^originals\/[0-9a-f]{32}\.png$/);
  assert.deepEqual(
    {
      format: original.format,
      contentType: original.contentType,
      width: original.width,
      height: original.height,
    },
    { format: 'png', contentType: 'image/png', width: 64, height: 48 },
  );
});

/** A plain-object decoder listing `formats` whose inspect resolves with `info` or rejects with `error`. */
function fakeDecoder(
  formats: string[],
  behaviour: { info: SourceInfo } | { error: unknown },
): SourceDecoder {
  return {
    formats,
    async inspect(): Promise<SourceInfo> {
      if ('error' in behaviour) {
        throw behaviour.error;
      }
      return behaviour.info;
    },
    async render(): Promise<Raster> {
      throw new Error('render is not part of these tests');
    },
  };
}

const pdfInfo: SourceInfo = {
  format: 'pdf',
  contentType: 'application/pdf',
  width: 120.4,
  height: 80.6,
};

/** A plain-object decoder of `info.format` that always reads the bytes and renders with `render`. */
function renderingDecoder(
  info: SourceInfo,
  render: SourceDecoder['render'],
): SourceDecoder {
  return { formats: [info.format], inspect: async () => info, render };
}

/** Thrown values that cannot be read: each throws when printed or asked for its message. */
function unreadableValues(): unknown[] {
  const no = () => {
    throw new Error('no');
  };
  return [
    { toString: no },
    Object.defineProperty(new Error('hidden'), 'message', { get: no }),
    new Proxy(
      {},
      {
        get: no,
        has: no,
        getPrototypeOf: no,
        ownKeys: no,
        getOwnPropertyDescriptor: no,
      },
    ),
  ];
}

/** An Uploader over `decoders` with recording storage; `upload.formats` adds 'pdf'. */
function uploaderWith(decoders: DecoderSet) {
  const { storage, uploads } = recordingStorage();
  const uploader = new Uploader({
    storage,
    decoders,
    config: makeImageConfig({ upload: { formats: ['png', 'pdf'] } }),
  });
  return { uploader, uploads };
}

const somePdf = Buffer.from('%PDF-1.7 not really');

describe('uploadOriginal — through the decoders', () => {
  test('the format, content type and extension come from the decoder that reads the bytes', async () => {
    const { uploader, uploads } = uploaderWith(
      new DecoderSet([fakeDecoder(['pdf'], { info: pdfInfo })]),
    );
    const original = await uploader.upload({
      body: somePdf,
      visibility: 'private',
    });
    assert.match(uploads[0].key, /^originals\/[0-9a-f]{32}\.pdf$/);
    assert.equal(uploads[0].contentType, 'application/pdf');
    assert.deepEqual(
      {
        format: original.format,
        contentType: original.contentType,
        width: original.width,
        height: original.height,
      },
      {
        format: 'pdf',
        contentType: 'application/pdf',
        width: 120,
        height: 81,
      },
    );
  });

  test('a format a decoder identifies but upload.formats lacks is RESIZE_ORIGINAL_FORMAT_DISABLED', async () => {
    const { storage, uploads } = recordingStorage();
    const uploader = new Uploader({
      storage,
      decoders: new DecoderSet([fakeDecoder(['pdf'], { info: pdfInfo })]),
      config: makeImageConfig({ upload: { formats: ['png'] } }),
    });
    await assert.rejects(
      uploader.upload({ body: somePdf, visibility: 'private' }),
      (err: unknown) =>
        err instanceof ResizeOriginalError &&
        err.code === 'RESIZE_ORIGINAL_FORMAT_DISABLED',
    );
    assert.equal(uploads.length, 0);
  });

  test("a decoder's own ResizeError reaches the caller as a ResizeOriginalError with its code and retryable", async () => {
    const cause = new ResizeMediaError('the test decoder refuses', {
      code: 'TEST_CODE',
      retryable: false,
    });
    const { uploader, uploads } = uploaderWith(
      new DecoderSet([fakeDecoder(['pdf'], { error: cause })]),
    );
    await assert.rejects(
      uploader.upload({ body: somePdf, visibility: 'private' }),
      (err: unknown) =>
        err instanceof ResizeOriginalError &&
        err.code === 'TEST_CODE' &&
        err.retryable === false &&
        err.message === 'the test decoder refuses' &&
        err.cause === cause,
    );
    assert.equal(uploads.length, 0);
  });

  test('a host decoder failure or a timeout is RESIZE_ORIGINAL_INSPECT_FAILED, retryable', async () => {
    for (const [cause, detail] of [
      [new Error('the engine crashed'), 'the engine crashed'],
      [new Error('timeout: 5% complete'), 'timeout: 5% complete'],
      [new Error('first line\nsecond line'), 'first line'],
      ['a plain string', 'a plain string'],
      // A healthy file this build cannot decode must stay retryable.
      [
        new Error(
          'Input buffer has corrupt header: heif: Error while loading plugin: Support for this compression format has not been built in',
        ),
        'heif: Error while loading plugin: Support for this compression format has not been built in',
      ],
    ] as const) {
      const { uploader, uploads } = uploaderWith(
        new DecoderSet([fakeDecoder(['pdf'], { error: cause })]),
      );
      await assert.rejects(
        uploader.upload({ body: somePdf, visibility: 'private' }),
        (err: ResizeOriginalError) => {
          assert.ok(err instanceof ResizeOriginalError);
          assert.equal(err.code, 'RESIZE_ORIGINAL_INSPECT_FAILED');
          assert.equal(err.retryable, true);
          assert.equal(err.cause, cause);
          assert.equal(
            err.message,
            `resize uploadOriginal: the decoder could not read the image: ${detail}`,
          );
          return true;
        },
      );
      assert.equal(uploads.length, 0);
    }
  });

  test("a host decoder's error that reads like Sharp's is not read as Sharp's verdict on the bytes", async () => {
    // The words of Sharp's refusal, thrown by a decoder that has nothing to do with Sharp.
    for (const message of [
      'Input buffer contains unsupported image format',
      'pdf: unsupported image format in page 3',
    ]) {
      const cause = new Error(message);
      const { uploader, uploads } = uploaderWith(
        new DecoderSet([fakeDecoder(['pdf'], { error: cause })]),
      );
      await assert.rejects(
        uploader.upload({ body: somePdf, visibility: 'private' }),
        (err: ResizeOriginalError) => {
          assert.equal(err.code, 'RESIZE_ORIGINAL_INSPECT_FAILED');
          assert.equal(err.retryable, true);
          assert.equal(err.cause, cause);
          return true;
        },
      );
      assert.equal(uploads.length, 0);
    }
  });

  test('bytes the built-in decoder recognises nothing in stay RESIZE_ORIGINAL_INVALID, behind a host decoder too', async () => {
    const { uploader, uploads } = uploaderWith(createDecoderSet([]));
    const refused = (err: ResizeOriginalError) => {
      assert.equal(err.code, 'RESIZE_ORIGINAL_INVALID');
      assert.equal(err.retryable, false);
      assert.equal(
        err.message,
        'resize uploadOriginal: bytes are not a supported image: Input buffer contains unsupported image format',
      );
      return true;
    };
    await assert.rejects(
      uploader.upload({
        body: Buffer.from('not an image'),
        visibility: 'private',
      }),
      refused,
    );
    const behind = uploaderWith(
      createDecoderSet([
        fakeDecoder(['pdf'], {
          error: new ResizeMediaError('not mine', {
            code: 'RESIZE_SOURCE_FORMAT_UNSUPPORTED',
            retryable: false,
          }),
        }),
      ]),
    );
    await assert.rejects(
      behind.uploader.upload({
        body: Buffer.from('not an image'),
        visibility: 'private',
      }),
      refused,
    );
    assert.equal(uploads.length, 0);
  });

  test('the engine line in an upload error is cut at 200 characters', async () => {
    const { uploader } = uploaderWith(
      new DecoderSet([
        fakeDecoder(['pdf'], { error: new Error('x'.repeat(5000)) }),
      ]),
    );
    await assert.rejects(
      uploader.upload({ body: somePdf, visibility: 'private' }),
      {
        message: `resize uploadOriginal: the decoder could not read the image: ${'x'.repeat(200)}`,
      },
    );
  });

  test('a thrown value that cannot be read does not break the upload error', async () => {
    for (const cause of unreadableValues()) {
      const { uploader, uploads } = uploaderWith(
        new DecoderSet([fakeDecoder(['pdf'], { error: cause })]),
      );
      await assert.rejects(
        uploader.upload({ body: somePdf, visibility: 'private' }),
        (err: ResizeOriginalError) => {
          assert.ok(err instanceof ResizeOriginalError);
          assert.equal(err.code, 'RESIZE_ORIGINAL_INSPECT_FAILED');
          assert.equal(err.retryable, true);
          assert.ok(err.cause === cause, 'the cause is that very value');
          assert.equal(
            err.message,
            'resize uploadOriginal: the decoder could not read the image: a thrown value that cannot be printed',
          );
          return true;
        },
      );
      assert.equal(uploads.length, 0);
    }
  });

  test('a setup error from a decoder reaches the caller unchanged', async () => {
    const setup = new ResizeSetupError('the test decoder is not wired', {
      code: 'TEST_SETUP',
    });
    const { uploader, uploads } = uploaderWith(
      new DecoderSet([fakeDecoder(['pdf'], { error: setup })]),
    );
    await assert.rejects(
      uploader.upload({ body: somePdf, visibility: 'private' }),
      (err: unknown) =>
        err === setup &&
        (err as Error).name === 'ResizeSetupError' &&
        !(err instanceof ResizeOriginalError),
    );
    const broken = uploaderWith(
      new DecoderSet([
        fakeDecoder(['pdf'], {
          info: { ...pdfInfo, format: 'not-listed' },
        }),
      ]),
    );
    await assert.rejects(
      broken.uploader.upload({ body: somePdf, visibility: 'private' }),
      (err: unknown) =>
        (err as Error).name === 'ResizeSetupError' &&
        (err as ResizeSetupError).code === 'RESIZE_DECODER_INVALID' &&
        !(err instanceof ResizeOriginalError),
    );
    assert.equal(uploads.length + broken.uploads.length, 0);
  });

  test("a host's subclass of ResizeSetupError from a decoder reaches the caller unchanged", async () => {
    class HostWiringError extends ResizeSetupError {}
    const setup = new HostWiringError('the host decoder has no licence key', {
      code: 'HOST_WIRING',
    });
    const { uploader, uploads } = uploaderWith(
      new DecoderSet([fakeDecoder(['pdf'], { error: setup })]),
    );
    await assert.rejects(
      uploader.upload({ body: somePdf, visibility: 'private' }),
      (err: unknown) =>
        err === setup &&
        (err as Error).name === 'HostWiringError' &&
        !(err instanceof ResizeOriginalError),
    );
    assert.equal(uploads.length, 0);
  });

  test('bytes every decoder refuses are RESIZE_ORIGINAL_FORMAT_UNSUPPORTED', async () => {
    const refusal = new ResizeMediaError('not a pdf', {
      code: 'RESIZE_SOURCE_FORMAT_UNSUPPORTED',
      retryable: false,
    });
    const { uploader, uploads } = uploaderWith(
      new DecoderSet([fakeDecoder(['pdf'], { error: refusal })]),
    );
    await assert.rejects(
      uploader.upload({ body: somePdf, visibility: 'private' }),
      (err: unknown) =>
        err instanceof ResizeOriginalError &&
        err.code === 'RESIZE_ORIGINAL_FORMAT_UNSUPPORTED' &&
        err.retryable === false &&
        ResizeOriginalError.isResizeError(err.cause) &&
        err.cause.code === 'RESIZE_SOURCE_FORMAT_UNSUPPORTED',
    );
    assert.equal(uploads.length, 0);
  });

  test("a decoder's RESIZE_SOURCE_METADATA_MISSING is RESIZE_ORIGINAL_METADATA_MISSING", async () => {
    const cause = new ResizeMediaError('no width/height', {
      code: 'RESIZE_SOURCE_METADATA_MISSING',
      retryable: false,
    });
    const { uploader, uploads } = uploaderWith(
      new DecoderSet([fakeDecoder(['pdf'], { error: cause })]),
    );
    await assert.rejects(
      uploader.upload({ body: somePdf, visibility: 'private' }),
      (err: unknown) =>
        err instanceof ResizeOriginalError &&
        err.code === 'RESIZE_ORIGINAL_METADATA_MISSING' &&
        err.retryable === false &&
        err.cause === cause,
    );
    assert.equal(uploads.length, 0);
  });

  test('an SVG over the pixel limit and the side limit reports RESIZE_ORIGINAL_TOO_MANY_PIXELS, as today', async () => {
    const { storage, uploads } = recordingStorage();
    const uploader = new Uploader({
      storage,
      decoders: createDecoderSet(),
      config: makeImageConfig({ limits: { sourcePixels: 1000 } }),
    });
    await assert.rejects(
      uploader.upload({
        body: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="100000"/>',
        ),
        visibility: 'private',
      }),
      (err: unknown) =>
        err instanceof ResizeOriginalError &&
        err.code === 'RESIZE_ORIGINAL_TOO_MANY_PIXELS' &&
        err.retryable === false &&
        ResizeOriginalError.isResizeError(err.cause) &&
        err.cause.code === 'RESIZE_SOURCE_TOO_LARGE',
    );
    assert.equal(uploads.length, 0);
  });
});

describe('uploadOriginal — raster bytes and metadata', () => {
  for (const [format, body] of Object.entries(animatedOriginals)) {
    test(`${format} animation reports frame dimensions and preserves bytes`, async () => {
      installApp();
      const { storage, uploads } = recordingStorage();
      const r = new FrameworkResizer({ storage });
      const original = await r.uploadOriginal({ body, visibility: 'public' });
      assert.equal(original.width, 10);
      assert.equal(original.height, 10);
      assert.deepEqual(uploads[0].body, body);
    });

    test(`${format} animation counts each frame once at the pixel limit`, async () => {
      installApp({ limits: { sourcePixels: 200 } });
      const { storage } = recordingStorage();
      const r = new FrameworkResizer({ storage });
      await r.uploadOriginal({ body, visibility: 'public' });
    });

    test(`${format} animation rejects total pixels above the limit before storage`, async () => {
      installApp({ limits: { sourcePixels: 199 } });
      const { storage, uploads } = recordingStorage();
      const r = new FrameworkResizer({ storage });
      await assert.rejects(r.uploadOriginal({ body, visibility: 'public' }), {
        code: 'RESIZE_ORIGINAL_TOO_MANY_PIXELS',
        message: /image 10x10x2f exceeds limits\.sourcePixels \(199\)/,
      });
      assert.equal(uploads.length, 0);
    });

    test(`${format} animation is measured one frame at a time against limits.inputPixels`, async () => {
      // One 10×10 frame (100 px) fits 150; the stack (200 px) is bounded at render, by the plan.
      installApp({ limits: { inputPixels: 150 } });
      const { storage, uploads } = recordingStorage();
      const r = new FrameworkResizer({ storage });
      const original = await r.uploadOriginal({ body, visibility: 'public' });
      assert.equal(original.width, 10);
      assert.equal(original.height, 10);
      assert.equal(uploads.length, 1);
    });
  }

  test('stores JPEG bytes unchanged and reports display dimensions without rotating EXIF', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const r = new FrameworkResizer({ storage });
    const original = await r.uploadOriginal({
      body: orientedJpeg,
      visibility: 'private',
    });

    assert.equal(original.format, 'jpeg');
    assert.equal(original.contentType, 'image/jpeg');
    assert.equal(original.size, orientedJpeg.byteLength);
    assert.equal(original.width, 20);
    assert.equal(original.height, 40);
    assert.equal(
      (original.storageRef as { bucket?: string }).bucket,
      'originals',
    );
    assert.match(
      (original.storageRef as { key: string }).key,
      /^originals\/[a-f0-9]{32}\.jpg$/,
    );
    assert.deepEqual(uploads[0].body, orientedJpeg);
    assert.equal(uploads[0].visibility, 'private');
  });

  test('accepts Uint8Array PNG and produces a different safe key for each upload', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const r = new FrameworkResizer({ storage });
    const first = await r.uploadOriginal({
      body: new Uint8Array(png),
      visibility: 'public',
    });
    const second = await r.uploadOriginal({ body: png, visibility: 'public' });

    assert.equal(first.format, 'png');
    assert.equal(first.contentType, 'image/png');
    assert.equal(first.width, 32);
    assert.equal(first.height, 24);
    assert.match(
      (first.storageRef as { key: string }).key,
      /^originals\/[a-f0-9]{32}\.png$/,
    );
    assert.notEqual(
      (first.storageRef as { key: string }).key,
      (second.storageRef as { key: string }).key,
    );
    assert.deepEqual(uploads[0].body, png);
  });

  test('accepts a TIFF enabled only through upload.formats', async () => {
    installApp({ upload: { formats: ['tiff'] } });
    const { storage, uploads } = recordingStorage();
    const r = new FrameworkResizer({ storage });
    const body = await sharp(png).tiff().toBuffer();

    const original = await r.uploadOriginal({ body, visibility: 'private' });

    assert.equal(original.format, 'tiff');
    assert.equal(original.contentType, 'image/tiff');
    assert.match(
      (original.storageRef as { key: string }).key,
      /^originals\/[a-f0-9]{32}\.tiff$/,
    );
    assert.deepEqual(uploads[0].body, body);
  });

  test('round-trips exact original bytes through LocalFsStorage', async () => {
    installApp();
    const dir = await mkdtemp(join(tmpdir(), 'resize-original-'));
    const r = new FrameworkResizer({
      storage: new LocalFsStorage({ rootDir: dir, publicBaseUrl: '/media' }),
    });
    const original = await r.uploadOriginal({
      body: png,
      visibility: 'private',
    });
    assert.deepEqual(original.storageRef, {
      path: (original.storageRef as { path: string }).path,
      visibility: 'private',
    });
    assert.deepEqual(
      await readFile(
        join(`${dir}-private`, (original.storageRef as { path: string }).path),
      ),
      png,
    );
  });

  test('recognizes WebP and AVIF containers without rewriting their bytes', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const r = new FrameworkResizer({ storage });
    const webpOriginal = await r.uploadOriginal({
      body: webp,
      visibility: 'public',
    });
    const avifOriginal = await r.uploadOriginal({
      body: avif,
      visibility: 'public',
    });
    assert.equal(webpOriginal.format, 'webp');
    assert.equal(webpOriginal.contentType, 'image/webp');
    assert.equal(avifOriginal.format, 'avif');
    assert.equal(avifOriginal.contentType, 'image/avif');
    assert.deepEqual(uploads[0].body, webp);
    assert.deepEqual(uploads[1].body, avif);
  });
});

describe('uploadOriginal — private SVG source', () => {
  test('reads SVG metadata and stores the exact source bytes without queue work', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const tasks = new MemoryTaskQueue();
    const r = new FrameworkResizer({
      storage,
      tasks,
    });
    const body = Buffer.from(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="120px" height="80px" viewBox="0 0 240 100"><path d="M0 0h1v1z"/></svg>',
    );
    const original = await r.uploadOriginal({ body, visibility: 'private' });

    assert.equal(original.format, 'svg');
    assert.equal(original.contentType, 'image/svg+xml');
    assert.equal(original.width, 120);
    assert.equal(original.height, 80);
    assert.equal(original.size, body.byteLength);
    assert.match(
      (original.storageRef as { key: string }).key,
      /^originals\/[a-f0-9]{32}\.svg$/,
    );
    assert.deepEqual(uploads[0].body, body);
    assert.equal(tasks.added.length, 0);
  });

  test('a public JPEG through the built-in decoder is stored as before', async () => {
    const { storage, uploads } = recordingStorage();
    const original = await new Uploader({
      storage,
      decoders: createDecoderSet(),
      config: makeImageConfig(),
    }).upload({ body: orientedJpeg, visibility: 'public' });
    assert.equal(original.format, 'jpeg');
    assert.equal(uploads[0].visibility, 'public');
    assert.deepEqual(uploads[0].body, orientedJpeg);
  });

  test('rejects a public SVG original before writing to storage', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const r = new FrameworkResizer({ storage });
    const body = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"/>',
    );
    await assert.rejects(
      () => r.uploadOriginal({ body, visibility: 'public' }),
      /SVG originals must be stored privately/,
    );
    assert.equal(uploads.length, 0);
  });

  test('uses Sharp dimensions for SVG with a viewBox', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const r = new FrameworkResizer({ storage });
    const body = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 100"/>',
    );
    const original = await r.uploadOriginal({ body, visibility: 'private' });
    assert.equal(original.format, 'svg');
    assert.equal(original.width, 240);
    assert.equal(original.height, 100);
    assert.deepEqual(uploads[0].body, body);
  });

  for (const [width, height] of [
    [1, 100000],
    [100000, 1],
    [0.6, 40000],
    [1, 65535],
    [1, 2400000],
  ]) {
    test(`rejects an unrasterizable ${width}×${height} SVG before storage`, async () => {
      installApp();
      const { storage, uploads } = recordingStorage();
      const r = new FrameworkResizer({ storage });
      await assert.rejects(
        r.uploadOriginal({
          body: Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`,
          ),
          visibility: 'private',
        }),
        (err: unknown) =>
          err instanceof ResizeOriginalError &&
          err.code === 'RESIZE_SVG_DIMENSIONS_UNSUPPORTED' &&
          err.retryable === false,
      );
      assert.equal(uploads.length, 0);
    });
  }

  for (const [width, height] of [
    [1, 40000],
    [40000, 1],
    [0.7, 40000],
    [1, 65534],
  ]) {
    test(`accepts a supported ${width}×${height} SVG and preserves its bytes`, async () => {
      installApp();
      const { storage, uploads } = recordingStorage();
      const r = new FrameworkResizer({ storage });
      const body = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`,
      );
      const original = await r.uploadOriginal({ body, visibility: 'private' });
      assert.equal(original.format, 'svg');
      assert.deepEqual(uploads[0].body, body);
    });
  }

  test('rejects unreadable SVG and non-image XML before storage', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const r = new FrameworkResizer({ storage });
    for (const svg of [
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><g></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      '<?xml version="1.0"?><html/>',
    ]) {
      await assert.rejects(
        r.uploadOriginal({ body: Buffer.from(svg), visibility: 'private' }),
        { code: 'RESIZE_ORIGINAL_INVALID' },
      );
    }
    assert.equal(uploads.length, 0);
  });

  test('a damaged upload keeps RESIZE_ORIGINAL_INVALID, with the damage as its cause', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const r = new FrameworkResizer({ storage });
    await assert.rejects(
      r.uploadOriginal({
        body: cut(await noisy().gif().toBuffer()),
        visibility: 'private',
      }),
      (err: ResizeOriginalError) => {
        assert.ok(err instanceof ResizeOriginalError);
        assert.equal(err.code, 'RESIZE_ORIGINAL_INVALID');
        assert.equal(
          (err.cause as { code?: string }).code,
          'RESIZE_SOURCE_DAMAGED',
        );
        return true;
      },
    );
    assert.equal(uploads.length, 0);
  });

  test('a cut GIF names its detail', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const r = new FrameworkResizer({ storage });
    await assert.rejects(
      r.uploadOriginal({
        body: cut(await noisy().gif().toBuffer()),
        visibility: 'private',
      }),
      (err: ResizeOriginalError) => {
        assert.equal(err.code, 'RESIZE_ORIGINAL_INVALID');
        assert.equal(err.retryable, false);
        assert.match(
          err.message,
          /^resize uploadOriginal: bytes are not a supported image: gifload_buffer:/,
        );
        return true;
      },
    );
    assert.equal(uploads.length, 0);
  });

  test('an upload the engine fails with no detail is RESIZE_ORIGINAL_INSPECT_FAILED, retryable', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const r = new FrameworkResizer({ storage });
    await assert.rejects(
      r.uploadOriginal({
        body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        visibility: 'private',
      }),
      (err: ResizeOriginalError) => {
        assert.ok(err instanceof ResizeOriginalError);
        assert.equal(err.code, 'RESIZE_ORIGINAL_INSPECT_FAILED');
        assert.equal(err.retryable, true);
        assert.equal(
          err.message,
          'resize uploadOriginal: the decoder could not read the image: the engine gave no detail',
        );
        assert.match((err.cause as Error).message, /the engine gave no detail/);
        return true;
      },
    );
    assert.equal(uploads.length, 0);
  });

  test('malformed SVG says it could not be parsed', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const r = new FrameworkResizer({ storage });
    await assert.rejects(
      r.uploadOriginal({
        body: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><g></svg>',
        ),
        visibility: 'private',
      }),
      (err: ResizeOriginalError) => {
        assert.ok(err instanceof ResizeOriginalError);
        assert.equal(err.code, 'RESIZE_ORIGINAL_INVALID');
        assert.equal(err.retryable, false);
        assert.match(
          err.message,
          /^resize uploadOriginal: the SVG could not be parsed: Error domain 1 code \d+/,
        );
        return true;
      },
    );
    assert.equal(uploads.length, 0);
  });

  test('an undefined entity and a billion-laughs SVG are refused before storage, with the parser text', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const r = new FrameworkResizer({ storage });
    const entities = Array.from(
      { length: 8 },
      (_, level) => `<!ENTITY lol${level + 1} "${`&lol${level};`.repeat(10)}">`,
    ).join('');
    for (const [svg, text] of [
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>&nope;</text></svg>',
        /Entity 'nope' not defined/,
      ],
      [
        `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY lol0 "lol">${entities}]><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>&lol8;</text></svg>`,
        /Maximum entity amplification factor exceeded/,
      ],
    ] as const) {
      await assert.rejects(
        r.uploadOriginal({ body: Buffer.from(svg), visibility: 'private' }),
        (err: ResizeOriginalError) => {
          assert.equal(err.code, 'RESIZE_ORIGINAL_INVALID');
          assert.equal(err.retryable, false);
          assert.match(
            err.message,
            /^resize uploadOriginal: the SVG could not be parsed: /,
          );
          assert.match(err.message, text);
          return true;
        },
      );
    }
    assert.equal(uploads.length, 0);
  });

  test('an unsized SVG is RESIZE_ORIGINAL_INVALID, not retryable, before storage', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const r = new FrameworkResizer({ storage });
    await assert.rejects(
      r.uploadOriginal({
        body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        visibility: 'private',
      }),
      (err: ResizeOriginalError) => {
        assert.equal(err.code, 'RESIZE_ORIGINAL_INVALID');
        assert.equal(err.retryable, false);
        assert.match(err.message, /svgload_buffer: bad dimensions/);
        return true;
      },
    );
    assert.equal(uploads.length, 0);
  });

  test("Sharp's pixel limit at upload is RESIZE_ORIGINAL_TOO_MANY_PIXELS", async () => {
    installApp({ limits: { inputPixels: 100 } });
    const { storage, uploads } = recordingStorage();
    const r = new FrameworkResizer({ storage });
    await assert.rejects(
      r.uploadOriginal({ body: orientedJpeg, visibility: 'private' }),
      {
        code: 'RESIZE_ORIGINAL_TOO_MANY_PIXELS',
        message: /pixel limit limits\.inputPixels \(100\)/,
      },
    );
    assert.equal(uploads.length, 0);
  });

  test('the pixel limit is RESIZE_ORIGINAL_TOO_MANY_PIXELS, not retryable', async () => {
    // The engine's limit on one frame, then the module's own limit on the whole source.
    for (const limits of [{ inputPixels: 100 }, { sourcePixels: 100 }]) {
      const { storage, uploads } = recordingStorage();
      const uploader = new Uploader({
        storage,
        decoders: createDecoderSet(),
        config: makeImageConfig({ limits }),
      });
      await assert.rejects(
        uploader.upload({ body: orientedJpeg, visibility: 'private' }),
        { code: 'RESIZE_ORIGINAL_TOO_MANY_PIXELS', retryable: false },
      );
      assert.equal(uploads.length, 0);
    }
  });

  test('applies the source pixel limit to SVG metadata before storage', async () => {
    installApp({ limits: { sourcePixels: 99 } });
    const { storage, uploads } = recordingStorage();
    const r = new FrameworkResizer({ storage });
    await assert.rejects(
      r.uploadOriginal({
        body: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
        ),
        visibility: 'private',
      }),
      { code: 'RESIZE_ORIGINAL_TOO_MANY_PIXELS' },
    );
    assert.equal(uploads.length, 0);
  });

  test('honors the SVG upload format allowlist before storage', async () => {
    installApp({ upload: { formats: ['png'] } });
    const { storage, uploads } = recordingStorage();
    const r = new FrameworkResizer({ storage });
    await assert.rejects(
      r.uploadOriginal({
        body: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
        ),
        visibility: 'private',
      }),
      { code: 'RESIZE_ORIGINAL_FORMAT_DISABLED' },
    );
    assert.equal(uploads.length, 0);
  });

  test('preserves a declared ISO-8859-1 SVG byte-for-byte', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const r = new FrameworkResizer({ storage });
    const body = Buffer.from(
      '<?xml version="1.0" encoding="ISO-8859-1"?><svg xmlns="http://www.w3.org/2000/svg" width="9" height="7"><text>é</text></svg>',
      'latin1',
    );
    const original = await r.uploadOriginal({ body, visibility: 'private' });
    assert.equal(original.format, 'svg');
    assert.equal(original.width, 9);
    assert.equal(original.height, 7);
    assert.deepEqual(uploads[0].body, body);
  });
});

describe('uploadOriginal — typed failures', () => {
  test('a body over limits.sourceBytes is refused at upload, naming that limit', async () => {
    const { storage, uploads } = recordingStorage();
    const uploader = new Uploader({
      storage,
      decoders: createDecoderSet(),
      config: makeImageConfig({
        upload: { maxBytes: 1024 * 1024 },
        limits: { sourceBytes: 10 },
      }),
    });
    await assert.rejects(
      uploader.upload({ body: png, visibility: 'private' }),
      (err: unknown) => {
        assert.ok(err instanceof ResizeOriginalError);
        assert.equal(err.code, 'RESIZE_ORIGINAL_TOO_LARGE');
        assert.equal(err.retryable, false);
        assert.match(err.message, /limits\.sourceBytes \(10\)/);
        return true;
      },
    );
    assert.equal(uploads.length, 0);
  });

  test('rejects empty, over-limit, and disabled formats before storage', async () => {
    installApp({ upload: { maxBytes: 8, formats: ['jpeg'] } });
    const { storage, uploads } = recordingStorage();
    const r = new FrameworkResizer({ storage });
    await assert.rejects(
      () => r.uploadOriginal({ body: Buffer.alloc(0), visibility: 'private' }),
      (error: unknown) =>
        error instanceof ResizeOriginalError &&
        error.code === 'RESIZE_ORIGINAL_EMPTY',
    );
    await assert.rejects(
      () => r.uploadOriginal({ body: png, visibility: 'private' }),
      (error: unknown) =>
        error instanceof ResizeOriginalError &&
        error.code === 'RESIZE_ORIGINAL_TOO_LARGE',
    );
    // A Resizer reads its config once, at construction: a new config needs a new Resizer.
    resetAppInstance();
    resetResizerForTests();
    installApp({ upload: { maxBytes: 1024 * 1024, formats: ['jpeg'] } });
    const larger = new FrameworkResizer({ storage });
    await assert.rejects(
      () => larger.uploadOriginal({ body: png, visibility: 'private' }),
      (error: unknown) =>
        error instanceof ResizeOriginalError &&
        error.code === 'RESIZE_ORIGINAL_FORMAT_DISABLED',
    );
    assert.equal(uploads.length, 0);
  });

  test('wraps storage failure as ResizeStorageError with its cause', async () => {
    installApp();
    const cause = new Error('disk full');
    const storage: ResizeStorage = {
      download: async () => Buffer.alloc(0),
      upload: async () => {
        throw cause;
      },
      publicUrl: () => '',
    };
    const r = new FrameworkResizer({ storage });
    await assert.rejects(
      () => r.uploadOriginal({ body: png, visibility: 'private' }),
      (error: unknown) =>
        error instanceof ResizeStorageError &&
        error.code === 'RESIZE_ORIGINAL_UPLOAD_FAILED' &&
        error.retryable === true &&
        error.cause === cause,
    );
  });

  test("a driver's final refusal makes RESIZE_ORIGINAL_UPLOAD_FAILED not retryable, with the refusal as its cause", async () => {
    installApp();
    const dir = await mkdtemp(join(tmpdir(), 'resize-original-'));
    try {
      const r = new FrameworkResizer({
        storage: new LocalFsStorage({ rootDir: dir, publicBaseUrl: '/media' }),
      });
      await assert.rejects(
        () =>
          r.uploadOriginal({
            body: png,
            visibility: 'private',
            namespace: '../bad',
          }),
        (error: unknown) =>
          error instanceof ResizeStorageError &&
          error.code === 'RESIZE_ORIGINAL_UPLOAD_FAILED' &&
          error.retryable === false &&
          error.cause instanceof ResizeSecurityError &&
          error.cause.code === 'RESIZE_STORAGE_NAMESPACE_INVALID',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(`${dir}-private`, { recursive: true, force: true });
    }
  });

  test('an upload failure keeps retryable: true unless its cause is a ResizeError that says false, told by the brand', async () => {
    installApp();
    const failingWith = (cause: unknown): ResizeStorage => ({
      download: async () => Buffer.alloc(0),
      upload: async () => {
        throw cause;
      },
      publicUrl: () => '',
    });
    // From a second copy of the package: the brand, not the class, says it is one.
    const copied = Object.assign(new Error('refused'), {
      [Symbol.for('@adaptivestone/framework-module-resize.error')]: true,
      code: 'RESIZE_STORAGE_NAMESPACE_INVALID',
      retryable: false,
    });
    // Another library's error with a retryable field of its own (an AWS SDK v2 4xx carries one).
    const foreign = Object.assign(new Error('4xx'), { retryable: false });
    const transient = new ResizeStorageError('slow down');
    // A cause whose fields cannot be read gives no verdict.
    const hostile = new Proxy(
      {},
      {
        has() {
          throw new Error('trap');
        },
        get() {
          throw new Error('trap');
        },
      },
    );
    const cases = [
      [copied, false],
      [foreign, true],
      [transient, true],
      [hostile, true],
    ] as const;
    for (const [index, [cause, retryable]] of cases.entries()) {
      const r = new FrameworkResizer({
        storage: failingWith(cause),
        name: `upload-cause-${index}`,
      });
      await assert.rejects(
        () => r.uploadOriginal({ body: png, visibility: 'private' }),
        (error: unknown) =>
          error instanceof ResizeStorageError &&
          error.code === 'RESIZE_ORIGINAL_UPLOAD_FAILED' &&
          error.retryable === retryable &&
          error.cause === cause,
      );
    }
  });

  test('rejects unsupported bytes with a stable input error', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const r = new FrameworkResizer({ storage });
    await assert.rejects(
      () =>
        r.uploadOriginal({
          body: Buffer.from('this is not an image'),
          visibility: 'private',
        }),
      (error: unknown) =>
        error instanceof ResizeOriginalError &&
        error.code === 'RESIZE_ORIGINAL_INVALID',
    );
    assert.equal(uploads.length, 0);
  });

  test('text bytes are RESIZE_ORIGINAL_INVALID, not retryable, with the engine line', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const r = new FrameworkResizer({ storage });
    await assert.rejects(
      r.uploadOriginal({
        body: Buffer.from('<html><body>not an image</body></html>'),
        visibility: 'private',
      }),
      (err: ResizeOriginalError) => {
        assert.ok(err instanceof ResizeOriginalError);
        assert.equal(err.code, 'RESIZE_ORIGINAL_INVALID');
        assert.equal(err.retryable, false);
        assert.equal(
          err.message,
          'resize uploadOriginal: bytes are not a supported image: Input buffer contains unsupported image format',
        );
        return true;
      },
    );
    assert.equal(uploads.length, 0);
  });

  test('every refusal of the upload policy is not retryable', async () => {
    const { storage } = recordingStorage();
    const uploader = new Uploader({
      storage,
      decoders: createDecoderSet(),
      config: makeImageConfig({ upload: { maxBytes: 8, formats: ['jpeg'] } }),
    });
    for (const [opts, code] of [
      [{ body: 'x', visibility: 'private' }, 'RESIZE_ORIGINAL_BODY_INVALID'],
      [
        { body: Buffer.from('x'), visibility: 'x' },
        'RESIZE_ORIGINAL_VISIBILITY_INVALID',
      ],
      [
        { body: Buffer.alloc(0), visibility: 'private' },
        'RESIZE_ORIGINAL_EMPTY',
      ],
      [{ body: png, visibility: 'private' }, 'RESIZE_ORIGINAL_TOO_LARGE'],
    ] as const) {
      await assert.rejects(uploader.upload(opts as never), {
        code,
        retryable: false,
      });
    }
    const disabled = new Uploader({
      storage,
      decoders: createDecoderSet(),
      config: makeImageConfig({ upload: { formats: ['jpeg'] } }),
    });
    await assert.rejects(
      disabled.upload({ body: png, visibility: 'private' }),
      { code: 'RESIZE_ORIGINAL_FORMAT_DISABLED', retryable: false },
    );
    await assert.rejects(
      new Uploader({
        storage,
        decoders: createDecoderSet(),
        config: makeImageConfig(),
      }).upload({
        body: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"/>',
        ),
        visibility: 'public',
      }),
      { code: 'RESIZE_ORIGINAL_SVG_PUBLIC', retryable: false },
    );
  });

  test('rejects an invalid custom-storage locator with a typed error', async () => {
    installApp();
    const storage: ResizeStorage = {
      download: async () => Buffer.alloc(0),
      upload: async () => undefined as never,
      publicUrl: () => '',
    };
    const r = new FrameworkResizer({ storage });
    await assert.rejects(
      () => r.uploadOriginal({ body: png, visibility: 'private' }),
      (error: unknown) =>
        error instanceof ResizeStorageError &&
        error.code === 'RESIZE_ORIGINAL_STORAGE_REF_INVALID',
    );
  });

  test('accepts an opaque locator returned by a content-addressed storage driver', async () => {
    installApp();
    let suggestedKey = '';
    const storage: ResizeStorage = {
      download: async () => Buffer.alloc(0),
      upload: async ({ key }) => {
        suggestedKey = key;
        return { key: 'sha256/opaque-content-id', bucket: 'objects' };
      },
      publicUrl: () => '',
    };
    const r = new FrameworkResizer({ storage });
    const body = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"/>',
    );

    const original = await r.uploadOriginal({
      body,
      visibility: 'private',
    });

    assert.match(suggestedKey, /^originals\/[a-f0-9]{32}\.svg$/);
    assert.equal(
      (original.storageRef as { key: string }).key,
      'sha256/opaque-content-id',
    );
    assert.equal(
      (original.storageRef as { bucket?: string }).bucket,
      'objects',
    );
    assert.equal(original.format, 'svg');
  });

  test('preserves a valid falsy scalar locator', async () => {
    installApp();
    const storage: ResizeStorage = {
      download: async () => png,
      upload: async () => 0,
      publicUrl: () => '/zero',
    };
    const original = await new FrameworkResizer({ storage }).uploadOriginal({
      body: png,
      visibility: 'private',
    });
    assert.equal(original.storageRef, 0);
  });
});

describe('upload.verify', () => {
  /** An Uploader over `decoders` with `upload.verify: 'decode'` and recording storage. */
  function verifying(decoders: DecoderSet = createDecoderSet()) {
    const { storage, uploads } = recordingStorage();
    const metrics = recordingMetrics();
    const uploader = new Uploader({
      storage,
      decoders,
      metrics,
      config: makeImageConfig({
        upload: {
          verify: 'decode',
          formats: ['jpeg', 'png', 'webp', 'avif', 'gif', 'svg', 'pdf'],
        },
      }),
    });
    return { uploader, uploads, metrics };
  }

  /** A decoder of `pdf` whose render rejects with `error`. */
  const refusingRender = (error: unknown) =>
    new DecoderSet([
      renderingDecoder(pdfInfo, async () => {
        throw error;
      }),
    ]);

  const anyRaster: Raster = {
    data: Buffer.alloc(3),
    info: { width: 1, height: 1, channels: 3 },
  };

  test("upload.verify 'none' stores a cut JPEG, as before", async () => {
    assert.equal(makeImageConfig().upload.verify, 'none');
    const { storage, uploads } = recordingStorage();
    const body = cut(await noisy().jpeg().toBuffer());
    const original = await new Uploader({
      storage,
      decoders: createDecoderSet(),
      config: makeImageConfig(),
    }).upload({ body, visibility: 'private' });
    assert.equal(original.format, 'jpeg');
    assert.deepEqual(uploads[0].body, body);
  });

  test("upload.verify 'decode' refuses a cut JPEG before storage", async () => {
    const { uploader, uploads } = verifying();
    await assert.rejects(
      uploader.upload({
        body: cut(await noisy().jpeg().toBuffer()),
        visibility: 'private',
      }),
      (err: ResizeOriginalError) => {
        assert.ok(err instanceof ResizeOriginalError);
        assert.equal(err.code, 'RESIZE_ORIGINAL_DAMAGED');
        assert.equal(err.retryable, false);
        assert.equal(
          err.message,
          'resize uploadOriginal: the image is damaged: VipsJpeg: premature end of JPEG image',
        );
        assert.equal(
          (err.cause as { code?: string }).code,
          'RESIZE_SOURCE_DAMAGED',
        );
        return true;
      },
    );
    assert.equal(uploads.length, 0);
  });

  test("upload.verify 'decode' refuses a cut PNG before storage", async () => {
    const { uploader, uploads } = verifying();
    await assert.rejects(
      uploader.upload({
        body: cut(await noisy().png().toBuffer()),
        visibility: 'private',
      }),
      {
        code: 'RESIZE_ORIGINAL_DAMAGED',
        retryable: false,
        message:
          'resize uploadOriginal: the image is damaged: vipspng: libpng read error',
      },
    );
    assert.equal(uploads.length, 0);
  });

  test("upload.verify 'decode' checks at limits.failOn", async () => {
    const { storage, uploads } = recordingStorage();
    const body = cut(await noisy().jpeg().toBuffer());
    await new Uploader({
      storage,
      decoders: createDecoderSet(),
      config: makeImageConfig({
        upload: { verify: 'decode' },
        limits: { failOn: 'none' },
      }),
    }).upload({ body, visibility: 'private' });
    assert.equal(uploads.length, 1);
  });

  test("upload.verify 'decode' stores a clean image once, with its bytes unchanged", async () => {
    for (const body of [
      orientedJpeg,
      png64x48,
      webp,
      avif,
      animatedOriginals.gif,
      animatedOriginals.webp,
    ]) {
      const { uploader, uploads } = verifying();
      await uploader.upload({ body, visibility: 'private' });
      assert.equal(uploads.length, 1);
      assert.deepEqual(uploads[0].body, body);
    }
  });

  test("upload.verify 'decode' never renders an SVG", async () => {
    // No `vector` flag: the format's name alone skips the render.
    const svgInfo: SourceInfo = {
      format: 'svg',
      contentType: 'image/svg+xml',
      width: 10,
      height: 10,
    };
    const { uploader, uploads } = verifying(
      new DecoderSet([
        renderingDecoder(svgInfo, async () => {
          throw new Error('an SVG must not render at upload');
        }),
      ]),
    );
    const original = await uploader.upload({
      body: Buffer.from('<svg/>'),
      visibility: 'private',
    });
    assert.equal(original.format, 'svg');
    assert.equal(uploads.length, 1);
  });

  test("upload.verify 'decode' never renders a host decoder's vector source", async () => {
    let renders = 0;
    const { uploader, uploads } = verifying(
      new DecoderSet([
        renderingDecoder({ ...pdfInfo, vector: true }, async () => {
          renders += 1;
          throw new Error('a vector source must not render at upload');
        }),
      ]),
    );
    const original = await uploader.upload({
      body: somePdf,
      visibility: 'private',
    });
    assert.equal(original.format, 'pdf');
    assert.equal(renders, 0);
    assert.equal(uploads.length, 1);
  });

  test("upload.verify 'decode' reads the first frame only", async () => {
    const frames = 6;
    const side = 60;
    // Random pixels, so each frame takes about a sixth of the file.
    const gif = await sharp(randomBytes(side * side * frames * 3), {
      raw: {
        width: side,
        height: side * frames,
        channels: 3,
        pageHeight: side,
      },
    })
      .gif({ delay: Array(frames).fill(100) })
      .toBuffer();
    const { uploader, uploads } = verifying();
    await uploader.upload({ body: cut(gif), visibility: 'private' });
    assert.equal(uploads.length, 1);
    // A cut inside the first frame, which `inspect` already finds.
    await assert.rejects(
      uploader.upload({
        body: gif.subarray(0, Math.floor(gif.length / 20)),
        visibility: 'private',
      }),
      {
        code: 'RESIZE_ORIGINAL_INVALID',
        retryable: false,
        message:
          /^resize uploadOriginal: bytes are not a supported image: gifload_buffer:/,
      },
    );
    assert.equal(uploads.length, 1);
  });

  test("upload.verify 'decode' renders once at 16 px with one frame", async () => {
    const renders: Array<{
      bytes: Buffer;
      box: DecodeBox;
      opts: RenderOptions;
    }> = [];
    const config = makeImageConfig({
      upload: { verify: 'decode', formats: ['pdf'] },
    });
    const { storage, uploads } = recordingStorage();
    await new Uploader({
      storage,
      config,
      decoders: new DecoderSet([
        renderingDecoder(pdfInfo, async (bytes, box, opts) => {
          renders.push({ bytes, box, opts });
          return anyRaster;
        }),
      ]),
    }).upload({ body: somePdf, visibility: 'private' });
    assert.equal(renders.length, 1);
    assert.deepEqual(renders[0].bytes, somePdf);
    assert.deepEqual(renders[0].box, { width: 16, height: 16 });
    assert.equal(renders[0].opts.frames, 1);
    assert.equal(renders[0].opts.limits, config.limits);
    assert.deepEqual(renders[0].opts.source, pdfInfo);
    assert.equal(uploads.length, 1);
  });

  test('a verify failure that is not damage is RESIZE_ORIGINAL_VERIFY_FAILED, retryable, with its cause', async () => {
    for (const [cause, detail] of [
      [new Error('timeout: 5% complete'), 'timeout: 5% complete'],
      [
        new Error(
          'heif: Error while loading plugin: Support for this compression format has not been built in\nmore',
        ),
        'heif: Error while loading plugin: Support for this compression format has not been built in',
      ],
      [
        new ResizeMediaError('the test decoder is busy', {
          code: 'TEST_CODE',
          retryable: true,
        }),
        'the test decoder is busy',
      ],
    ] as const) {
      const { uploader, uploads } = verifying(refusingRender(cause));
      await assert.rejects(
        uploader.upload({ body: somePdf, visibility: 'private' }),
        (err: ResizeOriginalError) => {
          assert.ok(err instanceof ResizeOriginalError);
          assert.equal(err.code, 'RESIZE_ORIGINAL_VERIFY_FAILED');
          assert.equal(err.retryable, true);
          assert.equal(err.cause, cause);
          assert.equal(
            err.message,
            `resize uploadOriginal: the decode check failed: ${detail}`,
          );
          return true;
        },
      );
      assert.equal(uploads.length, 0);
    }
  });

  test("a host decoder's final refusal during the check keeps its code and retryable, as at inspect", async () => {
    const cause = new ResizeMediaError('the PDF is encrypted', {
      code: 'TEST_ENCRYPTED',
      retryable: false,
    });
    const { uploader, uploads } = verifying(refusingRender(cause));
    await assert.rejects(
      uploader.upload({ body: somePdf, visibility: 'private' }),
      (err: ResizeOriginalError) => {
        assert.ok(err instanceof ResizeOriginalError);
        assert.equal(err.code, 'TEST_ENCRYPTED');
        assert.equal(err.retryable, false);
        assert.equal(err.message, 'the PDF is encrypted');
        assert.equal(err.cause, cause);
        return true;
      },
    );
    assert.equal(uploads.length, 0);
  });

  test('a module error whose retryable cannot be read stays RESIZE_ORIGINAL_VERIFY_FAILED', async () => {
    const cause = Object.defineProperty(
      new ResizeMediaError('the test decoder gave up', { code: 'TEST_CODE' }),
      'retryable',
      {
        get() {
          throw new Error('no');
        },
      },
    );
    const { uploader, uploads } = verifying(refusingRender(cause));
    await assert.rejects(
      uploader.upload({ body: somePdf, visibility: 'private' }),
      (err: ResizeOriginalError) => {
        assert.ok(err instanceof ResizeOriginalError);
        assert.equal(err.code, 'RESIZE_ORIGINAL_VERIFY_FAILED');
        assert.equal(err.retryable, true);
        assert.equal(err.cause, cause);
        return true;
      },
    );
    assert.equal(uploads.length, 0);
  });

  test('a thrown value that cannot be read does not break the verify error', async () => {
    for (const cause of unreadableValues()) {
      const { uploader, uploads } = verifying(refusingRender(cause));
      await assert.rejects(
        uploader.upload({ body: somePdf, visibility: 'private' }),
        (err: ResizeOriginalError) => {
          assert.ok(err instanceof ResizeOriginalError);
          assert.equal(err.code, 'RESIZE_ORIGINAL_VERIFY_FAILED');
          assert.equal(err.retryable, true);
          assert.ok(err.cause === cause, 'the cause is that very value');
          assert.equal(
            err.message,
            'resize uploadOriginal: the decode check failed: a thrown value that cannot be printed',
          );
          return true;
        },
      );
      assert.equal(uploads.length, 0);
    }
  });

  test('damage a host decoder reports without an engine error names its own message', async () => {
    const { uploader } = verifying(
      refusingRender(
        new ResizeMediaError('page 3 is cut', {
          code: 'RESIZE_SOURCE_DAMAGED',
          retryable: false,
        }),
      ),
    );
    await assert.rejects(
      uploader.upload({ body: somePdf, visibility: 'private' }),
      {
        code: 'RESIZE_ORIGINAL_DAMAGED',
        message: 'resize uploadOriginal: the image is damaged: page 3 is cut',
      },
    );
  });

  test('the pixel limit met while verifying is RESIZE_ORIGINAL_TOO_MANY_PIXELS', async () => {
    const { uploader, uploads } = verifying(
      refusingRender(
        new ResizeMediaError('over the limit', {
          code: 'RESIZE_SOURCE_TOO_LARGE',
          retryable: false,
        }),
      ),
    );
    await assert.rejects(
      uploader.upload({ body: somePdf, visibility: 'private' }),
      { code: 'RESIZE_ORIGINAL_TOO_MANY_PIXELS', retryable: false },
    );
    assert.equal(uploads.length, 0);
  });

  test('a setup error from the verify render reaches the caller unchanged', async () => {
    const setup = new ResizeSetupError('the test decoder is not wired', {
      code: 'TEST_SETUP',
    });
    const { uploader, uploads } = verifying(refusingRender(setup));
    await assert.rejects(
      uploader.upload({ body: somePdf, visibility: 'private' }),
      (err: unknown) => err === setup,
    );
    assert.equal(uploads.length, 0);
  });

  test('a policy refusal comes before the verify decode', async () => {
    let renders = 0;
    const countingRender = async () => {
      renders += 1;
      return anyRaster;
    };
    const disabled = new Uploader({
      storage: recordingStorage().storage,
      decoders: new DecoderSet([renderingDecoder(pdfInfo, countingRender)]),
      config: makeImageConfig({
        upload: { verify: 'decode', formats: ['png'] },
      }),
    });
    await assert.rejects(
      disabled.upload({ body: somePdf, visibility: 'private' }),
      { code: 'RESIZE_ORIGINAL_FORMAT_DISABLED' },
    );
    const { uploader } = verifying(
      new DecoderSet([
        renderingDecoder(
          {
            format: 'svg',
            contentType: 'image/svg+xml',
            width: 10,
            height: 10,
            vector: true,
          },
          countingRender,
        ),
      ]),
    );
    await assert.rejects(
      uploader.upload({ body: Buffer.from('<svg/>'), visibility: 'public' }),
      { code: 'RESIZE_ORIGINAL_SVG_PUBLIC' },
    );
    assert.equal(renders, 0);
  });

  test('a rejected verify is counted as a rejected upload', async () => {
    const { uploader, metrics } = verifying();
    await assert.rejects(
      uploader.upload({
        body: cut(await noisy().jpeg().toBuffer()),
        visibility: 'private',
      }),
      { code: 'RESIZE_ORIGINAL_DAMAGED' },
    );
    assert.equal(metrics.calls.length, 1);
    const [timing] = metrics.calls;
    assert.deepEqual(
      { kind: timing.kind, name: timing.name, labels: timing.labels },
      {
        kind: 'timing',
        name: 'resize.upload',
        labels: { outcome: 'rejected', code: 'RESIZE_ORIGINAL_DAMAGED' },
      },
    );
  });
});

describe('upload metrics', () => {
  /** An Uploader with recording storage and a recording metrics sink. */
  function measuredUploader() {
    const { storage } = recordingStorage();
    const metrics = recordingMetrics();
    const uploader = new Uploader({
      storage,
      decoders: createDecoderSet(),
      config: makeImageConfig(),
      metrics,
    });
    return { uploader, metrics };
  }

  test('a stored upload records its time and its bytes', async () => {
    const { uploader, metrics } = measuredUploader();
    const body = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 9, g: 9, b: 9 },
      },
    })
      .png()
      .toBuffer();
    await uploader.upload({ body, visibility: 'private' });
    assert.equal(metrics.calls.length, 2);
    const [timing, bytes] = metrics.calls;
    assert.deepEqual(
      { kind: timing.kind, name: timing.name, labels: timing.labels },
      {
        kind: 'timing',
        name: 'resize.upload',
        labels: { outcome: 'stored', format: 'png' },
      },
    );
    assert.ok(timing.value >= 0);
    assert.deepEqual(
      {
        kind: bytes.kind,
        name: bytes.name,
        value: bytes.value,
        labels: bytes.labels,
      },
      {
        kind: 'count',
        name: 'resize.upload.bytes',
        value: body.length,
        labels: { format: 'png' },
      },
    );
  });

  test('a rejected upload records its code and still throws', async () => {
    const { uploader, metrics } = measuredUploader();
    await assert.rejects(
      () => uploader.upload({ body: Buffer.alloc(0), visibility: 'private' }),
      { code: 'RESIZE_ORIGINAL_EMPTY' },
    );
    assert.equal(metrics.calls.length, 1);
    const [timing] = metrics.calls;
    assert.deepEqual(
      { kind: timing.kind, name: timing.name, labels: timing.labels },
      {
        kind: 'timing',
        name: 'resize.upload',
        labels: { outcome: 'rejected', code: 'RESIZE_ORIGINAL_EMPTY' },
      },
    );
    assert.ok(timing.value >= 0);
  });
});

describe('adoptOriginal', () => {
  /**
   * An Uploader over memoryStorage(), whose `publicUrl` answers for every ref, so each object reads
   * as public (a Sharp format may be) unless its ref says `private: true`.
   */
  function adopting({
    config = {},
    decoders = createDecoderSet(),
    storage: over = {},
  }: {
    config?: Parameters<typeof makeImageConfig>[0];
    decoders?: DecoderSet;
    storage?: Partial<ResizeStorage>;
  } = {}) {
    const { storage, files } = memoryStorage();
    const { publicUrl } = storage;
    storage.publicUrl = (ref) => {
      if ((ref as { private?: boolean }).private === true) {
        throw new Error('this object is private');
      }
      return publicUrl(ref);
    };
    const metrics = recordingMetrics();
    const uploader = new Uploader({
      storage: Object.assign(storage, over),
      decoders,
      metrics,
      config: makeImageConfig(config),
    });
    return { uploader, files, metrics };
  }

  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"/>',
  );
  const anyRaster: Raster = {
    data: Buffer.alloc(3),
    info: { width: 1, height: 1, channels: 3 },
  };
  /** A pdf decoder over storage that reads every object as private, so the public rule is out of it. */
  const pdfAdopting = (render: SourceDecoder['render'], info = pdfInfo) => {
    const { uploader, files } = adopting({
      decoders: new DecoderSet([renderingDecoder(info, render)]),
    });
    files.set('a.pdf', somePdf);
    const adopt = () =>
      uploader.adopt({ storageRef: { key: 'a.pdf', private: true } });
    return { adopt };
  };

  for (const [name, body] of [
    ['png', png],
    ['EXIF-rotated jpeg', orientedJpeg],
    ...Object.entries(animatedOriginals),
  ] as const) {
    test(`adopting what upload stored returns the same Original: ${name}`, async () => {
      const { uploader, files } = adopting();
      const stored = await uploader.upload({ body, visibility: 'private' });
      const adopted = await uploader.adopt({ storageRef: stored.storageRef });
      assert.deepEqual(adopted, stored);
      assert.deepEqual(Object.keys(adopted), Object.keys(stored));
      assert.deepEqual(
        await uploader.adopt({ storageRef: stored.storageRef }),
        stored,
      ); // a second adoption too
      assert.equal(files.size, 1); // adoption stored nothing
    });
  }

  test('adopting on LocalFsStorage with a namespace returns the same Original', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'resize-adopt-'));
    t.after(async () => {
      await rm(dir, { recursive: true, force: true });
      await rm(`${dir}-private`, { recursive: true, force: true });
    });
    const uploader = new Uploader({
      storage: new LocalFsStorage({ rootDir: dir, publicBaseUrl: '/media' }),
      decoders: createDecoderSet(),
      config: makeImageConfig(),
    });
    for (const [body, visibility] of [
      [png, 'private'],
      [png, 'public'],
      [svg, 'private'],
    ] as const) {
      const stored = await uploader.upload({
        body,
        visibility,
        namespace: 'avatars',
      });
      assert.equal(
        (stored.storageRef as { namespace: string }).namespace,
        'avatars',
      );
      assert.deepEqual(
        await uploader.adopt({ storageRef: stored.storageRef }),
        stored,
      );
    }
  });

  test('adopting on LocalFsStorage: a file already there is read in place, and the visibility decides what is public', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'resize-adopt-'));
    t.after(async () => {
      await rm(dir, { recursive: true, force: true });
      await rm(`${dir}-private`, { recursive: true, force: true });
    });
    await mkdir(join(dir, 'legacy'));
    await mkdir(join(`${dir}-private`, 'legacy'), { recursive: true });
    await writeFile(join(dir, 'legacy', 'a.svg'), svg);
    await writeFile(join(`${dir}-private`, 'legacy', 'a.svg'), svg);
    const uploader = new Uploader({
      storage: new LocalFsStorage({ rootDir: dir, publicBaseUrl: '/media' }),
      decoders: createDecoderSet(),
      config: makeImageConfig(),
    });
    const storageRef = { path: 'legacy/a.svg', visibility: 'private' };
    assert.deepEqual(await uploader.adopt({ storageRef }), {
      storageRef,
      format: 'svg',
      contentType: 'image/svg+xml',
      size: svg.byteLength,
      width: 40,
      height: 20,
    });
    await assert.rejects(
      uploader.adopt({
        storageRef: { path: 'legacy/a.svg', visibility: 'public' },
      }),
      { code: 'RESIZE_ORIGINAL_SVG_PUBLIC' },
    );
    // Local paths are filesystem paths, and stay strict: a host copies such a file to a new name.
    await assert.rejects(
      uploader.adopt({
        storageRef: { path: 'legacy/my cat.jpg', visibility: 'private' },
      }),
      { code: 'RESIZE_STORAGE_KEY_INVALID', retryable: false },
    );
  });

  test('a real over-limit refusal from a driver stays RESIZE_SOURCE_TOO_LARGE', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'resize-adopt-'));
    t.after(async () => {
      await rm(dir, { recursive: true, force: true });
      await rm(`${dir}-private`, { recursive: true, force: true });
    });
    const storage = new LocalFsStorage({
      rootDir: dir,
      publicBaseUrl: '/media',
    });
    const decoders = createDecoderSet();
    const { storageRef } = await new Uploader({
      storage,
      decoders,
      config: makeImageConfig(),
    }).upload({ body: png, visibility: 'private' });
    await assert.rejects(
      new Uploader({
        storage,
        decoders,
        config: makeImageConfig({ limits: { sourceBytes: 10 } }),
      }).adopt({ storageRef }),
      (err: ResizeError) => {
        assert.ok(err instanceof ResizeMediaError);
        assert.ok(!(err instanceof ResizeOriginalError));
        assert.equal(err.code, 'RESIZE_SOURCE_TOO_LARGE');
        assert.equal(err.retryable, false);
        return true;
      },
    );
  });

  test("a driver's ResizeError passes through as the same object", async () => {
    for (const refusal of [
      new ResizeSecurityError('a third bucket', {
        code: 'RESIZE_S3_BUCKET_NOT_ALLOWED',
      }),
      new ResizeSecurityError('a refused key', {
        code: 'RESIZE_STORAGE_KEY_INVALID',
      }),
      new ResizeStorageError('object not found', {
        code: 'RESIZE_STORAGE_NOT_FOUND',
      }),
      // Not the decoder's code of this name, which an upload reads as a pixel limit.
      new ResizeMediaError('over the limit', {
        code: 'RESIZE_SOURCE_TOO_LARGE',
        retryable: false,
      }),
    ]) {
      const { uploader } = adopting({
        storage: {
          download: async () => {
            throw refusal;
          },
        },
      });
      await assert.rejects(
        uploader.adopt({ storageRef: { key: 'k' } }),
        (err: unknown) => {
          assert.strictEqual(err, refusal);
          return true;
        },
      );
    }
  });

  test('another driver error is RESIZE_ORIGINAL_DOWNLOAD_FAILED with its cause, retryable', async () => {
    for (const cause of [new Error('socket hang up'), ...unreadableValues()]) {
      const { uploader } = adopting({
        storage: {
          download: async () => {
            throw cause;
          },
        },
      });
      await assert.rejects(
        uploader.adopt({ storageRef: { key: 'k' } }),
        (err: ResizeStorageError) => {
          assert.ok(err instanceof ResizeStorageError);
          assert.equal(err.code, 'RESIZE_ORIGINAL_DOWNLOAD_FAILED');
          assert.equal(err.retryable, true);
          assert.ok(err.cause === cause, 'the cause is that very value');
          assert.equal(
            err.message,
            'resize adoptOriginal: the object could not be read from storage',
          );
          return true;
        },
      );
    }
  });

  test('a driver that resolves with something other than bytes is RESIZE_ORIGINAL_DOWNLOAD_FAILED too', async () => {
    for (const value of [
      undefined,
      null,
      'text',
      {},
      5,
      new DataView(new ArrayBuffer(1)),
      new Uint16Array(1),
    ]) {
      const { uploader } = adopting({
        storage: { download: async () => value as never },
      });
      await assert.rejects(uploader.adopt({ storageRef: { key: 'k' } }), {
        code: 'RESIZE_ORIGINAL_DOWNLOAD_FAILED',
        retryable: true,
      });
    }
  });

  test('no storageRef is RESIZE_ORIGINAL_STORAGE_REF_INVALID, and a falsy scalar ref is read', async () => {
    const read: unknown[] = [];
    const { uploader } = adopting({
      storage: {
        download: async (ref) => {
          read.push(ref);
          return png;
        },
        publicUrl: () => '/any',
      },
    });
    for (const opts of [
      undefined,
      {},
      { storageRef: null },
      { storageRef: undefined },
    ]) {
      await assert.rejects(
        uploader.adopt(opts as never),
        (err: ResizeOriginalError) => {
          assert.ok(err instanceof ResizeOriginalError);
          assert.equal(err.code, 'RESIZE_ORIGINAL_STORAGE_REF_INVALID');
          assert.equal(err.retryable, false);
          assert.equal(
            err.message,
            'resize adoptOriginal: storageRef is required',
          );
          return true;
        },
      );
    }
    assert.deepEqual(read, [], 'no download without a ref');
    const original = await uploader.adopt({ storageRef: 0 });
    assert.equal(original.storageRef, 0);
    assert.deepEqual(read, [0]);
  });

  test('a driver that ignores maxBytes: RESIZE_SOURCE_TOO_LARGE naming limits.sourceBytes, and download got { maxBytes }', async () => {
    const asked: unknown[] = [];
    let inspected = 0;
    const { uploader } = adopting({
      config: { limits: { sourceBytes: 10 } },
      decoders: new DecoderSet([
        {
          formats: ['pdf'],
          inspect: async () => {
            inspected += 1;
            return pdfInfo;
          },
          render: async () => anyRaster,
        },
      ]),
      storage: {
        download: async (_ref, opts) => {
          asked.push(opts);
          return new Uint8Array(11);
        },
      },
    });
    await assert.rejects(
      uploader.adopt({ storageRef: { key: 'k' } }),
      (err: ResizeMediaError) => {
        assert.ok(err instanceof ResizeMediaError);
        assert.equal(err.code, 'RESIZE_SOURCE_TOO_LARGE');
        assert.equal(err.retryable, false);
        assert.equal(
          err.message,
          'resize adoptOriginal: object is 11 bytes, over limits.sourceBytes (10)',
        );
        return true;
      },
    );
    assert.deepEqual(asked, [{ maxBytes: 10 }]);
    assert.equal(inspected, 0, 'no decoder saw the bytes');
  });

  test('an object at exactly limits.sourceBytes, as a Uint8Array, is adopted', async () => {
    const { uploader } = adopting({
      config: { limits: { sourceBytes: png.byteLength } },
      storage: { download: async () => new Uint8Array(png) },
    });
    const original = await uploader.adopt({ storageRef: { key: 'k' } });
    assert.equal(original.size, png.byteLength);
  });

  test('an empty object is RESIZE_ORIGINAL_EMPTY; bytes that are not an image are refused', async () => {
    const { uploader, files } = adopting();
    files.set('empty', Buffer.alloc(0));
    files.set('text', Buffer.from('this is not an image'));
    await assert.rejects(
      uploader.adopt({ storageRef: { key: 'empty' } }),
      (err: ResizeOriginalError) => {
        assert.ok(err instanceof ResizeOriginalError);
        assert.equal(err.code, 'RESIZE_ORIGINAL_EMPTY');
        assert.equal(err.retryable, false);
        return true;
      },
    );
    await assert.rejects(
      uploader.adopt({ storageRef: { key: 'text' } }),
      (err: ResizeOriginalError) => {
        assert.ok(err instanceof ResizeOriginalError);
        assert.equal(err.code, 'RESIZE_ORIGINAL_INVALID');
        assert.equal(err.retryable, false);
        return true;
      },
    );
  });

  test('bytes every decoder refuses are RESIZE_ORIGINAL_FORMAT_UNSUPPORTED', async () => {
    const { uploader, files } = adopting({
      decoders: new DecoderSet([
        fakeDecoder(['pdf'], {
          error: new ResizeMediaError('not a pdf', {
            code: 'RESIZE_SOURCE_FORMAT_UNSUPPORTED',
            retryable: false,
          }),
        }),
      ]),
    });
    files.set('a', png);
    await assert.rejects(uploader.adopt({ storageRef: { key: 'a' } }), {
      code: 'RESIZE_ORIGINAL_FORMAT_UNSUPPORTED',
      retryable: false,
    });
  });

  test('one frame over limits.sourcePixels is refused; frames that only add up over it are adopted', async () => {
    const body = animatedOriginals.webp; // 2 frames of 10×10
    const within = adopting({ config: { limits: { sourcePixels: 150 } } });
    within.files.set('a', body);
    const original = await within.uploader.adopt({ storageRef: { key: 'a' } });
    assert.equal(original.width, 10);
    assert.equal(original.height, 10);
    const over = adopting({ config: { limits: { sourcePixels: 50 } } });
    over.files.set('a', body);
    await assert.rejects(over.uploader.adopt({ storageRef: { key: 'a' } }), {
      code: 'RESIZE_ORIGINAL_TOO_MANY_PIXELS',
      retryable: false,
      message:
        'resize adoptOriginal: image 10x10x1f exceeds limits.sourcePixels (50)',
    });
  });

  test("the engine's pixel limit is RESIZE_ORIGINAL_TOO_MANY_PIXELS", async () => {
    const { uploader, files } = adopting({
      config: { limits: { inputPixels: 100 } },
    });
    files.set('a', orientedJpeg);
    await assert.rejects(uploader.adopt({ storageRef: { key: 'a' } }), {
      code: 'RESIZE_ORIGINAL_TOO_MANY_PIXELS',
      retryable: false,
    });
  });

  test('upload.maxBytes and upload.formats are not applied', async () => {
    const { uploader, files } = adopting({
      config: { upload: { maxBytes: 10, formats: ['jpeg'] } },
    });
    files.set('a', png);
    const original = await uploader.adopt({ storageRef: { key: 'a' } });
    assert.equal(original.format, 'png');
  });

  test('a public SVG is RESIZE_ORIGINAL_SVG_PUBLIC; a private one is adopted', async () => {
    const { uploader, files } = adopting();
    files.set('a.svg', svg);
    await assert.rejects(
      uploader.adopt({ storageRef: { key: 'a.svg' } }),
      (err: ResizeOriginalError) => {
        assert.ok(err instanceof ResizeOriginalError);
        assert.equal(err.code, 'RESIZE_ORIGINAL_SVG_PUBLIC');
        assert.equal(err.retryable, false);
        assert.equal(
          err.message,
          'resize adoptOriginal: this SVG object is public — move it to private storage first; SVG originals stay private',
        );
        return true;
      },
    );
    const original = await uploader.adopt({
      storageRef: { key: 'a.svg', private: true },
    });
    assert.deepEqual(original, {
      storageRef: { key: 'a.svg', private: true },
      format: 'svg',
      contentType: 'image/svg+xml',
      size: svg.byteLength,
      width: 40,
      height: 20,
    });
  });

  test('a truncated JPEG is RESIZE_ORIGINAL_DAMAGED with upload.verify none, and adopted with limits.failOn none', async () => {
    const body = cut(await noisy().jpeg().toBuffer());
    const strict = adopting();
    assert.equal(makeImageConfig().upload.verify, 'none');
    strict.files.set('a', body);
    await assert.rejects(
      strict.uploader.adopt({ storageRef: { key: 'a' } }),
      (err: ResizeOriginalError) => {
        assert.ok(err instanceof ResizeOriginalError);
        assert.equal(err.code, 'RESIZE_ORIGINAL_DAMAGED');
        assert.equal(err.retryable, false);
        assert.equal(
          (err.cause as { code?: string }).code,
          'RESIZE_SOURCE_DAMAGED',
        );
        return true;
      },
    );
    const lenient = adopting({ config: { limits: { failOn: 'none' } } });
    lenient.files.set('a', body);
    const original = await lenient.uploader.adopt({ storageRef: { key: 'a' } });
    assert.equal(original.format, 'jpeg');
  });

  test('a decode that fails without damage is RESIZE_ORIGINAL_VERIFY_FAILED, retryable', async () => {
    const cause = new Error('timeout');
    const { adopt } = pdfAdopting(async () => {
      throw cause;
    });
    await assert.rejects(adopt(), (err: ResizeOriginalError) => {
      assert.ok(err instanceof ResizeOriginalError);
      assert.equal(err.code, 'RESIZE_ORIGINAL_VERIFY_FAILED');
      assert.equal(err.retryable, true);
      assert.equal(err.cause, cause);
      return true;
    });
  });

  test('the decode runs once at 16 px with one frame, and a clean object is adopted', async () => {
    const boxes: DecodeBox[] = [];
    const frames: number[] = [];
    const { adopt } = pdfAdopting(async (_bytes, box, opts) => {
      boxes.push(box);
      frames.push(opts.frames);
      return anyRaster;
    });
    assert.equal((await adopt()).format, 'pdf');
    assert.deepEqual(boxes, [{ width: 16, height: 16 }]);
    assert.deepEqual(frames, [1]);
  });

  test('an unrecognised engine failure during inspect is RESIZE_ORIGINAL_INSPECT_FAILED, retryable', async () => {
    const { uploader, files } = adopting();
    files.set(
      'a',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    await assert.rejects(
      uploader.adopt({ storageRef: { key: 'a' } }),
      (err: ResizeOriginalError) => {
        assert.ok(err instanceof ResizeOriginalError);
        assert.equal(err.code, 'RESIZE_ORIGINAL_INSPECT_FAILED');
        assert.equal(err.retryable, true);
        return true;
      },
    );
  });

  test("a host decoder's final refusal keeps its code and retryable, at inspect and in the decode", async () => {
    const cause = new ResizeMediaError('the PDF is encrypted', {
      code: 'TEST_ENCRYPTED',
      retryable: false,
    });
    const atInspect = adopting({
      decoders: new DecoderSet([fakeDecoder(['pdf'], { error: cause })]),
    });
    atInspect.files.set('a', somePdf);
    const refused = (err: ResizeOriginalError) => {
      assert.ok(err instanceof ResizeOriginalError);
      assert.equal(err.code, 'TEST_ENCRYPTED');
      assert.equal(err.retryable, false);
      assert.equal(err.cause, cause);
      return true;
    };
    await assert.rejects(
      atInspect.uploader.adopt({ storageRef: { key: 'a' } }),
      refused,
    );
    const { adopt } = pdfAdopting(async () => {
      throw cause;
    });
    await assert.rejects(adopt(), refused);
  });

  test("a decoder's setup error reaches the caller as the same object, at inspect and in the decode", async () => {
    const setup = new ResizeSetupError('the test decoder is not wired', {
      code: 'TEST_SETUP',
    });
    const atInspect = adopting({
      decoders: new DecoderSet([fakeDecoder(['pdf'], { error: setup })]),
    });
    atInspect.files.set('a', somePdf);
    const same = (err: unknown) => {
      assert.strictEqual(err, setup);
      return true;
    };
    await assert.rejects(
      atInspect.uploader.adopt({ storageRef: { key: 'a' } }),
      same,
    );
    const { adopt } = pdfAdopting(async () => {
      throw setup;
    });
    await assert.rejects(adopt(), same);
  });

  test("an SVG object is not decoded: the decoder's render is never called", async () => {
    const real = new SvgDecoder();
    let renders = 0;
    const counting: SourceDecoder = {
      formats: real.formats,
      inspect: (bytes, limits) => real.inspect(bytes, limits),
      render: async (bytes, box, opts) => {
        renders += 1;
        return real.render(bytes, box, opts);
      },
    };
    const { uploader, files } = adopting({
      decoders: new DecoderSet([counting]),
    });
    files.set('a.svg', svg);
    const original = await uploader.adopt({
      storageRef: { key: 'a.svg', private: true },
    });
    assert.equal(original.format, 'svg');
    assert.equal(renders, 0);
  });

  test("a host decoder's vector object is not decoded at adoption", async () => {
    let renders = 0;
    const { files, uploader } = adopting({
      decoders: new DecoderSet([
        renderingDecoder({ ...pdfInfo, vector: true }, async () => {
          renders += 1;
          throw new Error('a vector source must not render at adoption');
        }),
      ]),
      storage: {
        publicUrl: () => {
          throw new Error('this object is private');
        },
      },
    });
    files.set('a.pdf', somePdf);
    const original = await uploader.adopt({ storageRef: { key: 'a.pdf' } });
    assert.equal(original.format, 'pdf');
    assert.equal(renders, 0);
  });

  test('a public object a decoder may not hold is refused before the decode', async () => {
    let renders = 0;
    const { files, uploader } = adopting({
      decoders: new DecoderSet([
        renderingDecoder(pdfInfo, async () => {
          renders += 1;
          return anyRaster;
        }),
      ]),
    });
    files.set('a.pdf', somePdf);
    await assert.rejects(uploader.adopt({ storageRef: { key: 'a.pdf' } }), {
      code: 'RESIZE_ORIGINAL_PUBLIC_REFUSED',
      retryable: false,
    });
    assert.equal(renders, 0);
  });

  test('every message the uploader writes here says adoptOriginal', async () => {
    const says = async (
      body: Buffer,
      config: Parameters<typeof makeImageConfig>[0],
      code: string,
    ) => {
      const { uploader, files } = adopting({ config });
      files.set('a', body);
      await assert.rejects(
        uploader.adopt({ storageRef: { key: 'a' } }),
        (err: ResizeOriginalError) => {
          assert.equal(err.code, code);
          assert.match(err.message, /^resize adoptOriginal:/);
          return true;
        },
      );
    };
    await says(Buffer.alloc(0), {}, 'RESIZE_ORIGINAL_EMPTY');
    await says(Buffer.from('not an image'), {}, 'RESIZE_ORIGINAL_INVALID');
    await says(
      png,
      { limits: { sourcePixels: 1 } },
      'RESIZE_ORIGINAL_TOO_MANY_PIXELS',
    );
    await says(svg, {}, 'RESIZE_ORIGINAL_SVG_PUBLIC');
    await says(
      cut(await noisy().jpeg().toBuffer()),
      {},
      'RESIZE_ORIGINAL_DAMAGED',
    );
    // A cut GIF is damage that inspect finds, and malformed XML has a line of its own.
    await says(
      cut(await noisy().gif().toBuffer()),
      {},
      'RESIZE_ORIGINAL_INVALID',
    );
    await says(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><g></svg>',
      ),
      {},
      'RESIZE_ORIGINAL_INVALID',
    );
    await says(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      {},
      'RESIZE_ORIGINAL_INSPECT_FAILED',
    );
    const { adopt } = pdfAdopting(async () => {
      throw new Error('timeout');
    });
    await assert.rejects(adopt(), {
      code: 'RESIZE_ORIGINAL_VERIFY_FAILED',
      message: /^resize adoptOriginal: the decode check failed: timeout$/,
    });
  });

  test('adoption records a resize.adopt timing and no upload metric', async () => {
    const { uploader, files, metrics } = adopting();
    files.set('a', png);
    files.set('empty', Buffer.alloc(0));
    await uploader.adopt({ storageRef: { key: 'a' } });
    await assert.rejects(uploader.adopt({ storageRef: { key: 'empty' } }), {
      code: 'RESIZE_ORIGINAL_EMPTY',
    });
    assert.deepEqual(
      metrics.calls.map(({ kind, name, labels }) => ({ kind, name, labels })),
      [
        {
          kind: 'timing',
          name: 'resize.adopt',
          labels: { outcome: 'adopted', format: 'png' },
        },
        {
          kind: 'timing',
          name: 'resize.adopt',
          labels: { outcome: 'rejected', code: 'RESIZE_ORIGINAL_EMPTY' },
        },
      ],
    );
    for (const { value } of metrics.calls) {
      assert.ok(value >= 0);
    }
  });

  test('a rejection that is not a module error is recorded without a code', async () => {
    const hostile = new Error('hostile');
    const { uploader, metrics } = adopting();
    const opts = {
      get storageRef() {
        throw hostile;
      },
    };
    await assert.rejects(uploader.adopt(opts as never), (err: unknown) => {
      assert.strictEqual(err, hostile);
      assert.ok(!ResizeError.isResizeError(err));
      return true;
    });
    assert.deepEqual(metrics.calls[0].labels, { outcome: 'rejected' });
  });

  test('the value holds the ref as JSON: an undefined value drops, and a later change to the given object reaches nothing', async () => {
    const seen: unknown[] = [];
    const { uploader } = adopting({
      storage: {
        download: async (ref) => {
          seen.push(['download', ref]);
          return png;
        },
        publicUrl: (ref) => {
          seen.push(['publicUrl', ref]);
          throw new Error('this object is private');
        },
      },
    });
    const given = {
      key: 'k',
      namespace: undefined,
      nested: { gone: undefined, kept: 1 },
    };
    const { storageRef } = await uploader.adopt({ storageRef: given });
    assert.deepStrictEqual(storageRef, { key: 'k', nested: { kept: 1 } });
    // The driver reads what a worker reads once the value is saved, so it refuses it now if at all.
    assert.deepStrictEqual(seen, [
      ['download', storageRef],
      ['publicUrl', storageRef],
    ]);
    given.key = 'other';
    given.nested.kept = 2;
    assert.deepStrictEqual(storageRef, { key: 'k', nested: { kept: 1 } });
  });

  test('a ref JSON cannot represent is RESIZE_ORIGINAL_STORAGE_REF_INVALID, and nothing is read', async () => {
    let read = 0;
    const { uploader } = adopting({
      storage: {
        download: async () => {
          read += 1;
          return png;
        },
      },
    });
    const circular: Record<string, unknown> = { key: 'k' };
    circular.self = circular;
    const refs: Array<[string, unknown]> = [
      ['circular', circular],
      ['a BigInt inside', { key: 1n }],
      ['a BigInt', 1n],
      ['a function', () => 'k'],
      ['a symbol', Symbol('k')],
      ['NaN, whose JSON form is null', Number.NaN],
      ['a toJSON that resolves to nothing', { toJSON: () => undefined }],
      [
        'a toJSON that throws',
        {
          toJSON() {
            throw new Error('no');
          },
        },
      ],
      [
        'a getter that throws',
        {
          get key() {
            throw new Error('no');
          },
        },
      ],
    ];
    for (const [what, storageRef] of refs) {
      await assert.rejects(
        uploader.adopt({ storageRef } as never),
        (err: ResizeOriginalError) => {
          assert.ok(err instanceof ResizeOriginalError, what);
          assert.equal(err.code, 'RESIZE_ORIGINAL_STORAGE_REF_INVALID', what);
          assert.equal(err.retryable, false, what);
          assert.match(err.message, /adoptOriginal: storageRef/, what);
          return true;
        },
      );
    }
    assert.equal(read, 0);
    await assert.rejects(
      uploader.adopt({ storageRef: circular }),
      (err: ResizeOriginalError) => {
        assert.ok(err.cause instanceof TypeError, 'the reason stays readable');
        return true;
      },
    );
  });

  describe('maxBytes', () => {
    const storageRef = { key: 'k', private: true };
    const overMaxBytes = (cap: number) => (err: ResizeOriginalError) => {
      assert.ok(err instanceof ResizeOriginalError);
      assert.equal(err.code, 'RESIZE_ORIGINAL_TOO_LARGE');
      assert.equal(err.retryable, false);
      assert.match(err.message, new RegExp(`maxBytes \\(${cap}\\)`));
      assert.doesNotMatch(err.message, /limits\.sourceBytes/);
      return true;
    };
    /** A driver that refuses from the object's length, as the shipped ones do, and reads nothing. */
    const refusing = (length: number, reads: { count: number }) => ({
      download: async (_ref: unknown, opts?: { maxBytes?: number }) => {
        if (opts?.maxBytes !== undefined && length > opts.maxBytes) {
          throw new ResizeMediaError(
            `resize test: object is ${length} bytes, over the ${opts.maxBytes} byte limit (limits.sourceBytes)`,
            { code: 'RESIZE_SOURCE_TOO_LARGE', retryable: false },
          );
        }
        reads.count += 1;
        return png;
      },
    });

    test('the driver is asked for the smaller of it and limits.sourceBytes, so it cannot raise the limit', async () => {
      const limit = png.length + 10;
      const asked: unknown[] = [];
      const { uploader } = adopting({
        config: { limits: { sourceBytes: limit } },
        storage: {
          download: async (_ref, opts) => {
            asked.push(opts);
            return png;
          },
        },
      });
      for (const maxBytes of [undefined, png.length, limit, 2 ** 40]) {
        await uploader.adopt({ storageRef, maxBytes });
      }
      assert.deepEqual(asked, [
        { maxBytes: limit },
        { maxBytes: png.length },
        { maxBytes: limit },
        { maxBytes: limit },
      ]);
    });

    test("over a call's own cap: a driver's refusal becomes RESIZE_ORIGINAL_TOO_LARGE, and nothing is read past it", async () => {
      const reads = { count: 0 };
      const { uploader, metrics } = adopting({
        config: { limits: { sourceBytes: 1000 } },
        storage: refusing(500, reads),
      });
      await assert.rejects(
        uploader.adopt({ storageRef, maxBytes: 100 }),
        overMaxBytes(100),
      );
      assert.equal(reads.count, 0);
      assert.deepEqual(metrics.calls.at(-1)?.labels, {
        outcome: 'rejected',
        code: 'RESIZE_ORIGINAL_TOO_LARGE',
      });
    });

    test('an object over both is over the cap that applied: the smaller one', async () => {
      const { uploader } = adopting({
        config: { limits: { sourceBytes: 1000 } },
        storage: refusing(5000, { count: 0 }),
      });
      await assert.rejects(
        uploader.adopt({ storageRef, maxBytes: 100 }),
        overMaxBytes(100),
      );
    });

    test("a driver that ignores it is caught by the core's check, before any decode", async () => {
      let inspected = 0;
      const { uploader, files } = adopting({
        decoders: new DecoderSet([
          {
            formats: ['pdf'],
            inspect: async () => {
              inspected += 1;
              return pdfInfo;
            },
            render: async () => anyRaster,
          },
        ]),
      });
      files.set('k', Buffer.alloc(11));
      await assert.rejects(
        uploader.adopt({ storageRef, maxBytes: 10 }),
        overMaxBytes(10),
      );
      assert.equal(inspected, 0);
    });

    test('an object of exactly the cap is adopted', async () => {
      const { uploader, files } = adopting();
      files.set('k', png);
      const original = await uploader.adopt({
        storageRef,
        maxBytes: png.length,
      });
      assert.equal(original.size, png.length);
    });

    test('over limits.sourceBytes stays RESIZE_SOURCE_TOO_LARGE, however the call sets maxBytes, on a driver that refuses and on one that ignores it', async () => {
      const tooLarge = (err: ResizeMediaError) => {
        assert.ok(err instanceof ResizeMediaError);
        assert.equal(err.code, 'RESIZE_SOURCE_TOO_LARGE');
        assert.equal(err.retryable, false);
        assert.match(err.message, /limits\.sourceBytes/);
        return true;
      };
      for (const maxBytes of [undefined, 10, 11]) {
        const honest = adopting({
          config: { limits: { sourceBytes: 10 } },
          storage: refusing(11, { count: 0 }),
        });
        const ignoring = adopting({ config: { limits: { sourceBytes: 10 } } });
        ignoring.files.set('k', Buffer.alloc(11));
        await assert.rejects(
          honest.uploader.adopt({ storageRef, maxBytes }),
          tooLarge,
        );
        await assert.rejects(
          ignoring.uploader.adopt({ storageRef, maxBytes }),
          tooLarge,
        );
      }
    });

    test('another refusal from the driver passes unchanged under a cap', async () => {
      const refusal = new ResizeStorageError('gone', {
        code: 'RESIZE_STORAGE_NOT_FOUND',
      });
      const { uploader } = adopting({
        storage: {
          download: async () => {
            throw refusal;
          },
        },
      });
      await assert.rejects(
        uploader.adopt({ storageRef, maxBytes: 10 }),
        (err: unknown) => err === refusal,
      );
    });

    test('an invalid value is RESIZE_ADOPT_MAX_BYTES_INVALID, and nothing is read', async () => {
      let read = 0;
      const { uploader } = adopting({
        storage: {
          download: async () => {
            read += 1;
            return png;
          },
        },
      });
      for (const maxBytes of [
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        2 ** 53,
        '100',
        null,
        {},
      ]) {
        await assert.rejects(
          uploader.adopt({ storageRef, maxBytes } as never),
          (err: ResizeSetupError) => {
            assert.ok(err instanceof ResizeSetupError, String(maxBytes));
            assert.equal(err.code, 'RESIZE_ADOPT_MAX_BYTES_INVALID');
            assert.equal(err.retryable, false);
            assert.match(err.message, /maxBytes/);
            return true;
          },
        );
      }
      assert.equal(read, 0);
    });

    test('on LocalFsStorage: over it nothing is read, and exactly it is adopted', async (t) => {
      const dir = await mkdtemp(join(tmpdir(), 'resize-adopt-'));
      t.after(async () => {
        await rm(dir, { recursive: true, force: true });
        await rm(`${dir}-private`, { recursive: true, force: true });
      });
      await mkdir(`${dir}-private`, { recursive: true });
      const uploader = new Uploader({
        storage: new LocalFsStorage({ rootDir: dir, publicBaseUrl: '/media' }),
        decoders: createDecoderSet(),
        config: makeImageConfig(),
      });
      const huge = { path: 'huge.mp4', visibility: 'private' };
      await writeFile(join(`${dir}-private`, 'huge.mp4'), '');
      // Sparse and over 2 GiB: readFile would reject with ERR_FS_FILE_TOO_LARGE, so the code proves stat refused it.
      await truncate(join(`${dir}-private`, 'huge.mp4'), 3 * 1024 ** 3);
      await assert.rejects(
        uploader.adopt({ storageRef: huge, maxBytes: 1024 }),
        overMaxBytes(1024),
      );
      const small = { path: 'a.png', visibility: 'private' };
      await writeFile(join(`${dir}-private`, 'a.png'), png);
      assert.equal(
        (await uploader.adopt({ storageRef: small, maxBytes: png.length }))
          .size,
        png.length,
      );
      await assert.rejects(
        uploader.adopt({ storageRef: small, maxBytes: png.length - 1 }),
        overMaxBytes(png.length - 1),
      );
    });
  });

  test('on LocalFsStorage too, the value holds no undefined namespace', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'resize-adopt-'));
    t.after(async () => {
      await rm(dir, { recursive: true, force: true });
      await rm(`${dir}-private`, { recursive: true, force: true });
    });
    await mkdir(`${dir}-private`, { recursive: true });
    await writeFile(join(`${dir}-private`, 'a.png'), png);
    const uploader = new Uploader({
      storage: new LocalFsStorage({ rootDir: dir, publicBaseUrl: '/media' }),
      decoders: createDecoderSet(),
      config: makeImageConfig(),
    });
    const { storageRef } = await uploader.adopt({
      storageRef: {
        path: 'a.png',
        visibility: 'private',
        namespace: undefined,
      },
    });
    assert.deepStrictEqual(storageRef, {
      path: 'a.png',
      visibility: 'private',
    });
  });

  test('an ArrayBuffer from a driver is adopted, as a worker renders it', async () => {
    const buffer = png.buffer.slice(
      png.byteOffset,
      png.byteOffset + png.byteLength,
    );
    const { uploader } = adopting({
      storage: { download: async () => buffer as never },
    });
    const original = await uploader.adopt({ storageRef: { key: 'k' } });
    assert.equal(original.format, 'png');
    assert.equal(original.size, png.length);
  });
});
