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
  quality: { jpeg: number; webp: number; avif: number };  // default { jpeg:80, webp:82, avif:64 } (webp 82 ≈ jpeg 80 ≈ avif 64 — the cited equivalence)
  effort:  { webp: number; avif: number };                // default { webp:4, avif:4 } (sharp default / AWS DIT). Previews are persisted + CDN-cached (encode-once), so raising to 5–6 is usually worth it — smaller files for one-time CPU
  mozjpeg: boolean;                // default true — jpeg({ mozjpeg:true }): progressive + trellis quantization, ~10–20% smaller at equal quality
  chromaSubsampling: '4:2:0' | '4:4:4';  // default '4:2:0' (sharp's JPEG default, fine for photos); '4:4:4' keeps full chroma for text/logos/UI — recommended for the `fit` full-view. WebP analog: webp({ smartSubsample:true }) at 4:4:4
  sharpen: { cover: boolean; fit: boolean } | false;  // default { cover:true, fit:false } — mild unsharp AFTER downscale; ON for heavy-downscale crops, OFF for the large modal (avoids halos)
  flattenBackground: string;       // default '#ffffff' — when a source has alpha and the output format is jpeg, .flatten({background}) before encode (else transparent → black)
  limitInputPixels: number;        // default 268402689 (sharp default ~0x3FFF²) — decoder decompression-bomb guard
  maxSourcePixels: number;         // default 50_000_000 (≈imgproxy MAX_SRC_RESOLUTION) — rejected BEFORE decode, from metadata(); counts width*height*frames
  maxResultDimension: number;      // default 5000 — clamp on the cover branch too (fit already capped by maxSize)
  animated: boolean;               // default false — true sets sharp { animated:true } so GIF/WebP keep frames (else flattened to frame 1)
  maxAnimationFrames: number;      // default 64 — when animated, cap decoded frames (sharp `pages`) — animation-bomb guard (≈imgproxy MAX_ANIMATION_FRAMES); also multiplied into the maxSourcePixels check
  lockTtlMs: { dispatch: number; worker: number }; // default { dispatch: 60000, worker: 60000 }. worker MUST be ≤ leaseMs so a crashed worker's locks free within the lease window (07 · doneness invariant)
  leaseMs: number;                 // default 60000 — worker heartbeat renews the lease at leaseMs/2; set ≥ ~2× worst-case encode
  retryBackoffMs: { base: number; max: number };   // default { base: 5000, max: 300000 } — delayed re-lease on fail
  maxAttempts: number;             // default 3 — retries before dead-letter (sane 3–5; SQS default 10). Mongo status:'dead' / SQS DLQ
  idlePollMs: number;              // default 1000
  workerConcurrency: number;       // default 4 — variants resized in parallel per task (NOT unbounded Promise.all)
  sharpConcurrency: number;        // default 1 — sharp.concurrency() (libvips threads per op). Keep workerConcurrency × sharpConcurrency ≈ nCPU to avoid thread oversubscription
  sharpCache: boolean;             // default false — sharp.cache(): a worker processes distinct images, so the libvips operation cache mostly wastes memory
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
// defaultResizeConfig: Partial<ResizeConfig> — every TUNABLE is defaulted (formats, quality,
//   effort, lockTtlMs, leaseMs, maxAttempts, …); the host-REQUIRED fields (mediaModelName,
//   bucketPublic, publicURL) are NOT defaulted — they come from the host's src/config/resize.ts.
// const overwrite = (_dest: unknown[], src: unknown[]) => src;   // arrays REPLACE, never concat
// getResizeConfig(app) = deepmerge(defaultResizeConfig, app.getConfig('resize') ?? {}, { arrayMerge: overwrite })
//   → THROWS a clear error if a required field (mediaModelName/bucketPublic/publicURL) is still
//     missing (fail fast at first use, not mid-resize).
// requiredFormats(config) = config.webpAvifOnly ? ['webp','avif'] : config.formats
```

`requiredFormats()` is the **single source** for the format list, used by both the read
path and the worker. Never hardcode the format list anywhere else. Arrays in the host
override **replace** the default (so `formats:['webp','avif']` doesn't concat to five).

---

## §12. Scaffold (`resize-scaffold` bin) — thin shims, not vendored copies

The framework discovers models and commands by **auto-scanning one host folder, keyed by
filename** (`server.ts:572-599`; verified — [Appendix C/D](./appendix.md)). There is no
`registerModel` API and no bootstrap factory that reaches the worker/CLI process, so the
`ResizeTask` model and `ResizeWorker` command **must exist as files in the host's `src/`**.

> **How `resize-scaffold` runs (no chicken-and-egg).** The generator does **not** use the
> framework's host-folder command scan — the host files don't exist yet. It ships as a **package
> bin** (`package.json` `"bin": { "resize-scaffold": "./dist/scaffold/command.js" }` —
> [09 · Packaging](./09-packaging-and-tests.md)), run once from the host project root via
> `npx @adaptivestone/framework-module-resize resize-scaffold` (or an npm script). The generated
> `ResizeWorker`/`ResizeTask` files are then what the framework's scanner picks up at runtime.

But those files are **one-line shims over module-owned definitions**, not vendored copies — so
the schema/behavior stays in the npm package (auto-updates, no drift): the model **`extends` the
package's `ResizeTaskModel` class**, the command **re-exports** the package's command:

```ts
// src/models/ResizeTask.ts   — scaffolded; the module owns ResizeTaskModel (schema + indexes)
import ResizeTaskModel from '@adaptivestone/framework-module-resize/models/ResizeTask.js';
export default class ResizeTask extends ResizeTaskModel {}   // a different media ref? → `{ static fileRef = 'Media' }`

