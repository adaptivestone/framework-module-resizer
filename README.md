# @adaptivestone/framework-module-resize

Image resizing for [`@adaptivestone/framework`](https://framework.adaptivestone.com).
Upload only the **original**; generate resized variants with [`sharp`](https://sharp.pixelplumbing.com).
**Eager** mode (`generate` at upload) is a complete first-class path — no queue, no worker.
Lazy and pre-warm share the same core and the same `previews[]` when listings get huge.

Everything the module touches — storage, the optional queue transport, the media store, the
lock provider — is a **swappable driver** wired in one constructor literal. The core owns
only the identity, the read decision, and the resize pipeline.

Distilled from several prior production implementations of upload-time resizing, minus their
synchronous all-or-nothing cost and their three incompatible response shapes.

> **Coding agents** (Claude Code, Cursor, Codex, …): read [`AGENTS.md`](./AGENTS.md) — the
> machine-oriented integration guide that ships with this package.

---

## How it works

```
upload ─▶ store the ORIGINAL ─▶ generate({ media, sizes }) ─▶ previews[] on the media doc
  read ─▶ resolve({ media, sizes }) ─▶ ready URLs (or missing, if you skipped generate)
```

Eager is the default story. `generate` runs the same sharp core inline at upload and appends
onto both the store and the in-memory `media.previews`, so a same-request `resolve({ media })`
sees the new rows.

When listings are huge, skip `generate` and add a transport + worker: `resolve` enqueues
missing variants instead. `sharp` stays off the HTTP **read** path either way.

---

## Install

```bash
npm i @adaptivestone/framework-module-resize
```

Requires Node `>=24` and the framework/mongoose peers (mandatory — a nested second framework copy
breaks the model loader). The AWS drivers are **optional peers**: install them only for the driver
you use. Each optional peer is resolved **only** when you import its driver subpath — the main
entry never loads the AWS SDKs, and a missing peer fails loudly at your own import line at
bootstrap, not at first I/O.

| You use… | Also install |
|---|---|
| **SQS transport** (`/transports/sqs.js`) | `@aws-sdk/client-sqs` `sqs-consumer` |
| **S3 storage** (`/storage/s3.js`) | `@aws-sdk/client-s3` `@aws-sdk/s3-request-presigner` |
| **Local filesystem** (`/storage/fs.js`) / Mongo transport / framework media store / locks | nothing (no optional deps) |

### Scaffold the integration files

The framework discovers models and commands by scanning your `src/` folder, so a few thin files
must live in your app. Generate them once:

```bash
npx @adaptivestone/framework-module-resize resize-scaffold --eager
```

It emits (into `process.cwd()`, or `--out <dir>`), **never overwriting** without `--force`:

| File | What it is |
|---|---|
| `src/resizer.ts` | the construction site — `new Resizer({ … })` (edit freely) |
| `src/config/resize.ts` | editable host overrides; module defaults merge at runtime |
| `src/models/ResizeTask.ts` | thin shim (only without `--eager`) |
| `src/commands/ResizeWorker.ts` | worker command re-export (only without `--eager`) |

The shims are **not vendored copies** — the schema/behavior stays in the npm package (auto-updates,
no drift). `--eager` wires `LocalFsStorage`; omit the flag for a Mongo transport + a storage TODO.

Other flags: `--check` (CI-gatable drift check; exits 1 on missing/drift, no writes), `--eject`
(write the full editable model instead of the shim, for custom fields/indexes), `--agents
<agents|claude|print|skip>` (where to write the append-only, marker-idempotent pointer to the
shipped [`AGENTS.md`](./AGENTS.md); default `agents` = the host `AGENTS.md`), `--force`,
`--out <dir>`.

---

## Quick start (eager + local filesystem)

Start here. No queue, no worker, no AWS. `npx resize-scaffold --eager` emits this wiring.

**1. Wire the Resizer** after `Server.init()` (or lazily on first request). One Resizer per
process — a second `new Resizer()` throws.

Load the scaffolded construction site dynamically from bootstrap after initialization:

```ts
await server.init();
const { resizer } = await import('./resizer.ts');
```

A static import is evaluated before bootstrap code and is therefore too early.

```ts
import { Resizer } from '@adaptivestone/framework-module-resize';
import { LocalFsStorage } from '@adaptivestone/framework-module-resize/storage/fs.js';

export const resizer = new Resizer({
  storage: new LocalFsStorage({ rootDir: './var/media', publicBaseUrl: '/media' }),
});
```

**2. At upload**, store the untouched original, persist the returned `Original` on your host
media document, then generate the catalog:

```ts
media.original = await resizer.uploadOriginal({
  body: buffer,                         // Buffer or Uint8Array
  visibility: 'private',
});
await media.save();                     // host-owned model lifecycle

const { created, failed } = await resizer.generate({
  media,
  sizes: [{ width: 320, height: 320 }],
});
const { decision } = await resizer.resolve({
  media, // generate already appended `created` onto media.previews
  sizes: [{ width: 320, height: 320 }],
});
```

**3. Set your media model name** in `src/config/resize.ts` (the one required field) and spread
`resizeMediaSchemaFragment` into the model so `original` + `previews[]` exist. Listing queries:

```ts
import { resizeMediaPaths } from '@adaptivestone/framework-module-resize';
File.find().select(['mediaType', ...resizeMediaPaths]);
```

S3 when you have buckets; a queue when listings are huge — both are later sections.

### Original upload

`uploadOriginal()` sniffs the actual bytes, creates a random `originals/<hex>.<ext>` suggested
key, writes through the configured `storage.upload()`, and returns a complete `Original` locator with
`format`, `contentType`, byte `size`, and reliable display dimensions when known. It does not
create a media document, enqueue variants, or know anything about users, owners, routes, or DTOs.
Built-in filesystem/S3 drivers preserve the suggested extension; a custom content-addressed
driver may return its own opaque locator key.

Input bytes are stored unchanged. Raster metadata is probed with `sharp.metadata()` under the
configured pixel guard, but no decode-to-output, rotation, EXIF rewrite, re-encode, or animation
collapse occurs. SVG is parsed by the non-rendering `saxes` XML parser and is never passed to
Sharp. Malformed XML, duplicate attributes, unknown/invalid entities, trailing document data,
and all DTD/entity declarations are rejected before storage. This structural check is not SVG
sanitization; the host must sanitize otherwise-valid SVG content before calling this method.
Pixel dimensions come only from positive unitless or `px` `width`/`height` attributes. A
`viewBox`, percentage, or relative length is not stored as a pixel dimension; unknown dimensions
are omitted, and previously stored media rows are not rewritten automatically.

Failures are typed: malformed/unsupported/over-limit input throws `ResizeOriginalError`; storage
I/O throws `ResizeStorageError` with code `RESIZE_ORIGINAL_UPLOAD_FAILED` and the driver error as
`cause`. The byte and format allowlists are `upload.maxBytes` and `upload.formats`.

---

## When listings are huge (lazy / queue)

Add a `transport` and run `ResizeWorker`. Missing variants are enqueued on `resolve()` (or
pushed at upload with `prewarm()`).

The Mongo transport deduplicates identical active tasks: variants are canonicalized and a
SHA-256 `requestKey` is stored under a partial unique index for `pending`/`processing` rows.
The key includes the pipeline and the complete variant payload handed to the transport;
reordering that payload returns the existing task. Before this stage, shared dispatch locks
can remove overlapping variants from a request. Rows created before `requestKey` was introduced
remain valid.

```ts
// src/resizer.ts — construct after Server.init(); import from API and worker processes
import { Resizer } from '@adaptivestone/framework-module-resize';
import { MongoTransport } from '@adaptivestone/framework-module-resize/transports/mongo.js';
import { S3Storage } from '@adaptivestone/framework-module-resize/storage/s3.js'; // optional AWS peers resolved only here

export const resizer = new Resizer({
  transport: new MongoTransport(),           // or new SqsTransport({ queueUrl, region })
  storage: new S3Storage({
    bucketPublic: 'my-cdn',
    bucketPrivate: 'my-originals',
    publicBaseUrl: 'https://cdn.example.com',
    client,                                  // existing S3Client — env/keys stay in the host
  }),
  pipelines: {
    default: {},
    listing: { beforeSteps: [blurPlates] },
    premium: {
      variantSteps: [(img, { variant }) => variant.filters?.blur ? img.blur(Number(variant.filters.blur)) : img],
    },
  },
  hooks: {
    resolveSizes:     (sizes, ctx) => ctx.entity === 'event' ? [...sizes, { fit: true }] : sizes,
    formatPublicUrls: (decision, ctx) => toHostDto(decision, ctx),
  },
});
```

Queue indexes are a lifecycle concern, not a resizer runtime operation. The package declares the
required `ResizeTask` indexes, and the framework declares the `Lock` indexes; the host's normal
model lifecycle or an explicit database migration must create them before producers and workers
run. The module does not expose `prepareQueue()`, call `createIndexes()`, synchronize/drop indexes,
or create any external queue/storage resource. In particular, do not put index creation in HTTP
bootstrap, the first enqueue, or the worker command.

The active-request partial unique index on `{ fileId, pipeline, requestKey }` is what guarantees
deduplication of identical active tasks. Without that index, enqueue remains at-least-once and
concurrent identical requests are not guaranteed to collapse to one row. Prepare the database
through the host's migration/lifecycle process and verify the exact model declarations there;
never run a destructive global `syncIndexes()` automatically.

**Enable the worker command** in the host `src/config/resize.ts` (the module default is `false`):

```ts
import type {
  DeepPartial,
  ResizeConfig,
} from '@adaptivestone/framework-module-resize';

export default {
  mediaModelName: 'File',
  worker: { enabled: true },
} satisfies DeepPartial<ResizeConfig>;
```

**Run the worker** as a separate process:

```bash
npm run cli ResizeWorker
```

`worker.enabled` permits the command to run; it does not start a worker inside the API. The
command assumes the host lifecycle or an explicit migration has already prepared the configured
queue/lock indexes before consumption.

Your media model (`File`/`Media`) must carry `original` (incl. `width`/`height`) and `previews[]`
(incl. `filters`/`fit`). That schema is host-owned; to avoid hand-written drift the module exports
an **opt-in** `as const` fragment you can spread in (single source of truth for the runtime schema
and the types):

```ts
import { resizeMediaSchemaFragment } from '@adaptivestone/framework-module-resize';
class File extends BaseModel {
  static get modelSchema() { return { ...existingFields, ...resizeMediaSchemaFragment } as const; }
}
```

At **upload**, prefer `uploadOriginal()` and persist its returned metadata on the media doc. Legacy
hosts may still populate `original` themselves; if dimensions are absent, the worker backfills
display dimensions on first processing.

**Read** from your DTO builders. No `app` argument — the module reads the ambient app instance.
`resolve` returns the raw `decision` and the `output` of your `formatPublicUrls` hook (`undefined`
when there is no hook or the hook throws — the raw decision is never sent as a DTO):

```ts
import { resizer } from '../resizer.ts';   // or: getResizer()

const { output } = await resizer.resolve({
  media: fileDoc,
  pipeline: 'listing',
  sizes: [
    { width: 1760, height: 990 },
    { width: 620 },
    { fit: true },
    { width: 300, height: 300, filters: { blur: 40 } },
  ],
  ctx: { entity: 'event', isOwner },
});
return output; // your own shape, produced by formatPublicUrls
```

---

## Modes: lazy vs pre-warm vs eager

All three modes drive the **same resize core** and write the same `previews[]` shape, so you can
switch later with no data migration, or mix them.

| | **Lazy** (queued, on read) | **Pre-warm** (queued, at upload) | **Eager** (sync, at upload) |
|---|---|---|---|
| Generate | on first read; `resolve()` enqueues missing | at upload; `prewarm()` enqueues the catalog | inline at upload via `resizer.generate(...)` |
| Needs | transport + `ResizeWorker` + `ResizeTask` + locks | same as lazy (transport + worker) | storage + media model only — **no** queue/worker |
| Best for | high volume, fast uploads, large/open-ended catalogs | fast uploads **and** a warm cache by first read | low/bursty volume, small fully-used catalogs, single-process |

> **Start eager.** It is a complete mode: no worker, no queue. **Graduate to lazy or pre-warm**
> when listings are huge and you want uploads to stay fast. The stored shape is identical, so
> you can switch later or mix the three.

**Pre-warm** — keep the lazy wiring (transport + worker), but push the catalog into the **queue**
at upload so the previews are usually ready by the first read: no `sharp` on the request path, no
waiting for the first reader. Never blocks and never throws (same guarantee as `resolve`); `ctx`
reaches the read-path waterfalls (the worker still runs with `ctx === {}`):

```ts
// upload handler, after the media doc is created:
await resizer.prewarm({ media: fileDoc, sizes: getListingSizes(), pipeline: 'listing' });
// → { enqueued } = how many variants were handed to the queue
```

Choose pre-warm when you want **fast uploads and a warm cache** — the request returns immediately
while the worker fills the catalog in the background.

When the upload workflow must know whether every required identity has a confirmed queue receipt,
use the separate strict API:

```ts
const result = await resizer.enqueueRequired({ media, sizes: catalog, pipeline: 'listing' });
// result.status: 'ready' | 'accepted' | 'not-required' | 'incomplete'
// ready / accepted / notRequired / unconfirmed partition the resolved catalog.
// tasks contains non-null transport receipts; issues is a machine-readable retry guide.
```

`prewarm()` remains best-effort and never throws for compatibility. In contrast,
`enqueueRequired()` never treats a held dispatch lock as proof that a task exists. Mongo can query
active task payloads through `findActive()` and prove coverage after a lock race only when the
complete canonical variant payload matches. Each active receipt is checked in full before any
requested payload is matched: two different payloads that collapse to one preview identity are
reported as a non-retryable conflict instead of being guessed. SQS confirms a
successful send by its `MessageId`, but cannot query another producer's message; a lock loser is
therefore `incomplete` and safely retryable. Custom transports may implement `findActive()` or
accept the same explicit limitation. These are at-least-once systems—this API does not promise
exactly-once delivery.

**Eager** — call `generate` from your
upload handler (`ctx` reaches pipeline steps here, unlike the queued worker):

```ts
const { created, failed } = await resizer.generate({
  media: fileDoc,
  sizes: getEventMediaSizes(),   // your catalog — never raw client width/height
  pipeline: 'listing',
});
// No original → ResizeNoOriginalError. Every variant failed → ResizeGenerateError.
// Some fail → no throw, failed > 0. created is this call only.
```

`created` is **only what this call made**. A second `generate` with the same catalog returns
`{ created: [], failed: 0 }` because everything already exists — treat an empty `created` as
"nothing new was needed", never as failure. An SVG original is the same: pass-through, never
rasterized, `{ created: [], failed: 0 }`.

**Hybrid:** `generate` the above-the-fold sizes at upload and let `resolve` lazily fill the heavy
ones on demand — or `prewarm` the whole catalog at upload and let `resolve` cover anything added
later. A host that starts eager can graduate to lazy (or pre-warm) with no migration.

---

## Errors

Every error this module throws extends **`ResizeError`**, so one check separates "the resize
module rejected this" from a `sharp` crash or an S3 timeout. The subclass answers the only
question a catch block actually has — what to do about it:

| Class | Means | Do |
|---|---|---|
| `ResizeSetupError` | wiring/bootstrap is wrong | fix your code; retrying never helps |
| `ResizeConfigError` | host config invalid or violates an invariant | crash at boot |
| `ResizeMediaError` | this media record is unusable | skip it; don't retry |
| ↳ `ResizeNoOriginalError` | `generate` called with no `original` | upload the source first |
| ↳ `ResizeOriginalError` | upload bytes are invalid, unsupported, or over limit | reject/fix the input |
| `ResizeGenerateError` | eager produced nothing, or queued coverage is incomplete | inspect `failed` / `requested` / `missing` |
| `ResizeStorageError` | transient storage I/O | a retry may help |
| `ResizeSecurityError` | a refusal (path traversal, cross-bucket) | never retry; log loudly |

```ts
import { ResizeError, ResizeNoOriginalError } from '@adaptivestone/framework-module-resize';

try {
  await resizer.generate({ media, sizes });
} catch (err) {
  if (err instanceof ResizeNoOriginalError) return badRequest('upload the image first');
  if (ResizeError.isResizeError(err)) return badRequest(err.message);  // any module rejection
  throw err;                                                           // not ours — let it bubble
}
```

Each error also carries a stable, machine-readable `err.code` (`RESIZE_NO_ORIGINAL`,
`RESIZE_STORAGE_REQUIRED`, `RESIZE_FS_PATH_TRAVERSAL`, …) for logging and alerting, plus the
usual `err.name` and `err.cause`.

**Prefer `ResizeError.isResizeError(err)` over `instanceof` across a package boundary.** If two
copies of this package end up in one `node_modules` tree the class identities differ and
`instanceof` silently returns `false` — exactly when you most need the check to work.
`isResizeError` tests a registered symbol instead of the prototype chain, so it keeps working.

---

## Drivers & seams

Four seams, each a single active strategy fixed at construction. Two ship drivers; two default to
framework-backed drivers when omitted, so a standard host wires only `transport` + `storage`.
Every driver lives behind its own package subpath (the core entry never loads driver deps).

| Seam | Option | Shipped | Subpath import |
|---|---|---|---|
| Queue transport | `transport?` | `MongoTransport`, `SqsTransport` | `…/transports/mongo.js`, `…/transports/sqs.js` |
| Storage | `storage` **(required)** | `LocalFsStorage`, `S3Storage` | `…/storage/fs.js`, `…/storage/s3.js` |
| Media store | `mediaStore?` | `FrameworkMediaStore` (default) | `…/mediaStore/framework.js` |
| Lock provider | `lockProvider?` | `FrameworkLockProvider` (default) | `…/locks/framework.js` |

`storage` is the one **required** option (both modes need it). `transport` is optional (omit for
eager-only). `mediaStore`/`lockProvider` default to the framework drivers. Reach the process-wide
instance anywhere via `getResizer()` (throws a clear error if none was constructed).

### `MongoTransport`

Option-less: `new MongoTransport()`. Backed by the scaffolded `ResizeTask` model; uses the
`config.queue` lease/retry knobs. It also implements the optional `findActive()` capability used
by `enqueueRequired()` to prove coverage after dispatch-lock races. No optional deps.

### `SqsTransport({ … })`

| Option | | |
|---|---|---|
| `queueUrl` | **required** | the SQS queue URL |
| `region`, `endpoint` | optional | AWS region / custom endpoint |
| `visibilityTimeout` | optional | seconds; passed to `sqs-consumer` |
| `heartbeatInterval` | optional | seconds; extends visibility during long resizes (SQS analog of the Mongo lease heartbeat) |
| `client` | optional | bring-your-own configured `SQSClient` (else built from `region`/`endpoint` on first use) |

Credentials are never options — they resolve via the standard AWS provider chain. Dead-lettering is
**native** (configure the queue's redrive policy with `maxReceiveCount = config.queue.maxAttempts`);
`onTaskDeadLettered` does not fire for SQS.

### `LocalFsStorage({ … })`

| Option | | |
|---|---|---|
| `rootDir` | **required** | files land under this directory |
| `publicBaseUrl` | **required** | URL prefix for `publicUrl()`, e.g. `/media` |

Default story for tests and first-week local. Same `download` / `upload` / `publicUrl` contract.
Option is `publicBaseUrl` (never `publicUrl`) so it cannot shadow the method.

The host must (1) write originals under `rootDir` at `original.key`, (2) serve `rootDir` at
`publicBaseUrl` (otherwise every URL 404s), and (3) treat this as a **local/dev** store:
`visibility` is accepted and ignored — originals and previews share one tree.

### `S3Storage({ … })`

```ts
new S3Storage({
  bucketPublic,
  bucketPrivate,
  publicBaseUrl, // alias of the old `publicUrl` for one minor
  client,        // existing S3Client — env/keys stay in the host
});
```

| Option | | |
|---|---|---|
| `bucketPublic` | **required** | previews land here (`public` visibility) |
| `bucketPrivate` | optional | originals (`private`); defaults to `bucketPublic`; configure a distinct private bucket when originals must stay private |
| `publicBaseUrl` | optional | CDN/base URL for public objects |
| `publicUrl` | optional | **deprecated** alias of `publicBaseUrl` (one minor) |
| `region`, `endpoint`, `forcePathStyle` | optional | S3-compatible targets (MinIO / localstack / R2) |
| `client` | optional | bring-your-own configured `S3Client` — show this first |

`publicUrl()` is **pure and I/O-free** (called on the read path). No per-object ACL — public access
is a bucket policy. Credentials via the AWS provider chain. `download`/`publicUrl`/`signedUrl`
enforce a **bucket allowlist**: a stored `ref.bucket` must be one of the configured
`bucketPublic`/`bucketPrivate`, else they throw a named error — so a tampered media-doc `bucket`
can never become a cross-bucket read or an attacker-controlled hostname in a URL.

### Custom driver = implement the interface

Any seam takes a plain object (or class) that satisfies the interface — no `app` parameter; it
closes over its own client. For plain S3 use `S3Storage`; for anything else (GCS, filesystem, R2):

```ts
new Resizer({ /* … */, storage: {
  download: (ref) => s3.getObject(ref.bucket!, ref.key),
  upload: async ({ key, body, contentType, visibility }) => {
    const bucket = visibility === 'public' ? 'my-cdn' : 'my-originals';
    await s3.putObject(bucket, key, body, contentType);
    return { bucket, key };               // ← persisted onto the preview/original
  },
  publicUrl: (ref) => `https://cdn.example.com/${ref.key}`,   // pure; no I/O
  signedUrl: (ref, ttl) => s3.getSignedUrl(ref.bucket!, ref.key, ttl),
}});
```

The same pattern swaps `mediaStore` (e.g. another DB/ORM) or `lockProvider` (e.g. Redis/redlock).
Contract types (`QueueTransport`, `ResizeStorage`, `MediaStore`, `LockProvider`, …) are exported
from the main entry for custom-driver authors.

---

## Pipelines & hooks

**Pipelines** are named per-media-type pixel work, selected per read call by name. The worker runs
in a separate process, so the task carries only the pipeline **name** — the worker resolves the
functions from its own registry (bootstrap runs in both processes).

Pipeline names are not part of preview identity. For the same media, dispatch locks, worker
locks, and stored previews are shared by size + format + filters across all pipelines. Use a
consistent pipeline for each media record. If the same media needs multiple renderings at the
same size and format, give each rendering distinct `filters` and pass those filters on reads too.

```ts
pipelines: {
  photo: {
    beforeSteps:  [detectAndBlurPlates, detectAndBlurFaces],  // run ONCE on the source, before any resize
    variantSteps: [(img, { variant }) => variant.filters?.blur ? img.blur(Number(variant.filters.blur)) : img],
  },
  avatar: {},                                                 // no special processing
}
// later / from another module: getResizer().registerPipeline('premium', { … })  (last-wins per name)
```

- **`beforeSteps`** — ordered, awaited, once per task on the source buffer. The home for detection
  metadata and pixel redaction (plate/face blur) that must apply to every variant. A throwing step
  fails the task (hard-stop on, e.g., an NSFW verdict).
- **`variantSteps`** — ordered (registration order matters) per-variant chain, after resize, before
  encode. The home for keyed `filters` and anything sized relative to the output.

> ⚠ **Put a watermark in `variantSteps`, not `beforeSteps`.** Baked onto the original once, a
> watermark scales down with each variant and becomes unreadable on small sizes.

> **`ctx` does NOT cross the queue.** In the lazy worker `ctx === {}` — the task carries only
> `{ mediaId, pipeline, previews }`. Durable per-media data a step needs must be read from the
> loaded `media` doc (or persisted onto it earlier). The full caller `ctx` reaches steps **only** in
> eager mode (`generate`, same process).

**Hooks** are the cross-cutting seams. Taps run in registration order, awaited sequentially, and are
error-isolated (a throwing tap is logged, never breaks the read/worker flow).

| Hook | Kind | Signature | Runs where |
|---|---|---|---|
| `resolveSizes` | waterfall | `(sizes, ctx) => sizes` | read path (real `ctx`) |
| `beforeEnqueue` | waterfall | `(missing, ctx) => missing` | read path (real `ctx`) |
| `formatPublicUrls` | waterfall | `(decision, ctx) => unknown` | read path (real `ctx`) |
| `onPreviewGenerated` | observer | `(preview, ctx)` | worker (`ctx === {}`) |
| `afterTaskComplete` | observer | `(task, ctx)` | worker (`ctx === {}`) |
| `onTaskFailed` | observer | `(task, error, ctx)` | per failed attempt (will retry) |
| `onTaskDeadLettered` | observer | `(task, error, ctx)` | task exhausted `maxAttempts` (host can alert/page) |

Register at construction (`hooks:`) or later via `getResizer().hook(name, fn)` (appends). Every
observer is **also** mirrored on the framework event bus as `resize:<name>` (e.g.
`resize:onTaskDeadLettered`), fire-and-forget, for ecosystem subscribers — but the typed `hook()`
registry stays the primary contract because it is awaited and error-isolated.

Taps are **typed** (`HookSignatures`): `hooks:` and `hook(name, fn)` infer each tap's exact
signature from its name, so autocomplete works and a wrong argument/return shape is a compile error
instead of a silent `any`. In every observer the `task` argument is the transport-agnostic
`LeasedTask` (`{ taskId, mediaId, pipeline, previews }`) on **both** the Mongo and SQS transports —
never a raw driver document — so a host tap is portable across transports.

---

## Sizes & identity

A size becomes a canonical **size key** via `getSizeKey`, and the full lookup/lock **identity** is
`sizeKey:format:filterSig`. Filters are part of identity (empty → `none`), so a blurred variant is a
distinct object.

| Size input | Size key | Meaning |
|---|---|---|
| `{ width: 300, height: 300 }` | `300x300` | cropped (cover) |
| `{ width: 620 }` | `620w` | width-only (banner/strip) |
| `{ height: 400 }` | `400h` | height-only |
| `{ fit: true }` | `fit` | uncropped ("contain"), bounded by `config.maxSize` |
| `{ width: 300, height: 300, filters: { blur: 40 } }` | `300x300` + `blur:40` in the identity | keyed alternate rendering |

The **host owns the size catalogs** per entity, injected via `resolveSizes` + per-call `sizes`.
Illustrative catalogs (entity names are generic examples, not prescriptive):

| Entity | Sizes |
|---|---|
| gallery / detail image | `1760x990`, `618x360` |
| banner / strip (width-only) | `620w` |
| avatar | `200x200`, `160x160`, `80x80`, `50x50` |
| thumbnail set | `100x70`, `200x140`, `400x280`, `800x560` |
| full gallery + uncropped view | `933x700`, `1866x1400`, `360x270`, `fit` |
| preview | `150x150`, `200x200`, `400x400` |

> **Security: the catalog is an allowlist.** Never pass raw client-supplied dimensions into `sizes`
> — resolve them against a fixed per-entity catalog first, or you invite arbitrary-resize resource
> abuse. The module owns the identity key; the host owns which sizes are permitted.

```ts
import {
  formatPictureUrls,
  isCatalogCovered,
  resizeMediaPaths,
} from '@adaptivestone/framework-module-resize';

