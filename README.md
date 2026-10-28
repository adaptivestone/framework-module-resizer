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
`ResizeSetupError` `RESIZE_PEER_MISSING`, which names the packages and the config file. An older
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
lock store beside a task queue without `gatesByTask` (`FrameworkLockStore`, the framework's `Lock`
model, for the SQS driver or a custom queue without the flag; the database queue needs none), and
the app logger and events. Import `src/resizer.ts` wherever you
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
`queues`, and `tasks: false` keeps a Resizer eager whatever the config says. A task queue passed as
`tasks` skips only the choice of the Resizer's queue from `queues` (its queue is the `queueName`
option, else the file's `queue`, else `'default'`, and `verify()` checks that the task queue serves
it); a `src/config/resize.ts` that exists is still read and validated as a whole for `worker` and
`coordination`, so a broken `queues` there fails `verify()` unless `coordination` is passed in code
too.

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
4. Run `npm run cli ResizeWorker` as a separate process.

The scaffolded command is `import '../resizer.ts'` plus a re-export of the module's command, so the
worker has the same Resizers as the API. Keep that import, and run
`npx resize-scaffold --check` in CI to catch drift (`--check --eager` for an eager app). Right
after an upgrade it reports drift for every `src/config/resize.ts` scaffolded by an earlier
version (a `queue: { … }` object, or `defaultFrameworkResizeConfig` imported from
`…/config/resize.js`; `//` comment lines are not checked) and for every ejected `ResizeTask` model
without `startedAt` and `finishedAt`. This is intended: rewrite the config to the shape in
[Config reference](#config-reference) (or move it aside, re-run `npx resize-scaffold` and copy your
settings back), and add `startedAt: { type: Date }` and `finishedAt: { type: Date }` to an ejected
model (or re-run `npx resize-scaffold --eject`). The config file is never diffed. The model
shim extends the default export of `…/framework/ResizeTaskModel.js`, which lets `npm run gen` type
`getModel('ResizeTask')`; `--check` reports a shim from an older scaffold (fix: delete
`src/models/ResizeTask.ts` and re-run `npx resize-scaffold`; `--force` would also overwrite
`src/resizer.ts` and `src/config/resize.ts`).

## Without the framework

