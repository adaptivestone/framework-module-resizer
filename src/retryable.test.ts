// What `retryable` says for every error code, in one audited table. `false` means no later delivery
// of the same input can succeed, where a later delivery includes one after a rolling deploy reaches
// this worker; unclear cases stay `true`. Each row triggers its error through real code, so a changed
// site fails here, and a new code must be placed in one of the three lists below.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import sharp from 'sharp';
import defaultResizeConfig from './config/resize.ts';
import type { SourceDecoder } from './contracts/decoder.ts';
import type { ResizeStorage } from './contracts/storage.ts';
import { createDecoderSet, DecoderSet } from './decoderSet.ts';
import { SharpDecoder } from './decoders/sharp.ts';
import { SvgDecoder } from './decoders/svg.ts';
import { LocalFsStorage } from './drivers/fs.ts';
import { S3Storage } from './drivers/s3.ts';
import { RESIZE_ERROR_CODES } from './errorCodes.ts';
import {
  ResizeConfigError,
  ResizeError,
  ResizeGenerateError,
  ResizeMediaError,
  ResizeSecurityError,
  ResizeSetupError,
  ResizeStorageError,
} from './errors.ts';
import { importDriver } from './helpers/peers.ts';
import { getSizeKey, requireMediaId } from './images.ts';
import { validateResizeConfig } from './resizeConfig.ts';
import { Resizer, resetResizerForTests } from './resizer.ts';
import { errorTableRows } from './testHelpers/errorTable.ts';
import {
  asS3Client,
  fakeMedia,
  memoryStorage,
  silentLogger,
} from './testHelpers/fakes.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import type { DeepPartial, MediaLike, ResizeConfig } from './types.d.ts';
import { Uploader } from './uploader.ts';
import { runWorker } from './worker.ts';

const limits = defaultResizeConfig.limits;
const png = await sharp({
  create: {
    width: 64,
    height: 64,
    channels: 3,
    background: 'red',
    noise: { type: 'gaussian', mean: 128, sigma: 30 },
  },
})
  .png()
  .toBuffer();
const jpeg = await sharp(png).jpeg().toBuffer();
const cutJpeg = jpeg.subarray(0, jpeg.length >> 1); // passes inspect, fails at render
const svg = (attrs: string) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"${attrs}/>`);
const pdfInfo = {
  format: 'pdf',
  contentType: 'application/pdf',
  width: 4,
  height: 4,
};
const decoder = (over = {}) =>
  ({
    formats: ['pdf'],
    inspect: async () => pdfInfo,
    render: async () => {
      throw new Error('render failed');
    },
    ...over,
  }) as unknown as SourceDecoder;
const rejectingWith = (code: string) =>
  decoder({
    inspect: async () => {
      throw new ResizeMediaError('no', { code, retryable: false });
    },
  });
const refusing = rejectingWith('RESIZE_SOURCE_FORMAT_UNSUPPORTED');
const crashing = decoder({
  inspect: async () => {
    throw new Error('crash');
  },
});
const uploader = (
  decoders: DecoderSet,
  {
    config = {},
    storage = memoryStorage().storage,
  }: { config?: DeepPartial<ResizeConfig>; storage?: unknown } = {},
) =>
  new Uploader({
    storage: storage as ResizeStorage,
    decoders,
    config: makeImageConfig(config),
  });
const upload = (
  body: unknown,
  {
    visibility = 'private',
    ...opts
  }: {
    visibility?: string;
    config?: DeepPartial<ResizeConfig>;
    storage?: unknown;
  } = {},
) => uploader(createDecoderSet(), opts).upload({ body, visibility } as never);
const uploadThrough = (
  one: SourceDecoder,
  config?: DeepPartial<ResizeConfig>,
) =>
  uploader(new DecoderSet([one]), { config }).upload({
    body: png,
    visibility: 'private',
  });
