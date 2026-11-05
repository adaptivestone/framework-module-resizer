// variantSteps through the whole path: `new Resizer`, `generate()`, the stored files and rows.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import sharp, {
  type FormatEnum,
  type OutputOptions,
  type OverlayOptions,
} from 'sharp';
import type { Raster } from './contracts/decoder.ts';
import type { Pipeline } from './contracts/pipeline.ts';
import { rasterToSharp, sharpToRaster } from './engines/sharpRaster.ts';
import { ResizeGenerateError } from './errors.ts';
import { Resizer, resetResizerForTests } from './resizer.ts';
import { fakeMedia, memoryStorage } from './testHelpers/fakes.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import type { MediaLike, Preview, ResizeLimits, SizeInput } from './types.d.ts';

afterEach(resetResizerForTests);

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
  }: { sizes?: SizeInput[]; limits?: Partial<ResizeLimits> } = {},
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

test('a slow step with its own timeout is killed, and fails only its variant', async () => {
  // Without the timeout this blur runs for about 7 s on the large size.
  const { result, warns } = await run(
    {
      variantSteps: [
        async (r) =>
          sharpToRaster(
            rasterToSharp(r)
              .blur(r.info.width === 2000 ? 400 : 1)
              .timeout({ seconds: 1 }),
          ),
      ],
    },
    ['webp'],
    await plain(2000, 1000),
    {
      sizes: [
        { width: 2000, height: 1000 },
        { width: 100, height: 50 },
      ],
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

test('limits.processingTimeoutSeconds does not bound a step: a step is host code', async () => {
  // This blur runs for longer than the limit, and the encode after it stays within it.
  const { result } = await run(
    {
      variantSteps: [async (r) => sharpToRaster(rasterToSharp(r).blur(500))],
    },
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
  const both = new Map<string, { rewritten: Buffer; chain: Buffer }>();
  for (const row of created) {
    const { format } = row;
    const raster = sized.get(format) as Raster;
    assert.equal(raster.info.channels, 4);
    const chain = rasterToSharp(raster).composite(overlay);
    both.set(format, {
      rewritten: files.get((row.storageRef as { key: string }).key) as Buffer,
      chain: await (encode.flatten.formats.includes(format)
        ? chain.flatten({ background: encode.flatten.background })
        : chain
      )
        .toFormat(
          format as keyof FormatEnum,
          encode.formats[format] as OutputOptions,
        )
        .toBuffer(),
    });
  }
  return both;
}

test('a rewritten composite on a transparent source matches the Sharp-form chain on JPEG and WebP', async () => {
  const both = await compositeInBothForms(
    await transparentSource((x) => (x < 100 ? 0 : 255)),
  );
  for (const format of ['jpeg', 'webp']) {
    const { rewritten, chain } = both.get(format) as {
      rewritten: Buffer;
      chain: Buffer;
    };
    assert.ok(rewritten.equals(chain), format);
  }
});

test('a rewritten composite on partly transparent pixels moves only the flattened format, by a few levels', async () => {
  const both = await compositeInBothForms(
    await transparentSource((x) => Math.floor((x * 255) / 199)),
  );
  const webp = both.get('webp') as { rewritten: Buffer; chain: Buffer };
  assert.ok(webp.rewritten.equals(webp.chain));
  const jpeg = both.get('jpeg') as { rewritten: Buffer; chain: Buffer };
  const a = await sharp(jpeg.rewritten).raw().toBuffer();
  const b = await sharp(jpeg.chain).raw().toBuffer();
  let most = 0;
  for (let i = 0; i < a.length; i++) {
    most = Math.max(most, Math.abs(a[i] - b[i]));
  }
  assert.ok(most <= 8, `${most} levels`);
});
