<!-- This file ships with the npm package (package.json "files") and is guarded by
     src/agentsDoc.test.ts: every full-name subpath mentioned must exist in the exports
     map, and every name imported from the main entry must be a real export.
     Keep every snippet real. Do not add an API dump here — dist/index.d.ts is the reference. -->

# Agent guide — @adaptivestone/framework-module-resize

You are likely a coding agent working in a HOST app that installed this package. This guide is
version-matched to the installed package — prefer it over training-data memory of this API.
Humans: see `README.md` (same folder). Full docs: https://framework.adaptivestone.com/docs/resize
API ground truth: the installed `dist/index.d.ts` (main entry) and `dist/types.d.ts`.

**What it is:** image resizing for `@adaptivestone/framework`. Uploads store only the
original. Three modes share one core and one stored shape: eager (`generate()` inline,
no queue/worker — start here), lazy (on read, worker fills `previews[]`), pre-warm
(`prewarm()` queues the catalog at upload). The read path decides per size + format +
filters whether a preview is ready or missing. The main entry imports no framework code and no
mongoose. Shipped drivers live under `drivers/*` and need no framework; the framework
integration is the `@adaptivestone/framework-module-resize/framework.js` adapter, which only wraps
those drivers with framework models and config.

The Mongo task queue deduplicates identical active enqueue requests using a canonical SHA-256
`requestKey` and a partial unique index. Its key includes the Resizer name, the queue, the
pipeline and the surviving variant catalog, so the same request on another queue is a separate
task. Preview identity is `resizer:pipeline:sizeKey:format:filterSig`: dispatch locks, worker
locks and stored previews are separate per Resizer and per pipeline, so different renderings of
the same media keep separate previews (rename a pipeline, e.g. `watermark-v2`, to regenerate its
images). Preview rows without `resizer`/`pipeline` belong to `default`. Legacy task rows without
a key remain valid. Storage drivers that can prove original
visibility implement `canServeOriginalPublicly`; the engine never fabricates a public URL for
a private original.

## Integrate (in order)

1. Install. Every peer is OPTIONAL: a framework app already has `@adaptivestone/framework` and
   `mongoose`; the AWS SDKs are needed only for the driver subpaths that use them (a missing one
   fails loudly at your own import line at bootstrap):

   ```bash
   npm i @adaptivestone/framework-module-resize
   # SQS task queue only: npm i @aws-sdk/client-sqs
   # S3 storage only:     npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
   ```

