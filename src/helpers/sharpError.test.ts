// The messages are real, measured on Sharp 0.35.5. What a Sharp upgrade changes shows up in
// src/decoders/sharp.test.ts, which damages real files.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResizeError, ResizeMediaError } from '../errors.ts';
import {
  engineDetail,
  isEngineDamage,
  isUnsupportedBytes,
  sharpDecodeError,
} from './sharpError.ts';

const damaged = [
  'VipsJpeg: premature end of JPEG image',
  'VipsJpeg: Invalid progressive/lossless parameters Ss=0 Se=63 Ah=0 Al=0',
  'vipspng: libpng read error',
  'webp2vips: unable to read pixels',
  'tiff2vips: Using code not yet in table',
  'Input buffer has corrupt header: VipsJpeg: premature end of JPEG image',
  'Input buffer has corrupt header: webp: unable to parse image',
  'Input buffer has corrupt header: gifload_buffer: Invalid frame data',
  'Input buffer has corrupt header: heif: Invalid input: Unexpected end of file (2.100)',
  'Input buffer has corrupt header: glib: XML parse error: Error domain 1 code 76 on line 1',
  'Input buffer has corrupt header: svgload_buffer: bad dimensions',
  'source: bad seek to 11724\nsource: bad seek to 5987\nheif: Invalid input: Unexpected end of file: Extent in iloc box references data outside of file bounds (points to file position 250)\n (2.100)',
];
const notDamaged = [
  // A healthy file this build cannot decode. The first two were measured with crafted healthy files.
  'source: bad seek to 1024\nsource: bad seek to 512\nheif: Error while loading plugin: Support for this compression format has not been built in: HEVC (a suitable decoder plugin is libde265) (11.6003)',
  'Input buffer has corrupt header: VipsJpeg: Unsupported JPEG process: SOF type 0xc5\nVipsJpeg: Unsupported JPEG process: SOF type 0xc5',
  'heif: Unsupported feature: Unsupported codec (4.3000)',
  // Measured with patched headers on healthy files: JPEG sampling Y 3x1 / Cb 2x1, TIFF compression
  // 34712, 50002 and 33003, a JPEG 65530 pixels wide (at inspect, so with the prefix).
  'VipsJpeg: Fractional sampling not implemented yet',
  'tiff2vips: Compression scheme 34712 strip decoding is not implemented',
  'tiff2vips: Compression scheme 50002 strip decoding is not implemented',
  'tiff2vips: Compression scheme 33003 strip decoding is not implemented',
  'Input buffer has corrupt header: VipsJpeg: Maximum supported image dimension is 65500 pixels',
  // Not measured: a codec left out of the build.
  'tiff2vips: LZMA compression support omitted at compile time',
  // A format this process has no decoder for: must stay RESIZE_DECODER_MISSING (A3).
  'Input buffer contains unsupported image format',
  // The prefix with nothing after it: another decode that failed at the same moment can have
  // emptied libvips's error buffer, so this says nothing about these bytes.
  'Input buffer has corrupt header:',
  'Input buffer has corrupt header: ',
  'Input buffer has corrupt header: the engine gave no detail',
  // A seek line alone, for the same reason: the line after it can be gone. No truncation depends on
  // it: 14 files, each cut at 201 points and read at four levels, always had a line after it.
  'source: bad seek to 149238',
  'Input buffer has corrupt header: source: bad seek to 1024',
  // Not about the bytes.
  'timeout: 1% complete\nVipsImage: killed for image "temp-57"',
  'Unknown error',
  'VipsJpeg: out of order read at line 1200',
  'VipsJpeg: Insufficient memory (case 4)',
];
for (const m of damaged) {
  test(`damage: ${m.slice(0, 50)}`, () => {
    assert.equal(isEngineDamage(m), true);
  });
}
for (const m of notDamaged) {
  test(`not damage: ${m.slice(0, 50)}`, () => {
    assert.equal(isEngineDamage(m), false);
  });
}