// src/commands/ResizeWorker.ts — scaffolded; the module owns the AbstractCommand
export { default } from '@adaptivestone/framework-module-resize/commands/ResizeWorker.js';
```

> **Why a `class … extends`, not a factory call.** The framework's `npm run gen` AST codegen
> detects a model as a `BaseModel` subclass by walking its `extends` chain in source (resolving
> bare-package ancestors), then types `getModel('ResizeTask')`. A literal `class ResizeTask extends
> ResizeTaskModel` is detected; a factory call (`export default makeResizeTaskModel(...)`) is **not**
> (no `extends` identifier to follow), so `getModel('ResizeTask')` would fall back to an untyped
> form. `fileRef` is an overridable static, **not** a constructor/factory arg — it's a runtime
> populate hint that doesn't affect the document type, so overriding it never changes the types.

> File name == class name == `'ResizeTask'` (the loader keys `getModel('ResizeTask')` by file
> name; mongoose refs use the class name). `ResizeWorker` must set
> `static isShouldInitModels = true` so models + the Mongo connection are ready inside `run()`.
> A host needing custom fields/indexes can `--eject` the model to a full editable copy.

`resize-scaffold` emits:
- `src/models/ResizeTask.ts` — thin `extends ResizeTaskModel` shim (Mongo transport only). `--eject` for a full copy.
- `src/commands/ResizeWorker.ts` — thin re-export.
- `src/config/resize.ts` — a **real editable copy** (config is *meant* to be tuned; this is the
  one place drift is intended). The framework does NOT auto-merge module defaults, so this file
  spreads the module's defaults and the module's `getResizeConfig(app)` deep-merges again.
- `src/assets/placeholders/*` — optional local placeholders.

> **Eager-mode hosts** ([11 · Modes](./11-modes.md)) skip the model + command entirely — they
> only scaffold `src/config/resize.ts`.

> **Write paths.** The standalone bin has **no framework `app`**, so paths resolve from the host
> project root (`process.cwd()`): `src/models/`, `src/commands/`, `src/config/` by default,
> overridable with a `--out <dir>` flag. Missing folders are created; an existing file is
> **never overwritten** without `--force`.

`resize-scaffold --check` — idempotent verification (CI-gatable): the shim files must exist and
reference the correct module (the model `extends ResizeTaskModel`, the command re-exports the
correct path); the editable `src/config/resize.ts` is checked only for
**existence + validity** (parses, required fields present) — **not** diffed against defaults,
since it is *meant* to diverge. Prints a per-file status (`ok` / `drift` / `missing`) and **exits
non-zero (1)** if any required file is missing or a re-export's import path drifted; `0` if clean.
Never silently overwrites.
`resize-scaffold --eject` — writes the **full editable model** (not the re-export) from the
`ResizeTask.model.full.ts.tpl` template ([09 · §3](./09-packaging-and-tests.md)), for hosts
needing custom fields/indexes. `--force` overwrites existing scaffolded files.

> **Customizing the scaffolded model in a host project.** The `extends ResizeTaskModel` shim is a
> first-class extension point — same rules as customizing the framework's own `User` model:
> - **Add fields** — keep `extends ResizeTaskModel`, spread the base schema:
>   `static get modelSchema() { return { ...ResizeTaskModel.modelSchema, myField: { type: String } } as const; }`.
>   Inherited statics keep working; `npm run gen` types `getModel('ResizeTask')` with your field.
> - **Do NOT reshape a module-owned field** (`previews`, `status`, `leaseToken`, …): the worker
>   reads/writes those by their defined shape, and a static-getter type *replacement* trips
>   TS2417 anyway. Reshape only fields you added (via `--eject` if you must change the base).
> - **Single framework copy is required.** The loader registers the model only if
>   `ModelConstructor.prototype instanceof BaseModel` holds against the *host's* `BaseModel`
>   (`server.ts`). `@adaptivestone/framework` is a **`peerDependency`** so npm dedupes to one copy;
>   a nested second copy would make the `instanceof` fail and the model mis-load.

`ResizeTask` schema that the package's `ResizeTaskModel` class defines via `static get
modelSchema()` (Mongoose, framework `BaseModel`; `export type TResizeTask =
GetModelTypeFromClass<typeof ResizeTaskModel>`):

```ts
// fields  (ref is built from `this.fileRef` so the thin-shim `static fileRef` override actually applies)
fileId:  { type: ObjectId, ref: this.fileRef, required: true },   // this.fileRef defaults to 'File'; host overrides via `static fileRef = 'Media'`
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

> **Optional `resizeMediaSchemaFragment` (avoids hand-written drift).** Because the worker `$push`es
> a full `Preview` (incl. `fit`/`actualWidth`/`filters`), a hand-written host schema that omits a
> field silently **drops it on write** with no type error. So the module **exports an opt-in `as
> const` schema fragment** (plain POJO — `String`/`Number`/`Boolean` globals, **no `mongoose`
> import**, so [01 · §15](./01-architecture.md) holds) that the host spreads into its media model,
> giving one source of truth for both the runtime schema and (via `BaseModel`'s `as const`
> inference) the types. Layer `TsTypeOverride<Original>` / `TsTypeOverride<Preview[]>` (framework
> `BaseModel`) for exact field types where Mongoose infers loosely (`Mixed`/subdoc arrays):
> ```ts
> import { resizeMediaSchemaFragment } from '@adaptivestone/framework-module-resize';
> class File extends BaseModel {
>   static get modelSchema() { return { ...existingFields, ...resizeMediaSchemaFragment } as const; }
> }
> ```
> **Opt-in, scaffolded as a commented example** — many hosts have a pre-existing `File` with a
> legacy preview shape + migration, which a forced fragment would collide with. Hosts adding the
> fields fresh should use it; hosts with a legacy schema keep hand-authoring.
