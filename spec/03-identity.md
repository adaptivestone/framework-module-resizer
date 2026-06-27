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

parseSizeKey(key): { sizeKey, width?, height?, fit }
// "fit"            → { fit:true }
// /^(\d+)x(\d+)$/  → width+height
// /^(\d+)w$/       → width
// /^(\d+)h$/       → height
// else             → { sizeKey, fit:false }  (no dims)
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
getImageContentType(format?): `image/${format}` | undefined
```

**Dimensions:**

```ts
calculateResizedDimensions(origW, origH, targetW, targetH, fit=false,
                           maxSize={width:2000,height:1200}): { width, height }
// !fit → { width: targetW, height: targetH } as-is (sharp 'cover' does the cropping).
// fit  → fit inside maxSize preserving aspect ratio, never exceeding the original
//        (no upscaling). Returns the rounded fitted dims.
//        (Rationale for `fit` — the uncropped modal/full-view variant — is in
//         07 · Worker.)
```

Build the preview identity and **all** lock keys from `getPreviewIdentity` only.
