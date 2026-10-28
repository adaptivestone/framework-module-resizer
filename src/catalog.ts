// What a Resizer can serve: size × format expansion, preview identities, which stored rows count
// and which formats have encoder settings. It binds the config to the pure rules in images.ts
// and adds none of its own; it does no I/O and logs nothing (callers log what was dropped).
import {
  canonicalizeVariants,
  configuredFormats,
  expandMissingPreviews,
  expandPreviewRequests,
  getPreviewIdentity,
  splitConfigured,
  storedIdentities,
  storedPreviews,
} from './images.ts';
import type {
  MediaLike,
  MissingPreview,
  Preview,
  PreviewFormat,
  PreviewScope,
  ResizeConfig,
  SizeInput,
} from './types.d.ts';

export interface CatalogDeps {
  config: ResizeConfig;
}

export class Catalog {
  readonly #config: ResizeConfig;

  constructor(deps: CatalogDeps) {
    this.#config = deps.config;
  }

  /** The preview identity of one variant in `scope`. */
  identity(
    scope: PreviewScope,
    variant: Pick<MissingPreview, 'sizeKey' | 'format' | 'filters'>,
  ): string {
    return getPreviewIdentity(
      scope,
      variant.sizeKey,
      variant.format,
      variant.filters,
    );
  }

  /** `sizes × formats` deduped by identity; a size without a usable key is skipped. */
  expand(
    sizes: SizeInput[],
    formats: PreviewFormat[],
    scope: PreviewScope,
  ): MissingPreview[] {
    return expandPreviewRequests(sizes, formats, scope);
  }

  /** What `expand` returns, less the identities already stored on `media` for `scope`. */
  missing(
    media: MediaLike,
    sizes: SizeInput[],
    formats: PreviewFormat[],
    scope: PreviewScope,
  ): MissingPreview[] {
    return expandMissingPreviews(media, sizes, formats, scope);
  }

  /** The usable stored previews of `scope` by identity; a later row wins. */
  storedPreviews(media: MediaLike, scope: PreviewScope): Map<string, Preview> {
    return storedPreviews(media, scope);
  }

  /** The identities of the usable stored previews of `scope`. */
  storedIdentities(media: MediaLike, scope: PreviewScope): Set<string> {
    return storedIdentities(media, scope);
  }

  /** A task payload in canonical form: filters normalized, duplicates removed, sorted. */
  canonicalize(variants: readonly MissingPreview[]): MissingPreview[] {
    return canonicalizeVariants(variants);
  }

  /** The requested formats (default: config.formats) with encoder settings, and the rest once. */
  configuredFormats(
    requested: readonly PreviewFormat[] = this.#config.formats,
  ): { formats: PreviewFormat[]; dropped: PreviewFormat[] } {
    return configuredFormats(this.#config.encode.formats, requested);
  }

  /** Variants with encoder settings, and the rest (a malformed entry among them). */
  splitConfigured(variants: readonly MissingPreview[]): {
    configured: MissingPreview[];
    unconfigured: MissingPreview[];
  } {
    return splitConfigured(this.#config.encode.formats, variants);
  }
}
