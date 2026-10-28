// Named pipeline types: the per-media-type pixel work. sharp is a hard dep; these reference its
// types (erased at runtime).
import type { Metadata, Sharp } from 'sharp';
import type { MediaLike, MissingPreview } from '../types.d.ts';

export type BeforeStep = (
  buffer: Buffer,
  meta: { media: MediaLike; metadata: Metadata; ctx: Record<string, unknown> },
) => Buffer | Promise<Buffer>;

export type VariantStep = (
  img: Sharp,
  meta: { variant: MissingPreview; ctx: Record<string, unknown> }, // variant carries `filters`, `fit`
) => Sharp | Promise<Sharp>;

export interface Pipeline {
  beforeSteps?: BeforeStep[]; // async; run ONCE on the original buffer, before any resize
  variantSteps?: VariantStep[]; // run PER variant, after resize, before encode
  /**
   * Part of each preview's encodeSig: bump it to mark this pipeline's stored previews as made with
   * older settings (they are not regenerated yet).
   */
  version?: string;
}
