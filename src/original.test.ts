import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import sharp from 'sharp';
import { ResizeOriginalError, ResizeStorageError } from './errors.ts';
import type { QueueTransport, ResizeStorage } from './resizer.ts';
import { Resizer, resetResizerForTests } from './resizer.ts';
import { LocalFsStorage } from './storage/fs.ts';

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

function installApp(config: Record<string, unknown> = {}) {
  setAppInstance({
    getConfig: () => ({ mediaModelName: 'File', ...config }),
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
    publicUrl: (ref) => `/media/${ref.key}`,
  };
  return { storage, uploads };
}

afterEach(() => {
  resetResizerForTests();
  resetAppInstance();
});

describe('uploadOriginal — raster bytes and metadata', () => {
  for (const [format, body] of Object.entries(animatedOriginals)) {
    test(`${format} animation reports frame dimensions and preserves bytes`, async () => {
      installApp();
      const { storage, uploads } = recordingStorage();
      const r = new Resizer({ storage });
      const original = await r.uploadOriginal({ body, visibility: 'public' });
      assert.equal(original.width, 10);
      assert.equal(original.height, 10);
      assert.deepEqual(uploads[0].body, body);
    });

    test(`${format} animation counts each frame once at the pixel limit`, async () => {
      installApp({ limits: { sourcePixels: 200 } });
      const { storage } = recordingStorage();
      const r = new Resizer({ storage });
      await r.uploadOriginal({ body, visibility: 'public' });
    });

    test(`${format} animation rejects total pixels above the limit before storage`, async () => {
      installApp({ limits: { sourcePixels: 199 } });
      const { storage, uploads } = recordingStorage();
      const r = new Resizer({ storage });
      await assert.rejects(r.uploadOriginal({ body, visibility: 'public' }), {
        code: 'RESIZE_ORIGINAL_TOO_MANY_PIXELS',
      });
      assert.equal(uploads.length, 0);
    });
  }

  test('stores JPEG bytes unchanged and reports display dimensions without rotating EXIF', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const r = new Resizer({ storage });
    const original = await r.uploadOriginal({
      body: orientedJpeg,
      visibility: 'private',
    });

    assert.equal(original.format, 'jpeg');
    assert.equal(original.contentType, 'image/jpeg');
    assert.equal(original.size, orientedJpeg.byteLength);
    assert.equal(original.width, 20);
    assert.equal(original.height, 40);
    assert.equal(original.bucket, 'originals');
    assert.match(original.key, /^originals\/[a-f0-9]{32}\.jpg$/);
    assert.deepEqual(uploads[0].body, orientedJpeg);
    assert.equal(uploads[0].visibility, 'private');
  });

  test('accepts Uint8Array PNG and produces a different safe key for each upload', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const r = new Resizer({ storage });
    const first = await r.uploadOriginal({
      body: new Uint8Array(png),
      visibility: 'public',
    });
    const second = await r.uploadOriginal({ body: png, visibility: 'public' });

    assert.equal(first.format, 'png');
    assert.equal(first.contentType, 'image/png');
    assert.equal(first.width, 32);
    assert.equal(first.height, 24);
    assert.match(first.key, /^originals\/[a-f0-9]{32}\.png$/);
    assert.notEqual(first.key, second.key);
    assert.deepEqual(uploads[0].body, png);
  });

  test('round-trips exact original bytes through LocalFsStorage', async () => {
    installApp();
    const dir = await mkdtemp(join(tmpdir(), 'resize-original-'));
    const r = new Resizer({
      storage: new LocalFsStorage({ rootDir: dir, publicBaseUrl: '/media' }),
    });
    const original = await r.uploadOriginal({
      body: png,
      visibility: 'private',
    });
    assert.deepEqual(await readFile(join(dir, original.key)), png);
  });

  test('recognizes WebP and AVIF containers without rewriting their bytes', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const r = new Resizer({ storage });
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

describe('uploadOriginal — SVG pass-through', () => {
  test('parses XML SVG without rasterizing or treating viewBox as pixel dimensions', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    let queueCalls = 0;
    const transport: QueueTransport = {
      enqueue: async () => {
        queueCalls++;
        return { taskId: 'unexpected' };
      },
      startWorker: async () => {},
    };
    const r = new Resizer({ storage, transport });
    const body = Buffer.from(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="120px" height="50%" viewBox="0 0 240 100"><path d="M0 0h1v1z"/></svg>',
    );
    const original = await r.uploadOriginal({ body, visibility: 'private' });

    assert.equal(original.format, 'svg');
    assert.equal(original.contentType, 'image/svg+xml');
    assert.equal(original.width, 120);
    assert.equal(original.height, undefined);
    assert.equal(original.size, body.byteLength);
    assert.match(original.key, /^originals\/[a-f0-9]{32}\.svg$/);
    assert.deepEqual(uploads[0].body, body);
    assert.equal(queueCalls, 0);
  });

  test('keeps an SVG original private and serves a separately uploaded public copy', async () => {
    installApp();
    const body = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const uploads: Array<{
      body: Buffer;
      visibility: 'public' | 'private';
      key: string;
    }> = [];
    const storage: ResizeStorage = {
      download: async () => body,
      upload: async (args) => {
        uploads.push({ ...args, body: Buffer.from(args.body) });
        return { key: args.key, bucket: args.visibility };
      },
      publicUrl: (ref) => `https://cdn/${ref.key}`,
      canServeOriginalPublicly: (ref) => ref.bucket === 'public',
    };
    const r = new Resizer({ storage });
    const original = await r.uploadOriginal({ body, visibility: 'private' });
    const published = await r.uploadOriginal({ body, visibility: 'public' });
    const media = {
      id: 'file-1',
      original: {
        ...original,
        publicCopy: { key: published.key, bucket: published.bucket },
      },
    };
    const { decision } = await r.resolve({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['webp'],
    });

    assert.equal(original.bucket, 'private');
    assert.equal(media.original.key, original.key);
    assert.equal(published.bucket, 'public');
    assert.notEqual(published.key, original.key);
    assert.deepEqual(
      uploads.map((upload) => upload.visibility),
      ['private', 'public'],
    );
    assert.deepEqual(
      uploads.map((upload) => upload.body),
      [body, body],
    );
    assert.equal(decision.ready[0]?.url, `https://cdn/${published.key}`);
    assert.deepEqual(decision.missing, []);
  });

  test('rejects malformed XML before storage', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const r = new Resizer({ storage });
    const fixtures = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="10"height="10"/>',
      '<svg xmlns="http://www.w3.org/2000/svg"><text>&unknown;</text></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><text>A & B</text></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" data-label="A & B"/>',
      '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"/><svg xmlns="http://www.w3.org/2000/svg"/>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" width="20"/>',
      '<svg xmlns="http://www.w3.org/2000/svg"><text>&#x110000;</text></svg>',
      '<!DOCTYPE svg [<!ENTITY xxe "blocked">]><svg>&xxe;</svg>',
      '<!DOCTYPE svg SYSTEM "file:///etc/passwd"><svg/>',
      '<svg xmlns="http://www.w3.org/2000/svg"/>trailing',
    ];

    for (const fixture of fixtures) {
      await assert.rejects(
        () =>
          r.uploadOriginal({
            body: Buffer.from(fixture),
            visibility: 'private',
          }),
        (error: unknown) =>
          error instanceof ResizeOriginalError &&
          error.code ===
            (fixture.startsWith('<!DOCTYPE')
              ? 'RESIZE_ORIGINAL_SVG_DTD_FORBIDDEN'
              : 'RESIZE_ORIGINAL_SVG_INVALID'),
      );
    }
    assert.equal(uploads.length, 0);
  });

  test('accepts standard and numeric entities, comments, CDATA, and a prefixed SVG namespace', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const r = new Resizer({ storage });
    const body = Buffer.from(
      '<svg:svg xmlns:svg="http://www.w3.org/2000/svg" viewBox="0,0,40,20"><!-- comment --><svg:text><![CDATA[A & B]]></svg:text><svg:title>&amp; &#x42;</svg:title></svg:svg>',
    );
    const original = await r.uploadOriginal({ body, visibility: 'public' });

    assert.equal(original.width, undefined);
    assert.equal(original.height, undefined);
    assert.deepEqual(uploads[0].body, body);

    const legacyBody = Buffer.from('<svg width="13" height="8"/>');
    const legacyOriginal = await r.uploadOriginal({
      body: legacyBody,
      visibility: 'public',
    });
    assert.equal(legacyOriginal.width, 13);
    assert.equal(legacyOriginal.height, 8);
    assert.deepEqual(uploads[1].body, legacyBody);
  });

  test('records only explicit pixel lengths and never infers dimensions from viewBox', async () => {
    installApp();
    const { storage } = recordingStorage();
    const r = new Resizer({ storage });
    const cases = [
      {
        svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120px" height="80"/>',
        width: 120,
        height: 80,
      },
      {
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 100"/>',
        width: undefined,
        height: undefined,
      },
      {
        svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" viewBox="0 0 240 100"/>',
        width: 120,
        height: undefined,
      },
      {
        svg: '<svg xmlns="http://www.w3.org/2000/svg" width="50%" height="2em" viewBox="0 0 240 100"/>',
        width: undefined,
        height: undefined,
      },
    ];

    for (const expected of cases) {
      const original = await r.uploadOriginal({
        body: Buffer.from(expected.svg),
        visibility: 'private',
      });
      assert.equal(original.width, expected.width);
      assert.equal(original.height, expected.height);
    }
  });

  test('rejects an uppercase SVG root and the wrong namespace before storage', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const r = new Resizer({ storage });
    for (const fixture of [
      '<SVG xmlns="http://www.w3.org/2000/svg"/>',
      '<svg xmlns="https://example.com/not-svg"/>',
    ]) {
      await assert.rejects(
        () =>
          r.uploadOriginal({
            body: Buffer.from(fixture),
            visibility: 'private',
          }),
        (error: unknown) =>
          error instanceof ResizeOriginalError &&
          error.code === 'RESIZE_ORIGINAL_NOT_SVG',
      );
    }
    assert.equal(uploads.length, 0);
  });

  test('rejects DTD/entities and malformed non-SVG XML before storage', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const r = new Resizer({ storage });
    await assert.rejects(
      () =>
        r.uploadOriginal({
          body: Buffer.from(
            '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg>&xxe;</svg>',
          ),
          visibility: 'private',
        }),
      (error: unknown) =>
        error instanceof ResizeOriginalError &&
        error.code === 'RESIZE_ORIGINAL_SVG_DTD_FORBIDDEN',
    );
    await assert.rejects(
      () =>
        r.uploadOriginal({
          body: Buffer.from('<?xml version="1.0"?><html/>'),
          visibility: 'public',
        }),
      (error: unknown) =>
        error instanceof ResizeOriginalError &&
        error.code === 'RESIZE_ORIGINAL_NOT_SVG',
    );
    assert.equal(uploads.length, 0);
  });

  test('preserves a declared ISO-8859-1 SVG byte-for-byte without passing it to Sharp', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const r = new Resizer({ storage });
    const body = Buffer.from(
      '<?xml version="1.0" encoding="ISO-8859-1"?><svg xmlns="http://www.w3.org/2000/svg" width="9" height="7"><text>é</text></svg>',
      'latin1',
    );

    const original = await r.uploadOriginal({
      body,
      visibility: 'private',
    });

    assert.equal(original.format, 'svg');
    assert.equal(original.contentType, 'image/svg+xml');
    assert.equal(original.width, 9);
    assert.equal(original.height, 7);
    assert.deepEqual(uploads[0].body, body);
  });

  test('rejects an unsupported XML byte order before storage', async () => {
    installApp();
    const { storage, uploads } = recordingStorage();
    const r = new Resizer({ storage });
    const utf32BePrefix = Buffer.from([0, 0, 0, 0x3c, 0, 0, 0, 0x73]);

    await assert.rejects(
      () =>
        r.uploadOriginal({
          body: utf32BePrefix,
          visibility: 'private',
        }),
      (error: unknown) =>
        error instanceof ResizeOriginalError &&
        error.code === 'RESIZE_ORIGINAL_SVG_ENCODING_UNSUPPORTED',
    );
    assert.equal(uploads.length, 0);
  });
});

