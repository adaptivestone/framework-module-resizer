// What a Resizer can serve: size × format expansion, preview identities, which stored rows count,
// which of them are fresh and which formats have encoder settings. It binds the config and the
// pipeline versions to the pure rules in images.ts and freshness.ts and adds none of its own; it
// does no I/O and logs nothing (callers log what was dropped).
import { expectedOrigin, isFreshRow } from './freshness.ts';
import {
  canonicalizeVariants,
  configuredFormats,
  expandMissingPreviews,
  expandPreviewRequests,
  getPreviewIdentity,
  splitConfigured,
  storedIdentities,
  storedPreviewRows,
  storedPreviews,
} from './images.ts';
import { encodeSignature } from './signatures.ts';
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
  /** The registered pipeline's current `version`, read from the live pipeline object. */
  versionOf?: (pipeline: string) => string | undefined;
}

export class Catalog {
  readonly #config: ResizeConfig;
  readonly #versionOf: ((pipeline: string) => string | undefined) | undefined;

  constructor(deps: CatalogDeps) {
    this.#config = deps.config;
    this.#versionOf = deps.versionOf;
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

  /** The identities of the usable stored previews of `scope`, fresh or stale. */
  storedIdentities(media: MediaLike, scope: PreviewScope): Set<string> {
    return storedIdentities(media, scope);
  }

  /**
   * The `encodeSig` a row of `format` made now in `pipeline` records. Computed on every call: the
   * config and the pipeline belong to the host and may change, and the writer reads them live.
   */
  encodeSig(pipeline: string, format: PreviewFormat, fit: boolean): string {
    return encodeSignature(this.#config, {
      format,
      fit,
      version: this.#versionOf?.(pipeline),
    });
  }

  /**
   * The usable stored previews of `scope` by identity, split into fresh and stale. A fresh row of an
   * identity wins over its stale rows whatever the store order (the later fresh row of two);
   * otherwise its later row is the stale one. Without `originDims` the stored dimensions sign the
   * origin, so a media without them has no fresh row; the worker passes the decoded size.
   */
  splitStored(
    media: MediaLike,
    scope: PreviewScope,
    originDims?: { width: number; height: number },
  ): { fresh: Map<string, Preview>; stale: Map<string, Preview> } {
    const origin = expectedOrigin(media.original, originDims);
    // One signature per format and fit flag within this call; the fit flag leads the key, so a
    // format id holding ':' cannot collide.
    const sigs = new Map<string, string>();
    const encodeSigOf = (row: Preview): string => {
      const fit = row.fit === true;
      const key = `${fit ? 'fit' : 'cover'}:${row.format}`;
      let sig = sigs.get(key);
      if (sig === undefined) {
        sig = this.encodeSig(scope.pipeline, row.format, fit);
        sigs.set(key, sig);
      }
      return sig;
    };
    const fresh = new Map<string, Preview>();
    const stale = new Map<string, Preview>();
    for (const [identity, rows] of storedPreviewRows(media, scope)) {
      let freshRow: Preview | undefined;
      if (origin !== undefined) {
        for (const row of rows) {
          if (isFreshRow(row, { encodeSig: encodeSigOf(row), origin })) {
            freshRow = row;
          }
        }
      }
      if (freshRow) {
        fresh.set(identity, freshRow);
      } else {
        stale.set(identity, rows[rows.length - 1]);
      }
    }
    return { fresh, stale };
  }

  /** The identities of the fresh stored previews of `scope` (see splitStored). */
  freshIdentities(
    media: MediaLike,
    scope: PreviewScope,
    originDims?: { width: number; height: number },
  ): Set<string> {
    return new Set(this.splitStored(media, scope, originDims).fresh.keys());
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
