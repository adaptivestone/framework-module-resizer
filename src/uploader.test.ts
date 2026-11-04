import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
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
import { LocalFsStorage } from './drivers/fs.ts';
import {
  ResizeMediaError,
  ResizeOriginalError,
  ResizeSetupError,
  ResizeStorageError,
} from './errors.ts';
import { FrameworkResizer } from './framework/resizer.ts';
import { resetResizerForTests } from './resizer.ts';
import {
  MemoryTaskQueue,
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
        error.cause === cause,
    );
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
