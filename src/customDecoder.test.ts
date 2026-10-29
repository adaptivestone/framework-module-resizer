// A host's own decoders, through `new Resizer({ decoders })`: a test-only PDF decoder stores and
// renders a source kind the package does not ship, eager and queued, with no core change; a host
// decoder for a built-in format is asked first; an invalid list fails at construction; and
// `verify()` runs each decoder's own check.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import sharp from 'sharp';
import defaultResizeConfig from './config/resize.ts';
import type { DecodeBox, SourceDecoder } from './contracts/decoder.ts';
import type { ResizeStorage } from './contracts/storage.ts';
import type { LeasedTask } from './contracts/taskQueue.ts';
import { SharpDecoder } from './decoders/sharp.ts';
import { ResizeMediaError, ResizeSetupError } from './errors.ts';
import {
  Resizer,
  type ResizerOptions,
  resetResizerForTests,
} from './resizer.ts';
import { fakeMedia } from './testHelpers/fakes.ts';
import { fakePdf, TestPdfDecoder } from './testHelpers/pdfDecoder.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import type { MediaLike, Preview, StorageRef } from './types.d.ts';
import { processTask } from './worker.ts';

const silent = { info() {}, warn() {}, error() {} };
const RED: [number, number, number] = [200, 30, 30];

afterEach(resetResizerForTests);

/** In-memory storage: uploads are kept by key and downloaded back. */
function memoryStorage(): {
  storage: ResizeStorage;
  files: Map<string, Buffer>;
} {
  const files = new Map<string, Buffer>();
  const keyOf = (ref: StorageRef) => (ref as { key: string }).key;
  const storage: ResizeStorage = {
    download: async (ref) => {
      const body = files.get(keyOf(ref));
      if (body === undefined) {
        throw new Error(`no file ${keyOf(ref)}`);
      }
      return body;
    },
    upload: async ({ key, body }) => {
      files.set(key, Buffer.from(body));
      return { key };
    },
    publicUrl: (ref) => `/m/${keyOf(ref)}`,
  };
  return { storage, files };
}

/** A media document in memory: load returns it, and stored previews land on it. */
function mediaOf(doc: MediaLike) {
  return fakeMedia({
    load: async (id) => (id === doc.id ? doc : null),
    appendPreviews: async (_id, previews: Preview[]) => {
      doc.previews = [...(doc.previews ?? []), ...previews];
      return previews;
    },
  });
}

const withPdf = () =>
  makeImageConfig({
    upload: { formats: [...defaultResizeConfig.upload.formats, 'pdf'] },
  });

async function centre(body: Buffer): Promise<number[]> {
  const { data, info } = await sharp(body)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const offset =
    (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) *
    info.channels;
  return [...data.subarray(offset, offset + 3)];
}

function assertNear(actual: number[], expected: number[], what: string): void {
  assert.ok(
    actual.every((value, i) => Math.abs(value - expected[i]) <= 8),
    `${what}: centre ${actual.join(',')} is not near ${expected.join(',')}`,
  );
}

const pdfTask = (over: Partial<LeasedTask> = {}): LeasedTask => ({
  taskId: 't1',
  resizer: 'default',
  queue: 'default',
  mediaId: 'm1',
  pipeline: 'default',
  previews: [
    {
      sizeKey: '60x60',
      format: 'webp',
      requestedWidth: 60,
      requestedHeight: 60,
    },
  ],
  attempts: 1,
  ...over,
});

