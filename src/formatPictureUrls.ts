// Generic `<picture>` map — a convenience, not "the" host DTO. Filtered variants
// are omitted (they would collide on sizeKey+format); map `decision` for those.
import { getFilterSig } from './images.ts';
import type { PictureUrls, ReadDecision } from './types.d.ts';

export function formatPictureUrls(
  decision: ReadDecision,
  opts: { id?: string; mediaType?: string } = {},
): PictureUrls {
  const sizes: PictureUrls['sizes'] = {};
  for (const entry of decision.ready) {
    if (getFilterSig(entry.filters) !== 'none') {
      continue;
    }
    let byFormat = sizes[entry.sizeKey];
    if (!byFormat) {
      byFormat = {};
      sizes[entry.sizeKey] = byFormat;
    }
    const contentType = entry.contentType ?? entry.preview?.contentType;
    const cell: { url: string; contentType?: string } = { url: entry.url };
    if (contentType) {
      cell.contentType = contentType;
    }
    byFormat[entry.format] = cell;
  }
  const out: PictureUrls = { sizes };
  if (opts.mediaType !== undefined) {
    out.mediaType = opts.mediaType;
  }
  if (opts.id !== undefined) {
    out.id = opts.id;
  }
  return out;
}