describe('uploadOriginal — typed failures', () => {
  test('rejects empty, over-limit, and disabled formats before storage', async () => {
    installApp({ upload: { maxBytes: 8, formats: ['jpeg'] } });
    const { storage, uploads } = recordingStorage();
    const r = new Resizer({ storage });
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
    resetAppInstance();
    installApp({ upload: { maxBytes: 1024 * 1024, formats: ['jpeg'] } });
    await assert.rejects(
      () => r.uploadOriginal({ body: png, visibility: 'private' }),
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
    const r = new Resizer({ storage });
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
    const r = new Resizer({ storage });
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

  test('rejects an invalid custom-storage locator with a typed error', async () => {
    installApp();
    const storage: ResizeStorage = {
      download: async () => Buffer.alloc(0),
      upload: async () => undefined as never,
      publicUrl: () => '',
    };
    const r = new Resizer({ storage });
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
    const r = new Resizer({ storage });
    const body = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"/>',
    );

    const original = await r.uploadOriginal({
      body,
      visibility: 'private',
    });

    assert.match(suggestedKey, /^originals\/[a-f0-9]{32}\.svg$/);
    assert.equal(original.key, 'sha256/opaque-content-id');
    assert.equal(original.bucket, 'objects');
    assert.equal(original.format, 'svg');
  });
});
