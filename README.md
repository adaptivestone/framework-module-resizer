# @adaptivestone/framework-module-resize

Image resizing for [`@adaptivestone/framework`](https://framework.adaptivestone.com), and for
plain Node apps through the same core. Upload the **original** once; the module generates resized
**previews** with [`sharp`](https://sharp.pixelplumbing.com), stores them through a storage
driver, and turns the record on your media document into image URLs.

- **Guide:** [framework.adaptivestone.com/docs/resize](https://framework.adaptivestone.com/docs/resize)
  covers setup, workflows, pipelines, security and troubleshooting.
- **Coding agents:** read [`AGENTS.md`](./AGENTS.md), the integration guide shipped with this package.
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
| S3: `storage: { driver: 's3' }` or `S3Storage` (`…/drivers/s3.js`) | `@aws-sdk/client-s3` `@aws-sdk/s3-request-presigner` ≥ 3.572 |
| SQS: a `queues` entry with `driver: 'sqs'`, or `SqsTaskQueue` (`…/drivers/sqs.js`) | `@aws-sdk/client-sqs` ≥ 3.572 |

A missing optional peer fails at your own import line when you import a driver subpath. A driver
chosen in the config fails when the Resizer first loads it (the first call, or `verify()`) with
`ResizeSetupError` `RESIZE_PEER_MISSING`, which names the packages and the config file. A queue
whose SDK is missing beside queues on another backend is only not served in that process (see
**Backends** under [Config reference](#config-reference)). An older
SQS client does not return receive counts, so failing tasks would never be dead-lettered;
`SqsTaskQueue` warns if that happens.

## Quick start (framework, eager)

```bash
npx resize-scaffold --eager   # src/resizer.ts + src/config/resize.ts
```

```ts
// src/config/resize.ts
import {
  defaultFrameworkResizeConfig,
  type FrameworkResizeConfig,
} from '@adaptivestone/framework-module-resize/framework.js';

export default {
  ...defaultFrameworkResizeConfig,
  mediaModelName: 'File',
  storage: { driver: 'local', rootDir: './var/media', publicBaseUrl: '/media' },
} satisfies FrameworkResizeConfig;
```

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

`generate()` stores the new rows itself and also appends them to `file.previews`, so a
same-request `resolve()` sees them. Reload the media before saving it after `generate()` or
`invalidate()`; the module wrote the rows itself (on a Mongoose document the changed `previews` is
marked modified, and saving the stale list would drop rows a worker stored since it was loaded).

**Background generation.** Run `npx resize-scaffold` (without `--eager`) to add the
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
   a migration before the new API and workers start (the order is in `CHANGELOG.md`). A migration
   that runs before both always works, also when a new pipeline needs the worker deployed before
   the API requests it.
4. Run `npm run cli ResizeWorker` as a separate process (it consumes `'default'`;
   `-- --queue=default --queue=bulk` consumes several queues).

The scaffolded command is `import '../resizer.ts'` plus a re-export of the module's command, so the
worker has the same Resizers as the API. Keep that import, and run
`npx resize-scaffold --check` in CI to catch drift (`--check --eager` for an eager app). Right
after an upgrade it reports drift for every `src/config/resize.ts`, and every `resize.<NODE_ENV>.ts`
override of it, scaffolded by an earlier version (a top-level `queue: { … }` object, or
`defaultFrameworkResizeConfig` imported from `…/config/resize.js`; only full-line `//` comments are
skipped, and a second Resizer's `configName` file is not checked) and for every ejected
`ResizeTask` model without `startedAt` and `finishedAt`. This is intended: rewrite the config to
the shape in [Config reference](#config-reference) (or move it aside, re-run `npx resize-scaffold`
and copy your settings back), and add `startedAt: { type: Date }` and `finishedAt: { type: Date }`
to an ejected model (or move `src/models/ResizeTask.ts` aside (or delete it), re-run `npx
resize-scaffold --eject`, then restore your customizations; the scaffold never overwrites a file, so
re-running `--eject` alone changes nothing). The config file is never diffed. The model shim extends
the default export of `…/framework/ResizeTaskModel.js`, which lets `npm run gen` type
`getModel('ResizeTask')`; `--check` reports a shim from an older scaffold (fix: delete
`src/models/ResizeTask.ts` and re-run `npx resize-scaffold`; `--force` would also overwrite
`src/resizer.ts` and `src/config/resize.ts`).

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
`name`, `logger`, `metrics`, …), the parts `storage`, `media`, `locks` and `tasks` (`false`: eager
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
lock store (unless its task queue routes names to several backends) and decoders; then, for each
queue it consumes, the route of every listed Resizer that uses that name (the backend, built now,
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
all of them, whatever their own queue (`0.3.0-rc.2` did not ask this; `npm run cli ResizeWorker`
serves every Resizer). For a Resizer it does not
serve it loads only the task queue and, when a consumed backend cannot filter claims, that
Resizer's backend of the consumed name (built now), and it rejects the same way when either cannot
be loaded, since it may be a shared one. Resizers built only in other processes cannot be checked:
construct every Resizer in the worker process too. Each task runs with the Resizer named in it and
that Resizer's [coordination](#coordination), so a dead-letter gets that Resizer's `cooldownMs`.
The task events and the three task observers (`afterTaskComplete`, `onTaskFailed`,
`onTaskDeadLettered`) receive the task with `attempts` (its deliveries, this one included).
When a task's handler ends, the worker first waits for a lease renewal still in flight, on every
task queue (a gating one too), within the same `min(leaseMs, 30000)` ms its gate calls get: a
renewal that then answers `false` means the lease was lost, so there is no completion, failure or
event, and the task is left to its next delivery. A renewal that does not answer in that time is
logged, and the task ends without it (its gate calls are then sent without waiting).
`logger` receives the worker loop's own messages, failed gate lock calls included; a logger that
throws never stops the loop. Framework hosts run `npm run cli ResizeWorker`, which serves the
Resizers that `src/resizer.ts` constructs.

## Package exports

| Import | Contents |
|---|---|
| `@adaptivestone/framework-module-resize` | The core; every name is listed below |
| `…/config/resize.js` | The framework-free core defaults: the default core config (default export), `defaultQueueOptions`, `defaultCoordination` |
| `…/drivers/fs.js` | `LocalFsStorage` (the `'local'` storage driver) and its options type `LocalFsStorageOptions` |
| `…/drivers/s3.js` | `S3Storage` (the `'s3'` storage driver) and its options type `S3StorageOptions` |
| `…/drivers/mongo.js` | `mongoParts` (and its types `MongoParts`, `MongoPartsOptions`), `MongoDatabase` (the `'mongo'` database driver), `MongoMediaStore` (and `MongoMediaModel`, `MongoMediaStoreOptions`, `MongoMediaUpdateOptions`), `MongoLockStore` (and `MongoLockModel`, `MongoLockStoreOptions`), `MongoTaskQueue` (and `MongoTaskQueueOptions`), `createResizeModels` (and `CreateResizeModelsOptions`), the schemas `resizeTaskFields`, `resizeTaskIndexes`, `resizeLockFields`, `resizeLockIndexes` and `resizeSchemaOptions`, `resizeMediaSchemaFragment`, `resizeMediaPaths` |
| `…/drivers/sqs.js` | `SqsTaskQueue` (the `'sqs'` queue driver) and its options type `SqsTaskQueueOptions` |
| `…/framework.js` | Framework adapter: `FrameworkResizer`, `FrameworkMediaStore`, `FrameworkLockStore`, `ResizeTaskModel`, `ResizeWorker`, `runResizeWorker`, `defaultFrameworkResizeConfig`, `defaultWorkerOptions`, `resizeMediaSchemaFragment` and `resizeMediaPaths` (re-exported), and the types `FrameworkResizeConfig`, `PartialFrameworkResizeConfig`, `StorageConfig`, `LocalStorageConfig`, `S3StorageConfig` (and their deprecated aliases `FrameworkStorageConfig`, `FrameworkLocalStorageConfig`, `FrameworkS3StorageConfig`), `FrameworkResizerOptions`, `FrameworkMediaStoreOptions` and `TResizeTask`, plus the queue entry types `QueueConfig`, `DatabaseQueueConfig` and `SqsQueueConfig` (re-exported) |
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
- the contracts a driver extends, with their types: `ResizeStorage` (`StorageUploadArgs`),
  `MediaStore` (`ReplacedPreviews`), `LockStore`, and `TaskQueue` (`NewTask`, `TaskAddResult`,
  `ClaimOptions`, `ClaimedTask`, `LeasedTask`, `FailOptions`, `TaskEvent`, `TaskEventHandler`);
- the decoder contract `SourceDecoder` and the decoder types `SourceInfo`, `Raster`, `RasterInfo`,
  `DecodeBox`, `RenderOptions`;
- metrics: the contract `ResizeMetrics`, the sinks `LogMetrics` (its options `LogMetricsOptions`)
  and `NoopMetrics`, and the types `MetricLabels` and `MetricContext`;
- the errors: `ResizeError`, `ResizeConfigError`, `ResizeSetupError`, `ResizeMediaError`,
  `ResizeNoOriginalError`, `ResizeOriginalError`, `ResizeGenerateError`, `ResizeStorageError`,
  `ResizeSecurityError`, and their options `ResizeErrorOptions`;
- the helpers: `formatPictureUrls`, `getSizeKey`, `parseSizeKey`, `isCatalogCovered`,
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
    for `invalidate()`, `InvalidateOpts`; for `uploadOriginal()`, `UploadOriginalOpts`; and
    `PictureUrls`, what `formatPictureUrls` makes of a decision;
  - the media and preview shapes: `MediaLike`, `Original`, `OriginalFormat`, `Preview`,
    `PreviewFormat`, `PreviewScope`, `Filters`, `StorageRef`;
  - the config sections: the image settings `ResizeConfig` and `ResizeLimits`, and `DeepPartial`
    for overrides; storage `StorageConfig`, `LocalStorageConfig`, `S3StorageConfig`; database
    `MongoDatabaseConfig`; coordination `CoordinationOptions`; worker `FrameworkWorkerConfig`; the
    framework config `FrameworkResizeConfig` and `PartialFrameworkResizeConfig`; the Resizer's
    other sections, `ResizerSections`, and the sections that registered drivers add,
    `StorageSectionOf`, `DatabaseSectionOf`, `QueueSectionOf`;
  - the queue entries and timing: `QueueConfig`, `DatabaseQueueConfig`, `SqsQueueConfig`,
    `QueueTimingOptions`;
  - the logger, the event bus and a part built on first use: `ResizeLogger`, `ResizeEventBus`,
    `LazyPart`;
  - the deprecated aliases `FrameworkStorageConfig`, `FrameworkLocalStorageConfig` and
    `FrameworkS3StorageConfig`, each the same type under its core name.

`FrameworkWorkerConfig` and `CoordinationOptions` come from the main entry, which exports every
config type; `…/framework.js` re-exports only the config types its row names.

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
| `rootDir` | required | Public previews go here; serve only this directory |
| `publicBaseUrl` | required | URL prefix, e.g. `/media` |
| `privateRootDir` | optional | Private originals; default `rootDir` + `-private`, and never inside `rootDir` |

The ref is `{ path, visibility, namespace? }`. Reads and writes check real paths. Do not put
symlinks into the public tree.

**`S3Storage`**

| Option | | |
|---|---|---|
| `bucketPublic` | required | Previews |
| `bucketPrivate` | for private uploads | Originals; must differ from `bucketPublic` |
| `publicBaseUrl` | optional | CDN/base URL (`publicUrl` is a deprecated alias) |
| `client` | optional | An existing `S3Client`; otherwise one is built from `region` / `endpoint` / `forcePathStyle` |

The ref is `{ bucket, key, namespace? }`. Every read accepts only the two configured buckets, so a
tampered `bucket` cannot reach another bucket. `publicUrl()` does no I/O, and public access is a
bucket policy, not a per-object ACL. Without `publicBaseUrl`, URLs are virtual-hosted
(`https://<bucket>.s3.<region>.amazonaws.com/<key>`), or path-style with `endpoint` or
`forcePathStyle` (`<endpoint>/<bucket>/<key>`; without an endpoint,
`https://s3.<region>.amazonaws.com/<bucket>/<key>`). China regions (`cn-…`) use
`amazonaws.com.cn` in both forms. SVG objects are uploaded with `Content-Disposition: attachment`.

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
`_id`, and is `null` when the preview was already stored or the media is gone. `replacePreviews`
(which `invalidate` uses) is one `findOneAndUpdate` with an update pipeline, an array update, and
`{ updatePipeline: true, returnDocument: 'before', lean: true, projection: { previews: 1 } }`, so a
custom model-shaped `MongoMediaModel` must accept an update pipeline, and a `findOneAndUpdate`
middleware on the media model also sees that call and must accept an array update. The rows are
first cast with the model's `castObject` when it has one (Mongoose's `Model.castObject`: strict rows
lose the keys they do not declare, loose rows (`strict: false`) keep them, and a value it cannot
cast rejects with Mongoose's `ValidationError` before anything is written; `storageRef` and
`filters` are stored as given, cast or not); without it they are written as given, minus their
`undefined` top-level keys. `MongoMediaStore.verify()` fails with
`RESIZE_MONGO_MEDIA_MODEL_OUTDATED` when the media schema declares preview rows as strict
sub-documents without `identity`, `origin` or `encodeSig` (a mixed or plain `previews` array, or
rows with `strict: false`, pass; `bytes` and `createdAt` are not checked) and logs one warning
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
| `timing` | optional | Every name's queue timing (below); the lease is the message visibility timeout |
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
`maxReceiveCount` above `maxAttempts`, so the module dead-letters a task first. SQS fences less
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
  - The ref you return from `upload()` is opaque to the module and comes back unchanged.
  - `upload()` may receive a `namespace` hint (from `uploadOriginal`) or a `parentRef` (the
    original's ref, for previews). Never both.
- `MediaStore`: `loadMedia(id)` (`null` for deleted media: its task completes as a no-op),
  `appendPreviews(id, previews, dims?)`, and optionally `verify()`, awaited at startup — throw
  there to stop the worker before it claims anything.
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
    downloads the original (see [Freshness](#freshness)).
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
    `ResizeError`. The rows `MongoMediaStore.replacePreviews` writes carry no sub-document `_id`
    (appended rows do); the module reads none, so do not rely on a preview row's `_id`.
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
    queue without `gatesByTask` the core keeps the gate lock for one lease, at most `gateTtlMs`). A
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
(`worker.enabled: false`) only logs that it is disabled. A queue build that fails reaches
`prewarm()` as an issue (see [`prewarm()` issues](#prewarm-issues)): the error's own code when it
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
Resizer: `new Resizer({ decoders: [new PdfDecoder()] })` (or `new FrameworkResizer({ decoders })`).
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
  its engine can. A raster whose `data` length does not match its `info` is
  `RESIZE_DECODER_INVALID`; one with more pixels (width × height × frames) than
  `min(limits.sourcePixels, limits.inputPixels)` is `ResizeMediaError` `RESIZE_SOURCE_TOO_LARGE`
  (`retryable: false`). A decoder's `ResizeMediaError` without a `mediaId` reaches the task, or
  `generate()`, as the same object with the media id set on it; one that cannot take it (frozen)
  is wrapped in a plain `ResizeMediaError` with the media id, its code and `retryable`, and itself
  as `cause`.
- Optionally `verify()`: awaited by `resizer.verify()` and at worker start; throw there when the
  decoder cannot work (e.g. a missing engine).

**Which decoder reads a source.** At upload the decoders are asked in order, and the first that
accepts the bytes measures them: its `format` is stored as `original.format` and its
`contentType` as `original.contentType`. `upload.formats` must list that format
(`RESIZE_ORIGINAL_FORMAT_DISABLED` otherwise). Bytes that every decoder refuses are
`RESIZE_ORIGINAL_FORMAT_UNSUPPORTED`; bytes Sharp cannot read at all stay `RESIZE_ORIGINAL_INVALID`.
In the worker and `generate()`, the stored `original.format` picks the decoder to try first. A
format that no decoder lists, or one whose decoder refuses the bytes, is logged as a warning, and
the bytes are probed through the other decoders; a format whose decoder reads the bytes as another
of its formats (JPEG bytes stored as `png`) is logged too, and rendered as what it is:

```text
resize worker: media <id> is stored as 'jpg' but its bytes are 'jpeg' (no decoder lists the stored format); rendering it as 'jpeg'
```

(`its decoder refused the bytes` for the second case, `its decoder read another of its formats`
for the third; when a host decoder lists the stored format,
refuses the bytes and a later decoder reads them as that same format, the warning says
`… is stored as 'jpeg'; the first decoder listing 'jpeg' refused these bytes, and another decoder
read them`). So `original.format` should be the
decoder's id: `jpeg`, not `jpg` or `image/jpeg`; fix such a record to silence the warning. When no
decoder lists the stored format and none reads the bytes, the source fails with the retryable
`ResizeSetupError` `RESIZE_DECODER_MISSING`: a process without the decoder that record needs (pass
it in `decoders` in every process). When the stored format's decoder refuses the bytes (or the
media has no stored format) and every other decoder refuses them too, it fails with
`ResizeMediaError` `RESIZE_SOURCE_FORMAT_UNSUPPORTED` (`retryable: false`: dead-lettered at once).

## Config reference

The Resizer's config holds image settings only. `new Resizer({ config })` defaults to
`…/config/resize.js`; spread it to change keys (`createResizer` and `FrameworkResizer` merge a
partial config over the defaults for you). A config object is validated when the Resizer is
created; a config function (the framework adapter passes one) on first use (`ready()`) or
`verify()`.

| Key | Default | Notes |
|---|---|---|
| `formats` | `['jpeg', 'webp', 'avif']` | Generated formats; each needs an `encode.formats` entry |
| `upload.maxBytes` | `26214400` (25 MiB) | Largest accepted original |
| `upload.formats` | `['jpeg', 'png', 'webp', 'avif', 'gif', 'svg']` | Accepted originals, detected from the bytes; a decoder must identify the format (see [Decoders](#decoders)) |
| `maxSize` | `{ width: 2000, height: 1200 }` | Box for `fit` |
| `animated` | `false` | `true`: WebP and GIF previews of an animated original keep its frames, for a pipeline without `beforeSteps` or `variantSteps`; other formats, pipelines with steps, and animations with an EXIF orientation get the first frame. `actualWidth`/`actualHeight` are one frame's size |
| `encode.formats` | jpeg `{ quality: 88, mozjpeg: true, chromaSubsampling: '4:2:0' }`, webp `{ quality: 82, effort: 4 }`, avif `{ quality: 64, effort: 4 }` | Passed to `sharp.toFormat(id, options)`; `{}` keeps Sharp's defaults |
| `encode.sharpen` | `{ cover: true, fit: false }` | Mild sharpening after downscaling, or `false` |
| `encode.flatten` | `{ formats: ['jpeg'], background: '#ffffff' }` | Formats whose transparency is flattened |
| `limits.inputPixels` | `268402689` | Sharp's input limit on the bytes a decoder reads (one frame of an animation); pixels the module renders itself are not limited by it |
| `limits.sourcePixels` | `50000000` | Largest frame, rejected before decoding |
| `limits.resultDimension` | `5000` | Largest output side for width/height sizes; when the side derived from the aspect ratio of a width-only or height-only size would exceed it, the preview is cropped to it |
| `limits.animationFrames` | `64` | Frame limit for animated input; an animation is also shortened to the frames that fit the pixel budget `min(sourcePixels, inputPixels)` at the larger of the source's size and the preview's |
| `limits.processingTimeoutSeconds` | `30` | Timeout per Sharp operation |
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
variant is planned from its result. A step that resolves with anything that is not a one-frame
`Raster` (a `Buffer`, a Sharp instance, a raster whose `data` length does not match its `info`)
fails with `ResizeSetupError` `RESIZE_PIPELINE_STEP_INVALID`, and so does `sharpToRaster` given a
multi-page image. A `variantStep` is `(img, { variant, ctx }) => Sharp` (or a promise of one): it
runs per variant, after the resize and before the encode, on a Sharp instance over that size's
pixels, so `metadata()` reports the preview's size (with `format: 'raw'`, no EXIF, ICC profile,
density or orientation, and `hasAlpha` as the sized pixels have it), a `resize()` resizes the
preview, and operations Sharp used to apply before its resize (such as `trim()`) apply to the
preview.

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
  `verify()`); a disabled worker only logs that it is disabled. With several broken entries, the
  first error reported may differ from `0.3.0-rc.2`. An entry set to
  `undefined` is not defined: set one to `undefined` in an environment file to remove it there (a
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
`RESIZE_CONFIG_REMOVED_KEY`, and the message says where the value goes: the 0.2.x keys
`webpAvifOnly`, `encode.quality`, `encode.effort`, `encode.mozjpeg`, `encode.chromaSubsampling` and
`encode.flattenBackground`; `queue` and `worker` in a core config (timing goes to the task queue;
framework hosts define queues in `queues` and keep `worker` in `src/config/resize.ts`);
`worker.concurrency` in a framework config file (use the top-level `concurrency`); a `queue`
object in a framework config file (define the queue in `queues` of `src/config/resize.ts` and set
`queue` to its name); `queues.<name>.queues` (give each SQS queue its own entry); `lockTtlMs` in a
task queue's `timing` or a `queues` entry (use [coordination](#coordination): `failed` →
`cooldownMs`, `dispatch` → `gateTtlMs`, drop `worker`); and the worker's `--config` flag and
`runResizeWorker({ configName })` (the worker reads `worker` and `queues` from
`src/config/resize.ts`).

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
  claimed and extended within it, otherwise it lapses and a later read queues the task. The worker extends the lock: to
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
`new LogMetrics(logger, { debug: true })` on its `logger` option, else the app logger, so that
logger decides whether the debug lines are kept. `new NoopMetrics()` turns metrics off. The sink is checked by shape at construction,
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
| `resize.variant` | timing | ms of one variant | `pipeline`, `format`, `mode`: `task` or `eager`, `outcome`: `stored`, `duplicate`, `rendered` or `failed`; `code` (failed) | `mediaId`, `identity`, `taskId` (task mode), `rawFormat` (`format: 'unconfigured'`) |
| `resize.variant.bytes` | count | the uploaded preview's bytes (stored, duplicate, rendered) | `pipeline`, `format` | — |
| `resize.task` | timing | ms from the claim to the task's outcome | `queue`, `pipeline`, `outcome`: `completed`, `failed` or `dead`; `code` (failed or dead, for a module error) | `taskId`, `mediaId`, `attempts`, `variants`, `payloadQueue` (when the task names another queue) |
| `resize.claim` | timing | ms the worker's loop waited for this task | `queue` | `taskId` |

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
that is not a positive safe integer is `RESIZE_METRICS_INVALID`.
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
  resize: task <taskId> of media <mediaId> <completed|failed|dead> in <ms> ms (Resizer '<r>', queue '<q>', pipeline '<p>', attempt <n>, variants <n>[, code <code>])
  resize: variant <identity> of media <mediaId> failed in <ms> ms (Resizer '<r>', pipeline '<p>', format '<f>'[, code <code>])
  ```

  A missing value prints as `?`; a code reduced to `'other'` prints the raw code.
- **The window** opens with the first summed event and closes when it is written, after
  `summaryIntervalMs`. Its timer is `unref`ed, so it never keeps a process alive, and no timer runs
  between windows. `flush()` writes the open window now. The worker flushes the sink of every
  Resizer it serves when it stops (once per distinct sink), waiting at most 5 s for each; that wait
  keeps the process alive until the flush settles or the 5 s end. An API process should call
  `await resizer.metrics.flush?.()` at shutdown, or the open window's counts are lost.
- **`debug: true`** also writes every call as one `debug` line, `resize metric <name> <value>
  <labels JSON> <context JSON>`, when the logger has a `debug` method (`ResizeLogger.debug` is
  optional). It costs two `JSON.stringify` calls per event. The default sink of a
  `FrameworkResizer` writes to its `logger` option, else the app logger, which always has `debug`,
  so it pays that cost even when the app drops debug lines: pass `metrics: new LogMetrics(logger)`
  to skip it.

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
- a row without signatures (written before `0.3.0-rc.1`).

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
in one `replacePreviews` write; the other new rows are appended. `GenerateResult.replaced` lists
the storage refs of the rows `generate()` replaced (set only when there are some), and
`generate()` swaps the rows in the caller's `media.previews` too. Each replacing write logs one
`info` line: "resize: replaced <n> outdated preview(s) of media <id>; their files are not deleted:
storage refs <refs>".

**Old files are never deleted.** Clean them up from that log line, or with a sweep that deletes
preview objects no row references. A row without an `identity` (written before 0.3.0) stays beside
its replacement and keeps its file referenced, so a sweep never finds that file: delete such rows
(and their files) yourself.

**A media without stored dimensions** (`original.width` and `original.height` must both be numbers;
a stored `null` counts as missing) has no row the read path can prove fresh, since it cannot
measure the original. Its first read queues one task that downloads and inspects the original (no
pixel decode, no upload when its rows turn out fresh) and records the dimensions; later reads find
the rows fresh. A `MediaStore` must therefore save `backfillDims` in `appendPreviews`, also when
`previews` is empty. A store that drops them makes every read of such a media queue a task that
downloads the original; the worker then warns once: "resize worker: the media store did not record
the original's dimensions of media <m> — …".

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

**Mongo `_id`.** Rows that `replacePreviews` writes carry no sub-document `_id`, so a replaced row
loses the `_id` it had: key preview rows by `identity`, never by `_id`.

## Operations

- **Task states (Mongo):** `pending → processing → completed`. A row's `active` is `true` from
  `add()` until the task completes: the row is the gate of its Resizer, media, pipeline and queue (see
  [Coordination](#coordination)). Rows written before the gate have no `active` and never block a
  new task. `startedAt` is when the latest delivery started (every claim sets it), and
  `finishedAt` when the task completed or was dead-lettered (a retry leaves both as they are); they
  are for inspection only, and the worker never reads them. An ejected or hand-written model
  without them keeps working (the times are dropped), but `resize-scaffold --check` reports it.
  - A failed attempt returns to `pending` with backoff, still active.
  - After `maxAttempts` the task is `dead`, and the lease never reclaims it. A task is `dead` at
    once when its error has `retryable: false` (`ResizeError.retryable`, default `true`): no
    retry can help. The module sets it on every `ResizeSecurityError` and on six codes: the
    media has no original (`RESIZE_NO_ORIGINAL`), no decoder reads the source's bytes
    (`RESIZE_SOURCE_FORMAT_UNSUPPORTED`), the source has no dimensions or exceeds the
    pixel limits (`RESIZE_SOURCE_METADATA_MISSING`, `RESIZE_SOURCE_TOO_LARGE`), an SVG has
    dimensions that cannot fit the renderer (`RESIZE_SVG_DIMENSIONS_UNSUPPORTED`, also rejected
    before storage by `uploadOriginal()`), or an SVG render ran past
    `limits.processingTimeoutSeconds` (`RESIZE_SVG_RENDER_TIMEOUT`). The worker reads
    `retryable` on the error that fails the task, when it is a `ResizeError` — including one from
    a duplicate copy of the package (it checks the `isResizeError` brand, not the class); errors
    from other libraries are retried, whatever fields they carry. A `ResizeError` from
    `loadMedia`, `storage.download`, the decoder's checks and render, `beforeSteps` or
    `appendPreviews` with `retryable: false` dead-letters the task at once. A source that cannot
    be decoded fails the task (and `generate()`) with the decoder's error, or with the retryable
    `ResizeMediaError` `RESIZE_SOURCE_DECODE_FAILED` when that error is not a `ResizeError`
    (Sharp's own, for example; it is the `cause`). An
    error inside one variant (`variantSteps`, encoding, `storage.upload`) fails only that
    variant: it is logged, and the task fails with the retryable
    `RESIZE_WORKER_INCOMPLETE` (retried for the missing variants only, then dead-lettered after
    `maxAttempts`).
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
  `retryable: false`). Steps are host code.
- **At-least-once delivery:** a task can run more than once. The worker skips previews that
  already exist fresh, and the media store keeps one row per preview identity, so a repeat never
  duplicates them. A task completes only when every requested
  variant is stored fresh. When an attempt is only partly successful, its previews are saved and the
  next attempt makes only the missing ones.
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
  pipeline `version`). The worker and `generate()` record them on every row from `0.3.0-rc.1` on,
  and `resizeMediaSchemaFragment` declares them. The read path, `prewarm()`, `generate()` and the
  worker compare them with what the current settings would record (see [Freshness](#freshness)).
  Rows written earlier have no `origin` or `encodeSig`, so they are stale: each is served until
  its replacement is stored, regenerated on its next read, and its old file stays in storage
  (plan the storage cost and the cleanup). Rows without an `identity` (written before 0.3.0) are
  never removed by `invalidate` or `replacePreviews`: delete their files yourself.
- **What a read logs:** a read writes a log line only for what an operator must fix, and only once
  per Resizer (once more after its task queue is set up again): an unregistered pipeline name
  (`error`, once per name, for at most 100 names), a format list without `encode.formats` entries
  (`error`, once per list, for at most 100 lists), and, when the caller passed
  `enqueueMissing: true` to a Resizer without a task queue, one `warn`. A media without an original
  logs nothing.
  Every read is counted instead, as `resize.read` with its outcome (see [Metrics](#metrics)). A
  stored preview whose `publicUrl` throws, and an enqueue that throws, are still logged on every
  read. `prewarm()` logs as before.
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
  `invalidate` returns too), access checks, the response shape, migrating legacy data, and domain
  image analysis such as face blurring (in pipeline steps).

### `prewarm()` issues

`prewarm()` never throws. A requested variant without a confirmed task is in `result.unconfirmed`,
and `result.issues` says why, each issue with the variants it covers and `retryable`. `false`: the
module knows that no retry can help until the request, the config or the code changes. `true`: the
module has not ruled a retry out. The cause may pass by itself, or it is a fault that the queue
can only report in the logs (an unregistered or outdated `ResizeTask` model, a lock store that
fails): fix the logged cause before you retry. An issue may also carry `causeCode`, the code of the
error behind it when that code is not one of the issue codes below: a driver's own code, or
`RESIZE_PEER_MISSING`, under `RESIZE_ENQUEUE_QUEUE_FAILED`, and `RESIZE_LOCKS_REQUIRED` under
`RESIZE_ENQUEUE_LOCK_FAILED`. The set of issue codes is closed, so a `switch` over `code` stays
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
| `RESIZE_ENQUEUE_UNCONFIRMED` | `add()` resolved `unconfirmed`: the queue did not confirm the task (on Mongo a database error, a duplicate key on another unique index of your model, or an unregistered or outdated `ResizeTask` model, each logged; on SQS a send that returned no `MessageId`). Or `add()` resolved a value in none of the `TaskAddResult` shapes (a queue written for an older version), logged once | `true`, even for an unregistered or outdated model: fix the logged cause first; `false` for a value in none of the shapes |
| `RESIZE_ENQUEUE_CONFIRM_FAILED` | After an `in-flight` add, `findActive()` threw (logged), so what the active task holds is unknown | `true` |
| `RESIZE_ENQUEUE_INTERNAL_ERROR` | An unexpected error (e.g. a media without an id, `RESIZE_MEDIA_NO_ID`), a Resizer that could not start (a part that did not load, an invalid config), a task queue that cannot be used (the error `verify()` reports, e.g. `RESIZE_LOCKS_REQUIRED`), or an invalid timing of the call's `queue` (a name used only per call; every variant is `unconfirmed`); the message is the error's | `false` when the error is a `ResizeError` with `retryable: false`, or a `ResizeMediaError`, `ResizeConfigError` or `ResizeSetupError` (or a subclass); otherwise `true` |

## Development

`npm test` runs the `node:test` suite. Core tests construct `new Resizer({ … })` with fakes and
need no framework app. Framework-adapter tests install a fake app with `setAppInstance()`.
`src/importGraph.test.ts` fails if the main entry ever reaches framework code. Before a release,
run `npm run build` and `npm run smoke`.
`node --experimental-strip-types bench/renderOnce.ts [rounds] [--single-thread]` benchmarks the
render path (3 sizes × JPEG and WebP from one 24 MP JPEG) against a "resize once per size"
baseline, with an A/A control, and exits 0 (PASS: within 5% of the baseline in wall and CPU
time), 1 (FAIL) or 2 (INCONCLUSIVE: the machine was too noisy to judge).

## License

MIT
