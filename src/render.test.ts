// The pixel steps on raw rasters, on the real SharpEngine: straight alpha, the box reduction, one
// render per size, and the encode of each format from it, with the checks on what an engine returns.
// Rasters are built here from solid colours.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import type { Raster, SourceInfo } from './contracts/decoder.ts';
import type {
  EncodedImage,
  EncodeRequest,
  EngineCallOptions,
  ImageEngine,
  ResizeRequest,
} from './contracts/engine.ts';
import type { BeforeStep, VariantStep } from './contracts/pipeline.ts';
import { SharpEngine } from './engines/sharp.ts';
import { rasterToSharp, sharpToRaster } from './engines/sharpRaster.ts';
import { type ResizeError, ResizeSetupError } from './errors.ts';
import type { SizePlan, VariantPlan } from './plan.ts';
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
const engine = new SharpEngine();

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
  return {
    variantSteps,
    ctx: {},
    encode: config.encode,
    limits,
    engine,
    media: { id: 'm1' },
    source: {
      format: 'png',
      contentType: 'image/png',
      width: 20,
      height: 10,
    },
  };
}

const lying = (over: Partial<ImageEngine>): ImageEngine => ({
  id: 'liar',
  formats: ['webp'],
  animatedFormats: [],
  resize: (frame, req, o) => engine.resize(frame, req, o),
  encode: (raster, req, o) => engine.encode(raster, req, o),
  ...over,
});

test('renderSize returns the raster itself when nothing changes', async () => {
  const raster = solid(20, 10, [10, 20, 30]);
  const out = await renderSize(raster, sizePlan(20, 10), engine, { limits });
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
  const cover = await renderSize(raster, sizePlan(20, 20, 'cover'), engine, {
    limits,
  });
  assert.equal(cover.info.width, 20);
  assert.equal(cover.info.height, 20);
  assertNear(pixelAt(cover, 2, 10), [255, 0, 0]);
  assertNear(pixelAt(cover, 17, 10), [0, 0, 255]);

  const fill = await renderSize(raster, sizePlan(10, 10), engine, { limits });
  assert.equal(fill.info.width, 10);
  assert.equal(fill.info.height, 10);
  assert.equal(fill.data.length, 10 * 10 * fill.info.channels);
});

test('renderSize turns a grey raster into sRGB', async () => {
  const out = await renderSize(solid(10, 10, [128]), sizePlan(10, 10), engine, {
    limits,
  });
  assert.equal(out.info.channels, 3);
  assert.equal(out.data.length, 10 * 10 * 3);
});

test('renderSize resizes every frame of an animation and keeps its timing', async () => {
  const out = await renderSize(
    threeFrames(),
    sizePlan(10, 10, 'fill', true),
    engine,
    { limits },
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
  const sized = await renderSize(threeFrames(), size, engine, { limits });
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
  const sized = await renderSize(threeFrames(), size, engine, { limits });
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
    engine,
    { limits },
  );
  const encoded = await encodeVariant(
    sized,
    variantPlan(size, 'png'),
    encodeOptions(),
  );
  assertNear(await encodedPixel(encoded.data, 0, 0), [100, 50, 200, 128]);
});

test('straightAlpha turns a premultiplied raster into straight alpha, and leaves a straight one alone', () => {
  const marked = solid(8, 4, [50, 25, 100, 128]);
  marked.info.premultiplied = true;
  const straight = straightAlpha(marked);
  assert.equal(straight.info.width, 8);
  assert.equal(straight.info.height, 4);
  assert.equal(straight.info.channels, 4);
  assertNear(pixelAt(straight, 0, 0), [100, 50, 200, 128]);
  assert.equal(straight.info.premultiplied, undefined);

  const unmarked = solid(8, 4, [50, 25, 100, 128]);
  assert.equal(straightAlpha(unmarked), unmarked);
});

