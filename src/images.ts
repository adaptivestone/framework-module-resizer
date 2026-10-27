// Pure identity, catalog + dimension helpers. ONE identity, built one way, used everywhere
// (read map, dedup, dispatch lock, worker lock), and the one implementation of which stored rows
// count and which formats have encoder settings. No external deps.
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
 * The usable stored previews of `scope`, keyed by identity; of two rows with one identity the later
 * wins. A row's identity comes from its own fields (its scope, size key, format and filters), so
 * another Resizer's or pipeline's rendering never matches. The one rule for which stored rows
 * count: the read path, prewarm, eager generate and the worker all use it.
 */
export function storedPreviews(
  media: MediaLike,
  scope: PreviewScope,
): Map<string, Preview> {
  const byIdentity = new Map<string, Preview>();
  for (const preview of media.previews ?? []) {
    if (!isUsablePreview(preview)) {
      continue;
    }
    const own = previewScope(preview);
    if (own.resizer === scope.resizer && own.pipeline === scope.pipeline) {
      byIdentity.set(
        getPreviewIdentity(
          own,
          preview.sizeKey,
          preview.format,
          preview.filters,
        ),
        preview,
      );
    }
  }
  return byIdentity;
}

/** The identities of the usable stored previews of `scope` (see storedPreviews). */
export function storedIdentities(
  media: MediaLike,
  scope: PreviewScope,
): Set<string> {
  return new Set(storedPreviews(media, scope).keys());
}

/**
 * Expand `sizes × formats` into a deduped `MissingPreview[]`, skipping any size whose key can't
 * be built (`getSizeKey` throws) and any identity already stored for `scope`. Eager `generate`
 * and `prewarm` expand the whole catalog up front this way. The read path does not: its
 * per-cell loop interleaves expansion with serving the ready cells.
 */
export function expandMissingPreviews(
  media: MediaLike,
  sizes: SizeInput[],
  formats: PreviewFormat[],
  scope: PreviewScope,
): MissingPreview[] {
  const existing = storedIdentities(media, scope);
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

/** A row that can be served: it has a storage ref and a raster content type (never SVG). */
export function isUsablePreview(preview: Preview): boolean {
  return Boolean(
    preview.storageRef != null &&
      preview.contentType &&
      preview.contentType !== 'image/svg+xml' &&
      preview.format !== 'svg',
  );
}

function normalizeVariant(variant: MissingPreview): MissingPreview {
  const normalized: MissingPreview = {
    sizeKey: variant.sizeKey,
    format: variant.format,
  };
  if (variant.filters && Object.keys(variant.filters).length > 0) {
    normalized.filters = canonicalizeFilterValue(
      variant.filters,
    ) as MissingPreview['filters'];
  }
  if (variant.requestedWidth !== undefined) {
    normalized.requestedWidth = variant.requestedWidth;
  }
  if (variant.requestedHeight !== undefined) {
    normalized.requestedHeight = variant.requestedHeight;
  }
  if (variant.fit !== undefined) {
    normalized.fit = variant.fit;
  }
  return normalized;
}

/**
 * Canonicalize a complete queue payload: normalize nested filter keys, remove exact
 * duplicate variants, and sort the result by the canonical representation. The
 * stable result goes into the request key, so a list permutation cannot create another
 * durable task in a queue that deduplicates by it.
 */
export function canonicalizeVariants(
  variants: readonly MissingPreview[],
): MissingPreview[] {
  const byKey = new Map<string, MissingPreview>();
  for (const variant of variants) {
    const normalized = normalizeVariant(variant);
    const key = JSON.stringify(normalized);
    if (!byKey.has(key)) {
      byKey.set(key, normalized);
    }
  }
  return (
    [...byKey.entries()]
      // Do not use localeCompare: durable identity ordering must be independent of
      // the host process locale.
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, variant]) => variant)
  );
}

/**
 * True when `format` is an own key of `encoders` (`config.encode.formats`). Format ids are open
 * strings: an alias such as 'jpg' would skip the JPEG options, and an arbitrary Sharp id such as
 * 'raw' would publish a pixel dump.
 */
function isConfiguredFormat(
  encoders: Record<string, unknown>,
  format: unknown,
): format is PreviewFormat {
  return typeof format === 'string' && Object.hasOwn(encoders, format);
}

/**
 * Split the requested formats into those with encoder settings (in order, repeats kept) and the
 * rest (each named once).
 */
export function configuredFormats(
  encoders: Record<string, unknown>,
  requested: readonly PreviewFormat[],
): { formats: PreviewFormat[]; dropped: PreviewFormat[] } {
  const formats: PreviewFormat[] = [];
  const dropped = new Set<PreviewFormat>();
  for (const format of requested) {
    if (isConfiguredFormat(encoders, format)) {
      formats.push(format);
    } else {
      dropped.add(format);
    }
  }
  return { formats, dropped: [...dropped] };
}

/**
 * Split variants by the same rule as configuredFormats. A `beforeEnqueue` tap may add or rewrite
 * a variant to a format with no encoder settings, which a worker could never produce; a malformed
 * entry (not an object, no string format) is unconfigured too, never thrown on.
 */
export function splitConfigured(
  encoders: Record<string, unknown>,
  variants: readonly MissingPreview[],
): { configured: MissingPreview[]; unconfigured: MissingPreview[] } {
  const configured: MissingPreview[] = [];
  const unconfigured: MissingPreview[] = [];
  for (const variant of variants) {
    if (isConfiguredFormat(encoders, variant?.format)) {
      configured.push(variant);
    } else {
      unconfigured.push(variant);
    }
  }
  return { configured, unconfigured };
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
