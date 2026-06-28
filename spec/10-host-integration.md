# 10 · Host integration

> Part of the [`@adaptivestone/framework-module-resize` build spec](../BUILD-SPEC.md).
> Prev: [09 · Packaging & tests](./09-packaging-and-tests.md) · Next: [11 · Modes](./11-modes.md)

How a consuming app wires the module — for the README. The four registrations, the
worker, the upload-time dims capture, and the real per-entity size catalogs the hosts use.

---

## §19. Host integration (for the README)

```ts
// src/server.ts (runs in every process — API and worker) — register strategies + hooks once
import { ResizeEngine, mongoTransport } from '@adaptivestone/framework-module-resize';

ResizeEngine.registerQueueTransport(mongoTransport);                  // or sqsTransport({ queueUrl, region }) — driver owns its options
ResizeEngine.registerStorage(myS3Storage); // { download, upload, publicUrl, signedUrl? } — driver owns buckets + base URL (05 · §10.4)

ResizeEngine.registerPipeline('default', {});
ResizeEngine.registerPipeline('listing', { beforeSteps: [blurPlates] });               // async detector
ResizeEngine.registerPipeline('premium', {
  variantSteps: [(img, { variant }) => variant.filters?.blur ? img.blur(Number(variant.filters.blur)) : img],
});

ResizeEngine.hook('resolveSizes',     (sizes, ctx) => ctx.entity === 'event' ? [...sizes, { fit:true }] : sizes);
ResizeEngine.hook('formatPublicUrls', (decision, ctx) => toHostDto(decision, ctx));     // host's shape + placeholders
```

```bash
npx @adaptivestone/framework-module-resize resize-scaffold   # vendor ResizeTask model + resize config into the app (package bin — 08 · §12)
npm run cli ResizeWorker           # run the worker process (separate from the API; worker.enabled gates it)
```

```ts
// in a host DTO builder
const { output } = await ResizeEngine.resolve(app, {
  media: fileDoc,
  pipeline: 'listing',
  sizes: [{ width:1760, height:990 }, { width:620 }, { fit:true }, { width:300, height:300, filters:{ blur:40 } }],
  ctx: { entity:'event', isOwner },
});
return output; // host's own shape, produced by the formatPublicUrls hook
```

At **upload** the host captures `original.width/height` (sharp metadata) into the media
doc; if it doesn't, the worker backfills them on first process.

---

## Example per-entity size catalogs

The host owns these and injects them via `resolveSizes` + per-call `sizes`. Illustrative
catalogs of the kinds hosts define (entity names are generic examples, not prescriptive):

| Entity | Sizes |
|---|---|
| gallery / detail image | `1760x990`, `618x360` |
| banner / strip (width-only) | `620w` |
| avatar | `200x200`, `160x160`, `80x80`, `720x720`, `50x50`, `100x100` |
| thumbnail set | `100x70`, `200x140`, `400x280`, `800x560` |
| full gallery + uncropped view | `933x700`, `1866x1400`, `128x96`, `256x192`, `360x270`, `720x540`, `fit` |
| preview | `150x150`, `400x400`, `200x200` |

Notes: a **width-only** key (`620w`) is supported for banner/strip layouts; the uncropped
**`fit`** variant is for full-view modals; a host may request a single `avif` per preset or
emit multiple formats for frontend `<picture>` negotiation.
