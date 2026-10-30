# Host adoption required for nested storage refs

This package changes the persisted resize fields from flat `key`/`bucket` fields to
`original.storageRef` and `previews[].storageRef`. It has no reader or migration for
old resize records. Updating this package alone does not make an existing host ready
for rollout: the API and worker must use the same package version and media schema.

Host adoption checklist (implementation belongs in the host repository):

- Upload handlers must persist the returned original with its nested `storageRef`.
  Supply a stable optional namespace if the host wants auditable storage prefixes.
- Media mapping helpers must pass nested refs to the module. Any handling of legacy
  host data is the host's responsibility; the module supplies no old-record reader
  or migration.
- `original.format` should be the decoder's id (`jpeg`, `png`, `svg`, …; not `jpg`
  or a MIME type), as `uploadOriginal()` returns it. The worker tries that decoder
  first; a value no decoder lists, or one whose decoder refuses the bytes, is logged
  as a warning and the bytes are probed, so a legacy record with a guessed format
  still renders. Fix the record to silence the warning.
- Media models must use `resizeMediaSchemaFragment` (from `…/framework.js`, or from
  `…/drivers/mongo.js` without the framework) and update presence checks and
  conditional writes that previously relied on flat `original.key` fields.
- Public URL builders and preview-generation helpers must check
  `original.storageRef` when deciding whether an original has been persisted.
- Upload, preview and storage tests must assert the nested ref shape.

Before deployment, verify the target data policy, update all host consumers, run
host tests and coordinate API/worker release. The module patch does not establish
that the host's existing data satisfies the no-legacy-record assumption.

Retain `minimize: false` on the media schema so empty objects inside opaque refs
survive persistence. Framework `BaseModel` already supplies this default; direct
Mongoose schemas must set it explicitly. The field fragment alone cannot configure
the enclosing schema's options.

## Installing the release candidate

0.3.0 ships as release candidates first, published with the npm tag `next`:

```bash
npm i @adaptivestone/framework-module-resize@next
```

