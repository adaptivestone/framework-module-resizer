# 0.3.0

**Prereleases.** 0.3.0 ships as release candidates first, published with the npm tag `next`
(`npm i @adaptivestone/framework-module-resize@next`); `latest` stays on the last stable release.

- `0.3.0-rc.1`: the host-facing shapes of this release: the config (`queues`, `queue` as a name,
  the process-wide `worker` and `coordination`), the option and type names, the import paths, the
  preview fields and `invalidate`. Integrate against these.
- `0.3.0-rc.2`: the `beforeSteps` signature (a `Raster` in and a `Raster` out, with the helpers
  `rasterToSharp` and `sharpToRaster`), decoders (`SourceDecoder` and the `decoders` option) and
  their error codes (below).
- `0.3.0-rc.3`: new APIs a host may use, no required host change: `createResizer`, `fromConfig`
  and drivers by name, routing between backends, `carrierOf`, one worker for several queues,
  partial config files (see Changed behaviour for what a host may notice).
- `0.3.0-rc.4`: metrics (`ResizeMetrics`, `LogMetrics`, `NoopMetrics`, the `metrics` option) and
  the freshness check, which regenerates outdated previews (see Changed behaviour for the storage
  cost).
- `0.3.0-rc.5`: long-lived cache headers on S3 public objects, and hygiene (test types, doc
  guards); no host change.
- Later release candidates: internal changes that need no host change.

`variantSteps` keep their Sharp instance in `0.3.0-rc.2`, now over each size's pixels (operations
Sharp used to apply before its resize now apply to the preview). Their raster form waits for a
later release that puts the image engine behind a port.

**Breaking changes**

- **Named queues, defined once, in `src/config/resize.ts`.** A framework host's queues are one
  process-wide `queues` map: each entry is one queue name, with its driver and that queue's own
  timing. Each Resizer's config file names the queue its tasks go to with `queue`:

  ```ts
  // src/config/resize.ts
  queue: 'default', // a key of `queues`, or false for eager only
  queues: {
    default: { driver: 'database', maxAttempts: 5 }, // tasks in the app's ResizeTask model
    bulk: { driver: 'database', leaseMs: 300_000 }, // a second lane, with its own timing
  },
  ```

  - A database entry is `{ driver: 'database', …timing }` (`DatabaseQueueConfig`); an SQS entry is
    `{ driver: 'sqs', queueUrl, deadLetterQueueUrl?, waitTimeSeconds?, region?, endpoint?, …timing }`
    (`SqsQueueConfig`), one SQS queue per name. The timing keys are `leaseMs`, `retryBackoffMs`,
    `maxAttempts`, `idlePollMs` and `taskTimeoutMs`; the rest default.
  - `queue` is a name. Missing, it is `'default'` when `queues` has entries, and eager only when
    `queues` is missing or empty; `false` is eager only. A name that `queues` does not define (the
    implied `'default'` too) is `ResizeConfigError` `RESIZE_CONFIG_QUEUE_UNKNOWN`, a config error
    on first use and in `verify()` like the rest of the file.
  - Migration from the `queue: { … }` object (0.2.x and the 0.3.0 pre-release builds): move the
    object into `queues.default` of `src/config/resize.ts` and write `queue: 'default'`. An SQS
    object's `queues: { bulk: url }` becomes an entry of its own,
    `bulk: { driver: 'sqs', queueUrl: url }`, with the same `region`, `endpoint`,
    `deadLetterQueueUrl` and `waitTimeSeconds`. A second Resizer's file (`configName`) whose own
    `queue` object was on the same backend (both `database`, or the same SQS settings) drops it and
    keeps `queue: 'default'`: the Resizers share that queue, and no new worker is needed. Only a
    queue on a different backend, or one that should get its own timing, needs a name of its own in
    `queues` and `queue: '<that name>'`, and every new name needs a worker that consumes it:
    `npm run cli ResizeWorker -- --queue=<name>`, or, from `0.3.0-rc.3`, one worker for several
    names (`--queue=default --queue=<name>`). A `queue` object, in any file, is `RESIZE_CONFIG_REMOVED_KEY`
    with the new shape in the message, and so is `queues.<name>.queues` (give each SQS queue its own
    entry).
  - `RESIZE_CONFIG_INVALID` also covers a malformed `queues` map or entry (no `driver`, an SQS
    entry without `queueUrl`), two SQS entries with the same `queueUrl`, and a `queue` that is
    neither a name nor `false`.
- **`queues`, `worker` and `coordination` are process-wide**, read only from
  `src/config/resize.ts`: every Resizer of the process and the worker use them. In another config
  file, or in the `FrameworkResizer` `config` option, each is `RESIZE_CONFIG_INVALID` naming the
  key. A second Resizer's file (`configName`) holds only that Resizer's sections: its image
  settings, `mediaModelName`, `storage` and `queue`. `coordination` is one per process (it was one
  per file; `new FrameworkResizer({ coordination })` still sets one Resizer's), and every key of
  `worker` is optional: a missing one takes `defaultWorkerOptions`, and only a wrong type or an
  unknown key (a misspelled `sharpConcurency`, say) is `RESIZE_CONFIG_INVALID`. A `queues` entry
  set to `undefined` is not defined, so an environment file can remove a queue that way. Only
  `queue: false` in the Resizer's own file (with no `queueName` option), `tasks: false` in code, or
  a task queue and `coordination` both passed in code keep a Resizer from reading
  `src/config/resize.ts`; every other Resizer validates that whole file on first use, and a
  malformed `queues` or `worker` section there fails in one of two ways. A Resizer that takes its
  task queue from the file, or whose file sets no `queue` (it reads `queues` to learn whether it is
  eager only or on `'default'`), fails its first call and its `verify()`: `uploadOriginal()`,
  `generate()` and `invalidate()` throw the config error (e.g. `RESIZE_CONFIG_INVALID`), and
  `resolve()` and `prewarm()`, which never throw, return the empty decision and `incomplete`, so
  even stored previews are not served until the file is fixed. A Resizer with a task queue passed
  in code (and no `coordination` in code) reads the file only for `coordination`, so a broken file
  is the degraded mode of an invalid `coordination`: it is logged once, reads serve stored previews
  and queue nothing, `uploadOriginal()`, `generate()` and `invalidate()` work, and `verify()`,
  `prewarm()` and worker start report it.
- **`runResizeWorker({ configName })` is removed, together with the worker's `--config` flag.**
  The worker reads `worker` and `queues` from `src/config/resize.ts`; both are rejected with
  `RESIZE_CONFIG_REMOVED_KEY`. A host whose Resizers read only named files adds a
  `src/config/resize.ts` that holds only the process-wide sections, typed
  `satisfies Partial<FrameworkResizeConfig>` (it needs no `mediaModelName` while no Resizer reads
  it as its own file).
- **`queueName` replaces the `queue` option, and `resizer.queue` is gone.**
  `new Resizer({ queueName })` and `new FrameworkResizer({ queueName })` name the queue of the
  Resizer's tasks (default `'default'`; a FrameworkResizer without it reads its file's `queue`).
  The old `queue` option is `ResizeSetupError` `RESIZE_QUEUE_INVALID`
  (``resize: `queue` is now `queueName` ``), as is a name that is not a non-empty string. Read
  `resizer.queueName` instead of `resizer.queue`. A string `queueName` option is readable at once.
  A name from the config file (or a `queueName` given to `new Resizer` as a function) is known
  only after `await resizer.ready()` or the first call; before that, `resizer.queueName` throws
  `RESIZE_NOT_READY`. `resolve()` and `prewarm()` keep their per-call `queue`.
- **Config types.** Every config file writes `satisfies FrameworkResizeConfig`:
  `src/config/resize.ts` and each other Resizer's file. Two files write
  `satisfies Partial<FrameworkResizeConfig>` instead: an environment override
  (`resize.<NODE_ENV>.ts`), and a `resize.ts` that holds only the process-wide sections. The queue
  entry types are `QueueConfig`, `DatabaseQueueConfig` and `SqsQueueConfig`, from the main entry
  and re-exported by `…/framework.js`; `FrameworkQueueConfig`, `FrameworkDatabaseQueueConfig` and
  `FrameworkSqsQueueConfig` are removed. `FrameworkResizeConfig.worker` is
  `Partial<FrameworkWorkerConfig>`.
- **Two import moves.** `resizeMediaSchemaFragment` and `resizeMediaPaths` moved from the main
  entry to `…/drivers/mongo.js`, and `…/framework.js` re-exports them: framework hosts import them
  from `…/framework.js`. `defaultFrameworkResizeConfig` and `defaultWorkerOptions` moved from
  `…/config/resize.js` to `…/framework.js`; `…/config/resize.js` keeps only the framework-free core
  defaults (the default export, `defaultQueueOptions` and `defaultCoordination`).
- **`defaultFrameworkResizeConfig` holds the image settings only**, without `worker` and
  `coordination`, so any Resizer's file can spread it. A missing `worker` takes
  `defaultWorkerOptions`, and a missing `coordination` takes `defaultCoordination`. The commented
  template line `worker: { ...defaultFrameworkResizeConfig.worker, enabled: true }` no longer
  type-checks: write `worker: { enabled: true }`, or spread `defaultWorkerOptions`.
- **`MediaStore.replacePreviews(mediaId, identities, rows)` is required.** In one atomic write per
  media it removes every stored row whose `identity` is in `identities` or belongs to one of
  `rows`, then stores `rows`, and resolves with `{ stored, removed }` (`ReplacedPreviews`) as plain
  objects; a media that is gone gives `{ stored: [], removed: [] }`. A row without a stored
  `identity` is never removed. `resizer.verify()` and worker start reject a media store without it
  (`ResizeSetupError` `RESIZE_MEDIA_REPLACE_MISSING`), and so does `invalidate` when it has rows to
  remove; a result other than two arrays is `ResizeSetupError`
  `RESIZE_MEDIA_REPLACE_RESULT_INVALID`. `MongoMediaStore` and `FrameworkMediaStore` have it, so a
  host on the shipped stores changes nothing.