test('engineDetail skips seek noise and the corrupt-header prefix', () => {
  assert.match(engineDetail(damaged.at(-1) as string), /^heif: Invalid input/);
  assert.equal(
    engineDetail(
      'Input buffer has corrupt header: webp: unable to parse image',
    ),
    'webp: unable to parse image',
  );
  assert.equal(engineDetail('source: bad seek to 1'), 'source: bad seek to 1');
});

test('any line of the message can clear a file, not only the line engineDetail reads', () => {
  assert.equal(
    isEngineDamage(
      'VipsJpeg: premature end of JPEG image\ntiff2vips: Compression scheme 33003 strip decoding is not implemented',
    ),
    false,
  );
  assert.equal(
    isEngineDamage(
      'source: bad seek to 1\nVipsJpeg: premature end of JPEG image\nheif: Unsupported feature: Unsupported codec (4.3000)',
    ),
    false,
  );
});

test('isUnsupportedBytes names only the message for bytes no loader recognises', () => {
  assert.equal(
    isUnsupportedBytes('Input buffer contains unsupported image format'),
    true,
  );
  assert.equal(
    isUnsupportedBytes('VipsJpeg: premature end of JPEG image'),
    false,
  );
});

test('sharpDecodeError maps damage and the pixel limit, and returns anything else unchanged', () => {
  const limits = { failOn: 'error', inputPixels: 100 } as const;
  const engine = new Error('VipsJpeg: premature end of JPEG image');
  const damage = sharpDecodeError(engine, limits) as ResizeError;
  assert.ok(damage instanceof ResizeMediaError);
  assert.equal(damage.code, 'RESIZE_SOURCE_DAMAGED');
  assert.equal(damage.retryable, false);
  assert.equal(damage.cause, engine);
  assert.equal(
    damage.message,
    "resize: the source is damaged (limits.failOn 'error'): VipsJpeg: premature end of JPEG image",
  );
  const limit = new Error('Input image exceeds pixel limit');
  const big = sharpDecodeError(limit, limits) as ResizeError;
  assert.ok(big instanceof ResizeMediaError);
  assert.equal(big.code, 'RESIZE_SOURCE_TOO_LARGE');
  assert.equal(big.retryable, false);
  assert.equal(big.cause, limit);
  assert.equal(
    big.message,
    'resize: the source exceeds the pixel limit limits.inputPixels (100)',
  );
  for (const raw of [
    new Error('Unknown error'),
    'text',
    new ResizeError('x'),
  ]) {
    assert.equal(sharpDecodeError(raw, limits), raw);
  }
});

test('sharpDecodeError names limits.failOn only when it is given: inspect did not use it', () => {
  const header = new Error(
    'Input buffer has corrupt header: webp: unable to parse image',
  );
  const damage = sharpDecodeError(header, { inputPixels: 100 }) as ResizeError;
  assert.equal(damage.code, 'RESIZE_SOURCE_DAMAGED');
  assert.equal(damage.retryable, false);
  assert.equal(
    damage.message,
    'resize: the source is damaged: webp: unable to parse image',
  );
  const big = sharpDecodeError(new Error('Input image exceeds pixel limit'), {
    inputPixels: 100,
  }) as ResizeError;
  assert.equal(big.code, 'RESIZE_SOURCE_TOO_LARGE');
});

test('sharpDecodeError leaves an empty corrupt-header message the engine failure it is, and says so', () => {
  const limits = { failOn: 'error', inputPixels: 100 } as const;
  const engine = new Error('Input buffer has corrupt header: ');
  assert.equal(sharpDecodeError(engine, limits), engine);
  assert.equal(
    engine.message,
    'Input buffer has corrupt header: the engine gave no detail',
    // A seek line alone, for the same reason: the line after it can be gone. No truncation depends on
    // it: 14 files, each cut at 201 points and read at four levels, always had a line after it.
    'source: bad seek to 149238',
    'Input buffer has corrupt header: source: bad seek to 1024',
  );
  // Any other message keeps its text: only the bare prefix has nothing to say.
  const unknown = new Error('Unknown error');
  assert.equal(sharpDecodeError(unknown, limits), unknown);
  assert.equal(unknown.message, 'Unknown error');
});
