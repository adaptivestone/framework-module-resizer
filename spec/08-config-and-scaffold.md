# 08 · Config & scaffold

> Part of the [`@adaptivestone/framework-module-resize` build spec](../BUILD-SPEC.md).
> Prev: [07 · Worker](./07-worker.md) · Next: [09 · Packaging & tests](./09-packaging-and-tests.md)

The default config (merged with the host's), and the scaffold command that vendors the
`ResizeTask` model + config into the host's `src` as editable source.

---

## §13. Config (`src/config/resize.ts`, merged with `app.getConfig('resize')`)

```ts
export interface ResizeConfig {
  mediaModelName: string;          // host media model, e.g. 'File' or 'Media'
  bucketPublic: string;            // previews destination
  bucketPrivate?: string;          // originals (for signedUrl reads)
  publicURL: string;
  cdnURL?: string;                 // preferred over publicURL when set
  formats: PreviewFormat[];        // default ['jpeg','webp','avif']
  webpAvifOnly?: boolean;          // when true, requiredFormats() drops 'jpeg' (read + worker MUST agree)
  maxSize: { width: number; height: number };   // default { 2000, 1200 }  (the `fit` cap)
  // Per-format encode settings (research-backed; sharp defaults differ per codec and are NOT
  // perceptually comparable — JPEG q80 ≈ AVIF q64 ≈ WebP q82). NEVER reuse one quality int.
  quality: { jpeg: number; webp: number; avif: number };  // default { jpeg:80, webp:80, avif:64 }
  effort:  { webp: number; avif: number };                // default { webp:4, avif:4 } — AWS DIT keeps AVIF at 4; raise (→6–9) only if worker CPU allows
  limitInputPixels: number;        // default 268402689 (sharp default ~0x3FFF²) — decoder decompression-bomb guard
  maxSourcePixels: number;         // default 50_000_000 (≈imgproxy MAX_SRC_RESOLUTION) — rejected BEFORE decode, from metadata()
  maxResultDimension: number;      // default 5000 — clamp on the cover branch too (fit already capped by maxSize)
  animated: boolean;               // default false — true sets sharp { animated:true } so GIF/WebP keep frames (else flattened to frame 1)
  lockTtlMs: { dispatch: number; worker: number }; // default { dispatch: 60000, worker: 60000 }. worker MUST be ≤ leaseMs so a crashed worker's locks free within the lease window (07 · doneness invariant)
  leaseMs: number;                 // default 60000 — worker heartbeat renews the lease at leaseMs/2; set ≥ ~2× worst-case encode
  retryBackoffMs: { base: number; max: number };   // default { base: 5000, max: 300000 } — delayed re-lease on fail
  maxAttempts: number;             // default 3 — retries before dead-letter (sane 3–5; SQS default 10). Mongo status:'dead' / SQS DLQ
  idlePollMs: number;              // default 1000
  workerConcurrency: number;       // default 4
  workerEnabled: boolean;          // default false (env-driven in host)
  placeholderPrefix?: string;      // e.g. 'placeholders/loading'
  sqs?: {                          // REQUIRED when the SQS transport is active (05 · §10.3); ignored by the Mongo transport
    queueUrl: string;              //   the work queue URL (SendMessage target + Consumer source)
    region?: string;               //   default: AWS_REGION / SDK default chain
    endpoint?: string;             //   optional override (LocalStack / VPC endpoint)
    // credentials are NOT config — they come from the standard AWS provider chain (env / instance role).
    // sqsTransport lazily builds + memoizes one SQSClient from these fields; see 05 · §10.3.
  };
}
// getResizeConfig(app)  = deepmerge(default, app.getConfig('resize'), { arrayMerge: overwrite })
// requiredFormats(config) = config.webpAvifOnly ? ['webp','avif'] : config.formats
```

`requiredFormats()` is the **single source** for the format list, used by both the read
path and the worker. Never hardcode the format list anywhere else. Arrays in the host
override **replace** the default (so `formats:['webp','avif']` doesn't concat to five).

---

## §12. Scaffold (`resize/scaffold` command) — thin re-exports, not vendored copies

The framework discovers models and commands by **auto-scanning one host folder, keyed by
filename** (`server.ts:572-599`; verified — [Appendix C/D](./appendix.md)). There is no
`registerModel` API and no bootstrap factory that reaches the worker/CLI process, so the
`ResizeTask` model and `ResizeWorker` command **must exist as files in the host's `src/`**.

But those files are **one-line re-exports of module-owned definitions**, not vendored copies —
so the schema/behavior stays in the npm package (auto-updates, no drift) and the host file only
injects the host-specific `ref`:

```ts
// src/models/ResizeTask.ts   — scaffolded; the module owns makeResizeTaskModel (schema + indexes)
export default makeResizeTaskModel({ fileRef: 'File' });   // host edits only the ref ('File' | 'Media' | …)

// src/commands/ResizeWorker.ts — scaffolded; the module owns the AbstractCommand
export { default } from '@adaptivestone/framework-module-resize/commands/ResizeWorker.js';
```

> File name == class name == `'ResizeTask'` (the loader keys `getModel('ResizeTask')` by file
> name; mongoose refs use the class name). `ResizeWorker` must set
> `static isShouldInitModels = true` so models + the Mongo connection are ready inside `run()`.
> A host needing custom fields/indexes can `--eject` the model to a full editable copy.

`resize/scaffold` emits:
- `src/models/ResizeTask.ts` — thin re-export (Mongo transport only). `--eject` for a full copy.
- `src/commands/ResizeWorker.ts` — thin re-export.
- `src/config/resize.ts` — a **real editable copy** (config is *meant* to be tuned; this is the
  one place drift is intended). The framework does NOT auto-merge module defaults, so this file
  spreads the module's defaults and the module's `getResizeConfig(app)` deep-merges again.
- `src/assets/placeholders/*` — optional local placeholders.

> **Eager-mode hosts** ([11 · Modes](./11-modes.md)) skip the model + command entirely — they
> only scaffold `src/config/resize.ts`.

`resize/scaffold --check` — idempotent drift mode: for re-export files, verify the import path;
for config, diff vs the current default template. Never silently overwrite.

`ResizeTask` schema that `makeResizeTaskModel` builds (Mongoose, framework `BaseModel`):

```ts
// fields
fileId:  { type: ObjectId, ref: 'File', required: true },   // host edits the ref (File / Media)
pipeline:{ type: String, default: 'default' },              // which registered pipeline the worker runs
previews: [{ sizeKey, filters: Mixed, requestedWidth?, requestedHeight?, format(enum), fit? }],
status:  { enum: ['pending','processing','completed','dead'], default: 'pending' },
attempts:{ type: Number, default: 0 },                      // capped by config.maxAttempts → 'dead'
leasedBy: String, leaseToken: String,                       // leaseToken = fencing token (see §10.2)
leaseExpiresAt: Date, completedAt: Date, deadAt: Date, error: String,

// static initHooks(schema) — indexes:
schema.index({ completedAt: 1 }, { expireAfterSeconds: 86400,
  partialFilterExpression: { status: 'completed' } });          // evict completed rows after 24h
schema.index({ deadAt: 1 }, { expireAfterSeconds: 2592000,
  partialFilterExpression: { status: 'dead' } });               // keep dead-letter rows ~30d for inspection/replay
schema.index({ status: 1, createdAt: 1 });        // lease hot path (+ dead-letter sweep)
schema.index({ leaseExpiresAt: 1 },
  { partialFilterExpression: { status: 'processing' } });       // sweep/reclaim; NOT sparse (null wouldn't be excluded)
schema.index({ fileId: 1, createdAt: -1 });
```

> **Dead-letter & replay.** A task that crashes or errors past `config.maxAttempts` lands
> in `status:'dead'` (see [05 · Transport §10.2](./05-transport-and-storage.md)), retained
> ~30 days by the `deadAt` TTL above. To **replay**, reset the row:
> `ResizeTask.updateOne({ _id }, { $set: { status: 'pending', attempts: 0, leaseExpiresAt: null } })`.
> The host owns the `30d` retention — edit the `expireAfterSeconds` to taste.

The host's **media model** (`File`/`Media`) must carry `original` (incl. `width`/`height`)
and `previews[]` (incl. `filters`/`fit`) per
[02 · Types](./02-types-and-api.md#5-data-shapes-srctypesdts). That schema is host-owned;
the scaffold does not generate it (the host may have a migration — out of module scope,
see [01 · Architecture §15](./01-architecture.md#15-out-of-scope-host-app-responsibilities--never-put-in-the-module)).