test('a pdf decoder in `decoders` stores a pdf original and renders its previews, eager and queued', async () => {
  const pdf = new TestPdfDecoder();
  const { storage, files } = memoryStorage();
  const doc: MediaLike = { id: 'm1', previews: [] };
  const resizer = new Resizer({
    storage,
    media: mediaOf(doc),
    config: withPdf(),
    logger: silent,
    decoders: [pdf],
  });

  const original = await resizer.uploadOriginal({
    body: fakePdf(300, 200, RED),
    visibility: 'private',
  });
  assert.equal(original.format, 'pdf');
  assert.equal(original.contentType, 'application/pdf');
  assert.equal(original.width, 300);
  assert.equal(original.height, 200);
  assert.match((original.storageRef as { key: string }).key, /\.pdf$/);
  doc.original = original;

  const { created, failed } = await resizer.generate({
    media: doc,
    sizes: [{ width: 150, height: 100 }, { fit: true }],
    formats: ['jpeg', 'webp'],
  });
  assert.equal(failed, 0);
  assert.equal(created.length, 4);
  assert.deepEqual(
    created.map((p) => `${p.actualWidth}x${p.actualHeight}`).sort(),
    ['150x100', '150x100', '300x200', '300x200'],
  );
  for (const preview of created) {
    const body = files.get((preview.storageRef as { key: string }).key);
    assert.ok(body, 'the preview was uploaded');
    assertNear(await centre(body), RED, preview.sizeKey);
  }
  // One render for the task, at the largest box its sizes need.
  assert.deepEqual(pdf.renders, [{ width: 300, height: 200 }]);

  const before = files.size;
  await processTask(pdfTask());
  assert.equal(files.size, before + 1);
  const queued = doc.previews?.find((p) => p.sizeKey === '60x60');
  assert.ok(queued, 'the worker stored the 60x60 preview');
  assert.equal(queued.format, 'webp');
  const body = files.get((queued.storageRef as { key: string }).key);
  assert.ok(body);
  assertNear(await centre(body), RED, 'queued 60x60');
  assert.equal(
    pdf.renders.length,
    2,
    'the worker rendered through the pdf decoder',
  );
});

test('a pdf upload is refused when upload.formats lacks pdf', async () => {
  const { storage, files } = memoryStorage();
  const resizer = new Resizer({
    storage,
    media: fakeMedia(),
    config: makeImageConfig(),
    logger: silent,
    decoders: [new TestPdfDecoder()],
  });
  await assert.rejects(
    resizer.uploadOriginal({
      body: fakePdf(300, 200, RED),
      visibility: 'private',
    }),
    (err: unknown) =>
      err instanceof ResizeMediaError &&
      err.code === 'RESIZE_ORIGINAL_FORMAT_DISABLED',
  );
  assert.equal(files.size, 0);
});

test('a pdf original in a process without the pdf decoder is RESIZE_DECODER_MISSING', async () => {
  const { storage, files } = memoryStorage();
  files.set('originals/a.pdf', fakePdf(300, 200, RED));
  const doc: MediaLike = {
    id: 'm1',
    original: {
      storageRef: { key: 'originals/a.pdf' },
      format: 'pdf',
      contentType: 'application/pdf',
      width: 300,
      height: 200,
    },
    previews: [],
  };
  const resizer = new Resizer({
    storage,
    media: mediaOf(doc),
    config: withPdf(),
    logger: silent,
  });
  const missing = (err: unknown) =>
    err instanceof ResizeSetupError &&
    err.code === 'RESIZE_DECODER_MISSING' &&
    err.retryable === true &&
    err.cause !== undefined;
  await assert.rejects(
    resizer.generate({
      media: doc,
      sizes: [{ width: 150, height: 100 }],
      formats: ['webp'],
    }),
    missing,
  );
  await assert.rejects(processTask(pdfTask()), missing);
  assert.equal(files.size, 1, 'nothing was stored');
});

