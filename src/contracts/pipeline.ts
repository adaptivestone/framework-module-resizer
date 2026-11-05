// Named pipeline types: the per-media-type pixel work. Both kinds of step work on raw pixels (a
// `Raster`), so host code never depends on the image engine.
import type { MediaLike, MissingPreview } from '../types.d.ts';
import type { Raster, SourceInfo } from './decoder.ts';

/**
 * Runs once per task on the decoded first frame (upright, 8-bit sRGB) and resolves with one
 * frame. `scale` is the width of the raster the step receives divided by `source.width`: multiply
 * coordinates stored in the source's units by it. `rasterToSharp` / `sharpToRaster` wrap a Sharp
 * step: `async (r) => sharpToRaster(rasterToSharp(r).blur(5))`.
 */
export type BeforeStep = (
  raster: Raster,
  meta: {
    media: MediaLike;
    source: SourceInfo;
    scale: number;
    ctx: Record<string, unknown>;
  },
) => Raster | Promise<Raster>;

/**
 * Runs once per variant, after the resize and before the encode, on one frame of that size's pixels
 * (upright, 8-bit sRGB), and resolves with one frame. The raster is the step's own copy, so it may
 * write to it. `variant` carries `filters` and `fit`. `rasterToSharp` / `sharpToRaster` wrap a Sharp
 * step: `async (r) => sharpToRaster(rasterToSharp(r).blur(5))`. A step is host code, so
 * `limits.processingTimeoutSeconds` does not bound its Sharp work: add `.timeout({ seconds: 5 })` to
 * the chain.
 */
export type VariantStep = (
  raster: Raster,
  meta: {
    variant: MissingPreview;
    media: MediaLike;
    source: SourceInfo;
    ctx: Record<string, unknown>;
  },
) => Raster | Promise<Raster>;

export interface Pipeline {
  beforeSteps?: BeforeStep[]; // async; run ONCE on the decoded source, before any resize
  variantSteps?: VariantStep[]; // run PER variant, after resize, before encode
  /**
   * Part of each preview's encodeSig: bump it when a step's output changes, and stored previews of
   * this pipeline are regenerated on their next read.
   */
  version?: string;
}
