// Test-only: give seeded preview rows the signatures a worker would have recorded for them, so a
// read treats them as fresh. The recipe is the writer's: the origin of the original's storage ref
// and stored dimensions, and the encode signature of the row's format, fit flag and pipeline
// version under the given image config.
import defaultResizeConfig from '../config/resize.ts';
import { encodeSignature, previewOrigin } from '../signatures.ts';
import type { MediaLike, ResizeConfig } from '../types.d.ts';

/**
 * Set `origin` and `encodeSig` on every row of `media.previews` in place, as the worker records
 * them. `version` is the pipeline version: a string for every row, or a function of the row's
 * pipeline. Throws when the original lacks its storage ref or numeric dimensions. Returns `media`.
 */
export function stampFresh<M extends MediaLike>(
  media: M,
  opts: {
    config?: ResizeConfig;
    version?: string | ((pipeline: string) => string | undefined);
  } = {},
): M {
  const original = media.original;
  if (
    original?.storageRef == null ||
    typeof original.width !== 'number' ||
    typeof original.height !== 'number'
  ) {
    throw new Error(
      'stampFresh: the original needs storageRef, width and height',
    );
  }
  const origin = previewOrigin(original.storageRef, {
    width: original.width,
    height: original.height,
  });
  const config = opts.config ?? defaultResizeConfig;
  for (const row of media.previews ?? []) {
    const version =
      typeof opts.version === 'function'
        ? opts.version(row.pipeline ?? 'default')
        : opts.version;
    row.origin = origin;
    row.encodeSig = encodeSignature(config, {
      format: row.format,
      fit: row.fit === true,
      version,
    });
  }
  return media;
}