test('a decoder for a built-in format is chosen before the built-in one', async () => {
  const builtIn = new SharpDecoder();
  const boxes: DecodeBox[] = [];
  const ownPng: SourceDecoder = {
    formats: ['png'],
    async inspect(bytes, limits) {
      const info = await builtIn.inspect(bytes, limits);
      if (info.format !== 'png') {
        throw new ResizeMediaError('not png', {
          code: 'RESIZE_SOURCE_FORMAT_UNSUPPORTED',
          retryable: false,
        });
      }
      return info;
    },
    async render(bytes, box, opts) {
      boxes.push(box);
      return builtIn.render(bytes, box, opts);
    },
  };
  const png = await sharp({
    create: { width: 64, height: 48, channels: 3, background: '#00f' },
  })
    .png()
    .toBuffer();
  const { storage, files } = memoryStorage();
  files.set('originals/a.png', png);
  const doc: MediaLike = {
    id: 'm1',
    original: { storageRef: { key: 'originals/a.png' }, format: 'png' },
    previews: [],
  };
  const resizer = new Resizer({
    storage,
    media: mediaOf(doc),
    config: makeImageConfig(),
    logger: silent,
    decoders: [ownPng],
  });
  const { created } = await resizer.generate({
    media: doc,
    sizes: [{ width: 16, height: 16 }],
    formats: ['webp'],
  });
  assert.equal(created.length, 1);
  assert.equal(boxes.length, 1, 'the host decoder rendered the stored png');
});

test('decoders that are not decoders are RESIZE_DECODER_INVALID at construction, and the name stays free', () => {
  const opts = (): ResizerOptions => ({
    storage: memoryStorage().storage,
    media: fakeMedia(),
    logger: silent,
  });
  for (const decoders of [
    [{ formats: ['pdf'] }],
    [{ formats: [], inspect() {}, render() {} }],
    null,
    'pdf',
  ]) {
    assert.throws(
      () => new Resizer({ ...opts(), decoders: decoders as never }),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_DECODER_INVALID',
    );
  }
  // No rejected construction claimed the name.
  assert.equal(new Resizer(opts()).name, 'default');
});

test("verify() runs each decoder's verify()", async () => {
  const boom = new ResizeSetupError('the pdf engine is missing', {
    code: 'TEST_PDF_ENGINE_MISSING',
  });
  let verified = 0;
  const pdf = new TestPdfDecoder();
  const resizer = new Resizer({
    storage: memoryStorage().storage,
    media: fakeMedia(),
    logger: silent,
    decoders: [
      Object.assign(pdf, {
        verify: async () => {
          verified += 1;
          throw boom;
        },
      }),
    ],
  });
  await assert.rejects(resizer.verify(), (err: unknown) => err === boom);
  assert.equal(verified, 1);
});

test('uploadOriginal asks a host decoder for a built-in format before the built-in one', async () => {
  const builtIn = new SharpDecoder();
  let asked = 0;
  const ownPng: SourceDecoder = {
    formats: ['png'],
    async inspect(bytes, limits) {
      asked += 1;
      const info = await builtIn.inspect(bytes, limits);
      return { ...info, contentType: 'image/x-test-png' };
    },
    render: (bytes, box, opts) => builtIn.render(bytes, box, opts),
  };
  const png = await sharp({
    create: { width: 8, height: 6, channels: 3, background: '#0f0' },
  })
    .png()
    .toBuffer();
  const resizer = new Resizer({
    storage: memoryStorage().storage,
    media: fakeMedia(),
    config: makeImageConfig(),
    logger: silent,
    decoders: [ownPng],
  });
  const original = await resizer.uploadOriginal({
    body: png,
    visibility: 'private',
  });
  assert.equal(asked, 1);
  assert.equal(original.contentType, 'image/x-test-png');
  assert.equal(original.format, 'png');
});

test("verify() runs the decoders' verify() after the media store's and the lock store's", async () => {
  const order: string[] = [];
  const pdf = new TestPdfDecoder();
  const resizer = new Resizer({
    storage: memoryStorage().storage,
    media: Object.assign(fakeMedia(), {
      verify: async () => void order.push('media'),
    }),
    locks: {
      acquire: async () => true,
      extend: async () => true,
      release: async () => true,
      verify: async () => void order.push('locks'),
    },
    logger: silent,
    decoders: [
      Object.assign(pdf, { verify: async () => void order.push('decoder') }),
    ],
  });
  await resizer.verify();
  assert.deepEqual(order, ['media', 'locks', 'decoder']);
});