isCatalogCovered(media, sizes, formats); // optional skip; generate is already a no-op when covered
File.find().select(['mediaType', ...resizeMediaPaths]);
formatPictureUrls(decision, { id }); // unfiltered <picture> map; filtered variants stay on decision
```

---

## Config reference

`src/config/resize.ts` (scaffolded, editable) is loaded by the framework, then its values are
deep-merged over module defaults by `getResizeConfig()` when `new Resizer()` is created. Config
errors therefore surface when the module is constructed (which must be after `Server.init()`), not
on the first image request. **Arrays REPLACE** (so
`formats: ['webp','avif']` doesn't concat to five); nested objects merge field-by-field.
Keep only host overrides in this file: `formats` selects generated previews, while
`upload.formats` is the independent allowlist for original input bytes.

| Key | Default | Notes |
|---|---|---|
| `mediaModelName` | — (**required**) | your host media model name (`'File'`/`'Media'`) |
| `formats` | `['jpeg','webp','avif']` | generated formats |
| `upload.maxBytes` | `26214400` (25 MiB) | maximum original byte length checked before storage |
| `upload.formats` | `['jpeg','png','webp','avif','gif','svg']` | allowed formats, determined from bytes |
| `webpAvifOnly` | `false` | filters `jpeg` from configured `formats`; adds nothing, and an empty result is invalid |
| `maxSize` | `{ width: 2000, height: 1200 }` | the `fit` cap |
| `animated` | `false` | `true` keeps GIF/WebP frames |
| `encode.quality` | `{ jpeg: 80, webp: 82, avif: 64 }` | per-format — sharp codec defaults aren't perceptually comparable; never reuse one int |
| `encode.effort` | `{ webp: 4, avif: 4 }` | encode-once + CDN-cached, so 5–6 is often worth it |
| `encode.mozjpeg` | `true` | progressive + trellis quantization |
| `encode.chromaSubsampling` | `'4:2:0'` | `'4:4:4'` keeps full chroma for text/logos/UI |
| `encode.sharpen` | `{ cover: true, fit: false }` | mild unsharp after downscale (off for the large modal) |
| `encode.flattenBackground` | `'#ffffff'` | alpha → jpeg flatten color |
| `limits.inputPixels` | `268402689` | sharp decoder bomb guard |
| `limits.sourcePixels` | `50_000_000` | rejected before decode, from metadata |
| `limits.resultDimension` | `5000` | clamp on the cover branch |
| `limits.animationFrames` | `64` | animation-bomb guard |
| `queue.lockTtlMs` | `{ dispatch: 60000, worker: 60000 }` | worker ≤ `leaseMs` |
| `queue.leaseMs` | `60000` | heartbeat renews at `leaseMs/2`; set ≥ ~2× worst-case encode |
| `queue.retryBackoffMs` | `{ base: 5000, max: 300000 }` | delayed re-lease on fail |
| `queue.maxAttempts` | `5` | delivery count before dead-letter (increments on every lease incl. reclaims, like SQS `maxReceiveCount`) |
| `queue.idlePollMs` | `1000` | empty-lease sleep |
| `queue.taskTimeoutMs` | `600000` | `handleTask` is raced against this; on timeout the task is failed and the slot freed (Mongo transport) |
| `worker.enabled` | `false` | set `true` in host config to permit the worker command to run |
| `worker.concurrency` | `4` | variants resized in parallel per task |
| `worker.sharpConcurrency` | `1` | `sharp.concurrency()`; keep `concurrency × sharpConcurrency ≈ nCPU` |
| `worker.sharpCache` | `false` | a worker processes distinct images; the op-cache mostly wastes memory |

Storage buckets/URLs and the SQS queue URL are **not** config — they are driver options passed to
`new S3Storage({...})` / `new SqsTransport({...})`.

---

## Operations

**`ResizeTask` lifecycle** (Mongo transport): `pending → processing → completed | dead`. Retries are
capped at `queue.maxAttempts`, then the task is **dead-lettered** (`status:'dead'`) — the lease never
reclaims a task past the cap, so no crash-loop runs forever. (SQS uses its native DLQ instead.)

**Retention TTLs:** `completed` rows evict after 24h; `dead` rows are kept ~30 days for
inspection/replay (edit the `expireAfterSeconds` in the scaffolded model to taste).

**Dead-letter replay** is a host op. First look for an active row with the same
`fileId` + `pipeline` + `requestKey`; if it exists, keep that row — it already represents
the same work. Otherwise reset the dead row:

```ts
const activeFilter = {
  fileId: row.fileId,
  pipeline: row.pipeline,
  requestKey: row.requestKey,
  status: { $in: ['pending', 'processing'] },
};
let active = await ResizeTask.findOne(activeFilter);
if (!active) {
  try {
    await ResizeTask.updateOne(
      { _id: row._id, status: 'dead' },
      { $set: { status: 'pending', attempts: 0, leaseExpiresAt: null } },
    );
  } catch (error) {
    // Another operator created the same active request after our first read.
    if ((error as { code?: number }).code !== 11000) throw error;
    active = await ResizeTask.findOne(activeFilter);
    if (!active) throw error;
  }
}
```

The active-row lookup is important because the partial unique index rejects two live copies
of the same request. If a concurrent operator creates one after the lookup, the example
re-reads that active row instead of retrying the dead row.

**Delivery is at-least-once** (both transports); the worker is **idempotent** — re-running a task
for an already-generated identity skips via the existing-preview check, never duplicates. A
raster task completes only when every requested identity is covered. Successfully uploaded
variants are persisted before an incomplete task is failed into the existing backoff/retry path;
the next delivery generates only the missing identities, and permanent gaps reach dead-letter.
`afterTaskComplete` fires only after full coverage. A deleted media row and a stray SVG task remain
successful no-ops; a live row without `original.key` is an observable terminal media error.

**SVG originals are pass-through.** They stay SVG (`image/svg+xml`) at every requested
size/format; the read path never resizes or enqueues them. To keep originals private while
publishing SVG to everyone, persist the private original before publishing its copy:

```ts
const original = await resizer.uploadOriginal({ body: sanitizedSvg, visibility: 'private' });
media.original = original;
await media.save();

