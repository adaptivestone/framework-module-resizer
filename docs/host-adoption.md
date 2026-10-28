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
- Media models must use `resizeMediaSchemaFragment` and update presence checks and
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

## Other changes a host must make for this version

`CHANGELOG.md` (`# 0.3.0`) has the details.

- Construct the Resizer with `new FrameworkResizer({ pipelines, hooks })` in
  `src/resizer.ts`, and move `storage` and `queue` into `src/config/resize.ts`
  (`queue: { driver: 'database' }` for background generation). Move
  `worker.concurrency` to the top-level `concurrency`.
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
  a collection without the gate index. Neither creates indexes.
- Move `queue.lockTtlMs` to the Resizer's `coordination` (a `coordination` section
  in the config file, or `new Resizer({ coordination })`): `lockTtlMs.failed` →
  `cooldownMs`, `lockTtlMs.dispatch` → `gateTtlMs`, drop `lockTtlMs.worker`. A
  `lockTtlMs` left in queue timing fails with `RESIZE_CONFIG_REMOVED_KEY`. Both
  values default to 600000. `gateTtlMs` is not the old dispatch lock renamed: that
  was a short per-variant hold (60 s); `gateTtlMs` is how long the one gate lock of
  a media, pipeline and queue holds a QUEUED task before a worker starts it (the
  worker then holds it through the task), and it is used only beside a task queue
  without `gatesByTask` (SQS). Set it to your worst queue wait, not to the old
  dispatch value.
- A hand-written media schema that declares preview rows as sub-documents must add
  `identity: { type: String }` to them (the fragment already has it);
  `resizer.verify()` throws `RESIZE_MONGO_MEDIA_MODEL_OUTDATED` without it. Rows
  written earlier have no identity and are not migrated. A custom model-shaped
  `MongoMediaModel` needs `findById` and `findOneAndUpdate`. A `findOneAndUpdate`
  middleware on the media model now runs once per preview write (and once for the
  dimension backfill) and receives a document with only `_id`, or `null` when the
  preview was already stored or the media is gone.
- The original is never served. Code that read `isOriginal`, or relied on
  `ctx.isOwner` / `ctx.isAdmin` to get the original from `resolve()`, must change:
  to give an owner the private original, call
  `storage.signedUrl(original.storageRef, ttlSeconds)`. For a pipeline without
  `variantSteps`, a small raster original now gets a normal preview at its own
  size, made by the worker.
- SVG `beforeSteps` now receive the rendered PNG, not SVG markup. The render runs
  in a child process: a host under Node's permission model needs
  `--allow-child-process`, and a bundle must keep `svgRasterChild.js` next to
  `svgRaster.js` (otherwise `RESIZE_SVG_RENDER_UNAVAILABLE`).
- Resizers on the database queue (and Resizers with identical SQS settings) share
  one task queue with one timing: config files that share a queue must set the same
  timing keys (and effective SQS `waitTimeSeconds`), or first use, `verify()` and
  worker start fail with `RESIZE_CONFIG_QUEUE_TIMING_CONFLICT`. Without the framework, call
  `mongoParts(connection, { mediaModel })` once per process and spread the same parts
  into every Resizer (each call makes its own task queue). The pre-release database
  part is split in two: `media` (the media store) and `locks` (the lock store), beside
  `tasks`; `locks` is needed only beside a task queue without `gatesByTask` (SQS).
- A custom `TaskQueue` must resolve `add()` with a `TaskAddResult` (`added`,
  `in-flight` or `unconfirmed`); see the `TaskQueue` contract in `README.md`.
- Call `resizer.verify()` at boot. A task queue that cannot be used (no `locks`
  beside a queue without `gatesByTask`, invalid timing on a task queue passed in
  code, or an invalid `coordination`) no longer fails reads or uploads: `resolve()`
  serves stored previews and queues nothing, and only `verify()`, `prewarm()` and
  worker start report it. Invalid timing in a framework config file is still a
  config error on first use.
- Deploy the API and the workers together, after the pending tasks have finished or
  been drained. Task rows from before the gate have no `active` field and are not
  gates, so during a rolling deploy a read can queue a second task for such a media.
  The next `add()` takes over a row that a worker from before the gate completed or
  dead-lettered. There are no dispatch or worker locks any more: the only lock is the
  gate lock of a task queue without `gatesByTask` (SQS), which lasts
  `coordination.gateTtlMs` until a worker extends it. An older SQS worker ignores
  the lock's owner, so the gate lock of a task it ran expires only after
  `gateTtlMs`. Lock rows that an older version wrote are never read again and expire
  by their TTL.
- A host whose Resizers read only named config files (no `resize.ts`) starts the
  worker with `npm run cli ResizeWorker -- --config=<name>`.
- Previews stored before preview identity included the Resizer and the pipeline
  have no `resizer` or `pipeline` field and count as the `default` Resizer's
  `default` pipeline. A named Resizer or pipeline generates its previews again, and a
  `default` read may serve an old preview that was rendered by another pipeline;
  remove such rows if that matters.
- Register every pipeline in `src/resizer.ts`, and deploy the worker before the API
  requests a new or renamed pipeline: an unregistered pipeline is never rendered.