let names = 0;
const generate = async (input = {}, parts = {}) => {
  const { storage } = memoryStorage();
  const storageRef = await storage.upload({
    key: 'k',
    body: png,
    contentType: 'image/png',
    visibility: 'private',
  });
  return new Resizer({
    name: `r${++names}`,
    logger: silentLogger,
    storage,
    media: fakeMedia(),
    ...parts,
  }).generate({
    media: {
      id: 'm',
      original: { storageRef, format: 'png', width: 64, height: 64 },
    },
    sizes: [{ width: 2 }],
    ...input,
  });
};
// fs: a root with a symlink out of it. s3: a client that answers nothing.
const root = await mkdtemp(join(tmpdir(), 'retryable-'));
const outside = await mkdtemp(join(tmpdir(), 'retryable-out-'));
after(async () => {
  resetResizerForTests();
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});
await writeFile(join(outside, 'file'), 'x');
await symlink(join(outside, 'file'), join(root, 'link'));
const fs = new LocalFsStorage({ rootDir: root, publicBaseUrl: '/m' });
const client = asS3Client({ send: async () => ({}) });
const s3 = new S3Storage({
  bucketPublic: 'pub',
  bucketPrivate: 'priv',
  client,
});
const put = {
  key: 'k',
  body: png,
  contentType: 'image/png',
  visibility: 'public' as const,
};
// A variable, so tsc does not try to resolve it.
const notAPackage = 'a-package-that-is-not-there';

