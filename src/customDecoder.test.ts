// A host's own decoders, through `new Resizer({ decoders })`: a test-only PDF decoder stores and
// renders a source kind the package does not ship, eager and queued, with no core change; its
// originals stay private unless it says otherwise; a host decoder for a built-in format is asked
// first; an invalid list fails at construction; and `verify()` runs each decoder's own check.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import sharp from 'sharp';
import defaultResizeConfig from './config/resize.ts';
import type { DecodeBox, SourceDecoder } from './contracts/decoder.ts';
import type { LeasedTask } from './contracts/taskQueue.ts';
import { SharpDecoder } from './decoders/sharp.ts';
import {
  ResizeMediaError,
  ResizeOriginalError,
  ResizeSetupError,
} from './errors.ts';
import {
  Resizer,
  type ResizerOptions,
  resetResizerForTests,
} from './resizer.ts';
import { fakeMedia, memoryStorage } from './testHelpers/fakes.ts';
import { fakePdf, TestPdfDecoder } from './testHelpers/pdfDecoder.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import type { MediaLike, Preview } from './types.d.ts';
import { processTask } from './worker.ts';

const silent = { info() {}, warn() {}, error() {} };
const RED: [number, number, number] = [200, 30, 30];

afterEach(resetResizerForTests);

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

/** Storage in memory that reads every ref as public and records the visibility of each upload. */
function recordedStorage() {
  const { storage, files } = memoryStorage();
  const { upload } = storage;
  const visibilities: string[] = [];
  storage.upload = (args) => {
    visibilities.push(args.visibility);
    return upload(args);
  };
  return { storage, files, visibilities };
}

class PublicPdfDecoder extends TestPdfDecoder {
  readonly publicOriginals = true;
}

test("a host decoder's original is private unless the decoder sets publicOriginals", async () => {
  const body = fakePdf(30, 20, RED);
  const { storage, files, visibilities } = recordedStorage();
  const resizerWith = (decoder: SourceDecoder, name: string) =>
    new Resizer({
      name,
      storage,
      media: fakeMedia(),
      config: withPdf(),
      logger: silent,
      decoders: [decoder],
    });
  const closed = resizerWith(new TestPdfDecoder(), 'closed');
  await assert.rejects(
    closed.uploadOriginal({ body, visibility: 'public' }),
    (err: ResizeOriginalError) => {
      assert.ok(err instanceof ResizeOriginalError);
      assert.equal(err.code, 'RESIZE_ORIGINAL_PUBLIC_REFUSED');
      assert.equal(err.retryable, false);
      assert.equal(
        err.message,
        "resize uploadOriginal: format 'pdf' is stored privately unless its decoder sets publicOriginals: true — pass visibility: 'private', or set publicOriginals on the decoder",
      );
      return true;
    },
  );
  assert.equal(files.size, 0, 'nothing was stored');

  const stored = await closed.uploadOriginal({ body, visibility: 'private' });
  assert.equal(stored.format, 'pdf');
  assert.deepEqual(visibilities, ['private']);

  const open = resizerWith(new PublicPdfDecoder(), 'open');
  await open.uploadOriginal({ body, visibility: 'public' });
  assert.deepEqual(visibilities, ['private', 'public']);
  assert.equal(files.size, 2);
});

test('a host decoder that takes over jpeg needs the flag too', async () => {
  const builtIn = new SharpDecoder();
  const body = await sharp({
    create: { width: 8, height: 6, channels: 3, background: '#0f0' },
  })
    .jpeg()
    .toBuffer();
  const ownJpeg = (over: Partial<SourceDecoder> = {}): SourceDecoder => ({
    formats: ['jpeg'],
    inspect: (bytes, limits) => builtIn.inspect(bytes, limits),
    render: (bytes, box, opts) => builtIn.render(bytes, box, opts),
    ...over,
  });
  const { storage, files } = recordedStorage();
  await assert.rejects(
    new Resizer({
      name: 'closed',
      storage,
      media: fakeMedia(),
      config: makeImageConfig(),
      logger: silent,
      decoders: [ownJpeg()],
    }).uploadOriginal({ body, visibility: 'public' }),
    { code: 'RESIZE_ORIGINAL_PUBLIC_REFUSED', retryable: false },
  );
  assert.equal(files.size, 0);
  // Only `true` opens it, not a value that merely reads as true.
  await assert.rejects(
    new Resizer({
      name: 'truthy',
      storage,
      media: fakeMedia(),
      config: makeImageConfig(),
      logger: silent,
      decoders: [ownJpeg({ publicOriginals: 1 as never })],
    }).uploadOriginal({ body, visibility: 'public' }),
    { code: 'RESIZE_ORIGINAL_PUBLIC_REFUSED' },
  );
  assert.equal(files.size, 0);
  const stored = await new Resizer({
    name: 'open',
    storage,
    media: fakeMedia(),
    config: makeImageConfig(),
    logger: silent,
    decoders: [ownJpeg({ publicOriginals: true })],
  }).uploadOriginal({ body, visibility: 'public' });
  assert.equal(stored.format, 'jpeg');
  assert.equal(files.size, 1);
});

test('a host decoder listing svg stays refused, even with the flag', async () => {
  const { storage, files } = recordedStorage();
  const ownSvg: SourceDecoder = {
    formats: ['svg'],
    publicOriginals: true,
    inspect: async () => ({
      format: 'svg',
      contentType: 'image/svg+xml',
      width: 4,
      height: 3,
    }),
    render: async () => {
      throw new Error('an SVG must not render at upload');
    },
  };
  await assert.rejects(
    new Resizer({
      storage,
      media: fakeMedia(),
      config: makeImageConfig(),
      logger: silent,
      decoders: [ownSvg],
    }).uploadOriginal({ body: Buffer.from('<svg/>'), visibility: 'public' }),
    { code: 'RESIZE_ORIGINAL_SVG_PUBLIC', retryable: false },
  );
  assert.equal(files.size, 0);
});

test('a public object read by a decoder without the flag is refused at adoption, and adopted with it', async () => {
  const body = fakePdf(30, 20, RED);
  const { storage, files } = recordedStorage();
  files.set('legacy/a.pdf', body);
  const storageRef = { key: 'legacy/a.pdf' };
  // `upload.formats` has no pdf: adoption does not read it.
  const resizerWith = (decoder: SourceDecoder, name: string) =>
    new Resizer({
      name,
      storage,
      media: fakeMedia(),
      config: makeImageConfig(),
      logger: silent,
      decoders: [decoder],
    });
  await assert.rejects(
    resizerWith(new TestPdfDecoder(), 'closed').adoptOriginal({ storageRef }),
    (err: ResizeOriginalError) => {
      assert.ok(err instanceof ResizeOriginalError);
      assert.equal(err.code, 'RESIZE_ORIGINAL_PUBLIC_REFUSED');
      assert.equal(err.retryable, false);
      assert.equal(
        err.message,
        "resize adoptOriginal: this 'pdf' object is public, and its decoder does not set publicOriginals: true — move it to private storage, or set publicOriginals on the decoder",
      );
      return true;
    },
  );
  const original = await resizerWith(
    new PublicPdfDecoder(),
    'open',
  ).adoptOriginal({ storageRef });
  assert.deepEqual(original, {
    storageRef,
    format: 'pdf',
    contentType: 'application/pdf',
    size: body.byteLength,
    width: 30,
    height: 20,
  });
  assert.equal(files.size, 1, 'adoption stored nothing');
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
