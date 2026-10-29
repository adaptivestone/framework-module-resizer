// The Sharp steps on raw rasters: straight alpha, the box reduction, one render per size, and the
// encode of each format from it. Rasters are built here from solid colours.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import type { Raster, SourceInfo } from './contracts/decoder.ts';
import type { BeforeStep, VariantStep } from './contracts/pipeline.ts';
import { ResizeSetupError } from './errors.ts';
import type { SizePlan, VariantPlan } from './plan.ts';
import { rasterToSharp, sharpToRaster } from './raster.ts';
import {
  type EncodeOptions,
  encodeVariant,
  reduceToBox,
  renderSize,
  runBeforeSteps,
  SizedRasters,
  straightAlpha,
} from './render.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';

const config = makeImageConfig();
const { limits } = config;

/** A raster of one solid colour per frame (one value per channel), frames stacked. */
function solid(width: number, height: number, ...colours: number[][]): Raster {
  const channels = colours[0].length as 1 | 2 | 3 | 4;
  const data = Buffer.alloc(width * height * channels * colours.length);
  colours.forEach((colour, frame) => {
    for (let i = 0; i < width * height; i++) {
      data.set(colour, (frame * width * height + i) * channels);
    }
  });
  return { data, info: { width, height, channels } };
}

/** Three 20×20 frames (red, green, blue) with their timing. */
function threeFrames(): Raster {
  const raster = solid(20, 20, [255, 0, 0], [0, 255, 0], [0, 0, 255]);
  return {
    data: raster.data,
    info: {
      width: 20,
      height: 20,
      channels: 3,
      frames: 3,
      delay: [100, 200, 300],
      loop: 3,
    },
  };
}

/** The pixel at (x, y) of frame `frame`, as an array of its channels. */
function pixelAt(raster: Raster, x: number, y: number, frame = 0): number[] {
  const { width, height, channels } = raster.info;
  const offset = ((frame * height + y) * width + x) * channels;
  return [...raster.data.subarray(offset, offset + channels)];
}

/** The decoded pixel at (x, y) of an encoded image. */
async function encodedPixel(
  data: Buffer,
  x: number,
  y: number,
): Promise<number[]> {
  const { data: raw, info } = await sharp(data)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return [...raw.subarray(offset, offset + info.channels)];
}

function assertNear(actual: number[], expected: number[], tolerance = 2) {
  assert.equal(actual.length, expected.length, `${actual} vs ${expected}`);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= tolerance,
      `${actual} is not within ±${tolerance} of ${expected}`,
    );
  }
}

function sizePlan(
  width: number,
  height: number,
  mode: 'fill' | 'cover' = 'fill',
  animated = false,
): SizePlan {
  return {
    key: `${width}x${height}:${mode}::${animated ? 'a' : ''}`,
    width,
    height,
    mode,
    sharpen: false,
    animated,
  };
}

function variantPlan(size: SizePlan, format: string): VariantPlan {
  return {
    variant: { sizeKey: `${size.width}x${size.height}`, format },
    identity: `default:default:${size.width}x${size.height}:${format}:`,
    size,
  };
}

function encodeOptions(variantSteps: VariantStep[] = []): EncodeOptions {
  return { variantSteps, ctx: {}, encode: config.encode, limits };
}

test('renderSize returns the raster itself when nothing changes', async () => {
  const raster = solid(20, 10, [10, 20, 30]);
  const out = await renderSize(raster, sizePlan(20, 10), limits);
  assert.equal(out, raster);
});

test('renderSize fills exact sizes and cover-crops the centre', async () => {
  // 40×20: the left half red, the right half blue.
  const raster = solid(40, 20, [255, 0, 0]);
  for (let y = 0; y < 20; y++) {
    for (let x = 20; x < 40; x++) {
      raster.data.set([0, 0, 255], (y * 40 + x) * 3);
    }
  }
  const cover = await renderSize(raster, sizePlan(20, 20, 'cover'), limits);
  assert.equal(cover.info.width, 20);
  assert.equal(cover.info.height, 20);
  assertNear(pixelAt(cover, 2, 10), [255, 0, 0]);
  assertNear(pixelAt(cover, 17, 10), [0, 0, 255]);

  const fill = await renderSize(raster, sizePlan(10, 10), limits);
  assert.equal(fill.info.width, 10);
  assert.equal(fill.info.height, 10);
  assert.equal(fill.data.length, 10 * 10 * fill.info.channels);
});

test('renderSize turns a grey raster into sRGB', async () => {
  const out = await renderSize(solid(10, 10, [128]), sizePlan(10, 10), limits);
  assert.equal(out.info.channels, 3);
  assert.equal(out.data.length, 10 * 10 * 3);
});

