// variantSteps through the whole path: `new Resizer`, `generate()`, the stored files and rows.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import sharp, {
  type FormatEnum,
  type OutputOptions,
  type OverlayOptions,
  type Sharp,
} from 'sharp';
import type { Raster } from './contracts/decoder.ts';
import type { ImageEngine } from './contracts/engine.ts';
import type { Pipeline } from './contracts/pipeline.ts';
import { SharpEngine } from './engines/sharp.ts';
import { rasterToSharp, sharpToRaster } from './engines/sharpRaster.ts';
import { ResizeGenerateError } from './errors.ts';
import { Resizer, resetResizerForTests } from './resizer.ts';
import {
  fakeMedia,
  MemoryTaskQueue,
  memoryStorage,
} from './testHelpers/fakes.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import { workUntil } from './testHelpers/work.ts';
import type { MediaLike, Preview, ResizeLimits, SizeInput } from './types.d.ts';

afterEach(resetResizerForTests);

const silent = { info() {}, warn() {}, error() {} };

const photo = (): Promise<Buffer> =>
  sharp({
    create: { width: 200, height: 100, channels: 3, background: '#336699' },
  })
    .png()
    .toBuffer();

async function run(
  pipeline: Pipeline,
  formats = ['jpeg', 'webp'],
  body?: Buffer,
  {
    sizes = [{ width: 100, height: 50 }],
    limits = {},
    engine,
  }: {
    sizes?: SizeInput[];
    limits?: Partial<ResizeLimits>;
    engine?: ImageEngine;
  } = {},
) {
  const { storage, files } = memoryStorage();
  const warns: unknown[][] = [];
  const doc: MediaLike = { id: 'm1', previews: [] };
  const resizer = new Resizer({
    storage,
    media: fakeMedia({
      load: async () => doc,
      appendPreviews: async (_id: string, rows: Preview[]) => rows,
    }),
    config: makeImageConfig({ formats, limits }),
    logger: {
      info() {},
      warn: (...args: unknown[]) => warns.push(args),
      error() {},
    },
    pipelines: { default: pipeline },
    engine,
  });
  doc.original = await resizer.uploadOriginal({
    body: body ?? (await photo()),
    visibility: 'private',
  });
  return {
    result: resizer.generate({ media: doc, sizes, formats }),
    files,
    warns,
  };
}

test('a step reads the stored media and the source through generate()', async () => {
  const seen: unknown[][] = [];
  const { result } = await run(
    {
      variantSteps: [
        (raster, { media, source, variant }) => {
          seen.push([media.id, source.width, source.format, variant.format]);
          return raster;
        },
      ],
    },
    ['webp'],
  );
  await result;
  assert.deepEqual(seen, [['m1', 200, 'png', 'webp']]);
});

test('a step that writes in place marks each format of a size once', async () => {
  const seen: number[] = [];
  const { result } = await run({
    variantSteps: [
      (raster) => {
        seen.push(raster.data[0]);
        raster.data.fill(0);
        return raster;
      },
    ],
  });
  assert.equal((await result).created.length, 2);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], 0);
  assert.equal(seen[1], seen[0]);
});

test('an old step that calls a Sharp method fails with its plain TypeError', async () => {
  const old = (img: unknown) =>
    (img as { composite(a: unknown[]): unknown }).composite([]);
  const { result, warns } = await run({ variantSteps: [old as never] });
  await assert.rejects(
    result,
    (err: unknown) => err instanceof ResizeGenerateError,
  );
  const [message, cause] = warns[0];
  assert.match(String(message), /variant .* failed for media m1/);
  assert.ok(cause instanceof TypeError);
  assert.match(cause.message, /\.composite is not a function/);
});

test('an old step that only returns its argument keeps working', async () => {
  const { result } = await run({ variantSteps: [(img) => img] }, ['webp']);
  const { created, failed } = await result;
  assert.equal(failed, 0);
  assert.equal(created.length, 1);
});

test('a step that resizes through the helpers gives the row its size', async () => {
  const { result, files } = await run(
    {
      variantSteps: [
        async (r) =>
          sharpToRaster(rasterToSharp(r).resize(50, 40, { fit: 'fill' })),
      ],
    },
    ['webp'],
  );
  const [row] = (await result).created;
  assert.deepEqual([row.actualWidth, row.actualHeight], [50, 40]);
  const { width, height } = await sharp(
    files.get((row.storageRef as { key: string }).key),
  ).metadata();
  assert.deepEqual([width, height], [50, 40]);
});

const plain = (width: number, height: number): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();

