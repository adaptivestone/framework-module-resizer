// The boundary between a Raster and Sharp: the shape check for rasters that decoders and steps
// return, the raw input options, and the read-back of Sharp's raw output. Every conversion between
// the two lives here, so the engine can later be put behind a port at this one place.
import sharp, { type Sharp, type SharpOptions } from 'sharp';
import type { Raster, RasterInfo } from './contracts/decoder.ts';
import { ResizeSetupError } from './errors.ts';
import type { ResizeLimits } from './types.d.ts';

const isPositiveInteger = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n > 0;

/** Why `value` is not a Raster, or undefined when it is one. */
export function rasterProblem(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return 'it is not an object';
  }
  const { data, info } = value as { data?: unknown; info?: unknown };
  if (!Buffer.isBuffer(data)) {
    return '`data` is not a Buffer';
  }
  if (typeof info !== 'object' || info === null) {
    return '`info` is not an object';
  }
  const { width, height, channels, frames = 1 } = info as RasterInfo;
  for (const [name, n] of Object.entries({ width, height, channels, frames })) {
    if (!isPositiveInteger(n)) {
      return `\`info.${name}\` (${String(n)}) is not a positive integer`;
    }
  }
  if (channels > 4) {
    return `\`info.channels\` (${channels}) is not 1–4`;
  }
  const expected = width * height * channels * frames;
  if (data.length !== expected) {
    return `\`data\` holds ${data.length} bytes, not width × height × channels × frames (${expected})`;
  }
  return undefined;
}

/** Rejects a decoder's raster that is not a Raster. */
export function checkRaster(raster: Raster): void {
  const problem = rasterProblem(raster);
  if (problem !== undefined) {
    throw new ResizeSetupError(
      `resize: a decoder returned an invalid raster: ${problem}`,
      { code: 'RESIZE_DECODER_INVALID' },
    );
  }
}

/** Sharp's raw input options for the raster's pixels, frames stacked top to bottom. */
function rawOptions(raster: Raster): NonNullable<SharpOptions['raw']> {
  const { width, height, channels, frames = 1, premultiplied } = raster.info;
  return {
    width,
    height: height * frames,
    channels,
    ...(frames > 1 ? { pageHeight: height } : {}),
    // Only bytes a decoder marked as premultiplied are read as such (see sharpToRaster).
    ...(premultiplied === true ? { premultiplied: true } : {}),
  };
}

/** The input options for `sharp(raster.data, …)` inside the core, under `limits.inputPixels`. */
export function rasterInput(
  raster: Raster,
  limits: ResizeLimits,
): SharpOptions {
  return { raw: rawOptions(raster), limitInputPixels: limits.inputPixels };
}

/**
 * Sharp over the raster's pixels, for a Sharp-based beforeStep. The raster is already in memory,
 * so its own size is the input limit.
 */
export function rasterToSharp(raster: Raster): Sharp {
  const { width, height, frames = 1 } = raster.info;
  return sharp(raster.data, {
    raw: rawOptions(raster),
    limitInputPixels: width * height * frames,
  });
}

/**
 * The 8-bit raw output of `img` as a raster (no timing). Sharp's `premultiplied` flag is never
 * copied: after a resize it reports true on raw output whose bytes are straight alpha. The frame
 * count comes from the pixels: Sharp echoes a requested page count in `info.pages` even when the
 * loader read one frame, but sets `pageHeight` below the height only on stacked frames.
 */
export async function readRaster(img: Sharp): Promise<Raster> {
  const { data, info } = await img
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  const frameHeight = info.pageHeight ?? info.height;
  const frames = info.height / frameHeight;
  const rasterInfo: RasterInfo = {
    width: info.width,
    height: frameHeight,
    channels: info.channels,
  };
  if (frames > 1) {
    rasterInfo.frames = frames;
  }
  return { data, info: rasterInfo };
}

/** Reads a Sharp-based beforeStep's result back as a one-frame sRGB raster. */
export async function sharpToRaster(img: Sharp): Promise<Raster> {
  const raster = await readRaster(img.toColorspace('srgb'));
  if ((raster.info.frames ?? 1) > 1) {
    throw new ResizeSetupError(
      `resize: a beforeStep must return one frame, not ${raster.info.frames}`,
      { code: 'RESIZE_PIPELINE_STEP_INVALID' },
    );
  }
  return raster;
}