const rows: [code: string, retryable: boolean, trigger: () => unknown][] = [
  // The class defaults.
  [
    'RESIZE_ERROR',
    true,
    () => {
      throw new ResizeError('m');
    },
  ],
  [
    'RESIZE_SETUP',
    true,
    () => {
      throw new ResizeSetupError('m');
    },
  ],
  [
    'RESIZE_MEDIA',
    true,
    () => {
      throw new ResizeMediaError('m');
    },
  ],
  [
    'RESIZE_STORAGE',
    true,
    () => {
      throw new ResizeStorageError('m');
    },
  ],
  [
    'RESIZE_CONFIG',
    false,
    () => {
      throw new ResizeConfigError('m');
    },
  ],
  [
    'RESIZE_SECURITY',
    false,
    () => {
      throw new ResizeSecurityError('m');
    },
  ],
  // false only when every variant failed with false: processor.test.ts.
  [
    'RESIZE_GENERATE_FAILED',
    true,
    () => {
      throw new ResizeGenerateError({ mediaId: 'm', failed: 1, requested: 1 });
    },
  ],
  [
    'RESIZE_CONFIG_INVALID',
    false,
    () =>
      validateResizeConfig(
        makeImageConfig({ limits: { failOn: 'x' } } as never),
      ),
  ],
  // A task or generate(), false: no later delivery of the same input can succeed.
  ['RESIZE_NO_ORIGINAL', false, () => generate({ media: { id: 'm' } })],
  ['RESIZE_MEDIA_NO_ID', false, () => requireMediaId({} as MediaLike)],
  ['RESIZE_SIZE_INVALID', false, () => getSizeKey({})],
  [
    'RESIZE_SOURCE_DAMAGED',
    false,
    () =>
      new SharpDecoder().render(
        cutJpeg,
        { width: 16, height: 16 },
        {
          limits,
          source: {
            format: 'jpeg',
            contentType: 'image/jpeg',
            width: 64,
            height: 64,
          },
          frames: 1,
        },
      ),
  ],
  [
    'RESIZE_SOURCE_TOO_LARGE',
    false,
    () => new SharpDecoder().inspect(png, { ...limits, inputPixels: 1 }),
  ],
  [
    'RESIZE_SOURCE_FORMAT_UNSUPPORTED',
    false,
    () => new DecoderSet([refusing]).identify(png, limits),
  ],
  [
    'RESIZE_SVG_DIMENSIONS_UNSUPPORTED',
    false,
    () => new SvgDecoder().inspect(svg(' width="1" height="100000"'), limits),
  ],
  // A task or generate(), true: time or a deploy can fix it.
  [
    'RESIZE_STORAGE_NOT_FOUND',
    true,
    () => fs.download({ path: 'gone', visibility: 'public' }),
  ],
  [
    'RESIZE_S3_EMPTY_BODY',
    true,
    () => s3.download({ bucket: 'pub', key: 'k' }),
  ],
  [
    'RESIZE_DECODER_MISSING',
    true,
    () => new DecoderSet([refusing]).identify(png, limits, 'tiff'),
  ],
  [
    'RESIZE_DECODER_INVALID',
    true,
    () =>
      new DecoderSet([
        decoder({ inspect: async () => ({ format: 'pdf' }) }),
      ]).identify(png, limits),
  ],
  ['RESIZE_PIPELINE_UNKNOWN', true, () => generate({ pipeline: 'nope' })],
  ['RESIZE_FORMAT_NOT_CONFIGURED', true, () => generate({ formats: ['jpg'] })],
  [
    'RESIZE_PEER_MISSING',
    true,
    () =>
      importDriver(() => import(notAPackage), 'test', [notAPackage], 'a test'),
  ],
  [
    'RESIZE_NO_RESIZER',
    true,
    () => runWorker({ resizers: [], signal: AbortSignal.abort() }),
  ],
  [
    'RESIZE_SOURCE_DECODE_FAILED',
    true,
    () =>
      generate(
        {},
        {
          decoders: [
            decoder({
              formats: ['png'],
              inspect: async () => ({
                ...pdfInfo,
                format: 'png',
                contentType: 'image/png',
              }),
            }),
          ],
        },
      ),
  ],
  [
    'RESIZE_SVG_RENDER_FAILED',
    true,
    () =>
      new SvgDecoder().render(
        svg(' width="4" height="4"'),
        { width: 4, height: 4 },
        {
          limits,
          source: {
            format: 'svg',
            contentType: 'image/svg+xml',
            width: 4,
            height: 4,
          },
          frames: 1,
          signal: AbortSignal.abort(),
        },
      ),
  ],
  // A download or an upload the driver refuses, false: ResizeSecurityError's default, and no driver
  // overrides it.
  [
    'RESIZE_FS_HINT_CONFLICT',
    false,
    () => fs.upload({ ...put, namespace: 'n', parentRef: {} }),
  ],
  [
    'RESIZE_FS_PATH_TRAVERSAL',
    false,
    () => fs.download({ path: 'link', visibility: 'public' }),
  ],
  [
    'RESIZE_FS_PRIVATE_URL',
    false,
    () => fs.publicUrl({ path: 'k', visibility: 'private' }),
  ],
  ['RESIZE_FS_REF_INVALID', false, () => fs.download(null as never)],
  [
    'RESIZE_FS_VISIBILITY_INVALID',
    false,
    () => fs.upload({ ...put, visibility: 'x' as never }),
  ],
  ['RESIZE_STORAGE_KEY_INVALID', false, () => fs.upload({ ...put, key: '..' })],
  [
    'RESIZE_STORAGE_NAMESPACE_INVALID',
    false,
    () => fs.upload({ ...put, namespace: '..' }),
  ],
  [
    'RESIZE_S3_BUCKET_NOT_ALLOWED',
    false,
    () => s3.download({ bucket: 'other', key: 'k' }),
  ],
  [
    'RESIZE_S3_HINT_CONFLICT',
    false,
    () => s3.upload({ ...put, namespace: 'n', parentRef: {} }),
  ],
  [
    'RESIZE_S3_KEY_TOO_LONG',
    false,
    () => s3.upload({ ...put, key: 'k'.repeat(1025) }),
  ],
  [
    'RESIZE_S3_PRIVATE_BUCKET_REQUIRED',
    false,
    () =>
      new S3Storage({ bucketPublic: 'pub', client }).upload({
        ...put,
        visibility: 'private',
      }),
  ],
  [
    'RESIZE_S3_PRIVATE_ORIGINAL_PUBLIC_URL',
    false,
    () => s3.publicUrl({ bucket: 'priv', key: 'k' }),
  ],
  ['RESIZE_S3_REF_INVALID', false, () => s3.download(null as never)],
  [
    'RESIZE_S3_VISIBILITY_INVALID',
    false,
    () => s3.upload({ ...put, visibility: 'x' as never }),
  ],
  // An upload, false: malformed input and every policy refusal.
  ['RESIZE_ORIGINAL_BODY_INVALID', false, () => upload('text')],
  [
    'RESIZE_ORIGINAL_VISIBILITY_INVALID',
    false,
    () => upload(png, { visibility: 'x' }),
  ],
  ['RESIZE_ORIGINAL_EMPTY', false, () => upload(Buffer.alloc(0))],
  [
    'RESIZE_ORIGINAL_TOO_LARGE',
    false,
    () => upload(png, { config: { upload: { maxBytes: 1 } } }),
  ],
  ['RESIZE_ORIGINAL_INVALID', false, () => upload(Buffer.from('text'))],
  [
    'RESIZE_ORIGINAL_FORMAT_DISABLED',
    false,
    () => upload(png, { config: { upload: { formats: ['jpeg'] } } }),
  ],
  ['RESIZE_ORIGINAL_FORMAT_UNSUPPORTED', false, () => uploadThrough(refusing)],
  [
    'RESIZE_ORIGINAL_METADATA_MISSING',
    false,
    () => uploadThrough(rejectingWith('RESIZE_SOURCE_METADATA_MISSING')),
  ],
  [
    'RESIZE_ORIGINAL_SVG_PUBLIC',
    false,
    () => upload(svg(' width="4" height="4"'), { visibility: 'public' }),
  ],
  [
    'RESIZE_ORIGINAL_TOO_MANY_PIXELS',
    false,
    () => upload(png, { config: { limits: { sourcePixels: 1 } } }),
  ],
  [
    'RESIZE_ORIGINAL_DAMAGED',
    false,
    () => upload(cutJpeg, { config: { upload: { verify: 'decode' } } }),
  ],
  [
    'RESIZE_ORIGINAL_PUBLIC_REFUSED',
    false,
    () =>
      uploader(new DecoderSet([decoder()]), {
        config: { upload: { formats: ['pdf'] } },
      }).upload({ body: png, visibility: 'public' }),
  ],
  // An upload, true: the bytes may be fine.
  ['RESIZE_ORIGINAL_INSPECT_FAILED', true, () => uploadThrough(crashing)],
  [
    'RESIZE_ORIGINAL_VERIFY_FAILED',
    true,
    () =>
      uploadThrough(decoder(), {
        upload: { verify: 'decode', formats: ['pdf'] },
      }),
  ],
  [
    'RESIZE_ORIGINAL_UPLOAD_FAILED',
    true,
    () =>
      upload(png, {
        storage: {
          upload: async () => {
            throw new Error('x');
          },
        },
      }),
  ],
  [
    'RESIZE_ADOPT_MAX_BYTES_INVALID',
    false,
    () =>
      uploader(createDecoderSet()).adopt({
        storageRef: { key: 'k' },
        maxBytes: 0,
      }),
  ],
  [
    'RESIZE_ORIGINAL_DOWNLOAD_FAILED',
    true,
    () =>
      uploader(createDecoderSet(), {
        storage: {
          download: async () => {
            throw new Error('x');
          },
        },
      }).adopt({ storageRef: { key: 'k' } }),
  ],
  [
    'RESIZE_ORIGINAL_STORAGE_REF_INVALID',
    true,
    () => upload(png, { storage: { upload: async () => null } }),
  ],
];
for (const [code, retryable, trigger] of rows) {
  test(`${code} is retryable: ${retryable}`, async () => {
    await assert.rejects(
      async () => trigger(),
      (err: ResizeError) => {
        assert.equal(err.code, code);
        assert.equal(err.retryable, retryable);
        return true;
      },
    );
  });
}