`0.3.0-rc.1` holds every host-facing shape of 0.3.0: the config, the option and type names, the
import paths, the preview fields and `invalidate`. `0.3.0-rc.2` changes the `beforeSteps`
signature and adds decoders (see [Changed in `0.3.0-rc.2`](#changed-in-030-rc2)).

`0.3.0-rc.3` only adds APIs a host may choose to use: `createResizer` (a Resizer from one config
object, without the framework), drivers registered by name (the `drivers` option, `fromConfig`),
`RoutingTaskQueue` and `carrierOf`, a worker that consumes several queues
(`--queue=default --queue=bulk`), and partial config files (`PartialFrameworkResizeConfig`). It
requires no host change. Three things a host may notice without changing anything:

- when `queues` spans two available backends (a database entry and an SQS entry whose SDK is
  installed), `resizer.tasks` is a `RoutingTaskQueue`, not the backend's own task queue (no
  `release`; an `instanceof MongoTaskQueue` check fails: ask `carrierOf(resizer.tasks, name)`);
- a call on a queue of another backend now queues there, where `0.3.0-rc.2` reported
  `RESIZE_QUEUE_NOT_SERVED`;
- with those two backends, every `FrameworkResizer` that takes its task queue from the config
  file can queue to every name, so a custom `runWorker({ resizers })` that consumes a queue on SQS
  must list all of them, whatever their own queue (else `RESIZE_QUEUE_SHARED_RESIZER_UNLISTED`;
  `0.3.0-rc.2` accepted `runWorker({ resizers: [b], queue: 'bulk' })` beside a Resizer `a` on the
  database queue). `npm run cli ResizeWorker` serves every Resizer and is not affected.

Release candidates after `0.3.0-rc.3` change only internals. `CHANGELOG.md` (`# 0.3.0`) has the
details of everything below.

## Named queues: from `queue: { … }` to `queues`

Each queue is now defined once, by name, in the process-wide `queues` map of
`src/config/resize.ts`, with its own timing. Each Resizer's config file names its queue with
`queue`. `worker` and `coordination` are process-wide too, and read only from
`src/config/resize.ts`. Before (0.2.x, or a 0.3.0 pre-release build):

```ts
// src/config/resize.ts
import type { FrameworkResizeConfig } from '@adaptivestone/framework-module-resize/framework.js';
import { defaultFrameworkResizeConfig } from '@adaptivestone/framework-module-resize/config/resize.js';

export default {
  ...defaultFrameworkResizeConfig,
  mediaModelName: 'File',
  storage: { driver: 'local', rootDir: './var/media', publicBaseUrl: '/media' },
  queue: {
    driver: 'sqs',
    queueUrl: 'https://sqs.eu-west-1.amazonaws.com/123456789012/resize',
    queues: { bulk: 'https://sqs.eu-west-1.amazonaws.com/123456789012/resize-bulk' },
    maxAttempts: 8,
  },
  worker: { ...defaultFrameworkResizeConfig.worker, enabled: true },
} satisfies FrameworkResizeConfig;

// src/config/resizeListings.ts
export default {
  ...defaultFrameworkResizeConfig,
  mediaModelName: 'Listing',
  storage: { driver: 'local', rootDir: './var/listings', publicBaseUrl: '/listings' },
  queue: { driver: 'database', leaseMs: 120_000 },
  coordination: { gateTtlMs: 900_000, cooldownMs: 600_000 },
} satisfies FrameworkResizeConfig;
```

After:

```ts
// src/config/resize.ts
import {
  defaultFrameworkResizeConfig,
  defaultWorkerOptions,
  type FrameworkResizeConfig,
} from '@adaptivestone/framework-module-resize/framework.js';

export default {
  ...defaultFrameworkResizeConfig,
  mediaModelName: 'File',
  storage: { driver: 'local', rootDir: './var/media', publicBaseUrl: '/media' },
  queue: 'default', // a key of `queues`, or false for eager only

  // process-wide sections, read only from this file
  queues: {
    default: {
      driver: 'sqs',
      queueUrl: 'https://sqs.eu-west-1.amazonaws.com/123456789012/resize',
      maxAttempts: 8,
    },
    bulk: {
      driver: 'sqs',
      queueUrl: 'https://sqs.eu-west-1.amazonaws.com/123456789012/resize-bulk',
      maxAttempts: 8, // timing is per queue now: copy it to each entry
    },
    listings: { driver: 'database', leaseMs: 120_000 },
  },
  coordination: { gateTtlMs: 900_000, cooldownMs: 600_000 }, // one per process: every Resizer's now
  worker: { ...defaultWorkerOptions, enabled: true },
} satisfies FrameworkResizeConfig;

// src/config/resizeListings.ts: only this Resizer's own sections
import {
  defaultFrameworkResizeConfig,
  type FrameworkResizeConfig,
} from '@adaptivestone/framework-module-resize/framework.js';

export default {
  ...defaultFrameworkResizeConfig,
  mediaModelName: 'Listing',
  storage: { driver: 'local', rootDir: './var/listings', publicBaseUrl: '/listings' },
  queue: 'listings',
} satisfies FrameworkResizeConfig;
```

- Move the default Resizer's `queue: { … }` object into `queues.default` of `src/config/resize.ts`
  and set `queue: 'default'`. Another Resizer's file whose `queue` object was on the same backend
  (both `database`, or the same SQS settings) drops it and keeps `queue: 'default'`: the Resizers
  share that queue, and no new worker is needed. Only a queue on a different backend (`listings`
  above), or one that should get its own timing, needs a name of its own in `queues` and
  `queue: '<that name>'`. An SQS
  object's `queues: { name: url }` becomes one entry per name, `{ driver: 'sqs', queueUrl: url }`,
  with the same `region`, `endpoint`, `deadLetterQueueUrl` and `waitTimeSeconds`. Its timing keys
  go to every entry they applied to. A `queue` object, in any file, now fails with
  `RESIZE_CONFIG_REMOVED_KEY`, and so does `queues.<name>.queues`.
- A name is defined once, so two Resizers that used `'default'` on different backends now need
  two names (`default` and `listings` above). A worker consumes only the queues it is given, so
  every new name needs a worker: `npm run cli ResizeWorker -- --queue=<name>` (`--queue=listings`
  above), or one worker for several, `npm run cli ResizeWorker -- --queue=default
  --queue=listings`; otherwise its tasks stay pending.
- `queue` is a name. Without `queue`, a Resizer uses `'default'` when `queues` has entries and is
  eager only when there are none; `queue: false` is eager only. A name that `queues` does not
  define (the implied `'default'` too) is `RESIZE_CONFIG_QUEUE_UNKNOWN`.
- `queues`, `worker` and `coordination` in another file (or in the `FrameworkResizer` `config`
  option) are `RESIZE_CONFIG_INVALID`. Move a second file's `coordination` into
  `src/config/resize.ts` (one per process), or pass it in code:
  `new FrameworkResizer({ …, coordination })`.
- Every key of `worker` is optional (a missing one takes `defaultWorkerOptions`), so an
  environment file may hold only `worker: { enabled: true }`. The old commented line
  `worker: { ...defaultFrameworkResizeConfig.worker, enabled: true }` no longer type-checks.
- Every config file writes `satisfies FrameworkResizeConfig`. An environment override
  (`resize.<NODE_ENV>.ts`), and a `resize.ts` that holds only the process-wide sections (no
  default Resizer, so no `mediaModelName`), write `satisfies Partial<FrameworkResizeConfig>`; an
  override that leaves out nested keys (only `limits.sourcePixels`, say) may write
  `satisfies PartialFrameworkResizeConfig` instead. From `0.3.0-rc.3` the image settings of every
  file are merged over the package defaults, so a file may set only the keys it changes. The
  queue entry types are `QueueConfig`, `DatabaseQueueConfig` and `SqsQueueConfig` (main entry,
  re-exported by `…/framework.js`); `FrameworkQueueConfig`, `FrameworkDatabaseQueueConfig` and
  `FrameworkSqsQueueConfig` are removed.
- Every `database` entry shares one task queue, and so do the SQS entries with the same `region`,
  `endpoint`, `deadLetterQueueUrl` and `waitTimeSeconds`: one task queue per backend, and each name
  is a lane on it with its own timing. Names on different backends are routed (statement 5 below).
  `RESIZE_CONFIG_QUEUE_TIMING_CONFLICT` is gone: a queue is defined once, so two files can no longer
  disagree about its timing.

## Six things to know after the upgrade

1. **`resize-scaffold --check` reports drift right after the upgrade.** It does so for every
   `src/config/resize.ts`, and every `resize.<NODE_ENV>.ts` override of it, scaffolded by an
   earlier version (a top-level `queue: { … }` object, or `defaultFrameworkResizeConfig` imported
   from `…/config/resize.js`; only full-line `//` comments are skipped, and a second Resizer's
   `configName` file is not checked), and for every ejected `ResizeTask` model. This is intended.
   To clear it:
   - rewrite the config to the new shape (above), or move it aside, re-run
     `npx resize-scaffold` and copy your settings back;
   - add `startedAt: { type: Date }` and `finishedAt: { type: Date }` to an ejected model, or
     move `src/models/ResizeTask.ts` aside (or delete it), re-run `npx resize-scaffold --eject`,
     then restore your customizations (the scaffold never overwrites a file, so re-running `--eject`
     alone changes nothing). Without them the model keeps working, but loses the two times.
2. **A custom model-shaped `MongoMediaModel` must accept an update pipeline.** `replacePreviews`
   (which `invalidate` uses) calls `findOneAndUpdate` with an array update and
   `{ updatePipeline: true, returnDocument: 'before', lean: true, projection: { previews: 1 } }`,
   after casting the rows with the model's optional `castObject` (`storageRef` and `filters` are
   stored as given, cast or not). A `findOneAndUpdate` middleware on the media model also sees
   that call, so it must accept an array update. A Mongoose model accepts it as it is.
