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

Queues are named (`'default'` unless set). A framework host defines each name once, in `queues`
of `src/config/resize.ts`, with its own timing. There is one TaskQueue per backend (every
`database` entry is one backend; SQS entries with the same `region`, `endpoint`,
`deadLetterQueueUrl` and `waitTimeSeconds` are one: set `region` (and `endpoint`) on every SQS entry
or on none — an omitted `region` and an explicit one equal to `AWS_REGION` count as two backends),
and each name is a lane on it. A Resizer's tasks go to its `queueName` (in a framework host, its
config file's `queue`); a call may name another queue of the same backend.

Queued work has one gate per Resizer, media, pipeline and queue: at most one of their tasks is
active (queued, running, waiting for a retry, or cooling down for `coordination.cooldownMs` after
a dead-letter), whatever variants it covers. While it is, a read that finds variants missing
queues nothing; the next read after the task ends queues them. A request on another queue is a
separate task (a `prewarm({ queue: 'bulk' })` never blocks reads on `'default'`). On the database
queue the `ResizeTask` row is the gate (`active`, with a unique index on
`{ resizer: 1, fileId: 1, pipeline: 1, queue: 1 }` partial on `active: true`, which `verify()`
requires); on a task queue without `gatesByTask` (SQS) it is one lock in the Resizer's
`LockStore`, `resize_gate:<resizer>:<queue>:<mediaId>:<pipeline>` (parts URI-encoded), whose owner
travels with the task as `gateOwner`. No per-identity lock exists: the
lease, its token fencing every write, and the media store keeping one row per preview identity
prevent duplicate work. Preview identity is `resizer:pipeline:sizeKey:format:filterSig`: stored
previews are separate per Resizer and per pipeline, so different renderings of the same media keep
separate previews (rename a pipeline, e.g. `watermark-v2`, to regenerate its images). Preview rows
without `resizer`/`pipeline` belong to `default`. Task rows written before the gate have no
`active` field and never block a new task. The original is never served: `resolve()` returns
stored previews only. For a pipeline without `variantSteps`, a raster original no larger than a
requested `WxH` box gets a preview at its own size (no upscaling, no cropping, metadata removed;
only the `limits.resultDimension` cap can scale it down); a pipeline with `variantSteps` always
gets the full box its steps were written for. To hand the private original to its owner, call
`storage.signedUrl(original.storageRef, ttlSeconds)` yourself; the module never calls it.

## Integrate (in order)

1. Install. Every peer is OPTIONAL: a framework app already has `@adaptivestone/framework` and
   `mongoose`; the AWS SDKs are needed only for the drivers that use them. A missing one fails at
   your own import line when you import a driver subpath, or, for a driver selected in the config
   file, at first use or `verify()` with `RESIZE_PEER_MISSING` (naming the packages and the file):

   ```bash
   npm i @adaptivestone/framework-module-resize
   # SQS task queue only: npm i @aws-sdk/client-sqs   (>= 3.572)
   # S3 storage only:     npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner   (>= 3.572)
   ```

