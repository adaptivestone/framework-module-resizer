# Upgrading `@adaptivestone/framework-module-resize`

Read the section for the version you are on, and every section above it, in order from the bottom up:
a host on 0.2.x reads both. This file says what a host may have to do. Every change is in the
[changelog](./CHANGELOG.md).

## From 0.3.x to 0.4.0

Stored previews do not regenerate on this upgrade. Deploy the API and the workers together.

Push delivery is new in this release. It is optional and a preview, so it is not an upgrade step: see
[Push delivery (preview)](./README.md#push-delivery-preview).

### Before you run `npm i`

**Move `@aws-sdk/client-s3` off 3.729 to 3.734.** They are out of the peer range. On them
`limits.sourceBytes` and `adoptOriginal({ maxBytes })` run after the read, so a 3 GB object is in
memory before it is refused. npm's default resolver stops a host pinned to one of them (`ERESOLVE`),
so the install below fails. Nothing else does: `--legacy-peer-deps`, `--force`, pnpm and yarn install
them, and the module does not check the version at run time. Move to 3.735 or later.

**Add `await getResizer().verify()` after `Server.init()` (or `startServer()`).** 0.3.0 accepted the
settings below, and 0.4.0 refuses them. Unless a row says otherwise, a refusal from a config file
comes at first use or `verify()`. On a framework host with no boot `verify()`, the first `resolve()`
logs it once as an `error`, and every read then serves nothing, with no further line: **previews
stored earlier stop being served until the value is fixed.** A quiet log after that line is not a
recovery. `verify()` does not run steps, so it says
nothing about them: see [Pipeline steps](#pipeline-steps).

| Setting | Code | Fix |
|---|---|---|
| An S3 `storage.publicUrl`, which 0.3.0 ignored, so previews used the bucket's own URL. The `S3Storage` option `publicUrl` throws at construction. A `'local'` section still ignores the key, with no error | `RESIZE_CONFIG_REMOVED_KEY` | Use `publicBaseUrl`. Check the URLs it gives: the value 0.3.0 ignored applies now |
| `leaseMs`, `idlePollMs` or `taskTimeoutMs` above `2147483647`, the longest a Node timer takes. A `leaseMs` of 24.8 to 49.7 days ran on 0.3.0 | `RESIZE_CONFIG_QUEUE_LEASE_INVALID` or `RESIZE_CONFIG_QUEUE_INVALID` | Lower it. A task queue passed in code keeps serving stored previews, queues nothing, and logs once per queue name |
| `new LogMetrics(logger, { summaryIntervalMs })` above `2147483647` | `RESIZE_METRICS_INVALID`, at construction | Lower it |
| `limits.processingTimeoutSeconds` above `3600`, where every Sharp call threw | `RESIZE_CONFIG_INVALID` | Lower it |
| `rootDir: ''`, `privateRootDir: ''`, or a whitespace-only root. `new LocalFsStorage()` throws at construction | `RESIZE_CONFIG_INVALID` | Write `'.'` for `''`: it is the same folder |
| An `engine` or `decoders` key in a config. `decoders` was dropped silently, so those decoders never ran | `RESIZE_CONFIG_INVALID` | Pass each as an option, in code |
| An id in `formats`, or an `encode.formats` entry you wrote, that the engine does not write: `jxl` on the prebuilt Sharp binaries, or an id in another case, such as `JPG` | `RESIZE_ENGINE_FORMAT_UNSUPPORTED`, from `verify()` and worker start only | Remove the entry, or rename the id, which regenerates its previews |

Then upgrade, and go through the rest of this list:

```bash
npm i @adaptivestone/framework-module-resize
```

### Limits

- **`limits.sourceBytes` is new, default 256 MiB.** A host that raised `upload.maxBytes` above it has
  such uploads refused (`RESIZE_ORIGINAL_TOO_LARGE`), and tasks for larger stored originals are dead
  at once (`RESIZE_SOURCE_TOO_LARGE`). Raise it too. `verify()` logs a warning naming both. It is not
  signed, so nothing regenerates.
- **A damaged source now fails.** `limits.failOn` defaults to `'error'`: an original the engine
  refuses as cut or unreadable is dead on its first delivery (`RESIZE_SOURCE_DAMAGED`), where 0.3.0
  rendered a garbled preview. Not every damaged original is refused: a cut animated GIF can still
  render the frames it has, and damage the engine reports with an error the module does not classify
  as damage (usually a cut TIFF, or a PNG cut to its 8 signature bytes) is the retryable
  `RESIZE_SOURCE_DECODE_FAILED`, retried until `maxAttempts`. `'none'` restores 0.3.0's rendering.
  Previews already made stay fresh; to find them, see **Damaged originals** in
  [Operations](./README.md#operations).
- **`generate()` on a cut JPEG** rejects with `ResizeMediaError`, not `ResizeGenerateError`, so a
  handler catching only `ResizeGenerateError` returns 500 on a user's upload. Catch `ResizeError`, or
  refuse the file at upload with `upload.verify: 'decode'`.
- **Upload routes that branch on a code.** A decoder failure during `inspect` that is not about the
  bytes is `RESIZE_ORIGINAL_INSPECT_FAILED` (`retryable: true`), where it was
  `RESIZE_ORIGINAL_INVALID`. Sharp's pixel limit is `RESIZE_SOURCE_TOO_LARGE` at decode and
  `RESIZE_ORIGINAL_TOO_MANY_PIXELS` at upload.

### Schemas and custom drivers

- **Strict preview rows need more fields.** A hand-written schema that declares rows as strict
  sub-documents must now declare `sizeKey`, `format` and `contentType` (each `{ type: String }`) and
  `storageRef` (`{ type: 'Mixed' }`), beside `identity`, `origin` and `encodeSig`, or `verify()` throws
  `RESIZE_MONGO_MEDIA_MODEL_OUTDATED`. Spreading `resizeMediaSchemaFragment` already has them.
- **A media store that loses a field now dead-letters.** After its writes the worker reloads the
  media and compares the rows under each `storageRef` it wrote. A custom `MediaStore`, a
  `findOneAndUpdate` middleware or a strict row schema that loses `contentType`, or loses or changes
  `origin`, `encodeSig`, `sizeKey`, `format`, `resizer`, `pipeline` or `filters`, gets
  `RESIZE_MEDIA_ROW_NOT_KEPT` (`retryable: false`), where it rendered again on every read with no
  log line; so does one that loses only `storageRef`. Rows are matched by `storageRef`, so a store
  that changes a ref to another non-null value, or loses `storageRef` together with another field,
  is not detected, and a `resizer`, `pipeline` or `filters` lost while it held its default
  (`'default'`, or no filters) is no loss: a read applies the same default. Store those fields as
  given.
- **A `findOneAndUpdate` pre hook on the media model** that calls `this.where({ $or })` replaces the
  store's guard on the dimension write, with no error. Use `this.and([...])`.
- **A custom model-shaped `MongoMediaModel`** gets `$or`, `$not` and `$type` in the filter of the
  dimension write, where it got `{ _id }`, and `strictQuery: false` in its options. Accept them, as
  it accepts the update pipeline of `replacePreviews`. A Mongoose model needs nothing.
- **A host decoder's originals are private** unless the decoder sets `publicOriginals: true`
  (`RESIZE_ORIGINAL_PUBLIC_REFUSED`). A raster it marks `premultiplied` now converts in plain JS, which
  blocks the event loop (182 ms at 24 MP): that matters for `generate()` on an API route.
- **A custom `download()`** that resolves with anything but bytes gets
  `RESIZE_STORAGE_DOWNLOAD_INVALID`, where it was a raw `TypeError` or a garbled decode.
- **Types.** `upload.verify`, `limits.failOn` and `limits.sourceBytes` are required in the config type,
  so a host file with a hand-written `upload` or `limits` fails `tsc`: spread the defaults. A complete
  config passed to `new Resizer` must hold them. `FrameworkStorageConfig`,
  `FrameworkLocalStorageConfig` and `FrameworkS3StorageConfig` are gone (`TS2305` or `TS2724`; TypeScript
  may suggest `FrameworkWorkerConfig`, which is another type): use `StorageConfig`, `LocalStorageConfig`
  and `S3StorageConfig`.

### Pipeline steps

`variantSteps` now take and return a `Raster`, as `beforeSteps` do. TypeScript rejects an old step. In
plain JavaScript it fails with `img.composite is not a function`, its variant fails, and the task
retries. An old step with a `typeof img.composite === 'function'` check or a
`try { } catch { return img; }` raises no error and renders with no watermark, so search for those
too. A step that resolves with a `Buffer` or a Sharp instance fails with
`RESIZE_PIPELINE_STEP_INVALID`. `verify()` does not run steps, and stored previews stay, so a broken
step shows only on new media or new sizes: check the logs after the first upload.

```ts
variantSteps: [(img) => img.composite([{ input: logo, gravity: 'southeast' }])], // before
variantSteps: [async (r) => sharpToRaster(rasterToSharp(r).composite([{ input: logo, gravity: 'southeast' }]))], // now
```

A logo larger than a preview on either side fails on both forms (`Image to composite must have same
dimensions or smaller`): fit it first, as **Pipelines** in the
[Config reference](./README.md#config-reference) shows.

What `img.metadata()` gave is in `raster.info`: `width`, `height`, `channels`. `hasAlpha` is
`channels === 2 || channels === 4`.

- **Memory, for a pipeline with a step only.** A worker holds a copy of the size's pixels and the step's
  result per variant in progress. Measured with one `composite` step at the default `concurrency` of 4
  on a 24 MP JPEG, at 5000, 4000, 3000 and 2000 wide, in JPEG and WebP: about 975 MB peak RSS against
  about 590 MB on 0.3.0. At 1920 wide and below: about 185 MB against 130 MB. On a 24 MP PNG with
  alpha at 5000 to 2000 wide: about 1.9 GB against about 1.5 GB. A pipeline without steps pays
  nothing. Size worker containers before you deploy.
- **What a rewritten step writes.** Stored previews stay, and only new previews change. Look at the
  first ones, and bump the pipeline's `version` to remake the old ones. A single `composite` writes the
  same files on an opaque source and on every format that keeps alpha. On a flattened format and a
  transparent source it can move partly transparent pixels by at most 2 levels before the JPEG encoder,
  up to 20 of 255 measured in the JPEG. Any other step can differ:
  - on a transparent source and a flattened format, the step runs before the flatten, where Sharp ran
    it after (`negate()` also negates alpha: use `negate({ alpha: false })`);
  - several steps run in order, each on the last one's result, where 0.3.0 gathered them in one Sharp
    chain, in which a second `composite`, `blur` or `resize` replaced the first;
  - with no error: `greyscale()` on a transparent source loses alpha, and a JPEG then shows black there
    (use `modulate({ saturation: 0 })`), `toColourspace('b-w')` stays in colour, and metadata calls in
    a step do nothing.
- **New previews of a step you did not touch.** A `beforeStep` that returns
  `toBuffer({ resolveWithObject: true })` no longer shifts colours. A step that adds transparency to an
  opaque preview now gets the `encode.flatten` background, where a JPEG came out black. Bump the
  pipeline's `version` to remake stored ones.
- **Time limit.** Sharp work in a step that does not go through `rasterToSharp`
  (`sharp(raster.data, { raw: raster.info })`, or a raster spread into a new object) has no limit, where
  0.3.0 held it under `limits.processingTimeoutSeconds`. It can starve other tasks.

### Operations

- **Alerts.** The worker logs a retried failure at `warn` and a dead task at `error`, whatever the
  metrics sink. A failed variant's line is now a `warn`, so alert on `error` or on `is dead`.
- **A log search on old words.** Eager failures say `resize generate:`, not `resize worker:`. Messages
  about formats say `format id`, not `Sharp format id`.
- **A worker that consumes nothing exits 1.** Disabled, or with no task queue on any Resizer, the
  command resolves `false`, so a CLI entry that forwards the result exits 1. Do not deploy the command
  with the flag off.
- **`retryable` changed.** `ResizeOriginalError` and `ResizeConfigError` default to `false`.
  `RESIZE_TASK_MAX_ATTEMPTS`, `RESIZE_MEDIA_NO_ID` and `RESIZE_SIZE_INVALID` are now `false`.
  `RESIZE_WORKER_INCOMPLETE` and `RESIZE_GENERATE_FAILED` are `false` when every variant failed with
  `false`, and a storage refusal from a preview upload now counts as such a failure, so the task is dead
  at once, where it was retried. A missing object is `RESIZE_STORAGE_NOT_FOUND` from both shipped
  drivers. The current values are in [Error codes](./README.md#error-codes).
- **`npx --no -- resize-scaffold --check` reports nothing new** on a host scaffolded by 0.3.0, and an
  ejected model written by 0.3.0 stays current. A config it leaves alone keeps
  `publicBaseUrl: '/media'`: re-scaffolding writes the new shape, with an explicit `privateRootDir`, so
  an override that moves `rootDir` must then move it too.
- **Add `/var/` to `.gitignore`** on a host scaffolded by 0.3.0. With the scaffold's local storage,
  its private originals sit under `./var/media-private`, and no rule keeps them out of git. Append
  it at the end of `.gitignore`: a `/var/` above a `!var/`, `!/var/` or `!**/var` line leaves the
  originals unignored. `git check-ignore var/media-private/x` prints the path when the rule works.
  Files already committed stay tracked: if `git ls-files var` lists any, run
  `git rm -r --cached var` (it keeps them on disk) and commit. The 0.4.0 scaffold adds the rule
  only in the run that writes a config, and `--check` does not report it.
- **The scaffold's spelling is `npx --no -- resize-scaffold`.** Without `--no`, a run with the package
  missing installs and runs whatever the registry holds under that name. Without the `--`, npm takes the options
  for itself.
- **Debug lines.** `FrameworkResizer`'s default sink writes none: pass
  `new LogMetrics(logger, { debug: true })` to keep them.

### Visible without a change

These need no code change. A strict response schema, an API snapshot test or an alert on any
`error` line sees them:

- **`formatPictureUrls` entries carry `width` and `height`** when the stored row has them:
  `{ url, contentType, width, height }`. A size key does not promise a size.
- **A read can log one `warn` per Resizer** for a media loaded without the module's fields
  (`resize resolve: media … was loaded without its stored …`): add `...resizeMediaPaths` to the
  query's projection.
- **The database queue checks the gate index** in the background after the first added task, and
  logs one `error` line when it is missing (`… has no gate index …`, ending in
  `(code RESIZE_MONGO_INDEX_MISSING, logged once)`): create it through your migration.

### A sweep written from the 0.3.0 docs

The 0.3.0 docs said to delete preview objects no row references, with no age rule. Such a sweep can
delete the file of a row about to be written. A read still calls that row ready, neither stale nor
missing, so nothing renders it again and its URL fails.

- Fix the sweep: list the objects first and read the rows after, leave out every `original.storageRef`
  (an adopted public original sits in the same bucket), and delete only objects older than a day and
  more than twice `taskTimeoutMs`, by S3 `LastModified` or file mtime.
- Repair the damage: for a media whose preview URL fails, call `invalidate()` on it. Its rows go, and
  the next read or `prewarm()` queues them again.
- Use `onPreviewReplaced` for prompt deletes if you like, but keep the sweep if every file must go: a
  report is delivered at most once.

## From 0.2.x to 0.3.0

A host on a 0.3.0 release candidate needs only what came after its rc: see
[Upgrading from a release candidate](#upgrading-from-a-release-candidate).

### Nested storage refs

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

### Named queues: from `queue: { … }` to `queues`

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
  `satisfies PartialFrameworkResizeConfig` instead. The image settings of every file are merged
  over the package defaults, so a file may set only the keys it changes. The
  queue entry types are `QueueConfig`, `DatabaseQueueConfig` and `SqsQueueConfig` (main entry,
  re-exported by `…/framework.js`); `FrameworkQueueConfig`, `FrameworkDatabaseQueueConfig` and
  `FrameworkSqsQueueConfig` are removed.
- Every `database` entry shares one task queue, and so do the SQS entries with the same `region`,
  `endpoint`, `deadLetterQueueUrl` and `waitTimeSeconds`: one task queue per backend, and each name
  is a lane on it with its own timing. Names on different backends are routed (statement 5 below).
  `RESIZE_CONFIG_QUEUE_TIMING_CONFLICT` is gone: a queue is defined once, so two files can no longer
  disagree about its timing.

### Removed keys

Each fails with `RESIZE_CONFIG_REMOVED_KEY`, and the message says where the value goes.

| Old key | Use instead |
|---|---|
| `webpAvifOnly: true` | `formats: ['webp', 'avif']` |
| `encode.quality.<format>`, `encode.effort.<format>` | `encode.formats.<format>.quality`, `encode.formats.<format>.effort` |
| `encode.mozjpeg`, `encode.chromaSubsampling` | `encode.formats.jpeg.mozjpeg`, `encode.formats.jpeg.chromaSubsampling` |
| `encode.flattenBackground` | `encode.flatten.background` |
| `worker.concurrency` | the top-level `concurrency` |
| `queue` and `worker` in a config passed to `new Resizer` | timing goes to the task queue's `timing`; framework hosts define queues in `queues` and keep `worker` in `src/config/resize.ts` |
| `queue: { driver, … }` in a framework config file | `queues: { default: { driver, … } }` in `src/config/resize.ts`, and `queue: 'default'` |
| `queue.queues: { bulk: url }` (SQS), `queues.<name>.queues` | one `queues` entry per name: `bulk: { driver: 'sqs', queueUrl: url, … }` |
| `queue.lockTtlMs` (or `queues.<name>.lockTtlMs`, or a task queue's `timing.lockTtlMs`) | `coordination`: `dispatch` → `gateTtlMs` (a different lock: the old one held one variant for 60 s, the new one holds a queued task's media; set it to your worst queue wait), `failed` → `cooldownMs`; drop `worker` |
| `npm run cli ResizeWorker -- --config=<name>`, `runResizeWorker({ configName })` | nothing: the worker reads `worker` and `queues` from `src/config/resize.ts` |
| An S3 `storage.publicUrl`, or the `S3Storage` option `publicUrl` | `publicBaseUrl` |

### Six things to know after the upgrade

1. **`resize-scaffold --check` reports drift right after the upgrade.** It does so for every
   `src/config/resize.ts`, and every `resize.<NODE_ENV>.ts` override of it, scaffolded by an
   earlier version (a top-level `queue: { … }` object, or `defaultFrameworkResizeConfig` imported
   from `…/config/resize.js`; only full-line `//` comments are skipped, and a second Resizer's
   `configName` file is not checked), and for every ejected `ResizeTask` model. This is intended.
   To clear it:
   - rewrite the config to the new shape (above), or move it aside, re-run
     `npx --no -- resize-scaffold` and copy your settings back;
   - add `startedAt: { type: Date }` and `finishedAt: { type: Date }` to an ejected model, or
     move `src/models/ResizeTask.ts` aside (or delete it), re-run
     `npx --no -- resize-scaffold --eject`, then restore your customizations (the scaffold never
     overwrites a file, so re-running `--eject` alone changes nothing). Without them the model keeps
     working, but loses the two times.
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
   - Rows without `origin` and `encodeSig` (written by 0.2.x or earlier) are stale: each is served
     until its replacement is stored, and regenerated on its next read, `prewarm()` or
     `generate()`. The old files stay in storage, since the module never deletes them: plan the
     storage cost and clean them up (in an `onPreviewReplaced` observer, from the "resize: replaced
     … outdated preview(s)" log line, or with a sweep: list the objects first and read the rows
     after, leave out every `original.storageRef`, and delete only objects older than a day and more
     than twice `taskTimeoutMs`; see "Freshness" in `README.md`).
   - The same holds after any change of image settings or of a pipeline `version`. That
     regeneration wave shares the queue with new uploads' previews: plan worker capacity for it.
   - Roll out image settings and pipeline versions to every worker at once (or after the old
     workers have stopped): two worker versions with different settings re-make each other's rows,
     and each replaced preview costs one render, one upload and one orphaned file.
   - Rows without an `identity` are never removed by `invalidate` or `replacePreviews`, and a sweep
     never finds their files; the host deletes those rows and files itself.

### Other changes a host must make for 0.3.0

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
  delete `src/models/ResizeTask.ts` and re-run `npx --no -- resize-scaffold`
  (`--force` would also overwrite `src/resizer.ts` and `src/config/resize.ts`). An ejected or
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
  `identity`, `origin`, `encodeSig`, `sizeKey`, `format` and `contentType` in them, each
  `{ type: String }`, `storageRef` as `{ type: 'Mixed' }`, and `fit` as `{ type: Boolean }` (the
  fragment already has them, with `bytes` and `createdAt`); `resizer.verify()` throws
  `RESIZE_MONGO_MEDIA_MODEL_OUTDATED` without the first seven, and logs one warning without `fit`.
  Rows written earlier have no identity and are not migrated. A replaced row stores an `_id` exactly
  when an appended one would, unless working it out fails; one replaced under 0.3.0 has none stored
  and reads a new random one on each load until it is next replaced, so remove it by `identity` or
  with `invalidate()`. A custom model-shaped `MongoMediaModel` needs `findById` and
  `findOneAndUpdate` (and optionally `castObject`, and `schema` and `base` for a replaced row's
  `_id`), and must accept an update pipeline (statement 2). A `findOneAndUpdate` middleware on the
  media model runs once per preview write (and once for the dimension backfill) and receives a
  document with only `_id`, or `null` when the preview was already stored or the media is gone, or,
  for a backfill, when the pair is already stored; it also sees the update pipeline of
  `replacePreviews`.
- A custom `MediaStore` must implement `replacePreviews(mediaId, identities, rows)`: in one
  atomic write per media, remove every stored row whose `identity` is in `identities` or belongs
  to one of `rows`, then store `rows`, and resolve with `{ stored, removed }` (`ReplacedPreviews`),
  `removed` being exactly what that write removed. `resizer.verify()` and worker start reject a
  store without it (`RESIZE_MEDIA_REPLACE_MISSING`), and a result other than two arrays is
  `RESIZE_MEDIA_REPLACE_RESULT_INVALID`. See the `MediaStore` contract in `README.md`.
  `MongoMediaStore` and `FrameworkMediaStore` have it. It must also save `backfillDims` in
  `appendPreviews` whenever it is given, also with `previews: []`: the freshness check needs the
  original's dimensions, and without them every read of such a media queues a task that downloads
  the original.
- To remove a media's stored previews (after a pipeline's output changed, or before deleting the
  media), call `await resizer.invalidate({ media, pipeline? })` and delete the storage refs it
  returns with your own storage client: it removes this Resizer's rows that carry an `identity`
  (of one pipeline, or of all when `pipeline` is omitted), in one write, and never deletes files
  or queues. It takes no gate: a task running for that media can still store rows after it
  returns.
- Preview rows now record `bytes`, `createdAt`, `origin` and `encodeSig`, and a pipeline may set
  `version`, which is part of its rows' `encodeSig`. A row whose signatures no longer match the
  current settings is regenerated on its next read (statement 6).
- The original is never served. Code that read `isOriginal`, or relied on
  `ctx.isOwner` / `ctx.isAdmin` to get the original from `resolve()`, must change:
  to give an owner the private original, call
  `storage.signedUrl(original.storageRef, ttlSeconds)`. For a pipeline without
  `variantSteps`, a small raster original now gets a normal preview at its own
  size, made by the worker.
- SVG originals are rendered in a child process, never as markup in a pipeline
  step (`beforeSteps` receive the rendered pixels, see
  [Pipeline steps and decoders](#pipeline-steps-and-decoders)): a host under Node's permission
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
  dead-lettered (such a worker leaves it active and sets no cooldown). There are no dispatch or
  worker locks any more: the only lock is the gate lock of a task queue without `gatesByTask`
  (SQS), which lasts `coordination.gateTtlMs` until a worker extends it. An older SQS worker ignores
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
- Every public object `S3Storage` uploads (previews and public raster originals, and your own
  direct uploads) carries `Cache-Control: public, max-age=31536000, immutable`. Give your own
  direct uploads new keys, and purge your CDN when you delete one that must disappear sooner
  (browsers that already have it may keep it until it expires).
- Metrics write log lines by default: each Resizer's default sink is a `LogMetrics` on its logger,
  with one summary `info` line per Resizer per minute and one line per task outcome (a
  `FrameworkResizer`'s default also writes one `debug` line per metric). Pass
  `new FrameworkResizer({ metrics: new NoopMetrics() })` to turn them off,
  `new LogMetrics(logger)` to keep the log lines without the debug ones, or your own
  `ResizeMetrics` to send them elsewhere (see "Metrics" in `README.md`).
- With `queues` on more than one available backend (a database entry and an SQS entry whose SDK
  is installed), every `FrameworkResizer` that takes its task queue from the config file can queue
  to every name, so a custom `runWorker({ resizers })` that consumes a queue on SQS must list all
  of them, whatever their own queue (else `RESIZE_QUEUE_SHARED_RESIZER_UNLISTED`).
  `npm run cli ResizeWorker` serves every Resizer and is not affected.

### Pipeline steps and decoders

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
- `variantSteps` keep their Sharp instance, now over each size's pixels (0.4.0
  changes that again: see [Pipeline steps](#pipeline-steps)): `metadata()` reports
  the preview (`format: 'raw'`, no EXIF, ICC profile, density or orientation;
  `hasAlpha` as the sized pixels have it), a step's `resize()` resizes the preview,
  and operations Sharp used to apply before its resize (such as `trim()`) now apply
  to the preview.
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

### Upgrading from a release candidate

0.3.0 was published first as release candidates, under the npm tag `next`. A host on one of them
needs only what came after its rc. 0.3.0 itself changed nothing a host sees after `0.3.0-rc.5`.

`0.3.0-rc.1` held every host-facing shape of 0.3.0: the config, the option and type names, the
import paths, the preview fields and `invalidate`.

`0.3.0-rc.2` changed the `beforeSteps` signature and added decoders: a host on `0.3.0-rc.1`
rewrites its `beforeSteps` (see [Pipeline steps and decoders](#pipeline-steps-and-decoders)).

`0.3.0-rc.3` only added APIs a host may choose to use: `createResizer` (a Resizer from one config
object, without the framework), drivers registered by name (the `drivers` option, `fromConfig`),
`RoutingTaskQueue` and `carrierOf`, a worker that consumes several queues
(`--queue=default --queue=bulk`), and partial config files (`PartialFrameworkResizeConfig`). It
required no host change. Three things a host on `0.3.0-rc.2` may notice without changing anything:

- when `queues` spans two available backends (a database entry and an SQS entry whose SDK is
  installed), `resizer.tasks` is a `RoutingTaskQueue`, not the backend's own task queue (no
  `release`; an `instanceof MongoTaskQueue` check fails: ask `carrierOf(resizer.tasks, name)`);
- a call on a queue of another backend queues there, where `0.3.0-rc.2` reported
  `RESIZE_QUEUE_NOT_SERVED`;
- with those two backends, every `FrameworkResizer` that takes its task queue from the config
  file can queue to every name, so a custom `runWorker({ resizers })` that consumes a queue on SQS
  must list all of them, whatever their own queue (else `RESIZE_QUEUE_SHARED_RESIZER_UNLISTED`;
  `0.3.0-rc.2` accepted `runWorker({ resizers: [b], queue: 'bulk' })` beside a Resizer `a` on the
  database queue). `npm run cli ResizeWorker` serves every Resizer and is not affected.

`0.3.0-rc.4` added metrics (`ResizeMetrics`, `LogMetrics`, `NoopMetrics` and the `metrics`
option; by default one summary `info` line per Resizer per minute and one per task outcome) and the
freshness check. It required no host change, but one behaviour is visible: outdated previews (made
from another original, with other image settings or pipeline `version`, or before `0.3.0-rc.1`)
regenerate on their next read. So, for a host on an earlier rc:

- plan worker capacity and storage for that wave, which shares the queue with new uploads;
- clean up the old files, which the module never deletes (in an `onPreviewReplaced` observer, from
  the "resize: replaced … outdated preview(s)" log line, or with a sweep: list the objects first and
  read the rows after, leave out every `original.storageRef`, and delete only objects older than a
  day and more than twice `taskTimeoutMs`; see "Freshness" in `README.md`);
- roll out image settings and pipeline versions with every worker at once (or after the old
  workers have stopped): two worker versions with different settings re-make each other's rows,
  and each replaced preview costs one render, one upload and one orphaned file;
- a custom `MediaStore` must save `backfillDims` in `appendPreviews`, also with `previews: []`.

`0.3.0-rc.5` removed and renamed nothing: it widened two types (the `NoopMetrics` parameters, and
the timing keys of a custom queue driver's `queues` entry; see Fixes in the
[changelog](./CHANGELOG.md)), and
every public object `S3Storage` uploads (previews and public raster originals, and your own direct
uploads, which must use new keys) carries `Cache-Control: public, max-age=31536000, immutable`, so
purge your CDN when you delete one that must disappear sooner (browsers that already have it may
keep it until it expires).