test('a slow step through rasterToSharp is killed near the limit, and fails only its variant', async () => {
  // Without the limit this blur runs for about 7 s on the large size.
  const { result, warns } = await run(
    {
      variantSteps: [
        async (r) =>
          sharpToRaster(rasterToSharp(r).blur(r.info.width === 2000 ? 400 : 1)),
      ],
    },
    ['webp'],
    await plain(2000, 1000),
    {
      sizes: [
        { width: 2000, height: 1000 },
        { width: 100, height: 50 },
      ],
      limits: { processingTimeoutSeconds: 1 },
    },
  );
  const { created, failed } = await result;
  assert.equal(failed, 1);
  assert.deepEqual(
    created.map((row) => row.sizeKey),
    ['100x50'],
  );
  assert.equal(warns.length, 1);
  assert.match(String(warns[0][1]), /timeout/);
});

test("a chain's own shorter timeout overrides the limit", async () => {
  const { result, warns } = await run(
    {
      variantSteps: [
        async (r) =>
          sharpToRaster(rasterToSharp(r).blur(400).timeout({ seconds: 1 })),
      ],
    },
    ['webp'],
    await plain(2000, 1000),
    { sizes: [{ width: 2000, height: 1000 }] },
  );
  await assert.rejects(result);
  assert.match(String(warns[0][1]), /timeout/);
});

test("a chain's own longer timeout, a timeout of 0 and a raster spread into a new object run past the limit", async () => {
  // This blur runs for longer than the limit of 1 s.
  const chains: Record<string, (r: Raster) => Sharp> = {
    '1000x500': (r) => rasterToSharp(r).blur(500).timeout({ seconds: 30 }),
    '990x495': (r) => rasterToSharp(r).blur(500).timeout({ seconds: 0 }),
    '980x490': (r) => rasterToSharp({ ...r }).blur(500),
  };
  const { result } = await run(
    {
      variantSteps: [
        async (r, { variant }) => sharpToRaster(chains[variant.sizeKey](r)),
      ],
    },
    ['webp'],
    await plain(1000, 500),
    {
      sizes: Object.keys(chains).map((key) => {
        const [width, height] = key.split('x').map(Number);
        return { width, height };
      }),
      limits: { processingTimeoutSeconds: 1 },
    },
  );
  const { created, failed } = await result;
  assert.equal(failed, 0);
  assert.equal(created.length, 3);
});

test("a chained step's input carries the limit too", async () => {
  const { result, warns } = await run(
    {
      variantSteps: [
        async (r) => sharpToRaster(rasterToSharp(r).blur(1)),
        async (r) => sharpToRaster(rasterToSharp(r).blur(400)),
      ],
    },
    ['webp'],
    await plain(2000, 1000),
    {
      sizes: [{ width: 2000, height: 1000 }],
      limits: { processingTimeoutSeconds: 1 },
    },
  );
  await assert.rejects(result);
  assert.match(String(warns[0][1]), /timeout/);
});

/** An engine of the host's: it records what encode() gets, and writes a marker file. */
function recordingEngine() {
  const sharpEngine = new SharpEngine();
  const encoded: Raster[] = [];
  const engine: ImageEngine = {
    id: 'recording',
    formats: ['jpeg', 'webp', 'avif'],
    animatedFormats: [],
    resize: (frame, req, opts) => sharpEngine.resize(frame, req, opts),
    encode: async (raster) => {
      encoded.push(raster);
      return {
        data: Buffer.from('preview'),
        format: 'webp',
        contentType: 'image/webp',
        width: raster.info.width,
        height: raster.info.height,
      };
    },
  };
  return { engine, encoded };
}

test('a step with no image library runs beside a custom engine, and encode gets its result', async () => {
  const { engine, encoded } = recordingEngine();
  const { result } = await run(
    {
      beforeSteps: [
        ({ data, info }) => ({ data: Buffer.from(data).fill(9), info }),
      ],
      variantSteps: [
        (raster) => {
          raster.data.fill(7, 0, raster.info.channels);
          return raster;
        },
      ],
    },
    ['webp'],
    undefined,
    { engine, sizes: [{ width: 100, height: 50 }] },
  );
  const { created, failed } = await result;
  assert.equal(failed, 0);
  assert.equal(created.length, 1);
  const [{ data, info }] = encoded;
  assert.deepEqual([info.width, info.height], [100, 50]);
  assert.equal(data[0], 7);
  // Nothing of the step's time limit shows on the raster an engine or a step sees.
  assert.deepEqual(Object.keys(encoded[0]).sort(), ['data', 'info']);
  assert.deepEqual(Object.keys(info).sort(), ['channels', 'height', 'width']);
});

