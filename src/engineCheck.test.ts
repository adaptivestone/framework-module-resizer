// The `engine` option: its shape at construction, and what `verify()` asks of it.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import sharp from 'sharp';
import { Catalog } from './catalog.ts';
import type { Raster } from './contracts/decoder.ts';
import type {
  EncodeRequest,
  EngineCallOptions,
  ImageEngine,
} from './contracts/engine.ts';
import { createEngine } from './engineCheck.ts';
import { SharpEngine } from './engines/sharp.ts';
import { ResizeConfigError, type ResizeError } from './errors.ts';
import {
  Resizer,
  type ResizerOptions,
  resetResizerForTests,
} from './resizer.ts';
import { encodeSignature } from './signatures.ts';
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
        "resize: Resizer 'default' has [avif] in `formats` or `encode.formats`, which engine 'test' does not write — it writes [jpeg, webp]",
      );
      return true;
    },
  );
});

const HEIF_IDS = ['heif', 'heic', 'avif'];
/** SharpEngine on a build without HEIF: it lists no HEIF id, and Sharp refuses them at render. */
class NoHeifEngine extends SharpEngine {
  readonly formats = new SharpEngine().formats.filter(
    (id) => !HEIF_IDS.includes(id),
  );
  encode(raster: Raster, req: EncodeRequest, opts: EngineCallOptions) {
    if (HEIF_IDS.includes(req.format)) {
      throw new Error(`Unsupported output format ${req.format}`);
    }
    return super.encode(raster, req, opts);
  }
}

test('a default entry the host left alone and does not generate is not checked', async () => {
  // A build without HEIF, with the default `encode.formats`: it works on 0.3.0.
  await resizerWith(new NoHeifEngine(), {
    formats: ['jpeg', 'webp'],
  }).verify();
  resetResizerForTests();
  // An engine that writes webp alone: the host never wrote jpeg or avif.
  await resizerWith(engineOf({ formats: ['webp'] }), {
    formats: ['webp'],
  }).verify();
});

test('a default entry in `formats`, or one the host changed, and a host entry it does not use are still checked', async () => {
  const refused = async (config: DeepPartial<ResizeConfig>, ids: string) => {
    resetResizerForTests();
    await assert.rejects(
      resizerWith(new NoHeifEngine(), config).verify(),
      (err: ResizeError) => {
        assert.equal(err.code, 'RESIZE_ENGINE_FORMAT_UNSUPPORTED');
        assert.match(
          err.message,
          new RegExp(`has \\[${ids}\\] in \`formats\` or \`encode\\.formats\``),
        );
        return true;
      },
      ids,
    );
  };
  // The default config generates avif.
  await refused({}, 'avif');
  // The default entry, changed by the host.
  await refused(
    {
      formats: ['jpeg', 'webp'],
      encode: { formats: { avif: { quality: 1 } } },
    },
    'avif',
  );
  // A host's entry nothing generates.
  await refused(
    { formats: ['jpeg', 'webp'], encode: { formats: { jxl: {} } } },
    'jxl',
  );
});

test('a per-call format with a default entry passes verify() and fails at render, as on 0.3.0', async () => {
  const { storage } = memoryStorage();
  const doc: MediaLike = { id: 'm1', previews: [] };
  const resizer = new Resizer({
    storage,
    media: fakeMedia({
      load: async () => doc,
      appendPreviews: async (_id: string, rows: Preview[]) => rows,
    }),
    config: makeImageConfig({ formats: ['webp'] }),
    logger: silent,
    engine: new NoHeifEngine(),
  });
  await resizer.verify();
  const body = await sharp({
    create: { width: 64, height: 48, channels: 3, background: '#336699' },
  })
    .png()
    .toBuffer();
  doc.original = await resizer.uploadOriginal({ body, visibility: 'private' });
  await assert.rejects(
    resizer.generate({
      media: doc,
      sizes: [{ width: 32 }],
      formats: ['avif'],
    }),
    (err: ResizeError) => {
      assert.equal(err.code, 'RESIZE_GENERATE_FAILED');
      assert.match(
        String((err.cause as Error).message),
        /Unsupported output format avif/,
      );
      return true;
    },
  );
});