3. **`runResizeWorker({ configName })` is removed, together with `--config`.** Both are rejected
   with `RESIZE_CONFIG_REMOVED_KEY`: the worker reads `worker` and `queues` from
   `src/config/resize.ts`. A host whose Resizers read only named files adds a
   `src/config/resize.ts` that holds only the process-wide sections
   (`satisfies Partial<FrameworkResizeConfig>`).
4. **`resizer.queue` is gone; use `queueName`.** The option is `queueName` too (the old `queue`
   option is `RESIZE_QUEUE_INVALID`).
   - A string `queueName` option is readable at once.
   - A name from the config file is known only after `await resizer.ready()` or the first call;
     before that, `resizer.queueName` throws `RESIZE_NOT_READY`.
5. **Mixed backends from an environment override now route.** Moving only some queues to another
   backend in `resize.<NODE_ENV>.ts` (for example only `queues.default` to SQS, while
   `queues.bulk` stays on the database) keeps every name working: each call goes to its queue's
   backend, gated there (a database task row, or a gate lock in the framework `Lock` model for
   SQS), and one worker can consume both (`--queue=default --queue=bulk`). A backend is built when
   one of its names is first needed, so an SQS entry no Resizer uses never loads the SQS SDK, and a
   name whose backend's SDK is not installed is not served in that process
   (`RESIZE_QUEUE_NOT_SERVED`, naming the package). With two backends, `resizer.tasks` is a
   `RoutingTaskQueue`: use `carrierOf(resizer.tasks, name)` instead of an `instanceof` check.
