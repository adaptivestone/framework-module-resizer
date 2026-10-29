// Named pipeline types: the per-media-type pixel work. A beforeStep works on raw pixels (a
// `Raster`), so host code there never depends on the image engine; variantSteps still receive a
// Sharp instance over the sized pixels. sharp is a hard dep; its type is erased at runtime.
import type { Sharp } from 'sharp';
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

export type VariantStep = (
  img: Sharp,
  meta: { variant: MissingPreview; ctx: Record<string, unknown> }, // variant carries `filters`, `fit`
) => Sharp | Promise<Sharp>;

export interface Pipeline {
  beforeSteps?: BeforeStep[]; // async; run ONCE on the decoded source, before any resize
  variantSteps?: VariantStep[]; // run PER variant, after resize, before encode
  /**
   * Part of each preview's encodeSig: bump it to mark this pipeline's stored previews as made with
   * older settings (they are not regenerated yet).
   */
  version?: string;
}