// RESIZE_ORIGINAL_UPLOAD_FAILED is `true` above, for a failure that gives no verdict. A driver's
// final refusal as its cause makes it `false`: the same upload fails the same way until the setting
// or the `namespace` changes. Each refusal comes from a shipped driver.
const refusals: [cause: string, storage: ResizeStorage, namespace?: string][] =
  [
    ['RESIZE_STORAGE_NAMESPACE_INVALID', fs, '../bad'],
    [
      'RESIZE_S3_PRIVATE_BUCKET_REQUIRED',
      new S3Storage({ bucketPublic: 'pub', client }),
    ],
    ['RESIZE_S3_KEY_TOO_LONG', s3, 'n'.repeat(1000)],
  ];
for (const [cause, storage, namespace] of refusals) {
  test(`RESIZE_ORIGINAL_UPLOAD_FAILED is retryable: false when its cause is ${cause}`, async () => {
    await assert.rejects(
      async () =>
        uploader(createDecoderSet(), { storage }).upload({
          body: png,
          visibility: 'private',
          ...(namespace === undefined ? {} : { namespace }),
        }),
      (err: ResizeError) => {
        assert.equal(err.code, 'RESIZE_ORIGINAL_UPLOAD_FAILED');
        assert.equal(err.retryable, false);
        assert.equal((err.cause as ResizeError).code, cause);
        assert.equal((err.cause as ResizeError).retryable, false);
        return true;
      },
    );
  });
}