if (original.format === 'svg') {
  const copy = await resizer.uploadOriginal({ body: sanitizedSvg, visibility: 'public' });
  media.original = {
    ...original,
    publicCopy: { key: copy.key, bucket: copy.bucket },
  };
  await media.save();
}
```

With `S3Storage`, configure distinct `bucketPrivate` and `bucketPublic` values and a bucket
policy that keeps the private bucket inaccessible to the public. Without `bucketPrivate`, the
driver stores both uploads in `bucketPublic`. The original locator stays in `media.original`;
`publicCopy` holds only the public locator. `resolve()` serves the copy when
`canServeOriginalPublicly()` confirms it and otherwise retains the existing signed URL rule for
private originals. Save the private original first so a failed public upload leaves a durable
source to retry from. If saving `publicCopy` fails after its upload, the host must retry that
save or clean up the unreferenced public object. A custom storage driver must implement
`canServeOriginalPublicly()` for anonymous SVG delivery; `LocalFsStorage` has no private area.
The host owns cleanup of both objects. `saxes` checks XML structure but does not remove scripts
or external links; **sanitize SVG in the host before either upload.**

**Original visibility is explicit.** Storage drivers that can prove an original is public should
implement `canServeOriginalPublicly(ref)`. The engine never treats an arbitrary custom driver's
`publicUrl` as proof and never falls back from a failed private presign to a public URL. Existing
previews remain the preferred public read path.

**Deleting media / storage cleanup is host-owned.** The module appends previews but does not delete
them; removing a media doc's storage objects (originals, public SVG copies, and derivatives) is your lifecycle.

---

## Host responsibilities

The module owns the resize core; the host owns everything domain-specific (spec §15):

- The public **response DTO shape** (via `formatPublicUrls`).
- **Which domain models** attach media and the **size catalogs** per entity (via `resolveSizes` +
  per-call `sizes` — treat catalogs as allowlists).
- **Data migration** from any legacy preview schema.
- **Domain image analysis** — NSFW/object detection, plate/face blur, watermark, masking (inject via
  pipeline `beforeSteps`/`variantSteps`).
- **Permissions** — who may delete/replace media; the host may pass `ctx.isOwner`/`ctx.isAdmin` to
  opt a read into a signed-original URL.
- **SVG sanitization** and **deleting media / storage cleanup**.

---

## Testing

The framework enforces one app instance per process; tests install a fake via `setAppInstance(fake)`
/ `resetAppInstance()` (the `node:test` runner isolates each file in its own process). Build fresh
Resizers with `resetResizerForTests()` between constructions. Run the full `node:test` suite with
`npm test`.

## License

MIT