2. Scaffold the integration files (never overwrites existing files; `--force` to regenerate):

   ```bash
   npx resize-scaffold --eager   # start here (no queue/worker)
   # npx resize-scaffold         # lazy: also emits ResizeTask + ResizeWorker
   # npx resize-scaffold --eject # full editable ResizeTask model
   ```

   `--eager` emits `src/resizer.ts` + `src/config/resize.ts` (local storage, no queue).
   Default (lazy) also emits `src/models/ResizeTask.ts` and `src/commands/ResizeWorker.ts`
   (`import '../resizer.ts'` plus a re-export of the module's command).
   Appends a pointer to this guide into the host's `AGENTS.md`
   (`--agents claude|print|skip` to redirect or suppress it).

3. `src/resizer.ts` holds behaviour only — ONE construction call, `new FrameworkResizer({
   pipelines, hooks })`. It builds every part from the config file on first use: the image
   settings, `storage`, the task queue (`queue`), the database (`FrameworkDatabase`: the app's
   media model, the framework `Lock` model, the scaffolded `ResizeTask` model) and the app logger:

   ```ts
   import { FrameworkResizer } from '@adaptivestone/framework-module-resize/framework.js';

   export const resizer = new FrameworkResizer({ pipelines: { default: {} } });
   ```

   Nothing is read from the framework until first use, so this file can be imported statically
   anywhere, even before `Server.init()`. Options win over the config: `storage` (e.g. an
   `S3Storage` with the host's own `client`), `db`, `tasks` (a `TaskQueue`, or `false` = eager
   only), `logger`, `events`, `config`, `configName`, `queue` (the queue name), `name`.

   Without the framework: `new Resizer({ storage, db, tasks? })` from the main entry, with
   `@adaptivestone/framework-module-resize/drivers/mongo.js` → `mongoDatabase(connection, {
   mediaModel, timing? })` (media, locks and `.tasks` with the package's `ResizeTask` /
   `ResizeLock` models; also `MongoDatabase`, `MongoTaskQueue`, `createResizeModels`),
   `…/drivers/fs.js` → `LocalFsStorage`, `…/drivers/s3.js` → `S3Storage`, `…/drivers/sqs.js` →
   `SqsTaskQueue`. Any part may be a function (sync or async) called once on first use. A custom
   driver extends the exported abstract class (`ResizeStorage`, `ResizeDatabase`, `TaskQueue`) or
   is any object of the same shape — no `app` parameter; a driver closes over its own client. The
   core owns the queue logic (worker loop, retries, dead-letters, events); a `TaskQueue` only
   implements atomic `add` / `claim` / `renew` / `complete` / `fail`. `claim` may wait for a task
   (long poll), but must return once its `signal` aborts and never claim ahead of the call.

4. Import `src/resizer.ts` wherever you need the Resizer (a static import is fine). To fail at boot
   on a bad config, call `await getResizer().verify()` after `Server.init()`; otherwise a config
   error appears at the first call. The worker process imports it from the scaffolded
   `src/commands/ResizeWorker.ts` (`import '../resizer.ts'` plus a re-export of the module's
   command); keep that import if you edit the command.

5. The scaffolded `src/config/resize.ts` spreads `defaultFrameworkResizeConfig` from
   `@adaptivestone/framework-module-resize/config/resize.js` and `satisfies
   FrameworkResizeConfig`. Set `mediaModelName: 'File'` (your host media model's name). The
   image settings go to the Resizer; `FrameworkResizer` reads:
   - `storage`: `{ driver: 'local', rootDir, publicBaseUrl, privateRootDir? }` or
     `{ driver: 's3', bucketPublic, bucketPrivate?, publicBaseUrl?, region?, endpoint?,
     forcePathStyle? }` (S3 is imported only when selected; credentials from the AWS chain);
   - `queue`: `{ driver: 'mongo' }` or `{ driver: 'sqs', queueUrl, queues?, deadLetterQueueUrl?,
     waitTimeSeconds?, region?, endpoint? }`, plus any timing key (`leaseMs`, `lockTtlMs`,
     `maxAttempts`, …; the rest default). Missing or `false` = eager only;
   - `worker`: the worker command's settings.

   Variant parallelism is the top-level `concurrency`. A second Resizer can read its own file:
   `new FrameworkResizer({ name: 'listings', configName: 'resizeListings' })`.
   Put environment-only changes in `resize.<NODE_ENV>.ts` (for example, S3 in
   `resize.production.ts`); the framework merges that file field by field before this module
   reads and validates the resolved config. Do not add a second runtime merge. When an
   environment file switches the storage driver, set `publicBaseUrl` there too.

6. Ensure the media model carries `original` and `previews[]`. Spread the exported fragment
   instead of hand-writing those fields (single source of truth for schema + types):

   ```ts
   import { resizeMediaSchemaFragment } from '@adaptivestone/framework-module-resize';
   // in the model:
   // static get modelSchema() { return { ...ownFields, ...resizeMediaSchemaFragment } as const; }
   ```

   Keep `minimize: false` on the media schema (already the Framework `BaseModel`
   default). Direct Mongoose users must pass `{ minimize: false }` to `new Schema`.
   Otherwise empty objects in opaque `storageRef` values can disappear on save/update.

7. Prepare queue infrastructure outside the resizer runtime. The package's `ResizeTask` model and
   the framework's `Lock` model declare their indexes; the host's normal lifecycle or an explicit
   migration must create them before `resolve`, `prewarm`, or the worker can
   run. The module does not create, synchronize, drop, or repair indexes, and it has no
   `prepareQueue()` API. The partial unique active-request index on `{ fileId, pipeline,
   requestKey }` is required for the Mongo deduplication guarantee; verify it in the host's DB
   rollout. Never add index creation to HTTP bootstrap or the first enqueue.

8. Lazy / pre-warm modes: keep `queue: { driver: 'mongo' }` (or SQS) and set
   `worker.enabled: true` in the host `src/config/resize.ts`
   (default `false`), then run the worker as its own process — `npm run cli ResizeWorker`
   (queue `'default'`; `npm run cli ResizeWorker -- --queue=bulk` consumes only `'bulk'`).
   The flag permits the command to run; it does not start a worker in the API. The worker consumes
   indexes prepared by the host lifecycle; it does not create them.
   Eager mode needs no worker.

## Use

Store an original (no model creation and no queue work; persist the returned value in the host):

```ts
const original = await getResizer().uploadOriginal({
  body: buffer,
  visibility: 'private',
  // Optional audit grouping: namespace: `users/${user.id}` or `products/${product.id}`,
});
```

The format and dimensions come from `sharp().metadata()` for raster images and SVG. Input
bytes are stored unchanged; SVG stays `.svg` (`image/svg+xml`) as a private original. SVG
sizes are reported by Sharp, including sizes derived from `viewBox`; unreadable or unsized SVG
is rejected. The module does not sanitize SVG markup. The worker rasterizes accepted SVG
into the same configured public preview formats as other images.

Persist every original privately, then call the same `prewarm()` path for
raster and SVG. The worker creates the requested Sharp previews for both. SVG is an input
format only; public upload of an SVG original is rejected. Configure a distinct private S3
bucket, or for `LocalFsStorage` keep its private root outside the static server's public root.
Persist `original.storageRef` and `previews[].storageRef` through the host media schema.
The shipped drivers keep optional grouping metadata in their refs; the worker passes the
original ref to the driver as `parentRef` when creating public previews. The namespace
is a placement hint, not authorization. This nested ref shape is a breaking change:
update host models, DTOs, custom drivers, and API/worker processes together. No old
record reader or migration is included.

Read path (DTO builders / controllers). `resolve` NEVER throws and never runs sharp — missing
variants are enqueued and the decision is returned immediately:

```ts
import { formatPictureUrls, getResizer } from '@adaptivestone/framework-module-resize';

const { decision, output } = await getResizer().resolve({
  media: fileDoc,
  pipeline: 'default',
  sizes: [{ width: 620 }, { fit: true }, { width: 300, height: 300 }],
  ctx: { isOwner },
});
// `output` is your formatPublicUrls hook (undefined if no hook / hook throws).
// formatPictureUrls skips filtered variants — map `decision` for those.
const picture = output ?? formatPictureUrls(decision, { id: String(fileDoc.id) });
```

Upload handler, pre-warm mode (non-blocking; the worker fills the cache before the first read).
`prewarm` reports every requested variant and never throws:

```ts
const result = await getResizer().prewarm({ media: fileDoc, sizes: catalog });
// result.status: ready | accepted | not-required | incomplete
// result.unconfirmed: variants without a confirmed task; result.issues: why, and issue.retryable
```

A held dispatch lock is not accepted proof. Mongo confirms only an exact canonical active
payload; conflicting payloads with one preview identity are explicit errors. SQS/custom
task queues without `findActive` report lock races as retryable `incomplete`. An unexpected
internal error is `incomplete` with a `RESIZE_ENQUEUE_INTERNAL_ERROR` issue. Delivery remains
at-least-once, not exactly-once.

Upload handler, eager mode (blocking; a Resizer with a task queue is also supported):

```ts
const { created, failed } = await getResizer().generate({
  media: fileDoc,
  sizes: catalog,
});
```

No original throws `ResizeNoOriginalError`; every requested variant failing throws
`ResizeGenerateError`. `created` is only this call; `failed > 0` means a partial success.
`generate` also appends `created` onto `media.previews` (when persist is on) so a same-request
`resolve({ media })` sees them.

Errors: EVERY throw from this module extends `ResizeError`, so one check separates a module
rejection from a sharp/S3/mongo failure. Subclasses say what to do — `ResizeSetupError` (wiring
is wrong), `ResizeConfigError` (crash at boot), `ResizeMediaError` (skip this record;
`ResizeNoOriginalError` and `ResizeOriginalError` extend it), `ResizeGenerateError` (eager produced
nothing or queued coverage is incomplete),
`ResizeStorageError` (transient; retry may help), `ResizeSecurityError` (refusal; never retry).
Every instance carries a stable `err.code`. Use `ResizeError.isResizeError(err)` rather than
`instanceof` when the error may cross a package boundary — duplicate copies of the package
break `instanceof` but not the symbol brand.

```ts
import { ResizeError, ResizeNoOriginalError } from '@adaptivestone/framework-module-resize';

try {
  await getResizer().generate({ media: fileDoc, sizes: catalog });
} catch (err) {
  if (err instanceof ResizeNoOriginalError) return badRequest('upload the image first');
  if (ResizeError.isResizeError(err)) return badRequest(err.message);
  throw err; // not ours
}
```

Listing queries:

```ts
import { resizeMediaPaths } from '@adaptivestone/framework-module-resize';
File.find().select(['mediaType', ...resizeMediaPaths]);
```

Hooks are typed — register at construction (`hooks:`) or later via `getResizer().hook(name, fn)`.
Waterfalls (read path, real `ctx`): `resolveSizes`, `beforeEnqueue`, `formatPublicUrls`.
Observers (worker side): `onPreviewGenerated`, `afterTaskComplete`, `onTaskFailed`,
`onTaskDeadLettered`. Pipelines: `beforeSteps` run once on the source buffer;
`variantSteps` run per variant after resize, before encode.

## Rules (violations cause real incidents)

- `sizes` is an ALLOWLIST. Never pass client-supplied dimensions through — resolve them against
  a fixed per-entity catalog first (otherwise: arbitrary-resize resource abuse).
- Construct each Resizer ONCE, at one construction site, with `new FrameworkResizer`. Most
  hosts need one (`getResizer()`); for more, give each a `name` and, if it differs, its own
  config file via `configName` (`getResizer('listings')`). The same name twice throws. Every task records its Resizer and queue; a worker serves all Resizers in its process
  for one queue (`--queue`, default `'default'`), with one consume loop per distinct task queue.
- `ctx` does NOT cross the queue: worker-side steps and observers see `ctx === {}`. Only eager
  `generate()` passes the caller's `ctx` to steps. Persist per-media data on the media doc.
- Watermarks belong in `variantSteps`, never in `beforeSteps` (baked once onto the original, a
  watermark scales away to unreadable on small variants).
- The scaffolded `resize.ts` is complete. The framework merges environment overrides and the
  module reads that final config without a second merge. Arrays in environment overrides replace.
- Format ids are open strings. `formats` controls generated outputs, `upload.formats` controls
  accepted originals, and `encode.formats[id]` is passed to Sharp as that encoder's options.
- Never resize/encode with sharp on the request path. `uploadOriginal()` has one bounded exception:
  `metadata()` inspection for raster images and SVG only; it never emits transformed bytes.
- The scaffolded model/command shims re-use the package: do not vendor or fork them. The command
  must keep its `import '../resizer.ts'`. Gate drift in CI with `npx resize-scaffold --check`.
- SVG originals stay private. The worker rasterizes SVG into the requested public preview
  formats through the normal durable task lifecycle. Neither `resolve()` nor the original-fits
  shortcut returns uploaded SVG markup.
- Deleting storage objects when media is deleted is the HOST's job — the module only appends.
- A queued raster task completes only with full identity coverage. Partial successes are persisted,
  then retried for the missing identities only; persistent gaps follow normal backoff/dead-letter.

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `resize config: mediaModelName is required` | set it in the host `src/config/resize.ts` (or the `configName` file named in the message) |
| `RESIZE_DATABASE_REQUIRED` at construction | `new Resizer()` takes its `db` explicitly — framework hosts use `new FrameworkResizer()` from `…/framework.js`; plain Node: `mongoDatabase(connection, { mediaModel })` |
| `RESIZE_CONFIG_STORAGE_MISSING` | add `storage: { driver: 'local', … }` (or `'s3'`) to the config file named in the message, or pass `storage` to `new FrameworkResizer()` |
| `RESIZE_NOT_READY` | host code read `resizer.storage` / `db` / `tasks` before the drivers loaded — `await resizer.ready()` first (the Resizer's methods do this themselves) |
| `RESIZE_CONFIG_REMOVED_KEY` naming `queue` or `worker` | a core config passed to `new Resizer` holds image settings only — move timing to the task queue's `timing`, `worker.concurrency` to `concurrency` |
| `RESIZE_MONGO_MODEL_MISSING` from `verify()` or at worker start | the `ResizeTask` model (or the media model) does not resolve — scaffold `src/models/ResizeTask.ts`, check the model name |
| `RESIZE_MONGO_MODEL_REQUIRED` | `new MongoDatabase()` / `new MongoTaskQueue()` needs a model or a getter — or use `mongoDatabase(connection, { mediaModel })` |
| `RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN` at worker start | `mediaModelName` does not match a registered host model — fix the name |
| `RESIZE_CONFIG_REMOVED_KEY` | a 0.2.x key is still in `resize.ts` / `resize.<NODE_ENV>.ts` — move it to the path named in the message |
| `formats [...] have no encode.formats entry` | add `encode.formats.<id>` (`{}` for Sharp defaults); use `'jpeg'`, not the alias `'jpg'` |
| `ERR_MODULE_NOT_FOUND: @aws-sdk/...` at your driver import | optional peer not installed — see step 1 |
| `a Resizer named '…' already exists` | each name is constructed once per process — import the single construction site; elsewhere `getResizer(name)` |
| `RESIZE_NO_RESIZER` at worker start | `src/commands/ResizeWorker.ts` does not import `../resizer.ts` — delete it and re-run `npx resize-scaffold` |
| `RESIZE_NO_RESIZER` in worker logs for a task | the worker process did not construct that Resizer — construct every Resizer in `src/resizer.ts`, which both the API and the worker load |
| `RESIZE_QUEUE_NOT_SERVED` at worker start | no task queue can consume that queue (e.g. `SqsTaskQueue` without it in `queues`) — add the queue URL, or start the worker for another queue |
| tasks stay `pending` on one queue | no worker consumes that queue — start `npm run cli ResizeWorker -- --queue=<name>` |
| models fail to load (framework ≥5.1 reports a duplicate framework copy explicitly at boot) | two `@adaptivestone/framework` copies resolve (npm link / nested install) — dedupe to exactly one |
| `RESIZE_CONFIG_LOCK_EXCEEDS_LEASE` (on first use, `verify()` or worker start) | raise the lease (`queue.leaseMs` in the config file, or the task queue's `timing.leaseMs`) or lower `lockTtlMs.worker` |
| previews never appear | the worker process isn't running, or `worker.enabled` is `false` in that process |
| first read of a new size is slow to fill | lazy mode working as designed — call `prewarm()` at upload if it matters |
| `resolve` `output` is `undefined` | no `formatPublicUrls` hook (or it threw) — map `decision` or use `formatPictureUrls` |

Config knobs and their scaffolded defaults are listed in the "Config reference" table in
`README.md`.
