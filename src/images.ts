// Pure identity + dimension helpers. ONE identity, built one way, used everywhere
// (read map, dedup, dispatch lock, worker lock). No external deps — see 03 · Identity.
import { ResizeMediaError, ResizeSetupError } from './errors.ts';
import { isPositiveFinite } from './helpers/guards.ts';
import type {
  Filters,
  MediaLike,
  MissingPreview,
  Preview,
  PreviewFormat,
  PreviewScope,
  SizeInput,
} from './types.d.ts';

/** A size dimension rounded to whole pixels; undefined when not finite or below 1 once rounded. */
function keyDimension(n: number | undefined): number | undefined {
  if (!isPositiveFinite(n)) {
    return undefined;
  }
  const rounded = Math.round(n);
  return rounded >= 1 ? rounded : undefined;
}

/**
 * Canonical size key (size only — never format or filters). `fit` wins; a dimension
 * counts only if finite and still ≥ 1 once Math.round-ed (so the key round-trips through
 * parseSizeKey's integer regexes and never asks sharp for 0 pixels). Throws when nothing
 * usable is provided.
 */
export function getSizeKey({ width, height, fit }: SizeInput): string {
  if (fit) {
    return 'fit';
  }
  const w = keyDimension(width);
  const h = keyDimension(height);
  if (w !== undefined && h !== undefined) {
    return `${w}x${h}`;
  }
  if (w !== undefined) {
    return `${w}w`;
  }
  if (h !== undefined) {
    return `${h}h`;
  }
  throw new ResizeSetupError(
    'getSizeKey: a size needs `fit`, a width, and/or a height',
    { code: 'RESIZE_SIZE_INVALID' },
  );
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

// Escape the `|` (pair separator) and `:` (key/value separator) so a filter key/value that
// contains them cannot forge a boundary — otherwise `{ a: '1|b:2' }` collides with
// `{ a: 1, b: 2 }` (same identity → cache confusion + lock shadowing). Backslash is escaped
// FIRST so the escapes we then add for `|`/`:` are not themselves re-escaped. (03 · §7 review fix)
function escapeFilterPart(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/:/g, '\\:');
}

/**
 * Return a JSON-safe filter value with nested object keys in lexical order.
 *
 * Runtime Mongo `Mixed` fields can contain richer values than the public flat
 * filter type. This is shared by queue request keys and preview identities so
 * they cannot disagree about equivalent nested filter objects.
 */
