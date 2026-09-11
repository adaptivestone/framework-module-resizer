// Generic `<picture>` map — a convenience, not "the" host DTO. Filtered variants
// are omitted (they would collide on sizeKey+format); map `decision` for those.
import { getFilterSig } from './images.ts';
import type { PictureUrls, ReadDecision } from './types.d.ts';

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
    const contentType = entry.contentType ?? entry.preview?.contentType;
    const cell: { url: string; contentType?: string } = { url: entry.url };
    if (contentType) {
      cell.contentType = contentType;
    }
    byFormat.set(entry.format, cell);
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