- **A custom model-shaped `MongoMediaModel` must accept an update pipeline.** `replacePreviews`
  calls `findOneAndUpdate` with an array update and
  `{ updatePipeline: true, returnDocument: 'before', lean: true, projection: { previews: 1 } }`,
  after casting the rows with the model's optional `castObject` (Mongoose's `Model.castObject`:
  strict rows lose the keys they do not declare, loose rows (`strict: false`) keep them;
  `storageRef` and `filters` are stored as given, cast or not; a value it cannot cast, such as
  `bytes: 'abc'`, rejects with Mongoose's `ValidationError` before anything is written). Without
  `castObject` the rows are written as given, minus their `undefined` top-level keys. A
  `findOneAndUpdate` middleware on the media model also sees that call, so it must accept an array
  update.
- **Strict media rows need `origin` and `encodeSig`.** A hand-written media schema that declares
  preview rows as strict sub-documents must declare `identity`, `origin` and `encodeSig` (each
  `{ type: String }`), or `MongoMediaStore.verify()` (so `resizer.verify()` and worker start)
  throws `ResizeSetupError` `RESIZE_MONGO_MEDIA_MODEL_OUTDATED` naming the missing fields. `bytes`
  and `createdAt` are informational and not checked. The current `resizeMediaSchemaFragment`
  declares all of them; a mixed or plain `previews` array, or rows with `strict: false`, pass.
- **A call on a queue that its task queue does not serve queues nothing.** That is an unknown
  queue name, or, from `0.3.0-rc.3`, a queue whose backend's optional SDK is not installed in that
  process (a queue on another available backend is routed, see Features; in `0.3.0-rc.1` and
  `0.3.0-rc.2` it was not served). Before any gate lock or `add()`, `prewarm()` reports
  every variant `unconfirmed` with the issue `RESIZE_QUEUE_NOT_SERVED` (`retryable: false`), and
  `resolve()` logs a warning once per queue name. On SQS this replaces the logged
  `RESIZE_SQS_QUEUE_UNKNOWN` and the issue `RESIZE_ENQUEUE_QUEUE_FAILED` for a queue name without a
  URL; `SqsTaskQueue` still throws `RESIZE_SQS_QUEUE_UNKNOWN` to a direct caller. A Resizer's own
  `queueName` that its task queue does not serve is still caught by `verify()` and, when the
  worker consumes that queue, by worker start (`RESIZE_QUEUE_NOT_SERVED`).
- **`SqsTaskQueue` `queueUrl` is optional beside `queues`.** `queues` may name `'default'` too,
  and a queue that serves only other names needs no `queueUrl`;
  `RESIZE_SQS_QUEUE_URL_REQUIRED` now means that neither `queueUrl` nor a `queues` entry gives a
  URL. It serves only the names with a URL (`servesQueue`).
- **`resize-scaffold --check` reports drift right after the upgrade.** It does so for every
  `src/config/resize.ts`, and every `resize.<NODE_ENV>.ts` override of it, scaffolded by an earlier
  version (one with a top-level `queue: { … }` object, or that imports
  `defaultFrameworkResizeConfig` from `…/config/resize.js`; only full-line `//` comments are
  skipped, a `queue` entry inside `queues` is not drift, and a second Resizer's `configName` file
  is not checked), and for every ejected `ResizeTask` model (one without `startedAt` and
  `finishedAt`). This is intended. To clear it, rewrite the config to the new shape (or move it
  aside, re-run `npx resize-scaffold` and copy your settings back), and add
  `startedAt: { type: Date }` and `finishedAt: { type: Date }` to an ejected model (or
  move `src/models/ResizeTask.ts` aside (or delete it), re-run `npx resize-scaffold --eject`, then
  restore your customizations; the scaffold never overwrites a file, so re-running `--eject` alone
  changes nothing). The config file is still never diffed. An ejected model without the two times
  keeps working: they are dropped, and `RESIZE_MONGO_MODEL_OUTDATED` does not list them.
- **Old preview rows.** Rows written before `0.3.0-rc.1` have no `origin` or `encodeSig`, so the
  freshness check (`0.3.0-rc.4`) finds them stale: each is served until its replacement is stored,
  regenerated on its next read, `prewarm()` or `generate()`, and its old file stays in storage, so
  plan the storage cost and the cleanup (see Changed behaviour). Rows without an `identity`
  (written before 0.3.0) are never removed by `invalidate` or `replacePreviews`: the host deletes
  their files itself.
- **`beforeSteps` take and return a `Raster`.** `BeforeStep` is now
  `(raster, { media, source, scale, ctx }) => Raster` (or a promise of one), for every source
  kind: `raster` is the decoded first frame (`{ data, info }`: raw 8-bit sRGB pixels, upright), and
  the step resolves with one frame. The image engine becomes replaceable, so host steps see pixels,
  not a library object. `source` is the decoder's `SourceInfo`, and `scale` is the width of the
  raster the step receives divided by `source.width`: for a raster source the step sees the upright
  original at its own size; for a vector source (SVG) the pixels can be larger, so multiply
  coordinates stored in the source's units by it. Migration, with both helpers imported from the
  main entry:

  ```ts
  beforeSteps: [async (buf) => sharp(buf).blur(5).toBuffer()], // before
  beforeSteps: [async (r) => sharpToRaster(rasterToSharp(r).blur(5))], // now
  ```

  An old step fails inside its own `sharp(buf)` call, because Sharp reads the `Raster` object as
  options: it rejects with Sharp's plain `Error` "Input file is missing" (retried, then
  dead-lettered; thrown as-is by eager `generate()`), not with `RESIZE_PIPELINE_STEP_INVALID`,
  which a step gets when it resolves with something that is not a one-frame `Raster` (a `Buffer`,
  a Sharp instance, a raster whose `data` length does not match its `info`).
- **`variantSteps` receive the sized pixels.** They keep their Sharp instance, now over the raw
  pixels of the preview's exact size: `metadata()` reports the preview (with `format: 'raw'`, no
  EXIF, ICC profile, density or orientation, and `hasAlpha` as the sized pixels have it), a step's
  `resize()` resizes the preview, and operations Sharp used to apply before its resize (such as
  `trim()`) now apply to the preview.
- **Animation needs a pipeline without `beforeSteps`.** With `animated: true`, WebP and GIF
  previews keep an animation's frames only for a pipeline with neither `beforeSteps` nor
  `variantSteps`; `beforeSteps` receive the first frame, and every preview of their pipeline is a
  still image.
- **A decode failure fails the task.** A source that cannot be decoded fails the task, or
  `generate()`, with the decoder's error when it is a `ResizeError`, and otherwise (Sharp's own
  error, for example) with the retryable `ResizeMediaError` `RESIZE_SOURCE_DECODE_FAILED`, the
  original error as its `cause`.
- **The worker reads `original.format`** to pick the decoder to try first. A format that no
  decoder lists, or one whose decoder refuses the bytes, is logged as a warning
  (`resize worker: media <id> is stored as '<stored>' but its bytes are '<format>' (<why>);
  rendering it as '<format>'`; when a host decoder lists the stored format, refuses the bytes and
  a later decoder reads them as that format, `… the first decoder listing '<stored>' refused these
  bytes, and another decoder read them`) and the bytes are probed through the other decoders, so a
  record with an alias (`jpg`) or a MIME type still renders. A format whose decoder reads the bytes
  as another of its formats (JPEG bytes stored as `png`) is logged with the same warning and
  rendered by that decoder as what it is; no other decoder is asked. Store the decoder's id
  (`jpeg`, `png`, `svg`, …), as `uploadOriginal()` returns it.
- **`RESIZE_ORIGINAL_FORMAT_UNSUPPORTED` means "no decoder reads these bytes".** It meant "Sharp
  named no format". It fires when Sharp identifies a format that no decoder lists (a libvips build
  with extra loaders), or when every decoder refuses the bytes. Bytes Sharp cannot read at all
  stay `RESIZE_ORIGINAL_INVALID`.
- **Upload messages.** `uploadOriginal()` reports a refused or unmeasurable original with the
  decoder's message (`RESIZE_ORIGINAL_FORMAT_UNSUPPORTED`, `RESIZE_ORIGINAL_METADATA_MISSING`), and
  an SVG over `limits.sourcePixels` with the SVG decoder's message
  (`RESIZE_ORIGINAL_TOO_MANY_PIXELS`). An SVG whose size cannot be inspected is
  `RESIZE_ORIGINAL_INVALID` with the generic "bytes are not a supported image" message and the
  helper's error as its `cause`. The `RESIZE_SVG_DIMENSIONS_UNSUPPORTED` message starts with
  `resize:`. A stored SVG's `width` and `height` are its natural size rounded, at least 1. The
  `RESIZE_ORIGINAL_TOO_MANY_PIXELS` message for an EXIF-rotated original prints its display
  (upright) sides. The codes are unchanged.
- **Worker memory and rounding.** With `beforeSteps`, the worker decodes the source at least at
  its own size and holds it as raw pixels plus the step's result: about 2 × width × height × 4
  bytes, up to about 400 MB at the default `limits.sourcePixels`; the result is released once the
  sizes are made from it. Each size is held raw too, up to `concurrency` sizes at once, each up to
  `limits.resultDimension`² pixels. An animated size holds frames × size pixels × channels bytes,
  with the frames cut so that frames × the larger of the source's and the size's pixels stays
  within `min(limits.sourcePixels, limits.inputPixels)`. Size worker containers for
  `limits.sourcePixels`. Preview sizes are computed from
  the source's display dimensions and rounded once per side, so a preview side can differ by one
  pixel from what Sharp derived before.