6. **Old preview rows.**
   - Rows written before `0.3.0-rc.1` (no `origin` or `encodeSig`) are served for now. They will
     be regenerated once a later release's freshness check ships, so plan the storage cost.
   - Rows without an `identity` are never removed by `invalidate` or `replacePreviews`; the host
     deletes their files itself.

## Other changes a host must make for 0.3.0

- Construct the Resizer with `new FrameworkResizer({ pipelines, hooks })` in
  `src/resizer.ts`, and move `storage` and the queues into `src/config/resize.ts`
  (`queues: { default: { driver: 'database' } }` and `queue: 'default'` for background
  generation; see above). Move `worker.concurrency` to the top-level `concurrency`.
- Update two imports. `resizeMediaSchemaFragment` and `resizeMediaPaths` left the main entry:
  import them from `…/framework.js` (without the framework, from `…/drivers/mongo.js`).
  `defaultFrameworkResizeConfig` and `defaultWorkerOptions` moved from `…/config/resize.js` to
  `…/framework.js`; `…/config/resize.js` keeps only the framework-free core defaults (the default
  export, `defaultQueueOptions` and `defaultCoordination`). `defaultFrameworkResizeConfig` holds
  the image settings only, without `worker` and `coordination`.
- Rename the `queue` option to `queueName` (`new Resizer({ queueName })`,
  `new FrameworkResizer({ queueName })`), and read `resizer.queueName` instead of `resizer.queue`
  (statement 4). `resolve()` and `prewarm()` keep their per-call `queue`.
