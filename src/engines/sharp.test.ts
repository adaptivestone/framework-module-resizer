// SharpEngine against Sharp itself: the ids it lists, and what its two operations hand back.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp, { type FormatEnum } from 'sharp';
import type { Raster } from '../contracts/decoder.ts';
import { makeImageConfig } from '../testHelpers/resizeConfig.ts';
import { SharpEngine } from './sharp.ts';

const engine = new SharpEngine();
const opts = { limits: makeImageConfig().limits };
const solid = (width: number, height: number, ...colour: number[]): Raster => ({
  data: Buffer.alloc(width * height * colour.length).map(
    (_, i) => colour[i % colour.length],
  ) as Buffer,
  info: {
    width,
    height,
    channels: colour.length as Raster['info']['channels'],
  },
});
const rawOptions = ({ info: { width, height, channels } }: Raster) => ({
  raw: { width, height, channels },
});

/** Every id Sharp's toFormat() accepts, from its own refusal of an unknown one. */
function acceptedIds(): string[] {
  const image = solid(1, 1, 0, 0, 0);
  try {
    sharp(image.data, rawOptions(image)).toFormat(
      'no-such-format' as keyof FormatEnum,
    );
  } catch (err) {
    const list = /Expected one of: (.*?) for format/.exec(
      (err as Error).message,
    )?.[1];
    if (list) {
      return list.split(', ');
    }
  }
  throw new Error(
    "Sharp's refusal no longer lists its format ids: update this test",
  );
}

test('formats is exactly what toFormat accepts and this build writes', async () => {
  const image = solid(16, 16, 100, 100, 100);
  const accepted = acceptedIds();
  assert.ok(
    accepted.includes('jpg'),
    'sanity check: the list holds the aliases',
  );
  for (const id of accepted) {
    // heif and heic have no default compression; everything else writes with no options.
    const options =
      id === 'heif' || id === 'heic' ? { compression: 'av1' as const } : {};
    // Some ids (jp2 on the prebuilt binaries) are refused by toFormat() itself, so this stays async.
    const write = async () =>
      sharp(image.data, rawOptions(image))
        .toFormat(id as keyof FormatEnum, options)
        .toBuffer();
    const writes = await write().then(
      () => true,
      () => false,
    );
    assert.equal(engine.formats.includes(id), writes, id);
  }
  assert.deepEqual(
    engine.formats.filter((id) => !accepted.includes(id)),
    [],
  );
});

test('formats names the aliases a host may have configured', () => {
  for (const id of ['jpg', 'jpe', 'tif', 'heic', 'tile']) {
    assert.ok(engine.formats.includes(id), id);
  }
});

test('encode under an alias reports the format the bytes are', async () => {
  const out = await engine.encode(
    solid(8, 6, 10, 20, 30),
    { format: 'jpg', options: {} },
    opts,
  );
  assert.deepEqual(
    [out.format, out.contentType, out.width, out.height],
    ['jpeg', 'image/jpeg', 8, 6],
  );
});

test('encode tells AVIF from HEIF', async () => {
  const out = await engine.encode(
    solid(16, 16, 10, 20, 30),
    { format: 'avif', options: { effort: 0 } },
    opts,
  );
  assert.deepEqual([out.format, out.contentType], ['avif', 'image/avif']);
});

test('encode flattens only when it is given a background', async () => {
  const clear = solid(8, 8, 0, 0, 0, 0);
  const flat = await engine.encode(
    clear,
    { format: 'png', options: {}, background: '#ffffff' },
    opts,
  );
  assert.equal((await sharp(flat.data).metadata()).channels, 3);
  const kept = await engine.encode(clear, { format: 'png', options: {} }, opts);
  assert.equal((await sharp(kept.data).metadata()).channels, 4);
});

test("encode writes the frames and timing of an animation, and reports one frame's size", async () => {
  // Different colours: the WebP encoder merges identical frames.
  const frames = [
    solid(8, 6, 200, 20, 30),
    solid(8, 6, 10, 200, 30),
    solid(8, 6, 10, 20, 200),
  ];
  const raster: Raster = {
    data: Buffer.concat(frames.map((f) => f.data)),
    info: { ...frames[0].info, frames: 3, delay: [100, 200], loop: 2 },
  };
  const out = await engine.encode(
    raster,
    { format: 'webp', options: {} },
    opts,
  );
  assert.deepEqual([out.width, out.height], [8, 6]);
  const meta = await sharp(out.data, { pages: -1 }).metadata();
  assert.deepEqual(
    [meta.pages, meta.delay, meta.loop],
    [3, [100, 200, 200], 2],
  );
});

test('resize returns exactly the size asked for, in colour', async () => {
  const out = await engine.resize(
    solid(40, 30, 128),
    { width: 7, height: 9, mode: 'fill', sharpen: false },
    opts,
  );
  assert.deepEqual(
    [out.info.width, out.info.height, out.info.channels],
    [7, 9, 3],
  );
});

test('resize with a coverBox scales by one factor, as the outside fit does', async () => {
  const image = solid(1024, 683, 90, 120, 150);
  image.data.fill(30, 0, 1024 * 3 * 100);
  const box = { width: 620, height: 414 };
  const expected = await sharp(image.data, rawOptions(image))
    .resize(box.width, box.height, { fit: 'outside' })
    .toColorspace('srgb')
    .raw({ depth: 'uchar' })
    .toBuffer();
  const out = await engine.resize(
    image,
    { width: 621, height: 414, mode: 'fill', sharpen: false, coverBox: box },
    opts,
  );
  assert.deepEqual([out.info.width, out.info.height], [621, 414]);
  assert.ok(out.data.equals(expected));
});

test('resize and encode leave their inputs as they were', async () => {
  const image = solid(20, 10, 10, 20, 30, 128);
  const before = Buffer.from(image.data);
  await engine.resize(
    image,
    { width: 5, height: 5, mode: 'cover', sharpen: true },
    opts,
  );
  await engine.encode(
    image,
    { format: 'jpeg', options: {}, background: '#ffffff' },
    opts,
  );
  assert.ok(image.data.equals(before));
});