test('renderSize resizes every frame of an animation and keeps its timing', async () => {
  const out = await renderSize(
    threeFrames(),
    sizePlan(10, 10, 'fill', true),
    limits,
  );
  assert.equal(out.info.frames, 3);
  assert.equal(out.info.width, 10);
  assert.equal(out.info.height, 10);
  assert.equal(out.data.length, 10 * 10 * out.info.channels * 3);
  assertNear(pixelAt(out, 5, 5, 0), [255, 0, 0]);
  assertNear(pixelAt(out, 5, 5, 1), [0, 255, 0]);
  assertNear(pixelAt(out, 5, 5, 2), [0, 0, 255]);
  assert.deepEqual(out.info.delay, [100, 200, 300]);
  assert.equal(out.info.loop, 3);
});

test('encodeVariant writes animated WebP and GIF with the source delays and loop count', async () => {
  const size = sizePlan(10, 10, 'fill', true);
  const sized = await renderSize(threeFrames(), size, limits);
  for (const format of ['webp', 'gif']) {
    const encoded = await encodeVariant(
      sized,
      variantPlan(size, format),
      encodeOptions(),
    );
    assert.equal(encoded.format, format);
    const meta = await sharp(encoded.data, { animated: true }).metadata();
    assert.equal(meta.pages, 3, format);
    assert.deepEqual(meta.delay, [100, 200, 300], format);
    assert.equal(meta.loop, 3, format);
  }
});

test('encodeVariant gives a format that cannot animate the first frame', async () => {
  const size = sizePlan(10, 10, 'fill', true);
  const sized = await renderSize(threeFrames(), size, limits);
  const encoded = await encodeVariant(
    sized,
    variantPlan(size, 'jpeg'),
    encodeOptions(),
  );
  assert.equal(encoded.width, 10);
  assert.equal(encoded.height, 10);
  const meta = await sharp(encoded.data).metadata();
  assert.equal(meta.height, 10);
  assertNear(await encodedPixel(encoded.data, 5, 5), [255, 0, 0], 12);
});

test('a semi-transparent raster keeps its colours through renderSize and encode', async () => {
  const size = sizePlan(20, 15);
  const sized = await renderSize(
    solid(40, 30, [100, 50, 200, 128]),
    size,
    limits,
  );
  const encoded = await encodeVariant(
    sized,
    variantPlan(size, 'png'),
    encodeOptions(),
  );
  assertNear(await encodedPixel(encoded.data, 0, 0), [100, 50, 200, 128]);
});

test('straightAlpha turns a premultiplied raster into straight alpha, and leaves a straight one alone', async () => {
  const marked = solid(8, 4, [50, 25, 100, 128]);
  marked.info.premultiplied = true;
  const straight = await straightAlpha(marked, limits);
  assert.equal(straight.info.width, 8);
  assert.equal(straight.info.height, 4);
  assert.equal(straight.info.channels, 4);
  assertNear(pixelAt(straight, 0, 0), [100, 50, 200, 128]);
  assert.equal(straight.info.premultiplied, undefined);

  const unmarked = solid(8, 4, [50, 25, 100, 128]);
  assert.equal(await straightAlpha(unmarked, limits), unmarked);
});

test('reduceToBox shrinks a larger raster to cover the box and leaves a smaller one alone', async () => {
  const large = solid(600, 400, [10, 20, 30]);
  const exact = await reduceToBox(large, { width: 300, height: 200 }, limits);
  assert.equal(exact.info.width, 300);
  assert.equal(exact.info.height, 200);
  const covering = await reduceToBox(
    large,
    { width: 300, height: 250 },
    limits,
  );
  assert.equal(covering.info.width, 375);
  assert.equal(covering.info.height, 250);
  assert.equal(covering.data.length, 375 * 250 * covering.info.channels);

  const small = solid(200, 100, [10, 20, 30]);
  assert.equal(
    await reduceToBox(small, { width: 300, height: 200 }, limits),
    small,
  );
});

test('encodeVariant flattens alpha onto the background for the listed formats', async () => {
  const size = sizePlan(10, 10);
  const encoded = await encodeVariant(
    solid(10, 10, [0, 0, 0, 0]),
    variantPlan(size, 'jpeg'),
    encodeOptions(),
  );
  assertNear(await encodedPixel(encoded.data, 5, 5), [255, 255, 255], 5);
});

test('encodeVariant runs variantSteps on the sized pixels, in order', async () => {
  const seen: [string, number | undefined][] = [];
  const record =
    (name: string): VariantStep =>
    async (img) => {
      seen.push([name, (await img.metadata()).width]);
      return img;
    };
  const size = sizePlan(20, 10);
  await encodeVariant(
    solid(20, 10, [10, 20, 30]),
    variantPlan(size, 'jpeg'),
    encodeOptions([record('a'), record('b')]),
  );
  assert.deepEqual(seen, [
    ['a', 20],
    ['b', 20],
  ]);
});

test('encodeVariant reports the encoded size and content type', async () => {
  const size = sizePlan(20, 10);
  const jpeg = await encodeVariant(
    solid(20, 10, [10, 20, 30]),
    variantPlan(size, 'jpeg'),
    encodeOptions(),
  );
  assert.deepEqual(
    {
      format: jpeg.format,
      contentType: jpeg.contentType,
      width: jpeg.width,
      height: jpeg.height,
    },
    { format: 'jpeg', contentType: 'image/jpeg', width: 20, height: 10 },
  );
  assert.ok(Buffer.isBuffer(jpeg.data) && jpeg.data.length > 0);

  const animated = sizePlan(10, 10, 'fill', true);
  const webp = await encodeVariant(
    await renderSize(threeFrames(), animated, limits),
    variantPlan(animated, 'webp'),
    encodeOptions(),
  );
  assert.equal(webp.contentType, 'image/webp');
  assert.equal(webp.width, 10);
  assert.equal(webp.height, 10);
});

