// The built-in SVG decoder. SVG markup is untrusted: librsvg renders it inside one native call that
// Sharp's `.timeout()` cannot interrupt, so `render` rasterizes it in a separate process, killed at
// `limits.processingTimeoutSeconds` or when the abort signal fires, and decodes only the PNG it
// returns in-process. `inspect` reads the header without rendering: the natural size, which may be
// fractional, and whether the SVG keeps a pixel on each side within the renderer's limits.
import sharp from 'sharp';
import {
  type DecodeBox,
  type Raster,
  type RenderOptions,
  SourceDecoder,
  type SourceInfo,
} from '../contracts/decoder.ts';
import { ResizeMediaError } from '../errors.ts';
import { svgNaturalSize, svgRasterDensity } from '../helpers/svgDimensions.ts';
import { rasterizeSvg } from '../helpers/svgRaster.ts';
import type { ResizeLimits } from '../types.d.ts';

/** The render density for `largestScale`; a raster without a pixel on a side is refused. */
async function densityFor(
  bytes: Buffer,
  width: number,
  height: number,
  limits: ResizeLimits,
  largestScale: number,
): Promise<number> {
  const density = await svgRasterDensity(bytes, width, height, {
    pixelBudget: Math.min(limits.sourcePixels, limits.inputPixels),
    inputPixels: limits.inputPixels,
    timeoutSeconds: limits.processingTimeoutSeconds,
    largestScale,
  });
  if (density === undefined) {
    throw new ResizeMediaError(
      'resize: SVG dimensions cannot be rasterized within the renderer limits',
      { code: 'RESIZE_SVG_DIMENSIONS_UNSUPPORTED', retryable: false },
    );
  }
  return density;
}

export class SvgDecoder extends SourceDecoder {
  readonly formats = Object.freeze(['svg'] as const);

  async inspect(bytes: Buffer, limits: ResizeLimits): Promise<SourceInfo> {
    // Sharp's own error (bytes it cannot read, the pixel limit, the timeout) is rethrown as it is.
    const meta = await sharp(bytes, { limitInputPixels: limits.inputPixels })
      .timeout({ seconds: limits.processingTimeoutSeconds })
      .metadata();
    if (meta.format !== 'svg') {
      throw new ResizeMediaError(
        `resize: the SVG decoder does not read ${meta.format === undefined ? 'these bytes' : `format '${meta.format}'`}`,
        { code: 'RESIZE_SOURCE_FORMAT_UNSUPPORTED', retryable: false },
      );
    }
    if (meta.width === undefined || meta.height === undefined) {
      throw new ResizeMediaError(
        "resize: source metadata missing width/height (format 'svg') — cannot size safely",
        { code: 'RESIZE_SOURCE_METADATA_MISSING', retryable: false },
      );
    }
    // The pixel count comes first: the density probe below may render the header again.
    if (meta.width * meta.height > limits.sourcePixels) {
      throw new ResizeMediaError(
        `resize: SVG ${meta.width}x${meta.height} exceeds limits.sourcePixels (${limits.sourcePixels})`,
        { code: 'RESIZE_SOURCE_TOO_LARGE', retryable: false },
      );
    }
    const natural = await svgNaturalSize(
      bytes,
      meta.width,
      meta.height,
      limits.inputPixels,
      limits.processingTimeoutSeconds,
    );
    await densityFor(bytes, natural.width, natural.height, limits, 1);
    return {
      format: 'svg',
      contentType: 'image/svg+xml',
      width: natural.width,
      height: natural.height,
      vector: true,
    };
  }

  async render(
    bytes: Buffer,
    box: DecodeBox,
    opts: RenderOptions,
  ): Promise<Raster> {
    const { limits, source } = opts;
    // Never below the natural size: a smaller box is made by the core's resize.
    const largestScale = Math.max(
      1,
      box.width / source.width,
      box.height / source.height,
    );
    const density = await densityFor(
      bytes,
      source.width,
      source.height,
      limits,
      largestScale,
    );
    // No media id: the decoder does not know it, and the caller adds its own context.
    const png = await rasterizeSvg(bytes, {
      density,
      limitInputPixels: limits.inputPixels,
      timeoutMs: limits.processingTimeoutSeconds * 1000,
      signal: opts.signal,
    });
    // Decoding the PNG in-process is safe: the markup was rendered in the child.
    const { data, info } = await sharp(png, {
      limitInputPixels: limits.inputPixels,
    })
      .toColorspace('srgb')
      .raw({ depth: 'uchar' })
      .timeout({ seconds: limits.processingTimeoutSeconds })
      .toBuffer({ resolveWithObject: true });
    return {
      data,
      info: { width: info.width, height: info.height, channels: info.channels },
    };
  }
}