The main entry imports no framework code, and the shipped drivers need no framework either. With
MongoDB, a plain Node app writes no driver code:

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
store, for a Resizer that swaps in `SqsTaskQueue`. With the parts, create the indexes of both
models through your migration process (for example
`await mongoose.connection.models.ResizeTask.createIndexes()`, and the same for `ResizeLock`); the
module never creates them at runtime (`createResizeModels` sets `autoIndex: false`), and
`verify()` rejects with `RESIZE_MONGO_INDEX_MISSING` until the gate index exists (with Mongoose's
`autoIndex` on it first waits for the model's own index build).

**The worker.** `runWorker({ signal, queue?, resizers?, logger?, sharp? })` serves the Resizers in
`resizers`, by default every Resizer constructed in the process when it starts (an empty list
rejects with `RESIZE_NO_RESIZER`). The list is resolved once, at start: a Resizer constructed later
is not served. Every claim carries the served Resizer names, so a task queue with `claimFilters`
(`MongoTaskQueue`) never hands the worker another Resizer's task. A task queue that cannot filter
claims (`SqsTaskQueue`, most custom queues) may: such a task is never run there. It is given back
to the queue for a worker that serves it, or, when the task queue cannot give tasks back (no
`release`), retried: it fails with `RESIZE_NO_RESIZER`, then dead-letters after `maxAttempts`, and
its task events are logged and dropped. The worker logs each such Resizer once. `SqsTaskQueue`
counts every receive, so there a task given back often can still use up its `maxAttempts` and be
dead-lettered by the worker that serves it. Before it claims anything, the worker readies and
verifies every listed Resizer, so one that cannot start, or whose task queue cannot be used (no lock
store beside a queue without `gatesByTask`, invalid timing or coordination), rejects `runWorker`. A
list must name each Resizer once (two Resizers under one name: `RESIZE_DUPLICATE_RESIZER`). Beside
a task queue the worker consumes that cannot filter claims, the list must also include every
Resizer of the process that uses that queue: otherwise the worker would claim their tasks without
running them, so it rejects with `RESIZE_QUEUE_SHARED_RESIZER_UNLISTED`. For a Resizer it does not
serve it loads only the task queue, and it rejects the same way when that task queue cannot be
loaded, since it may be a shared one. Resizers built only in other processes cannot be checked:
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
| `@adaptivestone/framework-module-resize` | `Resizer`, `getResizer`, `resetResizerForTests`, `runWorker`, the contracts (`ResizeStorage`, `MediaStore`, `LockStore`, `TaskQueue`), helpers (`formatPictureUrls`, `getSizeKey`, `parseSizeKey`, `isCatalogCovered`), errors, types (among them `InvalidateOpts`, `ReplacedPreviews` and the queue entry types `QueueConfig`, `DatabaseQueueConfig`, `SqsQueueConfig`) |
| `…/config/resize.js` | The framework-free core defaults: the default core config (default export), `defaultQueueOptions`, `defaultCoordination` |
| `…/drivers/fs.js` | `LocalFsStorage` |
| `…/drivers/s3.js` | `S3Storage` |
| `…/drivers/mongo.js` | `mongoParts`, `MongoMediaStore`, `MongoLockStore`, `MongoTaskQueue`, `createResizeModels`, the schemas, `resizeMediaSchemaFragment`, `resizeMediaPaths` |
| `…/drivers/sqs.js` | `SqsTaskQueue` |
| `…/framework.js` | Framework adapter: `FrameworkResizer`, `FrameworkMediaStore`, `FrameworkLockStore`, `ResizeTaskModel`, `ResizeWorker`, `runResizeWorker`, `defaultFrameworkResizeConfig`, `defaultWorkerOptions`, `resizeMediaSchemaFragment` and `resizeMediaPaths` (re-exported), and the types `FrameworkResizeConfig`, `FrameworkStorageConfig`, `FrameworkLocalStorageConfig`, `FrameworkS3StorageConfig`, `FrameworkResizerOptions`, `FrameworkMediaStoreOptions` and `TResizeTask`, plus the queue entry types `QueueConfig`, `DatabaseQueueConfig` and `SqsQueueConfig` (re-exported). `FrameworkWorkerConfig` and `CoordinationOptions` come from the main entry, which exports every config type |
| `…/framework/ResizeTaskModel.js` | `ResizeTaskModel` as the default export, for the scaffolded model shim |

## Drivers

A `Resizer` takes four parts:
- `storage` (required, a `ResizeStorage`): files;
- `media` (required, a `MediaStore`; `RESIZE_MEDIA_REQUIRED` without it): media documents and
  their previews;
- `locks` (a `LockStore`): the gate locks of a task queue without `gatesByTask` (`SqsTaskQueue`,
  most custom queues), and required beside one (`RESIZE_LOCKS_REQUIRED` from `verify()`); neither
  `MongoTaskQueue` nor an eager-only Resizer needs one;
- `tasks` (queued workflows, a `TaskQueue`): where tasks wait — `mongoParts(…).tasks`, or an
  `SqsTaskQueue`.

The core owns the queue logic (the worker loop, lease heartbeat, task timeout, retry with backoff,
dead-lettering, the gate lock of a task queue without `gatesByTask`, and events), so every queue
behaves the same; adapters only implement atomic operations. Drivers receive no `app` argument;
each one uses its own clients. `FrameworkResizer` builds `FrameworkMediaStore` (the app's media
model) and uses the scaffolded `ResizeTask` model as its database queue; it builds
`FrameworkLockStore` (the framework's own `Lock` model) on first use, and only beside a task queue
without `gatesByTask` (the SQS driver, or a custom queue without the flag), so an app on the
database queue needs no `Lock` model. Any part may also be a function (sync or
async), called once on first use: `new Resizer({ storage: async () => …, media, locks, tasks })`.
`await resizer.ready()` loads them; the Resizer's own methods and the worker do it for you. After
loading, `ready()` validates the image config (a config given as a function is read here), then
sets up the task queue (a lock store beside a queue without `gatesByTask`, valid queue timing and
a valid [coordination](#coordination), read here when it is a function), then builds the Resizer's
services. A part that does not load or an invalid config rejects; a broken framework config file
therefore fails as a config error, never as a task queue failure. A task queue that cannot be used
does not reject: the error is logged once, `resolve()` serves the stored previews and queues
nothing, `uploadOriginal()` and `generate()` work, `prewarm()` returns `incomplete` with a
non-retryable `RESIZE_ENQUEUE_INTERNAL_ERROR` issue carrying the error, and `verify()` and the
worker reject with it (`RESIZE_LOCKS_REQUIRED`, `RESIZE_CONFIG_QUEUE_*`,
`RESIZE_CONFIG_REMOVED_KEY` for a `lockTtlMs` left in the queue's own `timing`,
`RESIZE_CONFIG_COORDINATION_INVALID`). `verify()` also runs the drivers' own checks, among them
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
lose the keys they do not declare, and a value it cannot cast rejects with Mongoose's
`ValidationError` before anything is written); without it they are written as given, minus their
`undefined` top-level keys. `MongoMediaStore.verify()` fails with
`RESIZE_MONGO_MEDIA_MODEL_OUTDATED` when the media schema declares preview rows as strict
sub-documents without `identity`, `origin` or `encodeSig` (a mixed or plain `previews` array, or
rows with `strict: false`, pass; `bytes` and `createdAt` are not checked),
`MongoLockStore.verify()` with `RESIZE_MONGO_LOCK_MODEL_OUTDATED` when a strict lock schema has no
`owner` field (for example a `ResizeLock` model registered on the connection before this
version), and `MongoTaskQueue.verify()` with `RESIZE_MONGO_MODEL_OUTDATED` when the `ResizeTask`
schema lacks a field the queue writes (`active` and `cooldownUntil` among them). The queue checks
the schema at its first use too, whether or not `verify()` ran: with such a model `add()` logs
`RESIZE_MONGO_MODEL_OUTDATED` once per model and resolves `unconfirmed` every time until the model is
fixed (a strict schema without `active` would store every task and turn the gate off), and its
other methods reject with it. `MongoTaskQueue.verify()` also reads the collection's indexes and
rejects with `ResizeSetupError` `RESIZE_MONGO_INDEX_MISSING` unless one is the gate index: unique on
exactly `{ resizer: 1, fileId: 1, pipeline: 1, queue: 1 }` with
`partialFilterExpression: { active: true }` (or the same filter spelt `{ active: { $eq: true } }`;
a collection that does not exist yet has none). Before it reads them it waits for an opening
connection and for the model's own `init()`: with Mongoose's `autoIndex` on (an API server),
Mongoose is still building the declared indexes at boot, so the check waits for that build (a
failed build is the cause of the missing-index error); with `autoIndex` off (the framework CLI
that runs the worker, and the models `mongoParts` registers) it builds nothing. A connection that
is closed (never opened, or disconnected) rejects at once with `RESIZE_MONGO_NOT_CONNECTED`; one
that is opening and fails rejects with it once the driver gives up (its
`serverSelectionTimeoutMS`, 30 s by default), and the message names the driver's error. It never
creates an index: create the gate index through your migration process. `MongoTaskQueue` sets `gatesByTask` and `claimFilters`: its rows are the gate (see
[Coordination](#coordination)), and a claim takes only tasks of the Resizers the worker serves. Its
`add()` counts a duplicate key as the gate only on the gate index; a duplicate key on another unique
index of your model is logged, and the add is `unconfirmed`.

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
passes each `queues` entry's timing through `getTiming`); the core validates it when the Resizer
starts, not when the queue is constructed (invalid timing makes `verify()` and the worker reject;
see `ready()` above). A redrive policy on the SQS queue is optional; if you keep
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
    one whose identity is already stored counts as covered: another worker stored it first, so the
    core logs it as a warning with its storage ref, does not count it as created and sends no
    `onPreviewGenerated` event. Any other is not recorded.
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
    `ResizeError`.
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
    and `verify()` and the worker reject a Resizer whose own `queueName` it does not serve.
  - Optionally `getTiming(queue)`: that name's timing (missing values default); the core reads it
    once per name, on that name's first use. A queue with one timing for every name ignores the
    argument. Also optionally `verify()`.

## Config reference

The Resizer's config holds image settings only. `new Resizer({ config })` defaults to
`…/config/resize.js`; spread it to change keys. A config object is validated when the Resizer is
created; a config function (the framework adapter passes one) on first use (`ready()`) or
`verify()`.

| Key | Default | Notes |
|---|---|---|
| `formats` | `['jpeg', 'webp', 'avif']` | Generated formats; each needs an `encode.formats` entry |
| `upload.maxBytes` | `26214400` (25 MiB) | Largest accepted original |
| `upload.formats` | `['jpeg', 'png', 'webp', 'avif', 'gif', 'svg']` | Accepted originals, detected from the bytes |
| `maxSize` | `{ width: 2000, height: 1200 }` | Box for `fit` |
| `animated` | `false` | `true`: WebP and GIF previews of an animated original keep its frames, for a pipeline without `variantSteps`; other formats, pipelines with variant steps, and animations with an EXIF orientation get the first frame. `actualWidth`/`actualHeight` are one frame's size |
| `encode.formats` | jpeg `{ quality: 88, mozjpeg: true, chromaSubsampling: '4:2:0' }`, webp `{ quality: 82, effort: 4 }`, avif `{ quality: 64, effort: 4 }` | Passed to `sharp.toFormat(id, options)`; `{}` keeps Sharp's defaults |
| `encode.sharpen` | `{ cover: true, fit: false }` | Mild sharpening after downscaling, or `false` |
| `encode.flatten` | `{ formats: ['jpeg'], background: '#ffffff' }` | Formats whose transparency is flattened |
| `limits.inputPixels` | `268402689` | Sharp decoder limit |
| `limits.sourcePixels` | `50000000` | Largest frame, rejected before decoding |
| `limits.resultDimension` | `5000` | Largest output side for width/height sizes; when the side derived from the aspect ratio of a width-only or height-only size would exceed it, the preview is cropped to it |
| `limits.animationFrames` | `64` | Frame limit for animated input; an animation is also shortened to the frames that fit `sourcePixels` and `inputPixels` |
| `limits.processingTimeoutSeconds` | `30` | Timeout per Sharp operation |
| `concurrency` | `4` | Variants processed in parallel per task or `generate()` call |

**Pipelines** (`pipelines` of `new Resizer` or `new FrameworkResizer`, fixed at construction) are
`{ beforeSteps?, variantSteps?, version? }`. `version` is an optional string that is part of every
preview row's `encodeSig` (see [Operations](#operations)): bump it when a step's output changes, to
mark the pipeline's stored previews as made with older settings. They are not regenerated yet; a
later release's freshness check will regenerate them. It is not validated, and `''` signs
differently from an absent version.

**Queue name.** `queueName` (`new Resizer({ queueName })` or `new FrameworkResizer({ queueName })`,
default `'default'`; a `FrameworkResizer` without it takes its file's `queue`) names the queue of the
Resizer's tasks. `resolve()` and `prewarm()` take a per-call `queue`, and a worker consumes one queue
(`runWorker({ queue })`, `npm run cli ResizeWorker -- --queue=<name>`). A string `queueName` is
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
name's timing once, on that name's first use, and validates it: the Resizer's own `queueName` when
the Resizer sets up its task queue (invalid timing makes `verify()` and the worker reject, while
reads serve stored previews and queue nothing and `prewarm()` reports it; see `ready()` under
[Drivers](#drivers)); a name used only per call on its first `prewarm()` (every variant
`unconfirmed`, with one non-retryable `RESIZE_ENQUEUE_INTERNAL_ERROR` issue carrying the timing
error) or `resolve()` (logged once per queue name), and in the worker that consumes it. How long
locks last is not timing: it is the Resizer's [coordination](#coordination). The timing defaults
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
merge field by field, arrays are replaced); the module does not merge again, and its messages
name both (``src/config/<name>.ts (or its <name>.<NODE_ENV>.ts override)``). A file spreads
`defaultFrameworkResizeConfig` from `…/framework.js` (the image settings above) and adds that
Resizer's own sections, which only `FrameworkResizer` reads:
- `mediaModelName` (required): the host media model, used by `FrameworkMediaStore`.
- `storage`: `{ driver: 'local', rootDir, publicBaseUrl, privateRootDir? }` or `{ driver: 's3',
  bucketPublic, bucketPrivate?, publicBaseUrl?, region?, endpoint?, forcePathStyle? }`. Required
  unless the code passes `storage`. S3 is imported only when selected; credentials come from the
  AWS SDK's default chain. Switching the driver in an environment file keeps the other keys of
  the merged section, so set `publicBaseUrl` there too.
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
  | `driver` | both, required | `'database'`: tasks in the app's `ResizeTask` model (`DatabaseQueueConfig`); `'sqs'`: an SQS queue of its own (`SqsQueueConfig`, needs `@aws-sdk/client-sqs`) |
  | `queueUrl` | `sqs`, required | This name's SQS queue; two entries with the same URL are `RESIZE_CONFIG_INVALID` |
  | `deadLetterQueueUrl` | `sqs`, optional | Dead tasks are sent here with their error, then deleted; without it they are logged and deleted |
  | `waitTimeSeconds` | `sqs`, `10` | Long poll per claim (0–20) |
  | `region`, `endpoint` | `sqs`, optional | The SQS client's; credentials come from the AWS SDK's default chain |
  | `leaseMs`, `retryBackoffMs`, `maxAttempts`, `idlePollMs`, `taskTimeoutMs` | both, optional | This queue's timing (the table above); the rest default |

  A `queues` that is not an object of names, a blank name, an entry without driver `'database'` or
  `'sqs'`, or an SQS entry without `queueUrl` is `RESIZE_CONFIG_INVALID`; an invalid timing value
  keeps its own code (`RESIZE_CONFIG_QUEUE_INVALID`, `RESIZE_CONFIG_QUEUE_LEASE_INVALID`) and its
  message names the entry. Every entry is validated with the file, on first use.
- `worker`: `{ enabled, sharpConcurrency, sharpCache }` for the `ResizeWorker` command
  (`defaultWorkerOptions` from `…/framework.js`: `false`, `1`, `false`). Every key is optional and a
  missing one takes its default, so an environment file may set only `worker: { enabled: true }`; a
  wrong type is `RESIZE_CONFIG_INVALID` naming the key. `enabled` allows the command to run.
- `coordination`: `{ gateTtlMs, cooldownMs }` for every Resizer of the process (missing values take
  `defaultCoordination`); see [Coordination](#coordination). `new FrameworkResizer({ coordination })`
  sets one Resizer's instead.

A missing `src/config/resize.ts` means no queues, the default `worker` and the default
`coordination`. Only `queue: false` in the Resizer's own file (with no `queueName` option),
`tasks: false` in code, or a task queue and `coordination` both passed in code keep a Resizer from
reading `src/config/resize.ts`; every other Resizer, one whose file sets no `queue` too (it reads
`queues` to learn whether it is eager only or on `'default'`), validates that whole file on first
use. So a malformed `queues` or `worker` section there fails that Resizer's first call and its
`verify()`: `uploadOriginal()`, `generate()` and `invalidate()` throw the config error (e.g.
`RESIZE_CONFIG_INVALID`), and `resolve()` and `prewarm()`, which never throw, return the empty
decision and `incomplete`, so even stored previews are not served until the file is fixed.
`src/config/resize.ts` needs `mediaModelName` only while the default Resizer reads it as its own
file.

Every file writes `satisfies FrameworkResizeConfig`: `src/config/resize.ts` and each other
Resizer's file. Two files write `satisfies Partial<FrameworkResizeConfig>` instead: an environment
override, and a `resize.ts` that holds only the process-wide sections (no default Resizer, so no
`mediaModelName`). A full `src/config/resize.ts` with two queues, and a second Resizer's file:

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
`database` entry is one backend (the app's `ResizeTask` model), and the SQS entries that share
`region`, `endpoint`, `deadLetterQueueUrl` and the effective `waitTimeSeconds` (unset counts as 10)
are one backend, one `SqsTaskQueue` with a name → URL map. Each name is a lane on its backend's task
queue, with its own timing, and the worker runs one consume loop per task queue. A Resizer's task
queue is its own queue's backend, and it serves only that backend's names: a call on a queue of
another backend, or on a name that `queues` does not define, queues nothing (`prewarm()` reports
`RESIZE_QUEUE_NOT_SERVED`, see [`prewarm()` issues](#prewarm-issues); `resolve()` logs it once per
queue name). So moving only some queues to another backend in `resize.<NODE_ENV>.ts` (only
`queues.default` to SQS, say, while `queues.bulk` stays on the database) splits them in that
environment, and those calls fail there with `RESIZE_QUEUE_NOT_SERVED`: move all of a Resizer's
queues together until routing between backends ships. The same goes for SQS entries with different
dead-letter queues.

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
    retry can help. The module sets it on every `ResizeSecurityError` and on five codes: the
    media has no original (`RESIZE_NO_ORIGINAL`), the source has no dimensions or exceeds the
    pixel limits (`RESIZE_SOURCE_METADATA_MISSING`, `RESIZE_SOURCE_TOO_LARGE`), an SVG has
    dimensions that cannot fit the renderer (`RESIZE_SVG_DIMENSIONS_UNSUPPORTED`, also rejected
    before storage by `uploadOriginal()`), or an SVG render ran past
    `limits.processingTimeoutSeconds` (`RESIZE_SVG_RENDER_TIMEOUT`). The worker reads
    `retryable` on the error that fails the task, when it is a `ResizeError` — including one from
    a duplicate copy of the package (it checks the `isResizeError` brand, not the class); errors
    from other libraries are retried, whatever fields they carry. A `ResizeError` from
    `loadMedia`, `storage.download`, the source and SVG checks, the SVG render, `beforeSteps` or
    `appendPreviews` with `retryable: false` dead-letters the task at once. An
    error inside one variant (`variantSteps`, encoding, `storage.upload`) fails only that
    variant: it is logged, and the task fails with the retryable
    `RESIZE_WORKER_INCOMPLETE` (retried for the missing variants only, then dead-lettered after
    `maxAttempts`).
  - A dead row keeps the gate (`active`) until its `cooldownUntil` (`deadAt` +
    `coordination.cooldownMs`); then the next `add()` takes it over (see
    [Coordination](#coordination)).
  - Completed rows expire after 24 h and dead rows after ~30 days (the `expireAfterSeconds` in
    the model).
- **At-least-once delivery:** a task can run more than once. The worker skips previews that
  already exist, and the media store keeps one row per preview identity, so a repeat never
  duplicates them. A task completes only when every requested
  variant is stored. When an attempt is only partly successful, its previews are saved and the
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
  its storage ref and dimensions) and `encodeSig` (a signature of its format's encode settings and
  the pipeline `version`). The worker and `generate()` record them on every row from `0.3.0-rc.1`
  on, and `resizeMediaSchemaFragment` declares them. The read path does not check them yet. Rows
  written earlier have no `origin` or `encodeSig`: they are served for now, and a later release's
  freshness check will regenerate them, so plan the storage cost of rendering them again. Rows
  without an `identity` (written before 0.3.0) are never removed by `invalidate` or
  `replacePreviews`: delete their files yourself.
- **Removing previews:** `resizer.invalidate({ media, pipeline? })` removes this Resizer's stored
  previews of a media, of one pipeline or of all (only an omitted `pipeline` means all;
  `pipeline: null` or `''` matches nothing), in one media store write, and resolves with the
  storage refs of the rows it removed. Delete those objects yourself: the module never deletes
  files, and never queues. It loads the media fresh, picks this Resizer's rows that carry an
  `identity` (rows without `resizer` or `pipeline` count as `'default'`; the pipeline need not be
  registered, so a renamed pipeline's rows can be removed), and also drops them from the caller's
  `media.previews`, so a same-request `resolve()` does not serve them (when that array cannot be
  changed, it logs a warning and still resolves with the refs). It takes no gate: a task running
  for that media can store rows after it returns, and a row stored between its read and its write
  under a new identity stays. A media that is gone gives `[]`; a store failure rejects, and then
  nothing was removed. It needs `replacePreviews` on the media store (`RESIZE_MEDIA_REPLACE_MISSING`
  without it).

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
fails): fix the logged cause before you retry.

| `code` | When | `retryable` |
|---|---|---|
| `RESIZE_PIPELINE_UNKNOWN` | The pipeline (any name but `'default'`) is not registered on this Resizer; nothing is queued | `false` |
| `RESIZE_FORMAT_NOT_CONFIGURED` | A requested format (in the call, or from a `beforeEnqueue` tap) has no `encode.formats` entry; it is never queued | `false` |
| `RESIZE_ENQUEUE_NO_ORIGINAL` | The media has no `original.storageRef` | `false` |
| `RESIZE_ENQUEUE_NO_QUEUE` | The Resizer has no task queue (eager only) | `false` |
| `RESIZE_QUEUE_NOT_SERVED` | The Resizer's task queue does not serve the call's `queue`: a name it has no queue for (in a framework app, one that `queues` does not define; for `SqsTaskQueue`, one without a URL), or a queue on another backend (one Resizer cannot use two backends yet). Nothing is queued: it is reported before any gate lock or `add()` | `false` |
| `RESIZE_ENQUEUE_VARIANT_CONFLICT` | Different payloads share one preview identity, in the request (e.g. after a `beforeEnqueue` tap) or in the active task, so none of them can be confirmed | `false` |
| `RESIZE_TASK_IN_FLIGHT` | A task queue with `gatesByTask` (Mongo): a task of this Resizer, media, pipeline and queue is active, or a dead one is cooling down, and does not hold these variants | `true`: call again after it ends |
| `RESIZE_ENQUEUE_LOCK_CONTENDED` | A task queue without `gatesByTask` (SQS): the gate lock is held (a task queued, running or waiting for a retry, a dead task's cooldown, or the one-lease hold after an add that threw or was not confirmed); SQS cannot say which variants that task holds | `true`: call again after it ends |
| `RESIZE_ENQUEUE_LOCK_FAILED` | A task queue without `gatesByTask`: acquiring the gate lock threw (logged) | `true`, even when the lock store fails for good: fix the logged cause first |
| `RESIZE_ENQUEUE_QUEUE_FAILED` | `add()` threw (logged), e.g. an SQS send error; the task may still be stored. Beside a queue without `gatesByTask` the gate lock is then kept for one lease (at most `gateTtlMs`), so a `prewarm()` in that time reports `RESIZE_ENQUEUE_LOCK_CONTENDED` and the read path logs nothing | `true`: fix the logged cause first |
| `RESIZE_ENQUEUE_UNCONFIRMED` | `add()` resolved `unconfirmed`: the queue did not confirm the task (on Mongo a database error, a duplicate key on another unique index of your model, or an unregistered or outdated `ResizeTask` model, each logged; on SQS a send that returned no `MessageId`). Or `add()` resolved a value in none of the `TaskAddResult` shapes (a queue written for an older version), logged once | `true`, even for an unregistered or outdated model: fix the logged cause first; `false` for a value in none of the shapes |
| `RESIZE_ENQUEUE_CONFIRM_FAILED` | After an `in-flight` add, `findActive()` threw (logged), so what the active task holds is unknown | `true` |
| `RESIZE_ENQUEUE_INTERNAL_ERROR` | An unexpected error (e.g. a media without an id, `RESIZE_MEDIA_NO_ID`), a Resizer that could not start (a part that did not load, an invalid config), a task queue that cannot be used (the error `verify()` reports, e.g. `RESIZE_LOCKS_REQUIRED`), or an invalid timing of the call's `queue` (a name used only per call; every variant is `unconfirmed`); the message is the error's | `false` when the error is a `ResizeError` with `retryable: false`, or a `ResizeMediaError`, `ResizeConfigError` or `ResizeSetupError` (or a subclass); otherwise `true` |

## Development

`npm test` runs the `node:test` suite. Core tests construct `new Resizer({ … })` with fakes and
need no framework app. Framework-adapter tests install a fake app with `setAppInstance()`.
`src/importGraph.test.ts` fails if the main entry ever reaches framework code. Before a release,
run `npm run build` and `npm run smoke`.

## License

MIT
