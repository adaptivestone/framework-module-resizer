// The signatures a stored preview row records: `origin` (the original it was made from) and
// `encodeSig` (the encode settings and pipeline version it was made with). Rows keep them, so a
// later check can tell whether a preview still matches its original and the current settings. The
// recipes are fixed: changing what goes into one changes every signature already stored, and every
// stored preview would then look stale. Pure: no I/O, no Sharp.
import { createHash } from 'node:crypto';
import { canonicalizeFilterValue } from './images.ts';
import type { ResizeConfig, StorageRef } from './types.d.ts';

// The formats whose rows sign `config.animated`. A deliberate frozen copy of the formats
// isAnimatedFormat knows, not an import of it: this list is part of the recipe. If Sharp later
// animates another format, isAnimatedFormat may grow, but the signatures already stored for that
// format's rows must not change.
const ANIMATED_FORMATS: readonly string[] = Object.freeze(['gif', 'webp']);

/** The first 16 hex digits of the SHA-256 of `text`. */
function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * JSON with object keys sorted at every depth and `undefined` values dropped, so two equal
 * values always give one string whatever their key order. The value goes through JSON first, so
 * it is signed as it would be stored (a Date becomes its ISO string).
 */
export function canonicalJson(value: object): string {
  return JSON.stringify(
    canonicalizeFilterValue(JSON.parse(JSON.stringify(value))),
  );
}

/** The original a preview was made from: its storage ref and the dimensions the media holds. */
export function previewOrigin(
  storageRef: StorageRef,
  dims: { width: number; height: number },
): string {
  return shortHash(
    canonicalJson({ storageRef, width: dims.width, height: dims.height }),
  );
}

/**
 * The settings a preview of `row.format` was encoded with. Each input is signed only for the rows
 * it changes: the flatten background for flattened formats, `maxSize` for fit rows, `animated`
 * for animated formats. An input that does not apply is signed as null, never left out.
 */
export function encodeSignature(
  config: ResizeConfig,
  row: { format: string; fit: boolean; version?: string },
): string {
  const { format, fit, version } = row;
  return shortHash(
    canonicalJson({
      format,
      encode: config.encode.formats[format] ?? {},
      sharpen: config.encode.sharpen,
      flatten: config.encode.flatten.formats.includes(format)
        ? config.encode.flatten.background
        : null,
      maxSize: fit ? config.maxSize : null,
      resultDimension: config.limits.resultDimension,
      animated: ANIMATED_FORMATS.includes(format) ? config.animated : null,
      version: version ?? null,
    }),
  );
}
