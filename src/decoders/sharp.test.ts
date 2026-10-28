// SharpDecoder tests: real Sharp on tiny in-memory fixtures built with Sharp itself.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { ResizeError } from '../errors.ts';
import { makeImageConfig } from '../testHelpers/resizeConfig.ts';
import { SharpDecoder } from './sharp.ts';

const limits = makeImageConfig().limits;

// 64×48 stored, EXIF orientation 6: displayed 48×64.
const orientedJpeg = await sharp({
  create: { width: 64, height: 48, channels: 3, background: '#0080ff' },
})
  .jpeg()
  .withMetadata({ orientation: 6 })
  .toBuffer();

const wideJpeg = await sharp({
  create: { width: 600, height: 400, channels: 3, background: '#808080' },
})
  .jpeg()
  .toBuffer();

/** Raw RGB frames of one solid colour each, stacked top to bottom (Sharp's animation layout). */
function solidFrames(colours: number[][], width: number, height: number) {
  return Buffer.concat(
    colours.map((colour) => {
      const frame = Buffer.alloc(width * height * 3);
      for (let i = 0; i < width * height; i++) {
        frame.set(colour, i * 3);
      }
      return frame;
    }),
  );
}

// Three 20×20 frames: red, green, blue.
const animatedGif = await sharp(
  solidFrames(
    [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ],
    20,
    20,
  ),
  { raw: { width: 20, height: 60, channels: 3, pageHeight: 20 } },
)
  .gif({ delay: [100, 200, 300], loop: 3 })
  .toBuffer();

const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
);