// Reached by a task, where a real run belongs in another test file. That test asserts this value;
// here the file must at least hold the code.
const elsewhere: [code: string, retryable: boolean, file: string][] = [
  ['RESIZE_SOURCE_METADATA_MISSING', false, 'uploader.test.ts'],
  ['RESIZE_SVG_RENDER_TIMEOUT', false, 'helpers/svgRaster.test.ts'],
  ['RESIZE_TASK_MAX_ATTEMPTS', false, 'consumer.test.ts'],
  ['RESIZE_TASK_TIMEOUT', true, 'consumer.test.ts'],
  ['RESIZE_WORKER_INCOMPLETE', true, 'worker.test.ts'], // false only when every missing variant failed with false
  ['RESIZE_SVG_RENDER_UNAVAILABLE', true, 'helpers/svgRaster.test.ts'],
  ['RESIZE_PIPELINE_STEP_INVALID', true, 'processor.test.ts'],
  ['RESIZE_STORAGE_DOWNLOAD_INVALID', true, 'processor.test.ts'],
  ['RESIZE_SVG_PUBLIC_PREVIEW', true, 'processor.test.ts'], // a custom engine's output: a deploy can fix it
  ['RESIZE_ENGINE_INVALID', true, 'render.test.ts'],
  ['RESIZE_PREVIEW_STORAGE_REF_INVALID', true, 'processor.test.ts'],
  ['RESIZE_MEDIA_APPEND_RESULT_INVALID', true, 'previewRecorder.test.ts'],
  ['RESIZE_MEDIA_REPLACE_MISSING', true, 'previewRecorder.test.ts'],
  ['RESIZE_MEDIA_REPLACE_RESULT_INVALID', true, 'previewRecorder.test.ts'],
  // The one exception to "a deploy included" (design C1): a deploy that fixes the store would help,
  // but every retry until then costs a render, an upload and an orphaned file.
  ['RESIZE_MEDIA_ROW_NOT_KEPT', false, 'regenerate.test.ts'],
];
test('each code asserted elsewhere is in the test file named', () => {
  for (const [code, , file] of elsewhere) {
    assert.ok(
      readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').includes(
        code,
      ),
      `${code} in ${file}`,
    );
  }
});