test('reduceToBox shrinks a larger raster to cover the box and leaves a smaller one alone', async () => {
  const large = solid(600, 400, [10, 20, 30]);
  const exact = await reduceToBox(large, { width: 300, height: 200 }, engine, {
    limits,
  });
  assert.equal(exact.info.width, 300);
  assert.equal(exact.info.height, 200);
  const covering = await reduceToBox(
    large,
    { width: 300, height: 250 },
    engine,
    { limits },
  );
  assert.equal(covering.info.width, 375);
  assert.equal(covering.info.height, 250);
  assert.equal(covering.data.length, 375 * 250 * covering.info.channels);

  const small = solid(200, 100, [10, 20, 30]);
  assert.equal(
    await reduceToBox(small, { width: 300, height: 200 }, engine, { limits }),
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
    async (raster) => {
      seen.push([name, raster.info.width]);
      return raster;
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

test('a variantStep gets its own copy of the pixels, for each format', async () => {
  const sized = solid(20, 10, [10, 20, 30]);
  const before = Buffer.from(sized.data);
  const seen: number[] = [];
  const mark: VariantStep = (raster) => {
    seen.push(raster.data[0]);
    raster.data[0] = 255;
    return raster;
  };
  for (const format of ['webp', 'png']) {
    await encodeVariant(
      sized,
      variantPlan(sizePlan(20, 10), format),
      encodeOptions([mark]),
    );
  }
  assert.deepEqual(seen, [10, 10]);
  assert.ok(sized.data.equals(before));
});

test('a variantStep owns its memory on a small preview: no slice of the shared pool', async () => {
  const neighbour = Buffer.from('neighbour');
  const seen: { own: number; length: number }[] = [];
  const through: VariantStep = (raster) => {
    seen.push({
      own: raster.data.buffer.byteLength,
      length: raster.data.length,
    });
    new Uint8Array(raster.data.buffer).fill(255);
    return raster;
  };
  await encodeVariant(
    solid(20, 10, [10, 20, 30]),
    variantPlan(sizePlan(20, 10), 'webp'),
    encodeOptions([through]),
  );
  assert.deepEqual(seen, [{ own: 600, length: 600 }]);
  assert.equal(neighbour.toString(), 'neighbour');
});

test('a variantStep sees the variant, media, source and ctx', async () => {
  let meta: Parameters<VariantStep>[1] | undefined;
  const opts = encodeOptions([
    (raster, m) => {
      meta = m;
      return raster;
    },
  ]);
  const plan = variantPlan(sizePlan(20, 10), 'webp');
  await encodeVariant(solid(20, 10, [1, 2, 3]), plan, opts);
  assert.equal(meta?.variant, plan.variant);
  assert.equal(meta?.media, opts.media);
  assert.equal(meta?.source, opts.source);
  assert.equal(meta?.ctx, opts.ctx);
});

test('transparency a variantStep adds is flattened on a flattened format', async () => {
  const clear: VariantStep = (raster) =>
    sharpToRaster(rasterToSharp(raster).ensureAlpha(0));
  const { data } = await encodeVariant(
    solid(20, 10, [10, 20, 30]),
    variantPlan(sizePlan(20, 10), 'jpeg'),
    encodeOptions([clear]),
  );
  for (const channel of await encodedPixel(data, 5, 5)) {
    assert.ok(channel >= 250, String(channel));
  }
});

test('a variantStep that removes alpha gets no background', async () => {
  const requests: EncodeRequest[] = [];
  const recording = lying({
    encode: (raster, req, o) => {
      requests.push(req);
      return engine.encode(raster, req, o);
    },
  });
  const opaque: VariantStep = (raster) =>
    sharpToRaster(rasterToSharp(raster).removeAlpha());
  await encodeVariant(
    solid(20, 10, [10, 20, 30, 128]),
    variantPlan(sizePlan(20, 10), 'jpeg'),
    { ...encodeOptions([opaque]), engine: recording },
  );
  assert.equal(requests[0].background, undefined);
});

test('a step that resolves with a Sharp instance is told to return its pixels', async () => {
  const lazy = (raster: Raster) => rasterToSharp(raster) as unknown as Raster;
  const expected = (kind: string) => (err: ResizeError) => {
    assert.equal(err.code, 'RESIZE_PIPELINE_STEP_INVALID');
    assert.match(err.message, new RegExp(`a ${kind} resolved with`));
    assert.match(
      err.message,
      /it is a Sharp instance, not its pixels: return sharpToRaster\(img\)/,
    );
    return true;
  };
  await assert.rejects(
    encodeVariant(
      solid(20, 10, [1, 2, 3]),
      variantPlan(sizePlan(20, 10), 'webp'),
      encodeOptions([lazy]),
    ),
    expected('variantStep'),
  );
  await assert.rejects(
    runBeforeSteps(solid(20, 10, [1, 2, 3]), [lazy], {
      media: { id: 'm1' },
      source: encodeOptions().source,
      ctx: {},
    }),
    expected('beforeStep'),
  );
});

test('a premultiplied variantStep result reaches the engine as straight alpha', async () => {
  const seen: Raster[] = [];
  const recording = lying({
    encode: (raster, req, o) => {
      seen.push(raster);
      return engine.encode(raster, req, o);
    },
  });
  const marked: VariantStep = (raster) => ({
    data: raster.data,
    info: { ...raster.info, premultiplied: true },
  });
  await encodeVariant(
    solid(20, 10, [50, 50, 50, 128]),
    variantPlan(sizePlan(20, 10), 'png'),
    { ...encodeOptions([marked]), engine: recording },
  );
  assert.equal(seen[0].info.premultiplied, undefined);
  assert.deepEqual(pixelAt(seen[0], 0, 0), [100, 100, 100, 128]);
});

test("Sharp's own { data, info } from a step is read as straight alpha, on both kinds of step", async () => {
  const flags: unknown[] = [];
  const sharpsOwn = async (raster: Raster) => {
    const out = await rasterToSharp(raster)
      .resize(10, 5)
      .raw()
      .toBuffer({ resolveWithObject: true });
    flags.push(out.info.premultiplied);
    return out as unknown as Raster;
  };
  const seen: Raster[] = [];
  const recording = {
    id: 'recording',
    formats: engine.formats,
    animatedFormats: engine.animatedFormats,
    resize: engine.resize.bind(engine),
    encode: (raster: Raster, req: EncodeRequest, opts: EngineCallOptions) => {
      seen.push(raster);
      return engine.encode(raster, req, opts);
    },
  } as ImageEngine;
  await encodeVariant(
    solid(20, 10, [200, 100, 50, 128]),
    variantPlan(sizePlan(20, 10), 'png'),
    { ...encodeOptions([sharpsOwn]), engine: recording },
  );
  const before = await runBeforeSteps(
    solid(20, 10, [200, 100, 50, 128]),
    [sharpsOwn],
    {
      media: { id: 'm1' },
      source: encodeOptions().source,
      ctx: {},
    },
  );
  // Sharp's flag says premultiplied on these straight bytes: what the core must not believe.
  assert.deepEqual(flags, [true, true]);
  for (const raster of [seen[0], before]) {
    assert.equal(raster.info.premultiplied, undefined);
    assertNear(pixelAt(raster, 0, 0), [200, 100, 50, 128]);
  }
});

test("a step that spreads Sharp's info over its own premultiplied bytes is read as straight alpha", async () => {
  const spreads = async (raster: Raster) => {
    const { info } = await rasterToSharp(raster)
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      data: solid(20, 10, [100, 50, 25, 128]).data,
      info: { ...info, premultiplied: true },
    } as unknown as Raster;
  };
  const out = await runBeforeSteps(solid(20, 10, [1, 2, 3, 255]), [spreads], {
    media: { id: 'm1' },
    source: encodeOptions().source,
    ctx: {},
  });
  // Not divided: the flag on such a result is not believed, so a step must not build one this way.
  assert.deepEqual(pixelAt(out, 0, 0), [100, 50, 25, 128]);
  assert.equal(out.info.premultiplied, undefined);
});

test('the flag on a raster a step built itself is still believed', async () => {
  const marked = (raster: Raster): Raster => ({
    data: solid(20, 10, [100, 50, 25, 128]).data,
    info: { ...raster.info, premultiplied: true },
  });
  const out = await runBeforeSteps(solid(20, 10, [1, 2, 3, 255]), [marked], {
    media: { id: 'm1' },
    source: encodeOptions().source,
    ctx: {},
  });
  assertNear(pixelAt(out, 0, 0), [199, 100, 50, 128]);
});

test("a chained step's input owns its memory after a result marked premultiplied", async () => {
  const seen: number[] = [];
  const chained: VariantStep[] = [
    (raster) => ({
      data: Buffer.from(raster.data),
      info: { ...raster.info, premultiplied: true },
    }),
    (raster) => {
      seen.push(raster.data.buffer.byteLength, raster.data.length);
      return raster;
    },
  ];
  await encodeVariant(
    solid(20, 10, [50, 50, 50, 128]),
    variantPlan(sizePlan(20, 10), 'webp'),
    encodeOptions(chained),
  );
  assert.deepEqual(seen, [800, 800]);
});

test("a task's signal does not stop a variant's steps or its encode: only the engine gets it", async () => {
  const controller = new AbortController();
  const ran: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const recording = {
    id: 'recording',
    formats: engine.formats,
    animatedFormats: engine.animatedFormats,
    resize: engine.resize.bind(engine),
    encode: (raster: Raster, req: EncodeRequest, opts: EngineCallOptions) => {
      signals.push(opts.signal);
      return engine.encode(raster, req, opts);
    },
  } as ImageEngine;
  const out = await encodeVariant(
    solid(20, 10, [1, 2, 3]),
    variantPlan(sizePlan(20, 10), 'webp'),
    {
      ...encodeOptions([
        (raster) => {
          ran.push('first');
          controller.abort();
          return raster;
        },
        (raster) => {
          ran.push('second');
          return raster;
        },
      ]),
      engine: recording,
      signal: controller.signal,
    },
  );
  assert.ok(out.data.length > 0);
  assert.deepEqual(ran, ['first', 'second']);
  assert.deepEqual(signals, [controller.signal]);
});

test('a step that resolves with a Buffer is told to return its pixels, not an image file', async () => {
  const buffer = (raster: Raster) => raster.data as unknown as Raster;
  const encoded = (raster: Raster) =>
    rasterToSharp(raster).png().toBuffer() as unknown as Raster;
  const expected = (kind: string) => (err: ResizeError) => {
    assert.equal(err.code, 'RESIZE_PIPELINE_STEP_INVALID');
    assert.match(err.message, new RegExp(`a ${kind} resolved with`));
    assert.match(
      err.message,
      /it is a Buffer, not a Raster: return \{ data, info \} \(with Sharp: sharpToRaster\(img\), not img\.toBuffer\(\)\)/,
    );
    assert.doesNotMatch(err.message, /`data` is not a Buffer/);
    // A host on another engine, with no Sharp of its own, hears the shape first.
    assert.match(
      err.message,
      /receives and returns a Raster \(\{ data, info \}\), whatever the engine/,
    );
    return true;
  };
  for (const step of [buffer, encoded]) {
    await assert.rejects(
      encodeVariant(
        solid(20, 10, [1, 2, 3]),
        variantPlan(sizePlan(20, 10), 'webp'),
        encodeOptions([step]),
      ),
      expected('variantStep'),
    );
    await assert.rejects(
      runBeforeSteps(solid(20, 10, [1, 2, 3]), [step], {
        media: { id: 'm1' },
        source: encodeOptions().source,
        ctx: {},
      }),
      expected('beforeStep'),
    );
  }
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
    await renderSize(threeFrames(), animated, engine, { limits }),
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
  const sized = new SizedRasters(solid(20, 10, [10, 20, 30]), [a, b], engine, {
    limits,
  });
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

test('SizedRasters.clear drops the base raster and every sized one, released or not', async () => {
  const small = sizePlan(10, 5);
  const large = sizePlan(16, 8);
  const sized = new SizedRasters(
    solid(20, 10, [10, 20, 30]),
    [variantPlan(small, 'jpeg'), variantPlan(large, 'jpeg')],
    engine,
    { limits },
  );
  await sized.get(small);
  sized.clear();
  // Neither the cached size nor the base raster is left to render from.
  await assert.rejects(sized.get(small), ResizeSetupError);
  await assert.rejects(sized.get(large), ResizeSetupError);
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
      runBeforeSteps(input, [step as unknown as BeforeStep], stepMeta()),
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

test('renderSize resizes a two-frame raster per frame and reads both frames back', async () => {
  const two = solid(12, 8, [255, 0, 0], [0, 0, 255]);
  two.info.frames = 2;
  const out = await renderSize(two, sizePlan(6, 4, 'fill', true), engine, {
    limits,
  });
  assert.deepEqual(out.info, { width: 6, height: 4, channels: 3, frames: 2 });
  assert.equal(out.data.length, 6 * 4 * 3 * 2);
  assertNear(pixelAt(out, 3, 2, 0), [255, 0, 0]);
  assertNear(pixelAt(out, 3, 2, 1), [0, 0, 255]);
});

test('renderSize sharpens a size marked sharpen', async () => {
  // A hard edge: sharpening overshoots next to it, a plain resize does not.
  const edge = solid(40, 40, [100, 100, 100]);
  for (let y = 0; y < 40; y++) {
    for (let x = 20; x < 40; x++) {
      edge.data.set([160, 160, 160], (y * 40 + x) * 3);
    }
  }
  const plain = await renderSize(edge, sizePlan(20, 20), engine, { limits });
  const sharp20 = await renderSize(
    edge,
    { ...sizePlan(20, 20), key: '20x20:fill:s:', sharpen: true },
    engine,
    { limits },
  );
  assert.equal(sharp20.info.width, 20);
  assert.notDeepEqual(sharp20.data, plain.data);
});

test('encodeVariant gives every frame a delay when the raster lists fewer delays than frames', async () => {
  const size = sizePlan(10, 10, 'fill', true);
  const sized = await renderSize(threeFrames(), size, engine, { limits });
  sized.info.delay = [70];
  for (const format of ['gif', 'webp']) {
    const encoded = await encodeVariant(
      sized,
      variantPlan(size, format),
      encodeOptions(),
    );
    const meta = await sharp(encoded.data, { animated: true }).metadata();
    assert.equal(meta.pages, 3, format);
    assert.deepEqual(meta.delay, [70, 70, 70], format);
  }
});

test('straightAlpha converts a premultiplied animation frame by frame and keeps its timing', () => {
  const marked = solid(8, 4, [50, 25, 100, 128], [25, 50, 0, 128]);
  marked.info = {
    width: 8,
    height: 4,
    channels: 4,
    frames: 2,
    delay: [40, 80],
    loop: 2,
    premultiplied: true,
  };
  const straight = straightAlpha(marked);
  assert.equal(straight.info.frames, 2);
  assert.equal(straight.info.height, 4);
  assert.deepEqual(straight.info.delay, [40, 80]);
  assert.equal(straight.info.loop, 2);
  assert.equal(straight.info.premultiplied, undefined);
  assertNear(pixelAt(straight, 0, 0, 0), [100, 50, 200, 128]);
  assertNear(pixelAt(straight, 0, 0, 1), [50, 100, 0, 128]);
});

const encodedAs = (fields: Partial<EncodedImage>): ImageEngine =>
  lying({
    encode: async () =>
      ({
        data: Buffer.from('x'),
        format: 'webp',
        contentType: 'image/webp',
        width: 20,
        height: 10,
        ...fields,
      }) as EncodedImage,
  });
for (const [fields, problem] of [
  [{ data: 'x' as unknown as Buffer }, '`data` is not a Buffer'],
  [{ format: '' }, 'no `format`'],
  [
    { format: 'image/webp' },
    "the `format` 'image/webp' is not a file extension",
  ],
  [{ contentType: '' }, 'no `contentType`'],
  [{ width: 0 }, 'the size 0×10'],
  [{ data: Buffer.alloc(0) }, '`data` is empty'],
  [{ width: 1, height: 1 }, 'it is 1×1, not 20×10'],
  [{ width: 20, height: 20 }, 'it is 20×20, not 20×10'],
  [{ width: 21, height: 10 }, 'it is 21×10, not 20×10'],
  [
    { contentType: 'text/html' },
    "the `contentType` 'text/html' is not an image type",
  ],
  [
    { contentType: 'application/octet-stream' },
    "the `contentType` 'application/octet-stream' is not an image type",
  ],
  [
    { contentType: ' image/svg+xml' },
    "the `contentType` ' image/svg+xml' is not an image type",
  ],
] as [Partial<EncodedImage>, string][]) {
  test(`an encode result with ${problem} is RESIZE_ENGINE_INVALID`, async () => {
    await assert.rejects(
      encodeVariant(
        solid(20, 10, [1, 2, 3]),
        variantPlan(sizePlan(20, 10), 'webp'),
        { ...encodeOptions(), engine: encodedAs(fields) },
      ),
      (err: ResizeError) => {
        assert.equal(err.code, 'RESIZE_ENGINE_INVALID');
        assert.equal(err.retryable, true);
        assert.equal(
          err.message,
          `resize: engine 'liar' broke its contract: the result of encode(): ${problem}`,
        );
        return true;
      },
    );
  });
}

test('a resize result of another size is RESIZE_ENGINE_INVALID', async () => {
  const wrong = lying({
    resize: async () => ({
      data: Buffer.alloc(3),
      info: { width: 1, height: 1, channels: 3 },
    }),
  });
  await assert.rejects(
    renderSize(solid(20, 10, [1, 2, 3]), sizePlan(4, 2), wrong, { limits }),
    (err: ResizeError) => {
      assert.equal(err.code, 'RESIZE_ENGINE_INVALID');
      assert.equal(
        err.message,
        "resize: engine 'liar' broke its contract: the result of resize(): it is 1×1, not 4×2",
      );
      return true;
    },
  );
});

test('an engine that reports SVG, HTML or XML by format, or SVG by contentType, is refused, by name', async () => {
  for (const fields of [
    { format: 'svg' },
    { format: 'SVG' },
    { format: 'svgz' },
    { format: 'html' },
    { format: 'htm' },
    { format: 'xhtml' },
    { format: 'XML' },
    { format: 'webp', contentType: 'IMAGE/SVG+XML' },
  ]) {
    await assert.rejects(
      encodeVariant(
        solid(20, 10, [1, 2, 3]),
        variantPlan(sizePlan(20, 10), 'webp'),
        { ...encodeOptions(), engine: encodedAs(fields) },
      ),
      (err: ResizeError) => {
        assert.equal(err.code, 'RESIZE_SVG_PUBLIC_PREVIEW');
        assert.equal(err.retryable, true);
        assert.match(err.message, /engine 'liar'/);
        assert.match(err.message, /cannot be published as a preview/);
        return true;
      },
      JSON.stringify(fields),
    );
  }
});

test('every id SharpEngine writes passes the checks on its result, at 1 to 4 channels', async () => {
  // `heif` and `heic` have no default compression, so they need one (see the README).
  const needs: Record<string, Record<string, unknown>> = {
    heif: { compression: 'av1' },
    heic: { compression: 'av1' },
  };
  for (const format of engine.formats) {
    for (const colour of [[9], [9, 128], [9, 8, 7], [9, 8, 7, 128]]) {
      const out = await encodeVariant(
        solid(20, 10, colour),
        variantPlan(sizePlan(20, 10), format),
        {
          ...encodeOptions(),
          encode: {
            ...config.encode,
            formats: { [format]: needs[format] ?? {} },
          },
        },
      );
      assert.deepEqual([out.width, out.height], [20, 10], format);
    }
  }
});

test('`heic: {}` fails at render: Sharp has no default compression for it', async () => {
  await assert.rejects(
    encodeVariant(
      solid(20, 10, [9, 8, 7]),
      variantPlan(sizePlan(20, 10), 'heic'),
      {
        ...encodeOptions(),
        encode: { ...config.encode, formats: { heic: {} } },
      },
    ),
    /Expected one of: av1, hevc for compression/,
  );
});

test('an animated encode reports the size of one frame', async () => {
  for (const format of engine.animatedFormats) {
    const out = await encodeVariant(
      threeFrames(),
      variantPlan(sizePlan(20, 20, 'fill', true), format),
      encodeOptions(),
    );
    assert.deepEqual([out.width, out.height], [20, 20], format);
  }
});

test('a later animation frame with another channel count is RESIZE_ENGINE_INVALID, naming the engine', async () => {
  let call = 0;
  const wrong = lying({
    resize: async (_frame, req) => {
      const channels = call === 0 ? 3 : 4;
      call += 1;
      return {
        data: Buffer.alloc(req.width * req.height * channels),
        info: { width: req.width, height: req.height, channels },
      };
    },
  });
  await assert.rejects(
    renderSize(threeFrames(), sizePlan(4, 4, 'fill', true), wrong, { limits }),
    (err: ResizeError) => {
      assert.equal(err.code, 'RESIZE_ENGINE_INVALID');
      assert.equal(err.retryable, true);
      assert.equal(
        err.message,
        "resize: engine 'liar' broke its contract: the result of resize(): frame 1 holds 64 bytes, not 48 like the first frame",
      );
      return true;
    },
  );
});

test('reduceToBox asks for the size one factor gives, and passes the box', async () => {
  for (const [w, h, bw, bh] of [
    [1024, 683, 621, 414],
    [6000, 4000, 3, 999],
    [4000, 6000, 123, 77],
    [997, 601, 97, 61],
  ]) {
    const { info } = await sharp({
      create: { width: w, height: h, channels: 3, background: '#808080' },
    })
      .resize(bw, bh, { fit: 'outside' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const seen: ResizeRequest[] = [];
    const stub = lying({
      resize: async (_frame, req) => {
        seen.push(req);
        return {
          data: Buffer.alloc(req.width * req.height * 3),
          info: { width: req.width, height: req.height, channels: 3 },
        };
      },
    });
    const box = { width: bw, height: bh };
    await reduceToBox(
      { data: Buffer.alloc(0), info: { width: w, height: h, channels: 3 } },
      box,
      stub,
      { limits },
    );
    assert.deepEqual(
      seen,
      [
        {
          width: info.width,
          height: info.height,
          mode: 'fill',
          sharpen: false,
          coverBox: box,
        },
      ],
      `${w}x${h}`,
    );
  }
});

test('a coverBox result may differ from the computed size by a pixel, as long as it covers the box', async () => {
  const frame: Raster = {
    data: Buffer.alloc(60 * 80 * 3),
    info: { width: 60, height: 80, channels: 3 },
  };
  const box = { width: 19, height: 26 };
  const answering = (width: number, height: number) =>
    lying({
      resize: async () => ({
        data: Buffer.alloc(width * height * 3),
        info: { width, height, channels: 3 },
      }),
    });
  // The computed size is 20×26; Sharp's own is 19×26.
  const out = await reduceToBox(frame, box, answering(19, 26), { limits });
  assert.equal(out.info.width, 19);
  for (const [width, height] of [
    [18, 26], // does not cover the box
    [22, 26], // more than a pixel from the computed size
  ]) {
    await assert.rejects(
      reduceToBox(frame, box, answering(width, height), { limits }),
      { code: 'RESIZE_ENGINE_INVALID' },
    );
  }
});

test('straightAlpha is within one level of Sharp on every valid pixel', async () => {
  const pairs: number[] = [];
  for (let alpha = 0; alpha < 256; alpha++) {
    for (let colour = 0; colour <= alpha; colour++) {
      pairs.push(colour, colour, colour, alpha);
    }
  }
  const data = Buffer.from(pairs);
  const raw = { width: data.length / 4, height: 1, channels: 4 as const };
  const viaSharp = await sharp(data, { raw: { ...raw, premultiplied: true } })
    .raw({ depth: 'uchar' })
    .toBuffer();
  const ours = straightAlpha({ data, info: { ...raw, premultiplied: true } });
  assert.equal(ours.info.premultiplied, undefined);
  for (let i = 0; i < data.length; i++) {
    assert.ok(Math.abs(ours.data[i] - viaSharp[i]) <= 1, `byte ${i}`);
  }
});

test('straightAlpha converts grey with alpha, and clamps a colour above its alpha', () => {
  const data = Buffer.from([100, 128, 0, 0, 200, 100]);
  const before = Buffer.from(data);
  const out = straightAlpha({
    data,
    info: { width: 3, height: 1, channels: 2, premultiplied: true },
  });
  assert.deepEqual([...out.data], [199, 128, 0, 0, 255, 100]);
  assert.equal(out.info.channels, 2);
  assert.ok(data.equals(before));
});
