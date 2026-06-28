# 03 · Identity helpers

> Part of the [`@adaptivestone/framework-module-resize` build spec](../BUILD-SPEC.md).
> Prev: [02 · Types & API](./02-types-and-api.md) · Next: [04 · Pipelines & hooks](./04-pipelines-and-hooks.md)

`src/images.ts` — the shared, pure helpers. **One identity, built one way, used
everywhere** (read map, dedup, dispatch lock, worker lock, scaffolded model). Building a
key by hand at any call site is the bug class that produced a `_`-vs-`x` lock-key leak and a
`620w → NaN` size-key mis-parse in prior implementations.

---

## §7. Identity helpers (`src/images.ts`) — exact behavior

**Size key** (size only — never includes format or filters):

```ts
getSizeKey({ width, height, fit }): string
// fit                 → "fit"
// width && height     → `${width}x${height}`   e.g. "1760x990"
// width only          → `${width}w`            e.g. "620w"
// height only         → `${height}h`           e.g. "400h"
// none                → throw Error
// (a dimension counts only if it is a finite number > 0; `fit` wins if set)
// Dimensions are positive INTEGERS by contract; getSizeKey rounds each with Math.round so the
// key ALWAYS round-trips through parseSizeKey's integer regexes (a fractional dim would else
// produce a non-matching key — the round-trip is the 01 · Architecture identity invariant).

parseSizeKey(key): { sizeKey, width?, height?, fit }
// Always echoes `sizeKey: key` and a boolean `fit`; width/height set only when matched:
// "fit"            → { sizeKey:"fit", fit:true }
// /^(\d+)x(\d+)$/  → { sizeKey:key, width, height, fit:false }
// /^(\d+)w$/       → { sizeKey:key, width, fit:false }
// /^(\d+)h$/       → { sizeKey:key, height, fit:false }
// else             → { sizeKey:key, fit:false }  (no dims)
```

**Filter signature** (canonical, order-independent; empty-filter-bag bug from a prior
implementation fixed):

```ts
getFilterSig(filters?): string
// undefined / {} / no own keys → "none"
// else: sort keys; join "k:v" with "|"   e.g. { blur:40 } → "blur:40"; { b:2, a:1 } → "a:1|b:2"
```

**Preview identity** — the one lookup/lock key used everywhere:

```ts
getPreviewIdentity(sizeKey, format, filters?): string
// → `${sizeKey}:${format}:${getFilterSig(filters)}`
//   e.g. "300x300:avif:none", "300x300:avif:blur:40", "fit:webp:none", "620w:jpeg:none"
```

**Content type:**

```ts
getImageContentType(format?: PreviewFormat): `image/${PreviewFormat}` | undefined
// For the three RASTER PREVIEW formats only → `image/jpeg|webp|avif` (undefined if format missing).
// Do NOT pass an ORIGINAL's format: originals (incl. SVG) carry their own `original.contentType`
// (e.g. 'image/svg+xml') and are served from THAT, never via this helper — which would mis-map
// 'svg'→'image/svg' and 'jpg'→'image/jpg'.
```

**Dimensions:**

```ts
calculateResizedDimensions(origW, origH, targetW, targetH, fit=false,
                           maxSize={width:2000,height:1200}): { width?, height? }
// !fit (cover) → { width: targetW, height: targetH } passed through unchanged; EITHER may be
//        undefined for a width-only ("620w") or height-only ("400h") key — sharp then resizes
//        by the provided side, preserving aspect (cover crops only when BOTH are set). The
//        worker clamps each provided side to config.limits.resultDimension before encode (07 · Worker).
// fit  → fit inside maxSize preserving aspect ratio, never exceeding the original (no upscaling);
//        both returned sides rounded with Math.round.
//        (Rationale for `fit` — the uncropped modal/full-view variant — is in 07 · Worker.)
// maxSize default {2000,1200} MUST equal config.maxSize (08 · Config); callers always pass it in.
// origW/origH MUST be DISPLAY dimensions (post-EXIF-orient): the worker swaps width/height when
// metadata.orientation >= 5 before calling (07 · Worker step 3/5), else `fit` mis-sizes rotated photos.
```

Build the preview identity and **all** lock keys from `getPreviewIdentity` only.
