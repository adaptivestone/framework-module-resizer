// Test-only: an image engine with no image library. It resizes by nearest neighbour in plain JS and
// writes every format it lists as a real PNG (node:zlib), so a test can read a preview back with
// `decodePng`, or with Sharp. It records every call. It ignores `coverBox`, as the contract allows.
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import type { Raster } from '../contracts/decoder.ts';
import {
  type EncodedImage,
  type EncodeRequest,
  type EngineCallOptions,
  ImageEngine,
  type ResizeRequest,
} from '../contracts/engine.ts';

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const tagged = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tagged));
  return Buffer.concat([len, tagged, crc]);
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const COLOUR_TYPE: Record<number, number> = { 1: 0, 2: 4, 3: 2, 4: 6 };

export function encodePng(r: Raster): Buffer {
  const { width, height, channels, frames = 1 } = r.info;
  const stacked = height * frames;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(stacked, 4);
  ihdr[8] = 8;
  ihdr[9] = COLOUR_TYPE[channels];
  const stride = width * channels;
  const lines = Buffer.alloc((stride + 1) * stacked);
  for (let y = 0; y < stacked; y++) {
    r.data.copy(lines, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(lines, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Reads back only what encodePng writes, and refuses anything else: a test must not read noise. */
export function decodePng(png: Buffer): Raster {
  const refused = new Error('fake: this is not a file encodePng wrote');
  const tagAt = (at: number) => png.toString('latin1', at, at + 4);
  if (
    !png.subarray(0, 8).equals(PNG_SIGNATURE) ||
    tagAt(12) !== 'IHDR' ||
    tagAt(37) !== 'IDAT'
  ) {
    throw refused;
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const channels = (
    { 0: 1, 4: 2, 2: 3, 6: 4 } as Record<number, 1 | 2 | 3 | 4>
  )[png[25]];
  const len = png.readUInt32BE(33);
  if (png[24] !== 8 || channels === undefined || tagAt(49 + len) !== 'IEND') {
    throw refused;
  }
  const lines = inflateSync(png.subarray(41, 41 + len));
  const stride = width * channels;
  if (lines.length !== (stride + 1) * height) {
    throw refused;
  }
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    // encodePng writes filter 0 on every row: any other row is not raw pixels.
    if (lines[y * (stride + 1)] !== 0) {
      throw refused;
    }
    lines.copy(data, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return { data, info: { width, height, channels } };
}

/**
 * A background as `#rgb` or `#rrggbb`, the only spelling this engine reads. The contract also allows
 * a name such as 'white', which this engine refuses, so it never writes a colour nobody asked for.
 */
const parseHex = (css: string): [number, number, number] => {
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(css)) {
    throw new Error(`fake: this engine reads a hex background, not '${css}'`);
  }
  const hex = css.slice(1);
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
};

export class FakeEngine extends ImageEngine {
  readonly id = 'fake';
  readonly formats: readonly string[];
  readonly animatedFormats: readonly string[];
  readonly calls: {
    op: string;
    width: number;
    height: number;
    format?: string;
    background?: string;
    sharpen?: boolean;
    mode?: string;
  }[] = [];

  constructor(opts: { formats?: string[]; animatedFormats?: string[] } = {}) {
    super();
    this.formats = opts.formats ?? ['jpeg', 'png', 'webp', 'avif', 'gif'];
    this.animatedFormats = opts.animatedFormats ?? ['gif', 'webp'];
  }

  async resize(
    frame: Raster,
    req: ResizeRequest,
    _opts: EngineCallOptions,
  ): Promise<Raster> {
    this.calls.push({
      op: 'resize',
      width: req.width,
      height: req.height,
      mode: req.mode,
      sharpen: req.sharpen,
    });
    const { width: sw, height: sh, channels: sc } = frame.info;
    // Grey becomes colour, as the contract says.
    const dc = (sc === 1 ? 3 : sc === 2 ? 4 : sc) as 3 | 4;
    const data = Buffer.alloc(req.width * req.height * dc);
    const cover = req.mode === 'cover';
    const scale = cover ? Math.max(req.width / sw, req.height / sh) : 0;
    const offX = cover ? (sw - req.width / scale) / 2 : 0;
    const offY = cover ? (sh - req.height / scale) / 2 : 0;
    for (let y = 0; y < req.height; y++) {
      const sy = Math.min(
        sh - 1,
        Math.floor(
          cover ? offY + (y + 0.5) / scale : ((y + 0.5) * sh) / req.height,
        ),
      );
      for (let x = 0; x < req.width; x++) {
        const sx = Math.min(
          sw - 1,
          Math.floor(
            cover ? offX + (x + 0.5) / scale : ((x + 0.5) * sw) / req.width,
          ),
        );
        const s = (sy * sw + sx) * sc;
        const d = (y * req.width + x) * dc;
        if (sc >= 3) {
          for (let c = 0; c < sc; c++) {
            data[d + c] = frame.data[s + c];
          }
        } else {
          data[d] = data[d + 1] = data[d + 2] = frame.data[s];
          if (sc === 2) {
            data[d + 3] = frame.data[s + 1];
          }
        }
      }
    }
    return {
      data,
      info: { width: req.width, height: req.height, channels: dc },
    };
  }

  async encode(
    raster: Raster,
    req: EncodeRequest,
    _opts: EngineCallOptions,
  ): Promise<EncodedImage> {
    const { width, height, channels } = raster.info;
    this.calls.push({
      op: 'encode',
      width,
      height,
      format: req.format,
      background: req.background,
    });
    // The contract: a render compares no list, so the engine refuses what it does not write.
    if (!this.formats.includes(req.format)) {
      throw new Error(`fake: this engine does not write ${req.format}`);
    }
    let out = raster;
    if (req.background !== undefined && (channels === 4 || channels === 2)) {
      const bg = parseHex(req.background);
      const dc = channels === 4 ? 3 : 1;
      const data = Buffer.alloc((raster.data.length / channels) * dc);
      for (let i = 0, d = 0; i < raster.data.length; i += channels, d += dc) {
        const a = raster.data[i + channels - 1] / 255;
        for (let c = 0; c < dc; c++) {
          data[d + c] = Math.round(raster.data[i + c] * a + bg[c] * (1 - a));
        }
      }
      out = { data, info: { ...raster.info, channels: dc as 1 | 3 } };
    }
    return {
      data: encodePng(out),
      format: req.format,
      contentType: `image/${req.format}`,
      width,
      height,
    };
  }
}
