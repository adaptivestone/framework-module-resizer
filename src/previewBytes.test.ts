// The files a render writes. Each case spells out, with Sharp itself, the chain that wrote the files
// of 0.3.0, and compares its bytes with what `generate()` uploads. Both sides run in one process on
// one Sharp, so a Sharp upgrade moves them together: this fails only when the module's chain changes.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import sharp, {
  type FormatEnum,
  type OutputOptions,
  type Sharp,
  type SharpOptions,
} from 'sharp';
import type { DecodeBox, Raster, RasterInfo } from './contracts/decoder.ts';
import type { Pipeline } from './contracts/pipeline.ts';
import { Resizer, resetResizerForTests } from './resizer.ts';
import { fakeMedia, memoryStorage } from './testHelpers/fakes.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import type { MediaLike, Preview, SizeInput } from './types.d.ts';

sharp.concurrency(1); // AVIF bytes depend on the thread count; a test file has its own process
afterEach(resetResizerForTests);

const config = makeImageConfig({
  animated: true,
  formats: ['jpeg', 'webp', 'png', 'avif'],
  encode: {
    formats: {
      jpeg: { quality: 88, mozjpeg: true, chromaSubsampling: '4:2:0' },
      webp: { quality: 82, effort: 2 },
      png: {},
      avif: { quality: 64, effort: 2 },
      gif: {},
    },
  },
});
const { limits, encode } = config;
const timeout = { seconds: limits.processingTimeoutSeconds };
const ALL = ['jpeg', 'webp', 'png', 'avif'];
const STILL = ['jpeg', 'webp'];

interface Geometry {
  width: number;
  height: number;
  fit: 'fill' | 'cover';
  sharpen: boolean;
}

const input = ({ data, info }: Raster): [Buffer, SharpOptions] => {
  const { width, height, channels, frames = 1 } = info;
  const raw = {
    width,
    height: height * frames,
    channels,
    ...(frames > 1 ? { pageHeight: height } : {}),
  };
  return [data, { raw, limitInputPixels: width * height * frames }];
};

async function rawOf(img: Sharp): Promise<Raster> {
  const { data, info } = await img
    .timeout(timeout)
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  return {
    data,
    info: {
      width: info.width,
      height: info.height,
      channels: info.channels as RasterInfo['channels'],
    },
  };
}

function resizedAsBefore(frame: Raster, g: Geometry): Promise<Raster> {
  const img = sharp(...input(frame))
    .resize(g.width, g.height, { fit: g.fit, position: 'center' })
    .toColorspace('srgb');
  return rawOf(g.sharpen ? img.sharpen() : img);
}

function encodedAsBefore(raster: Raster, format: string): Promise<Buffer> {
  const { channels, frames = 1, delay, loop } = raster.info;
  const img = sharp(...input(raster));
  const flat =
    (channels === 2 || channels === 4) &&
    encode.flatten.formats.includes(format);
  const options = {
    ...(frames > 1 ? { delay, loop } : {}),
    ...encode.formats[format],
  } as OutputOptions;
  return (flat ? img.flatten({ background: encode.flatten.background }) : img)
    .toFormat(format as keyof FormatEnum, options)
    .timeout(timeout)
    .toBuffer();
}

/** Fixed photo-like pixels: gradients and a little noise; the fourth channel is half transparent. */
function pixels(width: number, height: number, channels: 1 | 3 | 4): Buffer {
  const data = Buffer.alloc(width * height * channels);
  let seed = 12345;
  for (let i = 0; i < data.length; i++) {
    const c = i % channels;
    const x = Math.floor(i / channels) % width;
    const y = Math.floor(i / channels / width);
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] =
      c === 3
        ? x < width / 2
          ? 128
          : 255
        : 128 +
          60 * Math.sin(x / 17 + c) +
          50 * Math.cos(y / 23 - c) +
          ((seed >> 16) & 15);
  }
  return data;
}
const image = (width: number, height: number, channels: 1 | 3 | 4): Sharp =>
  sharp(pixels(width, height, channels), { raw: { width, height, channels } });

/** What generate() uploads, by `sizeKey:format`. */
async function uploaded(
  body: Buffer,
  sizes: SizeInput[],
  formats: string[],
  pipeline: Pipeline = {},
) {
  const { storage, files } = memoryStorage();
  const doc: MediaLike = { id: 'm1', previews: [] };
  const resizer = new Resizer({
    storage,
    media: fakeMedia({
      load: async () => doc,
      appendPreviews: async (_id: string, rows: Preview[]) => rows,
    }),
    config,
    logger: { info() {}, warn() {}, error: console.error },
    pipelines: { default: pipeline },
  });
  doc.original = await resizer.uploadOriginal({ body, visibility: 'private' });
  const { created, failed } = await resizer.generate({
    media: doc,
    sizes,
    formats,
  });
  assert.equal(failed, 0);
  return new Map(
    created.map((row) => [
      `${row.sizeKey}:${row.format}`,
      files.get((row.storageRef as { key: string }).key) as Buffer,
    ]),
  );
}

