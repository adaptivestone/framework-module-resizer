// The built-in raster decoder: every format the installed Sharp (libvips) reads from a buffer,
// except SVG, which only the SVG decoder renders, in a separate process, and `raw`, which is not a
// file format. A Sharp call cannot be cancelled, so `render` does not watch the abort signal:
// `limits.processingTimeoutSeconds` bounds every call instead.
import sharp from 'sharp';
import {
  type DecodeBox,
  type Raster,
  type RasterInfo,
  type RenderOptions,
  SourceDecoder,
  type SourceInfo,
} from '../contracts/decoder.ts';
import { ResizeMediaError } from '../errors.ts';
import { isAvifBuffer } from '../helpers/imageFormat.ts';
import type { ResizeLimits } from '../types.d.ts';

/** Sharp's buffer input formats, without svg and raw; `avif` too when `heif` is there. */
function sharpInputFormats(): string[] {
  const formats = Object.values(sharp.format)
    .filter(
      (entry) => entry.input.buffer && entry.id !== 'svg' && entry.id !== 'raw',
    )
    .map((entry) => entry.id);
  // Sharp names an AVIF file `heif`; inspect tells the two apart by the container's brand.
  return formats.includes('heif') ? [...formats, 'avif'] : formats;
}

export class SharpDecoder extends SourceDecoder {
  readonly formats: readonly string[] = Object.freeze(sharpInputFormats());

  async inspect(bytes: Buffer, limits: ResizeLimits): Promise<SourceInfo> {
    // Sharp's own error (bytes it cannot read, the pixel limit, the timeout) is rethrown as it is.
    const meta = await sharp(bytes, {
      limitInputPixels: limits.inputPixels,
      animated: true,
    })
      .timeout({ seconds: limits.processingTimeoutSeconds })
      .metadata();
    const format =
      meta.format === 'heif' && isAvifBuffer(bytes) ? 'avif' : meta.format;
    if (format === undefined || !this.formats.includes(format)) {
      throw new ResizeMediaError(
        `resize: the Sharp decoder does not read ${format === undefined ? 'these bytes' : `format '${format}'`}`,
        { code: 'RESIZE_SOURCE_FORMAT_UNSUPPORTED', retryable: false },
      );
    }
    if (meta.width === undefined || meta.height === undefined) {
      throw new ResizeMediaError(
        `resize: source metadata missing width/height (format '${format}') — cannot size safely`,
        { code: 'RESIZE_SOURCE_METADATA_MISSING', retryable: false },
      );
    }
    // With `animated: true` Sharp reports the frames stacked; one frame is `pageHeight` high.
    const frameHeight = meta.pageHeight ?? meta.height;
    const orientation = meta.orientation ?? 1;
    // EXIF orientations 5–8 turn the image by 90°: the display size swaps the sides.
    const [width, height] =
      orientation >= 5 ? [frameHeight, meta.width] : [meta.width, frameHeight];
    const pages = meta.pages ?? 1;
    return {
      format,
      contentType: `image/${format}`,
      width,
      height,
      pages,
      // Sharp does not rotate a multi-page image, so an EXIF-rotated one renders as one frame.
      animated: pages > 1 && orientation <= 1,
    };
  }

  async render(
    bytes: Buffer,
    box: DecodeBox,
    opts: RenderOptions,
  ): Promise<Raster> {
    const { limits } = opts;
    // Never ask for more frames than the source has: a still image yields one.
    const frames = Math.max(1, Math.min(opts.frames, opts.source.pages ?? 1));
    const timeout = { seconds: limits.processingTimeoutSeconds };
    let img = sharp(bytes, {
      failOn: 'none',
      sequentialRead: true,
      limitInputPixels: limits.inputPixels,
      pages: frames,
    });
    // Sharp cannot rotate a multi-page image; an animated source carries no EXIF orientation.
    if (frames === 1) {
      img = img.rotate();
    }
    const rendering = img
      .resize(box.width, box.height, {
        fit: 'outside',
        withoutEnlargement: true,
      })
      .toColorspace('srgb')
      .raw({ depth: 'uchar' })
      .timeout(timeout)
      .toBuffer({ resolveWithObject: true });
    // Raw pixels carry no animation timing: read it from the source for the encoder.
    const timing =
      frames > 1
        ? sharp(bytes, { limitInputPixels: limits.inputPixels, animated: true })
            .timeout(timeout)
            .metadata()
        : undefined;
    const [{ data, info }, meta] = await Promise.all([rendering, timing]);
    // The frame count comes from the pixels themselves: Sharp echoes the requested `pages` in
    // `info.pages` even when the loader read a single frame, but sets `pageHeight` only on a
    // stacked multi-frame result.
    const frameHeight = info.pageHeight ?? info.height;
    const count = info.height / frameHeight;
    // Sharp's `premultiplied` flag is never copied: after a resize it reports true on raw output
    // whose bytes are straight alpha.
    const rasterInfo: RasterInfo = {
      width: info.width,
      height: frameHeight,
      channels: info.channels,
    };
    if (count > 1) {
      rasterInfo.frames = count;
      if (meta?.delay !== undefined) {
        rasterInfo.delay = meta.delay.slice(0, count);
      }
      if (meta?.loop !== undefined) {
        rasterInfo.loop = meta.loop;
      }
    }
    return { data, info: rasterInfo };
  }
}
