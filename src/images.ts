// Pure identity + dimension helpers. ONE identity, built one way, used everywhere
// (read map, dedup, dispatch lock, worker lock). No external deps — see 03 · Identity.
import { isPositiveFinite } from './helpers/guards.ts';
import type {
  Filters,
  MediaLike,
  MissingPreview,
  PreviewFormat,
  SizeInput,
} from './types.d.ts';

/**
 * Canonical size key (size only — never format or filters). `fit` wins; a dimension
 * counts only if finite and > 0; each is Math.round-ed so the key round-trips through
 * parseSizeKey's integer regexes. Throws when nothing usable is provided.
 */
export function getSizeKey({ width, height, fit }: SizeInput): string {
  if (fit) {
    return 'fit';
  }
  const w = isPositiveFinite(width) ? Math.round(width) : undefined;
  const h = isPositiveFinite(height) ? Math.round(height) : undefined;
  if (w !== undefined && h !== undefined) {
    return `${w}x${h}`;
  }
  if (w !== undefined) {
    return `${w}w`;
  }
  if (h !== undefined) {
    return `${h}h`;
  }
  throw new Error('getSizeKey: a size needs `fit`, a width, and/or a height');
}

export interface ParsedSizeKey {
  sizeKey: string;
  width?: number;
  height?: number;
  fit: boolean;
}

/** Inverse of getSizeKey. Always echoes `sizeKey` + a boolean `fit`; dims set only when matched. */
export function parseSizeKey(key: string): ParsedSizeKey {
  if (key === 'fit') {
    return { sizeKey: 'fit', fit: true };
  }
  const wh = /^(\d+)x(\d+)$/.exec(key);
  if (wh) {
    return {
      sizeKey: key,
      width: Number(wh[1]),
      height: Number(wh[2]),
      fit: false,
    };
  }
  const w = /^(\d+)w$/.exec(key);
  if (w) {
    return { sizeKey: key, width: Number(w[1]), fit: false };
  }
  const h = /^(\d+)h$/.exec(key);
  if (h) {
    return { sizeKey: key, height: Number(h[1]), fit: false };
  }
  return { sizeKey: key, fit: false };
}

/** Canonical, order-independent filter signature. Empty / undefined → "none". */
export function getFilterSig(filters?: Filters): string {
  if (!filters) {
    return 'none';
  }
  const keys = Object.keys(filters).sort();
  if (keys.length === 0) {
    return 'none';
  }
  return keys.map((k) => `${k}:${filters[k]}`).join('|');
}

/** The one lookup/lock key used everywhere: `${sizeKey}:${format}:${filterSig}`. */
export function getPreviewIdentity(
  sizeKey: string,
  format: PreviewFormat,
  filters?: Filters,
): string {
  return `${sizeKey}:${format}:${getFilterSig(filters)}`;
}

/**
 * Expand `sizes × formats` into a deduped `MissingPreview[]`, skipping any size whose key can't
 * be built (`getSizeKey` throws) and any identity already present in `media.previews`. This is
 * the SHARED expansion for the two modes that queue/generate the WHOLE catalog up front — eager
 * `generateImpl` (11 · §11.1 step 2–3) and pre-warm `prewarmImpl` (11 · §11.1b step 2–3): both
 * skip-existing + dedup into the exact same `MissingPreview` shapes. The read path (06 · §17
 * step 7) does NOT use this: its per-cell loop interleaves expansion with ready/fast-path serving,
 * so it keeps its own inline version.
 */
export function expandMissingPreviews(
  media: MediaLike,
  sizes: SizeInput[],
  formats: PreviewFormat[],
): MissingPreview[] {
  const existing = new Set<string>();
  for (const p of media.previews ?? []) {
    existing.add(getPreviewIdentity(p.sizeKey, p.format, p.filters));
  }
  const requested: MissingPreview[] = [];
  const seen = new Set<string>();
  for (const size of sizes) {
    let sizeKey: string;
    try {
      sizeKey = getSizeKey(size);
    } catch {
      continue; // a size with nothing usable is skipped
    }
    for (const format of formats) {
      const identity = getPreviewIdentity(sizeKey, format, size.filters);
      if (existing.has(identity) || seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      const mp: MissingPreview = { sizeKey, format };
      if (size.filters && Object.keys(size.filters).length > 0) {
        mp.filters = size.filters;
      }
      if (isPositiveFinite(size.width)) {
        mp.requestedWidth = size.width;
      }
      if (isPositiveFinite(size.height)) {
        mp.requestedHeight = size.height;
      }
      if (size.fit) {
        mp.fit = true;
      }
      requested.push(mp);
    }
  }
  return requested;
}

/**
 * Content type for a raster PREVIEW format only. Never pass an original's format —
 * originals carry their own `original.contentType` (e.g. 'image/svg+xml').
 */
export function getImageContentType(
  format?: PreviewFormat,
): `image/${PreviewFormat}` | undefined {
  return format ? `image/${format}` : undefined;
}

export interface ResizedDimensions {
  width?: number;
  height?: number;
}

/**
 * cover (!fit): pass target dims straight through (either may be undefined for a
 * width-/height-only key — sharp resizes by the provided side). fit: scale to fit
 * INSIDE maxSize preserving aspect, never upscaling beyond the original; sides rounded.
 * origW/origH MUST be DISPLAY dims (post-EXIF-orient) — see 07 · Worker.
 */
export function calculateResizedDimensions(
  origW: number,
  origH: number,
  targetW: number | undefined,
  targetH: number | undefined,
  fit = false,
  maxSize: { width: number; height: number } = { width: 2000, height: 1200 },
): ResizedDimensions {
  if (!fit) {
    return { width: targetW, height: targetH };
  }
  const scale = Math.min(maxSize.width / origW, maxSize.height / origH, 1);
  return {
    width: Math.round(origW * scale),
    height: Math.round(origH * scale),
  };
}