test('SizedRasters renders each size once for the variants that share it, and drops it after the last', async () => {
  const size = sizePlan(10, 5);
  const a = variantPlan(size, 'jpeg');
  const b = variantPlan(size, 'webp');
  const sized = new SizedRasters(solid(20, 10, [10, 20, 30]), [a, b], limits);
  const first = sized.get(a.size);
  assert.equal(sized.get(b.size), first);
  assert.equal((await first).info.width, 10);
  sized.release(a.size);
  assert.equal(sized.get(b.size), first, 'kept until the last variant');
  sized.release(b.size);
  const again = sized.get(a.size);
  assert.notEqual(again, first);
  assert.equal((await again).info.width, 10);
});

/** The meta runBeforeSteps passes on (without the scale it adds per step). */
function stepMeta(source: Partial<SourceInfo> = {}) {
  return {
    media: { id: 'm1' },
    source: {
      format: 'png',
      contentType: 'image/png',
      width: 40,
      height: 30,
      ...source,
    },
    ctx: {},
  };
}

test('runBeforeSteps hands each step the current raster with its scale, and passes the result on', async () => {
  const seen: Array<{ width: number; scale: number }> = [];
  const steps: BeforeStep[] = [
    async (raster, { scale }) => {
      seen.push({ width: raster.info.width, scale });
      return sharpToRaster(
        rasterToSharp(raster).extract({
          left: 0,
          top: 0,
          width: 10,
          height: 10,
        }),
      );
    },
    (raster, { scale }) => {
      seen.push({ width: raster.info.width, scale });
      return raster;
    },
  ];
  const result = await runBeforeSteps(
    solid(40, 20, [10, 20, 30]),
    steps,
    stepMeta({ format: 'svg', width: 20, height: 10, vector: true }),
    limits,
  );
  assert.deepEqual(seen, [
    { width: 40, scale: 2 },
    { width: 10, scale: 0.5 },
  ]);
  assert.equal(result.info.width, 10);
  assert.equal(result.info.height, 10);
});

test('runBeforeSteps keeps semi-transparent colours through the helpers', async () => {
  const result = await runBeforeSteps(
    solid(40, 30, [100, 50, 200, 128]),
    [async (r) => sharpToRaster(rasterToSharp(r).resize(20, 15))],
    stepMeta(),
    limits,
  );
  assert.equal(result.info.width, 20);
  assertNear(pixelAt(result, 0, 0), [100, 50, 200, 128]);
  assert.equal(result.info.premultiplied, undefined);
});

test('a returned raster marked premultiplied is converted to straight alpha', async () => {
  const result = await runBeforeSteps(
    solid(40, 30, [10, 20, 30]),
    [
      () => {
        const marked = solid(8, 4, [50, 25, 100, 128]);
        marked.info.premultiplied = true;
        return marked;
      },
    ],
    stepMeta(),
    limits,
  );
  assert.equal(result.info.width, 8);
  assertNear(pixelAt(result, 0, 0), [100, 50, 200, 128]);
  assert.equal(result.info.premultiplied, undefined);
});

test('a step result that is not a one-frame Raster is RESIZE_PIPELINE_STEP_INVALID', async () => {
  const input = solid(4, 2, [10, 20, 30]);
  const cases: Array<[string, (r: Raster) => unknown]> = [
    ['a Buffer', (r) => Buffer.from(r.data)],
    ['undefined', () => undefined],
    ['a Sharp instance', (r) => rasterToSharp(r)],
    [
      'channels 5',
      (r) => ({
        data: Buffer.alloc(4 * 2 * 5),
        info: { ...r.info, channels: 5 },
      }),
    ],
    ['width 0', (r) => ({ data: r.data, info: { ...r.info, width: 0 } })],
    [
      'frames 2',
      (r) => ({
        data: Buffer.concat([r.data, r.data]),
        info: { ...r.info, frames: 2 },
      }),
    ],
    [
      'data one byte short',
      (r) => ({ data: r.data.subarray(1), info: r.info }),
    ],
    [
      'data a Uint8Array',
      (r) => ({ data: new Uint8Array(r.data), info: r.info }),
    ],
  ];
  for (const [name, step] of cases) {
    await assert.rejects(
      runBeforeSteps(
        input,
        [step as unknown as BeforeStep],
        stepMeta(),
        limits,
      ),
      (err: unknown) => {
        assert.ok(err instanceof ResizeSetupError, name);
        assert.equal(err.code, 'RESIZE_PIPELINE_STEP_INVALID', name);
        assert.equal(err.retryable, true, name);
        assert.match(err.message, /beforeStep/, name);
        return true;
      },
    );
  }
});
