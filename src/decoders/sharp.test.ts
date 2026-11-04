// SharpDecoder tests: real Sharp on tiny in-memory fixtures built with Sharp itself.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import type { SourceInfo } from '../contracts/decoder.ts';
import { ResizeError } from '../errors.ts';
import { makeImageConfig } from '../testHelpers/resizeConfig.ts';
import type { ResizeFailOn } from '../types.d.ts';
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

test('a file holding only PNG magic bytes stays an engine failure: an empty message is no evidence of damage', async () => {
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await assert.rejects(
    new SharpDecoder().inspect(magic, limits),
    (err: Error) => {
      assert.equal(ResizeError.isResizeError(err), false);
      assert.match(err.message, /the engine gave no detail/);
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

test('render resizes every frame of an animation to the box', async () => {
  const decoder = new SharpDecoder();
  const raster = await decoder.render(
    animatedGif,
    { width: 10, height: 10 },
    { limits, source: await decoder.inspect(animatedGif, limits), frames: 3 },
  );
  assert.equal(raster.info.width, 10);
  assert.equal(raster.info.height, 10);
  assert.equal(raster.info.frames, 3);
  assert.equal(raster.data.length, 10 * 10 * raster.info.channels * 3);
  assert.deepEqual(raster.info.delay, [100, 200, 300]);
  assert.equal(raster.info.loop, 3);
  assertNear(pixelAt(raster, 5, 5, 2).slice(0, 3), [0, 0, 255]);
});

test('a still image asked for several frames renders one consistent frame', async () => {
  const png = await sharp({
    create: { width: 8, height: 8, channels: 3, background: '#00ff00' },
  })
    .png()
    .toBuffer();
  const decoder = new SharpDecoder();
  const source = await decoder.inspect(png, limits);
  // The second source claims three pages: the frame count still comes from the output.
  for (const claimed of [source, { ...source, pages: 3 }]) {
    const raster = await decoder.render(
      png,
      { width: 8, height: 8 },
      { limits, source: claimed, frames: 3 },
    );
    assert.equal(raster.info.frames ?? 1, 1);
    assert.equal(
      raster.data.length,
      raster.info.width * raster.info.height * raster.info.channels,
    );
    assert.equal(raster.info.delay, undefined);
    assert.equal(raster.info.loop, undefined);
  }
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

test('inspect checks one frame of an animation against limits.inputPixels, not the whole stack', async () => {
  // One 20×20 frame is 400 px; the three stacked are 1200.
  const small = { ...limits, inputPixels: 800 };
  const decoder = new SharpDecoder();
  const info = await decoder.inspect(animatedGif, small);
  assert.equal(info.width, 20);
  assert.equal(info.height, 20);
  assert.equal(info.pages, 3);
  assert.equal(info.animated, true);

  const raster = await decoder.render(
    animatedGif,
    { width: 20, height: 20 },
    { limits: small, source: info, frames: 2 },
  );
  assert.equal(raster.info.frames, 2);
  assert.deepEqual(raster.info.delay, [100, 200]);
  assert.equal(raster.info.loop, 3);
  assert.equal(raster.data.length, 20 * 20 * raster.info.channels * 2);
});

// Noise, so a cut falls inside image data instead of in a flat run the codec compressed away.
const noisy = () =>
  sharp({
    create: {
      width: 400,
      height: 300,
      channels: 3,
      background: '#808080',
      noise: { type: 'gaussian', mean: 128, sigma: 60 },
    },
  });

type Format = 'jpeg' | 'png' | 'webp' | 'gif' | 'avif';
const FORMATS: readonly Format[] = ['jpeg', 'png', 'webp', 'gif', 'avif'];
const LEVELS: readonly ResizeFailOn[] = [
  'none',
  'truncated',
  'error',
  'warning',
];

const samples = new Map<Format, Buffer>();
async function sample(format: Format): Promise<Buffer> {
  let bytes = samples.get(format);
  if (bytes === undefined) {
    bytes = await noisy().toFormat(format).toBuffer();
    samples.set(format, bytes);
  }
  return bytes;
}

const firstHalf = (bytes: Buffer): Buffer =>
  bytes.subarray(0, Math.floor(bytes.length / 2));

/** `inspect`, then `render` at 16 px: every place a decoder reads the bytes. */
async function decode(bytes: Buffer, level: ResizeFailOn = 'error') {
  const decoder = new SharpDecoder();
  const at = { ...limits, failOn: level };
  const source = await decoder.inspect(bytes, at);
  return decoder.render(
    bytes,
    { width: 16, height: 16 },
    { limits: at, source, frames: 1 },
  );
}

for (const format of FORMATS) {
  test(`a cut ${format} is RESIZE_SOURCE_DAMAGED; a Sharp upgrade that changes the message fails here`, async () => {
    const decoder = new SharpDecoder();
    const bytes = firstHalf(await sample(format));
    let source: SourceInfo | undefined;
    await assert.rejects(
      (async () => {
        source = await decoder.inspect(bytes, limits);
        await decoder.render(
          bytes,
          { width: 16, height: 16 },
          { limits, source, frames: 1 },
        );
      })(),
      (err: ResizeError) => {
        assert.equal(err.code, 'RESIZE_SOURCE_DAMAGED', err.message);
        assert.equal(err.retryable, false);
        // Only a render ran at limits.failOn, so only a render's message names it.
        if (source === undefined) {
          assert.doesNotMatch(err.message, /failOn/);
        } else {
          assert.match(err.message, /limits\.failOn 'error'/);
        }
        return true;
      },
    );
  });
}

test('a TIFF with flipped bytes is damaged; a cut one is unreadable bytes, not damage', async () => {
  const tiff = await noisy().tiff({ compression: 'lzw' }).toBuffer();
  const flipped = Buffer.from(tiff);
  const middle = Math.floor(flipped.length / 2);
  for (let i = middle; i < middle + 256; i += 1) {
    flipped[i] ^= 0xff;
  }
  await assert.rejects(decode(flipped), (err: ResizeError) => {
    assert.equal(err.code, 'RESIZE_SOURCE_DAMAGED', err.message);
    assert.equal(err.retryable, false);
    return true;
  });
  // A3: on a worker this message means a format with no decoder, so it is never read as damage.
  await assert.rejects(
    new SharpDecoder().inspect(firstHalf(tiff), limits),
    (err: Error) => {
      assert.equal(ResizeError.isResizeError(err), false);
      assert.match(err.message, /unsupported image format/);
      return true;
    },
  );
});

test('a clean image decodes to the same pixels at every failOn level', async () => {
  for (const format of FORMATS) {
    const bytes = await sample(format);
    const baseline = await decode(bytes, 'none');
    for (const level of LEVELS) {
      const raster = await decode(bytes, level);
      assert.deepEqual(raster.info, baseline.info, `${format} at ${level}`);
      assert.ok(raster.data.equals(baseline.data), `${format} at ${level}`);
    }
  }
});

test("failOn 'none' restores 0.3.0's rendering: a cut JPEG renders", async () => {
  const cut = firstHalf(await sample('jpeg'));
  const raster = await decode(cut, 'none');
  assert.equal(raster.info.channels, 3);
  // The chain 0.3.0 ran, with its hard-coded level.
  const reference = await sharp(cut, { failOn: 'none', sequentialRead: true })
    .rotate()
    .resize(16, 16, { fit: 'outside', withoutEnlargement: true })
    .toColorspace('srgb')
    .raw({ depth: 'uchar' })
    .toBuffer();
  assert.ok(raster.data.equals(reference));
});

test("a file whose header cannot be read fails at every level, also at 'none'", async () => {
  // inspect runs metadata() at Sharp's default level, whatever limits.failOn says. On 0.3.0 this
  // was five retries and a dead-letter; now it is dead at once.
  const bytes = firstHalf(await sample('gif'));
  await assert.rejects(
    new SharpDecoder().inspect(bytes, { ...limits, failOn: 'none' }),
    (err: ResizeError) => {
      assert.equal(err.code, 'RESIZE_SOURCE_DAMAGED');
      // inspect did not use limits.failOn, so the message does not name it.
      assert.doesNotMatch(err.message, /failOn/);
      return true;
    },
  );
});

/** A JPEG's first marker of `kind` (0xdb DQT, 0xda SOS), as an index in its bytes. */
function markerAt(jpeg: Buffer, kind: number): number {
  const at = jpeg.indexOf(Buffer.from([0xff, kind]));
  assert.ok(at > 0, `marker 0xff${kind.toString(16)} not found`);
  return at;
}

const inserted = (bytes: Buffer, at: number, extra: Buffer): Buffer =>
  Buffer.concat([bytes.subarray(0, at), extra, bytes.subarray(at)]);

test('harmless JPEG defects render at the default', async () => {
  const jpeg = await sample('jpeg');
  const junk = Buffer.alloc(16, 0x41);
  const intact = await decode(jpeg);
  const defects = {
    'trailing garbage after EOI': Buffer.concat([jpeg, junk]),
    '16 junk bytes before SOS': inserted(jpeg, markerAt(jpeg, 0xda), junk),
    '16 junk bytes before DQT': inserted(jpeg, markerAt(jpeg, 0xdb), junk),
  };
  for (const [name, bytes] of Object.entries(defects)) {
    const raster = await decode(bytes);
    assert.ok(raster.data.equals(intact.data), name);
  }
});

const STRICT_LEVELS: readonly ResizeFailOn[] = [
  'truncated',
  'error',
  'warning',
];
const withoutEndMarker = (jpeg: Buffer): Buffer =>
  jpeg.subarray(0, jpeg.length - 2);

test('a progressive JPEG missing only its end marker is refused at every strict level, and renders at none', async () => {
  // The decoder reads on to the next scan's marker, so it always meets the end of the data.
  const noEnd = withoutEndMarker(
    await noisy().jpeg({ progressive: true }).toBuffer(),
  );
  for (const level of STRICT_LEVELS) {
    await assert.rejects(decode(noEnd, level), (err: ResizeError) => {
      assert.equal(err.code, 'RESIZE_SOURCE_DAMAGED', err.message);
      assert.match(err.message, new RegExp(`limits\\.failOn '${level}'`));
      return true;
    });
  }
  assert.ok((await decode(noEnd, 'none')).data.length > 0);
});

test('a baseline JPEG missing only its end marker gets one answer from every strict level; one that renders has the intact pixels', async () => {
  // Most are refused. A few are not, by their last bytes: measured on 0.35.5, 2 to 13% of random
  // files, because the decoder took the last image data without reading past it.
  for (let i = 0; i < 8; i += 1) {
    const jpeg = await noisy().jpeg().toBuffer();
    const noEnd = withoutEndMarker(jpeg);
    const intact = await decode(jpeg);
    const answers = new Set<boolean>();
    // One at a time: libvips keeps one error buffer per process, so of two failures at once one can
    // get the other's message, or none.
    for (const level of STRICT_LEVELS) {
      try {
        const raster = await decode(noEnd, level);
        assert.ok(raster.data.equals(intact.data), level);
        answers.add(true);
      } catch (err) {
        assert.equal((err as ResizeError).code, 'RESIZE_SOURCE_DAMAGED');
        answers.add(false);
      }
    }
    assert.equal(answers.size, 1);
    assert.ok((await decode(noEnd, 'none')).data.length > 0);
  }
});

test('a healthy TIFF whose compression this build does not implement stays an engine failure', async () => {
  const tiff = Buffer.from(
    await noisy().tiff({ compression: 'none' }).toBuffer(),
  );
  // Sharp writes the byte order this machine uses; tag 259 is Compression, a SHORT held in the entry.
  const littleEndian = tiff.toString('latin1', 0, 2) === 'II';
  const u16 = (at: number) =>
    littleEndian ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
  const ifd = littleEndian ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4);
  let patched = false;
  for (let i = 0; i < u16(ifd); i += 1) {
    const entry = ifd + 2 + i * 12;
    if (u16(entry) === 259) {
      if (littleEndian) {
        tiff.writeUInt16LE(33003, entry + 8);
      } else {
        tiff.writeUInt16BE(33003, entry + 8);
      }
      patched = true;
    }
  }
  assert.ok(patched, 'tag 259 not found');
  await assert.rejects(decode(tiff), (err: Error) => {
    assert.equal(ResizeError.isResizeError(err), false);
    assert.match(err.message, /not implemented/);
    return true;
  });
});

test('inspect and render report the pixel limit as RESIZE_SOURCE_TOO_LARGE', async () => {
  const decoder = new SharpDecoder();
  const small = { ...limits, inputPixels: 100 };
  const isTooLarge = (err: ResizeError) => {
    assert.equal(err.code, 'RESIZE_SOURCE_TOO_LARGE', err.message);
    assert.equal(err.retryable, false);
    assert.match(err.message, /pixel limit limits\.inputPixels \(100\)/);
    return true;
  };
  await assert.rejects(decoder.inspect(wideJpeg, small), isTooLarge);
  const source = await decoder.inspect(wideJpeg, limits);
  await assert.rejects(
    decoder.render(
      wideJpeg,
      { width: 16, height: 16 },
      { limits: small, source, frames: 1 },
    ),
    isTooLarge,
  );
});
