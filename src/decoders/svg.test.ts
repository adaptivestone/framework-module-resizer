// SvgDecoder tests: real Sharp and the real render child on tiny in-memory SVGs.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { afterEach, mock, test } from 'node:test';
import sharp from 'sharp';
import { ResizeError } from '../errors.ts';
import { makeImageConfig } from '../testHelpers/resizeConfig.ts';
import { SvgDecoder } from './svg.ts';

const limits = makeImageConfig().limits;

/** An empty SVG with the given `width` and `height` attributes. */
function sizedSvg(width: number | string, height: number | string): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`,
  );
}

const smallSvg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>',
);

// Six turbulence-filtered rects: librsvg needs more than 10 s for this 488-byte SVG, inside one
// native call that sharp's `.timeout()` cannot interrupt.
const heavySvg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><filter id="f" x="0" y="0" width="1" height="1"><feTurbulence baseFrequency="0.02" numOctaves="10"/></filter>${'<rect width="100%" height="100%" filter="url(#f)"/>'.repeat(6)}</svg>`,
);

/** A check for a rejection: a ResizeError with `code` and `retryable: false`. */
function nonRetryable(code: string) {
  return (err: unknown) => {
    assert.ok(ResizeError.isResizeError(err), String(err));
    assert.equal(err.code, code);
    assert.equal(err.retryable, false);
    return true;
  };
}

afterEach(() => {
  mock.restoreAll();
});

test('inspect reports the natural size, the SVG content type and that the source is vector', async () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120px" height="80px" viewBox="0 0 12 8"><rect width="12" height="8"/></svg>',
  );
  assert.deepEqual(await new SvgDecoder().inspect(svg, limits), {
    format: 'svg',
    contentType: 'image/svg+xml',
    width: 120,
    height: 80,
    vector: true,
  });
});

test('inspect keeps a fractional side', async () => {
  const info = await new SvgDecoder().inspect(sizedSvg(1000, 0.6), limits);
  assert.equal(info.width, 1000);
  assert.ok(Math.abs(info.height - 0.6) < 0.01, String(info.height));
});

test('inspect refuses raster bytes with RESIZE_SOURCE_FORMAT_UNSUPPORTED, retryable false', async () => {
  const png = await sharp({
    create: { width: 4, height: 4, channels: 3, background: '#808080' },
  })
    .png()
    .toBuffer();
  await assert.rejects(
    new SvgDecoder().inspect(png, limits),
    nonRetryable('RESIZE_SOURCE_FORMAT_UNSUPPORTED'),
  );
});

test('an SVG without a raster pixel on a side is RESIZE_SVG_DIMENSIONS_UNSUPPORTED, retryable false', async () => {
  const decoder = new SvgDecoder();
  for (const [width, height] of [
    [1, 100000],
    [100000, 1],
    [0.6, 40000],
    [1, 65535],
  ]) {
    await assert.rejects(
      decoder.inspect(sizedSvg(width, height), limits),
      nonRetryable('RESIZE_SVG_DIMENSIONS_UNSUPPORTED'),
      `${width}×${height}`,
    );
  }
  for (const [width, height] of [
    [1, 40000],
    [40000, 1],
    [0.7, 40000],
    [1, 65534],
  ]) {
    const info = await decoder.inspect(sizedSvg(width, height), limits);
    assert.equal(info.format, 'svg', `${width}×${height}`);
  }
});

test('inspect checks limits.sourcePixels before the dimension probe', async () => {
  // 1×100000 is over both limits: the pixel count is what it reports.
  await assert.rejects(
    new SvgDecoder().inspect(sizedSvg(1, 100000), {
      ...limits,
      sourcePixels: 1000,
    }),
    (err) => {
      nonRetryable('RESIZE_SOURCE_TOO_LARGE')(err);
      assert.match(
        (err as Error).message,
        /^resize: SVG 1x100000 exceeds limits\.sourcePixels \(1000\)$/,
      );
      return true;
    },
  );
});

test('render runs one child process and returns RGBA at the box', async () => {
  const decoder = new SvgDecoder();
  const source = await decoder.inspect(smallSvg, limits);
  const spawn = mock.method(childProcess, 'spawn');
  const raster = await decoder.render(
    smallSvg,
    { width: 2000, height: 1000 },
    { limits, source, frames: 1 },
  );
  assert.equal(spawn.mock.callCount(), 1);
  assert.deepEqual(raster.info, { width: 2000, height: 1000, channels: 4 });
  assert.equal(raster.data.length, 2000 * 1000 * 4);
});

test('render never goes below the natural size', async () => {
  const decoder = new SvgDecoder();
  const source = await decoder.inspect(smallSvg, limits);
  const raster = await decoder.render(
    smallSvg,
    { width: 10, height: 5 },
    { limits, source, frames: 1 },
  );
  assert.deepEqual(raster.info, { width: 20, height: 10, channels: 4 });
});

test('a render over limits.processingTimeoutSeconds is RESIZE_SVG_RENDER_TIMEOUT, retryable false, without a media id', {
  timeout: 8000,
}, async () => {
  const decoder = new SvgDecoder();
  const source = await decoder.inspect(heavySvg, limits);
  await assert.rejects(
    decoder.render(
      heavySvg,
      { width: 1000, height: 1000 },
      {
        limits: { ...limits, processingTimeoutSeconds: 1 },
        source,
        frames: 1,
      },
    ),
    (err) => {
      nonRetryable('RESIZE_SVG_RENDER_TIMEOUT')(err);
      assert.equal((err as { mediaId?: unknown }).mediaId, undefined);
      return true;
    },
  );
});
