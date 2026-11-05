// The image engine: the two pixel operations the core needs after a decode. A Raster goes in, and
// a Raster or a preview's bytes come out, so nothing here names an image library.
import type { ResizeLimits } from '../types.d.ts';
import type { DecodeBox, Raster } from './decoder.ts';

export interface EngineCallOptions {
  limits: ResizeLimits; // the core sets no timer: the engine applies `processingTimeoutSeconds` itself
  signal?: AbortSignal; // the task's; absent in generate(); an engine that cannot cancel ignores it
}

export interface ResizeRequest {
  width: number; // the exact output size: the engine never picks one
  height: number;
  mode: 'fill' | 'cover'; // fill: the whole frame into this size. cover: scale to cover it, centre crop
  sharpen: boolean; // an engine without a sharpener ignores it
  /**
   * Set only on the reduction after `beforeSteps`: the box `width × height` was computed from, by
   * one factor for both axes. An engine that takes a box scales more exactly from it; any other
   * ignores it and returns `width × height`.
   */
  coverBox?: DecodeBox;
}

export interface EncodeRequest {
  format: string; // a configured id, as the host wrote it
  options: Record<string, unknown>; // encode.formats[format]
  background?: string; // when set, flatten the raster onto this colour first
}

export interface EncodedImage {
  data: Buffer;
  format: string; // the preview's file extension: letters and digits
  contentType: string;
  width: number;
  height: number; // of one frame
}

/**
 * Resizes and encodes. Extend this, or write any object of the same shape: the core never checks
 * `instanceof`. Two rules the types cannot state. An engine must not write to its inputs, because
 * the formats of one size share one raster. It must be re-entrant, because calls run concurrently,
 * up to `config.concurrency`.
 */
export abstract class ImageEngine {
  abstract readonly id: string; // names the engine in messages
  abstract readonly formats: readonly string[]; // what encode writes; verify() checks the config against it
  abstract readonly animatedFormats: readonly string[]; // what encode writes with every frame
  /** One frame in; one frame out at exactly the size asked for (with `coverBox`: within a pixel of it, covering the box), 8-bit sRGB, 3 channels or 4 with alpha. */
  abstract resize(
    frame: Raster,
    req: ResizeRequest,
    opts: EngineCallOptions,
  ): Promise<Raster>;
  /** One frame (1 to 4 channels, straight alpha), or `info.frames` of them for an animated format. */
  abstract encode(
    raster: Raster,
    req: EncodeRequest,
    opts: EngineCallOptions,
  ): Promise<EncodedImage>;
  verify?(): void | Promise<void>;
}