/**
 * The decode of 0.3.0. Its `failOn: 'none'` is `limits.failOn` since 0.4.0; every source here is
 * healthy, so the level changes no byte.
 */
async function decoded(
  bytes: Buffer,
  box: DecodeBox,
  frames = 1,
): Promise<Raster> {
  const img = sharp(bytes, {
    failOn: 'none',
    sequentialRead: true,
    limitInputPixels: limits.inputPixels,
    pages: frames,
  });
  const { data, info } = await rawOf(
    (frames === 1 ? img.rotate() : img)
      .resize(box.width, box.height, {
        fit: 'outside',
        withoutEnlargement: true,
      })
      .toColorspace('srgb'),
  );
  return { data, info: { ...info, height: info.height / frames } };
}

async function assertSame(
  files: Map<string, Buffer>,
  key: string,
  raster: Raster,
  formats: string[],
) {
  for (const format of formats) {
    const actual = files.get(`${key}:${format}`);
    assert.ok(
      actual,
      `no file for ${key}:${format}; have ${[...files.keys()].join(' ')}`,
    );
    const expected = await encodedAsBefore(raster, format);
    assert.ok(
      actual.equals(expected),
      `${key}:${format}: ${actual.length} bytes differ from the chain's ${expected.length}`,
    );
  }
}

const fill = (width: number, height: number): Geometry => ({
  width,
  height,
  fit: 'fill',
  sharpen: true,
});
const cover = (width: number, height: number): Geometry => ({
  width,
  height,
  fit: 'cover',
  sharpen: true,
});

test('no steps, a JPEG: width, height, cover and fit sizes', async () => {
  const bytes = await image(1024, 683, 3).jpeg({ quality: 90 }).toBuffer();
  const files = await uploaded(
    bytes,
    [
      { width: 320 },
      { height: 199 },
      { width: 200, height: 200 },
      { fit: true },
    ],
    ALL,
  );
  const base = await decoded(bytes, { width: 1024, height: 683 });
  await assertSame(
    files,
    '320w',
    await resizedAsBefore(base, fill(320, 213)),
    ALL,
  );
  await assertSame(
    files,
    '199h',
    await resizedAsBefore(base, fill(298, 199)),
    ALL,
  );
  await assertSame(
    files,
    '200x200',
    await resizedAsBefore(base, cover(200, 200)),
    ALL,
  );
  await assertSame(files, 'fit', base, ALL);
});

test('no steps, one small size: the decoder shrinks to its box', async () => {
  const bytes = await image(1024, 683, 3).jpeg({ quality: 90 }).toBuffer();
  const files = await uploaded(bytes, [{ width: 620 }], STILL);
  await assertSame(
    files,
    '620w',
    await resizedAsBefore(
      await decoded(bytes, { width: 621, height: 414 }),
      fill(620, 414),
    ),
    STILL,
  );
});

test('no steps, a portrait JPEG: cover crops top and bottom, on a box that rounds', async () => {
  // Box 19×26 on 60×80, a shrink of more than 2: the fit decides 26 over 25, and the JPEG loader
  // shrinks on load.
  const bytes = await image(60, 80, 3).jpeg({ quality: 90 }).toBuffer();
  const files = await uploaded(bytes, [{ width: 19, height: 19 }], STILL);
  const base = await decoded(bytes, { width: 19, height: 26 });
  assert.equal(base.info.height, 26);
  await assertSame(
    files,
    '19x19',
    await resizedAsBefore(base, cover(19, 19)),
    STILL,
  );
});

test('no steps, an EXIF-rotated JPEG comes out upright', async () => {
  const bytes = await image(80, 60, 3)
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 90 })
    .toBuffer();
  const files = await uploaded(bytes, [{ width: 45 }], STILL);
  const base = await decoded(bytes, { width: 45, height: 60 });
  assert.equal(base.info.height, 60);
  await assertSame(
    files,
    '45w',
    await resizedAsBefore(base, fill(45, 60)),
    STILL,
  );
});

test('no steps, a transparent PNG: JPEG is flattened, the others keep alpha', async () => {
  const bytes = await image(640, 480, 4).png().toBuffer();
  const files = await uploaded(
    bytes,
    [{ width: 320 }, { width: 200, height: 200 }, { fit: true }],
    ALL,
  );
  const base = await decoded(bytes, { width: 640, height: 480 });
  await assertSame(
    files,
    '320w',
    await resizedAsBefore(base, fill(320, 240)),
    ALL,
  );
  await assertSame(
    files,
    '200x200',
    await resizedAsBefore(base, cover(200, 200)),
    ALL,
  );
  await assertSame(files, 'fit', base, ALL);
});

