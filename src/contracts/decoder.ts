// Decoder contract: turns the stored bytes of one source kind into pixels. The core measures an
// upload and renders previews only through this port, so a new source kind (a PDF, a camera raw
// format) needs only a new decoder, and the planning, resizing and encoding stay unchanged. A
// decoder closes over its own engine and receives no `app`. Extend this class (or pass any object
// of the same shape — the core never checks `instanceof`, so duplicate package copies still work).
import type { ResizeLimits } from '../types.d.ts';

/** What `inspect` measured. */
export interface SourceInfo {
  /** Stored as `original.format`; one of the decoder's `formats`. */
  format: string;
  /** Stored as `original.contentType`. */
  contentType: string;
  /** Display size of one frame (upright); a vector source may report a fractional natural size. */
  width: number;
  height: number;
  /** Frames in the source; absent = 1. */
  pages?: number;
  /** More than one frame AND renderable as an animation (Sharp: no EXIF orientation). */
  animated?: boolean;
  /** No own size: the own-size rule is off, and the box may exceed width × height. */
  vector?: boolean;
}

/** The size `render` should cover, in display pixels. */
export interface DecodeBox {
  width: number;
  height: number;
}

export interface RenderOptions {
  limits: ResizeLimits;
  /** Aborts when the task does; a decoder stops when it can. */
  signal?: AbortSignal;
  /** What `inspect` returned for these bytes. */
  source: SourceInfo;
  /** How many frames to decode (1 = the first frame only). */
  frames: number;
}

export interface RasterInfo {
  /** One frame. */
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
  /** Absent = 1; frames are stacked top to bottom in `data`. */
  frames?: number;
  /** Animation timing (ms per frame, and the loop count), kept for the encoder. */
  delay?: number[];
  loop?: number;
  /** True only when the bytes really are premultiplied. */
  premultiplied?: boolean;
}

/** Raw pixels: 8-bit, sRGB, upright (display orientation). */
export interface Raster {
  data: Buffer;
  info: RasterInfo;
}

/** One source kind: the formats it reads, how to measure its bytes and how to render them. */
export abstract class SourceDecoder {
  /** The format ids this decoder reads (`original.format` values), e.g. `['svg']`. */
  abstract readonly formats: readonly string[];

  /**
   * Measure the bytes: format, display size, frames. Read only what that needs; never render.
   * Bytes that are not one of `formats` reject quickly with a `ResizeMediaError` whose code is
   * RESIZE_SOURCE_FORMAT_UNSUPPORTED: the core then asks the next decoder. Any other rejection is
   * final for these bytes.
   */
  abstract inspect(bytes: Buffer, limits: ResizeLimits): Promise<SourceInfo>;

  /**
   * Render one upright 8-bit sRGB raster with `opts.frames` frames, or one frame when the decoder
   * cannot animate. The raster is at least `box` on both sides where the decoder's limits allow;
   * the core resizes it to each exact size either way. A raster source smaller than the box is
   * never enlarged. Colours are converted to sRGB with the embedded profile, and no profile is
   * carried. Respect `opts.limits`, and stop when `opts.signal` aborts if the engine can.
   */
  abstract render(
    bytes: Buffer,
    box: DecodeBox,
    opts: RenderOptions,
  ): Promise<Raster>;

  /** Optional startup check: throw when the decoder cannot work (e.g. a missing engine). */
  verify?(): void | Promise<void>;
}
