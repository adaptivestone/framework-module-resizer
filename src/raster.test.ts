// The boundary between a Raster and Sharp: the shape check, and the helpers a Sharp-based
// beforeStep uses to wrap a raster and read one back.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import type { Raster } from './contracts/decoder.ts';
import { ResizeError } from './errors.ts';
import {
  checkRaster,
  rasterProblem,
  rasterToSharp,
  sharpToRaster,
} from './raster.ts';

/** A raster of one solid colour (one value per channel). */
function solid(width: number, height: number, colour: number[]): Raster {
  const channels = colour.length as 1 | 2 | 3 | 4;
  const data = Buffer.alloc(width * height * channels);
  for (let i = 0; i < width * height; i++) {
    data.set(colour, i * channels);
  }
  return { data, info: { width, height, channels } };
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

/** Three 20×20 frames (red, green, blue) as an animated GIF. */
async function threeFrameGif(): Promise<Buffer> {
  const frames = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
  ].map((colour) => solid(20, 20, colour).data);
  return sharp(Buffer.concat(frames), {
    raw: { width: 20, height: 60, channels: 3, pageHeight: 20 },
  })
    .gif({ delay: [100, 200, 300], loop: 3 })
    .toBuffer();
}

test('checkRaster rejects a raster that is not a Raster with RESIZE_DECODER_INVALID', () => {
  const valid = solid(10, 10, [1, 2, 3]);
  assert.equal(rasterProblem(valid), undefined);
  assert.doesNotThrow(() => checkRaster(valid));
  const invalid: unknown[] = [
    { data: Buffer.alloc(299), info: { width: 10, height: 10, channels: 3 } },
    { data: Buffer.alloc(500), info: { width: 10, height: 10, channels: 5 } },
    {
      data: Buffer.alloc(300),
      info: { width: 10, height: 10, channels: 3, frames: 0 },
    },
    { data: Buffer.alloc(150), info: { width: 1.5, height: 10, channels: 3 } },
    {
      data: new Uint8Array(300),
      info: { width: 10, height: 10, channels: 3 },
    },
  ];
  for (const raster of invalid) {
    assert.equal(typeof rasterProblem(raster), 'string');
    assert.throws(
      () => checkRaster(raster as Raster),
      (err) => {
        assert.ok(ResizeError.isResizeError(err));
        assert.equal(err.name, 'ResizeSetupError');
        assert.equal(err.code, 'RESIZE_DECODER_INVALID');
        return true;
      },
    );
  }
});

test('rasterToSharp and sharpToRaster round-trip the pixels', async () => {
  const raster = solid(20, 10, [10, 120, 230]);
  const back = await sharpToRaster(rasterToSharp(raster));
  assert.deepEqual(back.info, { width: 20, height: 10, channels: 3 });
  assert.deepEqual(back.data, raster.data);

  const grey = await sharpToRaster(rasterToSharp(solid(4, 4, [128])));
  assert.equal(grey.info.channels, 3);
  assert.equal(grey.data.length, 4 * 4 * 3);
});

test('sharpToRaster never forwards the premultiplied flag', async () => {
  const raster = solid(40, 30, [100, 50, 200, 128]);
  const back = await sharpToRaster(rasterToSharp(raster).resize(20, 15));
  assert.equal(back.info.width, 20);
  assert.equal(back.info.height, 15);
  assertNear([...back.data.subarray(0, 4)], [100, 50, 200, 128]);
  assert.equal(back.info.premultiplied, undefined);
});

test('sharpToRaster rejects a multi-page image with RESIZE_PIPELINE_STEP_INVALID', async () => {
  await assert.rejects(
    sharpToRaster(sharp(await threeFrameGif(), { animated: true })),
    (err) => {
      assert.ok(ResizeError.isResizeError(err));
      assert.equal(err.name, 'ResizeSetupError');
      assert.equal(err.code, 'RESIZE_PIPELINE_STEP_INVALID');
      assert.match(err.message, /a beforeStep must return one frame/);
      return true;
    },
  );
  // Sharp echoes a requested page count on a still image, which still has one frame.
  const png = await rasterToSharp(solid(8, 8, [1, 2, 3]))
    .png()
    .toBuffer();
  const still = await sharpToRaster(sharp(png, { pages: 3 }));
  assert.deepEqual(still.info, { width: 8, height: 8, channels: 3 });
});