2. Scaffold the integration files (never overwrites existing files; `--force` to regenerate):

   ```bash
   npx resize-scaffold --eager   # start here (no queue/worker)
   # npx resize-scaffold         # lazy: also emits ResizeTask + ResizeWorker
   # npx resize-scaffold --eject # full editable ResizeTask model
   ```

   `--eager` emits `src/resizer.ts` + `src/config/resize.ts` (local storage, no queue).
   Default (lazy) also emits `src/models/ResizeTask.ts` (extends the default export of
   `@adaptivestone/framework-module-resize/framework/ResizeTaskModel.js`, so `npm run gen` types
   `getModel('ResizeTask')`) and `src/commands/ResizeWorker.ts` (`import '../resizer.ts'` plus a
   re-export of the module's command).
   Appends a pointer to this guide into the host's `AGENTS.md`
   (`--agents claude|print|skip` to redirect or suppress it).

3. `src/resizer.ts` holds behaviour only — ONE construction call, `new FrameworkResizer({
   pipelines, hooks })`. It builds every part from the config file on first use: the image
   settings, `storage`, the task queue (the file's `queue` names an entry of `queues`; the database
   queue is the scaffolded `ResizeTask` model), `media` (`FrameworkMediaStore`: the app's media
   model), `locks` (`FrameworkLockStore`:
   the framework `Lock` model, built only beside a task queue without `gatesByTask` — the SQS
   driver, or a custom queue without the flag; the database queue keeps its gate in its task rows,
   so it needs no `Lock` model) and the app logger:

   ```ts
   import { FrameworkResizer } from '@adaptivestone/framework-module-resize/framework.js';

   export const resizer = new FrameworkResizer({ pipelines: { default: {} } });
   ```

   Nothing is read from the framework until first use, so this file can be imported statically
   anywhere, even before `Server.init()`. Options win over the config: `storage` (e.g. an
   `S3Storage` with the host's own `client`), `media`, `locks`, `tasks` (a `TaskQueue`, or
   `false` = eager only), `coordination`, `logger`, `events`, `config`, `configName`, `queueName`
   (the queue name, a key of `queues`), `name`. `resizer.queue` is gone: read `resizer.queueName`.
   A `queueName` option is readable at once; a name from the config file only after
   `await resizer.ready()` or the first call (`RESIZE_NOT_READY` before). A `tasks` queue in code
   skips only the choice of the queue from `queues` (the name is `queueName`, else the file's
   `queue`, else `'default'`); a `src/config/resize.ts` that exists is still validated as a whole,
   so a broken `queues` there fails `verify()` unless `coordination` is passed in code too (its
   calls then run in the degraded mode of step 4).

   Without the framework: `new Resizer({ storage, media, locks?, tasks?, coordination?, queueName? })` from
   the main entry (`locks` is required only beside a task queue without `gatesByTask`, such as
   `SqsTaskQueue`, which takes one gate lock per media, pipeline and queue: `verify()` rejects
   without it; `MongoTaskQueue` needs none), with
   `@adaptivestone/framework-module-resize/drivers/mongo.js` → `...mongoParts(connection, {
   mediaModel, timing? })` (`{ media, locks, tasks }`: the host media model, and locks and the task
   queue on the package's `ResizeLock` / `ResizeTask` models; also `MongoMediaStore`,
   `MongoLockStore`, `MongoTaskQueue`, `createResizeModels`; call it once and spread the same parts
   into every Resizer — each call makes its own queue),
   `…/drivers/fs.js` → `LocalFsStorage`, `…/drivers/s3.js` → `S3Storage`, `…/drivers/sqs.js` →
   `SqsTaskQueue`. Any part may be a function (sync or async) called once on first use. A custom
   driver extends the exported abstract class (`ResizeStorage`, `MediaStore`, `LockStore`,
   `TaskQueue`) or is any object of the same shape — no `app` parameter; a driver closes over its
   own client. `MediaStore.appendPreviews` resolves with the previews it stored, and the REQUIRED
   `MediaStore.replacePreviews` swaps rows by identity in one write (see Use); `LockStore` locks
   carry an owner (`release(key, owner)` is a compare-and-delete). The core owns the queue logic
   (worker loop, retries, dead-letters, the gate lock, events); a `TaskQueue` only implements
   atomic `add` / `claim` / `renew` / `complete` / `fail`. `add` resolves with a `TaskAddResult`
   (`added`, `in-flight` or `unconfirmed`); the optional flags `gatesByTask` (the queue keeps at
   most one active task per Resizer, media, pipeline and queue itself, with the lifecycle that
   the `TaskQueue.gatesByTask` JSDoc states (`dist/contracts/taskQueue.d.ts`, re-exported by
   `dist/index.d.ts`), including taking a dead task over after its cooldown) and `claimFilters` (`claim` takes only tasks of the Resizers in its
   `{ resizers }` option) change what the core does around it. A queue without `gatesByTask` must
   store `gateOwner` and hand it back on the claimed task. Optional `release`
   gives a task back at worker shutdown, and, on a queue without `claimFilters`, a task for a
   Resizer the worker does not serve; see the README contract. `claim` may wait for a task (long
   poll), but must return once its `signal` aborts and never claim ahead of the call.

4. Import `src/resizer.ts` wherever you need the Resizer (a static import is fine). To fail at boot
   on a bad config, call `await getResizer().verify()` after `Server.init()`; otherwise a config
   error appears at the first call. A task queue passed in code that cannot be used (no lock store
   beside a queue without `gatesByTask`, invalid `timing`), or an invalid `coordination`, does not
   fail calls: it is logged once, reads serve stored previews and queue nothing, uploads and
   `generate()` work, and only `verify()`, `prewarm()` and worker start report it. For a
   `FrameworkResizer` that takes its task queue from the config file, invalid timing in a `queues`
   entry of `src/config/resize.ts` (or a malformed `queues` or `worker` section) is still a config
   error at the first call, like the rest of the file; its `coordination` section degrades as
   above. With a task queue passed in code (and no `coordination` in code), the file is read only
   for `coordination`, so any broken section of it degrades as above. The
   worker process imports it from the
   scaffolded `src/commands/ResizeWorker.ts` (`import '../resizer.ts'` plus a re-export of the
   module's command); keep that import if you edit the command.

5. The scaffolded `src/config/resize.ts` spreads `defaultFrameworkResizeConfig` (the image
   settings only) from `@adaptivestone/framework-module-resize/framework.js` and `satisfies
   FrameworkResizeConfig`. Set `mediaModelName: 'File'` (your host media model's name). The
   image settings go to the Resizer; `FrameworkResizer` reads the Resizer's own sections from its
   file:
   - `storage`: `{ driver: 'local', rootDir, publicBaseUrl, privateRootDir? }` or
     `{ driver: 's3', bucketPublic, bucketPrivate?, publicBaseUrl?, region?, endpoint?,
     forcePathStyle? }` (S3 is imported only when selected; credentials from the AWS chain);
   - `queue`: the name of a `queues` entry (the scaffold writes `queue: 'default'`), or `false` =
     eager only. Missing: `'default'` when `queues` has entries, else eager only. A name that
     `queues` does not define (the implied `'default'` too) is `RESIZE_CONFIG_QUEUE_UNKNOWN`.

   and the PROCESS-WIDE sections, read only from `src/config/resize.ts` (in any other file, or in
   the `config` option, they are `RESIZE_CONFIG_INVALID`):
   - `queues`: every queue, by name, each defined once: `{ driver: 'database', …timing }` or
     `{ driver: 'sqs', queueUrl, deadLetterQueueUrl?, waitTimeSeconds?, region?, endpoint?,
     …timing }` (one SQS queue per name), where timing is any of `leaseMs`, `retryBackoffMs`,
     `maxAttempts`, `idlePollMs`, `taskTimeoutMs` (the rest default), per queue;
   - `coordination`: `{ gateTtlMs, cooldownMs }` (each `600000` by default, `defaultCoordination`;
     missing values take it): how long the gate lock of a QUEUED task lasts before a worker starts
     it (the worker then extends it per lease; only a task queue without `gatesByTask` takes the
     lock; raise it when tasks wait longer), and how long a dead-lettered task blocks new tasks for
     its media, pipeline and queue. ONE per process (`new FrameworkResizer({ coordination })` sets
     one Resizer's); only the core validates it (`coordination: null` is invalid, not the
     defaults). `lockTtlMs` is a removed key (`RESIZE_CONFIG_REMOVED_KEY`): `failed` →
     `cooldownMs`, `dispatch` → `gateTtlMs`, drop `worker`;
   - `worker`: the worker process's `enabled` switch and Sharp tuning (`defaultWorkerOptions` from
     `…/framework.js`; every key optional, so `worker: { enabled: true }` is enough).

   Variant parallelism is the top-level `concurrency`. A second Resizer can read its own file:
   `new FrameworkResizer({ name: 'listings', configName: 'resizeListings' })`. That file holds only
   the Resizer's own sections (image settings, `mediaModelName`, `storage`, and `queue`, e.g.
   `queue: 'bulk'` naming an entry of `queues` in `resize.ts`), and also `satisfies
   FrameworkResizeConfig`. An environment override (`<name>.<NODE_ENV>.ts`, e.g.
   `resize.production.ts` or `resizeListings.production.ts`), and a `resize.ts` that holds only the
   process-wide sections (no default Resizer, so no `mediaModelName`), write `satisfies
   Partial<FrameworkResizeConfig>`. The worker reads `worker` and `queues` from
   `src/config/resize.ts`: its `--config` flag is removed (`RESIZE_CONFIG_REMOVED_KEY`). One Resizer
   uses one backend: moving only some queues to another backend in `resize.<NODE_ENV>.ts` (only
   `queues.default` to SQS, say) splits them there, and calls on the other backend's queues queue
   nothing (`RESIZE_QUEUE_NOT_SERVED`). Move all of a Resizer's queues together until routing
   between backends ships; SQS entries with different dead-letter queues are different backends too,
   so set `region` (and `endpoint`) on every SQS entry or on none — an omitted `region` and an
   explicit one equal to `AWS_REGION` count as two backends. Put environment-only changes in
   `resize.<NODE_ENV>.ts` (for example, S3 in `resize.production.ts`); the framework merges that
   file field by field before this module reads and validates the resolved config. Do not add a
   second runtime merge. When an environment file switches the storage driver, set `publicBaseUrl`
   there too.

6. Ensure the media model carries `original` and `previews[]`. Spread the exported fragment
   instead of hand-writing those fields (single source of truth for schema + types). It is
   exported by `…/framework.js` and `…/drivers/mongo.js`, not by the main entry:

   ```ts
   import { resizeMediaSchemaFragment } from '@adaptivestone/framework-module-resize/framework.js';
   // in the model:
   // static get modelSchema() { return { ...ownFields, ...resizeMediaSchemaFragment } as const; }
   ```

   Keep `minimize: false` on the media schema (already the Framework `BaseModel`
   default). Direct Mongoose users must pass `{ minimize: false }` to `new Schema`.
   Otherwise empty objects in opaque `storageRef` values can disappear on save/update. Preview
   rows carry `bytes`, `createdAt`, `origin` and `encodeSig` beside the fields `resolve()` reads
   (the fragment declares them). A hand-written schema that declares preview rows as strict
   sub-documents must also give them `identity`, `origin` and `encodeSig` (each
   `{ type: String }`), or `verify()` throws `RESIZE_MONGO_MEDIA_MODEL_OUTDATED`: the media store
   keeps one row per preview identity, and the two signatures record what each row was made from.

7. Prepare queue infrastructure outside the resizer runtime. The package's `ResizeTask` model
   declares its indexes (and so does the framework's `Lock` model, used only beside a task queue
   without `gatesByTask`); the host's normal lifecycle or an explicit migration must create them
   before `resolve`, `prewarm`, or the worker can run. The module does not create, synchronize,
   drop, or repair indexes, and it has no `prepareQueue()` API. `verify()` (and worker start)
   reads them and rejects with `RESIZE_MONGO_INDEX_MISSING` until the gate index exists; it never
   creates one. With Mongoose's `autoIndex` on (an API server) it first waits for the model's own
   index build, so the boot check right after `Server.init()` passes on a fresh database; it needs
   an open (or opening) connection, else `RESIZE_MONGO_NOT_CONNECTED`. The worker runs on the
   framework CLI, which turns `autoIndex` off: it builds no index and waits for no build, so a
   worker started before the gate index exists stops with `RESIZE_MONGO_INDEX_MISSING`, on a fresh
   database too. The indexes must exist BEFORE the worker starts: create them through a migration
   that runs before the API and the workers (the order that always works), or, on a new database
   only, let the API build them first (Mongoose's own `autoIndex` build at boot, no code of yours;
   its `verify()` passes once the build is done). When upgrading, create them through a
   migration, in this order:
   - create the gate index `{ resizer: 1, fileId: 1, pipeline: 1, queue: 1 }` (unique, partial on
     `active: true`) BEFORE the new API and workers start: it keeps one task per media, pipeline
     and queue. Without it every `add()` stores a task, duplicate active rows build up, and the
     unique index build then fails with E11000 until those rows are no longer active (completed,
     or dead and taken over or expired);
   - create the claim index `{ queue: 1, status: 1, availableAt: 1 }` before or together with the
     new workers, then drop the old lease index (`{ status: 1, createdAt: 1 }`, or
     `{ queue: 1, status: 1, createdAt: 1 }` from a pre-release build);
   - drop the old `{ fileId, pipeline, requestKey }` index when convenient: new rows never enter it.

   An ejected `ResizeTask` model (`--eject`) also declares `startedAt` and `finishedAt` (when the
   latest delivery started, and when the task completed or was dead-lettered). An older ejected
   model keeps working without them (the times are dropped), but `resize-scaffold --check` reports
   it as drift: add both as `{ type: Date }`, or move `src/models/ResizeTask.ts` aside (or delete
   it), re-run `npx resize-scaffold --eject`, then restore your customizations (the scaffold never
   overwrites an existing file, so re-running `--eject` alone changes nothing).

   When upgrading from a version without the gate (0.2.x or a 0.3 pre-release build), deploy the
   API and the workers together, after the pending tasks have finished or been drained. Task rows
   from before the gate have no `active` field and are not gates, so in a mixed-version (rolling)
   deploy a read can queue a second task for such a media; the next `add()` takes over a row that
   an older worker completed or dead-lettered (such a worker leaves it active and sets no
   cooldown). On SQS an older worker ignores `gateOwner`, so the gate lock of a task it ran
   expires only after `coordination.gateTtlMs`.

   Verify these indexes in the host's DB rollout. Never add index creation to HTTP bootstrap or the
   first enqueue.

8. Lazy / pre-warm modes: keep `queues: { default: { driver: 'database' } }` (or an SQS entry)
   and `queue: 'default'`, and set `worker: { enabled: true }` in the host `src/config/resize.ts`
   (default `false`), then run the worker as its own process — `npm run cli ResizeWorker`
   (queue `'default'`; `npm run cli ResizeWorker -- --queue=bulk` consumes only `'bulk'`).
   The flag permits the command to run; it does not start a worker in the API. The worker consumes
   indexes prepared by the host lifecycle; it does not create them, so start it after they exist
   (step 7).
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
is rejected. SVG dimensions that cannot retain a pixel on each side within the renderer's side
limit are rejected before storage with `RESIZE_SVG_DIMENSIONS_UNSUPPORTED` (for example,
`1×100000`). Already stored sources with those dimensions are dead-lettered on their first
delivery. The module does not sanitize SVG markup. The worker renders an SVG once per task,
before any pipeline step, into a PNG, in a separate Node process, at the largest size the
requested previews need; `beforeSteps` receive that PNG (never SVG markup), and every format is
made from it. The render is killed after `limits.processingTimeoutSeconds`
(`RESIZE_SVG_RENDER_TIMEOUT`, dead-lettered at once) or when the task aborts; a crashed render is
`RESIZE_SVG_RENDER_FAILED` (retried). A render that cannot start is `ResizeSetupError`
`RESIZE_SVG_RENDER_UNAVAILABLE`: the host must allow child processes (Node's permission model:
`--allow-child-process`) and ship `svgRasterChild.js` next to `svgRaster.js` (watch out when
bundling). Eager `generate()` throws all three.

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

A variant is accepted only when a task holds it: the task `prewarm()` just added, or, when the
gate is held (`add()` resolved `in-flight`), the active task that `findActive` (the database
queue) reports with the same canonical payload; conflicting payloads with one preview identity
are explicit errors. A requested variant the active task does not cover stays `unconfirmed` with
the retryable `RESIZE_TASK_IN_FLIGHT` (also while a dead task cools down): call `prewarm()` again
after that task ends. On a queue without `gatesByTask` (SQS) a held gate lock is the retryable
`RESIZE_ENQUEUE_LOCK_CONTENDED`. An `unconfirmed` add is the retryable
`RESIZE_ENQUEUE_UNCONFIRMED`; an add result that is not a `TaskAddResult` (a custom queue written
for an older version) is never counted as queued and gets the same code, not retryable, logged
once. An unexpected internal error is `incomplete` with a `RESIZE_ENQUEUE_INTERNAL_ERROR` issue.
The [`prewarm()` issues table](./README.md#prewarm-issues) in `README.md` lists every issue code,
when it happens and its `retryable`. Delivery remains at-least-once, not exactly-once.

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
`resolve({ media })` sees them. Reload the media before saving it after `generate()` or
`invalidate()`; the module wrote the rows itself (on a Mongoose document the changed `previews` is
marked modified, and saving the stale list would drop rows a worker stored since it was loaded).

Errors: EVERY throw from this module extends `ResizeError`, so one check separates a module
rejection from a sharp/S3/mongo failure. Subclasses say what to do — `ResizeSetupError` (wiring
is wrong), `ResizeConfigError` (crash at boot), `ResizeMediaError` (skip this record in the
request path; `ResizeNoOriginalError` and `ResizeOriginalError` extend it), `ResizeGenerateError`
(eager produced nothing or queued coverage is incomplete),
`ResizeStorageError` (transient; retry may help), `ResizeSecurityError` (refusal; never retry).
Every instance carries a stable `err.code` and `err.retryable` (default `true`; `false`: no retry
can help). The worker reads `retryable` on the error that fails the task, when it is a
`ResizeError` — including one from a duplicate copy of the package; errors from other libraries
are retried. It dead-letters the task at once when it is `false`; an error inside one variant
(`variantSteps`, encoding, `storage.upload`) fails only that variant, and the task fails with the
retryable `RESIZE_WORKER_INCOMPLETE`. Use `ResizeError.isResizeError(err)` rather than
`instanceof` when the error may cross a package boundary — duplicate copies of the package break
`instanceof` but not the symbol brand.

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
import { resizeMediaPaths } from '@adaptivestone/framework-module-resize/framework.js';
File.find().select(['mediaType', ...resizeMediaPaths]);
```

Remove a media's stored previews (e.g. after a pipeline's output changed, or before deleting the
media). `invalidate` never deletes files and never queues: delete the returned refs yourself:

```ts
const refs = await getResizer().invalidate({ media: fileDoc, pipeline: 'default' }); // omit pipeline: every pipeline
// delete each ref's object with your own storage client; the next read or prewarm() queues new ones
```

It removes only this Resizer's rows that carry an `identity`, in one write through
`MediaStore.replacePreviews`, and drops them from `fileDoc.previews` too (when that array cannot
be changed, it logs a warning and still returns the refs). Reload the media before saving it
after `generate()` or `invalidate()`; the module wrote the rows itself. Only an omitted
`pipeline` means every pipeline (`pipeline: null` matches nothing). It takes no gate: a task
running for that media can store rows after it returns. A custom `MediaStore` must implement
`replacePreviews(mediaId, identities, rows)` → `{ stored, removed }` (`verify()` rejects one
without it: `RESIZE_MEDIA_REPLACE_MISSING`). A custom model-shaped `MongoMediaModel` must accept
an update pipeline: `replacePreviews` calls `findOneAndUpdate` with an array update and
`{ updatePipeline: true, returnDocument: 'before', lean: true, projection: { previews: 1 } }`
(after an optional `castObject`), and a `findOneAndUpdate` middleware on the media model sees
that call too. Old rows: rows written before `0.3.0-rc.1` have no `origin` or `encodeSig`; they
are served for now and will be regenerated once a later release's freshness check ships (plan
the storage cost). Rows without an `identity` (written before 0.3.0) are never removed by
`invalidate` or `replacePreviews`: the host deletes their files itself.

Hooks are typed — register at construction (`hooks:`) or later via `getResizer().hook(name, fn)`.
Waterfalls (read path, real `ctx`): `resolveSizes`, `beforeEnqueue`, `formatPublicUrls`.
Observers (worker side): `onPreviewGenerated`, `afterTaskComplete`, `onTaskFailed`,
`onTaskDeadLettered`; the three task observers (`afterTaskComplete`, `onTaskFailed`,
`onTaskDeadLettered`) receive the task with `attempts` (its deliveries, 1 on the first).
Pipelines: `beforeSteps` run once on the source buffer;
`variantSteps` run per variant after resize, before encode. An optional pipeline `version`
(string) is part of each preview row's `encodeSig`: bump it when a step's output changes (stored
previews are not regenerated yet).

## Rules (violations cause real incidents)

- `sizes` is an ALLOWLIST. Never pass client-supplied dimensions through — resolve them against
  a fixed per-entity catalog first (otherwise: arbitrary-resize resource abuse).
- Construct each Resizer ONCE, at one construction site, with `new FrameworkResizer`. Most
  hosts need one (`getResizer()`); for more, give each a `name` and, if it differs, its own
  config file via `configName` (`getResizer('listings')`). The same name twice throws. Every task records its Resizer and queue; a worker serves one queue
  (`--queue`, default `'default'`) for every Resizer constructed in its process before the worker
  starts, with one consume loop per task queue (Resizers on the same backend share one), one task
  at a time, each processed with its own Resizer. Every claim names the Resizers the worker
  serves: a task queue with `claimFilters` (the database queue) never hands it another Resizer's
  task; from one that cannot filter claims (SQS), such a task is given back to the queue (or
  retried when the queue cannot give tasks back).
- `ctx` does NOT cross the queue: worker-side steps and observers see `ctx === {}`. Only eager
  `generate()` passes the caller's `ctx` to steps. Persist per-media data on the media doc.
- Watermarks belong in `variantSteps`, never in `beforeSteps` (baked once onto the original, a
  watermark scales away to unreadable on small variants).
- Register every pipeline in `src/resizer.ts`, so the API and the worker both have it
  (`resizer.hasPipeline(name)` checks). An unregistered name (anything but `'default'`) never
  renders: `resolve()` serves only previews already stored for it and queues nothing, `prewarm()`
  reports the non-retryable issue `RESIZE_PIPELINE_UNKNOWN`, and `generate()` and the worker throw
  `ResizeSetupError` with that code (a queued task retries, then dead-letters). When you add or
  rename a pipeline, deploy the worker before the API requests it. The worker in turn needs the
  indexes (step 7), so create them through a migration that runs before both.
- The scaffolded `resize.ts` is complete. The framework merges environment overrides and the
  module reads that final config without a second merge. Arrays in environment overrides replace.
- Format ids are open strings. `formats` controls generated outputs, `upload.formats` controls
  accepted originals, and `encode.formats[id]` is passed to Sharp as that encoder's options. A
  per-call `formats` entry (or a variant a `beforeEnqueue` tap adds or rewrites) without an
  `encode.formats` key is never generated: `resolve()` leaves it out of `decision.missing`,
  `prewarm()` reports it in `unconfirmed` with the non-retryable issue
  `RESIZE_FORMAT_NOT_CONFIGURED`, and `generate()` throws `ResizeSetupError` with that code.
- Never resize/encode with sharp on the request path. `uploadOriginal()` has one bounded exception:
  `metadata()` inspection for raster images and SVG only; it never emits transformed bytes.
- The scaffolded model/command shims re-use the package: do not vendor or fork them. The command
  must keep its `import '../resizer.ts'`. Gate drift in CI with `npx resize-scaffold --check`
  (`--check --eager` for an eager host, which has no model or command to check). Right after an
  upgrade it reports every older `src/config/resize.ts` and ejected model: intended, see
  Troubleshooting.
- SVG originals stay private, and no original is ever served: `resolve()` returns stored previews
  only, so uploaded SVG markup never reaches a reader. The worker renders SVG into the requested
  raster preview formats through the normal durable task lifecycle.
- Deleting storage objects is the HOST's job — the module only appends rows, and `invalidate`
  only removes rows and returns their storage refs.
- A queued raster task completes only with full identity coverage. Partial successes are persisted,
  then retried for the missing identities only; persistent gaps follow normal backoff/dead-letter.

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| ``resize config: `mediaModelName` is required``, `RESIZE_CONFIG_MEDIA_MODEL_MISSING` | set it in the host `src/config/resize.ts` (or the `configName` file named in the message) |
| `RESIZE_APP_NOT_INITIALIZED` | a `FrameworkResizer` (or another part from `…/framework.js`) read the framework app before the `Server` was constructed — construct the Server before the first call (importing `src/resizer.ts` earlier is fine: it reads nothing until first use); in tests, install a fake app with `setAppInstance` from `@adaptivestone/framework/helpers/appInstance.js` |
| `RESIZE_MEDIA_REQUIRED` at construction | `new Resizer()` takes its `media` explicitly — framework hosts use `new FrameworkResizer()` from `…/framework.js`; plain Node: `...mongoParts(connection, { mediaModel })` |
| `RESIZE_STORAGE_REQUIRED` at construction or first use | `new Resizer()` got no `storage`, or a `storage` function resolved with nothing — pass a `ResizeStorage` driver (e.g. `new LocalFsStorage({ … })` from `…/drivers/fs.js`); framework hosts use `new FrameworkResizer()`, which builds it from the config file's `storage` (`RESIZE_CONFIG_STORAGE_MISSING` when that is missing) |
| `RESIZE_NAME_INVALID` or `RESIZE_QUEUE_INVALID` at construction | the Resizer's `name` or `queueName` option is not a non-empty string — pass one, or leave it out for `'default'`. ``resize: `queue` is now `queueName` `` (`RESIZE_QUEUE_INVALID`): the old `queue` option was renamed — pass `queueName`, and read `resizer.queueName` instead of the removed `resizer.queue` |
| `RESIZE_CONFIG_QUEUE_UNKNOWN` on first use or from `verify()` | the Resizer's queue name (its `queueName` option, or its file's `queue`, or the implied `'default'` when the file sets none) is not an entry of `queues` in `src/config/resize.ts` — add `queues.<name>` (e.g. `queues: { default: { driver: 'database' } }`), set `queue`/`queueName` to a defined name, or `queue: false` (`tasks: false` when the name came from the option) for eager only |
| `RESIZE_LOCKS_REQUIRED` from `verify()` or at worker start (reads serve stored previews and queue nothing; `prewarm()` reports it) | a Resizer whose task queue has no `gatesByTask` (e.g. `SqsTaskQueue`) has no `locks`, and it takes one gate lock per media, pipeline and queue — spread `mongoParts(connection, { mediaModel })` (its `locks`) or pass a `LockStore`, or drop `tasks` for an eager-only Resizer. `MongoTaskQueue` needs no `locks`; a `FrameworkResizer` builds `FrameworkLockStore` itself beside a task queue without `gatesByTask` (the SQS driver, or a custom queue without the flag) |
| `RESIZE_CONFIG_QUEUE_INVALID` or `RESIZE_CONFIG_QUEUE_LEASE_INVALID` | the queue timing is invalid — fix the key the message names (in `queues.<name>` of `src/config/resize.ts`, or the task queue's `timing` / `getTiming`). The config file fails on first use with the rest of the file; a task queue's own timing fails `verify()` and worker start, while reads serve stored previews, queue nothing, and `prewarm()` reports it. On a task queue passed in code, the invalid timing of a queue used only per call is reported by that call's `prewarm()` (`RESIZE_ENQUEUE_INTERNAL_ERROR`, not retryable) and logged once per queue name by `resolve()` |
| `RESIZE_MEDIA_REPLACE_MISSING` from `verify()`, at worker start, or from `invalidate` | a custom `MediaStore` has no `replacePreviews(mediaId, identities, rows)`, required since 0.3.0 — implement it (one atomic write per media; resolve `{ stored, removed }`; see the README `MediaStore` contract), or extend `MongoMediaStore` |
| `RESIZE_MEDIA_REPLACE_RESULT_INVALID` | a custom `MediaStore.replacePreviews` resolved with something other than `{ stored, removed }` (two arrays) — resolve with the rows it stored and removed (`[]` when none), `removed` being exactly what the write removed |
| a `findOneAndUpdate` middleware on the media model throws on an array update, or `invalidate` fails on a custom model-shaped `MongoMediaModel` | `replacePreviews` (which `invalidate` uses) sends an update pipeline: `findOneAndUpdate(filter, [ … ], { updatePipeline: true, returnDocument: 'before', lean: true, projection: { previews: 1 } })`, after casting the rows with the model's optional `castObject` — make the model and its middleware accept an array update |
| `RESIZE_MEDIA_APPEND_RESULT_INVALID` | a custom `MediaStore.appendPreviews` resolved with something other than an array — resolve with the previews it stored (`[]` when none) |
| `RESIZE_CONFIG_STORAGE_MISSING` | add `storage: { driver: 'local', … }` (or `'s3'`) to the config file named in the message, or pass `storage` to `new FrameworkResizer()` |
| `RESIZE_FS_PRIVATE_ROOT_PUBLIC` (`ResizeSecurityError`) when `LocalFsStorage` is constructed (from a config file: at first use or `verify()`) | `privateRootDir` is `rootDir` itself or inside it, so private originals would be served — put it outside `rootDir` (`storage.privateRootDir` in the config file), or leave it out for `rootDir` + `-private` |
| `RESIZE_CONFIG_INVALID` | the config is malformed, and the message names the part: a config (or config file) that is not an object, a `storage` driver other than `'local'` or `'s3'`, a `queues` map that is not an object of names, a `queues` entry with a blank name or without driver `'database'` or `'sqs'`, an SQS entry without `queueUrl`, two SQS entries with the same `queueUrl`, a `queue` that is neither a queue name nor `false`, a process-wide section (`queues`, `worker`, `coordination`) outside `src/config/resize.ts` (in another file, or in the `config` option), a `worker` section that is not an object or whose `enabled` (boolean), `sharpConcurrency` (positive integer) or `sharpCache` (boolean) has the wrong type (each key is optional and defaults), an unknown `worker` key (e.g. a misspelled `sharpConcurency`), or image settings of the wrong type (`maxSize`, `animated`, `encode.formats`, `encode.flatten`, `encode.sharpen`, `limits`, `concurrency`) — fix what the message names. A config file fails on first use or `verify()`; a config object passed in code, at construction (a config function: at first use) |
| `RESIZE_CONFIG_UPLOAD_INVALID`, `RESIZE_CONFIG_UPLOAD_MAX_BYTES_INVALID` or `RESIZE_CONFIG_UPLOAD_FORMATS_INVALID` | `upload` is not an object, `upload.maxBytes` is not a positive safe integer, or `upload.formats` is not a non-empty list of non-empty format ids — fix that key, e.g. spread the defaults' `upload` and change one value |
| `RESIZE_NOT_READY` | host code read `resizer.storage` / `media` / `locks` / `tasks`, or a `resizer.queueName` that comes from the config file (or from a function), before the Resizer loaded them — `await resizer.ready()` first (the Resizer's methods do this themselves). A string `queueName` option is readable at once. `resizer.queue` is gone: read `resizer.queueName` |
| `RESIZE_CONFIG_REMOVED_KEY` naming `queue` or `worker` | a core config passed to `new Resizer` holds image settings only — move timing to the task queue's `timing`; framework hosts define queues in `queues` and keep `worker` in `src/config/resize.ts`; `worker.concurrency` (in a framework config file too) moves to the top-level `concurrency` |
| `RESIZE_CONFIG_REMOVED_KEY` naming `lockTtlMs` | lock TTLs left queue timing (`queues.<name>` in `src/config/resize.ts`, or a task queue's `timing`) for the Resizer's `coordination`: `lockTtlMs.failed` → `cooldownMs`, `lockTtlMs.dispatch` → `gateTtlMs`, drop `lockTtlMs.worker` |
| `RESIZE_CONFIG_COORDINATION_INVALID` from `verify()` or at worker start (reads serve stored previews and queue nothing; `prewarm()` reports it) | `coordination` is not an object, or a value in it is not a positive safe integer (ms; `0` is rejected too, so the cooldown cannot be turned off) — fix the key the message names, or the whole section when the message shows its value (`coordination` in `src/config/resize.ts`, the only file it is read from since it is process-wide, or the `coordination` option) |
| `RESIZE_TASK_IN_FLIGHT` in `prewarm()` issues (`retryable: true`) | a task for this media, pipeline and queue is active, or a dead one is cooling down, and it does not cover these variants: one task per media, pipeline and queue runs at a time — call `prewarm()` again after it ends (a read after it ends queues them too) |
| `RESIZE_ENQUEUE_LOCK_CONTENDED` in `prewarm()` issues (`retryable: true`) | a task queue without `gatesByTask` (SQS): the gate lock of this Resizer, media, pipeline and queue is held — a task of theirs is queued, running or waiting for a retry, a dead one's `coordination.cooldownMs` runs, or an add that threw or was not confirmed keeps the lock for one lease (at most `coordination.gateTtlMs`). SQS cannot report which variants that task holds, so none is accepted — call `prewarm()` again after the task ends (a read after it ends queues them too) |
| `RESIZE_ENQUEUE_UNCONFIRMED` in `prewarm()` issues | `retryable: true` (even for an unregistered or outdated model): the task queue's `add()` resolved `unconfirmed`, so the queue did not confirm the task — on `MongoTaskQueue` a database error or a duplicate key on another unique index of the host's `ResizeTask` model (each logged), an unregistered `ResizeTask` model (logged), or an outdated one (`RESIZE_MONGO_MODEL_OUTDATED`, logged once; every add stays unconfirmed until it is fixed); on SQS a send that returned no `MessageId`. Fix the logged cause first, then call `prewarm()` again. `retryable: false`: a custom `TaskQueue` resolved a value in none of the `TaskAddResult` shapes (written for an older version, e.g. `{ taskId }`), logged once — resolve `{ status: 'added', taskId }`, `{ status: 'in-flight', taskId? }` or `{ status: 'unconfirmed' }` |
| `RESIZE_MONGO_INDEX_MISSING` from `verify()` or at worker start, or the warning "reported a task in flight without its id" | the `ResizeTask` collection has no gate index — unique on exactly `{ resizer: 1, fileId: 1, pipeline: 1, queue: 1 }` with `partialFilterExpression: { active: true }` (or `{ active: { $eq: true } }`) — or does not exist yet, or an index on those keys lacks `unique` or that partial filter, or Mongoose's own index build (`autoIndex`) failed (the error's `cause`, e.g. duplicate active rows) (without the filter every add after a completed task is in flight with no id and nothing queues). Create it through your migration (e.g. `ResizeTask.createIndexes()` or `syncIndexes()`; drop a wrong index on those keys first); the module never creates indexes, and a worker on the framework CLI (`autoIndex` off) neither builds them nor waits for a build: create them before it starts (step 7) |
| `RESIZE_MONGO_MODEL_MISSING` from `verify()` or at worker start | a model does not resolve: the `ResizeTask` model (scaffold `src/models/ResizeTask.ts`), the lock model (the framework's `Lock`, needed only beside a task queue without `gatesByTask`, or the model passed to `MongoLockStore`), or the media model of a plain `MongoMediaStore` (framework hosts get `RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN` instead) |
| `RESIZE_MONGO_MODEL_OUTDATED` from `verify()`, at worker start, or logged once by `add()` (every add is then unconfirmed and queues nothing until the model is fixed; claims reject with it), or `resize-scaffold --check` reports drift in `src/models/ResizeTask.ts` | a shim from an older scaffold that imports `…/framework.js`: delete `src/models/ResizeTask.ts` and re-run `npx resize-scaffold` (`--force` would also overwrite `src/resizer.ts` and `src/config/resize.ts`). An ejected or hand-written model without the `resizer`, `queue`, `availableAt`, `active` or `cooldownUntil` fields: port them (and the `{ queue, status, availableAt }` index and the gate index) from `resizeTaskFields()` / `resizeTaskIndexes` (`…/drivers/mongo.js`), or delete it and re-run `npx resize-scaffold --eject`. Right after the upgrade `--check` also reports every ejected model without `startedAt` and `finishedAt` — intended (such a model keeps working; the times are dropped and `RESIZE_MONGO_MODEL_OUTDATED` does not list them): add both as `{ type: Date }`, or move `src/models/ResizeTask.ts` aside (or delete it), re-run `npx resize-scaffold --eject`, then restore your customizations (re-running `--eject` alone never overwrites the file) |
| `resize-scaffold --check` reports drift in `src/config/resize.ts` or a `resize.<NODE_ENV>.ts` override ("uses the old config shape") right after the upgrade | intended, for every config scaffolded by an earlier version: a top-level `queue: { … }` object (a `queue` entry inside `queues` is fine), or `defaultFrameworkResizeConfig` imported from `…/config/resize.js` (only full-line `//` comments are skipped) — rewrite it to the new shape (step 5), or move it aside, re-run `npx resize-scaffold` and copy your settings back. The config file is never diffed, and a second Resizer's `configName` file is not checked: review it yourself |
| `RESIZE_MONGO_NOT_CONNECTED` from `verify()` or at worker start | the Mongoose connection of the `ResizeTask` model is closed (never opened, or disconnected: at once), or failed to open (after the driver's `serverSelectionTimeoutMS`, 30 s by default; the message names the driver's error) — call `verify()` after the connection has opened (after `Server.init()` in a framework host); an opening connection is awaited |
| `RESIZE_MONGO_MEDIA_MODEL_OUTDATED` from `verify()` or at worker start | the media schema declares preview rows as strict sub-documents without `identity`, `origin` or `encodeSig` (the message names them; a mixed or plain `previews` array, or rows with `strict: false`, pass) — spread the current `resizeMediaSchemaFragment`, or add each missing field to the row as `{ type: String }` |
| previews written before `0.3.0-rc.1` (no `origin` / `encodeSig`), or rows that `invalidate` leaves behind | old rows: rows without `origin` and `encodeSig` are served for now and will be regenerated once a later release's freshness check ships (plan the storage cost); rows without an `identity` (written before 0.3.0) are never removed by `invalidate` or `replacePreviews` — delete their files yourself |
| `RESIZE_MONGO_LOCK_MODEL_OUTDATED` from `verify()` or at worker start | the lock model's strict schema has no `owner` field, so no lock could be released before it expires (e.g. a `ResizeLock` model registered on the connection before this version, which `createResizeModels` returns as it is) — add `owner: { type: String }` (see `resizeLockFields` in `…/drivers/mongo.js`) |
| `RESIZE_SVG_RENDER_UNAVAILABLE` | the SVG render process cannot start — allow child processes (`--allow-child-process` under Node's permission model) and keep `svgRasterChild.js` next to `svgRaster.js` in a bundle |
| a variant stays missing for ~10 min after its task was dead-lettered | `coordination.cooldownMs` (default 600000): the dead task holds the gate of its media, pipeline and queue until the cooldown ends, so reads queue nothing and `prewarm()` reports `RESIZE_TASK_IN_FLIGHT` (SQS: `RESIZE_ENQUEUE_LOCK_CONTENDED`) — fix the cause in the logs first |
| `RESIZE_MONGO_MODEL_REQUIRED` | `new MongoMediaStore()` / `new MongoLockStore()` / `new MongoTaskQueue()` needs exactly one of `model` or `getModel` — or use `mongoParts(connection, { mediaModel })` |
| `RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN` at worker start | `mediaModelName` does not match a registered host model — fix the name |
| `RESIZE_CONFIG_REMOVED_KEY` | a 0.2.x key or an old shape is still in a config file (`resize.ts`, another Resizer's file, or an environment override) — move it to the path named in the message. Among them: a `queue: { … }` object (define the queue in `queues` of `src/config/resize.ts` and set `queue` to its name), `queues.<name>.queues` (give each SQS queue its own entry), and the worker's `--config` flag or `runResizeWorker({ configName })` (removed: the worker reads `worker` and `queues` from `src/config/resize.ts`) |
| `formats [...] have no encode.formats entry` (`RESIZE_CONFIG_FORMATS_INVALID` in the config), `RESIZE_FORMAT_NOT_CONFIGURED` | add `encode.formats.<id>` (`{}` for Sharp defaults), or request only configured ids; use `'jpeg'`, not the alias `'jpg'` |
| `RESIZE_PIPELINE_UNKNOWN` | the pipeline is not registered in that process — register it in `src/resizer.ts`; deploy the worker before the API requests a new or renamed pipeline |
| `ERR_MODULE_NOT_FOUND: @aws-sdk/...` at your driver import, or `RESIZE_PEER_MISSING` for a driver selected in the config | optional peer not installed — install the packages named, see step 1 |
| `a Resizer named '…' already exists` | each name is constructed once per process — import the single construction site; elsewhere `getResizer(name)` |
| `RESIZE_NO_RESIZER` at worker start | `src/commands/ResizeWorker.ts` does not import `../resizer.ts` — delete it and re-run `npx resize-scaffold` |
| `Resizer '…' is not served by this worker` in worker logs, or `RESIZE_NO_RESIZER` on a task | a task queue that cannot filter claims (SQS) handed the worker a task of a Resizer it does not serve: that Resizer was not constructed in the worker process before the worker started (or not passed in `runWorker({ resizers })`). Its tasks are given back to the queue for a worker that serves it (SQS still counts each receive, so a task bounced between workers that serve different Resizers can use up its `maxAttempts` and be dead-lettered by the worker that serves it: give each set of Resizers a worker serves its own SQS queue URL), or, when the queue cannot give tasks back, fail with `RESIZE_NO_RESIZER` (retried, then dead-lettered) — construct every Resizer in `src/resizer.ts`, which both the API and the worker load. On the database queue, which filters claims, such tasks wait for a worker that serves their Resizer, and every claim on that queue reads past them (the claim index does not hold the Resizer): give a Resizer that has no worker its own queue (a log saying the queue "handed its task out although it filters claims" is a broken custom queue) |
| `RESIZE_QUEUE_NOT_SERVED` at worker start or from `verify()` | no task queue can consume that queue (a `--queue` name that `queues` does not define, or an `SqsTaskQueue` without its URL), or a Resizer's own `queueName` is not served by the task queue passed to it in code — define the queue (add its URL), or start the worker for another queue |
| `RESIZE_QUEUE_NOT_SERVED` in `prewarm()` issues (`retryable: false`), or the warning "cannot queue to '…': its task queue does not serve that queue" from `resolve()` (once per queue name) | the call's `queue` is unknown to the Resizer's task queue (in a framework host, not an entry of `queues`; for `SqsTaskQueue`, no URL) or is a queue on another backend: one Resizer uses one backend, so nothing is queued. Typical cause: an environment override moved only some queues to another backend (e.g. only `queues.default` to SQS) — move all of a Resizer's queues together until routing between backends ships, or call with a queue of the Resizer's own backend |
| `RESIZE_SQS_QUEUE_URL_REQUIRED` at construction | `new SqsTaskQueue()` with neither `queueUrl` nor a `queues` entry — pass the `'default'` queue's URL, or name every queue it serves in `queues` (`queueUrl` is optional beside `queues`; a framework `queues` entry with driver `'sqs'` and no `queueUrl` fails with `RESIZE_CONFIG_INVALID` instead) |
| `RESIZE_SQS_QUEUE_UNKNOWN` | a direct `SqsTaskQueue` call (`add`, `claim`) named a queue it has no URL for — add the URL to `queues`. A Resizer never gets it: its call on such a name is `RESIZE_QUEUE_NOT_SERVED` before any gate lock or `add()` (see that row) |
| `RESIZE_QUEUE_SHARED_RESIZER_UNLISTED` at worker start | `runWorker({ resizers })` does not list a Resizer of the process that uses a task queue the worker consumes and that cannot filter claims, e.g. SQS (the message names the queue and the Resizers; a queue with `claimFilters` may be shared); the worker would claim their tasks without running them — list them too, or give them their own task queue. When the message says a task queue failed to load, the worker could not compare that unlisted Resizer's task queue (the load error is the cause) — fix that task queue |
| `RESIZE_DUPLICATE_RESIZER` at worker start, "the `resizers` list names '…' twice" | two different Resizers in `runWorker({ resizers })` share a name, so tasks could reach only one — give each its own name |
| tasks stay `pending` on one queue | no worker consumes that queue — start `npm run cli ResizeWorker -- --queue=<name>`. The gate is per queue: such a task blocks new tasks for its media and pipeline on that queue only, never reads on another queue |
| models fail to load (framework ≥5.1 reports a duplicate framework copy explicitly at boot) | two `@adaptivestone/framework` copies resolve (npm link / nested install) — dedupe to exactly one |
| previews never appear | the worker process isn't running, or `worker.enabled` is `false` in that process |
| first read of a new size is slow to fill | lazy mode working as designed — call `prewarm()` at upload if it matters |
| `resolve` `output` is `undefined` | no `formatPublicUrls` hook (or it threw) — map `decision` or use `formatPictureUrls` |

Config knobs and their scaffolded defaults are listed in the "Config reference" table in
`README.md`.