- Create the `ResizeTask` indexes through the host's migration, in this order.
  Create the gate index `{ resizer: 1, fileId: 1, pipeline: 1, queue: 1 }` (unique,
  partial on `active: true`), which keeps one active task per Resizer, media,
  pipeline and queue, BEFORE the new API and workers start: `resizer.verify()` and
  worker start reject with `RESIZE_MONGO_INDEX_MISSING` until it exists (with
  Mongoose's `autoIndex` on, `verify()` first waits for that build; it needs an
  open or opening connection, else `RESIZE_MONGO_NOT_CONNECTED`), and
  without it every `add()` stores a task, duplicate active rows build up, and the
  unique index build then fails with E11000 until those rows are no longer active
  (completed, or dead and taken over or expired). Create the claim index
  `{ queue: 1, status: 1, availableAt: 1 }` before or together with the new
  workers, then drop the old lease index (`{ status: 1, createdAt: 1 }`, or
  `{ queue: 1, status: 1, createdAt: 1 }` from a pre-release build). Then drop the
  `{ fileId, pipeline, requestKey }` index when convenient: new rows never enter
  it. Backfilling `availableAt` is optional: rows without it still wait for the
  retry time or lease end stored in `leaseExpiresAt`. The worker runs on the
  framework CLI with `autoIndex` off, so it never builds the indexes: they must
  exist before the first worker starts.
- Regenerate the model shim, which now imports `…/framework/ResizeTaskModel.js`:
  delete `src/models/ResizeTask.ts` and re-run `npx resize-scaffold` (`--force`
  would also overwrite `src/resizer.ts` and `src/config/resize.ts`). An ejected or
  hand-written model must add the `resizer`, `queue`, `availableAt`, `active` and
  `cooldownUntil` fields, the claim index and the gate index;
  `resize-scaffold --check` and `resizer.verify()` report a model without the fields
  (and the queue logs it once, then queues nothing until it is fixed), and `resizer.verify()`
  a collection without the gate index. Neither creates indexes. It should also add
  `startedAt` and `finishedAt` (`{ type: Date }`): `ResizeTask` rows now record when the latest
  delivery started and when the task completed or was dead-lettered, for inspection only; without
  the two fields the times are dropped, and `--check` reports the model (statement 1).
- Move `queue.lockTtlMs` to the Resizer's `coordination` (the `coordination` section
  of `src/config/resize.ts`, or `new Resizer({ coordination })`): `lockTtlMs.failed` →
  `cooldownMs`, `lockTtlMs.dispatch` → `gateTtlMs`, drop `lockTtlMs.worker`. A
  `lockTtlMs` left in queue timing (a task queue's `timing`, or `queues.<name>.lockTtlMs`) fails
  with `RESIZE_CONFIG_REMOVED_KEY`. Both
  values default to 600000. `gateTtlMs` is not the old dispatch lock renamed: that
  was a short per-variant hold (60 s); `gateTtlMs` is how long the one gate lock of
  a media, pipeline and queue holds a QUEUED task before a worker starts it (the
  worker then holds it through the task), and it is used only beside a task queue
  without `gatesByTask` (SQS). Set it to your worst queue wait, not to the old
  dispatch value.
- A hand-written media schema that declares preview rows as strict sub-documents must declare
  `identity`, `origin` and `encodeSig` in them, each `{ type: String }` (the fragment already has
  them, with `bytes` and `createdAt`); `resizer.verify()` throws
  `RESIZE_MONGO_MEDIA_MODEL_OUTDATED` without them. Rows written earlier have no identity and are
  not migrated. A custom model-shaped `MongoMediaModel` needs `findById` and `findOneAndUpdate`
  (and optionally `castObject`), and must accept an update pipeline (statement 2). A
  `findOneAndUpdate` middleware on the media model runs once per preview write (and once for the
  dimension backfill) and receives a document with only `_id`, or `null` when the preview was
  already stored or the media is gone; it also sees the update pipeline of `replacePreviews`.
- A custom `MediaStore` must implement `replacePreviews(mediaId, identities, rows)`: in one
  atomic write per media, remove every stored row whose `identity` is in `identities` or belongs
  to one of `rows`, then store `rows`, and resolve with `{ stored, removed }` (`ReplacedPreviews`),
  `removed` being exactly what that write removed. `resizer.verify()` and worker start reject a
  store without it (`RESIZE_MEDIA_REPLACE_MISSING`), and a result other than two arrays is
  `RESIZE_MEDIA_REPLACE_RESULT_INVALID`. See the `MediaStore` contract in `README.md`.
  `MongoMediaStore` and `FrameworkMediaStore` have it.
- To remove a media's stored previews (after a pipeline's output changed, or before deleting the
  media), call `await resizer.invalidate({ media, pipeline? })` and delete the storage refs it
  returns with your own storage client: it removes this Resizer's rows that carry an `identity`
  (of one pipeline, or of all when `pipeline` is omitted), in one write, and never deletes files
  or queues. It takes no gate: a task running for that media can still store rows after it
  returns.