export function canonicalizeFilterValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeFilterValue);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      // JSON.stringify omits undefined object values. The request-key payload
      // does too, so omit them here before identity construction.
      if (record[key] !== undefined) {
        // Define, never assign: `result['__proto__'] = …` would hit the prototype setter
        // and drop an own "__proto__" key (JSON.parse creates one), so two different
        // filter objects would share one identity.
        Object.defineProperty(result, key, {
          value: canonicalizeFilterValue(record[key]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    return result;
  }
  return value;
}

/**
 * Convert a canonical runtime filter value into a deterministic, type-preserving
 * identity fragment. This deliberately uses the same JSON value representation as
 * the durable request key: `1` and `'1'` are different filter values.
 */
function getFilterValueSig(value: unknown): string {
  return JSON.stringify(value) ?? 'undefined';
}

/** Canonical, order-independent filter signature. Empty / undefined → "none". */
export function getFilterSig(filters?: Filters): string {
  if (!filters) {
    return 'none';
  }
  const canonical = canonicalizeFilterValue(filters) as Record<string, unknown>;
  const keys = Object.keys(canonical);
  if (keys.length === 0) {
    return 'none';
  }
  return keys
    .map(
      (k) =>
        `${escapeFilterPart(k)}:${escapeFilterPart(getFilterValueSig(canonical[k]))}`,
    )
    .join('|');
}

/**
 * The media id, by the precedence `media.id ?? String(media._id)` (02 · §5). THROWS a named error
 * when neither is present — a media with no id cannot be identified, enqueued, or persisted, and
 * `String(undefined)` would silently produce the literal `'undefined'` as a lock/queue key. Eager
 * `generate` surfaces this to the host; `resolve`/`prewarm` let their never-throw wrapper log it +
 * return the safe value. (04 · papercut)
 */
export function requireMediaId(media: MediaLike): string {
  const id = media.id ?? (media._id != null ? String(media._id) : undefined);
  if (!id) {
    throw new ResizeMediaError(
      'resize: media has neither `id` nor `_id` — cannot identify the media document',
      { code: 'RESIZE_MEDIA_NO_ID' },
    );
  }
  return id;
}

/** Scope of rows stored before previews recorded their resizer and pipeline. */
export const DEFAULT_SCOPE: PreviewScope = Object.freeze({
  resizer: 'default',
  pipeline: 'default',
});

/** The scope a stored preview belongs to. */
export function previewScope(preview: {
  resizer?: string;
  pipeline?: string;
}): PreviewScope {
  return {
    resizer: preview.resizer ?? 'default',
    pipeline: preview.pipeline ?? 'default',
  };
}

/**
 * The one lookup and lock identity, used everywhere: which Resizer and pipeline rendered which
 * size, format and filters (`resizer:pipeline:sizeKey:format:filterSig`). Names are
 * URI-encoded, so a ':' inside a name cannot shift the fields.
 */
export function getPreviewIdentity(
  scope: PreviewScope,
  sizeKey: string,
  format: PreviewFormat,
  filters?: Filters,
): string {
  return `${encodeURIComponent(scope.resizer)}:${encodeURIComponent(scope.pipeline)}:${sizeKey}:${format}:${getFilterSig(filters)}`;
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
  scope: PreviewScope,
): MissingPreview[] {
  const existing = new Set<string>();
  for (const p of media.previews ?? []) {
    if (isUsablePreview(p)) {
      existing.add(
        getPreviewIdentity(previewScope(p), p.sizeKey, p.format, p.filters),
      );
    }
  }
  return expandPreviewRequests(sizes, formats, scope).filter(
    (preview) =>
      !existing.has(
        getPreviewIdentity(
          scope,
          preview.sizeKey,
          preview.format,
          preview.filters,
        ),
      ),
  );
}

/** Expand a size catalog for one scope without consulting stored previews. */
export function expandPreviewRequests(
  sizes: SizeInput[],
  formats: PreviewFormat[],
  scope: PreviewScope,
): MissingPreview[] {
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
      const identity = getPreviewIdentity(scope, sizeKey, format, size.filters);
      if (seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      requested.push(toMissingPreview(size, sizeKey, format));
    }
  }
  return requested;
}

/**
 * Task payload for one size × format. The dimensions come from the size key, so the payload is
 * a pure function of the preview identity: a fractional input is rounded exactly as the key
 * rounds it, and a `fit` size carries no dimensions (fit ignores them).
 */
export function toMissingPreview(
  size: SizeInput,
  sizeKey: string,
  format: PreviewFormat,
): MissingPreview {
  const parsed = parseSizeKey(sizeKey);
  const mp: MissingPreview = { sizeKey, format };
  if (size.filters && Object.keys(size.filters).length > 0) {
    mp.filters = size.filters;
  }
  if (parsed.width !== undefined) {
    mp.requestedWidth = parsed.width;
  }
  if (parsed.height !== undefined) {
    mp.requestedHeight = parsed.height;
  }
  if (parsed.fit) {
    mp.fit = true;
  }
  return mp;
}

/**
 * True when every `sizes × formats` identity of `scope` (default: the default Resizer and
 * pipeline) is already stored on `media.previews`. Hosts use this to skip a no-op
 * `generate` / `prewarm`.
 */
export function isCatalogCovered(
  media: MediaLike,
  sizes: SizeInput[],
  formats: PreviewFormat[],
  scope: PreviewScope = DEFAULT_SCOPE,
): boolean {
  return expandMissingPreviews(media, sizes, formats, scope).length === 0;
}

export function isUsablePreview(preview: Preview): boolean {
  return Boolean(
    preview.storageRef != null &&
      preview.contentType &&
      preview.contentType !== 'image/svg+xml' &&
      preview.format !== 'svg',
  );
}

export interface ResizedDimensions {
  width?: number;
  height?: number;
}

/**
 * cover (!fit): pass target dims straight through (either may be undefined for a
 * width-/height-only key — sharp resizes by the provided side). fit: scale to fit
 * INSIDE maxSize preserving aspect, never upscaling beyond the original; sides rounded
 * and kept ≥ 1 (an extreme aspect ratio would otherwise round one side to 0).
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
    width: Math.max(1, Math.round(origW * scale)),
    height: Math.max(1, Math.round(origH * scale)),
  };
}

/**
 * The box a cover (cropping) variant is resized to. Each requested side is rounded to whole
 * pixels (an old task payload may still carry a fraction) and capped at `cap`
 * (limits.resultDimension). A width-only or height-only size keeps the source aspect ratio,
 * unless the derived side would exceed `cap`: then the box is the requested side × `cap` and
 * the cover resize crops, so no output side is ever larger than `cap`. srcW/srcH MUST be
 * DISPLAY dims of one frame.
 */
export function coverDimensions(
  srcW: number,
  srcH: number,
  targetW: number | undefined,
  targetH: number | undefined,
  cap: number,
): ResizedDimensions {
  const side = (n: number | undefined) =>
    n === undefined ? undefined : Math.min(cap, Math.max(1, Math.round(n)));
  const width = side(targetW);
  const height = side(targetH);
  if (width !== undefined && height === undefined) {
    return { width, height: (width * srcH) / srcW > cap ? cap : undefined };
  }
  if (height !== undefined && width === undefined) {
    return { width: (height * srcW) / srcH > cap ? cap : undefined, height };
  }
  return { width, height };
}
