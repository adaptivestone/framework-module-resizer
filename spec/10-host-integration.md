# 10 · Host integration

> Part of the [`@adaptivestone/framework-module-resize` build spec](../BUILD-SPEC.md).
> Prev: [09 · Packaging & tests](./09-packaging-and-tests.md) · Next: [11 · Modes](./11-modes.md)

How a consuming app wires the module — for the README. The four registrations, the
worker, the upload-time dims capture, and the real per-entity size catalogs the hosts use.

---

## §19. Host integration (for the README)

```ts
// src/resizer.ts (scaffolded; imported by src/server.ts so it runs in every process — API and worker)
// ALL wiring in one visible literal — drivers are fixed at construction (02 · §6).
import { Resizer } from '@adaptivestone/framework-module-resize';
// Drivers come from their own subpaths (uniform rule — 02 · §6); bootstrap declares what it uses:
import { MongoTransport } from '@adaptivestone/framework-module-resize/transports/mongo.js';
import { S3Storage } from '@adaptivestone/framework-module-resize/storage/s3.js'; // optional AWS peers resolved only here

export const resizer = new Resizer({
  transport: new MongoTransport(),           // or new SqsTransport({ queueUrl, region }); omit entirely for eager-only (11)
  storage: new S3Storage({                   // REQUIRED — shipped driver (05 · §10.5) or any custom ResizeStorage (05 · §10.4)
    bucketPublic: 'my-cdn', bucketPrivate: 'my-originals', publicBaseUrl: 'https://cdn.example.com',
  }),
  // mediaStore / lockProvider omitted → framework defaults (05 · §10.6)
  pipelines: {
    default: {},
    listing: { beforeSteps: [blurPlates] },  // async detector
    premium: {
      variantSteps: [(img, { variant }) => variant.filters?.blur ? img.blur(Number(variant.filters.blur)) : img],
    },
  },
  hooks: {
    resolveSizes:     (sizes, ctx) => ctx.entity === 'event' ? [...sizes, { fit: true }] : sizes,
    formatPublicUrls: (decision, ctx) => toHostDto(decision, ctx),   // host's shape + placeholders
  },
});
```

```bash
npx @adaptivestone/framework-module-resize resize-scaffold   # vendor ResizeTask model + resize config into the app (package bin — 08 · §12)
npm run cli ResizeWorker           # run the worker process (separate from the API; worker.enabled gates it)
```

```ts
// in a host DTO builder (no app argument — the module reads the ambient appInstance)
import { resizer } from '../resizer.ts';   // or: getResizer()
const { output } = await resizer.resolve({
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