- Preview rows now record `bytes`, `createdAt`, `origin` and `encodeSig`, and a pipeline may set
  `version`, which is part of its rows' `encodeSig`. The read path does not check them yet
  (statement 6).
- The original is never served. Code that read `isOriginal`, or relied on
  `ctx.isOwner` / `ctx.isAdmin` to get the original from `resolve()`, must change:
  to give an owner the private original, call
  `storage.signedUrl(original.storageRef, ttlSeconds)`. For a pipeline without
  `variantSteps`, a small raster original now gets a normal preview at its own
  size, made by the worker.
- SVG originals are rendered in a child process, never as markup in a pipeline
  step (`beforeSteps` receive the rendered pixels, see
  [Changed in `0.3.0-rc.2`](#changed-in-030-rc2)): a host under Node's permission
  model needs `--allow-child-process`, and a bundle must keep `svgRasterChild.js`
  next to `svgRaster.js` (otherwise `RESIZE_SVG_RENDER_UNAVAILABLE`).
- Without the framework, call `mongoParts(connection, { mediaModel })` once per process and
  spread the same parts into every Resizer (each call makes its own task queue, with one timing
  for every name). The pre-release database part is split in two: `media` (the media store) and
  `locks` (the lock store), beside `tasks`; `locks` is needed only beside a task queue without
  `gatesByTask` (SQS). `new SqsTaskQueue()` accepts `queues` without `queueUrl` (at least one URL;
  `RESIZE_SQS_QUEUE_URL_REQUIRED` otherwise), and a call on a queue name without a URL is now
  `RESIZE_QUEUE_NOT_SERVED`.
- A custom `TaskQueue` must resolve `add()` with a `TaskAddResult` (`added`,
  `in-flight` or `unconfirmed`); see the `TaskQueue` contract in `README.md`. Its optional
  `servesQueue(queue)` returns `false` for a name it cannot carry (a call on it then queues
  nothing), and its optional `getTiming(queue)` gives one name's timing.
- Call `resizer.verify()` at boot. A task queue that cannot be used (no `locks`
  beside a queue without `gatesByTask`, invalid timing on a task queue passed in
  code, or an invalid `coordination`) no longer fails reads or uploads: `resolve()`
  serves stored previews and queues nothing, and only `verify()`, `prewarm()` and
  worker start report it. Invalid timing in a `queues` entry of `src/config/resize.ts` (or a
  malformed `queues` or `worker` section) is still a config error on first use for a Resizer that
  takes its task queue from the file; beside a task queue passed in code (and no `coordination` in
  code) the file is read only for `coordination`, and a broken file degrades as above.
- Deploy the API and the workers together, after the pending tasks have finished or
  been drained. Task rows from before the gate have no `active` field and are not
  gates, so during a rolling deploy a read can queue a second task for such a media.
  The next `add()` takes over a row that a worker from before the gate completed or
  dead-lettered (such a worker leaves it active and sets no cooldown). There are no dispatch or worker locks any more: the only lock is the
  gate lock of a task queue without `gatesByTask` (SQS), which lasts
  `coordination.gateTtlMs` until a worker extends it. An older SQS worker ignores
  the lock's owner, so the gate lock of a task it ran expires only after
  `gateTtlMs`. Lock rows that an older version wrote are never read again and expire
  by their TTL.
- Previews stored before preview identity included the Resizer and the pipeline
  have no `resizer` or `pipeline` field and count as the `default` Resizer's
  `default` pipeline. A named Resizer or pipeline generates its previews again, and a
  `default` read may serve an old preview that was rendered by another pipeline;
  remove such rows if that matters.
- Register every pipeline in `src/resizer.ts`, and deploy the worker before the API
  requests a new or renamed pipeline: an unregistered pipeline is never rendered.

## Changed in `0.3.0-rc.2`

- `beforeSteps` receive and return a `Raster`, for every source kind:
  `(raster, { media, source, scale, ctx }) => Raster`. `raster` is the decoded
  first frame (`{ data, info }`: raw 8-bit sRGB pixels, upright), and a step
  resolves with one frame. The image engine becomes replaceable, so host steps see
  pixels, not a library object. Wrap a Sharp step with the helpers from the main
  entry:

  ```ts
  import { rasterToSharp, sharpToRaster } from '@adaptivestone/framework-module-resize';

  beforeSteps: [async (buf) => sharp(buf).blur(5).toBuffer()], // before
  beforeSteps: [async (r) => sharpToRaster(rasterToSharp(r).blur(5))], // now
  ```

  An old step fails inside its own `sharp(buf)` call with Sharp's plain `Error`
  "Input file is missing" (retried, then dead-lettered; thrown as-is by eager
  `generate()`). A step that resolves with anything but a one-frame `Raster` (a
  `Buffer`, a Sharp instance) fails with `RESIZE_PIPELINE_STEP_INVALID`. For a
  raster source a step sees the upright original at its own size; for a vector
  source (SVG) the pixels can be larger, so multiply coordinates stored in the
  source's units by `meta.scale`.
- `variantSteps` keep their Sharp instance, now over each size's pixels:
  `metadata()` reports the preview (`format: 'raw'`, no EXIF, ICC profile, density
  or orientation; `hasAlpha` as the sized pixels have it), a step's `resize()`
  resizes the preview, and operations Sharp used to apply before its resize (such
  as `trim()`) now apply to the preview. Their raster form waits for a later
  release.
- With `animated: true`, an animation keeps its frames only for a pipeline with
  neither `beforeSteps` nor `variantSteps`; `beforeSteps` receive its first frame.
- With `beforeSteps`, a worker holds the decoded source as raw pixels plus a step's
  result, about 2 × width × height × 4 bytes (up to about 400 MB at the default
  `limits.sourcePixels`): size worker containers for it. Each size is held raw
  too, up to `concurrency` sizes at once. An animated size holds frames × size
  pixels × channels bytes, with the frames cut to fit
  `min(limits.sourcePixels, limits.inputPixels)` at the larger of the source's
  and the size's pixels.
- `limits.inputPixels` now guards only the bytes a decoder reads (one frame of an
  animation), not the pixels the module renders itself.
- A source that cannot be decoded fails the task (and `generate()`) with the
  decoder's error, or with the retryable `RESIZE_SOURCE_DECODE_FAILED`.
- New source kinds come as decoders: `new FrameworkResizer({ decoders })` (or
  `new Resizer({ decoders })`) takes `SourceDecoder` objects, asked before the
  built-in Sharp and SVG decoders; pass them in every process (API and worker),
  and add their formats to `upload.formats` (else `uploadOriginal()` throws
  `RESIZE_ORIGINAL_FORMAT_DISABLED`). See "Decoders" in `README.md`.
  `RESIZE_ORIGINAL_FORMAT_UNSUPPORTED` now means that no decoder reads the
  uploaded bytes.
