# @adaptivestone/framework-module-resize

Image resizing for [`@adaptivestone/framework`](https://framework.adaptivestone.com), and for
plain Node apps through the same core. Upload the **original** once; the module generates resized
**previews** with [`sharp`](https://sharp.pixelplumbing.com), stores them through a storage
driver, and turns the record on your media document into image URLs.

- **Guide:** [framework.adaptivestone.com/docs/resize](https://framework.adaptivestone.com/docs/resize)
  covers setup, workflows, pipelines, security and troubleshooting.
- **Coding agents:** read [`AGENTS.md`](./AGENTS.md), the integration guide shipped with this package.
- **Upgrading:** before you upgrade, read
  [`UPGRADING.md`](https://github.com/adaptivestone/framework-module-resizer/blob/main/UPGRADING.md):
  it lists what to change before you run `npm i`. It also ships with this package.
- **Errors:** every code is in [Error codes](#error-codes), further down this file.
- **On npmjs.com** this page stops at 64 KiB, so links to later sections do nothing there. Read the
  [whole file on GitHub](https://github.com/adaptivestone/framework-module-resizer#readme), which shows
  the default branch; the copy in `node_modules` matches your installed version.
- This README is the package overview and the reference for drivers, config and operations.

## Workflows

| Workflow | Call | Needs |
|---|---|---|
| **Eager**: previews ready when the upload finishes | `generate()` | storage + media model |
| **Pre-warm**: fast upload, previews made in the background | `prewarm()` | + a task queue and a worker |
| **Lazy**: previews only for sizes readers request | `resolve()` with a task queue | + a task queue and a worker |

All three write the same `previews[]` and read URLs with `resolve()`, so you can mix them or
switch later without migrating data. `sharp` never runs on the read path, and the original is
never served: for a pipeline without `variantSteps`, a raster original no larger than a `WxH`
size gets a preview at its own size (no upscaling, no cropping, metadata removed).

## Install

```bash
npm i @adaptivestone/framework-module-resize
```

Requires Node `>=24`. The core needs only `sharp`; every peer is optional and needed only by the
part that uses it:

| You use | Also install |
|---|---|
| `…/framework.js` (framework apps) | `@adaptivestone/framework` ≥ 5.1 and `mongoose` 9 (already in a framework app) |
| `…/drivers/mongo.js` | `mongoose` 9 |
| S3: `storage: { driver: 's3' }` or `S3Storage` (`…/drivers/s3.js`) | `@aws-sdk/client-s3` ≥ 3.572, not 3.729 to 3.734; add `@aws-sdk/s3-request-presigner` only if you call `signedUrl` |
| SQS: a `queues` entry with `driver: 'sqs'`, or `SqsTaskQueue` (`…/drivers/sqs.js`) | `@aws-sdk/client-sqs` ≥ 3.572 |

A missing optional peer fails at your own import line when you import a driver subpath. A driver
chosen in the config fails when the Resizer first loads it (the first call, or `verify()`) with
`ResizeSetupError` `RESIZE_PEER_MISSING`, which names the packages and the config file. The
presigner is loaded only by `signedUrl`, so a missing one rejects that call with
`RESIZE_PEER_MISSING` and stops nothing else. A queue whose SDK is missing beside queues on another
backend is only not served in that process (see
**Backends** under [Config reference](#config-reference)). An older
SQS client does not return receive counts, so failing tasks would never be dead-lettered;
`SqsTaskQueue` warns if that happens.

## Quick start (framework, eager)

```bash
npx --no -- resize-scaffold --eager   # src/resizer.ts + src/config/resize.ts
```

Run it after the install. `--no` refuses to fetch a package of that name from the registry when
this one is missing, and `--` hands the options to this command, not to npm.

```ts
// src/config/resize.ts
import {
  defaultFrameworkResizeConfig,
  type FrameworkResizeConfig,
} from '@adaptivestone/framework-module-resize/framework.js';

export default {
  ...defaultFrameworkResizeConfig,
  mediaModelName: 'File',
  storage: { driver: 'local', rootDir: './var/media', privateRootDir: './var/media-private',
    publicBaseUrl: process.env['RESIZE_PUBLIC_BASE_URL'] || 'http://localhost:3300/media' },
} satisfies FrameworkResizeConfig;
```

The framework serves no static files: serve exactly `./var/media` at `publicBaseUrl` (guide:
[Serve local files](https://framework.adaptivestone.com/docs/resize#serve-local-files)), and set
`RESIZE_PUBLIC_BASE_URL` in every deployed environment. In the run that writes this config, the
scaffold also appends `/var/` to `.gitignore`, because private originals must never reach version
control.

```ts
// src/resizer.ts — behaviour only; the drivers come from the config file
import { FrameworkResizer } from '@adaptivestone/framework-module-resize/framework.js';

export const resizer = new FrameworkResizer({ pipelines: { default: {} } });
```

`FrameworkResizer` builds every part from the config file on first use: the image settings, the
storage, the task queue, the media store (`FrameworkMediaStore`, over the app's media model), the
lock store (`FrameworkLockStore`, the framework's `Lock` model), used only for a queue on a backend
without `gatesByTask` (the SQS driver, or a custom queue without the flag; the database queue needs
none), and the app logger and events. Import `src/resizer.ts` wherever you
need it; a normal static import is fine. To fail at boot on a bad config, call
`await resizer.verify()` after `await server.init()`. Switch to S3 per environment in
`resize.production.ts`:

```ts
// src/config/resize.production.ts — merged over resize.ts by the framework
import type { FrameworkResizeConfig } from '@adaptivestone/framework-module-resize/framework.js';

export default {
  storage: { driver: 's3', bucketPublic: 'cdn', bucketPrivate: 'originals', publicBaseUrl: 'https://cdn.example.com' },
} satisfies Partial<FrameworkResizeConfig>;
```

Options win over the config: `new FrameworkResizer({ storage: new S3Storage({ …, client }) })`
reuses your own S3 client, `queueName: 'bulk'` sends the Resizer's tasks to another queue of
`queues`, `tasks: false` keeps a Resizer eager whatever the config says, and `drivers` registers
custom drivers by name (see [Drivers by name](#drivers-by-name)). A task queue passed as
`tasks` skips only the choice of the Resizer's queue from `queues` (its queue is the `queueName`
option, else the file's `queue`, else `'default'`, and `verify()` checks that the task queue serves
it); a `src/config/resize.ts` that exists is still read for its `coordination` (`worker` belongs to
the worker process) and validated as a whole, so a broken `queues` or `worker` section there fails
`verify()` while the Resizer's calls run in the degraded mode (see [Config
reference](#config-reference)). Passing `coordination` in code too keeps its process-wide sections
from being read: the default Resizer still reads the file for its own sections, and the worker
process reads `worker` and `queues` from it.

Add `...resizeMediaSchemaFragment` (from `…/framework.js`) to your media model's schema, then:

```ts
import { formatPictureUrls, getResizer } from '@adaptivestone/framework-module-resize';

const sizes = [{ width: 320, height: 320 }]; // a fixed catalog; never client input

// Upload handler
file.original = await getResizer().uploadOriginal({ body: buffer, visibility: 'private' });
await file.save();
await getResizer().generate({ media: file, sizes });

// Response builder
const { decision } = await getResizer().resolve({ media: file, sizes });
const picture = formatPictureUrls(decision, { id: String(file.id) });
```

`formatPictureUrls` maps each size key and format to `{ url, contentType }`. Its entries also carry
`width` and `height`, the preview's real size, when the row has them: a size key does not promise a
size, since a preview can be smaller than its box.

`generate()` stores the new rows itself and also appends them to `file.previews`, so a
same-request `resolve()` sees them. Reload the media before saving it after `generate()` or
`invalidate()`; the module wrote the rows itself (on a Mongoose document the changed `previews` is
marked modified, and saving the stale list would drop rows a worker stored since it was loaded).

**Background generation.** Run `npx --no -- resize-scaffold` (without `--eager`) to add the
`ResizeTask` model and the `ResizeWorker` command, then:

1. In `src/config/resize.ts`, define the queue and name it: `queues: { default: { driver:
   'database' } }` (tasks wait in the `ResizeTask` model; or `{ driver: 'sqs', queueUrl }`) and
   `queue: 'default'`. The scaffold without `--eager` writes both.
2. Set `worker: { enabled: true }` in `src/config/resize.ts` (its other keys take their defaults).
3. Create the indexes through your migration process, before the worker starts: the framework CLI
   that runs the worker turns Mongoose's `autoIndex` off, so the worker builds none and stops with
   `RESIZE_MONGO_INDEX_MISSING` without the gate index, on a fresh database too. On a new database
   only, an API with `autoIndex` on can build them first (Mongoose's own build at boot, no code of
   yours), and its `verify()` waits for that build. When upgrading, create the gate index through
   a migration before the new API and workers start (the order is in
   [`UPGRADING.md`](./UPGRADING.md)). A migration that runs before both always works, also when a
   new pipeline needs the worker deployed before the API requests it.
4. Run `npm run cli ResizeWorker` as a separate process (it consumes `'default'`;
   `-- --queue=default --queue=bulk` consumes several queues).

The scaffolded command is `import '../resizer.ts'` plus a re-export of the module's command, so the
worker has the same Resizers as the API. Keep that import, and run
`npx --no -- resize-scaffold --check` in CI to catch drift (`--check --eager` for an eager app). Right
after an upgrade it reports every config and ejected model written before 0.3.0: see
[`UPGRADING.md`](./UPGRADING.md#six-things-to-know-after-the-upgrade). The config file is never
diffed. The model shim extends the default export of `…/framework/ResizeTaskModel.js`, which lets
`npm run gen` type `getModel('ResizeTask')`; `--check` reports a shim from an older scaffold (fix:
delete `src/models/ResizeTask.ts` and re-run `npx --no -- resize-scaffold`; `--force` would also
overwrite `src/resizer.ts` and `src/config/resize.ts`).

## Without the framework

The main entry imports no framework code, and the shipped drivers need no framework either. With
MongoDB, a plain Node app writes one config object and one call:

```ts
import mongoose from 'mongoose';
import { createResizer, runWorker } from '@adaptivestone/framework-module-resize';

// File is your media model; its schema spreads resizeMediaSchemaFragment (…/drivers/mongo.js).
export const resizer = createResizer({
  formats: ['webp', 'avif'], // image settings, merged over the package defaults
  storage: { driver: 'local', rootDir: './var/media', publicBaseUrl: '/media' },
  database: { driver: 'mongo', connection: mongoose.connection, mediaModel: File },
  queues: { default: { driver: 'database' } }, // or { driver: 'sqs', queueUrl } (npm i @aws-sdk/client-sqs)
});

// Worker process; abort the signal on SIGTERM to stop it
await runWorker({ signal, queue: 'default', sharp: { concurrency: 1, cache: false } });
```

`createResizer(config, opts?)` returns the Resizer at once. The config (`ResizerConfig`) holds the
image settings of the [Config reference](#config-reference), merged over the package defaults (a
key you leave out takes its default; arrays and `encode.formats` replace), and the sections
`storage` (`'local'` or `'s3'`, as in a framework config file), `database` (`'mongo'`: the media
store over `mediaModel`, and the lock store and the database queue on the package's `ResizeLock`
and `ResizeTask` models, as `mongoParts` builds them), `queue` (the Resizer's queue name: a key of
`queues`, or `false`), `queues` (each name with its driver and timing) and `coordination`. Options
win over the config: `opts` takes every `new Resizer` option (`pipelines`, `hooks`, `decoders`,
`engine`, `name`, `logger`, `metrics`, …), the parts `storage`, `media`, `locks` and `tasks` (`false`: eager
only), `coordination` and `queueName`, each of which replaces what the config would build, and `drivers`
(see [Drivers by name](#drivers-by-name)). Only the drivers the config selects are loaded, so the
AWS SDKs are needed only when a section names S3 or SQS (`RESIZE_PEER_MISSING`, naming the
packages, otherwise). An object config is merged and validated at once, a function config on first
use; every part is built on first use (the first call, `ready()` or `verify()`), and nothing
connects at construction. Two `createResizer` calls build their own queues: Resizers that must
share one task queue are wired by hand, as below. Without a `storage` section or option, first use
is `RESIZE_CONFIG_STORAGE_MISSING`; without a `database` section or a `media` option,
`RESIZE_MEDIA_REQUIRED`; a `'database'` queue without a `database` section is
`RESIZE_CONFIG_INVALID`.

With strict types, a loaded Mongoose document is not a `MediaLike` (Mongoose types the nested
fields as nullable): pass it as `media: doc as MediaLike` (`import type { MediaLike }` from the
main entry), or type the model's `original` and `previews` paths with `Original` and `Preview`.

Wired by hand, the same Resizer is:

```ts
import mongoose from 'mongoose';
import { Resizer, runWorker } from '@adaptivestone/framework-module-resize';
import defaultResizeConfig from '@adaptivestone/framework-module-resize/config/resize.js';
import { LocalFsStorage } from '@adaptivestone/framework-module-resize/drivers/fs.js';
import { mongoParts } from '@adaptivestone/framework-module-resize/drivers/mongo.js';

// { media, locks, tasks }: the media store over your model, and locks and the task queue on the
// package's ResizeLock / ResizeTask models. Call it once: each call makes its own task queue, so
// spread the same parts into every Resizer.
const parts = mongoParts(mongoose.connection, { mediaModel: File }); // File spreads resizeMediaSchemaFragment (…/drivers/mongo.js)

export const resizer = new Resizer({
  config: { ...defaultResizeConfig, formats: ['webp', 'avif'] }, // optional; image settings only
  storage: new LocalFsStorage({ rootDir: './var/media', publicBaseUrl: '/media' }),
  ...parts, // to swap one part, set it after the spread: tasks: new SqsTaskQueue({ queueUrl })
});

// Worker process; abort the signal on SIGTERM to stop it
await runWorker({ signal, queue: 'default', sharp: { concurrency: 1, cache: false } });
```

An eager-only Resizer needs only `storage` and `media`: pass `media: new MongoMediaStore({ model:
File })` (also from `…/drivers/mongo.js`) instead of the parts, which also register the task and
lock models. `locks` is required only beside a task queue without `gatesByTask` (`SqsTaskQueue`,
most custom queues), which takes one gate lock per media, pipeline and queue it queues (see
[Coordination](#coordination)): without it `verify()` and the worker reject with
`RESIZE_LOCKS_REQUIRED`, and reads serve stored previews only (see [Drivers](#drivers)).
`MongoTaskQueue` keeps the gate in its own rows and uses no lock; `mongoParts` still returns a lock
store, for a Resizer that swaps in `SqsTaskQueue`. With the parts (or `database: { driver:
'mongo' }`), create the indexes of both models through your migration process (for example
`await mongoose.connection.models.ResizeTask.createIndexes()`, and the same for `ResizeLock`); the
module never creates them at runtime (`createResizeModels` sets `autoIndex: false`), and
`verify()` rejects with `RESIZE_MONGO_INDEX_MISSING` until the gate index exists (with Mongoose's
`autoIndex` on it first waits for the model's own index build).

**The worker.** `runWorker({ signal, queue?, resizers?, logger?, sharp? })` serves the Resizers in
`resizers`, by default every Resizer constructed in the process when it starts (an empty list
rejects with `RESIZE_NO_RESIZER`). The list is resolved once, at start: a Resizer constructed later
is not served. `queue` is one name or a list (default `'default'`): `queue: ['default', 'bulk']`
consumes both, with one consume loop per backend and name; a name listed twice is consumed once,
and an empty list or a blank name is `ResizeSetupError` `RESIZE_QUEUE_INVALID`. Every listed name
is checked before anything is claimed: a name that no served Resizer's task queue routes is
`RESIZE_QUEUE_NOT_SERVED` naming it (and the missing package, when its backend's SDK is not
installed), and a backend that fails to build rejects start with its own error, logged once with
the queue's name. Every claim carries the served Resizer names, so a task queue with `claimFilters`
(`MongoTaskQueue`) never hands the worker another Resizer's task. A task queue that cannot filter
claims (`SqsTaskQueue`, most custom queues) may: such a task is never run there. It is given back
to the queue for a worker that serves it, or, when the task queue cannot give tasks back (no
`release`), retried: it fails with `RESIZE_NO_RESIZER`, then dead-letters after `maxAttempts`, and
its task events are logged and dropped. The worker logs each such Resizer once. `SqsTaskQueue`
counts every receive, so there a task given back often can still use up its `maxAttempts` and be
dead-lettered by the worker that serves it. Before it claims anything, the worker readies every
listed Resizer and runs the checks of `verify()`: for each Resizer its parts, config, media store,
lock store (unless its task queue routes names to several backends), decoders and engine; then, for
each queue it consumes, the route of every listed Resizer that uses that name (the backend, built now,
the name's timing, the backend's own `verify()`, and a lock store beside a backend without
`gatesByTask`). A Resizer's own `queueName` is checked only when the worker consumes it, and each
backend and lock store is verified once, however many Resizers share it. So a Resizer that cannot
start, or whose task queue cannot be used for a consumed name (no lock store beside a queue without
`gatesByTask`, invalid timing or coordination), rejects `runWorker`. A list must name each Resizer
once (two Resizers under one name: `RESIZE_DUPLICATE_RESIZER`). Beside
a task queue the worker consumes that cannot filter claims, the list must also include every
Resizer of the process that uses that queue: otherwise the worker would claim their tasks without
running them, so it rejects with `RESIZE_QUEUE_SHARED_RESIZER_UNLISTED`. With `queues` on more
than one available backend, every `FrameworkResizer` that takes its task queue from the config file shares
one router that reaches every name, so a list for a worker that consumes a queue on SQS must name
all of them, whatever their own queue (`npm run cli ResizeWorker` serves every Resizer). For a
Resizer it does not
serve it loads only the task queue and, when a consumed backend cannot filter claims, that
Resizer's backend of the consumed name (built now), and it rejects the same way when either cannot
be loaded, since it may be a shared one. Resizers built only in other processes cannot be checked:
construct every Resizer in the worker process too. Each task runs with the Resizer named in it and
that Resizer's [coordination](#coordination), so a dead-letter gets that Resizer's `cooldownMs`.
The task events and the three task observers (`afterTaskComplete`, `onTaskFailed`,
`onTaskDeadLettered`) receive the task with `attempts` (its deliveries, this one included). The
worker awaits them in order, before its next task, up to `taskTimeoutMs`. Once it is stopping, it
waits at most 5 s after the later of the stop and the task's end, so a stop adds at most 5 s per
consume loop after the running task ends. Past either bound it logs one `warn` and goes on, and a
tap still running keeps running beside the next task. A preview observer (`onPreviewGenerated`,
`onPreviewReplaced`) runs inside its task, so it counts against `taskTimeoutMs`, during a stop too:
one that outlasts it costs the attempt (`RESIZE_TASK_TIMEOUT`), and at `maxAttempts: 1` the task is
dead, though its rows are stored. `generate()` sets no bound: a tap that never settles means
`generate()` never returns.
When a task's handler ends, the worker first waits for a lease renewal still in flight, on every
task queue (a gating one too), within the same `min(leaseMs, 30000)` ms its gate calls get: a
renewal that then answers `false` means the lease was lost, so there is no completion, failure or
event, and the task is left to its next delivery. A renewal that does not answer in that time is
logged, and the task ends without it (its gate calls are then sent without waiting).
`logger` receives the worker loop's own messages, failed gate lock calls included; a logger that
throws never stops the loop. `runWorker` resolves `true` after a run, and `false` when no Resizer has
a task queue, so the process consumes nothing (an `error` line says so). Framework hosts run
`npm run cli ResizeWorker`, which serves the Resizers that `src/resizer.ts` constructs.

## Package exports

| Import | Contents |
|---|---|
| `@adaptivestone/framework-module-resize` | The core; every name is listed below |
| `…/config/resize.js` | The framework-free core defaults: the default core config (default export), `defaultQueueOptions`, `defaultCoordination` |
| `…/drivers/fs.js` | `LocalFsStorage` (the `'local'` storage driver) and its options type `LocalFsStorageOptions` |
| `…/drivers/s3.js` | `S3Storage` (the `'s3'` storage driver) and its options type `S3StorageOptions` |
| `…/drivers/mongo.js` | `mongoParts` (and its types `MongoParts`, `MongoPartsOptions`), `MongoDatabase` (the `'mongo'` database driver), `MongoMediaStore` (and `MongoMediaModel`, `MongoMediaStoreOptions`, `MongoMediaUpdateOptions`), `MongoLockStore` (and `MongoLockModel`, `MongoLockStoreOptions`), `MongoTaskQueue` (and `MongoTaskQueueOptions`), `createResizeModels` (and `CreateResizeModelsOptions`), the schemas `resizeTaskFields`, `resizeTaskIndexes`, `resizeLockFields`, `resizeLockIndexes` and `resizeSchemaOptions`, `resizeMediaSchemaFragment`, `resizeMediaPaths` |
| `…/drivers/sqs.js` | `SqsTaskQueue` (the `'sqs'` queue driver) and its options type `SqsTaskQueueOptions` |
| `…/lambda.js` | Push delivery (preview): `createSqsHandler`, its options `SqsHandlerOptions`, and the types `SqsHandler`, `SqsEventLike`, `SqsRecordLike`, `LambdaContextLike`, `SqsBatchResponse` |
| `…/framework.js` | Framework adapter: `FrameworkResizer`, `FrameworkMediaStore`, `FrameworkLockStore`, `ResizeTaskModel`, `ResizeWorker`, `runResizeWorker`, `defaultFrameworkResizeConfig`, `defaultWorkerOptions`, `resizeMediaSchemaFragment` and `resizeMediaPaths` (re-exported), and the types `FrameworkResizeConfig`, `PartialFrameworkResizeConfig`, `StorageConfig`, `LocalStorageConfig`, `S3StorageConfig`, `FrameworkResizerOptions`, `FrameworkMediaStoreOptions` and `TResizeTask`, plus the queue entry types `QueueConfig`, `DatabaseQueueConfig` and `SqsQueueConfig` (re-exported) |
| `…/framework/ResizeTaskModel.js` | `ResizeTaskModel` as the default export, for the scaffolded model shim, and its document type `TResizeTask` |
| `…/package.json` | The package manifest (a JSON module, default export only; import it `with { type: 'json' }`), for tools that read the installed version |

**The main entry** exports:
- the Resizer and its registry: `Resizer` (its options `ResizerOptions`), `getResizer`, and the
  test-only `resetResizerForTests`;
- `createResizer`, which builds a Resizer from one config, and its types `ResizerConfig` and
  `CreateResizerOptions`;
- `runWorker`, the framework-free worker, and its options `RunWorkerOptions`;
- routing: `RoutingTaskQueue` (each queue name goes to the backend that carries it), `carrierOf`,
  and the types `Route` and `RoutingTaskQueueOptions`;
- the contracts a driver extends, with their types: `ResizeStorage` (`StorageUploadArgs`,
  `StorageDownloadOptions`), `MediaStore` (`ReplacedPreviews`), `LockStore`, and `TaskQueue`
  (`NewTask`, `TaskAddResult`, `ClaimOptions`, `ClaimedTask`, `LeasedTask`, `FailOptions`,
  `TaskEvent`, `TaskEventHandler`);
- the decoder contract `SourceDecoder` and the decoder types `SourceInfo`, `Raster`, `RasterInfo`,
  `DecodeBox`, `RenderOptions`;
- the engine contract `ImageEngine`, the default engine `SharpEngine`, and the engine types
  `EngineCallOptions`, `ResizeRequest`, `EncodeRequest`, `EncodedImage`;
- metrics: the contract `ResizeMetrics`, the sinks `LogMetrics` (its options `LogMetricsOptions`)
  and `NoopMetrics`, and the types `MetricLabels` and `MetricContext`;
- the errors: `ResizeError`, `ResizeConfigError`, `ResizeSetupError`, `ResizeMediaError`,
  `ResizeNoOriginalError`, `ResizeOriginalError`, `ResizeGenerateError`, `ResizeStorageError`,
  `ResizeSecurityError`, and their options `ResizeErrorOptions`;
- the helpers: `formatPictureUrls`, `getSizeKey`, `parseSizeKey`, `isCatalogCovered`, `hasOriginal`,
  `rasterToSharp`, `sharpToRaster`;
- the hook and pipeline types: `HookName`, `HookFn`, `HookSignatures`, `HookTaps`, `WaterfallName`,
  `ObserverName`, `Pipeline`, `BeforeStep`, `VariantStep`;
- the driver-factory types (how a config section becomes a part): `DriverRegistry`,
  `DriverContext`, `StorageDriver`, `DatabaseDriver`, `DatabaseParts`, `QueueDriver`,
  `QueueDriverContext`, `QueueEntry`, `QueueSection`;
- the data shapes and options (`src/types.d.ts`):
  - the Resizer calls: for `resolve()`, `ResolveOpts`, `SizeInput`, `ReadDecision`, `ReadyEntry`
    and `MissingPreview`; for `prewarm()`, `PrewarmOpts`, `PrewarmResult`, `PrewarmStatus`,
    `EnqueueReceipt` and `EnqueueIssue`; for `generate()`, `GenerateOpts` and `GenerateResult`;
    for `invalidate()`, `InvalidateOpts`; for `uploadOriginal()`, `UploadOriginalOpts`; for
    `adoptOriginal()`, `AdoptOriginalOpts`; and `PictureUrls`, what `formatPictureUrls` makes of a
    decision;
  - the media and preview shapes: `MediaLike`, `Original`, `OriginalFormat`, `Preview`,
    `PreviewFormat`, `PreviewScope`, `Filters`, `StorageRef`;
  - the config sections: the image settings `ResizeConfig`, `ResizeLimits` and `ResizeFailOn`, and `DeepPartial`
    for overrides; storage `StorageConfig`, `LocalStorageConfig`, `S3StorageConfig`; database
    `MongoDatabaseConfig`; coordination `CoordinationOptions`; worker `FrameworkWorkerConfig`; the
    framework config `FrameworkResizeConfig` and `PartialFrameworkResizeConfig`; the Resizer's
    other sections, `ResizerSections`, and the sections that registered drivers add,
    `StorageSectionOf`, `DatabaseSectionOf`, `QueueSectionOf`;
  - the queue entries and timing: `QueueConfig`, `DatabaseQueueConfig`, `SqsQueueConfig`,
    `QueueTimingOptions`;
  - the logger, the event bus and a part built on first use: `ResizeLogger`, `ResizeEventBus`,
    `LazyPart`.

`FrameworkWorkerConfig` and `CoordinationOptions` come from the main entry, which exports every
config type; `…/framework.js` re-exports only the config types its row names.

## Config reference

The Resizer's config holds image settings only. `new Resizer({ config })` defaults to
`…/config/resize.js`; spread it to change keys (`createResizer` and `FrameworkResizer` merge a
partial config over the defaults for you). A config object is validated when the Resizer is
created; a config function (the framework adapter passes one) on first use (`ready()`) or
`verify()`.

| Key | Default | Notes |
|---|---|---|
| `formats` | `['jpeg', 'webp', 'avif']` | Generated formats; each needs an `encode.formats` entry, and the engine must write it (see [Engines](#engines)) |
| `upload.maxBytes` | `26214400` (25 MiB) | Largest accepted original. `limits.sourceBytes` caps it too, so a larger value here accepts nothing more until that is raised as well; `verify()` logs a warning when it is above |
| `upload.formats` | `['jpeg', 'png', 'webp', 'avif', 'gif', 'svg']` | Accepted originals, detected from the bytes; a decoder must identify the format (see [Decoders](#decoders)) |
| `upload.verify` | `'none'` | `'decode'`: `uploadOriginal()` also decodes a raster original to a 16 px raster, at `limits.failOn`, before storing it. A damaged one is `RESIZE_ORIGINAL_DAMAGED`. It decodes the first frame only, so an animation damaged in a later frame can be stored, flipped bytes can pass, since a decode does not always find them, and a JPEG cut in its last rows can pass (measured at 1200×900, up to about 1% of its tail), and a larger render then dead-letters it. A vector source, such as SVG, is skipped. It costs about 0.1 s for a 24 MP JPEG and about 1 s for a 24 MP PNG on a Sharp thread, not on the event loop |
| `maxSize` | `{ width: 2000, height: 1200 }` | Box for `fit` |
| `animated` | `false` | `true`: WebP and GIF previews of an animated original keep its frames, for a pipeline without `beforeSteps` or `variantSteps`; other formats, pipelines with steps, and animations with an EXIF orientation get the first frame. `actualWidth`/`actualHeight` are one frame's size |
| `encode.formats` | jpeg `{ quality: 88, mozjpeg: true, chromaSubsampling: '4:2:0' }`, webp `{ quality: 82, effort: 4 }`, avif `{ quality: 64, effort: 4 }` | Passed to the engine's `encode` (`SharpEngine`: `toFormat(id, options)`); `{}` keeps its defaults, except `heif` and `heic`, which Sharp has no default compression for: `heic: {}` passes `verify()`, then every render fails with `Expected one of: av1, hevc for compression`, retried until dead, as on 0.3.0, and `heic: { compression: 'av1' }` writes. The engine must write each key the host wrote or changed, also one no call requests |
| `encode.sharpen` | `{ cover: true, fit: false }` | Mild sharpening after downscaling, or `false` |
| `encode.flatten` | `{ formats: ['jpeg'], background: '#ffffff' }` | Formats whose transparency is flattened |
| `limits.inputPixels` | `268402689` | Sharp's input limit on the bytes a decoder reads (one frame of an animation); pixels the module renders itself are not limited by it |
| `limits.sourcePixels` | `50000000` | Largest frame, rejected before decoding |
| `limits.sourceBytes` | `268435456` (256 MiB) | Largest original a worker, `generate()` or `adoptOriginal()` reads into memory, and largest body `uploadOriginal()` accepts whatever `upload.maxBytes` says. Over it: a task is dead-lettered at once with `RESIZE_SOURCE_TOO_LARGE`, `generate()` and `adoptOriginal()` reject with that code, and `uploadOriginal()` rejects with `RESIZE_ORIGINAL_TOO_LARGE` and stores nothing. Not signed into previews, so raising it regenerates nothing. It holds an uncompressed 8-bit TIFF at the default `limits.sourcePixels` (143 MiB), not a 16-bit one (286 MiB), which is refused. A host that holds those or long animated GIFs, or that raises `limits.sourcePixels`, raises this too |
| `limits.resultDimension` | `5000` | Largest output side for width/height sizes; when the side derived from the aspect ratio of a width-only or height-only size would exceed it, the preview is cropped to it |
| `limits.animationFrames` | `64` | Frame limit for animated input; an animation is also shortened to the frames that fit the pixel budget `min(sourcePixels, inputPixels)` at the larger of the source's size and the preview's |
| `limits.processingTimeoutSeconds` | `30` | Timeout per decode, resize and encode operation, at most `3600`, the longest Sharp accepts. A `variantStep`'s `rasterToSharp` chain, from a raster the module handed over or made from one through `sharpToRaster` (a raster read back from a `.clone()` has none), gets it too; `beforeSteps` and other host code in a step do not (see Pipelines). An AVIF encode is not interrupted by it: at effort 9 on 2000×1200, with a limit of 1 s, it ran about a minute, as on 0.3.0, and created the file. A custom engine applies it itself (see [Engines](#engines)) |
| `limits.failOn` | `'error'` | How strict decoding is: `'none'`, `'truncated'`, `'error'` or `'warning'` (Sharp's `failOn`). A source refused at this level is dead-lettered with `RESIZE_SOURCE_DAMAGED`. Not part of `encodeSig`, so changing it regenerates nothing |
| `concurrency` | `4` | Variants processed in parallel per task or `generate()` call |

**Pipelines** (`pipelines` of `new Resizer` or `new FrameworkResizer`, fixed at construction) are
`{ beforeSteps?, variantSteps?, version? }`. `version` is an optional string that is part of every
preview row's `encodeSig`: bump it when a step's output changes, and the pipeline's stored
previews are regenerated on their next read, `prewarm()` or `generate()` (see
[Freshness](#freshness)). It is not validated, and `''` signs differently from an absent version.

A `beforeStep` is `(raster, { media, source, scale, ctx }) => Raster` (or a promise of one). It
runs once per task, before any resize, on the decoded first frame as a `Raster` (`{ data, info }`:
raw 8-bit sRGB pixels, upright, with `info.width`, `info.height` and `info.channels`), and resolves
with one frame of pixels, which replaces the current raster. Steps see pixels, not a library
object, because the image engine is replaceable. A Sharp-based step stays one line with the
helpers from the main entry:

```ts
import { rasterToSharp, sharpToRaster } from '@adaptivestone/framework-module-resize';

const pipelines = {
  photo: {
    beforeSteps: [
      // async (r) => sharpToRaster(rasterToSharp(r).blur(5)), // e.g. blur plates: a Raster in, a Raster out
    ],
  },
};
```

`source` is the decoder's `SourceInfo` for the original. For a raster source the step sees the
upright original at its own size; a vector source (SVG) is rendered at least at its natural size
and can be larger, so multiply coordinates stored in the source's units by `scale` (the width of
the raster the step receives divided by `source.width`). When a step changes the size, every
variant is planned from its result. A `beforeStep` or `variantStep` that resolves with anything that
is not a one-frame `Raster` (a `Buffer`, a Sharp instance, a raster whose `data` length does not
match its `info`) fails with `ResizeSetupError` `RESIZE_PIPELINE_STEP_INVALID`, and so does
`sharpToRaster` given a multi-page image.

A `variantStep` is `(raster, { variant, ctx, media, source }) => Raster` (or a promise of one). It
runs per variant, after the resize and before the encode, on one frame of that size's pixels, and
resolves with one frame. Read the preview's size from `raster.info` (`width`, `height`, `channels`).
The raster is the step's own copy, so the step may write to it, and the formats of one size never
see each other's marks. A `resize()` in a step resizes the preview, and operations Sharp used to
apply before its resize (such as `trim()`) apply to the preview. The `encode.flatten` decision reads
the channels of the last step's result, so transparency a step adds is flattened on a flattened
format. `media` is the live object, so read it and never write to it: a write reaches the next
variant and your own document. `MediaLike` has no host fields, so TypeScript needs a cast.

```ts
variantSteps: [
  async (r) => {
    const { width, height } = r.info;
    const input = await sharp(logo)
      .resize(Math.ceil(width / 4), Math.ceil(height / 4), { fit: 'inside', withoutEnlargement: true })
      .toBuffer();
    return sharpToRaster(rasterToSharp(r).composite([{ input, gravity: 'southeast' }]));
  },
],
```

Fit the overlay on both sides, with `.resize(w, h, { fit: 'inside', withoutEnlargement: true })`: Sharp
refuses one larger than the preview on either side (`Image to composite must have same dimensions or
smaller`). Scaled by `r.info.width` alone, a 400×400 logo failed on 6 of 9 variants of a 4000×300
banner. `withoutEnlargement` keeps a smaller logo at its own size: without it, a 64×64 logo came out
300×300 on a 1600×1200 preview. `composite` on an opaque preview returns 4 channels with
alpha 255, which costs an AVIF about 200 bytes per file, which matters only on very flat images: add
`.removeAlpha()` when `r.info.channels === 3`.

A `rasterToSharp` chain in a `variantStep`, from a raster the module handed over or made from one
through `sharpToRaster` (a raster read back from a `.clone()` has none), runs under
`limits.processingTimeoutSeconds`: past it Sharp rejects, and only that variant fails. Each chain and the encode have their own limit, so the longest a variant holds a
thread is (chains + 1) × the limit. The chain's own `.timeout({ seconds: 60 })` replaces the limit on
that chain, and `.timeout({ seconds: 0 })` turns it off there. The limit follows those raster objects,
so a raster spread into a new object or built by the step has none, and neither has a fresh `sharp()`.
It does not cross a duplicate copy of the package: `rasterToSharp` from a second copy reads no limit,
with no error, so dedupe the package.

Nothing else in a step is bounded: Sharp work that does not go through `rasterToSharp`, such as
`sharp(raster.data, { raw: raster.info })`, and any other host code. `beforeSteps` are unbounded too,
through `rasterToSharp` as well, as in 0.3.0. Such work can starve other tasks and dead-letter healthy
ones, because stuck Sharp calls hold libuv's threads: with 4 slow variants beside one healthy task, at
`taskTimeoutMs` 2000 and `maxAttempts` 3, the healthy task was dead after about 12 s with no previews,
where a limit of 1 s let it complete in 1.5 s. A worker's `taskTimeoutMs` ends the task but not its
variants in progress: each keeps its thread and memory until it ends, and can still store its row. So
a step slower than `taskTimeoutMs` still stores its row, and the next delivery finds it fresh and
completes, if one is left. With none left, because the step outlasts them (5000 ms at `taskTimeoutMs`
1000) or `maxAttempts` is 1, the task ends dead with its row stored, as on 0.3.0. Such a late write can
also replace a newer row, even one from a newer original: the next
read finds that row stale and queues it again. `generate()` has no such bound.

A single step that only composites an overlay writes the same files as 0.3.0 on an opaque source
(with `png` added to `encode.flatten.formats`, it writes RGB where 0.3.0 wrote RGBA, with no pixel
difference) and on every format that keeps alpha. On a flattened format, a transparent source can
move wherever the preview has partly transparent pixels: at most 2 levels before the JPEG encoder, up
to 20 of 255 measured in the JPEG. Other steps can write different files, on new previews only:
`encodeSig` does not change, so stored previews stay, and `verify()` does not run steps, so look at
the logs and the files after the first upload.

- On a transparent source and a flattened format, the step now runs before the flatten, where Sharp
  ran it after, so most operations change that format's pixels. `negate()` also negates alpha: use
  `negate({ alpha: false })`. `removeAlpha()` shows the colours under transparent pixels, which are
  black after a resize.
- Several steps now run in order, each on the last one's result, where 0.3.0 gathered them in one
  Sharp chain: a second `composite`, `blur` or `resize` replaced the first, and Sharp chose the order.
- `sharpToRaster` reads raw sRGB pixels, so three things go wrong with no error. `greyscale()` on a
  transparent source loses alpha, so a JPEG shows the colours under transparent pixels, which are
  black after a resize: use `modulate({ saturation: 0 })`. `toColourspace('b-w')` stays in
  colour: use `greyscale()` on an opaque source, or `modulate({ saturation: 0 })`. Metadata calls in a
  step do nothing: `withMetadata`, `withExif` and `keepExif` add nothing, so a copyright set this way
  disappears, and `withIccProfile` also shifts the colours, so leave it out.

**Rounding.** Preview sizes are computed from the source's display dimensions and rounded once
per side, so a preview side can differ by one pixel from what Sharp derived in earlier releases,
or from a host's own rounding.

**Queue name.** `queueName` (`new Resizer({ queueName })` or `new FrameworkResizer({ queueName })`,
default `'default'`; a `FrameworkResizer` without it takes its file's `queue`) names the queue of the
Resizer's tasks. `resolve()` and `prewarm()` take a per-call `queue`, and a worker consumes one queue
or several (`runWorker({ queue })` with a name or a list, `npm run cli ResizeWorker -- --queue=<name>`,
which may be repeated). A string `queueName` is
readable as `resizer.queueName` at once. A name given as a function, as the framework adapter does
for a name from the config file, is read on first use: until `await resizer.ready()` or the first
call, `resizer.queueName` throws `RESIZE_NOT_READY`. A `queueName` that is not a non-empty string,
and the old `queue` option, are `ResizeSetupError` `RESIZE_QUEUE_INVALID`; `resizer.queue` is gone.
`verify()` and the worker reject a `queueName` that the Resizer's task queue does not serve
(`RESIZE_QUEUE_NOT_SERVED`).

Queue timing belongs to the **task queue**: `timing` (every name's) and `getTiming(queue)` (one
name's; when it gives none, `timing` applies) on `MongoTaskQueue` and `SqsTaskQueue`, and `timing`
on `mongoParts` (one timing for every name). A framework app sets it per queue, in each `queues`
entry of `src/config/resize.ts` (below), validated with the file on first use. The core reads a
name's timing once, on that name's first use, and validates it: in `verify()` for the Resizer's own
`queueName`, at worker start for each name the worker consumes, and on a call's first use of the
name, where `prewarm()` reports every variant `unconfirmed` with one non-retryable
`RESIZE_ENQUEUE_INTERNAL_ERROR` issue carrying the timing error, and `resolve()` logs it once per
queue name and serves the stored previews (see `ready()` under [Drivers](#drivers)). This holds for
the Resizer's own queue too: its invalid timing is not logged when the Resizer starts, but on the
first read of that queue. A builder route of a `RoutingTaskQueue` takes its timing from the
router's `getTiming` option (the factory fills it from each entry). How long locks last is not timing: it is the Resizer's [coordination](#coordination). The timing defaults
are `defaultQueueOptions` in `…/config/resize.js`:

| Option | Default | Notes |
|---|---|---|
| `leaseMs` | `60000` | Set to at least ~2× the slowest encode |
| `retryBackoffMs` | `{ base: 5000, max: 300000 }` | Retry delay |
| `maxAttempts` | `5` | Every lease counts, including reclaimed ones |
| `idlePollMs` | `1000` | Polling interval of an idle worker (a claim that waited counts toward it); each poll is one indexed query on Mongo. The claim index does not hold the Resizer, so a claim reads past every due task of a Resizer that no worker on the queue serves: give a Resizer that has no worker its own queue. Claim errors back off from it up to 10× |
| `taskTimeoutMs` | `600000` | A longer task is failed |

`leaseMs`, `idlePollMs` and `taskTimeoutMs` can be at most `2147483647` (about 24.8 days), the
longest a timer can wait: a larger value is `RESIZE_CONFIG_QUEUE_LEASE_INVALID` or
`RESIZE_CONFIG_QUEUE_INVALID`.

Sharp process tuning is a worker option: `runWorker({ sharp: { concurrency, cache } })`. Keep
`concurrency × sharp.concurrency ≈ CPU cores`.

**Framework config files.** Each `FrameworkResizer` reads its own file (`configName`, default
`'resize'`: `src/config/resize.ts`). The framework merges `<name>.<NODE_ENV>.ts` over it (objects
merge field by field, arrays are replaced). The module then merges the image settings of the
result over the package defaults, the same merge as `createResizer`'s: plain objects key by key at
any depth, arrays and `encode.formats` replaced as a whole, and a key set to `undefined` taking its
default. Only the image settings are merged; `storage` and the other sections are read as the files
hold them. So a file may set only the image keys it changes, and a complete file reaches the
Resizer with its own objects. Its messages name both files
(``src/config/<name>.ts (or its <name>.<NODE_ENV>.ts override)``). The scaffolded file spreads
`defaultFrameworkResizeConfig` from `…/framework.js` (the image settings above) and adds that
Resizer's own sections, which only `FrameworkResizer` reads:
- `mediaModelName` (required): the host media model, used by `FrameworkMediaStore`.
- `storage`: `{ driver: 'local', rootDir, publicBaseUrl, privateRootDir? }` or `{ driver: 's3',
  bucketPublic, bucketPrivate?, publicBaseUrl?, region?, endpoint?, forcePathStyle? }`. Required
  unless the code passes `storage`. S3 is imported only when selected; credentials come from the
  AWS SDK's default chain. Switching the driver in an environment file keeps the other keys of
  the merged section, so set `publicBaseUrl` there too. A custom storage driver passed in
  `drivers` adds its own section (see [Drivers by name](#drivers-by-name)).
- `queue`: the name of the queue its tasks go to (a key of `queues`), or `false` for eager only.
  Missing, it is `'default'` when `queues` has entries, and eager only when there are none. A name
  that `queues` does not define, the implied `'default'` too, is `ResizeConfigError`
  `RESIZE_CONFIG_QUEUE_UNKNOWN` (a config error on first use and in `verify()`). Any other value
  that is neither a name nor `false` is `RESIZE_CONFIG_INVALID`, except a `queue: { … }` object,
  the old shape, which is `RESIZE_CONFIG_REMOVED_KEY` (below). The `queueName` option wins over it.

`src/config/resize.ts` also holds the **process-wide** sections, which every Resizer of the process
and the worker use. They are read only from that file: in another file, or in the
`FrameworkResizer` `config` option, each is `RESIZE_CONFIG_INVALID` naming the key.
- `queues`: every queue, by name, each defined once (`Record<string, QueueConfig>`). An entry is a
  driver plus that queue's timing:

  | Key | For | Notes |
  |---|---|---|
  | `driver` | both, required | `'database'`: tasks in the app's `ResizeTask` model (`DatabaseQueueConfig`); `'sqs'`: an SQS queue of its own (`SqsQueueConfig`, needs `@aws-sdk/client-sqs`); or the name of a queue driver passed in `drivers` |
  | `queueUrl` | `sqs`, required | This name's SQS queue; two entries with the same URL are `RESIZE_CONFIG_INVALID` |
  | `deadLetterQueueUrl` | `sqs`, optional | Dead tasks are sent here with their error, then deleted; without it they are logged and deleted |
  | `waitTimeSeconds` | `sqs`, `10` | Long poll per claim (0–20) |
  | `region`, `endpoint` | `sqs`, optional | The SQS client's; credentials come from the AWS SDK's default chain |
  | `leaseMs`, `retryBackoffMs`, `maxAttempts`, `idlePollMs`, `taskTimeoutMs` | both, optional | This queue's timing (the table above); the rest default |

  A `queues` that is not an object of names, a blank name, an entry without a non-empty `driver`,
  or an SQS entry without `queueUrl` is `RESIZE_CONFIG_INVALID`; an invalid timing value keeps its
  own code (`RESIZE_CONFIG_QUEUE_INVALID`, `RESIZE_CONFIG_QUEUE_LEASE_INVALID`) and its message
  names the entry. Every entry is validated with the file, on first use. A driver name that the
  Resizer does not have (neither `'database'`, `'sqs'` nor a name in its `drivers`) passes the file
  read and is `RESIZE_CONFIG_INVALID` when the Resizer first reads `queues` (its first use or
  `verify()`); a disabled worker never checks it: it logs a `warn`, and the command resolves
  `false`, so a CLI entry that forwards the result, as the framework docs require, exits 1. An entry
  set to `undefined` is not defined: set one to `undefined` in an environment file to remove it there (a
  Resizer that still names it gets `RESIZE_CONFIG_QUEUE_UNKNOWN`).
- `worker`: `{ enabled, sharpConcurrency, sharpCache }` for the `ResizeWorker` command
  (`defaultWorkerOptions` from `…/framework.js`: `false`, `1`, `false`). Every key is optional and a
  missing one takes its default, so an environment file may set only `worker: { enabled: true }`; a
  wrong type, or an unknown key (a misspelled `sharpConcurency`, say), is `RESIZE_CONFIG_INVALID`
  naming the key. `enabled` allows the command to run.
- `coordination`: `{ gateTtlMs, cooldownMs }` for every Resizer of the process (missing values take
  `defaultCoordination`); see [Coordination](#coordination). `new FrameworkResizer({ coordination })`
  sets one Resizer's instead.

A missing `src/config/resize.ts` means no queues, the default `worker` and the default
`coordination`. Only `queue: false` in the Resizer's own file (with no `queueName` option),
`tasks: false` in code, or a task queue and `coordination` both passed in code keep a Resizer from
reading `src/config/resize.ts`; every other Resizer validates that whole file on first use. A
malformed `queues` or `worker` section there then fails in one of two ways:

- A Resizer that takes its task queue from the file (its queue name from the file or from the
  `queueName` option), or whose file sets no `queue` (it reads `queues` to learn whether it is eager
  only or on `'default'`): its first call and its `verify()` fail. `uploadOriginal()`, `generate()`
  and `invalidate()` throw the config error (e.g. `RESIZE_CONFIG_INVALID`), and `resolve()` and
  `prewarm()`, which never throw, return the empty decision and `incomplete`, so even stored
  previews are not served until the file is fixed.
- A Resizer with a task queue passed in code (and no `coordination` in code) reads the file only
  for `coordination`, so a broken file is the degraded mode of an invalid `coordination`: it is
  logged once, reads serve stored previews and queue nothing, `uploadOriginal()`, `generate()` and
  `invalidate()` work, and `verify()`, `prewarm()` and worker start report it.

`src/config/resize.ts` needs `mediaModelName` only while the default Resizer reads it as its own
file.

Every file writes `satisfies FrameworkResizeConfig`: `src/config/resize.ts` and each other
Resizer's file. Two files write `satisfies Partial<FrameworkResizeConfig>` instead: an environment
override, and a `resize.ts` that holds only the process-wide sections (no default Resizer, so no
`mediaModelName`). An override that leaves out nested keys (only `limits.sourcePixels`, say) writes
`satisfies PartialFrameworkResizeConfig` (from `…/framework.js`), which makes every object optional
key by key at any depth (arrays and `encode.formats` stay whole); `Partial<FrameworkResizeConfig>`
stays valid for a file that leaves out only top-level keys. With custom drivers, both types take the
driver registry: `FrameworkResizeConfig<{ storage: { gcs: typeof GcsStorage } }>`. A full
`src/config/resize.ts` with three queues, and a second Resizer's file:

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
  queue: 'default', // the default Resizer's queue

  // process-wide sections, read only from this file
  queues: {
    default: { driver: 'database' },
    bulk: { driver: 'database', leaseMs: 120_000 }, // the same backend, its own timing
    audit: { driver: 'sqs', queueUrl: 'https://sqs…/audit' }, // another backend, routed by name
  },
  worker: { ...defaultWorkerOptions, enabled: false },
  // coordination: { gateTtlMs: 600_000, cooldownMs: 600_000 },
} satisfies FrameworkResizeConfig;
```

```ts
// src/config/resizeListings.ts — new FrameworkResizer({ name: 'listings', configName: 'resizeListings' })
import {
  defaultFrameworkResizeConfig,
  type FrameworkResizeConfig,
} from '@adaptivestone/framework-module-resize/framework.js';

export default {
  ...defaultFrameworkResizeConfig,
  mediaModelName: 'Listing',
  storage: { driver: 'local', rootDir: './var/listings', publicBaseUrl: '/listings' },
  queue: 'bulk', // a name from `queues` in src/config/resize.ts; no queues, worker or coordination here
} satisfies FrameworkResizeConfig;
```

**Backends.** The entries on one backend share one task queue, built once per process: every
`database` entry is one backend (the app's `ResizeTask` model), the SQS entries that share
`region`, `endpoint`, `deadLetterQueueUrl` and the effective `waitTimeSeconds` (unset counts as 10)
are one backend, one `SqsTaskQueue` with a name → URL map, and a custom queue driver groups its
entries with `backendOf`. Each name is a lane on its backend's task queue, with its own timing.

Names on different backends route through a `RoutingTaskQueue` (see [Drivers](#drivers)). When
`queues` spans more than one available backend, `resizer.tasks` is a `RoutingTaskQueue` over them:
it has no `release`, its `findActive` asks the backend of the name, and a check such as
`resizer.tasks instanceof MongoTaskQueue` no longer finds the database queue. Use
`await carrierOf(resizer.tasks, 'default')` (main entry), which gives the backend of a name on any
task queue. With one available backend, `resizer.tasks` is that backend's task queue, as before.

- **With several backends, a backend is built when one of its names is first needed:** a call on
  it, `verify()` for the Resizer's own queue, or a worker that consumes it. A database Resizer
  beside an SQS entry it never uses never loads the SQS driver. A build that fails is forgotten
  (the next need builds again) and affects only that backend's names. With a single available
  backend, it is built when the task queue part loads: on the Resizer's first call of any kind,
  `ready()` or `verify()`.
- **Each call is gated by its queue's backend:** on a database queue the task row is the gate; on
  an SQS queue the gate lock in the Resizer's lock store (see [Coordination](#coordination)).
  Retries, the dead-letter cooldown and the shutdown give-back use the same backend's gate.
- **A backend whose SDK is not installed is not served in that process.** A call on one of its
  names queues nothing (`prewarm()` reports `RESIZE_QUEUE_NOT_SERVED`, its message names the
  package, and `resolve()` logs it once per queue name), and a worker given one of its names
  refuses to start with the same code and package. `verify()` rejects with `RESIZE_PEER_MISSING`
  when it is the Resizer's own queue. When no backend is available at all, the task queue fails
  with `RESIZE_PEER_MISSING`, as before.
- **The `Lock` model** of a framework app is checked by `verify()` only when the Resizer's own
  queue is on a backend without its own gate (SQS), and by the worker only for each such queue it
  consumes: a worker checks only the queues it consumes, never a served Resizer's own queue
  otherwise. A database Resizer beside SQS queues needs no `Lock` model.

A call on a name that `queues` does not define queues nothing (`RESIZE_QUEUE_NOT_SERVED`, see
[`prewarm()` issues](#prewarm-issues); `resolve()` logs it once per queue name). So an environment
override may move only some queues to another backend (only `queues.default` to SQS, say, while
`queues.bulk` stays on the database): both names keep working, and one worker consumes both with
`npm run cli ResizeWorker -- --queue=default --queue=bulk`.

Without the framework, buckets, URLs and queue URLs are driver options. Removed keys fail with
`RESIZE_CONFIG_REMOVED_KEY`, and the message says where the value goes: see
[Removed keys](./UPGRADING.md#removed-keys).

### Coordination

A Resizer with a task queue keeps one **gate** per Resizer, media, pipeline and queue: at most
one of their tasks is active at a time, whether it is queued, running, waiting for a retry, or
cooling down after a dead-letter. While the gate is held, a read that finds variants missing
queues nothing, whatever variants the active task covers: a new size for that media waits for the
active task, and the next read after the task ends queues it. So 1000 concurrent reads of a cold
media create one task. A request on another queue is a separate task, as before the gate: a
`prewarm({ queue: 'bulk' })` waiting for a bulk worker never blocks reads on `'default'` (the media
may then be rendered on both; the media store keeps one row per preview identity).

- On `MongoTaskQueue` (`gatesByTask`) the task row is the gate. Its `active` field is `true` from
  `add()` until the task completes, through its retries, and a unique index on
  `{ resizer: 1, fileId: 1, pipeline: 1, queue: 1 }` with `partialFilterExpression: { active: true }`
  lets one row per gate be active (`verify()` rejects with `RESIZE_MONGO_INDEX_MISSING` until it
  exists). A dead row keeps the gate until its `cooldownUntil` (`deadAt` + `cooldownMs`); the next
  `add()` after that retires it (`active: false`, its `error` kept) and inserts a new row. No lock
  is taken.
- On a task queue without `gatesByTask` (`SqsTaskQueue`, most custom queues) the gate is one lock in
  the Resizer's `LockStore`, `resize_gate:<resizer>:<queue>:<mediaId>:<pipeline>` (each part
  URI-encoded). The core takes it for `gateTtlMs` with a fresh random owner when it queues a task,
  and the owner travels in the task as `gateOwner`. When the queue does not confirm that it stored
  the task (`unconfirmed`, a throw), the task may still be stored, so an ambiguous enqueue keeps the
  gate for one lease (`leaseMs`, at most `gateTtlMs`) instead of releasing it: a stored task is
  claimed and extended within it, otherwise it lapses and a later read queues the task, unless the
  add was `unconfirmed` with `retryable: false`: calling again cannot help until someone fixes what
  `causeCode` names. The worker extends the lock: to
  one lease plus one heartbeat interval (`leaseMs / 2`) when the task starts and on every
  heartbeat, so a redelivery after a worker crash still finds it held; to the retry time plus one
  lease after a failed attempt; to `cooldownMs` after a dead-letter; and to `gateTtlMs` when it
  gives a task back (at shutdown, or a task it does not serve). When an extend finds the lock lapsed
  while the task runs, or for the retry and cooldown holds, the worker takes it back under the
  task's owner, unless another request has taken the gate meanwhile. It releases the lock when the
  task completes. Once a delivery's lease is known to be lost (a renewal still in flight when the
  task ends is awaited first), the worker makes no call for it at all (no completion, no gate
  call). Every lock store call waits at most `min(leaseMs, 30000)` ms, and a task's end waits that
  long at most for its renewals and all its gate calls, so a hanging lock store never holds the
  worker; a call that does not answer in time is logged as failed, with the wait it was given. The
  task's final gate action (the release, or the retry, cooldown or give-back hold) comes after the
  calls made while it ran; one of those that answers after the final action (a slow store) is
  followed by the final action again, so a late extend cannot cut a cooldown short, nor a late
  re-take re-create a released lock. This gate is best
  effort across a lost lease, an ambiguous enqueue (one lease) and a lock store failure: at worst a
  second task renders the same variants, and the media store keeps one row per preview identity.

There are no per-identity locks. The lease keeps a task with one worker at a time, its token fences
every write, and `appendPreviews` keeps one row per preview identity when an expired lease lets two
workers render the same variant.

| Option | Default | Notes |
|---|---|---|
| `gateTtlMs` | `600000` | How long the gate lock of a QUEUED task holds its media, pipeline and queue before a worker starts the task (from then on the worker extends it per lease), and how long a task given back holds it again. Raise it when tasks wait longer in the queue. Only a task queue without `gatesByTask` takes the lock; `MongoTaskQueue` ignores the value |
| `cooldownMs` | `600000` | After a task is dead-lettered, no new task for that media, pipeline and queue is queued for this long. The cooldown is per queue, like the gate: a dead task holds only its own queue's gate, so a poison task gets one `maxAttempts` cycle on each queue it is sent to. On Mongo a dead row is kept ~30 days (its TTL index), so a longer cooldown ends when the row expires |

Pass it as `new Resizer({ coordination: { gateTtlMs, cooldownMs } })` (or a function returning it)
or `new FrameworkResizer({ coordination })`, or set the process-wide `coordination` section of
`src/config/resize.ts`. Missing values take `defaultCoordination` from `…/config/resize.js` (the
types are `CoordinationOptions`); an eager-only Resizer never reads it. Only the core validates
it, when the Resizer sets up its task queue: a section that is not an object, or a value that is
not a positive safe integer (ms), is `ResizeConfigError` `RESIZE_CONFIG_COORDINATION_INVALID` (the
message names the key, or the value when the whole section is wrong); `0` is rejected for both
values (the minimum is 1 ms), so the cooldown cannot be turned off. It degrades like a task queue
that cannot be used (see `ready()` under [Drivers](#drivers)), in a config file too, and a section set to
`null` is invalid, not the defaults. No value depends on the queue's lease. Each dead-letter gets
the `cooldownMs` of the task's own Resizer.

## Drivers

A `Resizer` takes four parts:
- `storage` (required, a `ResizeStorage`): files;
- `media` (required, a `MediaStore`; `RESIZE_MEDIA_REQUIRED` without it): media documents and
  their previews;
- `locks` (a `LockStore`): the gate locks of a task queue without `gatesByTask` (`SqsTaskQueue`,
  most custom queues), and required beside one (`RESIZE_LOCKS_REQUIRED` from `verify()`; beside a
  `RoutingTaskQueue`, only for the names on such a backend); neither `MongoTaskQueue` nor an
  eager-only Resizer needs one;
- `tasks` (queued workflows, a `TaskQueue`): where tasks wait — `mongoParts(…).tasks`, an
  `SqsTaskQueue`, or a `RoutingTaskQueue` over several backends (below).

The core owns the queue logic (the worker loop, lease heartbeat, task timeout, retry with backoff,
dead-lettering, the gate lock of a task queue without `gatesByTask`, and events), so every queue
behaves the same; adapters only implement atomic operations. Drivers receive no `app` argument;
each one uses its own clients. `FrameworkResizer` builds `FrameworkMediaStore` (the app's media
model) and uses the scaffolded `ResizeTask` model as its database queue; it builds
`FrameworkLockStore` (the framework's own `Lock` model) beside a task queue without `gatesByTask`
(the SQS driver, or a custom queue without the flag) or one that routes names to several backends,
and reads the `Lock` model only for a queue on a backend without `gatesByTask`, so an app whose
queues are all database queues needs no `Lock` model. Any part may also be a function (sync or
async), called once on first use: `new Resizer({ storage: async () => …, media, locks, tasks })`.
`await resizer.ready()` loads them; the Resizer's own methods and the worker do it for you. After
loading, `ready()` validates the image config (a config given as a function is read here), then
sets up the task queue (a lock store beside a queue without `gatesByTask` that does not route
names to several backends, and a valid [coordination](#coordination), read here when it is a
function), then builds the Resizer's services. A part that does not load or an invalid config rejects; a broken framework config file
therefore fails as a config error, never as a task queue failure. A task queue that cannot be used
does not reject: the error is logged once, `resolve()` serves the stored previews and queues
nothing, `uploadOriginal()` and `generate()` work, `prewarm()` returns `incomplete` with a
non-retryable `RESIZE_ENQUEUE_INTERNAL_ERROR` issue carrying the error, and `verify()` and the
worker reject with it (`RESIZE_LOCKS_REQUIRED`, `RESIZE_CONFIG_COORDINATION_INVALID`). A queue
name's timing is not part of that set-up: the core reads and validates it per name, in `verify()`
for the Resizer's own `queueName`, at worker start for each name the worker consumes, and on each
call. An invalid one (`RESIZE_CONFIG_QUEUE_*`, or `RESIZE_CONFIG_REMOVED_KEY` for a `lockTtlMs`
left in the queue's own `timing`) makes `verify()` and the worker reject, `prewarm()` report a
non-retryable `RESIZE_ENQUEUE_INTERNAL_ERROR` issue, and `resolve()` log it once per queue name,
on that name's first read, while it serves the stored previews; it is no longer logged when the
Resizer starts. `verify()` also runs the drivers' own checks, among them
`MongoTaskQueue`'s (`RESIZE_MONGO_MODEL_MISSING`, `RESIZE_MONGO_MODEL_OUTDATED`,
`RESIZE_MONGO_NOT_CONNECTED`, `RESIZE_MONGO_INDEX_MISSING`); `MongoTaskQueue.verify()` reads the
database, so call it once the connection is open or opening. Call `verify()` at
boot so such a misconfiguration stops the deploy instead of degrading reads. (`FrameworkResizer`
validates every `queues` entry of `src/config/resize.ts` with the rest of the file, so there
invalid timing is a config error on first use; the file's `coordination` section goes to the core
as it is, so an invalid one degrades as above.) The next call retries what failed
(a part that did not load, a config that did not validate, a task queue that could not be set up)
and keeps the parts that loaded.

**`LocalFsStorage`**

| Option | | |
|---|---|---|
| `rootDir` | required | Public previews go here; serve exactly this directory |
| `publicBaseUrl` | required | URL prefix, e.g. `/media`; `''` gives root-relative URLs |
| `privateRootDir` | optional | Private originals; default `rootDir` + `-private`, and never inside `rootDir` |

`rootDir` and `privateRootDir` must hold more than whitespace (`RESIZE_CONFIG_INVALID`): an empty one
resolves to the working directory, and `'.'` says that on purpose. Never serve a parent of `rootDir`,
because `privateRootDir` sits beside it by default and the module cannot detect that. Its check that
`privateRootDir` is outside `rootDir` compares paths, so a symlink between the roots, or a
case-insensitive volume, can defeat it. An override that moves `rootDir` must move an explicit
`privateRootDir` too: it no longer follows.

The ref is `{ path, visibility, namespace? }`. Reads and writes check real paths. Its paths stay in
the strict alphabet, because they are filesystem paths. Do not put symlinks into the public tree.
Serve `rootDir` with a long-lived cache too, for example
`express.static(rootDir, { immutable: true, maxAge: '1y' })`: every file name the module writes
there is new (previews and public raster originals), so a file never changes under its URL; if you
write your own files under `rootDir`, give each a new name.

**`S3Storage`**

| Option | | |
|---|---|---|
| `bucketPublic` | required | Previews |
| `bucketPrivate` | for private uploads | Originals; must differ from `bucketPublic` |
| `publicBaseUrl` | optional | CDN/base URL |
| `client` | optional | An existing `S3Client`; otherwise one is built from `region` / `endpoint` / `forcePathStyle` |

The ref is `{ bucket, key, namespace? }`. Every read accepts only the two configured buckets, so a
tampered `bucket` cannot reach another bucket. A read accepts any key except one with a control
character, a `.` or `..` part, a leading `/` or an empty part, so a key holding a client's file name
can be adopted; `publicUrl` encodes each part. Keys the module writes, and `namespace`, keep the
strict alphabet `[A-Za-z0-9_.-]`, and previews never take a part of a stored key. Never build a ref
from a client's input: within those buckets it would publish previews of someone else's object.
`publicUrl()` does no I/O, and public access is a bucket policy, not a per-object ACL. Without
`publicBaseUrl`, URLs are virtual-hosted
(`https://<bucket>.s3.<region>.amazonaws.com/<key>`), or path-style with `endpoint` or
`forcePathStyle` (`<endpoint>/<bucket>/<key>`; without an endpoint,
`https://s3.<region>.amazonaws.com/<bucket>/<key>`). China regions (`cn-…`) use
`amazonaws.com.cn` in both forms. SVG objects are uploaded with `Content-Disposition: attachment`.

Every public object `S3Storage` uploads (previews and public raster originals, and a host's own
direct uploads) carries `Cache-Control: public, max-age=31536000, immutable`. Every key the module
writes is new, so an object never changes under its URL; if you call `S3Storage.upload` yourself,
give every upload a new key, as the `ResizeStorage.upload` contract requires (the driver does not
check). CDNs and browsers keep these objects up to a year, so purge your CDN when you delete one
that must disappear sooner (browsers that already have it may keep it until it expires). Private
objects get no cache header.

**`mongoParts(connection, { mediaModel, timing?, logger? })`** returns `{ media, locks, tasks }`
to spread into a Resizer: a `MongoMediaStore` over your media model, and a `MongoLockStore` and a
`MongoTaskQueue` on the package's `ResizeLock` and `ResizeTask` models, registered on that
connection with `autoIndex` off (create their indexes through your migration process). For other
setups, `new MongoMediaStore({ model | getModel })`, `new MongoLockStore({ model | getModel })`
and `new MongoTaskQueue({ model | getModel, timing?, getTiming?, queues?, logger? })` take the
models directly (exactly one of `model` and `getModel`, otherwise `RESIZE_MONGO_MODEL_REQUIRED`),
and `createResizeModels(connection)` registers the package's two models. `MongoTaskQueue`'s
`timing` is every queue name's timing, `getTiming(queue)` one name's (read on that name's first
use; when it gives none, `timing` applies), and `queues` the names it serves (`servesQueue`;
default every name); `mongoParts` passes one `timing` for every name. A model-shaped media object
needs `findById` and `findOneAndUpdate`, and optionally `castObject`. Previews and the backfilled
dimensions are appended with `findOneAndUpdate`, one write per preview plus one for the backfill,
so the media model's `findOneAndUpdate` middleware runs for each; the document it receives has only
`_id`, and is `null` when the preview was already stored or the media is gone, or, for a backfill,
when the pair is already stored. A model-shaped `MongoMediaModel` gets `$or`, `$not` and `$type` in
the backfill's filter, and `strictQuery: false` in its options. `replacePreviews`
(which `invalidate` uses) is one `findOneAndUpdate` with an update pipeline, an array update, and
`{ updatePipeline: true, returnDocument: 'before', lean: true, projection: { previews: 1 } }`, so a
custom model-shaped `MongoMediaModel` must accept an update pipeline, and a `findOneAndUpdate`
middleware on the media model also sees that call and must accept an array update. A row it writes
stores the `_id` an appended row would get, read from the model's `schema` and `base`, so a
model-shaped object without them writes none. The rows are
first cast with the model's `castObject` when it has one (Mongoose's `Model.castObject`: strict rows
lose the keys they do not declare, loose rows (`strict: false`) keep them, and a value it cannot
cast rejects with Mongoose's `ValidationError` before anything is written; `storageRef` and
`filters` are stored as given, cast or not); without it they are written as given, minus their
`undefined` top-level keys. `MongoMediaStore.verify()` fails with
`RESIZE_MONGO_MEDIA_MODEL_OUTDATED` when the media schema declares preview rows as strict
sub-documents without `identity`, `origin`, `encodeSig`, `sizeKey`, `format`, `contentType` or
`storageRef` (a mixed or plain `previews` array, or rows with `strict: false`, pass; `bytes` and
`createdAt` are not checked; a `storageRef` may be Mixed, or a sub-schema or nested paths that
declare every key of the driver's ref: strict rows drop the rest, so a task completes and a read
serves nothing, with an `error` line, and `verify()` cannot tell, since the key set is the driver's
own) and
logs one warning
when such rows lack `fit` (declare it as `{ type: Boolean }`; the warning goes to the store's
`logger` option, default `console`), `MongoLockStore.verify()`
with `RESIZE_MONGO_LOCK_MODEL_OUTDATED` when a strict lock schema has no `owner` field (for example
a `ResizeLock` model registered on the connection before this version), and
`MongoTaskQueue.verify()` with `RESIZE_MONGO_MODEL_OUTDATED` when the `ResizeTask` schema lacks a
field the queue writes (`active` and `cooldownUntil` among them). The queue checks the schema at its
first use too, whether or not `verify()` ran: with such a model `add()` logs
`RESIZE_MONGO_MODEL_OUTDATED` once per model and resolves `unconfirmed` every time until the model
is fixed (a strict schema without `active` would store every task and turn the gate off), and its
other methods reject with it. `MongoTaskQueue.verify()` also reads the collection's indexes and
rejects with `ResizeSetupError` `RESIZE_MONGO_INDEX_MISSING` unless one is the gate index: unique on
exactly `{ resizer: 1, fileId: 1, pipeline: 1, queue: 1 }` with `partialFilterExpression: { active:
true }` (or the same filter spelt `{ active: { $eq: true } }`; a collection that does not exist yet
has none). Before it reads them it waits for an opening connection and for the model's own `init()`:
with Mongoose's `autoIndex` on (an API server), Mongoose is still building the declared indexes at
boot, so the check waits for that build (a failed build is the cause of the missing-index error);
with `autoIndex` off (the framework CLI that runs the worker, and the models `mongoParts` registers)
it builds nothing. A connection that is closed (never opened, or disconnected) rejects at once with
`RESIZE_MONGO_NOT_CONNECTED`; one that is opening and fails rejects with it once the driver gives up
(its `serverSelectionTimeoutMS`, 30 s by default), and the message names the driver's error. It
never creates an index: create the gate index through your migration process. `MongoTaskQueue` sets
`gatesByTask` and `claimFilters`: its rows are the gate (see [Coordination](#coordination)), and a
claim takes only tasks of the Resizers the worker serves. Its `add()` counts a duplicate key as the
gate only on the gate index; a duplicate key on another unique index of your model is logged, and
the add is `unconfirmed`.

**`SqsTaskQueue`**

| Option | | |
|---|---|---|
| `queueUrl` | optional | The `'default'` queue; leave it out when `queues` names `'default'`, or when this queue serves only other names |
| `queues` | optional | Queue names → URLs: `{ bulk: 'https://sqs…/bulk' }` (`'default'` too, unless `queueUrl`). Without any URL from `queueUrl` or `queues`: `RESIZE_SQS_QUEUE_URL_REQUIRED` |
| `deadLetterQueueUrl` | optional | Dead tasks are sent here with their error, then deleted; without it they are logged and deleted. One for every name |
| `timing` | optional | Every name's queue timing (see [Config reference](#config-reference)); the lease is the message visibility timeout |
| `getTiming` | optional | `(queue) => timing`: one name's timing, read on that name's first use; when it gives none, `timing` applies |
| `waitTimeSeconds` | `10` | Long poll per claim (0–20) |
| `region`, `endpoint`, `client` | optional | An existing `SQSClient`, or one built on first use |
| `logger` | `console` | A queue built from a framework config file gets the app logger |

Credentials come from the AWS provider chain. Retries and dead-lettering are the core's, the same
as for Mongo (attempts = `ApproximateReceiveCount`), and `onTaskDeadLettered` fires for SQS too. Use
it with any media and lock store: media and locks stay in your database. It has neither
`gatesByTask` nor `claimFilters`: its gate is a lock in the Resizer's lock store, so the Resizer
needs `locks`, and each message carries that lock's owner (`gateOwner`). It serves only the names
with a URL (`servesQueue`): a Resizer's call on another name queues nothing
(`RESIZE_QUEUE_NOT_SERVED`, before any gate lock or `add()`), and a direct `add()` for one throws
`RESIZE_SQS_QUEUE_UNKNOWN`. Its timing is its `timing` and `getTiming` options (a framework app
passes each `queues` entry's timing through `getTiming`); the core validates it per name, not when the queue is constructed (invalid timing
makes `verify()` and the worker reject, and fails that name's calls; see `ready()` above). A redrive policy on the SQS queue is optional; if you keep
one, set its
`maxReceiveCount` above `maxAttempts`, so the module dead-letters a task first. Push delivery needs
one, at `maxAttempts` + 2: see [Push delivery (preview)](#push-delivery-preview). SQS fences less
strictly than Mongo: it accepts a delete with an outdated receipt, so a task whose lease ran out
can report `completed` and still run again (the worker skips previews that exist), and a dead
task can reach the dead-letter queue twice.

The core takes one kind of lock: the gate lock of a task queue without `gatesByTask`, one per
Resizer, media, pipeline and queue (see [Coordination](#coordination)). There are no per-identity
locks.
Locks only prevent duplicate work; correctness never depends on them. Every lock has an owner,
and `release(key, owner)` is a compare-and-delete: a holder whose lock expired and was taken over
cannot remove or extend the new holder's lock. A gate lock gets a fresh random owner when a task
is queued, and that owner travels with the task. `MongoLockStore` keeps the owner in the
`ResizeLock` row, and `FrameworkLockStore` in the framework `Lock` collection.

**Custom drivers** extend the exported abstract class, or are any object of the same shape:

- `ResizeStorage`: `upload`, `download`, `publicUrl` (pure, no I/O), and optionally
  `signedUrl(ref, ttlSeconds)`. The module never calls `signedUrl`; a host calls it to give an
  owner the private original.
  - The ref you return from `upload()` is opaque to the module and comes back unchanged. It is
    JSON-compatible and byte-stable for ever, because its JSON form is signed into every preview's
    `origin`: a ref that changes per load (a per-access nonce, say) reads as a replaced original.
  - `upload()` may receive a `namespace` hint (from `uploadOriginal`) or a `parentRef` (the
    original's ref, for previews). Never both. It must tolerate a `parentRef` it did not write: an
    adopted object's ref comes from the host.
  - `download()` must accept every ref the host adopts, and refuse one outside its scope with a
    `ResizeError`, which `adoptOriginal()` passes through unchanged.
  - `download()` resolves with a `Buffer` or a `Uint8Array` (an `ArrayBuffer` is read too). Anything
    else is `ResizeSetupError` `RESIZE_STORAGE_DOWNLOAD_INVALID` from `generate()` and on a task,
    where it is retried, and `RESIZE_ORIGINAL_DOWNLOAD_FAILED` from `adoptOriginal()`.
  - `publicUrl()` must refuse a ref it would not expose, because `adoptOriginal()` relies on that to
    tell a public object from a private one.
  - `download()` reports a missing object with a `ResizeStorageError` with the code
    `RESIZE_STORAGE_NOT_FOUND`, retryable, as both shipped drivers do: each retry costs one 404,
    and an object can appear later (a row written before its PUT finishes). An S3 role without
    `s3:ListBucket` gets 403 for a missing key, which stays raw.
  - `download(ref, opts?)`: when `opts.maxBytes` is given, refuse a larger object before reading
    it, with `ResizeMediaError` `RESIZE_SOURCE_TOO_LARGE`, `retryable: false`. A driver that ignores
    it still works; the core checks the length afterwards, but the memory is already spent. A
    response with no length, which `S3Storage` reads, is likewise caught only by that check, after
    the read. The peer range excludes `@aws-sdk/client-s3` 3.729 to 3.734: they collect a body with
    a full-object checksum before `send` resolves, so `S3Storage`'s own check would run after the
    read.
- `MediaStore`: `loadMedia(id)` (`null` for deleted media: its task completes as a no-op),
  `appendPreviews(id, previews, dims?)`, and optionally `verify()`, awaited at startup — throw
  there to stop the worker before it claims anything.
  - `loadMedia` must return each stored row's `origin`, `encodeSig`, `sizeKey`, `format`,
    `contentType`, `resizer`, `pipeline`, `filters` and `storageRef` as they were given. After a
    task's writes the worker reloads the media and looks at the rows under each `storageRef` it
    wrote. No such row raises nothing (a lagging reload; a store that reshapes refs is not
    detected), unless a row with all those fields as written came back with no `storageRef` at all.
    Rows there, and none matches what was written in those fields: the task fails with
    `ResizeSetupError` `RESIZE_MEDIA_ROW_NOT_KEPT` (`retryable: false`), naming the fields, because
    such a store makes reads render the preview again and again. `fit` is exempt, and `contentType`
    counts only when it is lost: a read needs one, in any form. A store that returns one ref for two
    rows is judged against all of them, and a row the check cannot read is skipped. On a driver that
    names files by their bytes, a lagging reload can show another row under the same ref, an older
    row after a replacement or another size key's row on a first render: the task is dead although
    its rows are stored, and the next read is fresh.
  - `loadMedia` should return a stored row's `identity` as given too, but losing it fails no task: a
    read does not use it, so a store keyed by the identity it computes works. A kept row whose
    `identity` is absent or differs gets one `warn` per Resizer, because `invalidate()` finds such
    rows only by identity, so it leaves them, and a `replacePreviews` that removes by stored identity
    leaves them too.
  - `appendPreviews` stores a preview only when its `identity` is not stored on the media yet, and
    must resolve with the previews it stored (`[]` when none); resolving with something other than
    an array (e.g. `undefined`) fails with `ResizeSetupError` `RESIZE_MEDIA_APPEND_RESULT_INVALID`.
    Of the previews left out,
    one whose identity is already stored in a fresh row counts as covered: another worker stored
    it first, so the core logs it as a warning with its storage ref, does not count it as created
    and sends no `onPreviewGenerated` event. One whose identity is stored in a stale row is not
    covered (the task's retry replaces that row). Any other is not recorded.
  - `appendPreviews` must save `dims` (`backfillDims`) on the original when it is given, whether
    or not it stores a preview (also for `previews: []`): the freshness check needs the original's
    dimensions, and a store that drops them makes every read of such a media queue a task that
    downloads the original (see [Freshness](#freshness)). The shipped `MongoMediaStore` drops them
    when the media schema declares a strict `original` without `width` and `height` (rejects them
    under `strict: 'throw'`), and stores them with the wrong type (or rejects them when it cannot
    cast them) when it declares them as a type that does not read back as a number (not Number,
    Int32 or Mixed); its `verify()` warns once about it. Write them only while the original holds
    no stored pair (both numbers), so they cannot land on an original swapped in during the render.
    `MongoMediaStore` does, except that an older worker in a rolling deploy still writes with no
    such condition. Its update form needs MongoDB 4.2, and the driver in use may require more
    (tested on 6.0.9 to 8.2.6). A host's `findOneAndUpdate` pre hook that calls
    `this.where({ $or })` replaces the guard's `$or`; `this.and([...])` keeps it. A store that
    writes them anyway behaves as before.
  - `replacePreviews(id, identities, rows)` (required: `verify()` and worker start reject a store
    without it with `ResizeSetupError` `RESIZE_MEDIA_REPLACE_MISSING`, and so does `invalidate`
    when it has rows to remove): in one atomic write per media, remove every stored row whose
    `identity` is in `identities` or belongs to one of `rows`, then store `rows` (of rows that share
    an identity only the first; a row without an identity always), and resolve with
    `{ stored, removed }` (`ReplacedPreviews`) as plain objects, `{ stored: [], removed: [] }` for
    a media that is gone. A row without a stored `identity` is never removed. `removed` must be
    exactly what the write removed (from the same write, not from a read before it), because the
    host deletes those files. A result other than two arrays fails with `ResizeSetupError`
    `RESIZE_MEDIA_REPLACE_RESULT_INVALID`. It takes no gate and no dimensions (a caller that must
    backfill them uses `appendPreviews(id, [], dims)`). A row the store cannot store rejects the
    call before anything is written: `MongoMediaStore` casts the rows to the model's schema first,
    so a value that cannot be cast rejects with Mongoose's `ValidationError`, which is not a
    `ResizeError`. The core reads no row `_id`, so a custom store needs none: key rows by `identity`
    (see [Freshness](#freshness)).
- `LockStore`: `acquire(key, owner, ttlMs)` (`true` when the key was free or its lock had expired;
  `false` while a live lock holds it, even one with the same owner), `extend(key, owner, ttlMs)`
  (only the owner's live lock), `release(key, owner)` (only while `owner` holds it, expired or
  not), and optionally `verify()`, awaited at startup. Keep the owner with the lock, not in process
  memory: one process may release a lock that another took (a read takes the gate lock, a worker
  extends and releases it).
- `TaskQueue` — each method one atomic operation:
  - `add(task)` stores `{ resizer, queue, mediaId, pipeline, previews, gateOwner? }` and resolves
    with a `TaskAddResult`: `{ status: 'added', taskId }`; `{ status: 'in-flight', taskId? }` (only
    a queue with `gatesByTask`: a task of this Resizer, media, pipeline and queue is active, so
    nothing was stored; `taskId` whenever the queue knows it); or `{ status: 'unconfirmed' }` (the
    queue cannot say whether the task was stored, e.g. a response lost after the write: the read
    path logs it once until an add is confirmed again, `prewarm()` reports the retryable
    `RESIZE_ENQUEUE_UNCONFIRMED` (see [`prewarm()` issues](#prewarm-issues)); on a gating queue a stored task's row is the gate, and beside a
    queue without `gatesByTask` the core keeps the gate lock for one lease, at most `gateTtlMs`).
    `unconfirmed` may also carry `retryable: false` and a string `causeCode`: calling again cannot
    help until someone fixes what `causeCode` names. `prewarm()` passes both on in its issue, and
    `MongoTaskQueue` sets them for a missing or outdated `ResizeTask` model. A
    value in
    none of these shapes (a queue written for an older version, e.g. one that resolves a task id)
    is never counted as queued: the Resizer logs it once, and `prewarm()` reports its variants
    with a non-retryable `RESIZE_ENQUEUE_UNCONFIRMED`.
  - Optionally `gatesByTask: true`: the queue itself keeps at most one active task per Resizer,
    media, pipeline and queue, whatever variants either asks for, and `add()` reports `in-flight`
    (with the active task's id) while one exists. Such a queue must keep a task active from
    `add()` through its retries and give-backs until `complete()`, and keep a dead task active for
    the `cooldownMs` that `fail()` passes; the next `add()` after that cooldown must take the dead
    task over (store the new task as the active one): a dead task left active blocks its media for
    good. `findActive` reports the active task while it is pending or processing, `[]` for a dead
    one. The Resizer then takes no gate lock and needs no `locks`. Without the flag, `add()` stores
    every task it is given, with its `gateOwner`, and the core takes a gate lock instead.
  - Optionally `claimFilters: true`: `claim()` honours `opts.resizers` (`ClaimOptions`) and claims
    only tasks of those Resizers; the worker passes the Resizers it serves. Such a queue skips the
    worker's shared-queue start check and never sees a task given back as unserved; one that hands
    out another Resizer's task anyway is logged, and the task fails with `RESIZE_NO_RESIZER`.
  - `claim(queue, leaseMs, signal?, opts?)` takes the task that became due first (a waiting one
    whose retry time has passed, or one whose lease expired), increments `attempts` and returns a
    fencing `token`. A queue without `gatesByTask` must return the `gateOwner` that `add()`
    received, unchanged, on the claimed task. It is how a worker receives tasks: it may return
    `null` at once (the core polls every `idlePollMs`) or wait for a task first (long poll,
    LISTEN/NOTIFY, a change stream). A waiting claim returns once `signal` aborts, claims only when
    called (a prefetched task's lease would run out), and treats a notification as a hint, since
    only one of the woken workers' claims wins.
  - `renew(task, leaseMs)`, `complete(task)`, `fail(task, { retryAt } | 'dead', error, opts?)` act
    only while the token still holds (`false` = lease lost). With `'dead'`, `opts.cooldownMs`
    (`FailOptions`) is how long a queue with `gatesByTask` keeps the dead task as the gate (the
    core always passes it; absent counts as 0). A queue without `gatesByTask` ignores it. Once
    `renew` reports the lease lost, the core makes no further call for that delivery.
  - Optionally `release(task)`: give a claimed task back unprocessed (`false` = lease lost). It
    becomes claimable at once, and the delivery should not count as an attempt; a backend that
    cannot take a delivery back may still count it (`MongoTaskQueue` takes the attempt back;
    `SqsTaskQueue` cannot, since SQS counts receives). The worker calls it at shutdown for a task
    it stopped, with no `onTaskFailed` / `onTaskDeadLettered` event and no backoff; a
    `ResizeError` with `retryable: false` (see [Operations](#operations)) is still dead-lettered
    with its event. Without `release`, the core retries the task at once through `fail`, which
    counts. On a queue without `claimFilters` the worker also gives back, without running it, a
    task for a Resizer it does not serve; without `release` such a task fails with
    `RESIZE_NO_RESIZER` (retried, then dead-lettered).
  - Optionally `findActive({ resizer, mediaId, pipeline, queue })`: the active (pending or
    processing) tasks of that Resizer, media, pipeline and queue, each with the previews it covers;
    at most one on a queue with `gatesByTask`, and `[]` when there are none. The core reads it only
    after an `in-flight` add, so `prewarm()` can accept the variants the active task holds.
  - Optionally `servesQueue(queue)`: omit it to serve every name; return `false` for a name this
    queue cannot carry. A Resizer's call on such a name queues nothing (`RESIZE_QUEUE_NOT_SERVED`),
    and `verify()` rejects a Resizer whose own `queueName` it does not serve; the worker rejects
    it only when it consumes that queue.
  - Optionally `routeOf(queue)`: a task queue that routes names to several backends resolves the
    task queue that carries `queue`, `undefined` for a name it does not route, and rejects when
    that backend cannot be built. Any task queue with this method counts as a router: the core asks
    every question about one queue name (the gate, `add`, `findActive`, the lock rule, `verify()`,
    what the worker consumes) of the carrier it resolves, never of the router, and reads timing
    only through the router's `getTiming`. `servesQueue` must still answer at once, without
    building anything. `carrierOf(tasks, queue)` (main entry) gives the carrier of a name on any
    task queue: its `routeOf(queue)` when it has one, else the task queue itself when it serves the
    name.
  - Optionally `getTiming(queue)`: that name's timing (missing values default); the core reads it
    once per name, on that name's first use. A queue with one timing for every name ignores the
    argument. Also optionally `verify()`.

**`RoutingTaskQueue`** (main entry) is the shipped router: `new RoutingTaskQueue(routes, {
getTiming? })`, where `routes` maps each queue name to a task queue, or to a builder
`async () => TaskQueue` called once, on the first need of one of its names (its promise is kept; a
rejected build is forgotten, so the next need builds again). One task queue or builder may carry
several names. The routes must be a non-empty plain object, each object route must have the five
required methods and serve its own name, and every other value must be a function: otherwise the
constructor throws `ResizeSetupError` `RESIZE_QUEUE_ROUTES_INVALID` naming the route. A builder
that resolves something that is not a task queue is `RESIZE_DRIVER_INVALID`. `add` and `claim` go by
the queue name, `renew`, `complete` and `fail` by `task.queue`, and `add` or `claim` on a name with
no route is `RESIZE_QUEUE_NOT_SERVED`. `findActive` is the carrier's (`[]` when it has none), and
there is no `release`, which the core asks of the carrier. `gatesByTask` and `claimFilters` are set
only when every route is an object route with that flag (a builder's flags are unknown until it is
built); the core reads them from the carrier, not from the router. Timing: an object route's names
answer through that route's own `getTiming`; a builder route's names through the router's
`getTiming` option only, because the answer is needed before the build and must not change after
it. `verify()` verifies each object route once; a builder route is verified when `verify()` or the
worker checks it as a carrier. A route that is itself a router is resolved through its own
`routeOf`. A Resizer on a router has no Resizer-wide lock requirement: a call on a name whose
carrier lacks `gatesByTask`, with no lock store, queues nothing (`prewarm()` reports
`RESIZE_ENQUEUE_LOCK_FAILED` with `causeCode: 'RESIZE_LOCKS_REQUIRED'`, `resolve()` logs it once
per queue name), and `verify()` (for the Resizer's own queue) and the worker (for a consumed name)
reject with `RESIZE_LOCKS_REQUIRED`. `createResizer` and `FrameworkResizer` build one for you when
`queues` spans several backends (see **Backends** under [Config reference](#config-reference)).

### Drivers by name

`createResizer` and `FrameworkResizer` build each part from a config section that names its
driver: `storage.driver`, `database.driver` (`createResizer` only) and the `driver` of each `queues`
entry. The built-in drivers are storage `'local'` (`LocalFsStorage`) and `'s3'` (`S3Storage`),
database `'mongo'` (`MongoDatabase`), and queue `'database'` (the database driver's task queue; a
`FrameworkResizer` uses the app's `ResizeTask` model) and `'sqs'` (`SqsTaskQueue`). A driver's
module is loaded only when a section selects it, and its optional peers are probed first without
loading anything, so a missing AWS SDK is `RESIZE_PEER_MISSING` naming the packages (a queue whose
SDK is missing beside another available backend is not served instead; see **Backends** under [Config reference](#config-reference)).

A host registers its own drivers with the `drivers` option (`createResizer(config, { drivers })`,
`new FrameworkResizer({ drivers })`), by kind and name (`DriverRegistry`):

| Kind | A driver | Returns |
|---|---|---|
| `storage` | `fromConfig(section, ctx)` (`StorageDriver`) | a `ResizeStorage`, or a promise of one |
| `database` | `fromConfig(section, ctx)` (`DatabaseDriver`) | `DatabaseParts`: `{ media, locks?, taskQueue? }`, the media store and the parts on the same connection; a `'database'` queue entry uses `taskQueue({ queues, getTiming, logger })` |
| `queue` | `backendOf?(section)`, `validate?(entries, { where })`, `fromConfig(entries, ctx)` (`QueueDriver`) | the task queue of one backend, serving exactly the names of its entries |

`ctx` is `{ logger, where }` (`DriverContext`; `where` names the config, for the driver's own
messages); a queue driver's also has `database`, the database parts when the config has a
`database` section (`QueueDriverContext`). A queue driver takes entries (`QueueEntry`:
`{ name, section, timing }`, the timing complete and validated) rather than one section, because
grouping names into backends and comparing entries (two SQS names with one URL) are its knowledge,
and both must work before its module, and any optional package it needs, is loaded:
`backendOf(section)` names the backend an entry's tasks wait in (the entries with one answer share
one task queue; default: every entry of the driver is one backend), and `validate(entries,
{ where })` checks all of the driver's entries at once and throws a `ResizeConfigError`. Both are
synchronous and load nothing. `fromConfig` runs once per backend, when one of its names is first
needed. No `fromConfig` may wait on the network or on a server: it builds its clients and returns,
and connecting and checking belong in the part's `verify()` (a `fromConfig` that never settles
stalls every call on that backend's names).

A driver is anything with a `fromConfig` function, a class with a static method (as the shipped
drivers are) or a plain object, checked by duck typing when the Resizer is constructed:
`ResizeSetupError` `RESIZE_DRIVER_INVALID` naming `drivers.<kind>.<name>`, before the Resizer's name
is taken. The part it returns is checked the same way on first use (a storage needs `upload`,
`download` and `publicUrl`; a media store `loadMedia`, `appendPreviews` and `replacePreviews`; a
task queue the five required methods, and it must serve every name of its entries), else
`RESIZE_DRIVER_INVALID`. A host driver under a built-in name replaces it, so a test can replace
`'sqs'`. A section's driver name is checked against the Resizer's drivers when the Resizer first
reads that section (on first use or in `verify()`; the `storage` of a config object passed in code,
at construction): an unregistered name is `RESIZE_CONFIG_INVALID`
listing the registered ones (`` `storage` in <config> needs driver 'local', 's3' or 'gcs' ``). A
framework config file accepts any non-empty driver name when it is read, so a disabled worker
(`worker.enabled: false`) never checks one: it logs a `warn`, and the command resolves `false`, so
a CLI entry that forwards the result, as the framework docs require, exits 1. A queue build that
fails reaches `prewarm()` as an issue (see [`prewarm()` issues](#prewarm-issues)): the error's own code when it
is an issue code, else `RESIZE_ENQUEUE_QUEUE_FAILED` with the error's code in `causeCode`, and
always the error's own `retryable`.

Every `FrameworkResizer` of a process shares one queue set, so each passes the same
`drivers.queue` drivers, by name and by object: another driver, a map that is missing, or an extra
name, on any `FrameworkResizer` (an eager-only one, or one with `tasks` in code, too) is
`ResizeSetupError` `RESIZE_DRIVER_CONFLICT` from its constructor, and its name stays free. A host
that passes no `drivers` anywhere is unaffected, and storage drivers may differ per Resizer.
Two `createResizer` calls never share queues, so they are not compared.

A custom storage driver, registered by name:

```ts
// gcsStorage.ts
import { type DriverContext, ResizeStorage } from '@adaptivestone/framework-module-resize';

export class GcsStorage extends ResizeStorage {
  static fromConfig(section: { driver: 'gcs'; bucket: string }, ctx: DriverContext) {
    return new GcsStorage(section.bucket, ctx.logger); // builds its client; connects nothing
  }
  // the constructor, upload, download and publicUrl (see Custom drivers above)
}
```

```ts
// plain Node
export const resizer = createResizer(
  {
    storage: { driver: 'gcs', bucket: 'media' },
    database: { driver: 'mongo', connection: mongoose.connection, mediaModel: File },
  },
  { drivers: { storage: { gcs: GcsStorage } } },
);
```

```ts
// framework: src/resizer.ts
export const resizer = new FrameworkResizer({
  pipelines: { default: {} },
  drivers: { storage: { gcs: GcsStorage } },
});

// src/config/resize.ts: the section's type comes from the driver's fromConfig
export default {
  ...defaultFrameworkResizeConfig,
  mediaModelName: 'File',
  storage: { driver: 'gcs', bucket: 'media' },
} satisfies FrameworkResizeConfig<{ storage: { gcs: typeof GcsStorage } }>;
```

`ResizerConfig<D>` is the same for `createResizer`: a section of a driver that is not registered,
or a key of the wrong type, does not compile.

### Decoders

A decoder turns the stored bytes of one source kind into pixels: `uploadOriginal()` measures an
original only through the decoders, and the worker and `generate()` render every source through
them. The built-in decoders read every format the installed Sharp reads from a buffer (except SVG
and `raw`), and SVG (rendered in a separate process). To add a source kind, pass decoders to the
Resizer: `new Resizer({ decoders: [new PdfDecoder()] })` (or `new FrameworkResizer({ decoders })`); a
`decoders` key in a config is `RESIZE_CONFIG_INVALID`.
They are asked first, in order, before the built-in Sharp and SVG decoders, so a host decoder can
also take over a built-in format. Pass the same decoders in every process that uploads or
generates previews (API and worker). An entry that is not a decoder (a non-empty `formats` list of
format ids, and `inspect` and `render` functions) is `ResizeSetupError` `RESIZE_DECODER_INVALID`
at construction.

A decoder extends `SourceDecoder`, or is any object of the same shape (the core never checks
`instanceof`), and closes over its own engine (no `app` parameter):

- `formats`: the format ids it reads, as stored in `original.format` (e.g. `['pdf']`).
- `inspect(bytes, limits)` resolves with a `SourceInfo`: `format` (one of its `formats`),
  `contentType`, the upright display `width` and `height` of one frame, and optionally `pages`,
  `animated` and `vector` (no own size: the own-size rule is off, and the box may exceed the
  natural size). It identifies and measures, reads only what that needs and never renders. Bytes
  that are not its format reject quickly with a `ResizeMediaError` whose code is
  `RESIZE_SOURCE_FORMAT_UNSUPPORTED`: the next decoder is asked. Any other rejection is final for
  those bytes. A result that breaks the contract (a format it does not list, no `contentType`, a
  size that is not positive) is `RESIZE_DECODER_INVALID`.
- `render(bytes, box, opts)` resolves with a `Raster` (`{ data, info }`): an upright 8-bit raster,
  colour-converted to sRGB with the embedded profile and carrying no profile, with `opts.frames`
  frames (one when the decoder cannot animate), at least `box` on both sides where the decoder's
  limits allow. The core resizes it to each exact size either way, and a raster source smaller
  than the box is never enlarged. It respects `opts.limits` and stops when `opts.signal` aborts, if
  its engine can. With `upload.verify: 'decode'` a host's `render` also runs in the API process
  during `uploadOriginal()`, and it always runs during `adoptOriginal()`, with no `opts.signal`, so
  the decoder bounds its own time; a source that reports `vector` is not rendered there. A raster
  whose `data` length does not match its `info` is `RESIZE_DECODER_INVALID`; one with more pixels
  (width × height × frames) than
  `min(limits.sourcePixels, limits.inputPixels)` is `ResizeMediaError` `RESIZE_SOURCE_TOO_LARGE`
  (`retryable: false`). A decoder's `ResizeMediaError` without a `mediaId` reaches the task, or
  `generate()`, as the same object with the media id set on it; one that cannot take it (frozen)
  is wrapped in a plain `ResizeMediaError` with the media id, its code and `retryable`, and itself
  as `cause`.
- Optionally `verify()`: awaited by `resizer.verify()` and at worker start; throw there when the
  decoder cannot work (e.g. a missing engine).
- `publicOriginals`: optional. Set `true` when public uploads of this source kind are safe. Without
  it, `uploadOriginal({ visibility: 'public' })` and `adoptOriginal` of a public object throw
  `RESIZE_ORIGINAL_PUBLIC_REFUSED`. `SharpDecoder` sets it. SVG is refused whatever the flag says.

**Which decoder reads a source.** At upload the decoders are asked in order, and the first that
accepts the bytes measures them: its `format` is stored as `original.format` and its
`contentType` as `original.contentType`. `upload.formats` must list that format
(`RESIZE_ORIGINAL_FORMAT_DISABLED` otherwise). Bytes that every decoder refuses are
`RESIZE_ORIGINAL_FORMAT_UNSUPPORTED`; bytes Sharp cannot read at all stay `RESIZE_ORIGINAL_INVALID`.
A host decoder's plain error says nothing about the bytes, whatever its message holds:
`RESIZE_ORIGINAL_INSPECT_FAILED`.
In the worker and `generate()`, the stored `original.format` picks the decoder to try first. A
format that no decoder lists, or one whose decoder refuses the bytes, is logged as a warning, and
the bytes are probed through the other decoders; a format whose decoder reads the bytes as another
of its formats (JPEG bytes stored as `png`) is logged too, and rendered as what it is:

```text
resize worker: media <id> is stored as 'jpg' but its bytes are 'jpeg' (no decoder lists the stored format); rendering it as 'jpeg'
```

(`resize generate:` when `generate()` writes it; `its decoder refused the bytes` for the second
case, `its decoder read another of its formats` for the third; when a host decoder lists the stored format,
refuses the bytes and a later decoder reads them as that same format, the warning says
`… is stored as 'jpeg'; the first decoder listing 'jpeg' refused these bytes, and another decoder
read them`). So `original.format` should be the
decoder's id: `jpeg`, not `jpg` or `image/jpeg`; fix such a record to silence the warning. When no
decoder lists the stored format and none reads the bytes, the source fails with the retryable
`ResizeSetupError` `RESIZE_DECODER_MISSING`: a process without the decoder that record needs (pass
it in `decoders` in every process). When the stored format's decoder refuses the bytes (or the
media has no stored format) and every other decoder refuses them too, it fails with
`ResizeMediaError` `RESIZE_SOURCE_FORMAT_UNSUPPORTED` (`retryable: false`: dead-lettered at once).

**What an upload rejection says.** `uploadOriginal()` throws a `ResizeOriginalError` whose message
carries the engine's line, for example `resize uploadOriginal: bytes are not a supported image:
gifload_buffer: Unexpected end of GIF source data`. The code is the stable part: the text may change
with Sharp, and it may reach end users through `badRequest(err.message)`. Check `err.retryable`:
when it is `true`, the module gave no verdict on the file, so answer with your own text. A
`ResizeOriginalError` is not retryable by default, since the same bytes get the same refusal. The
exceptions say what they are:

- `RESIZE_ORIGINAL_INSPECT_FAILED` (`retryable: true`): a decoder failed for a reason other than the
  bytes, such as a timeout, a host decoder's own failure, a healthy file this build cannot decode or
  an engine failure with no detail. Retry may help, and `cause` says why.
- `RESIZE_ORIGINAL_VERIFY_FAILED` (`retryable: true`): the `upload.verify: 'decode'` check failed for
  a reason other than damage, such as a timeout or a healthy file this build cannot decode. It gave
  no verdict on the image, and `cause` says why. A host decoder's own error with `retryable: false`
  (an encrypted PDF, say) is not this code: it keeps its code and `retryable`, as at `inspect`.

`RESIZE_ORIGINAL_DAMAGED` (`retryable: false`) comes only from that check. Damage `inspect` finds
first, such as a cut single-frame GIF or a cut inside an animation's first frame, stays
`RESIZE_ORIGINAL_INVALID`. The check decodes the first frame only: an animation damaged in a later
frame can be stored, and a worker then renders the frames it has or fails the task. Flipped bytes can
pass too, since a decode does not always find them: a still JPEG or lossy WebP usually passes. A JPEG
cut in its last rows can pass too (measured at 1200×900, up to about 1% of its tail), and a larger
render then dead-letters it.

### Engines

An engine does the resize and the encode. The default, `SharpEngine`, writes the same files as
0.3.0. A host passes its own in code, like `decoders`, in every process that renders or calls
`verify()`: `new Resizer({ engine })`, `createResizer(config, { engine })` or
`new FrameworkResizer({ engine })`. An API process that only reads but calls `verify()` without it is
refused, naming `sharp`, for a format only the worker's engine writes. There is no config driver, and
an `engine` key in a config is `RESIZE_CONFIG_INVALID`. Decoders stay separate, `Raster` is all the two
share, and Sharp stays a dependency.

An engine extends `ImageEngine`, or is any object of the same shape (the core never checks
`instanceof`):

- `id` names the engine in messages.
- `formats` lists the ids `encode` writes. `verify()` and worker start refuse an entry of `formats`,
  and an `encode.formats` entry the host wrote or changed, that it does not list
  (`RESIZE_ENGINE_FORMAT_UNSUPPORTED`). A package default outside `formats` that the host left alone
  is not checked: on a build without HEIF, `formats: ['jpeg', 'webp']` passes, and a per-call
  `formats: ['avif']` then fails at render, as on 0.3.0.
- `animatedFormats` lists the ids `encode` writes with every frame. Any other format gets the first
  frame. With `[]`, an animated source decodes one frame.
- `resize(frame, { width, height, mode, sharpen, coverBox }, { limits, signal })` takes one frame and
  resolves with one frame at exactly `width × height` (with `coverBox`: within a pixel of it, covering
  the box), 8-bit sRGB, 3 channels or 4 with alpha; a grey frame comes back as colour. `mode: 'fill'`
  puts the whole frame into that size, and `'cover'` scales to cover it and crops from the centre. An
  engine without a sharpener ignores `sharpen`. `coverBox` is set only on the reduction after
  `beforeSteps`: it is the box `width × height` was computed from, and any engine may ignore it. A
  result marked `info.premultiplied: true` is converted to straight alpha in plain JS, on the event
  loop (182 ms at 24 MP), before a step or `encode` sees it, unless its `info.format` is `'raw'`: that
  is Sharp's own `info`, whose flag is true on straight bytes after a resize, so it reads as straight.
- `encode(raster, { format, options, background }, { limits, signal })` takes one frame of 1 to 4
  channels with straight alpha, or `info.frames` of them (with `info.delay` and `info.loop`) for a
  format in `animatedFormats`. `options` is `encode.formats[format]`. When `background` is set, flatten
  onto it first: it holds `encode.flatten.background` as written, such as `'white'` or `'#ffffff'`, so
  an engine parses colour names too, or the host writes hex. It resolves with
  `{ data, format, contentType, width, height }`, where the size is that of the raster, one frame. The
  result's `format` is the preview's file extension, letters and digits only; the row keeps the id the
  host configured. `encode` must refuse a format it does not write: only `verify()` compares
  `formats`, so a png-only engine asked for avif otherwise writes a row `avif`, `image/png`, `.png`.
- `verify()` is optional, and runs in `resizer.verify()` and at worker start, after the decoders'.

Two rules the types cannot state. An engine must not write to its inputs, because the formats of one
size share one raster. It must be re-entrant, because calls run concurrently, up to `concurrency`. A
result of another size, one without those fields, one with empty `data` or a `contentType` that is not
`image/…`, and an animation frame with another channel count are `RESIZE_ENGINE_INVALID`. An encode
result that says SVG (by `format` or `contentType`), HTML or XML is `RESIZE_SVG_PUBLIC_PREVIEW`, on
that variant. These guard against a mislabelled file; they are no boundary, since an engine is host
code.

The core sets no timer on an engine's calls. An engine applies `limits.processingTimeoutSeconds`
itself, and stops when `signal` aborts, where its library can; `generate()` passes no `signal`. A call
that never settles holds its task until a worker's `taskTimeoutMs`; `generate()` has no such bound.
An engine that stops on `signal` stores no late row, where `SharpEngine`, which ignores it, does: a
step slower than `taskTimeoutMs` then ends dead after `maxAttempts` with no row, so such a pipeline
needs a longer `taskTimeoutMs`.

Steps do not change with the engine. Both kinds receive and resolve with a `Raster`, so a step needs
no image library: it reads `raster.info` and `raster.data` (`width × height × channels` bytes, row by
row, 8-bit sRGB with straight alpha) and resolves with `{ data, info }`. `rasterToSharp` and
`sharpToRaster` are helpers for a step written with Sharp, and no part of the engine contract: they
run Sharp, whichever engine the Resizer has. A `rasterToSharp` chain in a `variantStep`, from a raster
the module handed over or made from one through `sharpToRaster` (a raster read back from a `.clone()`
has none), keeps its limit on any engine. A step on another library has none, so it bounds its own time
(see Pipelines).

A step's result marked `info.premultiplied: true` is converted to straight alpha, unless its
`info.format` is `'raw'`. That is Sharp's own `{ data, info }` from `toBuffer({ resolveWithObject: true })`,
whose flag is true on straight bytes after a resize, so such a result is read as straight alpha. A step
that premultiplies its own bytes must not spread Sharp's `info`.

The engine is not part of `encodeSig` and declares no version. Switching engines does not regenerate
stored previews; bump each pipeline's `version` to do that. An engine that animates a format other
than `gif` or `webp` does not sign `animated` into that format's `encodeSig`, so after changing
`animated`, bump `version` too.

`SharpEngine.formats` lists every id Sharp's `toFormat` accepts that this build can write, aliases
included. An alias takes nothing from `jpeg`'s settings: `formats: ['jpg']` needs its own
`encode.formats.jpg`, and `encode.flatten.formats` must name it, or transparent pixels turn black.
Naming it there changes its signature, so its stored previews regenerate.

## Metrics

A Resizer reports what it does to a metrics sink: reads, uploads, rendered variants, task outcomes
and the worker's waits. A sink extends `ResizeMetrics` (main entry), or is any object of the same
shape:

```ts
abstract class ResizeMetrics {
  abstract count(name: string, value: number, labels?: MetricLabels, context?: MetricContext): void | Promise<void>;
  abstract timing(name: string, ms: number, labels?: MetricLabels, context?: MetricContext): void | Promise<void>;
  flush?(): void | Promise<void>; // write what is pending now
}
```

Each event is one call: `timing` for an event with a duration, `count` otherwise. `labels`
(`MetricLabels`, string values) are the few low-cardinality values a backend may group by;
`context` (`MetricContext`, strings and numbers), the 4th argument, carries per-event details
(media and task ids, identities) for logs, never for labels. A sink written with three parameters
per method still conforms. A method may be `async`: the module never awaits `count` or `timing`,
and it catches what they throw or reject.

**The `metrics` option.** `new Resizer({ metrics })`, `createResizer(config, { metrics })` and
`new FrameworkResizer({ metrics })` take the sink; `resizer.metrics` returns it as given. Left out
(only `undefined` means the default), `new Resizer` and `createResizer` use
`new LogMetrics(logger)` on the Resizer's logger, and `FrameworkResizer` uses
`new LogMetrics(logger)` too, on its `logger` option, else the app logger. `new NoopMetrics()` turns
metrics off. The sink is checked by shape at construction,
before the Resizer's name is taken: `metrics: null`, or an object without `count()` and `timing()`
functions, is `ResizeSetupError` `RESIZE_METRICS_INVALID` (`retryable: false`).

The Resizer puts a guard in front of its sink, and every call goes through it:
- it adds the `resizer` label (the Resizer's name) to every call;
- a `pipeline` label that is not a pipeline registered on the Resizer becomes `'unregistered'`,
  and a `code` label that is not one of the module's error codes becomes `'other'`; the raw value
  moves to `context.pipeline` or `context.code`. Host names and codes are unbounded, and a metrics
  backend keeps one series per label value;
- it never throws and never rejects into a read or a task: a throw or a rejection of the sink is
  caught, and the first failure of each method is logged once per Resizer ("resize: the metrics
  sink of Resizer '…' failed on '…' — further failures of count() are not logged").

**The events.**

| Name | Call | Value | Labels (besides `resizer`) | Context |
|---|---|---|---|---|
| `resize.read` | count | 1 per `resolve()` | `pipeline`, `outcome` | `mediaId`, `ready`, `missing`, `stale` |
| `resize.preview.stale` | count | the stale previews one read found | `pipeline` | `mediaId` |
| `resize.upload` | timing | ms of `uploadOriginal()` | `outcome`: `stored` or `rejected`; `format` (stored); `code` (rejected, for a module error) | — |
| `resize.upload.bytes` | count | the stored original's bytes | `format` | — |
| `resize.adopt` | timing | ms of `adoptOriginal()` | `outcome`: `adopted` or `rejected`; `format` (adopted); `code` (rejected, for a module error) | — |
| `resize.variant` | timing | ms of one variant | `pipeline`, `format`, `mode`: `task` or `eager`, `outcome`: `stored`, `duplicate`, `rendered` or `failed`; `code` (failed) | `mediaId`, `identity`, `taskId` (task mode), `rawFormat` (`format: 'unconfigured'`) |
| `resize.variant.bytes` | count | the uploaded preview's bytes (stored, duplicate, rendered) | `pipeline`, `format` | — |
| `resize.task` | timing | ms from the claim to the task's outcome | `queue`, `pipeline`, `outcome`: `completed`, `failed` or `dead`; `code` (failed or dead, for a module error) | `taskId`, `mediaId`, `attempts`, `variants`, `rendered` (on `completed`: the variants this delivery stored), `payloadQueue` (when the task names another queue) |
| `resize.claim` | timing | ms the worker's loop waited for this task | `queue` | `taskId` |

- **`resize.adopt`** reaches the debug line of `LogMetrics` only, and not its summary: an adoption is
  a bounded script, not traffic.
- **`resize.read` outcomes**, in the order a read decides them: `unknown-pipeline` (the pipeline is
  not registered), `ready` (nothing was missing or stale), `suppressed` (nothing was left to queue
  after `beforeEnqueue` and the dropped formats, or the caller passed `enqueueMissing: false`),
  `no-original` (the media has no `original.storageRef`), `eager-only` (no task queue), then what
  the task queue said: `enqueued` (a task was added), `in-flight` (a task of the media, pipeline and
  queue is already active, or, on a queue without `gatesByTask` such as SQS, its gate lock is
  held) or `failed` (it could not take the task, or the read itself failed, or
  the Resizer could not start, or its task queue cannot be used).
- **What a read counts.** A read that found every cell fresh counts `ready`, even when a
  `beforeEnqueue` tap added a variant and it was queued: the tap's work shows in `resize.task`. In
  the context, `ready` counts the cells served, stale ones included (so `ready` and `stale`
  overlap), while `missing` and `stale` count distinct variants. Stale variants are counted before
  `beforeEnqueue`, so a variant a tap drops still counts as stale.
- **`resize.variant`** is one variant's time: the wait for its size's resized pixels (one resize,
  shared by the formats of that size), its encode and its upload. `duplicate` is a variant another
  worker stored first in a fresh row, `rendered` a `generate({ persist: false })` variant. A
  variant left out because a row with other signatures holds its identity is `failed` with
  `RESIZE_WORKER_INCOMPLETE`: that row does not cover it, so the task fails and its retry replaces
  the row. When the persist itself fails, a variant the store kept before the failure (the append
  before a failed replace, or the part of a failed append that the reloaded media holds) is
  `stored`; every other variant it held is `failed` with the error's code.
- `format` is a configured format, or a decoder id for uploads. A task variant whose format has no
  encoder settings (an old or foreign payload) is `failed` with `format: 'unconfigured'`, its own
  format in `context.rawFormat`. `queue` is the queue the worker consumes; a task whose payload
  names another queue (a replayed or malformed message) keeps that name in `context.payloadQueue`.
  The queue latency (from due to claim) is not measured: `resize.claim` is the worker's own wait.

**`LogMetrics`** (the default) writes metrics as log lines on a logger: `new LogMetrics(logger, {
summaryIntervalMs?, debug? })` (`LogMetricsOptions`; defaults `60000` and `false`). An interval
that is not a positive integer of at most `2147483647` is `RESIZE_METRICS_INVALID`.
- **Summed** per Resizer, never a line of their own: the reads by outcome, the stale previews
  found, the uploads (stored and rejected, with their bytes), the variants stored, duplicate or
  rendered (with their bytes) and the claims (with their total wait). Once per window, one `info`
  line per Resizer that counted something:

  ```text
  resize: Resizer 'default' over 60 s: reads 1200 (ready 1150, enqueued 12, in-flight 38), stale previews found 40, uploads 25 (31457280 bytes), variants 75 (5242880 bytes), claims 12 (average wait 840 ms)
  ```

  Empty sections are left out; an upload section with nothing stored reads `uploads 3 (rejected
  3)`.
- **Written at once**, one `info` line each, because they are rare and worth reading alone:

  ```text
  resize: task <taskId> of media <mediaId> <completed|failed|dead> in <ms> ms (Resizer '<r>', queue '<q>', pipeline '<p>', attempt <n>, variants <n>[ of <m>][, code <code>])
  resize: variant <identity> of media <mediaId> failed in <ms> ms (Resizer '<r>', pipeline '<p>', format '<f>'[, code <code>])
  ```

  A missing value prints as `?`; a code reduced to `'other'` prints the raw code. `variants 5 of 9`
  is a completed task that stored 5 of the 9 variants it names; the others were fresh already, or
  its media is gone.
- **The window** opens with the first summed event and closes when it is written, after
  `summaryIntervalMs`. Its timer is `unref`ed, so it never keeps a process alive, and no timer runs
  between windows. `flush()` writes the open window now. The worker flushes the sink of every
  Resizer it serves when it stops (once per distinct sink), waiting at most 5 s for each; that wait
  keeps the process alive until the flush settles or the 5 s end. In a framework host the open
  window is written on the framework's `shutdown` event, with no code of yours, wherever the
  framework emits it: `startServer()` on SIGTERM or SIGINT, and its CLI after a command returns.
  Everywhere else, call `await getResizer().metrics.flush?.()` yourself:
  - a script that uses `new Server()` and `init()`, which never emits the event;
  - a `FrameworkResizer` with every part passed in code that is first used before the `Server`
    exists: it never registers for the event;
  - a CLI command with a sink whose `flush` is asynchronous, before the command returns: the
    listener does not wait, and the CLI entry calls `process.exit`;
  - a process without the framework, in your own SIGTERM handler.

  Under `startServer()`, a sink with an asynchronous `flush` must keep its own handle open until it
  finishes, because the event does not wait for it.
- **`debug: true`** (off by default for every Resizer) also writes every call as one `debug` line,
  `resize metric <name> <value> <labels JSON> <context JSON>`, when the logger has a `debug` method
  (`ResizeLogger.debug` is optional). `<value>` is the count, or a rounded `<n> ms`. It costs two
  `JSON.stringify` calls per event.

**`NoopMetrics`** records nothing.

**A custom sink** groups by labels only. A Prometheus sketch with `prom-client`:

```ts
import { Counter, Histogram } from 'prom-client';
import { type MetricLabels, ResizeMetrics } from '@adaptivestone/framework-module-resize';

const labelNames = ['event', 'resizer', 'pipeline', 'outcome', 'format', 'mode', 'queue', 'code'];
const counts = new Counter({ name: 'resize_events_total', help: 'resize events', labelNames });
const buckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]; // ms, not prom-client's seconds
const timings = new Histogram({ name: 'resize_duration_ms', help: 'resize timings (ms)', labelNames, buckets });

export class PromMetrics extends ResizeMetrics {
  count(name: string, value: number, labels: MetricLabels = {}) { counts.inc({ event: name, ...labels }, value); }
  timing(name: string, ms: number, labels: MetricLabels = {}) { timings.observe({ event: name, ...labels }, ms); }
}
```

## Freshness

Every preview row records two signatures (see **Preview rows** under [Operations](#operations)):
`origin`, the original it was made from, and `encodeSig`, the settings it was encoded with. A row
is **fresh** when both equal what the current settings would record now, and **stale** otherwise.
A stale row is served while its replacement is made; the replacement takes its place in one write.

**What makes a row stale:**
- a change in the encode inputs of its row: its format's `encode.formats` entry, the
  `encode.sharpen` flag of its fit mode, the flatten background (flattened formats), `maxSize`
  (fit rows) and `limits.resultDimension`. For webp and gif rows also `animated`,
  `limits.animationFrames` and the animation pixel budget, which is the SMALLER of
  `limits.sourcePixels` and `limits.inputPixels`: changing the smaller one changes those
  signatures, changing only the larger one changes nothing;
- a change of the pipeline's `version`;
- another `original.storageRef`, or other stored dimensions of the original;
- a row without signatures (`origin` and `encodeSig`; written by 0.2.x or earlier).

New bytes under the same `original.storageRef` and at the same size are not detected: after
replacing an original in place, call `invalidate()` for that media.

**On read.** `resolve()` serves a stale row like a fresh one, with `stale: true` on its
`ReadyEntry`, and queues its replacement: stale and missing variants form one list, in cell order,
for `beforeEnqueue`, and one task. After the hook, a variant whose stored row was stale is in
`decision.stale`, every other one in `decision.missing` (`stale` is set only when there is one, so
a fresh decision has no `stale` key). `decision.stale` lists the replacements the read asks for,
as left after the hook: it does not confirm that they were queued (an eager-only Resizer, a task
queue that cannot be used, `enqueueMissing: false`) or that each old row was served. A stale row
whose `publicUrl` throws is not served but is still queued: the replacement gets a new ref. A pipeline that is not registered serves every stored
row as fresh, since nothing can replace it. `prewarm()` reports only fresh rows as `ready`; stale
ones are required and queued like missing ones.

**The worker and `generate()`** render the stale variants again and count only fresh rows as done.
The worker judges freshness by its own settings: a queued variant that is fresh for it is skipped
(nothing is uploaded) and counts as covered. The new rows of a stale identity replace the old ones
in one `replacePreviews` write; the other new rows are appended. `GenerateResult.replaced` lists the
storage refs of the rows the write of `generate()` removed (set only when there are some): the
outdated rows, or a row of the same identity another worker stored meanwhile. A ref a new row of
that write or the original holds is left out, because that file is in use. `generate()` swaps the
rows in the caller's `media.previews` too. Each replacing write logs one `info` line: "resize:
replaced <n> outdated preview(s) of media <id>; their files are not deleted: storage refs <refs>".
Its count and refs are the rows that write removed, so they can include such a concurrent copy too.

**The module never deletes old files.** Clean them up in an `onPreviewReplaced` observer, which gets
each row a write of `generate()` or the worker removed, so it can delete `row.storageRef`; from that
log line; or with a sweep (below). A report is delivered at most once: a crash, a tap that outlasts
its timeout and a failed delete each lose one, a write that commits but whose acknowledgement is
lost leaves no `resize: replaced` line either, and that line is `info`, so keep the sweep if every
file must go. A response or a cached page built before the write still names the old URL, so you may
want to delete after your longest cache time. Do not wait in the tap for that: it runs inside the
task, so a wait past `taskTimeoutMs` costs the attempt, and at `maxAttempts: 1` the task of a fresh
preview is dead. Schedule the delete elsewhere, and return. The observer does not fire for
`invalidate()`, which returns its refs, or for `persist: false`. A removed row can be a copy another
worker stored meanwhile; its file is just as unreferenced. A host that adopts a stored preview as an
original while a replacement runs can be told to delete it, since only the original the render read
counts as live: check your own records before deleting a ref you may have adopted. Use a tap, not an
event bus listener: an async listener that rejects kills the process, since the module cannot catch
it and the framework's `app.events` is a plain `EventEmitter`.

**A sweep** deletes objects under the `previews/` prefix (below a ref's `namespace`) that no row
references, leaving out every `original.storageRef`: an adopted public original sits in the same
bucket, and no preview row references it. A preview is uploaded before its row is written, so list
the objects first and read the rows after, and delete only objects older than a day and more than
twice `taskTimeoutMs`, by S3 `LastModified` or file mtime: a delivery that timed out can still write
its row later, and `generate()` has no timer. Such a late write is not fenced, so it can replace a
newer row, even one from a newer original; the next read finds that row stale and queues it again.
Without that rule a sweep deletes the files of rows about to be written. A read then still reports such a row as ready, neither stale nor missing, so
nothing renders it again and its URL fails. `invalidate()` on that media removes its rows, and the
next read or `prewarm()` queues them again.

The shipped drivers give every preview a new key. On a driver that names files by their bytes, a ref
that a new row of the write or the original holds is not reported. Refs compare as JSON with sorted
keys, so reordered keys are one ref, but a value that reads back in another form (a Buffer in a
custom ref, as a bson `Binary`) counts as another, and that file is reported although it is in use.
Such a driver also shares a ref across two size keys, two pipelines, two Resizers or two media with
equal bytes, and a host that copies a media document shares files on any driver. The tap gets one
row and no media id, so it cannot see any of that: such a host should use the sweep, which sees
every row. The same goes for that log line, which still names a ref a new row kept. A row without an
`identity` (written before 0.3.0) stays beside its replacement and keeps its file referenced, so a
sweep never finds that file: delete such rows (and their files) yourself.

**A media without stored dimensions** (`original.width` and `original.height` must both be numbers;
a stored `null` counts as missing) has no row the read path can prove fresh, since it cannot
measure the original. Its first read queues one task that downloads and inspects the original (no
pixel decode, no upload when its rows turn out fresh) and records the dimensions; later reads find
the rows fresh. A `MediaStore` must therefore save `backfillDims` in `appendPreviews`, also when
`previews` is empty. A store that drops them makes every read of such a media queue a task that
downloads the original; the worker then warns once: "resize worker: the media store did not record
the original's dimensions of media <m> — …". The shipped `MongoMediaStore` drops them too when the
media schema declares `original` strictly (nested paths, or a sub-schema without `strict: false`)
without `original.width` and `original.height`: Mongoose strips them from the update. Declared
with a type that does not read back as a number (not Number, Int32 or Mixed; `String`, say, also
under `strict: false`), they are stored as that type, which the freshness check does not read as
dimensions. Under `strict: 'throw'`, or with a type Mongoose cannot cast them to (`Boolean`,
`ObjectId`), the symptom differs: the update is rejected, so the task fails with Mongoose's error,
is retried and is dead-lettered after `maxAttempts`, and no preview is stored. Its `verify()` warns
once about such a schema, naming the cause; spread `resizeMediaSchemaFragment`, or declare `width`
and `height` as `{ type: Number }` in `original`.

**`resolve()` must receive `original` as stored**: the same `storageRef` and dimensions. A
projection that drops `original.width` and `original.height`, or a ref reshaped by a DTO, makes
every row stale and queues a task per read that renders nothing. The worker then warns, once per
pipeline: "resize worker: task <id> of media <m> found every requested preview of pipeline '<p>'
already fresh — if this repeats, the API and the worker may run different image settings or
pipeline versions, or resolve() was given the media without its stored original (storageRef,
width, height)". It may fire once after an eager `generate()` filled variants a read had queued.

**An eager-only host** (no task queue) never regenerates on read: its stale rows are served with
`stale: true` until it calls `generate()` for that media.

**Rolling out a settings change.** The API and the workers must run the same image settings and
pipeline versions. Change them with every worker at once: deploy all workers together, or drain
(stop) the old workers before the new ones start. While two worker versions with different
settings run side by side (a rolling deploy, a canary), each sees the other's rows as stale and
makes them again: every read after a task ends queues the previews it finds stale again, and each
replaced preview costs one render, one upload and one orphaned file (a task replacing several
previews costs that several times).
An API ahead of its workers queues tasks that render nothing (the warning above). After a change,
every stored preview that the change touches regenerates as it is read; that wave shares the queue
with the previews of new uploads, which wait behind it, so plan worker capacity and storage.

**`isCatalogCovered`** checks identities only, not freshness: a stale row covers its variant
there. Call `generate()` to bring a catalog up to date; it is idempotent and renders only what is
missing or stale.

**Mongo `_id`.** A row stores an `_id` exactly when the media schema gives an appended row one,
unless working it out fails. The current `resizeMediaSchemaFragment` keeps Mongoose's automatic
`_id`, and `replacePreviews` stores the same on the rows it writes, so `row._id` reads the same on
every load. A row replaced under 0.3.0 has none stored: it reads a new random `_id` on each load (a
lean read gives none) until it is next replaced. Nothing migrates it, and reading it renders
nothing. Remove such a row by `identity` or with `invalidate()`: `row.deleteOne()`,
`previews.pull(row._id)` or a `$pull` by the id it read removes nothing, and a `$pull` by the id of
a lean read removes every row without a stored `_id`. Keying rows by `identity` avoids both.

## Push delivery (preview)

An SQS-triggered Lambda can run queued tasks instead of a worker process, with the same lease,
retries, dead-letters and gate. **It has not run on real AWS.** Everything here was measured on one
machine, with local stand-ins and a model, so it stays a preview until the check list in `RELEASE.md`
passes. A long-lived worker is the simpler choice when a host already runs one. Only the SQS driver
takes pushed messages, on standard queues: FIFO queues are not supported, since the driver sends no
`MessageGroupId` and a record after a failed one still runs. The walkthrough, with a whole handler, is
in the [guide](https://framework.adaptivestone.com/docs/resize#push-delivery).

### Settings to get right first

In the order that saves tasks:

1. **`ReportBatchItemFailures` in the trigger's `FunctionResponseTypes`.** Without it Lambda deletes every message of a normal return, so a failing task is gone after its first failure, with no copy, while its line says `retrying in 5000 ms`. The handler cannot detect this.
2. **Batch size 1, with no batch window.** Records of a batch run one after another. One that does not fit in the time left is not started, yet its delivery counts as an attempt, so healthy tasks die unrun.
3. **A function timeout well above your slowest task.** Start at 300 s. Lambda's default 3 s runs no task at all.
4. **Redrive `maxReceiveCount` = `maxAttempts` + 2** (7 for the default 5). Too low, and SQS moves the message itself, with no module line, hook or cooldown.
5. **A visibility timeout at least 6 × the function timeout**, which is AWS's rule. Set `coordination.gateTtlMs` at or above it.
6. **A `deadLetterQueueUrl` in the queue's entry.** Without one a dead task is deleted at its last delivery.
7. **The IAM permissions `AWSLambdaSQSQueueExecutionRole` lacks:** `sqs:ChangeMessageVisibility` on the queue, `sqs:SendMessage` on the dead-letter queue, and S3 get and put.
8. **`MaximumConcurrency` on the trigger, rather than low reserved concurrency.** Reserved concurrency throttles, and a throttled receive may count as an attempt.

What a wrong one costs:

| Setting | Wrong | Cost | What tells you |
|---|---|---|---|
| `ReportBatchItemFailures` | Missing | Lambda ignores the returned list, so every failed task is lost after its first failure, with no retry, no dead-letter and no copy | Nothing: its line still says `retrying in 5000 ms` |
| Batch size | A batch that does not fit: batch size × your slowest task must fit the function timeout minus the reserve | Healthy tasks die unrun, as the next table shows. A crash or a timeout also costs every neighbour in the batch a receive | A `warn` per record not started, then the `is dead` line with `RESIZE_TASK_MAX_ATTEMPTS` |
| Function timeout | Under 4 s, which includes Lambda's default 3 s | No task ever runs. Six deliveries, one visibility timeout apart, and every task is dead, unrun: 10 of 10 in the model, 90 s from the first at a visibility of 18 s. With no `deadLetterQueueUrl`, the sixth delivery deletes it | An `error` on each delivery, naming the time a task needs to start |
| Function timeout | 4 s to about 4.3 s | A task that does not fit stores no row at return, and each delivery leaves 15 or 16 orphan files: see [the table below](#stopping-in-time) | A `warn` (`had not settled`) on each delivery |
| Function timeout | Shorter than the task | `RESIZE_TASK_TIMEOUT` at the reserve. Finished variants are kept and the retry renders the rest | A `warn` per delivery |
| `maxReceiveCount` | Too low: below `maxAttempts` for every failing task, at `maxAttempts` when the last delivery is cut short | SQS moves the message first: no `is dead` line, no `onTaskDeadLettered`, no cooldown. The handler does not check this value | Nothing |
| Visibility timeout | Below the function timeout | AWS refuses the mapping | AWS, at deploy |
| Visibility timeout | Below 6 × | A record not started comes back sooner, so a task's six deliveries pass quicker, and an alarm has less time | Nothing |
| `coordination.gateTtlMs` | Below the visibility timeout: a 300 s function means at least 1800 s, against a default of 600 s | The gate of a record not started lapses first, and a read can queue a duplicate task. Nothing is lost, only work repeated | Nothing |
| `deadLetterQueueUrl` | Unset | A dead task is deleted, and a malformed message stays listed until your redrive moves it. It can be the queue your redrive policy targets | An `error` per delivery |
| IAM | No `sqs:ChangeMessageVisibility` | A task still runs, but a crash waits the whole visibility timeout and a failure comes back with no backoff | One `error` per environment for the adoption, and one per delivery from a task that fails |
| IAM | No `sqs:SendMessage` on the dead-letter queue | A dead task stays in the queue and no event fires | An `error` per delivery |
| `MaximumConcurrency` | Unset | A burst can use up the Mongo connections | Nothing |

A batch that does not fit, on the real handler over a simulated standard queue and poller, with a virtual clock, one Lambda environment at a time, three seeds per row, `maxAttempts` 5 and a visibility timeout of 6 × the function timeout. It is a model, not AWS:

| Tasks | Batch size | Function timeout | Each task takes | Dead, unrun | Receives used unrun, per task | Minutes to drain |
|---|---|---|---|---|---|---|
| 100 | 1 | 60 s | 20 s | 0, 0, 0 | 0 | 33 |
| 100 | 3 | 60 s | 20 s | 1, 1, 0 | 0.9 | 61 |
| 100 | 5 | 60 s | 20 s | 3, 3, 2 | 2.1 | 51 to 54 |
| 100 | 10 | 60 s | 20 s | 21, 24, 24 | 3.5 | 36 to 38 |
| 100 | 10 | 60 s | 10 s | 0, 0, 0 | 0.8 | 24 |
| 100 | 10 | 60 s | 5 s | 0, 0, 0 | 0 | 8 |
| 100 | 10 | 300 s | 60 s | 0, 0, 0 | 0.9 | 112 |
| 10 | 1 | 3 s | 5 s | 10, 10, 10 | 6 | 1.5 |

### The handler

```ts
// Import the file that constructs your Resizers first.
import './resizer.js';
import { createSqsHandler } from '@adaptivestone/framework-module-resize/lambda.js';

export const handler = createSqsHandler({ sharp: { concurrency: 1, cache: false } });
```

Lead with those Sharp options. `concurrency: 1` keeps Sharp to one thread per image, whatever CPU count the function reports, and with `cache: false` an environment that lives on keeps nothing for its next task. Over one task, turning the cache off saved 0 to 60 MB across three runs each, in a Linux container of 1 CPU and 1,769 MB, not on Lambda. They are process-wide: with two handlers in one process, each applies its own at its first invocation, so the last first invocation wins. Every start check a worker runs at start runs on the first invocation, not at import: a check that rejects throws from the invocation, which uses a receive of each record in it (see [How a record ends](#how-a-record-ends)), and the next invocation checks again.

| Option | Default | |
|---|---|---|
| `queue` | `'default'` | One name or a list. Records go by the queue in their event source |
| `resizers` | every Resizer registered when the start checks are built: at the first invocation, and again after checks that rejected or were dropped | As `runWorker` |
| `sharp` | left as they are | Process-wide tuning, applied with the start checks |
| `stopBeforeTimeoutMs` | `limits.processingTimeoutSeconds` + 5 s, never above half the time left | The time kept back for the end of a task. Given: a whole number of ms, at least 3000, honoured as given, with no cap |
| `logger` | `console` | |

### Other settings

| Setting | Value | Why |
|---|---|---|
| IAM | `AWSLambdaSQSQueueExecutionRole`, plus the permissions in the list above | That role grants only receive, delete and read attributes on SQS, and log writes. With a customer managed KMS key on a queue, add, per AWS, `kms:Decrypt` on the queue's key, and `kms:Decrypt` and `kms:GenerateDataKey` on the dead-letter queue's |
| `MaximumConcurrency` on the trigger | Your Mongo connection budget ÷ `maxPoolSize`, shared across the function's triggers; AWS's minimum is 2 per trigger | It applies per event source mapping, so their combined concurrency must stay within the budget. One handler on `default` and `bulk` through two mappings, at 100 connections and `maxPoolSize` 10, gets 5 each: 10 each would be 20 environments and 200 connections. Keep any reserved concurrency at or above their total, or Lambda may throttle, per AWS |
| `leaseMs`, `retryBackoffMs` | As for workers | A delivery never asks SQS for more than 11 h, since its 12 h limit on a message's visibility counts from the receipt, so a longer value is capped on push, and a crash at such a lease comes back after 11 h |
| Memory | Start at 1,769 MB, about 1 vCPU | Chosen for CPU. A 12 MP JPEG to 12 webp and avif variants peaked at about 360 MB in 14 s, and an SVG at 440 to 490 MB, in a Linux container of 1 CPU, not on Lambda |
| `concurrency` (image setting) | About the vCPU count: 1 or 2, not the default 4 | In that container the default 4 took 21 s against 14 s, with about 100 MB more |
| Runtime | `nodejs24.x` | |
| Architecture | The one Sharp is installed for: `arm64` in the example under Deployment | A mismatch fails at import, before your handler runs |
| Storage | `s3`, with `bucketPrivate` | `local` does not outlive the environment. Without `bucketPrivate` a private original is refused: `RESIZE_S3_BUCKET_NOT_ALLOWED`, dead on its first delivery |
| Indexes | From a migration, with `autoIndex: false` | As for workers. SQS needs no gate index, and the gate lock's TTL index comes from the same migration |
| Image settings | The same as the API's | As for workers: otherwise each side re-makes the other's previews (see [Freshness](#freshness)) |
| Network | In a VPC, a route to SQS and S3: a NAT gateway or VPC endpoints | Lambda's poller reads the queue from outside your VPC, so messages arrive, and then the handler's own calls hang until 2 s before the timeout, with no task run |

### Deployment

**Do not bundle.** Ship `node_modules` whole: the guide's handler with its dependencies is 52 MB, 14.5 MB zipped. The module looks for its optional peers on disk beside itself, and starts SVG's child process from a file next to its own, so a bundler breaks it in ways that depend on the flags. Measured with esbuild 0.28 (`--bundle --platform=node --format=esm --external:sharp`) on the guide's handler, with a real Mongo and local stand-ins for SQS and S3:

| Bundle | JPEG task | SVG task |
|---|---|---|
| No banner giving `require` through `createRequire` | Fails at import: `Dynamic require of "zlib" is not supported` | The same |
| Banner, AWS SDK inside | `RESIZE_PEER_MISSING` from every invocation | The same |
| Banner, `--external:@aws-sdk/*`, the SDK in `node_modules` | Works | `RESIZE_SVG_RENDER_UNAVAILABLE`, retried: the child script is looked for next to the bundle |
| The same, with `svgRasterChild.js` copied next to the bundle as `svgRasterChild.mjs` | Works | Works |
| `--external` of this package, the SDK and `mongoose`, so only your own code is bundled | Works | Works |
| A host without `@aws-sdk/client-s3`, SDK inside | Build fails: `Could not resolve "@aws-sdk/client-s3"` | The same |
| A host without `@aws-sdk/client-s3`, `--external:@aws-sdk/*` | Fails at import, `ERR_MODULE_NOT_FOUND`: esbuild hoists the lazy import into a static one | The same |
| `--format=cjs` | Build fails on the handler's top-level `await` | The same |

Sharp's binary must match the function's architecture, not your machine's. In a clean copy, run `npm install --omit=dev --os=linux --cpu=arm64 --libc=glibc`: on npm 12, without `--libc` no binary was installed. A wrong or missing one fails at import, before your handler runs, with `Could not load the "sharp" module using the linux-arm64 runtime` (measured in a Linux container, not on Lambda). Ship the AWS SDKs too: whether the module would find the copy in Lambda's runtime is on the check list.

### How a record ends

Only `completed`, `dead` and a malformed message moved aside are left out of `batchItemFailures`; everything else is listed, never thrown. A delivery that starts first sets the visibility to the lease, 60 s by default, so a crash comes back soon. `attempts` is the receive count, so every delivery counts, also one not started, and past `maxAttempts` a record is dead-lettered unrun. `resize.claim` reads as deliveries here, with a wait near zero. A task's other lines keep their `resize worker:` prefix, since the same `Consumer` writes them.

No metric says a record was not started: `resize.claim` records 0, and no `resize.task` follows. So the time a short function gets before its tasks die needs a log-based alarm, on the `was not started` `error` line. Past `maxAttempts`, `resize.task` reads `outcome: 'dead'`, `code: 'RESIZE_TASK_MAX_ATTEMPTS'`.

An outage or a bad deploy costs healthy tasks. A start check that rejects, or an import that fails, runs no task and makes no queue call, yet Lambda counts the invocation as failed, so it uses a receive of each record in it, and each comes back after the queue's visibility timeout. At a 300 s function, a visibility timeout of 1800 s and `maxReceiveCount` 7, with Mongo down or a wrong DSN: past about 2 h the first delivery after the fix is dead unrun, with `RESIZE_TASK_MAX_ATTEMPTS`, and past about 3 h SQS moves the message, with no module line, hook or cooldown. The dead-letter queue keeps a copy and a later read queues the media again, but a media only `prewarm()` queues stays without previews. So during a known outage disable the trigger, with `aws lambda update-event-source-mapping --uuid <UUID> --no-enabled`: Lambda stops polling, and the messages wait, up to the queue's retention. Afterwards call `prewarm()` again for what the dead-letter queue holds, whose bodies name each `mediaId` and `pipeline`. AWS's pages say a redrive makes each message a new one, with a new message ID, enqueue time and retention period; they do not state its receive count, which `attempts` reads, so a redrive stays on the check list (C19 in `RELEASE.md`), and `prewarm()` is the way until it passes.

### Stopping in time

The handler keeps back a reserve for the end of a task (`limits.processingTimeoutSeconds` + 5 s, never above half the time left), and the task gets the rest. The stop at the reserve goes through the existing timeout path: `RESIZE_TASK_TIMEOUT`, whose message names the budget rather than your `taskTimeoutMs`, with backoff. Finished variants persist, so the retry renders only the rest.

The handler then waits for the task to settle until 2 s before the deadline, lists the record and returns, with a `had not settled` `warn`. What still runs is frozen and may resume in a later invocation, which at worst repeats work, with one exception below. A metrics flush that hangs moves the return from 2 s to 1 s before the deadline.

A record with too little time is not started: too little means the time left minus the reserve is under the larger of 2 s and the longest delivery so far in this invocation. It is listed, with an `error` line on the first record of an invocation and a `warn` on a later one, and its visibility is left alone, so it comes back after the queue's visibility timeout. A longer visibility timeout gives an alarm more time to fire, and is not a fix.

A step that blocks the event loop defeats all of this, since no timer fires, and a hard kill loses the attempt: its rows are not stored, and its uploads become orphans.

On a short function the default reserve is half the time left, so the stop lands only half the time minus 2 s before the handler stops waiting, and the first invocation's start checks come out of the same time. The default reserve, a task of 40 variants that does not fit, 120 ms in-memory uploads, one machine, six deliveries per row. Real calls are slower, and a task that fits is not affected:

| Function timeout | Rows stored at return, per delivery | Files uploaded, per delivery |
|---|---|---|
| Under 4 s | Not started: 0 | 0 |
| 4 s to 4.02 s | 0 | 15 |
| 4.1 s to 4.2 s | 0, or 16 to 17, varying from delivery to delivery | 15 to 17 |
| 4.3 s | 17 | 17 |
| 4.5 s | 18 | 18 |
| 5 s | 20 | 20 |
| 6 s | 23 or 24 | 23 or 24 |

The refusal is at about 4 s, not exactly: at 3.999 s one delivery of six was refused. So where no row is stored, five deliveries leave up to 80 orphan files and no preview, with only `had not settled` on each, and the sixth dead-letters the task. An explicit reserve starts a first record from `stopBeforeTimeoutMs` + 2 s.

Measured with `SIGSTOP` on one machine, not on Lambda's freeze: a delivery that resumes after a thaw can write a late row. A read judges it as any other row, so most cases heal by a re-render, with orphan files. The exception: `invalidate()` during a freeze can be undone by a late row that reads fresh, and nothing heals that, so after replacing bytes in place on push, use a new ref or bump the pipeline's `version`. A sweep's "older than a day" assumes no later thaw. An observer still running at return freezes too, and may never finish. Frozen time counted toward Sharp's limit in that run, so a chain can fail just after a thaw, and its retry renders it.

### Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `RESIZE_DELIVERY_UNSUPPORTED` | Only the SQS driver takes pushed messages, so do not scaffold a `ResizeTask` model or a gate index for this, though a Resizer on the database queue can report those first: the start checks run before this refusal. A consumed queue name is not on SQS, or no Resizer has a task queue — consume that name with a worker, or leave it out of `createSqsHandler({ queue })`. When the message names other Resizers on that name that can take them, serve only those, with `createSqsHandler({ resizers })` |
| `RESIZE_SQS_EVENT_INVALID` | The event has no `Records` array, a record has no `messageId`, or the context has no `getRemainingTimeInMillis()` — check the function's trigger |
| `message … has no usable receiptHandle`, `no string body` or `no attributes.ApproximateReceiveCount …` | That record is listed alone, and the records beside it run. It comes back until a redrive policy or the queue's retention ends it, and with no count it never dead-letters — check the function's trigger |
| `RESIZE_CONFIG_INVALID` naming `stopBeforeTimeoutMs` | Pass a whole number of ms, at least 3000 |
| `RESIZE_NO_RESIZER` from the handler | The handler's file does not import the file that constructs your Resizers |
| `RESIZE_APP_NOT_INITIALIZED` from the handler | A framework host: run the guide's recipe before the first invocation |
| `RESIZE_PEER_MISSING` from the handler | The AWS SDK it names is not on disk beside the module, usually because it was bundled: see Deployment |
| `setting the visibility … had not answered` | The function has no route to SQS, and no task runs: see Network above |
| `setting the visibility … failed` | The role lacks `sqs:ChangeMessageVisibility`. The task runs, but a crash waits the whole visibility timeout |
| Failed tasks disappear | The trigger lacks `ReportBatchItemFailures` |
| A task in the dead-letter queue with no `is dead` line and no `onTaskDeadLettered` | `maxReceiveCount` is too low, so SQS's redrive ran first, and nothing logs it: set it to `maxAttempts` + 2 |
| `the first record … was not started` | The function timeout is too small. A task needs the time the line names just to start, plus the slowest task's time: start at 300 s, as a function just past that line's time stores no row for a task that does not fit (see [Stopping in time](#stopping-in-time)) |
| `message … was not started` (`warn`), or `RESIZE_TASK_MAX_ATTEMPTS` on tasks that never rendered | A batch does not fit: set batch size 1. With batch size 1 already, an outage or a bad deploy used up their receives: see [How a record ends](#how-a-record-ends) |
| `had not settled` | Raise the function timeout. Raise `stopBeforeTimeoutMs` only from a function of well over 5 s: an explicit reserve starts nothing under `stopBeforeTimeoutMs` + 2 s |
| `the start checks had not finished` | Every record is listed. The checks start over after a second miss, so ones that need more than two invocations' time never finish, and a hang in a driver given as a function gets no retry — check the connection settings, such as a `serverSelectionTimeoutMS` longer than the function timeout |
| `no consumed queue … matches` | The `queue` option, or the URL's account and name: a queue URL's path must end in `<account>/<name>`. The region is not compared, so a same-name ARN in another region matches and runs |
| `RESIZE_TASK_TIMEOUT` with a value below your `taskTimeoutMs` | The budget, see Stopping in time |
| `task … is dead and no deadLetterQueueUrl is set — deleting it` | Set a `deadLetterQueueUrl`, or the task's body is gone |

## Operations

- **Starting a worker:** once its checks pass, before it claims anything, the worker logs one `info`
  line naming what it serves: `resize worker started: queues 'default', 'bulk'; Resizers 'default',
  'listings'`. A worker that consumes nothing writes no start line. Disabled
  (`worker.enabled: false`), it logs a `warn`; with no task queue on any Resizer, the `error` line
  `resize worker: no Resizer has a task queue (eager-only wiring)`. In both cases the command
  resolves `false`, so a CLI entry that forwards the result, as the framework docs require, exits 1.
- **Task states (Mongo):** `pending → processing → completed`. A row's `active` is `true` from
  `add()` until the task completes: the row is the gate of its Resizer, media, pipeline and queue (see
  [Coordination](#coordination)). Rows written before the gate have no `active` and never block a
  new task. `startedAt` is when the latest delivery started (every claim sets it), and
  `finishedAt` when the task completed or was dead-lettered (a retry leaves both as they are); they
  are for inspection only, and the worker never reads them. An ejected or hand-written model
  without them keeps working (the times are dropped), but `npx --no -- resize-scaffold --check`
  reports it.
  - A failed attempt returns to `pending` with backoff, still active.
  - After `maxAttempts` the task is `dead`, and the lease never reclaims it. A task is `dead` at
    once when its error has `retryable: false` (`ResizeError.retryable`): no retry can help.
    The module sets it on every `ResizeSecurityError` and on eleven codes: the media store did not keep what a task wrote (`RESIZE_MEDIA_ROW_NOT_KEPT`), the media has no original (`RESIZE_NO_ORIGINAL`) or no id (`RESIZE_MEDIA_NO_ID`), a size has no usable
    dimension (`RESIZE_SIZE_INVALID`), no decoder reads the source's bytes
    (`RESIZE_SOURCE_FORMAT_UNSUPPORTED`), the source is damaged (`RESIZE_SOURCE_DAMAGED`), the
    source has no dimensions or exceeds the pixel or byte limits
    (`RESIZE_SOURCE_METADATA_MISSING`, `RESIZE_SOURCE_TOO_LARGE`), an SVG has
    dimensions that cannot fit the renderer (`RESIZE_SVG_DIMENSIONS_UNSUPPORTED`, also rejected
    before storage by `uploadOriginal()`), an SVG render ran past
    `limits.processingTimeoutSeconds` (`RESIZE_SVG_RENDER_TIMEOUT`), or the task was delivered more
    often than `maxAttempts` because its workers kept crashing (`RESIZE_TASK_MAX_ATTEMPTS`).
    The worker reads `retryable` on the error that fails the task, when it is a `ResizeError` —
    including one from
    a duplicate copy of the package (it checks the `isResizeError` brand, not the class); errors
    from other libraries are retried, whatever fields they carry. The rule for `false`: no later
    delivery of the same input can succeed, where a later delivery includes one after a rolling
    deploy reaches this worker, so `RESIZE_PIPELINE_UNKNOWN` and `RESIZE_DECODER_MISSING` stay
    `true`, and so does every unclear case. `RESIZE_MEDIA_ROW_NOT_KEPT` is the one exception: a
    deployed store fix would help, but every retry until then costs a render, an upload and an
    orphaned file. `ResizeOriginalError` and `ResizeConfigError` default
    to `false`, like `ResizeSecurityError`, and any other `ResizeError` to `true`;
    `RESIZE_WORKER_INCOMPLETE` is `false` only when every missing variant failed with `false` and
    the media still holds the original they were rendered from, and `generate()`'s
    `RESIZE_GENERATE_FAILED` only when every variant did. A
    `ResizeError` from
    `loadMedia`, `storage.download`, the decoder's checks and render, `beforeSteps` or
    `appendPreviews` with `retryable: false` dead-letters the task at once. Once the media has
    loaded, such a failure counts only for the original it came from: the worker reloads the media
    once, and if it holds another original (another `storageRef` or stored size), the task fails
    with the retryable `RESIZE_WORKER_INCOMPLETE`, whose `cause` is that failure, and the next
    delivery renders the new one. A reload that fails, or a media that is gone, keeps it final. A
    source that cannot be decoded fails the task (and `generate()`) with the decoder's error, or with the retryable
    `ResizeMediaError` `RESIZE_SOURCE_DECODE_FAILED` when that error is not a `ResizeError`
    (Sharp's own, for example; it is the `cause`). A damaged source stays retryable in two cases:
    its download length differs from `original.size` (`RESIZE_SOURCE_DECODE_FAILED`), or no decoder
    of this process lists its stored format (`RESIZE_DECODER_MISSING` when it fails at `inspect`,
    `RESIZE_SOURCE_DECODE_FAILED` when it fails at render). An
    error inside one variant (`variantSteps`, encoding, `storage.upload`) fails only that
    variant: it is logged as a `warn`, and the task fails with `RESIZE_WORKER_INCOMPLETE`, whose
    `cause` is the first failure of a variant still missing, so the task row and the task's log
    line say why (with several, the text counts them). It is retryable (retried for the missing
    variants only, then dead-lettered after `maxAttempts`), unless every missing variant failed with
    `retryable: false` and the original has not changed since, when the task is dead-lettered at
    once. An original replaced during the render keeps the task retryable: the next delivery renders
    the new one.
  - A dead row keeps the gate (`active`) until its `cooldownUntil` (`deadAt` +
    `coordination.cooldownMs`); then the next `add()` takes it over (see
    [Coordination](#coordination)).
  - Completed rows expire after 24 h and dead rows after ~30 days (the `expireAfterSeconds` in
    the model).
- **Worker memory:** a worker holds the decoded source as raw pixels, decoded once per task at
  the largest box the requested previews need. Each size is then held raw too, up to
  `concurrency` sizes at once, each up to `limits.resultDimension`² pixels. An animated size holds
  frames × size pixels × channels bytes; the frames are cut so that frames × the larger of the
  source's and the size's pixels stays within the pixel budget
  `min(limits.sourcePixels, limits.inputPixels)`. With `beforeSteps` the source is decoded at
  least at its own size, and the peak is about 2 × width × height × 4 bytes (a step's input and
  its result): up to about 400 MB at the default `limits.sourcePixels` (50,000,000); the step's
  result is released once the sizes are made from it. Size worker containers for
  `limits.sourcePixels`. The pixel
  limit after `beforeSteps` (`min(limits.sourcePixels, limits.inputPixels)`) is checked once, on
  the dimensions of the raster the last step returned, so a step that grows the image has already
  allocated it at its full size when it is rejected (`RESIZE_SOURCE_TOO_LARGE`,
  `retryable: false`). Steps are host code. With `variantSteps`, a worker also holds one copy of the
  size's pixels and the step's result per variant in progress, up to
  `width × height × (channels + 4)` bytes each, up to `concurrency` at once: about 117 MB per variant
  at a 5000-wide size of a 3:2 source. Measured with one `composite` step at the default
  `concurrency` of 4, writing JPEG and WebP, the process's peak RSS is about 185 MB (0.3.0: about
  130 MB) on a 24 MP JPEG at 1920, 1280 and 620 wide and 300×300, about 975 MB (0.3.0: about 590 MB)
  on that JPEG at 5000, 4000, 3000 and 2000 wide, and about 1.9 GB (0.3.0: about 1.5 GB) on a 24 MP
  PNG with alpha at those widths.
- **At-least-once delivery:** a task can run more than once. The worker skips previews that
  already exist fresh, and the media store keeps one row per preview identity, so a repeat never
  duplicates them. A task completes only when every requested
  variant is stored fresh. When an attempt is only partly successful, its previews are saved and the
  next attempt makes only the missing ones.
- **Push delivery** (an SQS-triggered Lambda) can run tasks instead of a worker process, as a preview: see [Push delivery (preview)](#push-delivery-preview).
- **Retrying a dead task:** after fixing the cause, call `prewarm()` for that media once the
  cooldown (`coordination.cooldownMs`, 10 minutes by default) has ended: on Mongo its `add()` then
  takes the dead row over and queues a new task. Until then `prewarm()` reports the retryable
  `RESIZE_TASK_IN_FLIGHT` (on SQS, the retryable `RESIZE_ENQUEUE_LOCK_CONTENDED`). To replay the
  dead row itself instead, at any time, make it pending and active again. The gate index allows
  one active row per Resizer, media, pipeline and queue:

```ts
await ResizeTask.updateOne(
  { _id: row._id, status: 'dead' },
  {
    $set: {
      status: 'pending',
      active: true,
      attempts: 0,
      cooldownUntil: null,
      leaseExpiresAt: null,
      availableAt: new Date(),
    },
  },
); // a duplicate-key error (11000) means another task for this media, pipeline and queue is active
```

- **Preview rows** carry, besides the fields `resolve()` reads, `bytes` (the encoded size),
  `createdAt` (when the row was stored), `origin` (a signature of the original it was made from:
  its storage ref and dimensions) and `encodeSig` (a signature of its format's encode settings,
  the sharpen setting of its fit mode, its animation settings (for animated formats: `animated`,
  `limits.animationFrames` and the pixel budget `min(limits.sourcePixels, limits.inputPixels)`,
  which also caps the frames at the larger of the source's and the preview's size), the
  result-dimension cap, the fit box (for fit rows) and the
  pipeline `version`). The worker and `generate()` record them on every row they write, and
  `resizeMediaSchemaFragment` declares them. The read path, `prewarm()`, `generate()` and the
  worker compare them with what the current settings would record (see [Freshness](#freshness)).
  Rows without `origin` and `encodeSig` (written by 0.2.x or earlier) are stale: each is served until
  its replacement is stored, regenerated on its next read, and its old file stays in storage
  (plan the storage cost and the cleanup). Rows without an `identity` (written before 0.3.0) are
  never removed by `invalidate` or `replacePreviews`: delete their files yourself.
- **What a read logs:** a read writes a log line only for what an operator must fix, and only once
  per Resizer (once more after its task queue is set up again): an unregistered pipeline name
  (`error`, once per name, for at most 100 names), a format list without `encode.formats` entries
  (`error`, once per list, for at most 100 lists), a Resizer that could not start (`error`, once per
  error message, for at most 100 messages), and, when the caller passed `enqueueMissing: true` to a
  Resizer without a task queue, one `warn`. Each read of a Resizer that could not start builds it
  again: a build that fails with a new message logs that message, and a good build ends this with no
  line of its own, so a read then serves as usual. Every read is counted
  instead, as `resize.read` with its outcome (see [Metrics](#metrics)). A stored preview whose
  `publicUrl` throws, and an enqueue that throws, are still logged on every read. `prewarm()` logs
  as before.

  A media loaded without the module's fields gets one `warn`, once per Resizer:

  ```text
  resize resolve: media <id> was loaded without its stored original and previews (a projection that drops resizeMediaPaths, or a row the module never wrote), so nothing is served or queued for it — add ...resizeMediaPaths to the query (logged once per Resizer)
  ```

  With only `previews` dropped, the line ends in "its previews are not seen and may be made again";
  with previews and no original, in "its previews are served as stale and no task is queued". A
  media loaded with an empty `previews` and no original logs nothing: it is a new row. One with
  neither field gets the warning above, which is one harmless line for a lean row the module never
  wrote.

  On `MongoTaskQueue`, the first added task checks the gate index, once per model. A missing index
  is one `error`, whose line ends in what that costs. With no index on those keys, or one that is
  not unique, concurrent adds can each store a duplicate active task. With a unique index that lacks
  the partial filter, every add after a completed task is in flight with no id and nothing is
  queued. With a unique index on another filter, one active task per media, pipeline and queue is
  not guaranteed. The check runs in the background, so it never slows the read, and it never creates
  the index.
- **What a worker logs:** the worker writes each task failure itself, one line on its own logger
  (`runWorker({ logger })`; the app logger under `npm run cli ResizeWorker`). A failure that will
  be retried is a `warn`, a dead task an `error`:

  ```text
  resize worker: task <taskId> of media <mediaId> failed (attempt 1 of 5, code RESIZE_SOURCE_DECODE_FAILED) — retrying in 5000 ms: <cause>
  resize worker: task <taskId> of media <mediaId> is dead (attempt 5 of 5, code RESIZE_SOURCE_DECODE_FAILED, last attempt) — new tasks for its media and pipeline wait 600000 ms: <cause>
  ```

  They are written whatever the metrics sink is, `NoopMetrics` included. Each variant that fails
  writes a `warn` of its own, on every attempt, in `generate()` too, whose caller gets the failed
  count or the throw, with the first failure as its `cause`. So the worker writes one `error` line per dead task, however many variants and
  attempts it took: alert on `error`, or on `is dead`. On SQS without a `deadLetterQueueUrl`, the
  queue adds one more as it deletes the task (`resize sqs: task … is dead and no deadLetterQueueUrl
  is set`). Other failures have `error` lines of their own, such as a media store write that failed,
  which names the uploads it left unrecorded. A dead line gives one of three reasons: `last attempt`
  (`maxAttempts` used up), `not retryable` (the error has `retryable: false`) or
  `delivered more often than maxAttempts` (its workers kept crashing mid-task). The code is `none`
  for an error without one. The cause fits one line of at most 1000 characters, with ` | ` for a
  line break, and the task row holds the same text. A thrown value cannot break the module's line:
  its cause and code stay on one line, and a line break anywhere in the line, such as in a `mediaId`
  from an SQS message body, reads ` | `. The error (on a dead line, any error that is not a
  `ResizeError`) goes to your logger as the second argument, and what it prints is your logger's,
  so do not treat later lines as the module's own. On the global console every `%` in the line is
  escaped, so a `%` in a URL cannot consume the error or rewrite the line. A logger that formats its
  first argument itself (pino, or a wrapper around `console.error`) can still treat a `%` in a cause
  as a placeholder, and Winston, the framework's logger included, leaves the error out of an entry
  whose line holds a format sequence such as `%c3` or `%s`: the line and its `(cause: …)` stay, the
  stack does not.
  A worker that no longer holds its task (a lost lease) writes a `warn` and never a dead line.
- **Damaged originals:** a source the engine refuses is dead-lettered on its first delivery with
  `RESIZE_SOURCE_DAMAGED`, unless the media was given another original while the task ran, when the
  task is retried and renders that one. Its pixels are decoded at `limits.failOn`, and that message names the
  level; its header is read at Sharp's own default level, whatever `limits.failOn` says. `'error'`
  refuses a truncation that cuts image data; a cut TIFF is usually retried, not refused, and a cut
  animated GIF can still render the frames it has, so its preview can be shorter. Three limits:
  bytes flipped mid-file can still render garbled at every level; a JPEG missing only its end marker
  is usually refused at every strict level (the few that pass have all their image data and render
  the same pixels as the intact file); and a PNG with a bad IDAT checksum is refused at `'error'`
  (`vipspng: libpng read error`), although it renders the same pixels as the intact file at
  `'none'`. `'warning'` refuses more, including JPEGs that look identical to the intact file.
  `'none'` restores 0.3.0's rendering; a file whose header cannot be read still
  fails, usually at once. Decoding failures at the same moment in one process can blur which file
  an engine message belongs to, so a failure with no usable detail is retried. They can also,
  rarely, put a neighbour's damage line on a healthy file this build cannot render (7 of 800 decodes
  with such files and cut JPEGs failing together); that file is then dead-lettered until the next
  read after the cooldown. To refuse a damaged file at upload instead, set `upload.verify: 'decode'`.

  **Previews made before this version.** A preview made from a damaged original stays fresh:
  upgrading does not regenerate it. To find them, decode each original at the level the worker now
  uses, with your `limits.inputPixels`. Skip SVG originals: SVG markup is untrusted, and the module
  renders it only in a separate process with a time limit. The bytes decide, because a stored
  `format` can hold a MIME type or a wrong value.

  ```ts
  import sharp from 'sharp';
  const { format, storageRef } = media.original;
  if (format !== 'svg') {
    const bytes = await storage.download(storageRef);
    const input = { limitInputPixels: limits.inputPixels };
    if ((await sharp(bytes, input).metadata()).format !== 'svg') {
      await sharp(bytes, { ...input, failOn: 'error' })
        .resize(16)
        .raw()
        .toBuffer(); // rejects: look at this file
    }
  }
  ```

  A rejection from either call means "look at this file", not proof of damage: a healthy file this
  build cannot decode rejects too. For each one that is damaged, call `invalidate()` and delete the
  returned refs. Its next task is dead-lettered with `RESIZE_SOURCE_DAMAGED`, and while reads keep
  asking, each cooldown costs one download, one decode and one `error` line, so mark that media in
  your app or replace its original. A second pass at `failOn: 'warning'` also finds some mid-file
  corruption, but it flags harmless JPEGs too, so look at those by eye. The worker accepts them, so
  `invalidate()` alone makes the same preview again. Flipped bytes can pass every level: no decode
  finds them. A cut animated GIF can pass too, and this recipe reads only its first frame.
- **Removing previews:** `resizer.invalidate({ media, pipeline? })` removes this Resizer's stored
  previews of a media, of one pipeline or of all (only an omitted `pipeline` means all;
  `pipeline: null` matches nothing), in one media store write, and resolves with the
  storage refs of the rows it removed. Delete those objects yourself: the module never deletes
  files, and never queues. It loads the media fresh, picks this Resizer's rows that carry an
  `identity` (rows without `resizer` or `pipeline` count as `'default'`; the pipeline need not be
  registered, so a renamed pipeline's rows can be removed), and also drops them from the caller's
  `media.previews`, so a same-request `resolve()` does not serve them (when that array cannot be
  changed, it logs a warning and still resolves with the refs). It takes no gate: a task running
  for that media can store rows after it returns, and a row stored between its read and its write
  under a new identity stays. A media that is gone gives `[]`; a store failure rejects, and then
  nothing was removed. It needs `replacePreviews` on the media store (`RESIZE_MEDIA_REPLACE_MISSING`
  without it). Reload the media before saving it after `generate()` or `invalidate()`; the module
  wrote the rows itself.

```ts
const refs = await getResizer().invalidate({ media: file, pipeline: 'photo' }); // omit pipeline: all
// Delete each ref's object with your own storage client; the next read or prewarm() queues new ones.
```

- **Your app's responsibilities:** deleting media and their storage objects (the refs that
  `invalidate` returns too), access checks, the response shape, moving legacy data onto the module
  (the module's part is [`adoptOriginal()`](#adoptoriginal)), and domain image analysis such as face
  blurring (in pipeline steps).

### `adoptOriginal()`

`resizer.adoptOriginal({ storageRef, maxBytes? })` measures and decodes an object already in storage
and resolves with the `Original` that `uploadOriginal()` would return for it. It writes nothing and
queues nothing: save the result as it is, and do not change it later, because a changed ref
regenerates that media's previews. The result holds the ref's JSON form, which is what a save stores,
so a `namespace: undefined` in the ref you pass is not in it. `hasOriginal(media)` tells whether a
media is on the module yet. The how-to, with the backfill loop, is in the guide:
[Adopting on an app with existing media](https://framework.adaptivestone.com/docs/resize#adopting).

`limits.sourceBytes` is its cap, shared with the workers. `upload.maxBytes` and `upload.formats` do
not apply. Each call holds the object in memory: about one object on local storage, and on S3 about
2.3 times it with a current AWS SDK and about 3.3 times with SDK 3.572, per concurrent call (measured
at 250 MiB). So on a request path, where a client chose the file, pass `maxBytes`, or run the adoption
from a job. It lowers the cap for this call and cannot raise it. Over it, the shipped drivers read
nothing, except on an S3 response with no length, where the object is read whole and then refused
with the same code. Real S3 sends a length.

The download has no timeout of its own, so set one on your storage client: for S3, pass
`new S3Storage({ …, client })` with `requestHandler: { socketTimeout: 5000 }`. Use a value under
6000 ms, because on current SDKs a larger one does not end a body that stalls after its headers
(measured against a local server, not real S3).

It refuses what a worker could never render, and a public SVG, so it always decodes the object, on a
Sharp thread, in the process that calls it. The check decodes the first frame. With `animated: true`,
damage in a later frame shows up on the worker as a dead task, `RESIZE_SOURCE_DAMAGED`.

| Case | Class | Code | `retryable` |
|---|---|---|---|
| No `storageRef`, or one JSON cannot represent (circular, a BigInt) | `ResizeOriginalError` | `RESIZE_ORIGINAL_STORAGE_REF_INVALID` | `false` (at upload, where a driver returned nothing, it is a `ResizeStorageError` and `true`) |
| `maxBytes` is not a positive safe integer | `ResizeSetupError` | `RESIZE_ADOPT_MAX_BYTES_INVALID` | `false` |
| Over the call's own `maxBytes` | `ResizeOriginalError` | `RESIZE_ORIGINAL_TOO_LARGE` | `false` |
| A driver's own `ResizeError`: a third bucket, a refused key or ref, a missing object, over the limit | as thrown, the same object | its code, e.g. `RESIZE_S3_BUCKET_NOT_ALLOWED`, `RESIZE_STORAGE_KEY_INVALID`, `RESIZE_STORAGE_NOT_FOUND`, `RESIZE_SOURCE_TOO_LARGE` | its own |
| Any other driver error, or a driver that resolved with something other than bytes | `ResizeStorageError` | `RESIZE_ORIGINAL_DOWNLOAD_FAILED` | `true` |
| A driver that ignored `maxBytes`, over `limits.sourceBytes` | `ResizeMediaError` | `RESIZE_SOURCE_TOO_LARGE` | `false` |
| Empty object | `ResizeOriginalError` | `RESIZE_ORIGINAL_EMPTY` | `false` |
| Not an image, unknown format, one frame over the pixel limit | `ResizeOriginalError` | `RESIZE_ORIGINAL_INVALID`, `RESIZE_ORIGINAL_FORMAT_UNSUPPORTED`, `RESIZE_ORIGINAL_TOO_MANY_PIXELS` | `false` |
| An unrecognised engine failure during `inspect` | `ResizeOriginalError` | `RESIZE_ORIGINAL_INSPECT_FAILED` | `true` |
| Public SVG | `ResizeOriginalError` | `RESIZE_ORIGINAL_SVG_PUBLIC` | `false` |
| Public, and its decoder has no `publicOriginals: true` | `ResizeOriginalError` | `RESIZE_ORIGINAL_PUBLIC_REFUSED` | `false` |
| The decode finds damage | `ResizeOriginalError` | `RESIZE_ORIGINAL_DAMAGED` | `false` |
| The decode fails for another reason | `ResizeOriginalError` | `RESIZE_ORIGINAL_VERIFY_FAILED` | `true` |
| A host decoder's final refusal (`retryable: false`), at `inspect` or in the decode | `ResizeOriginalError` | its own code | `false` |
| A decoder's setup or config error | as thrown, the same object | its own code | its own |

**Which keys are refused.** `S3Storage` reads any key except one with a control character, a `.` or
`..` part, a leading `/` or an empty part: `uploads//cat.jpg`, `dir/` and a name holding a tab are
`RESIZE_STORAGE_KEY_INVALID` (`retryable: false`). A key that holds a client's file name is fine.
`LocalFsStorage` paths stay in `[A-Za-z0-9_.-]`, because they are filesystem paths. For such an
object, copy it to a new key and adopt that. On S3 a `namespace` must leave room for a preview's key
within S3's 1024-byte limit, and a preview adds about 50 bytes to it. Too long adopts, then every
preview fails with `RESIZE_S3_KEY_TOO_LONG` and the task is dead at once: omit or shorten it.

### `prewarm()` issues

`prewarm()` never throws. A requested variant without a confirmed task is in `result.unconfirmed`,
and `result.issues` says why, each issue with the variants it covers and `retryable`. `false`: the
module knows that no retry can help until the request, the config or the code changes. `true`: the
module has not ruled a retry out. The cause may pass by itself, or it is a fault that the queue
can only report in the logs (a lock store that fails): fix the logged cause before you retry. An
issue may also carry `causeCode`, the code of the error behind it when that code is not one of the
issue codes below: a driver's own code, or `RESIZE_PEER_MISSING`, under
`RESIZE_ENQUEUE_QUEUE_FAILED`, `RESIZE_LOCKS_REQUIRED` under `RESIZE_ENQUEUE_LOCK_FAILED`, and what
a queue names (`RESIZE_MONGO_MODEL_MISSING` or `RESIZE_MONGO_MODEL_OUTDATED` from `MongoTaskQueue`)
under `RESIZE_ENQUEUE_UNCONFIRMED`. The set of issue codes is closed, so a `switch` over `code` stays
exhaustive.

| `code` | When | `retryable` |
|---|---|---|
| `RESIZE_PIPELINE_UNKNOWN` | The pipeline (any name but `'default'`) is not registered on this Resizer; nothing is queued | `false` |
| `RESIZE_FORMAT_NOT_CONFIGURED` | A requested format (in the call, or from a `beforeEnqueue` tap) has no `encode.formats` entry; it is never queued | `false` |
| `RESIZE_ENQUEUE_NO_ORIGINAL` | The media has no `original.storageRef` | `false` |
| `RESIZE_ENQUEUE_NO_QUEUE` | The Resizer has no task queue (eager only) | `false` |
| `RESIZE_QUEUE_NOT_SERVED` | The Resizer's task queue does not serve the call's `queue`: a name it has no queue for (in a framework app or a `createResizer` config, one that `queues` does not define; for `SqsTaskQueue`, one without a URL), or a name whose backend's optional SDK is not installed in this process (the message names the package). Nothing is queued: it is reported before any gate lock or `add()` | `false` |
| `RESIZE_ENQUEUE_VARIANT_CONFLICT` | Different payloads share one preview identity, in the request (e.g. after a `beforeEnqueue` tap) or in the active task, so none of them can be confirmed | `false` |
| `RESIZE_TASK_IN_FLIGHT` | A task queue with `gatesByTask` (Mongo): a task of this Resizer, media, pipeline and queue is active, or a dead one is cooling down, and does not hold these variants | `true`: call again after it ends |
| `RESIZE_ENQUEUE_LOCK_CONTENDED` | A task queue without `gatesByTask` (SQS): the gate lock is held (a task queued, running or waiting for a retry, a dead task's cooldown, or the one-lease hold after an add that threw or was not confirmed); SQS cannot say which variants that task holds | `true`: call again after it ends |
| `RESIZE_ENQUEUE_LOCK_FAILED` | A task queue without `gatesByTask`: acquiring the gate lock threw (logged). Also, with `causeCode: 'RESIZE_LOCKS_REQUIRED'`, a call on a queue whose backend has no gate of its own, on a Resizer with no lock store (a `RoutingTaskQueue`, whose need for locks is per name) | `true`, even when the lock store fails for good: fix the logged cause first; `false` with `causeCode: 'RESIZE_LOCKS_REQUIRED'` |
| `RESIZE_ENQUEUE_QUEUE_FAILED` | `add()` threw (logged), e.g. an SQS send error; the task may still be stored. Beside a queue without `gatesByTask` the gate lock is then kept for one lease (at most `gateTtlMs`), so a `prewarm()` in that time reports `RESIZE_ENQUEUE_LOCK_CONTENDED` and the read path logs nothing. Also the backend of the call's queue failed to build (a `RoutingTaskQueue` route): the error's code is in `causeCode`, unless that code is itself an issue code, which is then the issue's code | `true`: fix the logged cause first. For a backend that failed to build, the error's own `retryable` (`true` for an error that is not a `ResizeError`) |
| `RESIZE_ENQUEUE_UNCONFIRMED` | `add()` resolved `unconfirmed`: the queue did not confirm the task (on Mongo a database error, a duplicate key on another unique index of your model, or an unregistered or outdated `ResizeTask` model, each logged, the model with its code in `causeCode`; on SQS a send that returned no `MessageId`). Or `add()` resolved a value in none of the `TaskAddResult` shapes (a queue written for an older version), logged once | `true`: fix the logged cause first. `false` when the queue says so, as `MongoTaskQueue` does for an unregistered or outdated model (fix what `causeCode` names), and for a value in none of the shapes |
| `RESIZE_ENQUEUE_CONFIRM_FAILED` | After an `in-flight` add, `findActive()` threw (logged), so what the active task holds is unknown | `true` |
| `RESIZE_ENQUEUE_INTERNAL_ERROR` | An unexpected error (e.g. a media without an id, `RESIZE_MEDIA_NO_ID`), a Resizer that could not start (a part that did not load, an invalid config), a task queue that cannot be used (the error `verify()` reports, e.g. `RESIZE_LOCKS_REQUIRED`), or an invalid timing of the call's `queue` (a name used only per call; every variant is `unconfirmed`); the message is the error's | `false` when the error is a `ResizeError` with `retryable: false`, or a `ResizeMediaError`, `ResizeConfigError` or `ResizeSetupError` (or a subclass); otherwise `true` |

## Error codes

Every code the module raises, sorted so you can search for it. `retryable` is what the error carries when a task or a caller reads it: `false` means no later delivery of the same input can succeed, and the worker dead-letters the task at once (the rule, and the exceptions a row names, are under [Operations](#operations)). A dash means no worker decision depends on it: the wiring is wrong, so fix that rather than branch on the value, or it is a [`prewarm()` issue](#prewarm-issues), whose table gives its `retryable`. Every error extends `ResizeError`, and `err.name` says which subclass it is. What each subclass asks of a catch block is in the guide's [Errors](https://framework.adaptivestone.com/docs/resize#errors). What an upgrade changed is in [`UPGRADING.md`](./UPGRADING.md).

| Code | `retryable` | When, and what to do |
|---|---|---|
| `RESIZE_ADOPT_MAX_BYTES_INVALID` | `false` | From `adoptOriginal()`: `maxBytes` is not a positive safe integer — pass one, or leave it out for `limits.sourceBytes` |
| `RESIZE_APP_NOT_INITIALIZED` | — | A `FrameworkResizer` (or another part from `…/framework.js`) read the framework app before the `Server` was constructed — construct the Server before the first call (importing `src/resizer.ts` earlier is fine: it reads nothing until first use); in tests, install a fake app with `setAppInstance` from `@adaptivestone/framework/helpers/appInstance.js` |
| `RESIZE_CONFIG` | `false` | The default code of a `ResizeConfigError` whose throw names none: a host or driver error. Fix the config. |
| `RESIZE_CONFIG_COORDINATION_INVALID` | — | From `verify()` or at worker start (reads serve stored previews and queue nothing; `prewarm()` reports it): `coordination` is not an object, or a value in it is not a positive safe integer (ms; `0` is rejected too, so the cooldown cannot be turned off) — fix the key the message names, or the whole section when the message shows its value (`coordination` in `src/config/resize.ts`, the only file it is read from since it is process-wide, or the `coordination` option) |
| `RESIZE_CONFIG_FORMATS_INVALID` | — | `formats` in the config holds an empty id, or an id with no `encode.formats` entry (`formats [...] have no encode.formats entry`): use an id the defaults hold, such as `jpeg`, or add `encode.formats.<id>` (`{}` for the engine's defaults, except `heif` and `heic`: `heic: {}` passes `verify()`, then every render fails, and `heic: { compression: 'av1' }` writes), or request only configured ids; a `jpg` id needs its own `encode.formats.jpg`, and `encode.flatten.formats` must name it or transparent pixels turn black; naming it there changes its signature, so its previews regenerate |
| `RESIZE_CONFIG_INVALID` | `false` | The config is malformed, and the message names the part: a config (or config file) that is not an object, a `storage` section without a driver name, an empty or whitespace-only `rootDir` or `privateRootDir` of local storage (also from `new LocalFsStorage()`, at construction: `''` would resolve to the working directory, and `'.'` says that on purpose; `publicBaseUrl: ''` stays valid), a `storage` or `queues` driver name the Resizer does not have (not `'local'` / `'s3'` or `'database'` / `'sqs'`, nor a name in its `drivers`; checked when the Resizer first reads that section, so for a config file on first use or in `verify()`, and a disabled worker never checks it: it logs a `warn`, and the command resolves `false`, so a CLI entry that forwards the result, as the framework docs require, exits 1), a `database` section of `createResizer` without driver `'mongo'` (or a registered one), a `'mongo'` `database` section whose `connection` is not a Mongoose connection (`mongoose` itself is refused: pass `mongoose.connection`) or whose `mediaModel` has no `findById` and `findOneAndUpdate` functions, a `'database'` queue in a `createResizer` config without a `database` section, a `queues` map that is not an object of names, a `queues` entry with a blank name or without a `driver`, an SQS entry without `queueUrl`, two SQS entries with the same `queueUrl`, a `queue` that is neither a queue name nor `false`, a process-wide section (`queues`, `worker`, `coordination`) outside `src/config/resize.ts` (in another file, or in the `config` option), a `worker` section that is not an object or whose `enabled` (boolean), `sharpConcurrency` (positive integer) or `sharpCache` (boolean) has the wrong type (each key is optional and defaults), an unknown `worker` key (e.g. a misspelled `sharpConcurency`), an `engine` or `decoders` key in a config (each is an option, in code), or image settings of the wrong type (`upload.verify`, `maxSize`, `animated`, `encode.formats`, `encode.flatten`, `encode.sharpen`, `limits`, `concurrency`; `limits.processingTimeoutSeconds` above 3600 too, the longest Sharp accepts), or a `stopBeforeTimeoutMs` of `createSqsHandler()` below its least — fix what the message names. A config file fails on first use or `verify()`; a config object passed in code, at construction (a config function: at first use), except an unregistered `queues` or `database` driver name in it and what a driver checks in its own section (the `'mongo'` `connection` and `mediaModel`, say), which are reported on first use or `verify()` (an unregistered `storage` driver in it throws at construction) |
| `RESIZE_CONFIG_MEDIA_MODEL_MISSING` | — | ``resize config: `mediaModelName` is required``: set it in the host `src/config/resize.ts` (or the `configName` file named in the message) |
| `RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN` | — | At worker start: `mediaModelName` does not match a registered host model — fix the name |
| `RESIZE_CONFIG_QUEUE_INVALID` | — | The queue timing is invalid (`leaseMs`, `idlePollMs` and `taskTimeoutMs` can be at most 2147483647, the longest a timer can wait) — fix the key the message names (in `queues.<name>` of `src/config/resize.ts` or of a `createResizer` config, or the task queue's `timing` / `getTiming`; for a builder route of a `RoutingTaskQueue`, the router's `getTiming` option). A config file fails on first use with the rest of the file. A task queue's own timing is checked per queue name: `verify()` rejects for the Resizer's own queue, worker start for each queue it consumes, and each call on the name fails it (`prewarm()` reports `RESIZE_ENQUEUE_INTERNAL_ERROR`, not retryable; `resolve()` logs it once per queue name, on the first read of that queue, and serves stored previews). It is no longer logged when the Resizer starts |
| `RESIZE_CONFIG_QUEUE_LEASE_INVALID` | — | See `RESIZE_CONFIG_QUEUE_INVALID`. |
| `RESIZE_CONFIG_QUEUE_UNKNOWN` | — | On first use or from `verify()`: the Resizer's queue name (its `queueName` option, or its file's `queue`, or the implied `'default'` when the file sets none) is not an entry of `queues` in `src/config/resize.ts` — add `queues.<name>` (e.g. `queues: { default: { driver: 'database' } }`), set `queue`/`queueName` to a defined name, or `queue: false` (`tasks: false` when the name came from the option) for eager only |
| `RESIZE_CONFIG_REMOVED_KEY` | — | A removed key or an old shape is still in a config (a config file, an environment override, a config passed to `new Resizer`) or in an option (a task queue's `timing`, the `S3Storage` option `publicUrl`, `runResizeWorker({ configName })`), or the worker got its removed `--config` flag: move it to the path the message names. The list is in [Removed keys](./UPGRADING.md#removed-keys). |
| `RESIZE_CONFIG_STORAGE_MISSING` | — | Add `storage: { driver: 'local', … }` (or `'s3'`, or a driver passed in `drivers`) to the config named in the message (a config file, or the config passed to `createResizer()`), or pass `storage` to `new FrameworkResizer()` or `createResizer()` |
| `RESIZE_CONFIG_UPLOAD_FORMATS_INVALID` | — | See `RESIZE_CONFIG_UPLOAD_INVALID`. |
| `RESIZE_CONFIG_UPLOAD_INVALID` | — | `upload` is not an object, `upload.maxBytes` is not a positive safe integer, or `upload.formats` is not a non-empty list of non-empty format ids — fix that key, e.g. spread the defaults' `upload` and change one value |
| `RESIZE_CONFIG_UPLOAD_MAX_BYTES_INVALID` | — | See `RESIZE_CONFIG_UPLOAD_INVALID`. |
| `RESIZE_DECODER_INVALID` | `true` | A `decoders` entry is not a decoder (at construction: it needs a non-empty `formats` list and `inspect` and `render` functions), or a decoder broke the contract (its `inspect` result, or a raster whose `data` length does not match its `info`) — fix the decoder |
| `RESIZE_DECODER_MISSING` | `true` | On a task or from `generate()` (retried): no decoder in this process lists the stored `original.format` and none reads the bytes — pass the decoder in `decoders` in every process (API and worker), or fix an `original.format` that holds an alias of bytes no decoder reads |
| `RESIZE_DELIVERY_UNSUPPORTED` | — | See the table in [Push delivery (preview)](#troubleshooting). |
| `RESIZE_DRIVER_CONFLICT` | — | From `new FrameworkResizer()`: every `FrameworkResizer` of the process shares one task queue set, so each must pass the same `drivers.queue` map (the same names, the same driver objects): this one passes another driver, an extra name, or no map where an earlier one passed one (or the reverse). Eager-only Resizers and Resizers with `tasks` in code are compared too; the Resizer's name stays free — pass every `FrameworkResizer` the same `drivers.queue` (e.g. one shared object). A host that passes no `drivers` anywhere is unaffected, and storage drivers may differ per Resizer |
| `RESIZE_DRIVER_INVALID` | — | At construction (the Resizer's name stays free): the `drivers` option is not an object, has a kind other than `storage`, `database` or `queue`, or an entry has no `fromConfig` function (a queue driver's `backendOf` and `validate` must be functions when given) — the message names `drivers.<kind>.<name>`. On first use: a driver's `fromConfig` returned something that is not the part (a storage needs `upload`, `download`, `publicUrl`; a media store `loadMedia`, `appendPreviews`, `replacePreviews`; a task queue the five required methods and every name of its entries), or a `RoutingTaskQueue` builder resolved something that is not a task queue — fix the driver |
| `RESIZE_DUPLICATE_RESIZER` | — | From a constructor, `a Resizer named '…' already exists`: each name is constructed once per process — import the single construction site; elsewhere `getResizer(name)`. At worker start, "the `resizers` list names '…' twice": two different Resizers in `runWorker({ resizers })` share a name, so tasks could reach only one — give each its own name |
| `RESIZE_ENGINE_FORMAT_UNSUPPORTED` | — | From `verify()` or at worker start: a format in `formats`, or an `encode.formats` entry the host wrote or changed, is not in `engine.formats` (a package default outside `formats` that the host left alone is not checked) — remove it, use an id the message lists (ids are matched exactly: `jpg`, not `JPG`), or, for a custom engine, list it in `formats`. An API process that calls `verify()` needs the worker's `engine` too |
| `RESIZE_ENGINE_INVALID` | `true` | The `engine` option is not an image engine (at construction: it needs `id`, `formats`, `animatedFormats`, `resize` and `encode`), or an engine broke the contract (a resize result of another size, an animation frame with another channel count, an encode result without `data`, `contentType` or a size, with empty `data`, a `contentType` that is not `image/…`, a size other than its raster's, or a `format` that is not a file extension) — fix the engine |
| `RESIZE_ENQUEUE_CONFIRM_FAILED` | — | A `prewarm()` issue: see [`prewarm()` issues](#prewarm-issues). |
| `RESIZE_ENQUEUE_INTERNAL_ERROR` | — | A `prewarm()` issue: see [`prewarm()` issues](#prewarm-issues). |
| `RESIZE_ENQUEUE_LOCK_CONTENDED` | — | In `prewarm()` issues, on a task queue without `gatesByTask` (SQS): the gate lock of this Resizer, media, pipeline and queue is held — a task of theirs is queued, running or waiting for a retry, a dead one's `coordination.cooldownMs` runs, or an add that threw or was not confirmed keeps the lock for one lease (at most `coordination.gateTtlMs`). SQS cannot report which variants that task holds, so none is accepted — call `prewarm()` again after the task ends (a read after it ends queues them too) |
| `RESIZE_ENQUEUE_LOCK_FAILED` | — | A `prewarm()` issue: see [`prewarm()` issues](#prewarm-issues). With `causeCode: 'RESIZE_LOCKS_REQUIRED'` (`retryable: false`), the call's queue is on a backend without `gatesByTask` (SQS) and the Resizer has no lock store — pass `locks`, or give a `FrameworkResizer` the framework `Lock` model. |
| `RESIZE_ENQUEUE_NO_ORIGINAL` | — | A `prewarm()` issue: see [`prewarm()` issues](#prewarm-issues). |
| `RESIZE_ENQUEUE_NO_QUEUE` | — | A `prewarm()` issue: see [`prewarm()` issues](#prewarm-issues). |
| `RESIZE_ENQUEUE_QUEUE_FAILED` | — | A `prewarm()` issue: see [`prewarm()` issues](#prewarm-issues). With a `causeCode`, the backend of the call's queue failed to build (a queue driver's `fromConfig` threw: the driver's own code, or `RESIZE_PEER_MISSING`), with the error's own `retryable`; `resolve()` logs it once per queue name and message, and the next call builds again — fix what the message names. A built error whose code is already an issue code keeps it as the issue's code. |
| `RESIZE_ENQUEUE_UNCONFIRMED` | — | In `prewarm()` issues, with `retryable: true`: the task queue's `add()` resolved `unconfirmed`, so the queue did not confirm the task — on `MongoTaskQueue` a database error or a duplicate key on another unique index of the host's `ResizeTask` model (each logged); on SQS a send that returned no `MessageId`. Fix the logged cause first, then call `prewarm()` again. `retryable: false` with `causeCode`: an unregistered `ResizeTask` model (`RESIZE_MONGO_MODEL_MISSING`, logged), an outdated one (`RESIZE_MONGO_MODEL_OUTDATED`, logged once; every add stays unconfirmed until it is fixed), or what a custom queue names: calling again cannot help until it is fixed. `retryable: false` without one: a custom `TaskQueue` resolved a value in none of the `TaskAddResult` shapes (written for an older version, e.g. `{ taskId }`), logged once — resolve `{ status: 'added', taskId }`, `{ status: 'in-flight', taskId? }` or `{ status: 'unconfirmed' }` |
| `RESIZE_ENQUEUE_VARIANT_CONFLICT` | — | A `prewarm()` issue: see [`prewarm()` issues](#prewarm-issues). |
| `RESIZE_ERROR` | `true` | The default code of a plain `ResizeError` whose throw names none, such as a custom driver's. It comes from a host's or a custom driver's code: read its message. |
| `RESIZE_FORMAT_NOT_CONFIGURED` | `true` | A requested format, in the call or from a `beforeEnqueue` tap, has no `encode.formats` entry, so it is never generated: `resolve()` leaves it out of `decision.missing`, and `generate()` throws this code — use an id the defaults hold, such as `jpeg`, add `encode.formats.<id>`, or request only configured ids. As a `prewarm()` issue it is `false`: calling again cannot help until a deploy or a config change does. |
| `RESIZE_FS_HINT_CONFLICT` | `false` | `LocalFsStorage.upload` got both `namespace` and `parentRef`: pass one. |
| `RESIZE_FS_PATH_TRAVERSAL` | `false` | See `RESIZE_S3_BUCKET_NOT_ALLOWED`. |
| `RESIZE_FS_PRIVATE_ROOT_PUBLIC` | — | A `ResizeSecurityError`, when `LocalFsStorage` is constructed (from a config file: at first use or `verify()`): `privateRootDir` is `rootDir` itself or inside it, so private originals would be served — put it outside `rootDir` (`storage.privateRootDir` in the config file), or leave it out for `rootDir` + `-private` |
| `RESIZE_FS_PRIVATE_URL` | `false` | `publicUrl()` got a ref with `visibility: 'private'`, which has no public URL. Pass a preview's ref. |
| `RESIZE_FS_REF_INVALID` | `false` | See `RESIZE_S3_BUCKET_NOT_ALLOWED`. |
| `RESIZE_FS_VISIBILITY_INVALID` | `false` | `LocalFsStorage.upload` got a `visibility` other than `'public'` or `'private'`: pass one of those. |
| `RESIZE_GENERATE_FAILED` | `true` | `generate()` made no preview, because every requested variant failed. `false` when every variant failed with `false`. Its `cause` is the first failure: fix what it names. |
| `RESIZE_LOCKS_REQUIRED` | — | From `verify()` or at worker start (reads serve stored previews and queue nothing; `prewarm()` reports it): a Resizer whose task queue has no `gatesByTask` (e.g. `SqsTaskQueue`) has no `locks`, and it takes one gate lock per media, pipeline and queue — spread `mongoParts(connection, { mediaModel })` (its `locks`) or pass a `LockStore`, or drop `tasks` for an eager-only Resizer. `MongoTaskQueue` needs no `locks`; a `FrameworkResizer` builds `FrameworkLockStore` itself beside a task queue without `gatesByTask` (the SQS driver, or a custom queue without the flag). On a `RoutingTaskQueue` the need is per queue name: `verify()` rejects only when the Resizer's own queue is on a backend without `gatesByTask`, the worker only for such a queue it consumes, and a call on such a name queues nothing (the `prewarm()` issue `RESIZE_ENQUEUE_LOCK_FAILED` with `causeCode: 'RESIZE_LOCKS_REQUIRED'`) |
| `RESIZE_MEDIA` | `true` | The default code of a `ResizeMediaError` whose throw names none. It comes from a host's or a custom driver's code: read its message. |
| `RESIZE_MEDIA_APPEND_RESULT_INVALID` | `true` | A custom `MediaStore.appendPreviews` resolved with something other than an array — resolve with the previews it stored (`[]` when none) |
| `RESIZE_MEDIA_NO_ID` | `false` | The media has neither `id` nor `_id`: pass a media with one. A task with it is dead at once. |
| `RESIZE_MEDIA_REPLACE_MISSING` | `true` | From `verify()`, at worker start, or from `invalidate`, or from `generate()` and the worker when a stale preview is replaced: a custom `MediaStore` has no `replacePreviews(mediaId, identities, rows)`, required since 0.3.0 — implement it (one atomic write per media; resolve `{ stored, removed }`; see the `MediaStore` contract under [Drivers](#drivers)), or extend `MongoMediaStore` |
| `RESIZE_MEDIA_REPLACE_RESULT_INVALID` | `true` | A custom `MediaStore.replacePreviews` resolved with something other than `{ stored, removed }` (two arrays) — resolve with the rows it stored and removed (`[]` when none), `removed` being exactly what the write removed |
| `RESIZE_MEDIA_REQUIRED` | — | At construction: `new Resizer()` takes its `media` explicitly — framework hosts use `new FrameworkResizer()` from `…/framework.js`; plain Node: `...mongoParts(connection, { mediaModel })`, or a `database: { driver: 'mongo', connection, mediaModel }` section for `createResizer` (which reports a missing one on first use, naming its config) |
| `RESIZE_MEDIA_ROW_NOT_KEPT` | `false` | On a dead task: a custom `MediaStore`, a `findOneAndUpdate` middleware on the media model, or a strict row schema without `resizer`, `pipeline` or `filters` (`verify()` does not require those: they have defaults) lost or changed `storageRef`, `origin`, `encodeSig`, `sizeKey`, `format`, `resizer`, `pipeline` or `filters`, or lost `contentType`, of a row the worker wrote; the message names the fields and rows. Without this check each read after a task ends would render those previews again — store those fields as given; a read after `coordination.cooldownMs` queues the task again, and a media only `prewarm()` queues needs `prewarm()` again. On a driver that names files by their bytes, a lagging reload raises it too, when it shows another row under the same ref: an older row after a replacement (naming `encodeSig`) or another size key's row on a first render (naming `sizeKey`). Its rows are stored, and the next read is fresh |
| `RESIZE_METRICS_INVALID` | — | At construction: the `metrics` option is not a sink (`null`, or no `count()` and `timing()` functions), or `new LogMetrics(logger, { summaryIntervalMs })` got an interval that is not a positive integer of at most 2147483647 — pass `new LogMetrics(logger)`, `new NoopMetrics()` or your own `ResizeMetrics`, or leave `metrics` out for the default |
| `RESIZE_MONGO_INDEX_MISSING` | — | From `verify()` or at worker start, logged once as an `error` by the first added task (once per model, in the background: reads never wait for it, and the line ends in what the gap costs: concurrent adds can each store a duplicate active task, or, for a unique index without the filter, nothing queues), or the warning "reported a task in flight without its id": the `ResizeTask` collection has no gate index — unique on exactly `{ resizer: 1, fileId: 1, pipeline: 1, queue: 1 }` with `partialFilterExpression: { active: true }` (or `{ active: { $eq: true } }`) — or does not exist yet, or an index on those keys lacks `unique` or that partial filter, or Mongoose's own index build (`autoIndex`) failed (the error's `cause`, e.g. duplicate active rows) (without the filter every add after a completed task is in flight with no id and nothing queues). Create it through your migration (e.g. `ResizeTask.createIndexes()` or `syncIndexes()`; drop a wrong index on those keys first); the module never creates indexes, and a worker on the framework CLI (`autoIndex` off) neither builds them nor waits for a build: create them before it starts |
| `RESIZE_MONGO_LOCK_MODEL_OUTDATED` | — | From `verify()` or at worker start: the lock model's strict schema has no `owner` field, so no lock could be released before it expires (e.g. a `ResizeLock` model registered on the connection before this version, which `createResizeModels` returns as it is) — add `owner: { type: String }` (see `resizeLockFields` in `…/drivers/mongo.js`) |
| `RESIZE_MONGO_MEDIA_MODEL_OUTDATED` | — | From `verify()` or at worker start: the media schema declares preview rows as strict sub-documents without `identity`, `origin`, `encodeSig`, `sizeKey`, `format`, `contentType` or `storageRef` (the message names them; a mixed or plain `previews` array, or rows with `strict: false`, pass) — spread the current `resizeMediaSchemaFragment`, or add each missing field to the row as `{ type: String }` (`storageRef` as `{ type: 'Mixed' }`). A strict row schema without `fit` does not throw: it logs one warning (fit rows then lose their flag and are judged by either signature); add `fit: { type: Boolean }` |
| `RESIZE_MONGO_MODEL_MISSING` | — | From `verify()` or at worker start: a model does not resolve: the `ResizeTask` model (scaffold `src/models/ResizeTask.ts`), the lock model (the framework's `Lock`, needed only beside a task queue without `gatesByTask`, or the model passed to `MongoLockStore`), or the media model of a plain `MongoMediaStore` (framework hosts get `RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN` instead) |
| `RESIZE_MONGO_MODEL_OUTDATED` | — | From `verify()`, at worker start, or logged once by `add()` (every add is then unconfirmed and queues nothing until the model is fixed; claims reject with it), or `npx --no -- resize-scaffold --check` reports drift in `src/models/ResizeTask.ts`: a shim from an older scaffold that imports `…/framework.js`: delete `src/models/ResizeTask.ts` and re-run `npx --no -- resize-scaffold` (`--force` would also overwrite `src/resizer.ts` and `src/config/resize.ts`). An ejected or hand-written model without the `resizer`, `queue`, `availableAt`, `active` or `cooldownUntil` fields: port them (and the `{ queue, status, availableAt }` index and the gate index) from `resizeTaskFields()` / `resizeTaskIndexes` (`…/drivers/mongo.js`), or delete it and re-run `npx --no -- resize-scaffold --eject`. Right after the upgrade `--check` also reports every ejected model without `startedAt` and `finishedAt` — intended (such a model keeps working; the times are dropped and `RESIZE_MONGO_MODEL_OUTDATED` does not list them): add both as `{ type: Date }`, or move `src/models/ResizeTask.ts` aside (or delete it), re-run `npx --no -- resize-scaffold --eject`, then restore your customizations (re-running `--eject` alone never overwrites the file) |
| `RESIZE_MONGO_MODEL_REQUIRED` | — | `new MongoMediaStore()` / `new MongoLockStore()` / `new MongoTaskQueue()` needs exactly one of `model` or `getModel` — or use `mongoParts(connection, { mediaModel })` |
| `RESIZE_MONGO_NOT_CONNECTED` | — | From `verify()` or at worker start: the Mongoose connection of the `ResizeTask` model is closed (never opened, or disconnected: at once), or failed to open (after the driver's `serverSelectionTimeoutMS`, 30 s by default; the message names the driver's error) — call `verify()` after the connection has opened (after `Server.init()` in a framework host); an opening connection is awaited |
| `RESIZE_NAME_INVALID` | — | At construction: the Resizer's `name` option, or its `queueName` option (`RESIZE_QUEUE_INVALID`), is not a non-empty string — pass one, or leave it out for `'default'`. ``resize: `queue` is now `queueName` `` (`RESIZE_QUEUE_INVALID`): the old `queue` option was renamed — pass `queueName`, and read `resizer.queueName` instead of the removed `resizer.queue` |
| `RESIZE_NOT_READY` | — | Host code read `resizer.storage` / `media` / `locks` / `tasks`, or a `resizer.queueName` that comes from the config file (or from a function), before the Resizer loaded them — `await resizer.ready()` first (the Resizer's methods do this themselves). A string `queueName` option is readable at once. `resizer.queue` is gone: read `resizer.queueName` |
| `RESIZE_NO_ORIGINAL` | `false` | `generate()` or a task found no original (`ResizeNoOriginalError`): upload it first. |
| `RESIZE_NO_RESIZER` | `true` | At worker start: `src/commands/ResizeWorker.ts` does not import `../resizer.ts` — delete it and re-run `npx --no -- resize-scaffold`. Without the framework, `runWorker()` found no Resizer, or got an empty `resizers` list: construct the Resizers in the worker process before it starts (for a Lambda handler, see [Push delivery (preview)](#troubleshooting)). From `getResizer(name)`: no Resizer of that name was constructed in this process — construct it in bootstrap code that runs in every process that uses it. On a task, or `Resizer '…' is not served by this worker` in worker logs: a task queue that cannot filter claims (SQS) handed the worker a task of a Resizer it does not serve: that Resizer was not constructed in the worker process before the worker started (or not passed in `runWorker({ resizers })`). Its tasks are given back to the queue for a worker that serves it (SQS still counts each receive, so a task bounced between workers that serve different Resizers can use up its `maxAttempts` and be dead-lettered by the worker that serves it: give each set of Resizers a worker serves its own SQS queue URL), or, when the queue cannot give tasks back, fail with `RESIZE_NO_RESIZER` (retried, then dead-lettered) — construct every Resizer in `src/resizer.ts`, which both the API and the worker load. On the database queue, which filters claims, such tasks wait for a worker that serves their Resizer, and every claim on that queue reads past them (the claim index does not hold the Resizer): give a Resizer that has no worker its own queue (a log saying the queue "handed its task out although it filters claims" is a broken custom queue) |
| `RESIZE_ORIGINAL_BODY_INVALID` | `false` | `uploadOriginal({ body })` is not a `Buffer` or `Uint8Array`: pass the file's bytes. |
| `RESIZE_ORIGINAL_DAMAGED` | `false` | From `uploadOriginal()` or `adoptOriginal()`: `upload.verify: 'decode'`, or an adoption, which always runs it, decoded the original's first frame at `limits.failOn` and the engine refused it: the file is cut or corrupt, and nothing was stored — ask for the file again. Damage `inspect` finds first, such as a cut single-frame GIF or a cut inside an animation's first frame, stays `RESIZE_ORIGINAL_INVALID`. An animation damaged in a later frame can be stored, and a worker then renders the frames it has or fails the task. Flipped bytes can pass too, since a decode does not always find them: a still JPEG or lossy WebP usually passes. A JPEG cut in its last rows can pass too (measured at 1200×900, up to about 1% of its tail), and a larger render then dead-letters it |
| `RESIZE_ORIGINAL_DOWNLOAD_FAILED` | `true` | From `adoptOriginal()`: the storage driver failed with an error that is not the module's, such as a network error or an S3 403, or resolved with something other than bytes; `cause` says why — retry after fixing it. A driver's own `ResizeError` is not this code: it passes through as the same object |
| `RESIZE_ORIGINAL_EMPTY` | `false` | The upload, or the object to adopt, has no bytes: refuse the file. |
| `RESIZE_ORIGINAL_FORMAT_DISABLED` | `false` | `uploadOriginal()`: the format is not in `upload.formats`. Add it, or refuse the file. |
| `RESIZE_ORIGINAL_FORMAT_UNSUPPORTED` | `false` | See `RESIZE_SOURCE_FORMAT_UNSUPPORTED`. |
| `RESIZE_ORIGINAL_INSPECT_FAILED` | `true` | From `uploadOriginal()` or `adoptOriginal()`: a decoder failed to read the upload for a reason other than the bytes: a timeout, a host decoder's own failure, a file this build cannot decode, or an engine failure with no detail (a file holding only PNG magic bytes gets this one). Nothing was stored, and `cause` says why — retry; a file this build cannot decode keeps failing. Bytes the engine calls malformed or unknown are `RESIZE_ORIGINAL_INVALID` (`retryable: false`), with the engine's line in the message |
| `RESIZE_ORIGINAL_INVALID` | `false` | The bytes are malformed or unknown to the engine, and the message carries its line. Refuse the file. |
| `RESIZE_ORIGINAL_METADATA_MISSING` | `false` | A decoder found no width or height in the upload or the object to adopt: refuse the file. |
| `RESIZE_ORIGINAL_PUBLIC_REFUSED` | `false` | From `uploadOriginal()` or `adoptOriginal()`: a public original of a host decoder's source kind, whose decoder does not set `publicOriginals: true`: a public upload stores nothing, and an adopted object reads as public when `storage.publicUrl` returns for its ref — pass `visibility: 'private'` or move the object to private storage, or set `publicOriginals` on the decoder (a host decoder that takes over a built-in format needs it too). SVG is `RESIZE_ORIGINAL_SVG_PUBLIC` whatever the flag says |
| `RESIZE_ORIGINAL_STORAGE_REF_INVALID` | `true` | At `uploadOriginal()`, the driver returned no ref (`true`, `ResizeStorageError`). At `adoptOriginal()`, there is no `storageRef`, or JSON cannot represent it (`false`). Return the ref from the driver, or pass a plain ref. |
| `RESIZE_ORIGINAL_SVG_PUBLIC` | `false` | A public SVG upload, or a public SVG object to adopt: pass `visibility: 'private'`, or move the object to private storage. |
| `RESIZE_ORIGINAL_TOO_LARGE` | `false` | From `uploadOriginal()`: the body is over `upload.maxBytes` or `limits.sourceBytes`, the message says which, and nothing is stored. Refuse the file, or raise the limit; above `limits.sourceBytes` raise both, since a task could not read it. From `adoptOriginal()`: the object is over the call's own `maxBytes`; the shipped drivers read nothing, except on an S3 response with no length, which is read whole first. Over `limits.sourceBytes` it is `RESIZE_SOURCE_TOO_LARGE`. |
| `RESIZE_ORIGINAL_TOO_MANY_PIXELS` | `false` | The upload, or the object to adopt, is over `limits.sourcePixels` or Sharp's pixel limit: refuse the file, or raise the limit before rollout. |
| `RESIZE_ORIGINAL_UPLOAD_FAILED` | `true` | `storage.upload` failed for an original, and `cause` says why. Retry after fixing it. |
| `RESIZE_ORIGINAL_VERIFY_FAILED` | `true` | From `uploadOriginal()` or `adoptOriginal()`: the `upload.verify: 'decode'` check, or an adoption's, failed for a reason other than damage: a timeout, or a healthy file this build cannot decode. It gave no verdict on the image. Nothing was stored, and `cause` says why — retry; a file this build cannot decode keeps failing, and would not render on a worker either. A host decoder's own error with `retryable: false` is not this code: it keeps its code and `retryable`, as at `inspect` |
| `RESIZE_ORIGINAL_VISIBILITY_INVALID` | `false` | `uploadOriginal({ visibility })` is not `'public'` or `'private'`: pass one of those. |
| `RESIZE_PEER_MISSING` | `true` | `ERR_MODULE_NOT_FOUND: @aws-sdk/...` at your driver import, or this code for a driver selected in the config (a config file, or the config passed to `createResizer()`) or from `signedUrl()`: an optional peer is not installed — install the packages named, see [Install](#install). A queue whose backend lacks its SDK beside another available backend is only not served in that process (`RESIZE_QUEUE_NOT_SERVED`, naming the package); `verify()` rejects with `RESIZE_PEER_MISSING` only when it is the Resizer's own queue |
| `RESIZE_PIPELINE_STEP_INVALID` | `true` | A `beforeStep` or `variantStep` resolved with something that is not a one-frame `Raster` (a `Buffer`, a Sharp instance, a raster whose `data` length does not match its size), or `sharpToRaster` got a multi-page image, or `rasterToSharp` something that is not a `Raster` — return `{ data, info }`, or `sharpToRaster(…)` from a Sharp chain |
| `RESIZE_PIPELINE_UNKNOWN` | `true` | The pipeline is not registered in that process — register it in `src/resizer.ts`; deploy the worker before the API requests a new or renamed pipeline. As a `prewarm()` issue it is `false`: calling again cannot help until a deploy or a config change does. |
| `RESIZE_PREVIEW_STORAGE_REF_INVALID` | `true` | A custom driver's `upload` returned no ref for a preview: return the ref it stored. |
| `RESIZE_QUEUE_INVALID` | — | At construction, see `RESIZE_NAME_INVALID`. At worker start: `runWorker({ queue })` (or `runResizeWorker`) got an empty list, or a list entry or a single name that is blank or not a string (`queue: ''` is refused too) — pass a queue name or a list of names; `--queue` may be repeated |
| `RESIZE_QUEUE_NOT_SERVED` | — | At worker start or from `verify()`: no task queue can consume that queue: a `--queue` name (with a repeated `--queue`, the message names the one that is not served) that `queues` does not define, an `SqsTaskQueue` without its URL, or a name whose backend's SDK is not installed in this process (the message names the package); or a Resizer's own `queueName` is not served by the task queue passed to it in code (`verify()` checks the Resizer's own queue; the worker checks only the queues it consumes) — define the queue (add its URL), install the package named, or start the worker for other queues. Nothing is claimed before every listed name is served. A Resizer's own queue whose SDK is missing is `RESIZE_PEER_MISSING` from `verify()`. In `prewarm()` issues (`retryable: false`), or the warning "cannot queue to '…': its task queue does not serve that queue" from `resolve()` (once per queue name): the call's `queue` is unknown to the Resizer's task queue (in a framework host or a `createResizer` config, not an entry of `queues`; for `SqsTaskQueue`, no URL; the message ends "(a queue name it does not route)"), or that queue's backend lacks its optional SDK in this process (the message ends "(its driver 'sqs' needs @aws-sdk/client-sqs, which is not installed)"), so nothing is queued — define the queue, or install the package in that process. A queue on another backend of `queues` is routed and needs no change |
| `RESIZE_QUEUE_ROUTES_INVALID` | — | From `new RoutingTaskQueue()`: the routes are not a non-empty plain object, an object route lacks one of `add`, `claim`, `renew`, `complete`, `fail` or does not serve its own name, or a route is neither a task queue nor a function (the message names the route) — pass a task queue or an `async () => TaskQueue` builder per name |
| `RESIZE_QUEUE_SHARED_RESIZER_UNLISTED` | — | At worker start: `runWorker({ resizers })` does not list a Resizer of the process that uses a task queue the worker consumes and that cannot filter claims, e.g. SQS (the message names the queue and the Resizers; a queue with `claimFilters` may be shared); the worker would claim their tasks without running them — list them too, or give them their own task queue. With `queues` on more than one available backend, every `FrameworkResizer` that takes its task queue from the config file shares one router that reaches every name, so a worker that consumes a queue on SQS must list all of them, whatever their own queue (`npm run cli ResizeWorker` serves every Resizer). When the message says a task queue failed to load, the worker could not compare that unlisted Resizer's task queue (the load error is the cause) — fix that task queue |
| `RESIZE_S3_BUCKET_NOT_ALLOWED` | `false` | From `adoptOriginal()` or on a task: the driver refuses a ref the host built. `RESIZE_S3_BUCKET_NOT_ALLOWED`: the bucket is neither `bucketPublic` nor `bucketPrivate` — copy the object into one. Point `bucketPrivate` at that bucket only when no stored original uses the old private bucket and this bucket is not public: otherwise every row in the old bucket fails with this code, and new private uploads, SVG markup included, land in this one. `RESIZE_S3_REF_INVALID`: not `{ bucket, key }` with strings, or a `namespace` that does not prefix the key — fix the ref, or drop `namespace`. `RESIZE_FS_REF_INVALID`: not `{ path, visibility }` with `visibility` `'public'` or `'private'`, or a `namespace` that does not prefix the path — fix the ref. `RESIZE_FS_PATH_TRAVERSAL`: the path, or a symlink on it, leads out of its root — copy the file inside the root. `RESIZE_STORAGE_NAMESPACE_INVALID`: `namespace` is not `/`-separated parts of letters, digits, `_`, `.` and `-`; `null` counts — leave the key out when there is none, and `$unset` a stored `null`. On S3 a `namespace` must also leave room for a preview's key within S3's 1024-byte limit (a preview adds about 50 bytes to it): too long adopts, then every preview fails with `RESIZE_S3_KEY_TOO_LONG` and the task is dead at once — omit or shorten it |
| `RESIZE_S3_EMPTY_BODY` | `true` | An S3 response had no body. Retried, then dead-lettered after `maxAttempts`. Check the object and the endpoint. |
| `RESIZE_S3_HINT_CONFLICT` | `false` | `S3Storage.upload` got both `namespace` and `parentRef`: pass one. |
| `RESIZE_S3_KEY_TOO_LONG` | `false` | The object's key would be over S3's 1024-byte limit, usually because of a long `namespace`: shorten it. Every preview fails with it, and the task is dead at once. |
| `RESIZE_S3_PRIVATE_BUCKET_REQUIRED` | `false` | A private upload with no `bucketPrivate`, or with one equal to `bucketPublic`: set a distinct private bucket. |
| `RESIZE_S3_PRIVATE_ORIGINAL_PUBLIC_URL` | `false` | `publicUrl()` got a ref in the private bucket, which has no public URL. Pass a preview's ref, or hand the original over with `storage.signedUrl()`. |
| `RESIZE_S3_REF_INVALID` | `false` | See `RESIZE_S3_BUCKET_NOT_ALLOWED`. |
| `RESIZE_S3_VISIBILITY_INVALID` | `false` | `S3Storage.upload` got a `visibility` other than `'public'` or `'private'`: pass one of those. |
| `RESIZE_SECURITY` | `false` | The default code of a `ResizeSecurityError` whose throw names none. It comes from a host's or a custom driver's code: read its message. |
| `RESIZE_SETUP` | `true` | The default code of a `ResizeSetupError` whose throw names none: a host's own, or one of the module's internal checks. Read its message. |
| `RESIZE_SIZE_INVALID` | `false` | A requested size has none of `fit`, a width or a height. A task with it is dead at once. Fix the size in your catalog. |
| `RESIZE_SOURCE_DAMAGED` | `false` | The source is cut or unreadable: the engine refused its header, or refused its pixels at `limits.failOn` (the worker's dead line then names the level). Dead-lettered on its first delivery, since no retry can help — replace the original (one replaced while the task ran is retried under `RESIZE_WORKER_INCOMPLETE` and renders the new one). Previews made from a damaged original before this version stay fresh: see **Damaged originals** under [Operations](#operations). A download whose length differs from `original.size` stays the retryable `RESIZE_SOURCE_DECODE_FAILED`. On a stored format no decoder of this process lists, damage stays retryable too: `RESIZE_DECODER_MISSING` at `inspect`, `RESIZE_SOURCE_DECODE_FAILED` at render |
| `RESIZE_SOURCE_DECODE_FAILED` | `true` | Sharp (or a host decoder) could not decode the source, for a reason other than damage; the error's `cause` says why — retried, then dead-lettered |
| `RESIZE_SOURCE_FORMAT_UNSUPPORTED` | `false` | Every decoder refused the bytes: no decoder of this process reads that format. On a task it is dead-lettered at once; from `uploadOriginal()` or `adoptOriginal()` it is `RESIZE_ORIGINAL_FORMAT_UNSUPPORTED`. Add a decoder for it, or reject the file. A bare ref to a non-image (an mp4, HTML, an empty object) is not this code: its task is `RESIZE_SOURCE_DECODE_FAILED`, retried up to `maxAttempts`, where `adoptOriginal()` refuses it at once |
| `RESIZE_SOURCE_METADATA_MISSING` | `false` | A decoder found no width or height in the stored source. A task with it is dead at once. Replace the original. |
| `RESIZE_SOURCE_TOO_LARGE` | `false` | A stored original is over a limit, and the message names it: `limits.sourceBytes` (bytes, default 256 MiB), `limits.sourcePixels` or `limits.inputPixels` (pixels). Its task is dead-lettered at once, and `generate()` rejects with it, as `adoptOriginal()` does over `limits.sourceBytes`. Raise that limit, or replace the object. A `beforeStep` whose result is over `limits.sourcePixels` or `limits.inputPixels` gets it too, with no limit named: make the step's result smaller. At upload the same refusals are `RESIZE_ORIGINAL_TOO_LARGE` and `RESIZE_ORIGINAL_TOO_MANY_PIXELS`. |
| `RESIZE_SQS_EVENT_INVALID` | — | See [Push delivery (preview)](#troubleshooting). |
| `RESIZE_SQS_QUEUE_UNKNOWN` | — | A direct `SqsTaskQueue` call (`add`, `claim`) named a queue it has no URL for — add the URL to `queues`. A Resizer never gets it: its call on such a name is `RESIZE_QUEUE_NOT_SERVED` before any gate lock or `add()` (see that row) |
| `RESIZE_SQS_QUEUE_URL_REQUIRED` | — | At construction: `new SqsTaskQueue()` with neither `queueUrl` nor a `queues` entry — pass the `'default'` queue's URL, or name every queue it serves in `queues` (`queueUrl` is optional beside `queues`; a framework `queues` entry with driver `'sqs'` and no `queueUrl` fails with `RESIZE_CONFIG_INVALID` instead) |
| `RESIZE_STORAGE` | `true` | The default code of a `ResizeStorageError` whose throw names none. It comes from a host's or a custom driver's code: read its message. |
| `RESIZE_STORAGE_DOWNLOAD_INVALID` | `true` | On a task or from `generate()` (retried, then dead-lettered): a custom driver's `download()` resolved with something other than bytes — make it resolve with a `Buffer` or a `Uint8Array` |
| `RESIZE_STORAGE_KEY_INVALID` | `false` | From `adoptOriginal()`, or on a task whose ref holds such a key: the driver refuses this key. `S3Storage` reads any key except one with a control character, a `.` or `..` part, a leading `/` or an empty part (`uploads//cat.jpg`, `dir/`, a name holding a tab); `LocalFsStorage` paths stay in `[A-Za-z0-9_.-]` — copy the object to a new key and adopt that |
| `RESIZE_STORAGE_NAMESPACE_INVALID` | `false` | See `RESIZE_S3_BUCKET_NOT_ALLOWED`. |
| `RESIZE_STORAGE_NOT_FOUND` | `true` | On a task or from `generate()` (retried, then dead-lettered): `storage.download` found no object at the original's `storageRef` — restore the object, or fix or delete the media. It stays retryable because an object can appear later (a row written before its PUT finishes); each retry costs one 404. An S3 role without `s3:ListBucket` gets 403 for a missing key, which stays the raw SDK error |
| `RESIZE_STORAGE_REQUIRED` | — | At construction or first use: `new Resizer()` got no `storage`, or a `storage` function resolved with nothing — pass a `ResizeStorage` driver (e.g. `new LocalFsStorage({ … })` from `…/drivers/fs.js`); framework hosts use `new FrameworkResizer()`, which builds it from the config file's `storage` (`RESIZE_CONFIG_STORAGE_MISSING` when that is missing) |
| `RESIZE_SVG_DIMENSIONS_UNSUPPORTED` | `false` | An SVG's dimensions cannot keep a pixel on each side within the renderer's side limit (`1×100000`, say): refused before storage by `uploadOriginal()` and `adoptOriginal()`. A stored one is dead on its first delivery. Give the SVG a usable size, or refuse the file. |
| `RESIZE_SVG_PUBLIC_PREVIEW` | `true` | As the cause of a `variant … failed` warning: an engine's `encode` result says SVG (by `format` or `contentType`), HTML or XML, which is never published as a preview; the message names the engine, and only a custom one reaches it — fix the engine |
| `RESIZE_SVG_RENDER_FAILED` | `true` | The SVG render process crashed, or its task was aborted (a timeout, a lost lease or a stop), and the message then says the abort signal fired. Retried, then dead-lettered after `maxAttempts`. After a crash, look at the SVG, and at the process's memory. |
| `RESIZE_SVG_RENDER_TIMEOUT` | `false` | An SVG render ran past `limits.processingTimeoutSeconds`, and was killed. A task with it is dead at once. Raise `limits.processingTimeoutSeconds`, or replace the SVG. |
| `RESIZE_SVG_RENDER_UNAVAILABLE` | `true` | The SVG render process cannot start — allow child processes (`--allow-child-process` under Node's permission model) and keep `svgRasterChild.js` next to `svgRaster.js` in a bundle |
| `RESIZE_TASK_IN_FLIGHT` | — | In `prewarm()` issues: a task for this media, pipeline and queue is active, or a dead one is cooling down, and it does not cover these variants: one task per media, pipeline and queue runs at a time — call `prewarm()` again after it ends (a read after it ends queues them too) |
| `RESIZE_TASK_MAX_ATTEMPTS` | `false` | A task was delivered more often than `maxAttempts` with no outcome: its workers kept crashing, or, on push delivery, a record was not started, or an outage or a bad deploy used up its receives (see [How a record ends](#how-a-record-ends)). Dead at once. Fix that cause. |
| `RESIZE_TASK_TIMEOUT` | `true` | A task ran past `taskTimeoutMs` (on push delivery, past the time the function had, and the message names that budget): raise it. Healthy tasks fail with this code, or are dead-lettered with no previews, beside a slow step: Sharp work that does not go through `rasterToSharp` (`sharp(raster.data, { raw: raster.info })`, a raster spread into a new object), a chain with `.timeout({ seconds: 0 })`, or a slow `beforeStep` holds libuv's threads, and other tasks' Sharp calls wait behind it. `taskTimeoutMs` ends the task but not its variants in progress: each keeps its thread and memory until it ends, and can still store its row, and such a late write can replace a newer row, which the next read finds stale and queues again — run the work through `rasterToSharp`, or give it its own `.timeout({ seconds })` |
| `RESIZE_WORKER_INCOMPLETE` | `true` | A task left variants missing. Its previews are saved and it is retried for the missing ones, then dead-lettered after `maxAttempts`, or at once when every missing variant failed with `retryable: false` on an original the media still holds. A final error of the whole task is this code too when a reload finds another original on the media, and its next delivery renders the new one. Its `cause` is the first failure: fix what it names. |

### Symptoms without a code

| Symptom | Cause → fix |
|---|---|
| a `findOneAndUpdate` middleware on the media model throws on an array update, or `invalidate` fails on a custom model-shaped `MongoMediaModel` | `replacePreviews` (which `invalidate` uses) sends an update pipeline: `findOneAndUpdate(filter, [ … ], { updatePipeline: true, returnDocument: 'before', lean: true, projection: { previews: 1 } })`, after casting the rows with the model's optional `castObject` — make the model and its middleware accept an array update |
| the warning `resize worker: the media store did not keep the identity of …` (once per Resizer) | a custom `MediaStore` holds a row with `identity` absent or in another form. A read does not use it, so the row is served and the task completes, but `invalidate()` finds such rows only by identity, so it leaves them, and a `replacePreviews` that removes by stored identity leaves them too (a store keyed by the identity it computes replaces fine) — store and return `identity` as given |
| `npx --no -- resize-scaffold --check` reports drift in `src/config/resize.ts` or a `resize.<NODE_ENV>.ts` override ("uses the old config shape") right after the upgrade | intended, for every config scaffolded before 0.3.0: a top-level `queue: { … }` object (a `queue` entry inside `queues` is fine), or `defaultFrameworkResizeConfig` imported from `…/config/resize.js` (only full-line `//` comments are skipped) — rewrite it to the new shape (see [Config reference](#config-reference)), or move it aside, re-run `npx --no -- resize-scaffold` and copy your settings back. The config file is never diffed, and a second Resizer's `configName` file is not checked: review it yourself |
| previews without `origin` / `encodeSig` (written by 0.2.x or earlier), or rows that `invalidate` leaves behind | old rows: rows without `origin` and `encodeSig` are stale — served until replaced and regenerated on their next read; their old files stay (clean up in an `onPreviewReplaced` observer, from the "replaced … outdated preview(s)" log line, or sweep objects under the `previews/` prefix (below a ref's `namespace`) that no row references, leaving out every `original.storageRef` and deleting only objects older than a day and more than twice `taskTimeoutMs`). Rows without an `identity` (written before 0.3.0) are never removed by `invalidate` or `replacePreviews`, and a sweep never finds their files — delete those rows and files yourself |
| previews are re-rendered after a config change or an upgrade | freshness working as designed: a stored preview made with other image settings, another pipeline `version`, another original, or without `origin` and `encodeSig` (written by 0.2.x or earlier) is stale, served until replaced, and regenerated on its next read, `prewarm()` or `generate()`. It costs a render and an upload per preview, and the old files stay in storage — clean up in an `onPreviewReplaced` observer, from the "resize: replaced … outdated preview(s) … storage refs" log line, or sweep objects under the `previews/` prefix (below a ref's `namespace`) that no row references, leaving out every `original.storageRef` and deleting only objects older than a day and more than twice `taskTimeoutMs`. The wave shares the queue with new uploads' previews: plan worker capacity |
| the warning `resize resolve: media … was loaded without its stored …` (once per Resizer) | the query's projection dropped `original` or `previews`, so nothing is served or queued, or previews are served as stale, or previews are made again (the line says which) — add `...resizeMediaPaths` to the query. A lean row the module never wrote has neither field: one harmless line |
| one task per read that renders nothing, and the warning "found every requested preview … already fresh" | the API and the worker run different image settings or pipeline versions (deploy them together), or `resolve()` got the media without its stored original (a projection that drops `original.width` / `height`, or a reshaped `storageRef`) — pass `original` as stored |
| previews re-rendered over and over during a deploy | two worker versions with different settings run side by side (a rolling deploy, a canary), and each re-makes the other's rows: every read after a task ends queues them again, and each replaced preview costs one render, one upload and one orphaned file — deploy every worker at once, or change settings only after the old workers have stopped |
| the warning "the media store did not record the original's dimensions", or tasks that fail with a Mongoose `StrictModeError` or `CastError`, are retried and dead-lettered with no previews | a custom `MediaStore` drops `backfillDims` in `appendPreviews` (also with `previews: []`), so every read of such a media queues a task that downloads the original — make it save the dimensions on the original. The shipped `MongoMediaStore` drops them too when the media schema declares `original` strictly (nested paths, or a sub-schema without `strict: false`) without `width` and `height`, or stores them with the wrong type when they are declared as a type that does not read back as a number (not Number, Int32 or Mixed). Under `strict: 'throw'`, or with a type Mongoose cannot cast them to (`Boolean`, `ObjectId`), the backfill is rejected instead: the task fails, is retried and is dead-lettered after `maxAttempts`. In each case its `verify()` warns once, naming the cause — spread `resizeMediaSchemaFragment`, or declare `width` and `height` as `{ type: Number }` in `original` |
| worker warning `resize worker: media … is stored as '…' but its bytes are '…' (…); rendering it as '…'` (`resize generate:` from `generate()`) | `original.format` holds an alias (`jpg`), a MIME type (`image/jpeg`) or a wrong format, or its decoder refused the bytes or read them as another of its formats (JPEG bytes stored as `png`); the preview renders — fix the record to the decoder's id (`jpeg`) |
| the warning `resize: upload.maxBytes (…) is above limits.sourceBytes (…)` from `verify()` | the stricter limit wins, since a task could never read a larger stored file, so uploads over `limits.sourceBytes` are refused whatever `upload.maxBytes` says — raise `limits.sourceBytes` to accept them, or lower `upload.maxBytes` |
| Sharp's `Input file is missing` from a step | an old step that still calls `sharp(buf)` on its first argument, which is now a `Raster` — rewrite it as `async (r) => sharpToRaster(rasterToSharp(r)…)` |
| Sharp's `Input buffer contains unsupported image format` from a step | the step calls `sharp(raster.data)`: those bytes are raw pixels, not an image file — use `rasterToSharp(r)` |
| `img.composite is not a function` (or any Sharp method) from a `variantStep` | an old step that treats its first argument as a Sharp instance; it is now a `Raster` — rewrite it as `async (r) => sharpToRaster(rasterToSharp(r)…)`, and read `metadata()` values from `r.info`. An old step with a `typeof img.composite === 'function'` check or a `try { } catch { return img; }` raises no error: it renders silently with no watermark, so search for those too |
| Sharp's `timeout: …% complete` as the cause of a `variant … failed` warning | a `rasterToSharp` chain in a `variantStep` ran past `limits.processingTimeoutSeconds`, and only that variant failed. A slow resize or encode gets the same text, so the warning does not say which. On a worker the task then retries and, after `maxAttempts`, is dead-lettered into the cooldown (`coordination.cooldownMs`) — for a step: make it cheaper, or give the chain its own `.timeout({ seconds })` (`0` turns it off); for a resize or encode: raise the limit |
| `resize worker: task … is dead (…)` at `error` | the task was dead-lettered; the line holds the code, the reason (`last attempt`, `not retryable`, `delivered more often than maxAttempts`) and the cause — fix the cause first, then the next read after `coordination.cooldownMs` queues the media again. The line is one line; the error goes to your logger as the second argument, and what it prints is your logger's. A logger that formats its first argument itself (pino, or a wrapper around `console.error`) can still treat a `%` in a cause as a placeholder, and Winston, the framework's logger included, leaves the error out of an entry whose line holds a sequence such as `%c3` or `%s` |
| the warning `resize worker: the … observers of task … did not settle within … ms` | a task observer (`afterTaskComplete`, `onTaskFailed` or `onTaskDeadLettered`) was still running after `taskTimeoutMs`, or, once the worker was stopping, 5 s after the later of the stop and the task's end (the line says which). The task's state stands, the worker goes on, and the tap keeps running beside the next task — fix the tap |
| a preview URL fails while a read calls that preview ready, neither stale nor missing | its file was deleted, usually by a sweep without the age rule: a read never checks storage, so nothing renders it again — call `invalidate()` on that media, and the next read or `prewarm()` queues its previews again. Then fix the sweep: list objects first, read rows after, and delete only objects older than a day and more than twice `taskTimeoutMs` |
| a variant stays missing for ~10 min after its task was dead-lettered | `coordination.cooldownMs` (default 600000): the dead task holds the gate of its media, pipeline and queue until the cooldown ends, so reads queue nothing and `prewarm()` reports `RESIZE_TASK_IN_FLIGHT` (SQS: `RESIZE_ENQUEUE_LOCK_CONTENDED`) — fix the cause in the logs first |
| `TS2305` or `TS2724` on `FrameworkStorageConfig`, `FrameworkLocalStorageConfig` or `FrameworkS3StorageConfig` (TypeScript may suggest `FrameworkWorkerConfig`, which is another type) | these aliases are removed — import `StorageConfig`, `LocalStorageConfig` or `S3StorageConfig`, the same types under their core names, from the same entry |
| tasks stay `pending` on one queue | no worker consumes that queue — start `npm run cli ResizeWorker -- --queue=<name>`. The gate is per queue: such a task blocks new tasks for its media and pipeline on that queue only, never reads on another queue |
| models fail to load (framework ≥5.1 reports a duplicate framework copy explicitly at boot) | two `@adaptivestone/framework` copies resolve (npm link / nested install) — dedupe to exactly one |
| previews never appear | the worker process isn't running, or `worker.enabled` is `false` in that process (it logs the `warn` `resize worker disabled — this process consumes no tasks; …`, and the command resolves `false`, so a CLI entry that forwards the result, as the framework docs require, exits 1) |
| `resize worker: no Resizer has a task queue (eager-only wiring)` | this process consumes nothing: the same mistake as a disabled worker, with the same result (an `error` line, and the command resolves `false`) — set `queue` and `queues`, or do not run a worker |
| a deleted preview is still served by the CDN | every public object `S3Storage` uploads is cached for a year (`immutable`): purge the CDN path (browsers that already have it may keep it until it expires) |
| first read of a new size is slow to fill | lazy mode working as designed — call `prewarm()` at upload if it matters |
| `resolve` `output` is `undefined` | no `formatPublicUrls` hook (or it threw) — map `decision` or use `formatPictureUrls` |

## Development

`npm test` runs the `node:test` suite. Core tests construct `new Resizer({ … })` with fakes and
need no framework app. Framework-adapter tests install a fake app with `setAppInstance()`.
`src/importGraph.test.ts` fails if the main entry ever reaches framework code. Before a release,
run `npm run build` and `npm run smoke`. `npm run types:check` checks the shipped code
(`tsconfig.json`), then the tests, the test helpers and the root tooling (`tsconfig.tests.json`).
`npm run types:check:src` checks the shipped code and the type pins (`tsconfig.type-pins.json`);
CI runs it against the minimum peer versions.
`node --experimental-strip-types bench/renderOnce.ts [rounds] [--single-thread]` benchmarks the
render path (3 sizes × JPEG and WebP from one 24 MP JPEG) against a "resize once per size"
baseline, with an A/A control, and exits 0 (PASS: within 5% of the baseline in wall and CPU
time), 1 (FAIL) or 2 (INCONCLUSIVE: the machine was too noisy to judge).

## License

MIT
