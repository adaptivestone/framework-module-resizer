// The built-in engine: libvips through Sharp, as render.ts called it in 0.3.0. A Sharp call cannot
// be cancelled, so the signal is not watched: `limits.processingTimeoutSeconds` bounds each call,
// except an AVIF encode, which it does not interrupt (the same on 0.3.0).
import sharp, { type FormatEnum, type OutputOptions } from 'sharp';
import type { Raster } from '../contracts/decoder.ts';
import {
  type EncodedImage,
  type EncodeRequest,
  type EngineCallOptions,
  ImageEngine,
  type ResizeRequest,
} from '../contracts/engine.ts';
import { isAvifBuffer } from '../helpers/imageFormat.ts';
import { rasterInput, readRaster } from './sharpRaster.ts';

// Every id Sharp's toFormat() accepts, under the `sharp.format` entry that says whether this build
// writes it to a Buffer. A fixed table, because `output.alias` is incomplete and a global libvips
// reports outputs toFormat() refuses. Aliases are listed: a host with `formats: ['jpg']` works
// today, and renaming it would regenerate its previews.
const TO_FORMAT_IDS: Readonly<Record<string, readonly string[]>> = {
  jpeg: ['jpeg', 'jpe', 'jpg'],
  png: ['png'],
  webp: ['webp'],
  tiff: ['tiff', 'tif'],
  gif: ['gif'],
  heif: ['heif', 'heic', 'avif'],
  dz: ['dz', 'tile'],
  raw: ['raw'],
  jp2: ['jp2', 'jpx', 'j2k', 'j2c'],
  jxl: ['jxl'],
};

function writableIds(): string[] {
  const available = sharp.format as unknown as Record<
    string,
    { output?: { buffer?: boolean } } | undefined
  >;
  return Object.entries(TO_FORMAT_IDS)
    .filter(([entry]) => available[entry]?.output?.buffer === true)
    .flatMap(([, ids]) => ids);
}

/**
 * One delay per frame: a shorter list repeats its last delay (the GIF encoder writes 0 for a frame
 * without one, which plays it as fast as the viewer can), a longer one is cut.
 */
function delayPerFrame(delay: readonly number[], frames: number): number[] {
  return Array.from(
    { length: frames },
    (_, i) => delay[Math.min(i, delay.length - 1)],
  );
}

export class SharpEngine extends ImageEngine {
  readonly id = 'sharp';
  readonly formats: readonly string[] = Object.freeze(writableIds());
  // Measured with Sharp 0.35: webp and gif keep every frame; avif, jpeg and png stack the frames
  // into one tall image, and tiff writes them as pages, which no browser plays.
  readonly animatedFormats: readonly string[] = Object.freeze(['gif', 'webp']);

  resize(
    frame: Raster,
    req: ResizeRequest,
    { limits }: EngineCallOptions,
  ): Promise<Raster> {
    const input = sharp(frame.data, rasterInput(frame));
    // `fill` scales each axis by its own factor; the reduction after beforeSteps scales both by one.
    let img = (
      req.coverBox
        ? input.resize(req.coverBox.width, req.coverBox.height, {
            fit: 'outside',
          })
        : input.resize(req.width, req.height, {
            fit: req.mode === 'cover' ? 'cover' : 'fill',
            position: 'center',
          })
    ).toColorspace('srgb');
    if (req.sharpen) {
      img = img.sharpen();
    }
    return readRaster(
      img.timeout({ seconds: limits.processingTimeoutSeconds }),
    );
  }

  async encode(
    raster: Raster,
    req: EncodeRequest,
    { limits }: EngineCallOptions,
  ): Promise<EncodedImage> {
    const { frames = 1, delay, loop } = raster.info;
    let img = sharp(raster.data, rasterInput(raster));
    if (req.background !== undefined) {
      img = img.flatten({ background: req.background });
    }
    // Raw pixels carry no timing: without the source's, an animation plays at the encoder's
    // default speed and loops once.
    const timing =
      frames > 1
        ? {
            ...(delay !== undefined && delay.length > 0
              ? { delay: delayPerFrame(delay, frames) }
              : {}),
            ...(loop !== undefined ? { loop } : {}),
          }
        : {};
    const { data, info } = await img
      .toFormat(
        req.format as keyof FormatEnum,
        { ...timing, ...req.options } as OutputOptions,
      )
      .timeout({ seconds: limits.processingTimeoutSeconds })
      .toBuffer({ resolveWithObject: true });
    // Sharp reports AVIF output through its HEIF container id; the brands in the bytes tell them
    // apart, so a configured `heif: { compression: 'av1' }` gets the AVIF type and extension too.
    const format =
      info.format === 'heif' && isAvifBuffer(data) ? 'avif' : info.format;
    return {
      data,
      format,
      contentType: `image/${format}`,
      width: info.width,
      height: info.pageHeight ?? info.height,
    };
  }
}
