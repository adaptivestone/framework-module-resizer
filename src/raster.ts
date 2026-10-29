// The boundary between a Raster and Sharp: the shape check for rasters that decoders and steps
// return, the raw input options, and the read-back of Sharp's raw output. Every conversion between
// the two lives here, so the engine can later be put behind a port at this one place.
import sharp, { type Sharp, type SharpOptions } from 'sharp';
import type { Raster, RasterInfo } from './contracts/decoder.ts';
import { ResizeSetupError } from './errors.ts';

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

/**
 * The input options for `sharp(raster.data, …)` inside the core. The pixels are already in memory
 * (decoded, or rendered by the core itself), so the raster's own size is the input limit:
 * `limits.inputPixels` guards untrusted bytes, and the decoders apply it to those.
 */
export function rasterInput(raster: Raster): SharpOptions {
  const { width, height, frames = 1 } = raster.info;
  return { raw: rawOptions(raster), limitInputPixels: width * height * frames };
}

/**
 * Sharp over the raster's pixels, for a Sharp-based beforeStep. A value that is not a Raster is
 * refused here, before Sharp reads it as raw bytes of the wrong size.
 */
export function rasterToSharp(raster: Raster): Sharp {
  const problem = rasterProblem(raster);
  if (problem !== undefined) {
    throw new ResizeSetupError(
      `resize: rasterToSharp was given something that is not a Raster: ${problem}`,
      { code: 'RESIZE_PIPELINE_STEP_INVALID' },
    );
  }
  return sharp(raster.data, rasterInput(raster));
}

/**
 * Sharp's raw output as a raster, why its description does not match its bytes, and whether a page
 * height was left over from a multi-page input that was resized as one image.
 */
async function rawOutput(img: Sharp): Promise<{
  raster: Raster;
  problem: string | undefined;
  stalePageHeight: number | undefined;
}> {
  const { data, info } = await img
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  // The page height is a frame height only when it is below the height and divides it: Sharp keeps
  // a stale page height after resizing a raw multi-frame input, and echoes a requested page count
  // in `info.pages` even when the loader read one frame.
  const { pageHeight } = info;
  const frames =
    pageHeight !== undefined &&
    pageHeight > 0 &&
    pageHeight < info.height &&
    info.height % pageHeight === 0
      ? info.height / pageHeight
      : 1;
  const rasterInfo: RasterInfo = {
    width: info.width,
    height: info.height / frames,
    channels: info.channels,
  };
  if (frames > 1) {
    rasterInfo.frames = frames;
  }
  return {
    raster: { data, info: rasterInfo },
    problem: rasterProblem({ data, info: rasterInfo }),
    stalePageHeight:
      frames === 1 && pageHeight !== undefined && pageHeight !== info.height
        ? pageHeight
        : undefined,
  };
}

/**
 * The 8-bit raw output of `img` as a raster (no timing). Sharp's `premultiplied` flag is never
 * copied: after a resize it reports true on raw output whose bytes are straight alpha. Rejects
 * output whose bytes do not match its size and frame count, rather than return an inconsistent
 * raster. `SharpDecoder.render` reads frames by the same rule (decoders do not import this file);
 * the Processor checks its raster with `checkRaster`.
 */
export async function readRaster(img: Sharp): Promise<Raster> {
  const { raster, problem } = await rawOutput(img);
  if (problem !== undefined) {
    throw new ResizeSetupError(
      `resize: Sharp described its raw output inconsistently: ${problem}`,
    );
  }
  return raster;
}

/** Reads a Sharp-based beforeStep's result back as a one-frame sRGB raster. */
export async function sharpToRaster(img: Sharp): Promise<Raster> {
  // The input's own frames, before any resize: stacked frames (a page height below the height)
  // were loaded, whatever size the output has. A still opened with a page count, or one page of an
  // animation, has no page height below its height (ruling: one frame is one frame).
  const input = await img.metadata();
  if (
    input.pageHeight !== undefined &&
    input.height !== undefined &&
    input.height > input.pageHeight
  ) {
    throw new ResizeSetupError(
      `resize: a beforeStep must return one frame, not ${Math.round(input.height / input.pageHeight)} stacked frames`,
      { code: 'RESIZE_PIPELINE_STEP_INVALID' },
    );
  }
  const { raster, problem, stalePageHeight } = await rawOutput(
    img.toColorspace('srgb'),
  );
  if (stalePageHeight !== undefined) {
    throw new ResizeSetupError(
      `resize: a beforeStep must return one frame, not a multi-page image resized as one (a page height of ${stalePageHeight} over ${raster.info.height} rows)`,
      { code: 'RESIZE_PIPELINE_STEP_INVALID' },
    );
  }
  if (problem !== undefined) {
    throw new ResizeSetupError(
      `resize: a beforeStep returned pixels Sharp could not describe consistently: ${problem}`,
      { code: 'RESIZE_PIPELINE_STEP_INVALID' },
    );
  }
  if ((raster.info.frames ?? 1) > 1) {
    throw new ResizeSetupError(
      `resize: a beforeStep must return one frame, not ${raster.info.frames}`,
      { code: 'RESIZE_PIPELINE_STEP_INVALID' },
    );
  }
  return raster;
}