test('only verify() compares the list: a format the list does not name renders without it', async () => {
  // `JPG` works through Sharp, which lower-cases it, and verify() refuses it (above).
  const { storage, files } = memoryStorage();
  const doc: MediaLike = { id: 'm1', previews: [] };
  const resizer = new Resizer({
    storage,
    media: fakeMedia({
      load: async () => doc,
      appendPreviews: async (_id: string, rows: Preview[]) => rows,
    }),
    config: makeImageConfig({
      formats: ['JPG'],
      encode: { formats: { JPG: {} } },
    }),
    logger: silent,
  });
  const body = await sharp({
    create: { width: 64, height: 48, channels: 3, background: '#336699' },
  })
    .png()
    .toBuffer();
  doc.original = await resizer.uploadOriginal({ body, visibility: 'private' });
  const {
    created: [row],
  } = await resizer.generate({ media: doc, sizes: [{ width: 32 }] });
  assert.equal(row.format, 'JPG');
  const { key } = row.storageRef as { key: string };
  assert.equal((await sharp(files.get(key)).metadata()).format, 'jpeg');
});

test('a subclass of SharpEngine can name itself', async () => {
  class TunedSharp extends SharpEngine {
    readonly id = 'tuned-sharp';
  }
  await assert.rejects(
    resizerWith(new TunedSharp(), {
      formats: ['jxl'],
      encode: { formats: { jxl: {} } },
    }).verify(),
    /engine 'tuned-sharp' does not write/,
  );
});

test('the refusal of a bad engine names `verify` too', () => {
  assert.throws(
    () => resizerWith(engineOf({ verify: 'x' as never })),
    (err: ResizeError) => {
      assert.equal(err.code, 'RESIZE_ENGINE_INVALID');
      assert.match(err.message, /`verify`, when given, must be a function/);
      return true;
    },
  );
});

for (const option of ['engine', 'decoders']) {
  test(`a \`${option}\` key in a config is refused, naming the option`, () => {
    assert.throws(
      () =>
        new Resizer({
          storage: memoryStorage().storage,
          media: fakeMedia(),
          config: { ...makeImageConfig(), [option]: [] } as ResizeConfig,
          logger: silent,
        }),
      (err: ResizeError) => {
        assert.ok(err instanceof ResizeConfigError);
        assert.equal(err.code, 'RESIZE_CONFIG_INVALID');
        assert.ok(err.message.includes(`\`${option}\` is not a config key`));
        assert.ok(err.message.includes(`new Resizer({ ${option} })`));
        return true;
      },
    );
  });
}

test('a format with no encode.formats entry points to jpeg first, and to what a jpg entry needs', () => {
  assert.throws(
    () => resizerWith(undefined, { formats: ['jpg'] }),
    (err: ResizeError) => {
      assert.equal(err.code, 'RESIZE_CONFIG_FORMATS_INVALID');
      assert.equal(
        err.message,
        "resize config: formats [jpg] have no encode.formats entry — use an id it already has, such as 'jpeg', or add one ({} keeps the engine's defaults); a 'jpg' entry also needs encode.flatten.formats to name it, or transparent pixels turn black",
      );
      return true;
    },
  );
});

test('naming jpg in the flatten list changes its signature, so its previews regenerate', () => {
  const signature = (flatten: string[]) =>
    encodeSignature(
      makeImageConfig({
        formats: ['jpg'],
        encode: {
          formats: { jpg: {} },
          flatten: { formats: flatten, background: '#ffffff' },
        },
      }),
      { format: 'jpg', fit: false },
    );
  assert.notEqual(signature(['jpeg']), signature(['jpg']));
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