- **Pixel limits.** Pixels the module renders itself are no longer limited by
  `limits.inputPixels`, which now guards only the bytes a decoder reads: a `variantSteps` box that
  enlarges a small source renders instead of failing Sharp's input limit. The Sharp decoder
  inspects the first frame of an animation, so the input limit applies to one frame (a stored
  animation whose stack exceeds `limits.inputPixels` renders its stills and the frames that fit);
  `uploadOriginal()` still rejects an original whose width × height × frames exceeds
  `limits.sourcePixels` (`RESIZE_ORIGINAL_TOO_MANY_PIXELS`). The animation stack is bounded by the
  pixel budget at the preview's size: a width-only size that enlarges an animation keeps fewer
  frames. A decoder's raster over `min(limits.sourcePixels, limits.inputPixels)` fails the task
  with `ResizeMediaError` `RESIZE_SOURCE_TOO_LARGE` (`retryable: false`). `sharpToRaster` checks
  the pixels it reads back and refuses stacked input frames, whatever size they are resized to
  (`RESIZE_PIPELINE_STEP_INVALID`), and so does `rasterToSharp` given a value that is not a
  `Raster`. The worker sets the media id on a decoder's own `ResizeMediaError` (or subclass), so
  the same object reaches the task and `generate()`; a frozen one is wrapped, with it as `cause`.
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
  uploads. The worker renders an SVG once per task, before any pipeline step, in a separate Node
  process, at the largest size the requested previews need (with `beforeSteps`, at least its
  natural size); `beforeSteps` receive the rendered pixels as a `Raster`, never SVG markup, and
  every format is made from them. The render is killed after
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
- The module drops the `deepmerge` dependency. From `0.3.0-rc.3` it merges the image settings
  over the package defaults itself (see "Partial framework config files" and `createResizer` under
  Features); `storage` and the other sections are read as the files hold them. The config is
  validated when the Resizer first reads it (a plain config object: at construction), or by
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
  `FrameworkMediaStore` throws `ResizeConfigError` (`RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN`) instead of
  completing every task as a deleted-media no-op.
- Worker setup uses an explicit `worker.enabled: true` in host config instead of an
  environment-variable convention. Updated the scaffold example, guidance, and disabled-worker
  message; the module default remains `false`.
- Several named Resizers can live in one process. `new Resizer({ name })` registers under its
  name (default `'default'`), a duplicate name throws `RESIZE_DUPLICATE_RESIZER`, and
  `getResizer(name?)` looks one up. Each Resizer has its own `config`, `logger` and `events`; the
  framework adapter fills them from the app, read on first use.
- Drivers are four contracts, exported as abstract classes: a custom driver `extends` one, or is
  any object of the same shape. The 0.2 media store, lock provider and queue transport are gone,
  and so is the `ResizeDatabase` of pre-release 0.3.0 builds, split into `MediaStore` and
  `LockStore`.
  - `ResizeStorage` (files): `upload`, `download`, `publicUrl`, optional `signedUrl`.
  - `MediaStore` (media documents): `loadMedia`, `appendPreviews` and an optional `verify()`.
    `appendPreviews` stores a preview only when its `identity` is not stored yet and must resolve
    with the previews it stored (`[]` when none); resolving with something other than an array,
    such as the pre-release "nothing = all" `undefined`, fails with `ResizeSetupError`
    `RESIZE_MEDIA_APPEND_RESULT_INVALID`.
  - `LockStore` (locks with owners): `acquire(key, owner, ttlMs)`, `extend(key, owner, ttlMs)`,
    `release(key, owner)` and an optional `verify()`. `release` is a compare-and-delete: a holder
    whose lock expired and was taken over cannot remove the new holder's lock. The only lock the
    core takes is the gate lock of a task queue without `gatesByTask` (see the gate below): a read
    acquires it with a fresh owner, and the worker extends and releases it.
  - `TaskQueue` (queued tasks): atomic `add`, `claim`, `renew`, `complete` and `fail`, and
    optionally `release`, `findActive`, `servesQueue`, `getTiming`, `verify` and the flags
    `gatesByTask` and `claimFilters` (see the gate below).
- The core owns the queue logic. Its worker loop (run by `runWorker`) handles
  leases and the heartbeat, the task timeout, retry with backoff, dead-lettering (after
  `maxAttempts`, or at once for a `ResizeError` with `retryable: false`), the dead-letter
  cooldown, the gate lock of a queue without `gatesByTask` and the `completed` / `failed` /
  `deadLettered` events, identically for every queue. Tasks carry
  their `resizer` and `queue`; events go to the owning Resizer's observers. An idle worker polls every
  `idlePollMs`, counted from the start of the claim, so a long-polling claim (SQS) is not followed
  by an extra sleep; claim errors back off (doubling up to 10× `idlePollMs`, reset by the next
  successful claim). `claim` may wait for a task, which is how a driver can deliver tasks by
  notification without a contract change.
- `new Resizer({ storage, media, locks?, tasks?, coordination?, queueName? })`. `media` is required
  (`RESIZE_MEDIA_REQUIRED`); it replaces the pre-release `db` (`RESIZE_DATABASE_REQUIRED`), and
  `resizer.db` is gone: read `resizer.media`, `resizer.locks` and `resizer.tasks`. `tasks` enables
  queued work (prewarm, lazy reads, the worker); a task queue without `gatesByTask` needs `locks`
  beside it (`RESIZE_LOCKS_REQUIRED` from `verify()` and worker start; until then reads serve
  stored previews and queue nothing). `config` is optional (the package defaults) and may be a
  function read on first use; `logger` defaults to `console`; the core never reads a framework app.
- Shipped drivers are grouped by backend, and framework pieces live only in the adapter:

  | 0.2.x | Now |
  |---|---|
  | `…/storage/fs.js`, `…/storage/s3.js` | `…/drivers/fs.js`, `…/drivers/s3.js` (`LocalFsStorage`, `S3Storage`) |
  | `…/transports/mongo.js` + the framework media store and lock provider | `…/drivers/mongo.js`: `mongoParts(connection, { mediaModel, timing? })`, `MongoMediaStore`, `MongoLockStore`, `MongoTaskQueue`, `createResizeModels` |
  | `…/transports/sqs.js` | `…/drivers/sqs.js`: `SqsTaskQueue` |
  | `…/mediaStore/framework.js`, `…/locks/framework.js`, `…/models/ResizeTask.js`, `…/commands/ResizeWorker.js` | `…/framework.js`: `FrameworkMediaStore`, `FrameworkLockStore`, `ResizeTaskModel`, `ResizeWorker` |

  - `mongoParts` returns `{ media, locks, tasks }` to spread into the Resizer (it replaces the
    pre-release `mongoDatabase` / `MongoDatabase`), and registers the package's `ResizeTask` and
    `ResizeLock` models with `autoIndex` off; create their indexes through your migration.
    `ResizeLock` rows carry the lock's `owner`. `MongoLockStore` (and `FrameworkLockStore`)
    acquires a lock in one `findOneAndUpdate` upsert, the framework `Lock` model's pattern: an
    expired lock, or one without an expiry, is taken over. A `MongoLockModel` needs
    `findOneAndUpdate`, `updateOne` and `deleteOne` (no longer `create`); each call passes
    `strictQuery: false`, so `owner` stays in the filter of a non-strict schema that does not
    declare it. `MongoLockStore.verify()` fails with `RESIZE_MONGO_LOCK_MODEL_OUTDATED` when a strict lock
    schema has no `owner` field (a `ResizeLock` model registered before this version, which
    `createResizeModels` returns as it is).
  - `SqsTaskQueue` uses plain SQS calls (ReceiveMessage, ChangeMessageVisibility, DeleteMessage,
    SendMessage), so `sqs-consumer` is no longer a peer. Retries are the core's, a dead task goes
    to `deadLetterQueueUrl` (when set) and `onTaskDeadLettered` fires for SQS too. Its timing is
    checked by the core per queue name, like every task queue's, not when the queue is
    constructed: by `verify()` for the Resizer's own queue, at worker start for each name the
    worker consumes, and by each call on that name (`prewarm()` reports it; `resolve()` logs it
    once per queue name, on the first read of that queue). Its messages carry the gate lock's owner (`gateOwner`), which the worker uses to
    extend and release that lock.
  - Re-run `resize-scaffold` after deleting the old model and command shims.
- `ResizeTask` gains `resizer`, `queue` and `availableAt` (when the task may next be claimed)
  fields, and the gate's `active` and `cooldownUntil` (see the gate below). Rows without
  `resizer`/`queue` read as `'default'`. Rows without `availableAt` (written before it existed,
  or by an older worker during a rolling deploy) still wait for the retry time or lease end in
  their `leaseExpiresAt`; a backfill is optional.
- The claim index `{ queue: 1, status: 1, availableAt: 1 }` replaces `{ status: 1, createdAt: 1 }`
  (and the pre-release `{ queue: 1, status: 1, createdAt: 1 }`), and workers claim the task that
  became due first. Create it through your migration before or
  together with the new workers, then drop the old index.
- The worker runs each task with the Resizer named in it, and filters claims: every claim carries
  the served Resizer names, so a task queue with `claimFilters` (the database queue) never hands
  it another Resizer's task. From a task queue that cannot filter claims (SQS), a task for a
  Resizer the worker does not serve is given back to the queue, without running it, for a worker
  that serves it (or retried when the queue cannot give tasks back: it fails with
  `RESIZE_NO_RESIZER`, retries, then dead-letters, and its events are logged and dropped). The
  worker logs each such Resizer once. On SQS, which counts every receive, a task given back often
  can still use up `maxAttempts`. A filtering queue that hands out such a task anyway is logged,
  and the task fails with `RESIZE_NO_RESIZER`.