// Every remaining code, written out. None can reach a task or an upload's input: each is thrown at
// construction, at first use or verify() because the wiring is wrong, at worker start, or on an
// invocation whose event is no SQS batch, or is a prewarm issue code (README table), so nothing reads
// its retryable on a task. A new code must choose.
const NOT_READ = [
  'RESIZE_APP_NOT_INITIALIZED',
  'RESIZE_CONFIG_COORDINATION_INVALID',
  'RESIZE_CONFIG_FORMATS_INVALID',
  'RESIZE_CONFIG_MEDIA_MODEL_MISSING',
  'RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN',
  'RESIZE_CONFIG_QUEUE_INVALID',
  'RESIZE_CONFIG_QUEUE_LEASE_INVALID',
  'RESIZE_CONFIG_QUEUE_UNKNOWN',
  'RESIZE_CONFIG_REMOVED_KEY',
  'RESIZE_CONFIG_STORAGE_MISSING',
  'RESIZE_CONFIG_UPLOAD_FORMATS_INVALID',
  'RESIZE_CONFIG_UPLOAD_INVALID',
  'RESIZE_CONFIG_UPLOAD_MAX_BYTES_INVALID',
  'RESIZE_DELIVERY_UNSUPPORTED',
  'RESIZE_DRIVER_CONFLICT',
  'RESIZE_DRIVER_INVALID',
  'RESIZE_DUPLICATE_RESIZER',
  'RESIZE_ENGINE_FORMAT_UNSUPPORTED',
  'RESIZE_ENQUEUE_CONFIRM_FAILED',
  'RESIZE_ENQUEUE_INTERNAL_ERROR',
  'RESIZE_ENQUEUE_LOCK_CONTENDED',
  'RESIZE_ENQUEUE_LOCK_FAILED',
  'RESIZE_ENQUEUE_NO_ORIGINAL',
  'RESIZE_ENQUEUE_NO_QUEUE',
  'RESIZE_ENQUEUE_QUEUE_FAILED',
  'RESIZE_ENQUEUE_UNCONFIRMED',
  'RESIZE_ENQUEUE_VARIANT_CONFLICT',
  'RESIZE_FS_PRIVATE_ROOT_PUBLIC',
  'RESIZE_LOCKS_REQUIRED',
  'RESIZE_MEDIA_REQUIRED',
  'RESIZE_METRICS_INVALID',
  'RESIZE_MONGO_INDEX_MISSING',
  'RESIZE_MONGO_LOCK_MODEL_OUTDATED',
  'RESIZE_MONGO_MEDIA_MODEL_OUTDATED',
  'RESIZE_MONGO_MODEL_MISSING',
  'RESIZE_MONGO_MODEL_OUTDATED',
  'RESIZE_MONGO_MODEL_REQUIRED',
  'RESIZE_MONGO_NOT_CONNECTED',
  'RESIZE_NAME_INVALID',
  'RESIZE_NOT_READY',
  'RESIZE_QUEUE_INVALID',
  'RESIZE_QUEUE_NOT_SERVED',
  'RESIZE_QUEUE_ROUTES_INVALID',
  'RESIZE_QUEUE_SHARED_RESIZER_UNLISTED',
  'RESIZE_SQS_EVENT_INVALID',
  'RESIZE_SQS_QUEUE_UNKNOWN',
  'RESIZE_SQS_QUEUE_URL_REQUIRED',
  'RESIZE_STORAGE_REQUIRED',
  'RESIZE_TASK_IN_FLIGHT',
];
test('every error code has been placed: a new code must choose', () => {
  assert.deepEqual(
    [...rows.map(([c]) => c), ...elsewhere.map(([c]) => c), ...NOT_READ].sort(),
    [...RESIZE_ERROR_CODES].sort(),
  );
});

test('the README Error codes table states what this file audits', () => {
  const stated = Object.fromEntries(
    errorTableRows(
      readFileSync(new URL('../README.md', import.meta.url), 'utf8'),
    ).map((row) => [row.code, row.retryable]),
  );
  const audited = Object.fromEntries([
    ...rows.map(([code, retryable]) => [code, `\`${retryable}\``]),
    ...elsewhere.map(([code, retryable]) => [code, `\`${retryable}\``]),
    ...NOT_READ.map((code) => [code, '—']),
  ]);
  assert.deepEqual(stated, audited);
});
