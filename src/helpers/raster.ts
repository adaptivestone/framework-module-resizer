// The shape check for rasters that decoders, steps and engines return. No image library here: the
// core checks a raster without reaching one.
import type { Raster, RasterInfo } from '../contracts/decoder.ts';
import { ResizeSetupError } from '../errors.ts';

const isPositiveInteger = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n > 0;

// The time limit of a raster the core hands to a variantStep. `rasterToSharp` reads it, so a Sharp
// chain in a step stays under `limits.processingTimeoutSeconds` as it did when the step was one
// chain with the encode: a stuck chain holds a libuv thread, and other tasks then wait behind it. It
// lives beside the object, not on it, so the `Raster` shape stays what a host and an engine see: a
// raster spread into a new object is the host's own, and has no limit. It is this copy's map, so a
// `rasterToSharp` from a duplicate copy of the package reads none, with no error.
const stepTimeouts = new WeakMap<Raster, number>();

/** Marks a raster the core hands to a step: `rasterToSharp` puts this limit on its chain. */
export function limitStepRaster(raster: Raster, seconds: number): void {
  stepTimeouts.set(raster, seconds);
}

/** The limit `limitStepRaster` set on this object, if any. */
export function stepRasterTimeout(raster: Raster): number | undefined {
  return stepTimeouts.get(raster);
}

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