- The worker serves a fixed list of Resizers: `runWorker({ resizers })`, by default every Resizer
  constructed in the process when it starts. The list is resolved once, at start: a Resizer
  constructed later is not served. A listed Resizer that cannot start makes `runWorker` reject before it
  claims anything: the worker runs the checks of `verify()` that need no queue name for every
  listed Resizer, and the checks of each queue name it consumes on every Resizer that carries
  that name (not `verify()` itself, so a Resizer's own queue is checked only when it is consumed). Beside a task queue the worker
  consumes that cannot filter claims, the list must include every Resizer of the process that uses
  that queue (otherwise the worker would claim their tasks without running them:
  `RESIZE_QUEUE_SHARED_RESIZER_UNLISTED`, also when an unlisted Resizer's task queue cannot be
  loaded, so it cannot be compared), and two listed Resizers need two names
  (`RESIZE_DUPLICATE_RESIZER`). `runWorker({ logger })` takes the worker loop's messages, failed
  gate lock calls included; a logger that throws never stops the loop.
- Preview identity includes the Resizer and pipeline: `resizer:pipeline:sizeKey:format:filterSig`.
  Generated preview rows store `resizer` and `pipeline` (rows without them belong to `default`), so
  different pipelines and Resizers keep separate previews of the same media instead of sharing
  whichever was generated first. `isCatalogCovered` takes an optional scope. The "use distinct
  filters per pipeline" workaround is no longer needed.
- One preview row per identity. Every new preview row has an `identity` string, and
  `resizeMediaSchemaFragment` includes `previews[].identity`; the media store keeps a preview only
  when its identity is not stored yet. A preview that another worker stored first is logged as a
  warning with its storage ref and does not count as created. A hand-written media schema that
  declares preview rows as sub-documents must add `identity: { type: String }` to them:
  `MongoMediaStore.verify()` (so `resizer.verify()` and worker start) throws `ResizeSetupError`
  `RESIZE_MONGO_MEDIA_MODEL_OUTDATED` without it (a mixed or plain `previews` array passes). Rows
  written earlier have no identity and are not migrated.
- `MongoMediaStore` writes previews and the backfilled dimensions with `findOneAndUpdate`, one write
  per preview plus one for the backfill, so a `findOneAndUpdate` middleware on the media model runs
  for each; the document it receives has only `_id`, and is `null` when the preview was already
  stored or the media is gone. A model-shaped `MongoMediaModel` needs `findById` and
  `findOneAndUpdate` (no longer `findByIdAndUpdate`).
- The framework is an adapter. The main entry imports no framework code; framework wiring lives in
  `@adaptivestone/framework-module-resize/framework.js`. `new FrameworkResizer({ pipelines, hooks
  })` (a `Resizer` subclass) builds every part from the config file on first use: the image
  settings, `storage`, the task queue (the scaffolded `ResizeTask` model for the database queue),
  `FrameworkMediaStore` (the app's media model), beside a task queue without `gatesByTask` (the
  SQS driver, or a custom queue without the flag) `FrameworkLockStore` (the framework `Lock` model,
  which also stores each lock's owner; the two replace the pre-release `FrameworkDatabase`), and
  the app logger and events. Options win over the config (`storage`,
  `media`, `locks`, `tasks` — a `TaskQueue` or `false` —, `coordination`, `config`, `configName`,
  `queueName`, `logger`, `events`). The main entry no longer
  exports `ResizeWorker`, `ResizeTaskModel`, `runResizeWorker` or the `TResizeTask` type.
- A smaller public surface. The main entry no longer exports `calculateResizedDimensions`,
  `getFilterSig`, `getImageContentType`, `getPreviewIdentity`, `processTask`, `getResizeConfig`,
  `defaultResizeConfig` (use the default export of `…/config/resize.js`) or `requiredFormats`.
  `runWorker` is the worker entry. `…/framework.js` exports `FrameworkResizer`,
  `FrameworkMediaStore`, `FrameworkLockStore`, `ResizeTaskModel`, `ResizeWorker`,
  `runResizeWorker`, `defaultFrameworkResizeConfig`, `defaultWorkerOptions`,
  `resizeMediaSchemaFragment`, `resizeMediaPaths` and the config types.
- Pipelines are fixed at construction. `Resizer.registerPipeline()` and `getPipeline()` are
  removed (pass every pipeline in `pipelines`; `hasPipeline(name)` checks one), and so are
  `runWaterfall()` and `runObservers()` (register taps with `hooks:` or `hook()`; the module runs
  them). New: the `HookTaps` type of the `hooks` option, exported from the main entry. There is
  no public processor API in this release: the worker reaches the Resizer's renderer through an
  internal accessor that the package does not export.
- The scaffolded `src/resizer.ts` holds behaviour only (`new FrameworkResizer({ pipelines })`);
  storage and the queues live in `src/config/resize.ts`. `--eager` emits the same construction site
  with a config without `queue` or `queues`.
- The core config holds image settings only. `ResizeConfig` loses `queue` and `worker` (a core
  config containing them fails with `RESIZE_CONFIG_REMOVED_KEY`), and `worker.concurrency` becomes
  the top-level `concurrency`. Queue timing belongs to the task queue (`timing`), and lock TTLs to
  the Resizer's `coordination` (see the gate below); the core validates both when the Resizer
  starts: invalid values make `verify()` and worker start reject, while reads serve stored
  previews and queue nothing. Sharp process tuning is `runWorker({ sharp })`.
- Framework config files hold a Resizer's `mediaModelName`, `storage` and `queue` and spread
  `defaultFrameworkResizeConfig` from `…/framework.js`; `src/config/resize.ts` also holds the
  process-wide `queues`, `worker` and `coordination` (see the named queues above).
  - `storage`: `{ driver: 'local', … }` or `{ driver: 's3', … }` (S3 imported only when selected;
    `RESIZE_CONFIG_STORAGE_MISSING` when neither the config nor the code gives one).
  - `defaultFrameworkResizeConfig` contains no `queue` or `queues`: add
    `queues: { default: { driver: 'database' } }` for background generation (the scaffold without
    `--eager` writes it, with `queue: 'default'`).
  `ResizeConfig` no longer contains `mediaModelName`; `FrameworkResizeConfig` does.
- `prewarm()` reports every requested variant: `{ status, ready, accepted, notRequired,
  unconfirmed, tasks, issues }` (`PrewarmResult`), instead of an `{ enqueued }` count, and still
  never throws (an internal error is `incomplete` with a `RESIZE_ENQUEUE_INTERNAL_ERROR` issue that
  lists the variants requested so far; it is not retryable when the error is one of this
  package's with `retryable: false`, or a setup, config or media error, a host subclass of one
  included). A variant is accepted only when a task holds it: the
  task added now, or, after an `in-flight` add, the active task that the optional
  `TaskQueue.findActive()` (the Mongo queue) reports with the same canonical payload. A variant
  the active task does not cover is `unconfirmed` with the retryable `RESIZE_TASK_IN_FLIGHT`, and
  a held gate lock (SQS) is the retryable `RESIZE_ENQUEUE_LOCK_CONTENDED`. Conflicting payloads
  with one preview identity are explicit errors. Issues describe only the variants that remain
  unconfirmed. There is no separate strict
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
- `ResizeError.retryable` (default `true`) decides dead-lettering instead of a list of codes: a
  task whose error has `retryable: false` is dead-lettered on its first failure. It is `false` by
  default on `ResizeNoOriginalError` and `ResizeSecurityError` (a security refusal while reading
  the original is no longer retried), and `RESIZE_SOURCE_TOO_LARGE`,
  `RESIZE_SOURCE_FORMAT_UNSUPPORTED`, `RESIZE_SOURCE_METADATA_MISSING`,
  `RESIZE_SVG_DIMENSIONS_UNSUPPORTED` and
  `RESIZE_SVG_RENDER_TIMEOUT` set it. The worker reads `retryable` on the error that fails the
  task, when it is a `ResizeError` — including one from a duplicate copy of the package (the
  `isResizeError` brand, not the class); errors from other libraries are retried, whatever
  fields they carry (an AWS SDK v2 4xx has its own `retryable`). That covers errors from
  `loadMedia`, `storage.download`, the decoder's checks and render, `beforeSteps` and
  `appendPreviews`. An error inside one variant (`variantSteps`, encoding, `storage.upload`) fails
  only that variant, and the task fails with the retryable `RESIZE_WORKER_INCOMPLETE` (retried for
  the missing variants only).
- New error codes: `RESIZE_MEDIA_REQUIRED` (no `media`), `RESIZE_LOCKS_REQUIRED` (a task queue
  without `gatesByTask` and no `locks`), `RESIZE_MEDIA_APPEND_RESULT_INVALID` (`appendPreviews`
  resolved with something other than an array), `RESIZE_MONGO_LOCK_MODEL_OUTDATED` (a lock schema
  without `owner`) and `RESIZE_QUEUE_SHARED_RESIZER_UNLISTED` (a worker that serves only some of
  the Resizers on a task queue it consumes that cannot filter claims). The pre-release
  `RESIZE_DATABASE_REQUIRED` is gone.
- A task queue that cannot be used (no `locks` beside a queue without `gatesByTask`, invalid
  timing on the task queue itself, or an invalid `coordination`) no longer stops the Resizer:
  `ready()` resolves, the error is logged once, `resolve()` serves the stored previews and queues
  nothing, `uploadOriginal()` and `generate()` work, `prewarm()` returns `incomplete` with a
  non-retryable `RESIZE_ENQUEUE_INTERNAL_ERROR` issue carrying the error, and `verify()` and
  worker start reject with it. Call `verify()` at boot to stop such a
  deploy. (The `queues` entries of `src/config/resize.ts` are validated with the rest of the file,
  so there invalid timing is still a config error on first use; its `coordination` section
  degrades as above.)
- Locks carry an owner, and a release deletes only the owner's lock. The dispatch and worker locks
  of older versions are gone: this version never reads their `ResizeLock` and framework `Lock`
  rows, which expire by their TTL. Its only lock is the gate lock (`resize_gate:…`), which no older
  process knows.
- `worker.concurrency` in a framework config file fails with `RESIZE_CONFIG_REMOVED_KEY`; move it to
  the top-level `concurrency`.
- The scaffolded `src/models/ResizeTask.ts` imports the new
  `@adaptivestone/framework-module-resize/framework/ResizeTaskModel.js` export (the model class as
  its default export), which lets the framework's `npm run gen` type `getModel('ResizeTask')`.
  `resize-scaffold --check` reports a shim that still imports `…/framework.js` as drift: delete
  `src/models/ResizeTask.ts` and re-run `npx resize-scaffold` (`--force` would also overwrite
  `src/resizer.ts` and `src/config/resize.ts`).
- An ejected or hand-written `ResizeTask` model must declare the `resizer`, `queue`,
  `availableAt`, `active` and `cooldownUntil` fields (and the `{ queue, status, availableAt }`
  index and the gate index); Mongoose would drop undeclared fields, filing every task under
  Resizer and queue `'default'`, losing retry times, turning the gate off and ending every
  dead-letter cooldown at once. `resize-scaffold --check` reports such a model, and
  `MongoTaskQueue.verify()` (so `resizer.verify()` and worker start) throws `ResizeSetupError`
  `RESIZE_MONGO_MODEL_OUTDATED`. The queue checks the schema at its first use too, whether or not
  `verify()` ran: `add()` logs the error once per model and resolves `unconfirmed` every time (it
  never stores a task the gate cannot see), and its other methods reject with it. The read path
  logs an unconfirmed add once, then again only after an add was confirmed.
- One task queue per backend in a framework app, and each queue name is a lane on it, with its own
  timing. Every `database` entry of `queues` is one backend (the app's `ResizeTask` model), and the
  SQS entries that share `region`, `endpoint`, `deadLetterQueueUrl` and the effective
  `waitTimeSeconds` (default 10) are one backend: one `SqsTaskQueue` for all their names. From
  `0.3.0-rc.3` names on different backends route: each call goes to the backend of its queue name,
  so one Resizer may use queues on several backends. The worker runs one loop (Consumer) per
  backend and queue name it consumes, one task at a time, each task processed with its own
  Resizer. `RESIZE_CONFIG_QUEUE_TIMING_CONFLICT` is
  removed: each queue name is defined once, so two files can no longer disagree about its timing.
  Without the framework, each `mongoParts()` call makes its own queue, with one timing for every
  name: call it once and spread the same parts into every Resizer.
- The default JPEG quality is 88 (was 80).
- A task's `leasedBy` is `<hostname>:<pid>` instead of `resizer-<pid>`, so pods with the same pid
  are told apart.
- **The gate: one active task per Resizer, media, pipeline and queue.** While a task of theirs is
  queued, running, waiting for a retry, or cooling down after a dead-letter, no other task is
  queued for them, whatever variants either asks for: a read queues nothing, and a new size waits
  for the active task (the next read after it ends queues it). 1000 concurrent reads of a cold
  media create one task. A request on another queue is a separate task, as before: a task waiting
  on `'bulk'` never blocks reads on `'default'`. On the Mongo queue the task row is the gate; on a
  task queue that cannot gate by task (SQS) it is one owned lock per Resizer, media, pipeline and
  queue. The per-identity
  dispatch and worker locks are gone: the lease, its token fencing every write, and
  `appendPreviews` keeping one row per identity prevent duplicate work.
- `TaskQueue.add` resolves with a `TaskAddResult` (in pre-release builds it resolved
  `{ taskId: string | null }`): `{ status: 'added', taskId }`,
  `{ status: 'in-flight', taskId? }` (only from a gating queue: an active task of this Resizer,
  media, pipeline and queue exists, so nothing was stored; an `in-flight` without its id is logged
  once, since a gate index without its partial filter makes it constant) or
  `{ status: 'unconfirmed' }` (the queue cannot say whether it stored the task). A result in none
  of these shapes (a queue
  written for an earlier version) is never counted as queued: the Resizer logs it once, and
  `prewarm()` reports its variants with the non-retryable `RESIZE_ENQUEUE_UNCONFIRMED`. New in the
  contract: the optional flags `gatesByTask` (the queue keeps the gate itself, and must keep a
  task active from `add()` until `complete()`, and a dead one through its cooldown, after which the
  next `add()` must take it over; the `gatesByTask` JSDoc states the whole lifecycle) and
  `claimFilters` (`claim` honours `ClaimOptions.resizers`); `claim(queue, leaseMs, signal?,
  { resizers })`; `fail(task, next, error, { cooldownMs })` (`FailOptions`: how long a gating queue
  keeps a dead task as the gate); and `gateOwner` on `NewTask` and `ClaimedTask`, which a queue
  without `gatesByTask` must store and hand back unchanged from `claim()`.
  `findActive({ resizer, mediaId, pipeline, queue })` takes the queue (in pre-release builds it
  took none and looked on any queue) and returns the active (pending or processing) tasks of that
  queue, at most one on a gating queue and `[]` for a dead one; the core reads it
  only after an `in-flight` add.
- `NewTask.requestKey` is removed, with the SHA-256 request key, the `ResizeTask.requestKey` field
  and its `{ fileId, pipeline, requestKey }` index.
- `ResizeTask` gains `active` (true while the row is the gate of its Resizer, media, pipeline and
  queue: from `add()` until the task completes) and `cooldownUntil` (a dead row keeps the gate
  until then), and the gate index: unique on `{ resizer: 1, fileId: 1, pipeline: 1, queue: 1 }`
  with `partialFilterExpression: { active: true }`. The host creates the index through its
  migration; `MongoTaskQueue.verify()` (so `resizer.verify()` and worker start), now async (await
  it when you call it yourself), waits for the model's own `init()` (with `autoIndex` on, the
  index build Mongoose runs at boot; a failed build is the error's `cause`), reads the indexes and
  rejects with `ResizeSetupError` `RESIZE_MONGO_INDEX_MISSING` (naming the collection and the
  index) while it is missing, not unique, not partial on `active: true`, or the collection does not
  exist yet; the module never creates it. A filter spelt `{ active: { $eq: true } }` is accepted. It
  needs an open connection, or waits for an opening one; a closed one rejects at once with
  `ResizeSetupError` `RESIZE_MONGO_NOT_CONNECTED` instead of a buffering timeout, and an opening
  one that fails rejects with it once the driver gives up (`serverSelectionTimeoutMS`, 30 s by
  default), the message naming the driver's error. An ejected or
  hand-written model adds the two fields (`RESIZE_MONGO_MODEL_OUTDATED` without them). `MongoTaskQueue` sets `gatesByTask` and
  `claimFilters`. After a dead row's cooldown the next `add()` retires it (`active: false`, its
  `error` kept) and inserts a new row. Its `add()` counts a duplicate key as the gate only on the
  gate index: one on another unique index of a host model is logged and reported `unconfirmed`.
- `lockTtlMs` leaves queue timing for the Resizer's new `coordination: { gateTtlMs, cooldownMs }`
  (`CoordinationOptions`; defaults 600000 each, `defaultCoordination` in `…/config/resize.js`):
  `lockTtlMs.failed` → `cooldownMs`, `lockTtlMs.dispatch` → `gateTtlMs`, and `lockTtlMs.worker` is
  dropped. `lockTtlMs` in a task queue's `timing` or in a `queues` entry
  (`queues.<name>.lockTtlMs`) fails with `RESIZE_CONFIG_REMOVED_KEY`. Set `coordination` with
  `new Resizer({ coordination })`, `new FrameworkResizer({ coordination })` or the `coordination`
  section of `src/config/resize.ts` (missing values take `defaultCoordination`). Only the core
  validates it, when the Resizer sets up its task queue: `RESIZE_CONFIG_COORDINATION_INVALID` (the
  message names the key, or the value when the whole section is wrong; `coordination: null` in the
  file too) degrades like a
  task queue that cannot be used, in a config file too. No value depends on the queue's lease.
  Each dead-letter gets the cooldown of the task's own Resizer.
- `locks` is optional beside a task queue with `gatesByTask`. Only a queue without it
  (`SqsTaskQueue`, most custom queues) needs one, for one gate lock per Resizer, media, pipeline
  and queue, `resize_gate:<resizer>:<queue>:<mediaId>:<pipeline>` (each part URI-encoded), whose
  random owner travels with the task as `gateOwner` (`RESIZE_LOCKS_REQUIRED` now names
  `SqsTaskQueue`). The core takes it for `gateTtlMs` when it queues a task; when the queue does not
  confirm the add, it keeps the lock for one lease (at most `gateTtlMs`) instead of releasing it
  (the task may have been stored). The worker extends the lock when the task starts and on every heartbeat (to one lease
  plus one heartbeat interval, so a redelivery after a crash still finds it), after a failed
  attempt (to the retry time plus one lease), after a dead-letter (to `cooldownMs`) and when it
  gives a task back (to `gateTtlMs`); it takes a lapsed lock back under the task's owner unless
  another request holds it, and releases it on completion. After a known lease loss (a renewal in
  flight when the task ends is awaited first) it makes no call for that delivery (no completion,
  no gate call), and every lock store call is bounded by `min(leaseMs, 30000)` ms, so a hanging
  lock store never holds the worker. A gate call of the running task that answers after the final
  release or hold (a slow store) is followed by that final action again.
  `mongoParts` still returns `locks`. `FrameworkResizer` builds `FrameworkLockStore` on first use,
  and only beside a task queue without `gatesByTask` (the SQS driver, or a custom queue without
  the flag), so a database-queue app needs no framework `Lock` model; reading
  `resizer.locks` before `ready()` is `RESIZE_NOT_READY`, as for the other parts.
- The worker filters claims by the Resizers it serves (see the worker above).
- Task events and the three task observers (`afterTaskComplete`, `onTaskFailed`,
  `onTaskDeadLettered`) receive the task with `attempts`: `LeasedTask.attempts` counts the task's
  deliveries, this one included (1 on the first). In pre-release builds `attempts` was on
  `ClaimedTask` only; it moved to `LeasedTask`, which `ClaimedTask` extends.
- Codes: new `RESIZE_TASK_IN_FLIGHT`, `RESIZE_CONFIG_COORDINATION_INVALID`,
  `RESIZE_MONGO_INDEX_MISSING` and `RESIZE_MONGO_NOT_CONNECTED`. Gone: the pre-release
  `RESIZE_CONFIG_QUEUE_LOCK_TTL_INVALID` (an invalid `lockTtlMs`), whose successor is
  `RESIZE_CONFIG_COORDINATION_INVALID` (an invalid `coordination`), and
  `RESIZE_CONFIG_LOCK_EXCEEDS_LEASE`, with no successor: its rule (`lockTtlMs.worker` within the
  lease) went with `lockTtlMs.worker`.
- Rollout of the gate: deploy the API and the workers together, after the pending tasks have
  finished or been drained. Task rows from before the gate have no `active` and are not gates, so
  during a rolling deploy a read can queue a second task for such a media. The next `add()` takes
  over a row that a worker from before the gate completed or dead-lettered (such a worker leaves
  it active and sets no cooldown). Indexes, in this order: create the gate index
  `{ resizer: 1, fileId: 1, pipeline: 1, queue: 1 }` (unique, partial on `active: true`) BEFORE
  the new API and workers start (`verify()` and worker start reject with
  `RESIZE_MONGO_INDEX_MISSING` until it exists; without it every `add()` stores a task, duplicate
  active rows build up, and the unique index build then fails with E11000 until those rows are no
  longer active: completed, or dead and taken over or expired); create the claim index
  `{ queue: 1, status: 1, availableAt: 1 }` before or together with the new workers; then drop the
  `{ fileId, pipeline, requestKey }` index when convenient: new rows never enter it. On SQS an
  older worker ignores `gateOwner`, so the gate lock of a task it ran expires only after
  `gateTtlMs`.

**Changed behaviour** (`0.3.0-rc.3`, without a host change)

- For a host whose `queues` span two available backends, `resizer.tasks` is a `RoutingTaskQueue`:
  it has no `release`, and an `instanceof MongoTaskQueue` check on it fails; use
  `carrierOf(resizer.tasks, name)`.
- `verify()` checks the framework `Lock` model only for a Resizer whose own queue is on SQS.
- A driver name in a config (`storage`, `queues`) is checked against the Resizer's drivers when the
  Resizer first reads that section. An unregistered storage driver in an explicit `config` option
  still throws at construction, with the text and code of `0.3.0-rc.2`.
- With `queues` on more than one available backend, every `FrameworkResizer` that takes its task
  queue from the config file has the same router as `tasks`, which can queue to every name. So a
  custom `runWorker({ resizers })` that consumes a queue on SQS (a backend that cannot filter
  claims) must list every such `FrameworkResizer` of the process, whatever its own queue; else it
  fails with `RESIZE_QUEUE_SHARED_RESIZER_UNLISTED`. `0.3.0-rc.2` accepted, for example,
  `runWorker({ resizers: [b], queue: 'bulk' })` with `'bulk'` on SQS beside a Resizer `a` on the
  database queue `'default'`. The framework CLI (`npm run cli ResizeWorker`) serves every Resizer
  and is not affected.
- `RESIZE_QUEUE_NOT_SERVED` is narrower: an unknown name, or a backend whose SDK is not installed;
  a queue on another available backend now queues.
- `EnqueueIssue` gains the optional `causeCode` (the code of the error behind an issue); the union
  of issue codes is unchanged.
- An invalid timing of a task queue is logged once per queue name by `resolve()`, on the first
  read of that queue, instead of when the Resizer starts; `verify()` still rejects.
- A worker no longer checks a served Resizer's own queue unless it consumes it.
- A worker given `queue: ''` (or a list with a blank entry, or an empty list) fails with
  `RESIZE_QUEUE_INVALID`.
- With several broken `queues` entries, the first error reported may differ from `0.3.0-rc.2`;
  a config with one error keeps its text and code.
- `FrameworkStorageConfig`, `FrameworkLocalStorageConfig` and `FrameworkS3StorageConfig` are
  deprecated (use `StorageConfig`, `LocalStorageConfig` and `S3StorageConfig`).

**Changed behaviour** (`0.3.0-rc.4`, without a required host change)

- **Outdated previews regenerate.** A stored preview whose `origin` or `encodeSig` differs from
  what the current settings would record (another original or other stored dimensions, other
  encode settings, another pipeline `version`), or that has neither (written before
  `0.3.0-rc.1`), is stale. It is still served, and its replacement is made on its next read,
  `prewarm()` or `generate()` and stored over it in one write. Each replacement costs a render and
  an upload, and the old file is never deleted: plan the storage cost, and clean up from the
  `info` line "resize: replaced <n> outdated preview(s) of media <id>; their files are not
  deleted: storage refs …", or sweep preview objects no row references (rows without an
  `identity` keep their files referenced: delete them yourself). The wave shares the queue with
  new uploads' previews, which wait behind it. An eager-only host's stale rows are served until it
  calls `generate()`.
- **Roll out settings with every worker at once.** The API and the workers must run the same image
  settings and pipeline versions: deploy every worker together, or change settings only after the
  old workers have stopped. Two worker versions with different settings re-make each other's rows:
  every read after a task ends queues them again, and each replaced preview costs one render, one
  upload and one orphaned file.
- **A media without stored dimensions** (or with a stored `null`) takes one task that downloads and
  inspects the original and records its dimensions; no row of it can be proven fresh before. A
  `MediaStore` must save `backfillDims` in `appendPreviews`, also with `previews: []`; a store that
  drops them makes every read of such a media queue that task, and the worker warns once.
- **`beforeEnqueue` also receives stale variants**, with the missing ones, in cell order; a
  variant that replaces a stale row ends in `decision.stale`, not `decision.missing`.
- **Changing the smaller of `limits.sourcePixels` and `limits.inputPixels`** (the animation pixel
  budget) regenerates webp and gif previews; changing only the larger one changes nothing.
- **Per-read logs.** A read logs an unregistered pipeline name and a format list without
  `encode.formats` entries once per Resizer (at most 100 of each), and the missing task queue
  (when the caller passed `enqueueMissing: true`) once; a media without an original logs nothing.
  Each read is counted instead (`resize.read` with its outcome).
- **New `info` lines** from the default metrics: one summary line per Resizer per window (60 s by
  default) when something was counted, and one line per task outcome and per failed variant.
  `new NoopMetrics()` turns them off.
- **A truthy `fit` that is not `true`** (from untyped JS, e.g. a `beforeEnqueue` tap's `fit: 1`) is
  now a cover row: only `fit: true` makes a fit row. On the database queue such a variant used to
  render as a fit row (Mongoose cast `1` to `true`); fit rows already stored stay fresh and are not
  regenerated. Typed hosts are unaffected.
- **A stored row whose `fit` is not a boolean** (from a store that does not keep the field: a
  strict Mongoose row schema without it, a table without the column) is fresh when its
  `encodeSig` matches either the fit or the cover signature, so such a store does not regenerate
  its fit previews on every read. `MongoMediaStore.verify()` logs one warning (it does not throw)
  when strict preview rows lack `fit`: declare it as `{ type: Boolean }`.
- **`MongoMediaStore.verify()` also warns once** (it does not throw) when the media schema declares
  `original` strictly (nested paths, or a sub-schema without `strict: false`) without
  `original.width` or `original.height`: Mongoose drops the measured dimensions, so every read of
  such a media queues a task that downloads the original. Spread `resizeMediaSchemaFragment`, or
  add both as `{ type: Number }`.
- **A render copies what it reads, keeping the types.** The storage driver gets its own copy of
  the original's locator: plain objects and arrays copied, a `Buffer` still a `Buffer`, a `Date` a
  `Date`, and class instances (a bson `ObjectId`, say) and functions the same values as before. A
  config with extra host keys that cannot be copied (a function) still renders: only the image
  settings are copied.
- **`ResizeLogger.debug` accepts any value**, as before it was declared; `LogMetrics` writes its
  debug lines only through a function.
- **`resolve()` never throws** when reading the caller's options throws (a `pipeline` getter, say):
  the read returns the safe empty decision and counts a failed read under `pipeline: 'default'`.
- New bytes under the same `original.storageRef` and at the same size are not detected as stale:
  after replacing an original in place, call `invalidate()` for that media.

**Changed behaviour** (`0.3.0-rc.5`, without a host change)

- **S3 public objects are cached for a year.** Every public object `S3Storage` uploads (previews
  and public raster originals, and a host's own direct uploads) carries
  `Cache-Control: public, max-age=31536000, immutable`; private objects get no cache header. Every
  key the module writes is new, so an object never changes under its URL; a host that calls
  `S3Storage.upload` itself must give every upload a new key, as the `ResizeStorage.upload`
  contract requires (the driver does not check). CDNs and browsers keep these objects up to a
  year, so purge your CDN when you delete one that must disappear sooner (browsers that already
  have it may keep it until it expires). Objects uploaded before `0.3.0-rc.5` keep the headers they
  were stored with.

**Features**

- **Metrics.** A Resizer reports reads, uploads, rendered variants, task outcomes and the worker's
  waits to a `ResizeMetrics` sink (`count`, `timing`, optional `flush`; each may be `async`, and the
  4th argument carries per-event context for logs), given as the `metrics` option of `new
  Resizer`, `createResizer` and `new FrameworkResizer` and read back as `resizer.metrics`. The
  default is `LogMetrics` on the Resizer's logger (for a `FrameworkResizer`: with debug lines on,
  on its `logger` option, else the app logger); `NoopMetrics` records nothing. The Resizer adds the `resizer` label, bounds
  the `pipeline` and `code` labels (`'unregistered'`, `'other'`; the raw value goes to the
  context), and never lets the sink throw or reject into a read or a task. The worker flushes the
  sinks when it stops, waiting at most 5 s. A sink that is not one (`metrics: null` too) is
  `ResizeSetupError` `RESIZE_METRICS_INVALID`. See "Metrics" in `README.md`.
- **The freshness check.** The read path, `prewarm()`, `generate()` and the worker compare each
  stored row's `origin` and `encodeSig` with the current settings; stale rows are served while the
  worker replaces them in one write. See "Freshness" in `README.md`.
- New fields: `decision.stale` and `ReadyEntry.stale` (the stale variants a read asks to replace,
  as left after `beforeEnqueue`, and the stale rows served), `GenerateResult.replaced` (the storage
  refs of the rows `generate()` replaced) and the optional `ResizeLogger.debug`.
- `MongoMediaStoreOptions.logger` (default `console`), where `verify()` writes its warning;
  `mongoParts()` and the `'mongo'` database driver pass their logger, `FrameworkMediaStore` the
  app logger.
- The framework is optional. `@adaptivestone/framework` and `mongoose` are optional peers, so
  npm no longer installs them into a plain Node app; the core needs only `sharp`. A plain Node app
  with MongoDB writes no driver code: `mongoParts(connection, { mediaModel })` gives the media
  store, the lock store and the task queue, and the core `runWorker({ queue, signal, logger, sharp,
  resizers })` runs the worker.
- Each framework Resizer can read its own config file, which holds that Resizer's sections (image
  settings, `mediaModelName`, `storage`, `queue`):
  `new FrameworkResizer({ name: 'listings', configName: 'resizeListings' })`.
- Per-environment drivers: `resize.production.ts` can switch storage to S3, or queues to SQS,
  without code changes (some queues alone too: queues on different backends route, below).
- Lazy drivers: `storage`, `media`, `locks` and `tasks` may be functions (sync or async), called
  once on first use. `resizer.ready()` loads them, validates the image config (a lazy config is
  read here, so a broken framework config file fails as itself), sets up the task queue (a lock
  store beside a queue without `gatesByTask` that does not route names, and a valid coordination;
  a queue name's timing is checked per name, by `verify()`, the worker and each call; a failure here
  degrades the read path instead of rejecting, see above) and builds the Resizer's services;
  every Resizer method and the worker await it, and `resolve()` / `prewarm()` keep their
  never-throw guarantee when it fails. The next call retries the step that failed and keeps the
  parts that loaded. Reading `resizer.storage` / `media` / `locks` / `tasks` before then throws
  `RESIZE_NOT_READY`.
- Named queues. A Resizer has its own queue (`queueName`, default `'default'`; in a framework app
  its file's `queue`), and `resolve()` and `prewarm()` accept a per-call `queue`.
  `npm run cli ResizeWorker -- --queue=<name>` consumes only that queue; without the flag it
  consumes `'default'`, and the flag may be repeated (`--queue=default --queue=bulk`).
  `SqsTaskQueue` maps queue names to URLs with the `queues` option.
- One worker process serves several Resizers (`runWorker({ resizers })`, by default every Resizer
  constructed before it starts), routing each task to the Resizer named in it. It runs one loop
  per backend and queue name it consumes (a task queue that does not route or serve a name is
  skipped; `RESIZE_QUEUE_NOT_SERVED` naming the queue when none does; if one loop fails, the others
  stop and the worker rejects with that error), and before claiming it runs the checks of
  `verify()`: every served Resizer's parts, media store, lock store and decoders, then, for each
  consumed name, the route of every served Resizer that uses it.
- The framework adapter reads the app lazily: config, models, logger and events are read on first
  use, so `src/resizer.ts` can be imported statically anywhere, even before `Server.init()`. The new
  `resizer.verify()` checks at boot what would otherwise only be logged per call: the config, the
  media and lock stores (`RESIZE_MONGO_MODEL_MISSING` / `RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN` when a
  model does not resolve) and the task queue (a lock store beside a queue without `gatesByTask`,
  its timing and the coordination, its `verify()`, and that it serves the Resizer's queue). It is
  the one call that rejects for a task queue that cannot be used.
- `resizer.uploadOriginal({ body, visibility, namespace? })` stores the original bytes unchanged
  and returns typed metadata. Format and dimensions come from the decoders' `inspect` (Sharp's
  metadata for raster images and SVG); new `upload.maxBytes`, `upload.formats` and
  `limits.processingTimeoutSeconds` bound accepted inputs.
- One task per media, pipeline and queue, whatever variants the reads ask for (the gate, above): a
  cold media read by 1000 requests at once gets one task, on Mongo and on SQS. The module does not
  create indexes; prepare the gate index through the host's migration or lifecycle before
  rollout (`verify()` checks that it exists).
- Queued raster tasks retry only the identities still missing after partial generation.
  Successful previews stay persisted, and permanent gaps use the normal backoff and dead-letter
  path. Deleted media tasks remain successful no-ops; previews uploaded for media deleted during
  the task are logged as a warning that the media no longer exists.
- `MediaStore`, `LockStore` and `TaskQueue` have an optional `verify()` startup check.
  `Resizer.verify()` and the worker await them once before claiming tasks, so custom drivers can
  fail fast too; `MongoMediaStore.verify()` checks the media model (including
  `previews.identity`), `MongoLockStore.verify()` the lock model (including `owner`) and
  `MongoTaskQueue.verify()` the task model and its gate index;
  `FrameworkMediaStore` checks that `mediaModelName` names a registered model and
  `FrameworkLockStore` that the framework `Lock` model exists. A `FrameworkResizer` uses the
  `Lock` model only for a queue on a backend without `gatesByTask` (the SQS driver, or a custom
  queue without the flag): `verify()` checks it only when the Resizer's own queue is on one, so a
  database Resizer needs no `Lock` model, even beside SQS queues.
- Worker shutdown gives the stopped task back. The variants in progress finish and are saved, and
  the task returns to the queue with no `onTaskFailed` / `onTaskDeadLettered` event and no
  backoff, through the new optional `TaskQueue.release(task)`; a `ResizeError` with
  `retryable: false` is still dead-lettered with its event. `MongoTaskQueue` does not count the attempt; `SqsTaskQueue`
  makes the message visible again but still counts the delivery (SQS counts receives); a custom queue
  without `release` is retried at once through `fail`, which also counts.
- A driver selected in a framework config file whose optional AWS SDK peer is not installed fails
  at first use or in `verify()` with `ResizeSetupError` `RESIZE_PEER_MISSING`, naming the packages
  and the config file. A queue on such a backend beside an available one is only not served in
  that process (`RESIZE_QUEUE_NOT_SERVED`, naming the package).
- A dead-letter cooldown, `coordination.cooldownMs` (default 600000 ms): after a task is
  dead-lettered, its media, pipeline and queue keep the gate for this long, so `resolve()` and
  `prewarm()` do not queue the same failing work again until it ends.
- `resizer.invalidate({ media, pipeline? })` (`InvalidateOpts`) removes this Resizer's stored
  previews of a media, of one pipeline or of all (only an omitted `pipeline` means all;
  `pipeline: null` matches nothing), in one media store write (`replacePreviews`), and
  resolves with the removed rows' storage refs for the host to delete. It loads the media fresh,
  drops the rows from the caller's `media.previews` too (when that array cannot be changed, it logs
  a warning and still resolves with the refs), never deletes files and never queues. It takes no
  gate: a task running for that media can store rows after it returns. A media that is gone gives
  `[]`.
- Preview rows record `bytes` (the encoded size), `createdAt` (when the row was stored), `origin`
  (a signature of the original it was made from: its storage ref and dimensions) and `encodeSig`
  (a signature of its format's encode settings, the sharpen setting of its fit mode, its animation
  settings (for animated formats: `animated`, `limits.animationFrames` and the pixel budget
  `min(limits.sourcePixels, limits.inputPixels)`, which also caps the frames at the larger of
  the source's and the preview's size), the result-dimension cap, the fit box (for fit rows) and the pipeline version), from the worker and
  from `generate()`; `resizeMediaSchemaFragment` declares them. From `0.3.0-rc.4` the freshness
  check compares them with the current settings (below).
- `Pipeline.version` (optional string) is part of every row's `encodeSig`: bump it when a step's
  output changes, and the pipeline's stored previews are regenerated on their next read. It is not
  validated, and `''` signs differently from an absent version.
- `ResizeTask` rows record `startedAt` (when the latest delivery started; every claim sets it) and
  `finishedAt` (when the task completed or was dead-lettered; a retry leaves both as they are), for
  inspection only: the worker never reads them.
- Per-queue timing. Each `queues` entry of `src/config/resize.ts` has its own timing. A task queue
  may give one name's timing through the optional `TaskQueue.getTiming(queue)`, which the core
  reads once per name, on that name's first use: `MongoTaskQueue` and `SqsTaskQueue` take
  `getTiming` (when it gives none, `timing` applies), and `MongoTaskQueue` takes `queues`, the names
  it serves (default every name). `verify()` validates the timing of the Resizer's own queue; a
  name used only per call is checked by its first `prewarm()` (every variant `unconfirmed`, one
  non-retryable `RESIZE_ENQUEUE_INTERNAL_ERROR` issue with the timing error) or `resolve()` (logged
  once per queue name), and by the worker of its queue.
- **`createResizer(config, { drivers })`** (main entry) builds a whole Resizer from one config
  object: the image settings, merged over the package defaults, and the sections `storage`,
  `database` (`{ driver: 'mongo', connection, mediaModel }`), `queue`, `queues` and
  `coordination` (`ResizerConfig`). It returns the Resizer at once; the parts are built on first
  use, only the drivers a section selects are loaded (`RESIZE_PEER_MISSING` for a missing AWS SDK,
  naming the config), and options given in code win over the config (`CreateResizerOptions`). Two
  calls build their own queues. See "Without the framework" in `README.md`.
- **Drivers by name.** Every shipped driver builds itself from its config section with a static
  `fromConfig`: `LocalFsStorage`, `S3Storage`, `MongoDatabase` (new, on `…/drivers/mongo.js`: the
  `'mongo'` database driver, the parts `mongoParts` builds) and `SqsTaskQueue`. A host registers
  its own by kind and name with the `drivers` option (`DriverRegistry`: `storage`, `database` and
  `queue` drivers, each anything with a `fromConfig` function); a host driver under a built-in name
  replaces it. A queue driver takes the entries of one backend, with the optional synchronous
  `backendOf(section)` and `validate(entries, { where })`, so names are grouped and checked before
  any optional package loads. New types: `DriverRegistry`, `DriverContext`, `StorageDriver`,
  `DatabaseDriver`, `DatabaseParts`, `QueueDriver`, `QueueDriverContext`, `QueueEntry`,
  `QueueSection`, `ResizerConfig`, `CreateResizerOptions`, `ResizerSections`, `StorageConfig`,
  `LocalStorageConfig`, `S3StorageConfig` and `MongoDatabaseConfig`. See "Drivers by name" in
  `README.md`.
- **`RoutingTaskQueue` and `TaskQueue.routeOf`.** `new RoutingTaskQueue(routes, { getTiming? })`
  (main entry) routes each queue name to a task queue, or to a builder called on the name's first
  need. The optional `TaskQueue.routeOf(queue)` resolves the task queue that carries a name, and
  the core asks every per-queue question (the gate, `add`, `findActive`, the lock rule, `verify()`,
  the worker) of that carrier. `carrierOf(tasks, queue)` (main entry) gives the carrier of a name
  on any task queue.
- **Mixed backends in `queues`.** Names on different backends route: a database `default` beside
  an SQS `bulk`, or an environment override that moves only some queues to SQS, keeps every name
  working, each call gated by its queue's backend. A backend is built when one of its names is
  first needed, and a name whose backend's SDK is not installed is not served in that process
  (`RESIZE_QUEUE_NOT_SERVED`, naming the package).
- **One worker for several queues.** `runWorker({ queue: ['default', 'bulk'] })`,
  `runResizeWorker({ queue: [...] })` and a repeatable `--queue` consume several queues, with one
  loop per backend and name; an unserved or unbuildable listed name fails start before any claim.
- **`new FrameworkResizer({ drivers })`** registers custom drivers for its config file's sections;
  `FrameworkResizeConfig<D>` types a custom section (`satisfies FrameworkResizeConfig<{ storage: {
  gcs: typeof GcsStorage } }>`).
- **Partial framework config files.** The image settings of a framework config file are merged
  over the package defaults (plain objects key by key, arrays and `encode.formats` replaced
  whole), so a file may set only what it changes. `PartialFrameworkResizeConfig` (main entry and
  `…/framework.js`) types an override that leaves out nested keys; `Partial<FrameworkResizeConfig>`
  stays valid.
- **Core storage type names.** `StorageConfig`, `LocalStorageConfig` and `S3StorageConfig` (main
  entry and `…/framework.js`) are the storage section types; `FrameworkStorageConfig`,
  `FrameworkLocalStorageConfig` and `FrameworkS3StorageConfig` stay as deprecated aliases.
- New error codes: `RESIZE_QUEUE_ROUTES_INVALID` (`RoutingTaskQueue` routes that are not task
  queues or builders), `RESIZE_DRIVER_INVALID` (a `drivers` entry without `fromConfig`, or a part a
  driver built that is not one) and `RESIZE_DRIVER_CONFLICT` (two `FrameworkResizer`s with
  different `drivers.queue` maps), each `ResizeSetupError` with `retryable: false`. `EnqueueIssue`
  gains the optional `causeCode`.
- **Decoders.** `SourceDecoder` (main entry) is the contract of one source kind: `formats`,
  `inspect(bytes, limits)` (identify and measure, never render), `render(bytes, box, opts)` (an
  upright 8-bit sRGB `Raster`, at least the box where the decoder's limits allow) and an optional
  `verify()`. `new Resizer({ decoders })` (and `new FrameworkResizer({ decoders })`) adds decoders,
  asked before the built-in Sharp and SVG decoders. `uploadOriginal()`, the worker and
  `generate()` read every source through them, so a new source kind (a PDF, a camera raw format)
  needs only a decoder and its format in `upload.formats`. New types: `SourceInfo`, `Raster`,
  `RasterInfo`, `DecodeBox`, `RenderOptions` and `ResizeLimits`. See "Decoders" in `README.md`.
- **Raster helpers.** `rasterToSharp(raster)` and `sharpToRaster(img)` (main entry) wrap a
  Sharp-based `beforeStep`, and its `meta.scale` maps coordinates in the source's units onto the
  raster the step receives.
- New error codes: `RESIZE_SOURCE_FORMAT_UNSUPPORTED` (`ResizeMediaError`, `retryable: false`: a
  decoder refuses bytes that are not its format, or every decoder refuses them),
  `RESIZE_DECODER_MISSING` (`ResizeSetupError`, retryable: no decoder in this process lists the
  stored format and none reads the bytes), `RESIZE_DECODER_INVALID` (`ResizeSetupError`: a
  `decoders` entry is not a decoder, or a decoder broke the contract),
  `RESIZE_PIPELINE_STEP_INVALID` (`ResizeSetupError`, retryable: a `beforeStep` resolved with
  something that is not a one-frame `Raster`, or `sharpToRaster` got a multi-page image) and
  `RESIZE_SOURCE_DECODE_FAILED` (`ResizeMediaError`, retryable: decoding failed with an error that
  is not a `ResizeError`, kept as its `cause`).

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
  `limits.animationFrames` frames, for a pipeline without `beforeSteps` or `variantSteps`; every
  other format, and every preview of a pipeline with steps (a watermark would land on one frame),
  gets the first frame instead of all frames stacked into one tall image. `actualWidth` /
  `actualHeight` are the size of one frame. `limits.sourcePixels` applies to one frame, and an
  animation with more frames than `limits.sourcePixels` or `limits.inputPixels` allow is shortened
  to the frames that fit instead of failing. An animation with an EXIF orientation is rendered from
  its first frame.
- No output side of a width-only or height-only size exceeds `limits.resultDimension`: when the
  side derived from the aspect ratio would, the image is cropped to the cap.
- Fractional size dimensions are rounded in the size key, the task and the stored preview; a
  dimension that rounds to 0 is ignored; a `fit` result is at least 1 px per side.
- An EXIF-rotated original is no longer re-encoded before resizing (no quality loss, faster);
  `beforeSteps` receive its upright pixels as a `Raster`.
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
- One read or pre-warm takes at most one lock (the gate lock, beside a task queue without
  `gatesByTask`) instead of a dispatch lock per variant, one after another.
- `package.json` points to the right repository (`adaptivestone/framework-module-resizer`).
- `NoopMetrics` declares its parameters, all optional (`0.3.0-rc.5`), so a call with arguments
  (`new NoopMetrics().count('resize.read', 1)`) type-checks and a call without them still does.
  A widening: compatible for every call, subclass and config the runtime accepts.
- A custom queue driver's `queues` entry may hold the timing keys (`leaseMs`, `retryBackoffMs`,
  `maxAttempts`, `idlePollMs`, `taskTimeoutMs`, each optional) at the type level, as the runtime
  already accepted (`0.3.0-rc.5`). A widening: compatible for every call, subclass and config the
  runtime accepts. A host section type that declared a timing key with another type (e.g.
  `maxAttempts: string`) now fails to type-check; the runtime already rejected such a value.

**Internal**

- A new CI job, `min-versions`, runs the type check, build and tests on the oldest supported Node
  major (the newest 24.x release) with every peer at the lowest version its range allows.
- The Resizer is the composition root: its services (catalog, uploader, dispatcher, reader,
  processor and the worker loop) receive only the ports they use, never the Resizer. Import-graph
  tests keep `drivers/**` to contracts, errors, helpers, types and other drivers; only entry points
  import `resizer.ts`, and nothing it reaches imports it back.
- One decode per task, at the largest box the requested previews need (with `beforeSteps`, at
  least the source's own size), and one resize per size; each format is encoded from that size's
  pixels, and a size's pixels are released after its last encode. The pure plan (`planVariants`),
  `renderSize`, `encodeVariant` and `PreviewRecorder` replace `#generatePreviews`. The Uploader
  and the Processor import no image engine: a guard test holds the list of shipped files that
  import Sharp (the decoders and their SVG helpers, the raster helpers, the renderer, the worker
  and the `variantSteps` type).
- A benchmark of the render path, `bench/renderOnce.ts` (see "Development" in `README.md`).
- The framework adapter keeps no shared queue state of its own: the queue set and each backend
  are kept in the process registry (`resetResizerForTests` forgets them), and `FrameworkResizer`
  is the config files, the app's models, logger and events over `createResizer`'s option builder.
- The factory: `createResizer` and `FrameworkResizer` share one path from a config to Resizer
  options (the image merge, the driver registry, the queue set, the peer probe); only
  `src/factory/builtins.ts` imports a driver module dynamically.
- `types:check` covers the tests and the root tooling (`tsconfig.tests.json`); `types:check:src`
  keeps the type pins (`tsconfig.type-pins.json`) against the minimum peers.
- README and AGENTS.md are checked against the exports (`src/docsExports.test.ts`).
- The smoke compiles fresh default, `--eager` and `--eject` scaffolds against the installed
  package.
- `processTask` stays internal: a pushed task would skip the worker's task lifecycle (lease
  renewal, retries, dead-letters, the gate lock). Push delivery is not supported in 0.3.0.

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
