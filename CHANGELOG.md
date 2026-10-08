# 0.3.0

**Breaking changes**

- Persisted locators are nested, driver-owned refs: `original.storageRef` and
  `previews[].storageRef` replace the flat `key`/`bucket` fields, and `StorageRef` is now an
  opaque JSON value. No reader or migration for old resize records is included; update host
  models, DTOs, custom storage drivers and the API/worker processes together. Keep
  `minimize: false` on the media schema so empty objects inside refs survive persistence.
- `ResizeStorage.upload()` receives optional `namespace` (a placement hint from
  `uploadOriginal({ namespace })`) and `parentRef` (the original's ref when the worker stores
  previews).
- Private originals need separate storage: `S3Storage` rejects a private upload unless
  `bucketPrivate` differs from `bucketPublic`; `LocalFsStorage` keeps private files under
  `privateRootDir` (default `<rootDir>-private`).
- SVG is an input format only. `uploadOriginal()` stores SVG privately and rejects public SVG
  uploads. The worker renders an SVG once per task, before any pipeline step, into a PNG, in a
  separate Node process, at the largest size the requested previews need; `beforeSteps` receive
  that PNG, never SVG markup, and every format is made from it. The render is killed after
  `limits.processingTimeoutSeconds` (`ResizeMediaError` `RESIZE_SVG_RENDER_TIMEOUT`, the task is
  dead-lettered at once) or when the task is aborted; a render process that crashes or produces no
  image is `RESIZE_SVG_RENDER_FAILED` (retried). A render that cannot start is `ResizeSetupError`
  `RESIZE_SVG_RENDER_UNAVAILABLE`: the host must allow child processes (`--allow-child-process`
  under Node's permission model) and ship `svgRasterChild.js` next to `svgRaster.js` (bundles).
  Eager `generate()` throws all three.
  SVG dimensions that cannot retain a pixel on each raster side within the renderer's side
  limit (for example, `1×100000`) are rejected before storage with `ResizeOriginalError`
  `RESIZE_SVG_DIMENSIONS_UNSUPPORTED`. Already stored sources fail with `ResizeMediaError`
  carrying the same code and are dead-lettered on their first delivery.
- The original is never served. `resolve()` no longer serves an original that fits the requested
  box: `decision.ready` holds stored previews only, every `ReadyEntry` has `preview` and
  `contentType`, and `isOriginal` is gone. For a pipeline without `variantSteps`, a raster
  original no larger than the requested width and height gets a normal preview at its own size
  (no upscaling, no cropping, no sharpening, metadata such as EXIF and GPS removed; one larger than
  `limits.resultDimension` is scaled down inside the cap) in every requested format; before, it
  was served as it was or upscaled and cropped to the box. A pipeline with `variantSteps` still
  gets the full requested box, the size its steps were written for. `ctx.isOwner` /
  `ctx.isAdmin` no longer change what `resolve()` returns (hooks still receive `ctx`).
  `canServeOriginalPublicly` is removed from `ResizeStorage` and both shipped drivers; the module
  never calls `signedUrl`: to give an owner the private original, call
  `storage.signedUrl(original.storageRef, ttlSeconds)` yourself.
- The module no longer merges host config over its defaults and drops the `deepmerge`
  dependency. The framework's `resize.ts` + `resize.<NODE_ENV>.ts` merge is the only merge: the
  host `src/config/resize.ts` spreads `defaultFrameworkResizeConfig` from
  `@adaptivestone/framework-module-resize/config/resize.js`, and the final value must be complete.
  It is validated when the Resizer first reads it (a plain config object: at construction), or by
  `resizer.verify()`.
- Config keys moved. The old keys now fail validation with `RESIZE_CONFIG_REMOVED_KEY` instead of
  being ignored:

  | 0.2.x | 0.3.0 |
  |---|---|
  | `webpAvifOnly: true` | `formats: ['webp', 'avif']` |
  | `encode.quality.<format>` | `encode.formats.<format>.quality` |
  | `encode.effort.<format>` | `encode.formats.<format>.effort` |
  | `encode.mozjpeg`, `encode.chromaSubsampling` | `encode.formats.jpeg.mozjpeg`, `encode.formats.jpeg.chromaSubsampling` |
  | `encode.flattenBackground` | `encode.flatten.background` (formats in `encode.flatten.formats`) |

- Format ids are open strings passed to `sharp.toFormat(id, encode.formats[id])`. Every `formats`
  entry needs an `encode.formats` entry (`{}` keeps Sharp defaults), so an alias such as `'jpg'`
  fails at boot instead of skipping the `'jpeg'` options and flatten step.
- `mediaModelName` must name a registered model. The worker checks it at startup, and
  `FrameworkDatabase` throws `ResizeConfigError` (`RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN`) instead of
  completing every task as a deleted-media no-op.
- Worker setup uses an explicit `worker.enabled: true` in host config instead of an
  environment-variable convention. Updated the scaffold example, guidance, and disabled-worker
  message; the module default remains `false`.
- Several named Resizers can live in one process. `new Resizer({ name })` registers under its
  name (default `'default'`), a duplicate name throws `RESIZE_DUPLICATE_RESIZER`, and
  `getResizer(name?)` looks one up. Each Resizer has its own `config`, `logger` and `events`; the
  framework adapter fills them from the app, read on first use.
- Drivers are three contracts, exported as abstract classes: a custom driver `extends` one, or is
  any object of the same shape. The 0.2 media store, lock provider and queue transport are gone.
  - `ResizeStorage` (files): `upload`, `download`, `publicUrl`, optional `signedUrl`.
  - `ResizeDatabase` (records): `loadMedia`, `appendPreviews`, `acquireLock`, `releaseLock`, and
    optionally `tasks` (its own queue) and `verify()`. `appendPreviews` stores a preview only when
    its `identity` is not stored yet and resolves with the previews it stored.
  - `TaskQueue` (queued tasks): atomic `add`, `claim`, `renew`, `complete` and `fail`, and
    optionally `findActive`, `servesQueue`, `getTiming` and `verify`.
- The core owns the queue logic. Its worker loop (run by `runWorker`) handles
  leases and the heartbeat, the task timeout, retry with backoff, dead-lettering (after
  `maxAttempts`, or at once for a media without an original), the request de-duplication key and the
  `completed` / `failed` / `deadLettered` events, identically for every queue. Tasks carry their
  `resizer` and `queue`; events go to the owning Resizer's observers. An idle worker polls every
  `idlePollMs`, counted from the start of the claim, so a long-polling claim (SQS) is not followed
  by an extra sleep; claim errors back off (doubling up to 10× `idlePollMs`, reset by the next
  successful claim). `claim` may wait for a task, which is how a driver can deliver tasks by
  notification without a contract change.
- `new Resizer({ storage, db, tasks?, queue? })`. `db` is required (`RESIZE_DATABASE_REQUIRED`);
  `tasks` enables queued work (prewarm, lazy reads, the worker). Locks come from the database, with
  the worker-lock TTL of the queue that delivered the task. `config` is optional (the package
  defaults) and may be a function read on first use; `logger` defaults to `console`; the core never
  reads a framework app.
- Shipped drivers are grouped by backend, and framework pieces live only in the adapter:

  | 0.2.x | Now |
  |---|---|
  | `…/storage/fs.js`, `…/storage/s3.js` | `…/drivers/fs.js`, `…/drivers/s3.js` (`LocalFsStorage`, `S3Storage`) |
  | `…/transports/mongo.js` + the framework media store and lock provider | `…/drivers/mongo.js`: `mongoDatabase(connection, { mediaModel, timing? })`, `MongoDatabase`, `MongoTaskQueue`, `createResizeModels` |
  | `…/transports/sqs.js` | `…/drivers/sqs.js`: `SqsTaskQueue` |
  | `…/mediaStore/framework.js`, `…/locks/framework.js`, `…/models/ResizeTask.js`, `…/commands/ResizeWorker.js` | `…/framework.js`: `FrameworkDatabase`, `ResizeTaskModel`, `ResizeWorker` |

  - `mongoDatabase` registers the package's `ResizeTask` and `ResizeLock` models with `autoIndex`
    off; create their indexes through your migration.
  - `SqsTaskQueue` uses plain SQS calls (ReceiveMessage, ChangeMessageVisibility, DeleteMessage,
    SendMessage), so `sqs-consumer` is no longer a peer. Retries are the core's, a dead task goes
    to `deadLetterQueueUrl` (when set) and `onTaskDeadLettered` fires for SQS too.
  - Re-run `resize-scaffold` after deleting the old model and command shims.
- The Mongo `requestKey` is now `v2` and covers the Resizer name and the queue. `ResizeTask` gains
  `resizer`, `queue` and `availableAt` (when the task may next be claimed) fields. Rows without
  `resizer`/`queue` read as `'default'`. Rows without `availableAt` (written before it existed,
  or by an older worker during a rolling deploy) still wait for the retry time or lease end in
  their `leaseExpiresAt`; a backfill is optional.
- The claim index `{ queue: 1, status: 1, availableAt: 1 }` replaces `{ status: 1, createdAt: 1 }`
  (and the pre-release `{ queue: 1, status: 1, createdAt: 1 }`), and workers claim the task that
  became due first. Create it through your migration before or
  together with the new workers, then drop the old index.
- The worker runs each task with the Resizer named in it; an unknown name rejects with
  `RESIZE_NO_RESIZER` (the task retries, then dead-letters).
- Preview identity includes the Resizer and pipeline: `resizer:pipeline:sizeKey:format:filterSig`.
  Generated preview rows store `resizer` and `pipeline` (rows without them belong to `default`), so
  different pipelines and Resizers keep separate previews of the same media instead of sharing
  whichever was generated first. Dispatch and worker lock keys change accordingly.
  `isCatalogCovered` takes an optional scope. The "use distinct filters per pipeline" workaround is
  no longer needed.
- One preview row per identity. Every new preview row has an `identity` string, and
  `resizeMediaSchemaFragment` includes `previews[].identity`; the database stores a preview only
  when its identity is not stored yet. A preview that another worker stored first is logged as a
  warning with its storage ref and does not count as created. A hand-written media schema that
  declares preview rows as sub-documents must add `identity: { type: String }` to them:
  `MongoDatabase.verify()` (so `resizer.verify()` and worker start) throws `ResizeSetupError`
  `RESIZE_MONGO_MEDIA_MODEL_OUTDATED` without it (a mixed or plain `previews` array passes). Rows
  written earlier have no identity and are not migrated.
- `MongoDatabase` writes previews and the backfilled dimensions with `findOneAndUpdate`, one write
  per preview plus one for the backfill, so a `findOneAndUpdate` middleware on the media model runs
  for each; the document it receives has only `_id`, and is `null` when the preview was already
  stored or the media is gone. A model-shaped `MongoMediaModel` needs `findById` and
  `findOneAndUpdate` (no longer `findByIdAndUpdate`).
- The framework is an adapter. The main entry imports no framework code; framework wiring lives in
  `@adaptivestone/framework-module-resize/framework.js`. `new FrameworkResizer({ pipelines, hooks
  })` (a `Resizer` subclass) builds every part from the config file on first use: the image
  settings, `storage`, the task queue, `FrameworkDatabase` (the app's media model, the framework
  `Lock` model, and the scaffolded `ResizeTask` model as its queue), and the app logger and
  events. Options win over the config (`storage`, `db`, `tasks` — a `TaskQueue` or `false` —,
  `config`, `configName`, `logger`, `events`). The main entry no longer exports `ResizeWorker`,
  `ResizeTaskModel`, `runResizeWorker` or the `TResizeTask` type.
- A smaller public surface. The main entry no longer exports `calculateResizedDimensions`,
  `getFilterSig`, `getImageContentType`, `getPreviewIdentity`, `processTask`, `getResizeConfig`,
  `defaultResizeConfig` (use the default export of `…/config/resize.js`) or `requiredFormats`.
  `runWorker` is the worker entry. `…/framework.js` exports `FrameworkResizer`,
  `FrameworkDatabase`, `ResizeTaskModel`, `ResizeWorker`, `runResizeWorker` and the config types.
- The scaffolded `src/resizer.ts` holds behaviour only (`new FrameworkResizer({ pipelines })`);
  storage and the queue live in `src/config/resize.ts`. `--eager` emits the same construction site
  with a config without `queue`.
- The core config holds image settings only. `ResizeConfig` loses `queue` and `worker` (a core
  config containing them fails with `RESIZE_CONFIG_REMOVED_KEY`), and `worker.concurrency` becomes
  the top-level `concurrency`. Queue timing and lock TTLs belong to the task queue (`timing`); the
  core validates them, including worker lock ≤ lease (`RESIZE_CONFIG_LOCK_EXCEEDS_LEASE`), on first
  use, in `verify()` and at worker start. Sharp process tuning is `runWorker({ sharp })`.
- Framework config files hold `mediaModelName`, `storage`, `queue` and `worker` and spread
  `defaultFrameworkResizeConfig` (from `…/config/resize.js`, which also exports
  `defaultQueueOptions` and `defaultWorkerOptions`).
  - `storage`: `{ driver: 'local', … }` or `{ driver: 's3', … }` (S3 imported only when selected;
    `RESIZE_CONFIG_STORAGE_MISSING` when neither the config nor the code gives one).
  - `queue`: `{ driver: 'database' }` or `{ driver: 'sqs', queueUrl, … }` with any timing keys (the
    rest default). Missing or `false` means eager only; `defaultFrameworkResizeConfig` no longer
    contains `queue`, so add `queue: { driver: 'database' }` for background generation.
  `ResizeConfig` no longer contains `mediaModelName`; `FrameworkResizeConfig` does.
- `prewarm()` reports every requested variant: `{ status, ready, accepted, notRequired,
  unconfirmed, tasks, issues }` (`PrewarmResult`), instead of an `{ enqueued }` count, and still
  never throws (an internal error is `incomplete` with a `RESIZE_ENQUEUE_INTERNAL_ERROR` issue that
  lists the variants requested so far). A
  held lock is not treated as a task receipt: a task queue with the optional
  `TaskQueue.findActive()` (the Mongo queue) proves exact canonical active-payload coverage, while
  one without it (SQS) reports lock races as retryable `incomplete`. Conflicting payloads with one preview identity are explicit
  errors. Issues describe only the variants that remain unconfirmed. There is no separate strict
  method: the pre-release `enqueueRequired()` is merged into `prewarm()`.
- An unregistered pipeline name (anything but `'default'`, which always exists) is no longer
  rendered as an empty pipeline. `resolve()` logs an error, serves only previews already stored
  for that pipeline, reports nothing missing and queues nothing; `prewarm()` returns `incomplete`
  with one non-retryable `RESIZE_PIPELINE_UNKNOWN` issue; `generate()` and the worker throw
  `ResizeSetupError` (`RESIZE_PIPELINE_UNKNOWN`), so a queued task retries, then dead-letters.
  Register a new or renamed pipeline in the worker process before the API requests it (deploy
  workers first). New: `resizer.hasPipeline(name)`.
- Per-call `formats`, and the variants a `beforeEnqueue` tap adds or rewrites, must use keys of
  `encode.formats`. `resolve()` leaves the others out of `decision.missing` and logs an error,
  `prewarm()` reports them in `unconfirmed` with the non-retryable issue
  `RESIZE_FORMAT_NOT_CONFIGURED`, and `generate()` throws `ResizeSetupError`
  (`RESIZE_FORMAT_NOT_CONFIGURED`) before any hook runs.
- `RESIZE_SOURCE_TOO_LARGE` and `RESIZE_SOURCE_METADATA_MISSING` dead-letter a task on the first
  failure, like `RESIZE_NO_ORIGINAL`: no retry can fix them.
- `worker.concurrency` in a framework config file fails with `RESIZE_CONFIG_REMOVED_KEY`; move it to
  the top-level `concurrency`.
- The scaffolded `src/models/ResizeTask.ts` imports the new
  `@adaptivestone/framework-module-resize/framework/ResizeTaskModel.js` export (the model class as
  its default export), which lets the framework's `npm run gen` type `getModel('ResizeTask')`.
  `resize-scaffold --check` reports a shim that still imports `…/framework.js` as drift: delete
  `src/models/ResizeTask.ts` and re-run `npx resize-scaffold` (`--force` would also overwrite
  `src/resizer.ts` and `src/config/resize.ts`).
- An ejected or hand-written `ResizeTask` model must declare the `resizer`, `queue`, `requestKey`
  and `availableAt` fields (and the `{ queue, status, availableAt }` index); Mongoose would drop
  undeclared fields, filing every task under Resizer and queue `'default'` and losing retry
  times. `resize-scaffold --check` reports such a model, and `MongoTaskQueue.verify()` (so
  `resizer.verify()` and worker start) throws `ResizeSetupError` `RESIZE_MONGO_MODEL_OUTDATED`.
- One task queue per backend in a framework app: every `FrameworkResizer` and `FrameworkDatabase`
  on the database queue shares one task queue, and so do Resizers whose config selects SQS with
  the same settings. The worker runs one loop per queue, one task at a time, each task processed
  with its own Resizer. Timing belongs to the queue: config files that share one and set different
  timing (for SQS also an effective `waitTimeSeconds`; unset counts as the default 10) fail on
  first use, in `verify()` and at worker start
  with `ResizeConfigError` `RESIZE_CONFIG_QUEUE_TIMING_CONFLICT`, naming both files and the keys.
  Without the framework, each `mongoDatabase()` call makes its own queue: pass one database's
  `tasks` to every Resizer.
- The default JPEG quality is 88 (was 80).
- A task's `leasedBy` is `<hostname>:<pid>` instead of `resizer-<pid>`, so pods with the same pid
  are told apart.

**Features**

- The framework is optional. `@adaptivestone/framework` and `mongoose` are optional peers, so
  npm no longer installs them into a plain Node app; the core needs only `sharp`. A plain Node app
  with MongoDB writes no driver code: `mongoDatabase(connection, { mediaModel })` gives the media,
  locks and task queue, and the core `runWorker({ queue, signal, logger, sharp })` runs the worker.
- Each framework Resizer can read its own config file:
  `new FrameworkResizer({ name: 'listings', configName: 'resizeListings' })`.
- Per-environment drivers: `resize.production.ts` can switch storage to S3 or the queue to SQS
  without code changes.
- Lazy drivers: `storage`, `db` and `tasks` may be functions (sync or async), called once on first
  use. `resizer.ready()` loads them; every Resizer method and the worker await it, and `resolve()`
  / `prewarm()` keep their never-throw guarantee when loading fails. When one part fails to load,
  the next call retries only that part. Reading `resizer.storage` / `db` / `tasks` before then
  throws `RESIZE_NOT_READY`.
- Named queues. A Resizer has a default `queue` (default `'default'`), and `resolve()` and
  `prewarm()` accept a per-call `queue`. `npm run cli ResizeWorker -- --queue=<name>` consumes
  only that queue; without the flag it consumes `'default'`. `SqsTaskQueue` maps queue names to
  URLs with the `queues` option (`RESIZE_SQS_QUEUE_UNKNOWN` for an unknown name).
- One worker process serves every Resizer constructed in it, routing each task to the Resizer
  named in it. It runs one loop per distinct task queue that serves the queue (a queue whose
  `servesQueue()` says no is skipped; `RESIZE_QUEUE_NOT_SERVED` when none does; if one loop fails,
  the others stop and the worker rejects with that error), and every Resizer's `verify()` runs
  before claiming.
- The framework adapter reads the app lazily: config, models, logger and events are read on first
  use, so `src/resizer.ts` can be imported statically anywhere, even before `Server.init()`. The new
  `resizer.verify()` checks at boot what would otherwise only be logged per call: the config, the
  database (`RESIZE_MONGO_MODEL_MISSING` / `RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN` when a model does not
  resolve) and the task queue (its `verify()`, its timing, and that it serves the Resizer's
  queue).
- `resizer.uploadOriginal({ body, visibility, namespace? })` stores the original bytes unchanged
  and returns typed metadata. Format and dimensions come from `sharp().metadata()`; new
  `upload.maxBytes`, `upload.formats` and `limits.processingTimeoutSeconds` bound accepted inputs.
- The Mongo task queue deduplicates identical active requests with a canonical SHA-256
  `requestKey` and a partial unique index on `{ fileId, pipeline, requestKey }`. The module does not
  create indexes; prepare them through the host's migration or lifecycle before rollout.
- Queued raster tasks retry only the identities still missing after partial generation.
  Successful previews stay persisted, and permanent gaps use the normal backoff and dead-letter
  path. Deleted media tasks remain successful no-ops; previews uploaded for media deleted during
  the task are logged as a warning that the media no longer exists.
- `ResizeDatabase` and `TaskQueue` have an optional `verify()` startup check. `Resizer.verify()`
  and the worker await them once before claiming tasks, so custom drivers can fail fast too;
  `MongoDatabase.verify()` checks the media model (including `previews.identity`) and the lock
  model, and `FrameworkDatabase.verify()`
  checks that `mediaModelName` names a registered model and that the framework `Lock` model exists.
- Worker shutdown gives the stopped task back. The variants in progress finish and are saved, and
  the task returns to the queue with no `onTaskFailed` / `onTaskDeadLettered` event and no
  backoff, through the new optional `TaskQueue.release(task)`; a terminal media error
  (`RESIZE_NO_ORIGINAL`, `RESIZE_SOURCE_METADATA_MISSING`, `RESIZE_SOURCE_TOO_LARGE`) is still
  dead-lettered with its event. `MongoTaskQueue` does not count the attempt; `SqsTaskQueue` makes
  the message visible again but still counts the delivery (SQS counts receives); a custom queue
  without `release` is retried at once through `fail`, which also counts.
- `npm run cli ResizeWorker -- --config=<name>` picks the config file whose `worker` section (the
  `enabled` switch and Sharp tuning) the worker process uses; default `resize`. A host with only
  named config files must pass it.
- A driver selected in a framework config file whose optional AWS SDK peer is not installed fails
  at first use or in `verify()` with `ResizeSetupError` `RESIZE_PEER_MISSING`, naming the packages
  and the config file.
- New timing key `lockTtlMs.failed` (default 600000 ms): after a task is dead-lettered, the worker
  holds its variants' dispatch locks for this long, so `resolve()` and `prewarm()` do not queue
  the same failing work for that media again until it expires. An invalid value is
  `ResizeConfigError` `RESIZE_CONFIG_QUEUE_LOCK_TTL_INVALID`.

**Fixes**

- `npm run cli ResizeWorker` no longer starts with no Resizer. The scaffolded
  `src/commands/ResizeWorker.ts` was a bare re-export, so nothing built the host's Resizers in the
  CLI process. It is now `import '../resizer.ts'` plus a re-export of the module's command.
  `resize-scaffold --check` reports a command that does not import it as drift, and the framework
  worker rejects an empty registry with `RESIZE_NO_RESIZER` and that fix in the message. Hosts:
  delete `src/commands/ResizeWorker.ts` and re-run `npx resize-scaffold`.
- `LocalFsStorage` normalizes root paths before deriving the private root and rejects a
  `privateRootDir` equal to or inside the public root. A trailing slash no longer places private
  originals in the public folder.
- Coverage builds the package before integration tests. Source-only test runs skip the Framework
  config integration test with a build instruction when the compiled config is absent.
- Host adoption documentation uses a generic checklist without internal project names or paths.
- The resolved framework config is validated once instead of on every read, so the read path no
  longer re-runs full validation per `resolve()`.
- Optional peer ranges state what the code needs instead of `*`: `@adaptivestone/framework`
  `^5.1.0`, `mongoose` `^9.0.0`, and the AWS SDK clients `^3.572.0`. `SqsTaskQueue` reads attempt
  counts from `MessageSystemAttributeNames`, which older `@aws-sdk/client-sqs` versions silently
  drop: every delivery then counted as attempt 1, so a failing task was never dead-lettered. It
  now also warns once when SQS returns no `ApproximateReceiveCount`.
- `animated: true` works. WebP and GIF previews keep the animation, up to
  `limits.animationFrames` frames, for a pipeline without `variantSteps`; every other format, and
  every preview of a pipeline with variant steps (a watermark would land on one frame), gets the
  first frame instead of all frames stacked into one tall image. `actualWidth` / `actualHeight`
  are the size of one frame. `limits.sourcePixels` applies to one frame, and an animation with
  more frames than `limits.sourcePixels` or `limits.inputPixels` allow is shortened to the frames
  that fit instead of failing. An animation with an EXIF orientation is rendered from its first
  frame.
- No output side of a width-only or height-only size exceeds `limits.resultDimension`: when the
  side derived from the aspect ratio would, the image is cropped to the cap.
- Fractional size dimensions are rounded in the size key, the task and the stored preview; a
  dimension that rounds to 0 is ignored; a `fit` result is at least 1 px per side.
- An EXIF-rotated original is no longer re-encoded before resizing when the pipeline has no
  `beforeSteps` (no quality loss, faster). With `beforeSteps`, the steps still get upright pixels,
  re-encoded in the same format without visible loss.
- Very long or thin SVG originals render instead of failing at librsvg's size limit.
- When recording previews fails after their upload, the error log names the uploaded files that
  no stored row points to (and only those).
- A storage `publicUrl` that throws for one stored preview leaves out only that size and format;
  the rest of the read and the enqueue continue.
- `S3Storage.publicUrl` with `forcePathStyle: true` and no `endpoint` returns
  `https://s3.<region>.amazonaws.com/<bucket>/<key>` instead of a relative path, and China
  regions (`cn-…`) use the `amazonaws.com.cn` domain in both URL forms.
- `S3Storage` uploads `image/svg+xml` objects with `ContentDisposition: attachment`.
- Filters with an own `__proto__` key (as `JSON.parse` creates) keep their own preview identity.
- The dispatch locks of one read or pre-warm are acquired concurrently, not one after another.
- `package.json` points to the right repository (`adaptivestone/framework-module-resizer`).

**Internal**

- A new CI job, `min-versions`, runs the type check, build and tests on the oldest supported Node
  major (the newest 24.x release) with every peer at the lowest version its range allows.

# 0.2.1

**Fixes**

- `ResizeWorker` now exposes the `getMongoConnectionName` static required by the framework
  CLI without importing framework internals.
- Missing persisted originals raise `ResizeNoOriginalError`; Mongo tasks dead-letter this
  terminal condition immediately instead of retrying a download with no key.
- Resolve treats throwing original-visibility checks as private and continues enqueueing missing
  variants.
- Resolve preserves cached previews, missing variants, and URL formatting when a plain media
  record has `original: null`.
- Resolve and prewarm no longer enqueue variants when the media original has no storage key.
- Original visibility is explicit: public URLs are never fabricated for private S3 originals;
  authorized reads use signed URLs and local storage validates paths.
- Mongo enqueue canonicalizes variants and atomically deduplicates identical active requests
  with a partial unique index and SHA-256 request key, preserving schema validation on upserts.
  The key includes the pipeline and surviving catalog; dispatch locks and preview identities
  remain shared across pipelines. Legacy rows without a key remain valid.

# 0.2.0

**Breaking changes**

- `generate` now returns `{ created, failed }` instead of `{ previews }`. `created` is **only what
  this call made** — a second `generate` over the same catalog returns `{ created: [], failed: 0 }`
  because everything already exists. Treat an empty `created` as "nothing new was needed", never as
  failure. An SVG original is the same: pass-through, never rasterized.
- `generate` now throws instead of returning an ambiguous empty array: `ResizeNoOriginalError` when
  the media has no `original`, `ResizeGenerateError` when every requested variant failed. Some
  variants failing does not throw — `failed > 0` with the rest in `created`.
- `resolve`'s `output` is `undefined` when no `formatPublicUrls` hook is registered, or when every
  tap threw. It previously handed back the raw `{ ready, missing }` decision, which was easy to
  send to a frontend as if it were a DTO. Map `decision` yourself, or call `formatPictureUrls`.
- `enqueueMissing` now defaults to `false` when no `transport` is set (previously always `true`),
  so an eager-only host no longer enqueues-or-logs on every read.
- The `S3Storage` option `publicUrl` is renamed **`publicBaseUrl`**. The old name still works for
  one minor and is marked deprecated — it collided with the `publicUrl(ref)` method every storage
  driver implements, which silently broke anyone copying the option literal into a class.

**Features**

- New `LocalFsStorage` driver at `@adaptivestone/framework-module-resize/storage/fs.js` —
  `{ rootDir, publicBaseUrl }`, no optional peers. The default story for tests, CI and local
  development, and enough on its own for a complete eager-mode host.
- **Error hierarchy.** Every error the module throws now extends `ResizeError`, so one check
  separates a module rejection from a `sharp`/S3/mongo failure. Subclasses say what to do about it:
  `ResizeSetupError` (wiring is wrong), `ResizeConfigError` (crash at boot), `ResizeMediaError`
  (skip this record; `ResizeNoOriginalError` extends it), `ResizeGenerateError` (produced nothing),
  `ResizeStorageError` (transient; retry may help), `ResizeSecurityError` (refusal; never retry).
  Every instance carries a stable machine-readable `err.code` plus the usual `name` and `cause`.
- `ResizeError.isResizeError(err)` — prefer it over `instanceof` when the error may cross a package
  boundary. Two copies of this package in one `node_modules` tree produce two class identities, so
  `instanceof` silently returns `false`; the brand check does not.
- New `formatPictureUrls(decision, { id?, mediaType? })` — builds a generic `<picture>`-shaped map
  from a decision. A convenience, not a mandated DTO shape.
- New `isCatalogCovered(media, sizes, formats)` — true when every identity already exists (or the
  original is an SVG), so a host can skip a no-op `generate`/`prewarm`.
- New `resizeMediaPaths` — the `['original', 'previews'] as const` field list the module reads, for
  `.select()`. Append your own host fields.
- `resize-scaffold --eager` emits a filesystem-storage construction site and skips the queue files.

**Internal**

- Driver and `Resizer` internals moved from TypeScript `private` to real `#private` fields. These
  are engine-enforced rather than a compile-time convention, so a JS host can no longer read S3
  bucket configuration off the instance, and `console.log(storage)` cannot leak it. The emitted
  `.d.ts` collapses to `#private;` instead of naming the fields.
- The build specification (`spec/`, `BUILD-SPEC.md`, `BUILD-PLAN.md`, `ADOPTION-PLAN.md`) moved to
  `docs/history/` and is explicitly unmaintained. `README.md`, `AGENTS.md` and the docs site are
  the living documentation. Nothing under `docs/` has ever shipped to npm.
- Encode defaults were validated against the Kodak reference image set before release and left
  unchanged at `{ jpeg: 80, webp: 82, avif: 64 }`. At the sizes this module generates, raising
  AVIF to 90 cost +135% bytes for no difference visible at 1:1.
- Toolchain and dev dependencies refreshed (TypeScript 7.0.2; lockfile updates for mongoose, the
  AWS SDKs and the framework peer). **No consumer-facing dependency change** — `dependencies`,
  `peerDependencies`, `peerDependenciesMeta` and `engines` are identical to 0.1.0.

# 0.1.0

Initial release. Lazy, pre-warm and eager generation over one shared resize core; `previews[]`
persisted on the host media document; swappable transport / storage / media-store / lock-provider
seams injected in a single constructor literal; Mongo and SQS transports; S3 storage; named
per-media-type pipelines and typed cross-cutting hooks; `resize-scaffold` bin; `AGENTS.md` guide.
