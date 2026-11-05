// The `engine` option: its shape at construction, and what `verify()` asks of it.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import sharp from 'sharp';
import { Catalog } from './catalog.ts';
import type { ImageEngine } from './contracts/engine.ts';
import { createEngine } from './engineCheck.ts';
import { SharpEngine } from './engines/sharp.ts';
import type { ResizeError } from './errors.ts';
import {
  Resizer,
  type ResizerOptions,
  resetResizerForTests,
} from './resizer.ts';
import { fakeMedia, memoryStorage } from './testHelpers/fakes.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import type {
  DeepPartial,
  MediaLike,
  Preview,
  ResizeConfig,
} from './types.d.ts';

afterEach(resetResizerForTests);

const silent = { info() {}, warn() {}, error() {} };
const engineOf = (over: Partial<ImageEngine> = {}): ImageEngine => ({
  id: 'test',
  formats: ['jpeg', 'webp', 'avif'],
  animatedFormats: [],
  resize: async (frame) => frame,
  encode: async () => {
    throw new Error('not used');
  },
  ...over,
});
const resizerWith = (engine: unknown, config: DeepPartial<ResizeConfig> = {}) =>
  new Resizer({
    storage: memoryStorage().storage,
    media: fakeMedia(),
    config: makeImageConfig(config),
    logger: silent,
    engine: engine as ResizerOptions['engine'],
  });

test('an engine of the wrong shape is RESIZE_ENGINE_INVALID at construction, and the name stays free', () => {
  const invalid = [
    null,
    'sharp',
    {},
    engineOf({ id: '' }),
    engineOf({ id: 1 as never }),
    engineOf({ formats: [] }),
    engineOf({ formats: 'webp' as never }),
    engineOf({ formats: [''] }),
    engineOf({ animatedFormats: undefined as never }),
    engineOf({ resize: undefined as never }),
    engineOf({ encode: 'x' as never }),
    engineOf({ verify: 'x' as never }),
  ];
  for (const value of invalid) {
    assert.throws(
      () => resizerWith(value),
      { code: 'RESIZE_ENGINE_INVALID' },
      JSON.stringify(value),
    );
  }
  assert.ok(resizerWith(engineOf()));
});

test('only undefined means the default', () => {
  assert.ok(createEngine(undefined) instanceof SharpEngine);
  const given = engineOf({ animatedFormats: ['webp'], verify: () => {} });
  assert.equal(createEngine(given), given);
});

test("verify() runs the engine's own verify after the decoders', and passes its failure on", async () => {
  const order: string[] = [];
  const boom = new Error('no licence');
  const notUsed = async () => {
    throw new Error('not used');
  };
  const resizer = new Resizer({
    storage: memoryStorage().storage,
    media: fakeMedia(),
    config: makeImageConfig(),
    logger: silent,
    decoders: [
      {
        formats: ['pdf'],
        inspect: notUsed,
        render: notUsed,
        verify: () => {
          order.push('decoder');
        },
      },
    ],
    engine: engineOf({
      verify: () => {
        order.push('engine');
        throw boom;
      },
    }),
  });
  await assert.rejects(resizer.verify(), boom);
  assert.deepEqual(order, ['decoder', 'engine']);
});

test('verify() refuses a configured format the engine does not write, naming all three', async () => {
  await assert.rejects(
    resizerWith(engineOf({ formats: ['jpeg', 'webp'] })).verify(),
    (err: ResizeError) => {
      assert.equal(err.code, 'RESIZE_ENGINE_FORMAT_UNSUPPORTED');
      assert.equal(err.retryable, true);
      assert.equal(
        err.message,
        "resize: Resizer 'default' configures formats [avif] that engine 'test' does not write — it writes [jpeg, webp]",
      );
      return true;
    },
  );
});

test('an encode.formats key counts, even when no call requests it', async () => {
  // The default encode.formats also holds jpeg and avif.
  await assert.rejects(
    resizerWith(engineOf({ formats: ['webp'] }), {
      formats: ['webp'],
    }).verify(),
    /configures formats \[jpeg, avif\]/,
  );
});

test('SharpEngine refuses what it cannot write here, and an id in another case', async () => {
  for (const id of ['JPG', 'no-such-format']) {
    resetResizerForTests();
    const config = { formats: [id], encode: { formats: { [id]: {} } } };
    await assert.rejects(
      resizerWith(undefined, config).verify(),
      { code: 'RESIZE_ENGINE_FORMAT_UNSUPPORTED' },
      id,
    );
  }
});

test('a jpg id is flattened only when encode.flatten.formats names it', async () => {
  const body = await sharp({
    create: {
      width: 64,
      height: 48,
      channels: 4,
      background: { r: 200, g: 30, b: 90, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
  const firstPixel = async (flatten: string[]) => {
    resetResizerForTests();
    const { storage, files } = memoryStorage();
    const doc: MediaLike = { id: 'm1', previews: [] };
    const resizer = new Resizer({
      storage,
      media: fakeMedia({
        load: async () => doc,
        appendPreviews: async (_id: string, rows: Preview[]) => rows,
      }),
      config: makeImageConfig({
        formats: ['jpg'],
        encode: {
          formats: { jpg: {} },
          flatten: { formats: flatten, background: '#ffffff' },
        },
      }),
      logger: silent,
    });
    doc.original = await resizer.uploadOriginal({
      body,
      visibility: 'private',
    });
    const {
      created: [row],
    } = await resizer.generate({ media: doc, sizes: [{ width: 32 }] });
    const { key } = row.storageRef as { key: string };
    return [...(await sharp(files.get(key)).raw().toBuffer()).subarray(0, 3)];
  };
  assert.deepEqual(await firstPixel(['jpeg']), [0, 0, 0]);
  assert.deepEqual(await firstPixel(['jpg']), [255, 255, 255]);
});

test("a host with formats: ['jpg'] passes verify() and keeps its row format and signature", async () => {
  const config = makeImageConfig({
    formats: ['jpg'],
    encode: { formats: { jpg: { quality: 80 } } },
  });
  const { storage, files } = memoryStorage();
  const doc: MediaLike = { id: 'm1', previews: [] };
  const resizer = new Resizer({
    storage,
    media: fakeMedia({
      load: async () => doc,
      appendPreviews: async (_id: string, rows: Preview[]) => rows,
    }),
    config,
    logger: silent,
  });
  await resizer.verify();
  const body = await sharp({
    create: { width: 64, height: 48, channels: 3, background: '#336699' },
  })
    .png()
    .toBuffer();
  doc.original = await resizer.uploadOriginal({ body, visibility: 'private' });
  const { created, failed } = await resizer.generate({
    media: doc,
    sizes: [{ width: 32 }],
  });
  assert.equal(failed, 0);
  const [row] = created;
  assert.equal(row.format, 'jpg');
  assert.equal(
    row.encodeSig,
    new Catalog({ config }).encodeSig('default', 'jpg', false),
  );
  const { key } = row.storageRef as { key: string };
  assert.match(key, /\.jpeg$/);
  assert.equal((await sharp(files.get(key)).metadata()).format, 'jpeg');
});
