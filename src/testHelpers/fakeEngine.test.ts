// The fakes a no-image-library test rests on: they must refuse what they cannot read, so a test never
// passes on noise.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';
import type { ResizeError } from '../errors.ts';
import { FakePngDecoder } from './fakeDecoder.ts';
import { decodePng, encodePng, FakeEngine } from './fakeEngine.ts';
import { makeImageConfig } from './resizeConfig.ts';

const limits = makeImageConfig().limits;
const good = encodePng({
  data: Buffer.alloc(4 * 4 * 4, 200),
  info: { width: 4, height: 4, channels: 4 },
});
/** The file with one byte changed. */
const withByte = (at: number, value: number) => {
  const copy = Buffer.from(good);
  copy[at] = value;
  return copy;
};
const IEND_TAG = good.length - 8;
/** The file with other rows in its IDAT, and a CRC of zeros, which decodePng does not read. */
const withRows = (rows: Buffer) => {
  const body = deflateSync(rows);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([
    good.subarray(0, 33),
    length,
    Buffer.from('IDAT'),
    body,
    Buffer.alloc(4),
    good.subarray(IEND_TAG - 4),
  ]);
};

test('decodePng reads what encodePng wrote, at every channel count', () => {
  for (const channels of [1, 2, 3, 4] as const) {
    const data = Buffer.alloc(3 * 2 * channels);
    data.forEach((_, i) => {
      data[i] = i * 7;
    });
    const info = { width: 3, height: 2, channels };
    assert.deepEqual(decodePng(encodePng({ data, info })), { data, info });
  }
});

test('decodePng refuses anything else', async () => {
  const fullRows = (16 + 1) * 4;
  // Sanity: the rebuilt file itself reads, so each refusal below is about its rows.
  assert.equal(decodePng(withRows(Buffer.alloc(fullRows))).info.height, 4);
  for (const [name, file] of [
    ['empty', Buffer.alloc(0)],
    ['raw pixels', Buffer.alloc(64, 77)],
    ['a signature byte', withByte(0, 0)],
    ['the IHDR tag', withByte(12, 0)],
    ['bit depth 16', withByte(24, 16)],
    ['a palette', withByte(25, 3)],
    ['the IDAT tag', withByte(37, 0)],
    ['the IEND tag', withByte(IEND_TAG, 0)],
    ['no IEND', good.subarray(0, IEND_TAG - 4)],
    ['cut in the IDAT', good.subarray(0, 50)],
    ['half the rows', withRows(Buffer.alloc(fullRows / 2))],
    ['twice the rows', withRows(Buffer.alloc(fullRows * 2))],
    ['rows with another filter', withRows(Buffer.alloc(fullRows, 4))],
    ['a PNG Sharp wrote', await sharp(good).png().toBuffer()],
  ] as const) {
    assert.throws(() => decodePng(file), /not a file encodePng wrote/, name);
  }
});

test('the fake engine writes a hex background and refuses any other', async () => {
  const engine = new FakeEngine();
  const raster = {
    data: Buffer.from([10, 10, 10, 0]),
    info: { width: 1, height: 1, channels: 4 as const },
  };
  const flattened = async (background: string) => {
    const { data } = await engine.encode(
      raster,
      { format: 'jpeg', options: {}, background },
      { limits },
    );
    return [...decodePng(data).data];
  };
  assert.deepEqual(await flattened('#fff'), [255, 255, 255]);
  assert.deepEqual(await flattened('#102030'), [16, 32, 48]);
  for (const background of ['white', '#ggg', '#ffff', 'ffffff', '']) {
    await assert.rejects(flattened(background), /reads a hex background/);
  }
});

test('the fake decoder refuses bytes that are not its format with the code the contract asks for', async () => {
  const decoder = new FakePngDecoder();
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from([1, 2, 3]),
    Buffer.from([0x89, 0x50, 0x4e]),
    Buffer.alloc(64, 77),
  ]) {
    await assert.rejects(decoder.inspect(bytes), (err: ResizeError) => {
      assert.equal(err.code, 'RESIZE_SOURCE_FORMAT_UNSUPPORTED');
      return true;
    });
  }
  assert.deepEqual(await decoder.inspect(good), {
    format: 'png',
    contentType: 'image/png',
    width: 4,
    height: 4,
    pages: 1,
  });
});
