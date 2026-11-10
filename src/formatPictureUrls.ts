// Generic `<picture>` map — a convenience, not "the" host DTO. Filtered variants
// are omitted (they would collide on sizeKey+format); map `decision` for those.
import { getFilterSig } from './images.ts';
import type { PictureUrls, ReadDecision } from './types.d.ts';

// A hand-built entry can hold anything, and JSON turns NaN into a null a client would render.
const isSide = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

export function formatPictureUrls(
  decision: ReadDecision,
  opts: { id?: string; mediaType?: string } = {},
): PictureUrls {
  // Group in Maps so caller-provided keys never resolve inherited properties.
  const sizes = new Map<
    string,
    Map<string, PictureUrls['sizes'][string][string]>
  >();
  for (const entry of decision.ready) {
    if (getFilterSig(entry.filters) !== 'none') {
      continue;
    }
    let byFormat = sizes.get(entry.sizeKey);
    if (!byFormat) {
      byFormat = new Map();
      sizes.set(entry.sizeKey, byFormat);
    }
    // A preview can be smaller than its size key says, so a host reads its real size from here.
    // `?.`: this function never read the row before, so an entry an untyped host built keeps working.
    const width = entry.preview?.actualWidth;
    const height = entry.preview?.actualHeight;
    byFormat.set(entry.format, {
      url: entry.url,
      contentType: entry.contentType,
      ...(isSide(width) && isSide(height) ? { width, height } : {}),
    });
  }
  const out: PictureUrls = {
    // fromEntries creates own data properties, including for '__proto__', while
    // preserving the public DTO's ordinary object shape and JSON serialization.
    sizes: Object.fromEntries(
      Array.from(sizes, ([sizeKey, byFormat]) => [
        sizeKey,
        Object.fromEntries(byFormat),
      ]),
    ),
  };
  if (opts.mediaType !== undefined) {
    out.mediaType = opts.mediaType;
  }
  if (opts.id !== undefined) {
    out.id = opts.id;
  }
  return out;
}