test('a rasterToSharp chain in a step keeps the limit beside a custom engine', async () => {
  const { engine } = recordingEngine();
  const { result, warns } = await run(
    { variantSteps: [async (r) => sharpToRaster(rasterToSharp(r).blur(400))] },
    ['webp'],
    await plain(2000, 1000),
    {
      engine,
      sizes: [{ width: 2000, height: 1000 }],
      limits: { processingTimeoutSeconds: 1 },
    },
  );
  await assert.rejects(result);
  assert.match(String(warns[0][1]), /timeout/);
});

test('beforeSteps stay unbounded, as on 0.3.0', async () => {
  const { result } = await run(
    { beforeSteps: [async (r) => sharpToRaster(rasterToSharp(r).blur(500))] },
    ['webp'],
    await plain(1000, 500),
    {
      sizes: [{ width: 1000, height: 500 }],
      limits: { processingTimeoutSeconds: 1 },
    },
  );
  const { created, failed } = await result;
  assert.equal(failed, 0);
  assert.equal(created.length, 1);
});

test('the limit moves no byte: a fast step writes the same files with it turned off', async () => {
  const logo = await sharp({
    create: {
      width: 30,
      height: 20,
      channels: 4,
      background: { r: 0, g: 40, b: 250, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  const filesOf = async (seconds: number | undefined) => {
    resetResizerForTests();
    const { result, files } = await run(
      {
        variantSteps: [
          async (r) => {
            const img = rasterToSharp(r)
              .blur(2)
              .composite([{ input: logo, gravity: 'southeast' }]);
            return sharpToRaster(
              seconds === undefined ? img : img.timeout({ seconds }),
            );
          },
        ],
      },
      ['jpeg', 'webp'],
      await photo(),
    );
    const { created, failed } = await result;
    assert.equal(failed, 0);
    return new Map(
      created.map((row) => [
        row.format,
        files.get((row.storageRef as { key: string }).key) as Buffer,
      ]),
    );
  };
  const limited = await filesOf(undefined);
  const off = await filesOf(0);
  assert.equal(limited.size, 2);
  for (const [format, bytes] of limited) {
    assert.ok(bytes.equals(off.get(format) as Buffer), format);
  }
});

test('a healthy task completes beside slow variants: the limit frees the threads they hold', async () => {
  const tasks = new MemoryTaskQueue({
    timing: {
      idlePollMs: 5,
      taskTimeoutMs: 2000,
      maxAttempts: 3,
      retryBackoffMs: { base: 60_000, max: 60_000 },
    },
  });
  const bodies = new Map([
    ['slow', await plain(2000, 1000)],
    ['healthy', await plain(40, 20)],
  ]);
  const stored = new Map<string, Preview[]>();
  new Resizer({
    config: makeImageConfig({
      formats: ['webp'],
      limits: { processingTimeoutSeconds: 1 },
    }),
    logger: silent,
    storage: {
      download: async (ref) =>
        bodies.get((ref as { key: string }).key) as Buffer,
      upload: async () => ({ key: 'preview' }),
      publicUrl: () => '',
    },
    media: fakeMedia({
      load: async (id) => ({
        id,
        original: { storageRef: { key: id } },
        previews: [],
      }),
      previews: stored,
    }),
    tasks,
    pipelines: {
      slow: {
        variantSteps: [async (r) => sharpToRaster(rasterToSharp(r).blur(400))],
      },
    },
  });
  const webp = (width: number, height: number) => ({
    sizeKey: `${width}x${height}`,
    format: 'webp',
    requestedWidth: width,
    requestedHeight: height,
  });
  await tasks.add({
    resizer: 'default',
    queue: 'default',
    mediaId: 'slow',
    pipeline: 'slow',
    previews: [
      webp(2000, 1000),
      webp(1990, 995),
      webp(1980, 990),
      webp(1970, 985),
    ],
  });
  await tasks.add({
    resizer: 'default',
    queue: 'default',
    mediaId: 'healthy',
    pipeline: 'default',
    previews: [webp(20, 10)],
  });
  const [slow, healthy] = tasks.rows;
  await workUntil(
    { logger: silent },
    () => healthy.status === 'completed' || healthy.status === 'dead',
  );
  assert.equal(healthy.status, 'completed');
  assert.equal(healthy.attempts, 1);
  assert.equal(stored.get('healthy')?.length, 1);
  assert.equal(stored.get('slow')?.length ?? 0, 0);
  assert.equal(slow.attempts, 1);
});

/** A 200×100 source with smooth colours, whose columns take their alpha from `alpha`. */
function transparentSource(alpha: (x: number) => number): Promise<Buffer> {
  const data = Buffer.alloc(200 * 100 * 4);
  for (let i = 0; i < 200 * 100; i++) {
    const x = i % 200;
    data.set([x, 60 + Math.floor(i / 200), 200 - x, alpha(x)], i * 4);
  }
  return sharp(data, { raw: { width: 200, height: 100, channels: 4 } })
    .png()
    .toBuffer();
}

/** Its colours alone: Sharp lands an overlay after the flatten, and that adds an alpha channel. */
async function rgbOf(img: Sharp): Promise<Buffer> {
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const pixels = info.width * info.height;
  const rgb = Buffer.alloc(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    data.copy(rgb, i * 3, i * info.channels, i * info.channels + 3);
  }
  return rgb;
}

/** The same step in both forms: rewritten through `generate()`, and as 0.3.0's one Sharp chain. */
async function compositeInBothForms(body: Buffer) {
  const logo = await sharp({
    create: {
      width: 30,
      height: 20,
      channels: 4,
      background: { r: 0, g: 40, b: 250, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  const overlay: OverlayOptions[] = [{ input: logo, gravity: 'southeast' }];
  const sized = new Map<string, Raster>();
  const { result, files } = await run(
    {
      variantSteps: [
        async (r, { variant }) => {
          sized.set(variant.format, {
            data: Buffer.from(r.data),
            info: { ...r.info },
          });
          return sharpToRaster(rasterToSharp(r).composite(overlay));
        },
      ],
    },
    ['jpeg', 'webp'],
    body,
  );
  const { created, failed } = await result;
  assert.equal(failed, 0);
  const { encode } = makeImageConfig();
  const { background } = encode.flatten;
  const both = new Map<
    string,
    {
      rewritten: Buffer;
      chain: Buffer;
      /** Both forms' pixels after the flatten, before the encoder. */
      rewrittenFlat: Buffer;
      chainFlat: Buffer;
    }
  >();
  for (const row of created) {
    const { format } = row;
    const raster = sized.get(format) as Raster;
    assert.equal(raster.info.channels, 4);
    const chain = rasterToSharp(raster).composite(overlay);
    const stepped = await sharpToRaster(
      rasterToSharp(raster).composite(overlay),
    );
    both.set(format, {
      rewritten: files.get((row.storageRef as { key: string }).key) as Buffer,
      chain: await (encode.flatten.formats.includes(format)
        ? chain.flatten({ background })
        : chain
      )
        .toFormat(
          format as keyof FormatEnum,
          encode.formats[format] as OutputOptions,
        )
        .toBuffer(),
      rewrittenFlat: await rgbOf(
        rasterToSharp(stepped).flatten({ background }),
      ),
      chainFlat: await rgbOf(
        rasterToSharp(raster).composite(overlay).flatten({ background }),
      ),
    });
  }
  return both;
}

test('a rewritten composite on a transparent source matches the Sharp-form chain on JPEG and WebP', async () => {
  const both = await compositeInBothForms(
    await transparentSource((x) => (x < 100 ? 0 : 255)),
  );
  for (const format of ['jpeg', 'webp']) {
    const forms = both.get(format);
    assert.ok(forms?.rewritten.equals(forms.chain), format);
  }
});

test('a rewritten composite on partly transparent pixels moves only the flattened format, by a few levels', async () => {
  const both = await compositeInBothForms(
    await transparentSource((x) => Math.floor((x * 255) / 199)),
  );
  const [webp, jpeg] = ['webp', 'jpeg'].map((format) => {
    const forms = both.get(format);
    assert.ok(forms);
    return forms;
  });
  assert.ok(webp.rewritten.equals(webp.chain));
  const mostApart = (a: Buffer, b: Buffer) => {
    let most = 0;
    for (let i = 0; i < a.length; i++) {
      most = Math.max(most, Math.abs(a[i] - b[i]));
    }
    return most;
  };
  const encoded = mostApart(
    await sharp(jpeg.rewritten).raw().toBuffer(),
    await sharp(jpeg.chain).raw().toBuffer(),
  );
  assert.ok(encoded <= 8, `${encoded} levels in the JPEG`);
  // The move itself is smaller: the JPEG encoder spreads it.
  const flattened = mostApart(jpeg.rewrittenFlat, jpeg.chainFlat);
  assert.ok(flattened <= 2, `${flattened} levels before the encoder`);
});
