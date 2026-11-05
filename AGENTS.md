<!-- This file ships with the npm package (package.json "files") and is guarded by
     src/agentsDoc.test.ts: at most 5,000 words, every full-name subpath mentioned must exist in the
     exports map, and every name imported from the main entry must be a real export.
     Keep every snippet real. It holds what a new integration needs: a new detail goes to README.md
     or UPGRADING.md. Do not add an API dump here — dist/index.d.ts is the reference. -->

# Agent guide — @adaptivestone/framework-module-resize

You are likely a coding agent working in a HOST app that installed this package. This guide is
version-matched to the installed package — prefer it over training-data memory of this API. It holds
what a new integration needs. The rest is one link away, in this folder:

- [`README.md`](./README.md): the reference. Every option and driver contract, and
  [`## Error codes`](./README.md#error-codes), the full error table.
- [`UPGRADING.md`](./UPGRADING.md): read it first when a host moves from an earlier version.
- API ground truth: the installed `dist/index.d.ts` (main entry) and `dist/types.d.ts`.
- For people: the guide, https://framework.adaptivestone.com/docs/resize. The guide and GitHub show
  the newest release; this file matches the version you have installed.

**What it is:** image resizing for `@adaptivestone/framework`. Uploads store only the
original. Three modes share one core and one stored shape: eager (`generate()` inline,
no queue/worker — start here), lazy (on read, worker fills `previews[]`), pre-warm
(`prewarm()` queues the catalog at upload). The read path decides per size + format +
filters whether a preview is ready or missing. The main entry imports no framework code and no
mongoose. Shipped drivers live under `drivers/*` and need no framework; the framework
integration is the `@adaptivestone/framework-module-resize/framework.js` adapter, which only wraps
those drivers with framework models and config.

**Queues.** Named (`'default'` unless set). A framework host defines each name once, in `queues` of
`src/config/resize.ts`. Queued work has one gate per Resizer, media, pipeline and queue: at most one
of their tasks is active (queued, running, waiting for a retry, or cooling down for
`coordination.cooldownMs` after a dead-letter), whatever variants it covers. While it is, a read that
finds variants missing queues nothing; the next read after the task ends queues them. A request on
another queue is a separate task (a `prewarm({ queue: 'bulk' })` never blocks reads on `'default'`).
See [Coordination](./README.md#coordination).

**Previews.** Stored previews are separate per Resizer and per pipeline, so different renderings of
the same media keep separate previews (rename a pipeline, e.g. `watermark-v2`, to regenerate its
images). The original is never served: `resolve()` returns stored previews only. To hand the private
original to its owner, call `storage.signedUrl(original.storageRef, ttlSeconds)` yourself. A size key
does not promise a size: a raster that fits inside a `WxH` box keeps its own size, a width-only or
height-only size larger than the source enlarges it, and so does a box the source exceeds on one side
only; a pipeline with `variantSteps` always gets the full box. Read `width` and `height` from
`formatPictureUrls`.

## Integrate (in order)

1. Install. Every peer is OPTIONAL: a framework app already has `@adaptivestone/framework` and
   `mongoose`; the AWS SDKs are needed only for the drivers that use them. A missing one fails at
   your own import line when you import a driver subpath, or, for a driver selected in the config
   file, at first use or `verify()` with `RESIZE_PEER_MISSING`:

   ```bash
   npm i @adaptivestone/framework-module-resize
   # SQS task queue only: npm i @aws-sdk/client-sqs   (>= 3.572)
   # S3 storage only:     npm i @aws-sdk/client-s3   (>= 3.572, not 3.729 to 3.734; add @aws-sdk/s3-request-presigner only if you call signedUrl)
   ```

2. Scaffold the integration files (never overwrites existing files; `--force` to regenerate). Always
   this spelling: `--no` refuses to fetch a package of that name from the registry, and `--` hands
   the options to this command, not to npm.

   ```bash
   npx --no -- resize-scaffold --eager   # start here (no queue/worker)
   # npx --no -- resize-scaffold         # lazy: also emits ResizeTask + ResizeWorker
   # npx --no -- resize-scaffold --eject # full editable ResizeTask model
   ```

   `--eager` emits `src/resizer.ts` + `src/config/resize.ts` (local storage, no queue). The default
   (lazy) also emits `src/models/ResizeTask.ts` and `src/commands/ResizeWorker.ts`. It appends a
   pointer to this guide to the host's `AGENTS.md` (`--agents claude|print|skip` to redirect or
   suppress it) and, before it writes the config, `/var/` to the host's `.gitignore`, because the
   local storage keeps private originals under `./var`. Gate drift in CI with
   `npx --no -- resize-scaffold --check` (`--check --eager` for an eager host).

3. `src/resizer.ts` holds behaviour only — ONE construction call. It builds every part from the
   config file on first use:

   ```ts
   import { FrameworkResizer } from '@adaptivestone/framework-module-resize/framework.js';

   export const resizer = new FrameworkResizer({ pipelines: { default: {} } });
   ```

   Nothing is read from the framework until first use, so this file can be imported statically
   anywhere, even before `Server.init()`. Options win over the config: `storage`, `media`, `locks`,
   `tasks` (`false` = eager only), `coordination`, `logger`, `events`, `config`, `configName`,
   `queueName`, `name`, `decoders`, `engine`, `drivers`, `metrics`; see
   [Drivers](./README.md#drivers). `decoders` and `engine` are passed in code in every process that
   renders or calls `verify()`. With `queues` on several backends, `resizer.tasks` is a
   `RoutingTaskQueue`: ask `carrierOf(resizer.tasks, name)` for a name's backend, and do not test
   `instanceof MongoTaskQueue`. A custom driver extends the exported abstract class (`ResizeStorage`,
   `MediaStore`, `LockStore`, `TaskQueue`) or is any object of the same shape, with no `app`
   parameter; a custom decoder extends `SourceDecoder`. Each contract is in the README.

   Without the framework: one config object and one call, `createResizer(config, { drivers })`
   from the main entry (or wire the parts by hand, see
   [Without the framework](./README.md#without-the-framework)):

   ```ts
   import mongoose from 'mongoose';
   import { createResizer } from '@adaptivestone/framework-module-resize';
   // File is your media model; its schema spreads resizeMediaSchemaFragment (…/drivers/mongo.js).

   export const resizer = createResizer({
     formats: ['webp', 'avif'], // image settings, merged over the package defaults
     storage: { driver: 'local', rootDir: './var/media', publicBaseUrl: '/media' },
     database: { driver: 'mongo', connection: mongoose.connection, mediaModel: File },
     queues: { default: { driver: 'database' } }, // or { driver: 'sqs', queueUrl }
   });
   ```

4. Import `src/resizer.ts` wherever you need the Resizer. Call `await getResizer().verify()` after
   `Server.init()` (or `startServer()`), so a bad config fails at boot. Without it, a config error
   appears at the first call: `resolve()`, which never throws, logs it once as an `error`, and every
   read then serves nothing, previews stored earlier included. A task queue passed in code that
   cannot be used does not fail calls: it is logged once, reads serve stored previews and queue
   nothing, uploads and `generate()` work, and only `verify()`, `prewarm()` and worker start report
   it.

5. The scaffolded `src/config/resize.ts` spreads `defaultFrameworkResizeConfig` (the image settings)
   from `@adaptivestone/framework-module-resize/framework.js` and `satisfies FrameworkResizeConfig`.
   Set `mediaModelName: 'File'` (your host media model's name). It holds the Resizer's own sections:
   - `storage`: `{ driver: 'local', rootDir, publicBaseUrl, privateRootDir? }` or
     `{ driver: 's3', bucketPublic, bucketPrivate?, publicBaseUrl?, region?, endpoint?,
     forcePathStyle? }` (credentials from the AWS chain). Local: the framework serves no static
     files, see the guide's "Serve local files". Serve exactly `rootDir`, never a parent:
     `privateRootDir` sits beside it by default, and the module cannot detect that. The scaffold takes
     `publicBaseUrl` from `RESIZE_PUBLIC_BASE_URL`: set it in every deployed environment;
   - `queue`: the name of a `queues` entry, or `false` = eager only.

   and the PROCESS-WIDE sections, read only from `src/config/resize.ts`:
   - `queues`: every queue, by name: `{ driver: 'database', …timing }` or
     `{ driver: 'sqs', queueUrl, deadLetterQueueUrl?, waitTimeSeconds?, region?, endpoint?, …timing }`,
     where timing is any of `leaseMs`, `retryBackoffMs`, `maxAttempts`, `idlePollMs`, `taskTimeoutMs`;
   - `coordination`: `{ gateTtlMs, cooldownMs }` (each `600000` by default);
   - `worker`: the worker process's `enabled` switch and Sharp tuning (`worker: { enabled: true }` is
     enough).

   Variant parallelism is the top-level `concurrency`. A second Resizer reads its own file:
   `new FrameworkResizer({ name: 'listings', configName: 'resizeListings' })`, which holds only that
   Resizer's own sections. Put environment-only changes in `resize.<NODE_ENV>.ts`, which writes
   `satisfies Partial<FrameworkResizeConfig>` (or `PartialFrameworkResizeConfig`, for nested keys left
   out). The framework merges it field by field, and the module merges the image settings over the
   package defaults (arrays and `encode.formats` replace): do not add a merge of your own. Every key
   is in the [Config reference](./README.md#config-reference).

6. Ensure the media model carries `original` and `previews[]`. Spread the exported fragment instead
   of hand-writing those fields. It is exported by `…/framework.js` and `…/drivers/mongo.js`, not by
   the main entry:

   ```ts
   import { resizeMediaSchemaFragment } from '@adaptivestone/framework-module-resize/framework.js';
   // in the model:
   // static get modelSchema() { return { ...ownFields, ...resizeMediaSchemaFragment } as const; }
   ```

   Keep `minimize: false` on the media schema (already the Framework `BaseModel` default; direct
   Mongoose users pass `{ minimize: false }` to `new Schema`), or empty objects in `storageRef` values
   can disappear on save. A hand-written schema has its fields listed under
   `RESIZE_MONGO_MEDIA_MODEL_OUTDATED` in [Error codes](./README.md#error-codes). With strict types,
   pass a loaded document as `media: doc as MediaLike` (`import type { MediaLike }`), or type the
   model's `original`/`previews` paths with `Original`/`Preview` (framework hosts: `TsTypeOverride`).

7. Prepare queue infrastructure outside the resizer runtime. The `ResizeTask` model declares its
   indexes (the framework's `Lock` model too, used only beside a task queue without `gatesByTask`,
   such as SQS). The host's normal lifecycle or a migration must create them before `resolve`,
   `prewarm` or the worker can run: the module does not create, synchronize or repair indexes.
   `verify()` and worker start reject with `RESIZE_MONGO_INDEX_MISSING` until the gate index exists.
   The worker runs on the framework CLI, which turns `autoIndex` off, so it builds none and waits for
   none: create them through a migration that runs before the API and the workers, or, on a new
   database only, let the API build them first. Never add index creation to HTTP bootstrap or the
   first enqueue. Upgrading: the order is in [`UPGRADING.md`](./UPGRADING.md).

8. Lazy / pre-warm modes: keep `queues: { default: { driver: 'database' } }` (or an SQS entry)
   and `queue: 'default'`, and set `worker: { enabled: true }` in `src/config/resize.ts`, then run
   the worker as its own process — `npm run cli ResizeWorker`
   (`npm run cli ResizeWorker -- --queue=bulk` consumes only `'bulk'`, and
   `npm run cli ResizeWorker -- --queue=default --queue=bulk` consumes both). The flag permits the
   command to run; it does not start a worker in the API. Eager mode needs no worker.

   Push delivery (preview): an SQS-triggered Lambda can run tasks instead of a worker process, with
   `createSqsHandler()` from `…/lambda.js`. It has not run on real AWS. Standard queues only; do not
   bundle it, and install Sharp for the function's architecture, or the import fails. Read the README
   [`Push delivery (preview)`](./README.md#push-delivery-preview) section first:
   `ReportBatchItemFailures` (without it failed tasks are lost silently), batch size 1, a function
   timeout well above the task's time, `maxReceiveCount` = `maxAttempts` + 2, the visibility timeout,
   `deadLetterQueueUrl`, the IAM permissions the managed role lacks, `MaximumConcurrency` rather than
   low reserved concurrency. Its troubleshooting table is there too.

## Use

Store an original (no model creation and no queue work; persist the returned value in the host):

```ts
const original = await getResizer().uploadOriginal({
  body: buffer,
  visibility: 'private',
  // Optional key prefix: namespace: 'avatars',
});
```

Input bytes are stored unchanged. Persist every original privately, then call `prewarm()` or
`generate()` the same way for raster and SVG: SVG is an input format only, rendered in a child
process, and a public SVG upload is rejected. Persist `original.storageRef` and
`previews[].storageRef` through the host media schema. Previews inherit a `namespace`, so it appears
in their public URLs: put nothing in it you would not publish, such as a user id.

Put an object you already hold on the module, without uploading it again:

```ts
import { getResizer, hasOriginal } from '@adaptivestone/framework-module-resize';

if (!hasOriginal(doc)) {
  doc.original = await getResizer().adoptOriginal({ storageRef });
  await doc.save();
}
```

`hasOriginal(doc)` is the test, never `if (doc.original)`: a hydrated document reads a never-set
`original` as `{}`. `adoptOriginal` measures the object and returns the `Original` to save; it writes
and queues nothing. Build the ref from your own records. Save it once and never change it: a changed
ref regenerates that media's previews. Its limits and refusals are in
[`adoptOriginal()`](./README.md#adoptoriginal); the guide's how-to is
https://framework.adaptivestone.com/docs/resize#adopting

Read path (DTO builders / controllers). `resolve` NEVER throws and never runs sharp — missing
variants are enqueued and the decision is returned immediately. A stale stored preview is still
served, with `stale: true` on its `ReadyEntry`, and its replacement is requested with the missing
variants; after the `beforeEnqueue` hook the replacements are in `decision.stale`, the rest in
`decision.missing`. Being listed there does not confirm a task was queued (the gate, a cooldown or a
queue error can leave it unqueued). See [Freshness](./README.md#freshness):

```ts
import { formatPictureUrls, getResizer } from '@adaptivestone/framework-module-resize';

const { decision, output } = await getResizer().resolve({
  media: fileDoc,
  pipeline: 'default',
  sizes: [{ width: 620 }, { fit: true }, { width: 300, height: 300 }],
});
// `output` is your formatPublicUrls hook (undefined if no hook / hook throws).
// formatPictureUrls skips filtered variants — map `decision` for those.
const picture = output ?? formatPictureUrls(decision, { id: String(fileDoc.id) });
```

Upload handler, pre-warm mode (non-blocking; the worker fills the cache before the first read).
`prewarm` reports every requested variant and never throws. A variant is accepted only when a task
holds it; one the active task does not cover stays `unconfirmed` with a retryable issue, so call
`prewarm()` again after that task ends. Delivery is at-least-once. Each code is in
[`prewarm()` issues](./README.md#prewarm-issues):

```ts
const result = await getResizer().prewarm({ media: fileDoc, sizes: catalog });
// result.status: ready | accepted | not-required | incomplete
// result.unconfirmed: variants without a confirmed task; result.issues: why, and issue.retryable
```

Upload handler, eager mode (blocking; a Resizer with a task queue is also supported):

```ts
const { created, failed } = await getResizer().generate({
  media: fileDoc,
  sizes: catalog,
});
```

No original throws `ResizeNoOriginalError`; every requested variant failing throws
`ResizeGenerateError`. A source the engine refuses rejects before any variant runs, as
`ResizeMediaError` `RESIZE_SOURCE_DAMAGED`, so a handler catching only `ResizeGenerateError` returns
500 on a user's upload: catch `ResizeError`, or refuse the file at upload with
`upload.verify: 'decode'`. `created` is only this call; `failed > 0` means a partial success. Reload
the media before saving it after `generate()` or `invalidate()`: the module wrote the rows itself.

Errors: EVERY throw from this module extends `ResizeError`, so one check separates a module
rejection from a sharp/S3/mongo failure. Subclasses say what to do — `ResizeSetupError` (wiring
is wrong), `ResizeConfigError` (crash at boot), `ResizeMediaError` (skip this record in the
request path; `ResizeNoOriginalError` and `ResizeOriginalError` extend it), `ResizeGenerateError`
(eager produced nothing or queued coverage is incomplete),
`ResizeStorageError` (transient; retry may help), `ResizeSecurityError` (refusal; never retry).
Every instance carries a stable `err.code` and `err.retryable`, and `false` means no later delivery
of the same input can succeed: a worker dead-letters the task at once. A retryable error gave no
verdict on the file, and its message can be raw engine text, so answer it in your own words. Use
`ResizeError.isResizeError(err)` when the error may cross a package boundary.

```ts
import { ResizeError, ResizeNoOriginalError } from '@adaptivestone/framework-module-resize';

try {
  await getResizer().generate({ media: fileDoc, sizes: catalog });
} catch (err) {
  if (err instanceof ResizeNoOriginalError) return badRequest('upload the image first');
  if (ResizeError.isResizeError(err)) return err.retryable ? tryAgainLater() : badRequest(err.message);
  throw err; // not ours
}
```

Listing queries:

```ts
import { resizeMediaPaths } from '@adaptivestone/framework-module-resize/framework.js';
File.find().select(['mediaType', ...resizeMediaPaths]);
```

Remove a media's stored previews. `invalidate` never deletes files and never queues: delete the
returned refs yourself. New bytes under the same `original.storageRef` and at the same size are not
detected as stale, so call it after such a replacement:

```ts
const refs = await getResizer().invalidate({ media: fileDoc, pipeline: 'default' }); // omit pipeline: every pipeline
// delete each ref's object with your own storage client; the next read or prewarm() queues new ones
```

Hooks are typed — register at construction (`hooks:`) or later via `getResizer().hook(name, fn)`.
Waterfalls (read path, real `ctx`): `resolveSizes`, `beforeEnqueue`, `formatPublicUrls`.
Observers (worker side, and for the first two `generate()` too): `onPreviewGenerated`,
`onPreviewReplaced`, `afterTaskComplete`, `onTaskFailed`, `onTaskDeadLettered`. Do not wait in an
observer, and delete old files from `onPreviewReplaced` or a sweep only as
[Freshness](./README.md#freshness) says.

Pipelines: `beforeSteps` run once on the decoded first frame, and `variantSteps` once per variant
on that size's pixels, after the resize and before the encode; both take a `Raster` and return a
`Raster`. A variantStep reads the preview's size from `raster.info` and owns its copy of the pixels.
An optional pipeline `version` (string) is part of each preview row's `encodeSig`: bump it when a
step's output changes, and the pipeline's stored previews are regenerated on their next read.

```ts
import { rasterToSharp, sharpToRaster } from '@adaptivestone/framework-module-resize';
// beforeSteps: [async (r) => sharpToRaster(rasterToSharp(r).blur(5))]
```

Metrics: by default a `LogMetrics` writes one summary `info` line per window and one line per task
outcome. `new FrameworkResizer({ metrics: new NoopMetrics() })` turns that off; task failures are
still logged. See [Metrics](./README.md#metrics).

## Rules (violations cause real incidents)

- `sizes` is an ALLOWLIST. Never pass client-supplied dimensions through — resolve them against
  a fixed per-entity catalog first (otherwise: arbitrary-resize resource abuse).
- Construct each Resizer ONCE, at one construction site, with `new FrameworkResizer`. Most
  hosts need one (`getResizer()`); for more, give each a `name` (`getResizer('listings')`). The same
  name twice throws. A worker serves every Resizer constructed in its process before it starts.
- `ctx` does NOT cross the queue: worker-side steps and observers see `ctx === {}`. Only eager
  `generate()` passes the caller's `ctx` to steps. Persist per-media data on the media doc; a step
  reads it from `meta.media`, read only.
- Watermarks belong in `variantSteps`, never in `beforeSteps` (baked once onto the original, a
  watermark scales away to unreadable on small variants). Fit the logo on both sides: Sharp refuses
  an overlay larger than the preview on either side, so one scaled by `r.info.width` alone fails on a
  banner. `withoutEnlargement` keeps a smaller logo at its own size:

  ```ts
  async (r) => {
    const { width, height } = r.info;
    const input = await sharp(logo)
      .resize(Math.ceil(width / 4), Math.ceil(height / 4), { fit: 'inside', withoutEnlargement: true })
      .toBuffer();
    return sharpToRaster(rasterToSharp(r).composite([{ input, gravity: 'southeast' }]));
  };
  ```

- A step receives and returns a one-frame `Raster`, never a Sharp object or a `Buffer`; wrap Sharp
  work with `rasterToSharp` / `sharpToRaster`. Three things go wrong with no error: `greyscale()` on a
  transparent source loses alpha, and a JPEG then shows black there (use
  `modulate({ saturation: 0 })`), `toColourspace('b-w')` stays in colour, and metadata calls in a step
  do nothing. Sharp work outside `rasterToSharp` has no time limit: see **Pipelines** in the
  [Config reference](./README.md#config-reference).
- A pipeline with steps renders the first frame of an animation only. For an SVG source a
  `beforeStep` can get pixels larger than the source, so multiply coordinates stored in the source's
  units by `meta.scale`.
- Register every pipeline in `src/resizer.ts`, so the API and the worker both have it
  (`resizer.hasPipeline(name)` checks). When you add or rename a pipeline, deploy the worker before
  the API requests it, and the indexes before both.
- The API and the workers must run the same image settings and pipeline versions: two worker versions
  with different settings re-make each other's rows. Deploy every worker at once, or change the
  settings only after the old workers have stopped.
- `formats` controls generated outputs, `upload.formats` accepted originals, and `encode.formats[id]`
  is passed to the engine. A requested format without an `encode.formats` key is never generated.
  `original.format` should be the decoder's id (`jpeg`, not `jpg` or a MIME type), as
  `uploadOriginal()` returns it.
- Never resize/encode with sharp on the request path: a read (`resolve()`, a DTO builder, a list
  route) never runs it. Eager `generate()` on an upload route is the documented exception.
- The scaffolded model/command shims re-use the package: do not vendor or fork them. The command
  must keep its `import '../resizer.ts'`.
- SVG originals stay private, and no original is ever served, so uploaded SVG markup never reaches a
  reader. The module does not sanitize SVG markup.
- Deleting storage objects is the HOST's job: the module only appends rows, `invalidate` only removes
  rows and returns their refs, and `onPreviewReplaced` reports each row a write replaced.
- A `storageRef` you write or pass to `adoptOriginal` comes from the host's own records, never from
  a client's input: within the two configured buckets it would publish previews of someone else's
  object.

## Troubleshooting

The first things a new integration meets. Every other code is in
[`## Error codes`](./README.md#error-codes), other symptoms in
[Symptoms without a code](./README.md#symptoms-without-a-code), and what an upgrade changes in
[`UPGRADING.md`](./UPGRADING.md).

| Symptom | Cause → fix |
|---|---|
| ``resize config: `mediaModelName` is required``, `RESIZE_CONFIG_MEDIA_MODEL_MISSING` | set it in the host `src/config/resize.ts` (or the `configName` file named in the message) |
| `RESIZE_APP_NOT_INITIALIZED` | a `FrameworkResizer` read the framework app before the `Server` was constructed — construct the Server before the first call (importing `src/resizer.ts` earlier is fine); in tests, install a fake app with `setAppInstance` from `@adaptivestone/framework/helpers/appInstance.js` |
| `RESIZE_CONFIG_QUEUE_UNKNOWN` on first use or from `verify()` | the Resizer's queue name is not an entry of `queues` in `src/config/resize.ts` — add `queues.<name>`, set `queue`/`queueName` to a defined name, or `queue: false` for eager only |
| `RESIZE_CONFIG_STORAGE_MISSING` | add `storage: { driver: 'local', … }` (or `'s3'`) to the config named in the message, or pass `storage` to `new FrameworkResizer()` |
| `RESIZE_CONFIG_INVALID` | the config is malformed, and the message names the part — fix it. `engine` and `decoders` keys in a config are refused: each is an option, in code |
| `RESIZE_NOT_READY` | host code read `resizer.storage` / `media` / `locks` / `tasks` or a config-file `resizer.queueName` before the Resizer loaded them — `await resizer.ready()` first (the Resizer's methods do this themselves) |
| `RESIZE_MONGO_INDEX_MISSING` from `verify()` or at worker start | the `ResizeTask` collection has no gate index, unique on `{ resizer: 1, fileId: 1, pipeline: 1, queue: 1 }` with `partialFilterExpression: { active: true }` — create it through your migration (e.g. `ResizeTask.createIndexes()`), before the worker starts |
| `RESIZE_MONGO_MODEL_MISSING` from `verify()` or at worker start | a model does not resolve: the `ResizeTask` model (scaffold `src/models/ResizeTask.ts`), or the framework's `Lock`, needed only beside a task queue without `gatesByTask` |
| `RESIZE_MONGO_NOT_CONNECTED` from `verify()` or at worker start | call `verify()` after the connection has opened (after `Server.init()` in a framework host) |
| `RESIZE_PIPELINE_UNKNOWN` | the pipeline is not registered in that process — register it in `src/resizer.ts`; deploy the worker before the API requests a new or renamed pipeline |
| `RESIZE_PIPELINE_STEP_INVALID` | a step resolved with something that is not a one-frame `Raster` — return `{ data, info }`, or `sharpToRaster(…)` from a Sharp chain |
| `formats [...] have no encode.formats entry`, `RESIZE_FORMAT_NOT_CONFIGURED` | use an id the defaults hold, such as `jpeg`, or add `encode.formats.<id>`, or request only configured ids |
| `ERR_MODULE_NOT_FOUND: @aws-sdk/...` at your driver import, or `RESIZE_PEER_MISSING` | optional peer not installed — install the packages named, see step 1 |
| `a Resizer named '…' already exists`, `RESIZE_DUPLICATE_RESIZER` | each name is constructed once per process — import the single construction site; elsewhere `getResizer(name)` |
| `RESIZE_NO_RESIZER` at worker start | `src/commands/ResizeWorker.ts` does not import `../resizer.ts` — delete it and re-run `npx --no -- resize-scaffold` |
| `RESIZE_SOURCE_DAMAGED` | the source is cut or unreadable: dead-lettered on its first delivery, since no retry can help — replace the original |
| the warning `resize resolve: media … was loaded without its stored …` (once per Resizer) | the query's projection dropped `original` or `previews` — add `...resizeMediaPaths` to the query |
| `resize worker: task … is dead (…)` at `error` | the line holds the code, the reason and the cause — fix the cause first; the next read after `coordination.cooldownMs` queues the media again |
| a variant stays missing for ~10 min after its task was dead-lettered | `coordination.cooldownMs` (default 600000): the dead task holds the gate until the cooldown ends — fix the cause in the logs first |
| tasks stay `pending` on one queue | no worker consumes that queue — start `npm run cli ResizeWorker -- --queue=<name>` |
| previews never appear | the worker process isn't running, or `worker.enabled` is `false` in that process (it logs a `warn`, and the command resolves `false`) |
| `resolve` `output` is `undefined` | no `formatPublicUrls` hook (or it threw) — map `decision` or use `formatPictureUrls` |