test('no steps, a grey PNG comes out as colour', async () => {
  const bytes = await image(640, 480, 1).png().toBuffer();
  const files = await uploaded(bytes, [{ width: 320 }], STILL);
  await assertSame(
    files,
    '320w',
    await resizedAsBefore(
      await decoded(bytes, { width: 320, height: 240 }),
      fill(320, 240),
    ),
    STILL,
  );
});

test('no steps, a small source keeps its own size and is not resized', async () => {
  const bytes = await image(150, 100, 3).jpeg({ quality: 90 }).toBuffer();
  const files = await uploaded(bytes, [{ width: 300, height: 300 }], STILL);
  await assertSame(
    files,
    '300x300',
    await decoded(bytes, { width: 150, height: 100 }),
    STILL,
  );
});

test('no steps, an animation: WebP and GIF keep the frames, JPEG gets the first', async () => {
  const frame = (red: number): Buffer => {
    const data = pixels(64, 48, 3);
    for (let i = 0; i < data.length; i += 3) {
      data[i] = red;
    }
    return data;
  };
  const stack = Buffer.concat([frame(255), frame(128), frame(0)]);
  const bytes = await sharp(stack, {
    raw: { width: 64, height: 144, channels: 3, pageHeight: 48 },
  })
    .gif({ delay: [100, 200, 300], loop: 3 })
    .toBuffer();
  const files = await uploaded(bytes, [{ width: 32 }], ['webp', 'gif', 'jpeg']);
  const base = await decoded(bytes, { width: 32, height: 24 }, 3);
  const { width, height, channels } = base.info;
  const frameBytes = width * height * channels;
  const frames: Raster[] = [];
  for (let i = 0; i < 3; i++) {
    const data = base.data.subarray(i * frameBytes, (i + 1) * frameBytes);
    frames.push(
      await resizedAsBefore(
        { data, info: { width, height, channels } },
        fill(32, 24),
      ),
    );
  }
  const animated = {
    data: Buffer.concat(frames.map((f) => f.data)),
    info: { ...frames[0].info, frames: 3, delay: [100, 200, 300], loop: 3 },
  };
  await assertSame(files, '32w', animated, ['webp', 'gif']);
  await assertSame(files, '32w', frames[0], ['jpeg']);
});

test('beforeSteps: the reduction to the box scales both axes by one factor', async () => {
  const identity = { beforeSteps: [async (r: Raster) => r] };
  const wide = await image(1024, 683, 3).jpeg({ quality: 90 }).toBuffer();
  let files = await uploaded(wide, [{ width: 620 }], STILL, identity);
  let source = await decoded(wide, { width: 1024, height: 683 });
  let reduced = await rawOf(
    sharp(...input(source))
      .resize(621, 414, { fit: 'outside' })
      .toColorspace('srgb'),
  );
  await assertSame(
    files,
    '620w',
    await resizedAsBefore(reduced, fill(620, 414)),
    STILL,
  );

  resetResizerForTests();
  const large = await image(1200, 800, 3).jpeg({ quality: 90 }).toBuffer();
  files = await uploaded(
    large,
    [{ width: 3, height: 199 }],
    ['webp'],
    identity,
  );
  source = await decoded(large, { width: 1200, height: 800 });
  reduced = await rawOf(
    sharp(...input(source))
      .resize(299, 199, { fit: 'outside' })
      .toColorspace('srgb'),
  );
  await assertSame(
    files,
    '3x199',
    await resizedAsBefore(reduced, cover(3, 199)),
    ['webp'],
  );
});

test("beforeSteps: a side Sharp's outside fit rounds its own way keeps Sharp's size", async () => {
  // Box 19×26 on 60×80 is exact on the height and a half on the width (19.5): Sharp gives 19×26,
  // where Math.round gives 20×26. The same happens on 4032×3024 with { width: 1033 }.
  const identity = { beforeSteps: [async (r: Raster) => r] };
  const portrait = await image(60, 80, 3).jpeg({ quality: 90 }).toBuffer();
  const files = await uploaded(portrait, [{ width: 19 }], STILL, identity);
  const source = await decoded(portrait, { width: 60, height: 80 });
  const reduced = await rawOf(
    sharp(...input(source))
      .resize(19, 26, { fit: 'outside' })
      .toColorspace('srgb'),
  );
  assert.equal(reduced.info.width, 19);
  assert.equal(reduced.info.height, 26);
  await assertSame(
    files,
    '19w',
    await resizedAsBefore(reduced, fill(19, 25)),
    STILL,
  );
});