/** The pixel at (x, y) of frame `frame` in a raster, as an array of its channels. */
function pixelAt(
  raster: {
    data: Buffer;
    info: { width: number; height: number; channels: number };
  },
  x: number,
  y: number,
  frame = 0,
): number[] {
  const { width, height, channels } = raster.info;
  const offset = ((frame * height + y) * width + x) * channels;
  return [...raster.data.subarray(offset, offset + channels)];
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

test('formats are the raster formats Sharp reads from a buffer, without svg and raw', () => {
  const { formats } = new SharpDecoder();
  for (const format of ['jpeg', 'png', 'webp', 'gif', 'tiff', 'heif', 'avif']) {
    assert.ok(formats.includes(format), `formats include ${format}`);
  }
  assert.ok(!formats.includes('svg'));
  assert.ok(!formats.includes('raw'));
});

test('inspect reports the format, content type and display size of an EXIF-rotated JPEG', async () => {
  const info = await new SharpDecoder().inspect(orientedJpeg, limits);
  assert.deepEqual(info, {
    format: 'jpeg',
    contentType: 'image/jpeg',
    width: 48,
    height: 64,
    pages: 1,
    animated: false,
  });
});

test('inspect reports one frame of an animation, its page count, and that it animates', async () => {
  const info = await new SharpDecoder().inspect(animatedGif, limits);
  assert.equal(info.format, 'gif');
  assert.equal(info.width, 20);
  assert.equal(info.height, 20);
  assert.equal(info.pages, 3);
  assert.equal(info.animated, true);
});

test('inspect names an AVIF container avif', async () => {
  const avif = await sharp({
    create: { width: 8, height: 8, channels: 3, background: '#ff0000' },
  })
    .avif()
    .toBuffer();
  const info = await new SharpDecoder().inspect(avif, limits);
  assert.equal(info.format, 'avif');
  assert.equal(info.contentType, 'image/avif');
});

test('inspect refuses SVG bytes with RESIZE_SOURCE_FORMAT_UNSUPPORTED, retryable false', async () => {
  await assert.rejects(new SharpDecoder().inspect(svg, limits), (err) => {
    assert.ok(ResizeError.isResizeError(err));
    assert.equal(err.code, 'RESIZE_SOURCE_FORMAT_UNSUPPORTED');
    assert.equal(err.retryable, false);
    return true;
  });
});

test("inspect rethrows Sharp's own error for bytes Sharp cannot read", async () => {
  await assert.rejects(
    new SharpDecoder().inspect(Buffer.from('not an image'), limits),
    (err) => {
      assert.equal(ResizeError.isResizeError(err), false);
      return true;
    },
  );
});

test('inspect applies limits.inputPixels', async () => {
  await assert.rejects(
    new SharpDecoder().inspect(orientedJpeg, { ...limits, inputPixels: 100 }),
    /pixel limit/,
  );
});

test('render decodes upright at the box as 8-bit sRGB', async () => {
  const decoder = new SharpDecoder();
  const wide = await decoder.render(
    wideJpeg,
    { width: 180, height: 120 },
    { limits, source: await decoder.inspect(wideJpeg, limits), frames: 1 },
  );
  assert.equal(wide.info.width, 180);
  assert.equal(wide.info.height, 120);
  assert.equal(wide.info.channels, 3);
  assert.equal(wide.data.length, 180 * 120 * 3);

  const upright = await decoder.render(
    orientedJpeg,
    { width: 48, height: 64 },
    { limits, source: await decoder.inspect(orientedJpeg, limits), frames: 1 },
  );
  assert.equal(upright.info.width, 48);
  assert.equal(upright.info.height, 64);
});

test('render never enlarges a raster', async () => {
  const decoder = new SharpDecoder();
  const raster = await decoder.render(
    orientedJpeg,
    { width: 1000, height: 1000 },
    { limits, source: await decoder.inspect(orientedJpeg, limits), frames: 1 },
  );
  // Stored 64×48 with orientation 6: the upright raster is 48×64, never larger.
  assert.equal(raster.info.width, 48);
  assert.equal(raster.info.height, 64);
});

test('render keeps the frames, delays and loop count it is asked for', async () => {
  const decoder = new SharpDecoder();
  const raster = await decoder.render(
    animatedGif,
    { width: 20, height: 20 },
    { limits, source: await decoder.inspect(animatedGif, limits), frames: 3 },
  );
  assert.equal(raster.info.frames, 3);
  assert.equal(raster.info.width, 20);
  assert.equal(raster.info.height, 20);
  assert.deepEqual(raster.info.delay, [100, 200, 300]);
  assert.equal(raster.info.loop, 3);
  assert.equal(raster.data.length, 20 * 20 * raster.info.channels * 3);
  assertNear(pixelAt(raster, 10, 10, 1).slice(0, 3), [0, 255, 0]);
});

test('render with frames 1 gives the first frame only', async () => {
  const decoder = new SharpDecoder();
  const raster = await decoder.render(
    animatedGif,
    { width: 20, height: 20 },
    { limits, source: await decoder.inspect(animatedGif, limits), frames: 1 },
  );
  assert.equal(raster.info.height, 20);
  assert.equal(raster.info.frames ?? 1, 1);
  assert.equal(raster.data.length, 20 * 20 * raster.info.channels);
  assertNear(pixelAt(raster, 10, 10).slice(0, 3), [255, 0, 0]);
});

test('a semi-transparent PNG renders at a resizing box with its colours, not marked premultiplied', async () => {
  const png = await sharp({
    create: {
      width: 40,
      height: 30,
      channels: 4,
      background: { r: 100, g: 50, b: 200, alpha: 128 / 255 },
    },
  })
    .png()
    .toBuffer();
  const decoder = new SharpDecoder();
  const raster = await decoder.render(
    png,
    { width: 20, height: 15 },
    { limits, source: await decoder.inspect(png, limits), frames: 1 },
  );
  assert.equal(raster.info.channels, 4);
  assert.equal(raster.info.premultiplied, undefined);
  assertNear(pixelAt(raster, 0, 0), [100, 50, 200, 128]);
});

test('render converts a P3-tagged JPEG to sRGB as one Sharp pipeline does', async () => {
  const p3 = await sharp({
    create: {
      width: 40,
      height: 40,
      channels: 3,
      background: { r: 200, g: 40, b: 40 },
    },
  })
    .jpeg()
    .withIccProfile('p3')
    .toBuffer();
  const decoder = new SharpDecoder();
  const raster = await decoder.render(
    p3,
    { width: 20, height: 20 },
    { limits, source: await decoder.inspect(p3, limits), frames: 1 },
  );
  const reference = await sharp(p3)
    .rotate()
    .resize(20, 20)
    .toColorspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  assertNear(pixelAt(raster, 10, 10), pixelAt(reference, 10, 10));
});
