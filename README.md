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
| SQS: `queue: { driver: 'sqs' }` or `SqsTaskQueue` (`…/drivers/sqs.js`) | `@aws-sdk/client-sqs` ≥ 3.572 |

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
import type { FrameworkResizeConfig } from '@adaptivestone/framework-module-resize/framework.js';
import { defaultFrameworkResizeConfig } from '@adaptivestone/framework-module-resize/config/resize.js';

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
export default {
  storage: { driver: 's3', bucketPublic: 'cdn', bucketPrivate: 'originals', publicBaseUrl: 'https://cdn.example.com' },
};
```

Options win over the config: `new FrameworkResizer({ storage: new S3Storage({ …, client }) })`
reuses your own S3 client, and `tasks: false` keeps a Resizer eager whatever the config says.

Add `...resizeMediaSchemaFragment` (from the main entry) to your media model's schema, then:

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

1. Set `queue: { driver: 'database' }` in the config (tasks wait in the `ResizeTask` model), or
   `{ driver: 'sqs', queueUrl }`.
2. Set `worker.enabled: true` in the config.
3. Create the indexes through your migration process.
4. Run `npm run cli ResizeWorker` as a separate process.

The scaffolded command is `import '../resizer.ts'` plus a re-export of the module's command, so the
worker has the same Resizers as the API. Keep that import, and run
`npx resize-scaffold --check` in CI to catch drift (`--check --eager` for an eager app). The model
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
const parts = mongoParts(mongoose.connection, { mediaModel: File }); // File spreads resizeMediaSchemaFragment

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
most custom queues), which takes one gate lock per media and pipeline it queues (see
[Coordination](#coordination)): without it `verify()` and the worker reject with
`RESIZE_LOCKS_REQUIRED`, and reads serve stored previews only (see [Drivers](#drivers)).
`MongoTaskQueue` keeps the gate in its own rows and uses no lock; `mongoParts` still returns a lock
store, for a Resizer that swaps in `SqsTaskQueue`. With the parts, create the indexes of both
models through your migration process (for example
`await mongoose.connection.models.ResizeTask.createIndexes()`, and the same for `ResizeLock`); the
module never creates them at runtime (`createResizeModels` sets `autoIndex: false`).

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
`logger` receives the worker loop's own messages, failed gate lock calls included; a logger that
throws never stops the loop. Framework hosts run `npm run cli ResizeWorker`, which serves the
Resizers that `src/resizer.ts` constructs.

## Package exports

| Import | Contents |
|---|---|
| `@adaptivestone/framework-module-resize` | `Resizer`, `getResizer`, `resetResizerForTests`, `runWorker`, the contracts (`ResizeStorage`, `MediaStore`, `LockStore`, `TaskQueue`), helpers (`formatPictureUrls`, `getSizeKey`, `parseSizeKey`, `isCatalogCovered`, `resizeMediaPaths`, `resizeMediaSchemaFragment`), errors, types |
| `…/config/resize.js` | The default core config (default export), `defaultFrameworkResizeConfig`, `defaultQueueOptions`, `defaultCoordination`, `defaultWorkerOptions` |
| `…/drivers/fs.js` | `LocalFsStorage` |
| `…/drivers/s3.js` | `S3Storage` |
| `…/drivers/mongo.js` | `mongoParts`, `MongoMediaStore`, `MongoLockStore`, `MongoTaskQueue`, `createResizeModels`, the schemas |
| `…/drivers/sqs.js` | `SqsTaskQueue` |
| `…/framework.js` | Framework adapter: `FrameworkResizer`, `FrameworkMediaStore`, `FrameworkLockStore`, `ResizeTaskModel`, `ResizeWorker`, `runResizeWorker`, `FrameworkResizeConfig` and its section types |
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
`RESIZE_CONFIG_COORDINATION_INVALID`, `RESIZE_CONFIG_GATE_TTL_BELOW_LEASE`). Call `verify()` at
boot so such a misconfiguration stops the deploy instead of degrading reads. (`FrameworkResizer`
validates the config file's `queue` section with the rest of the file, so there invalid timing is
a config error on first use; the file's `coordination` section goes to the core as it is, so an
invalid one degrades as above.) The next call retries what failed
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
and `new MongoTaskQueue({ model | getModel, timing | getTiming, logger })` take the models
directly (exactly one of `model` and `getModel`, otherwise `RESIZE_MONGO_MODEL_REQUIRED`), and
`createResizeModels(connection)` registers the package's two models. A model-shaped media object
needs `findById` and `findOneAndUpdate`. Previews and the backfilled dimensions are written with
`findOneAndUpdate`, one write per preview plus one for the backfill, so the media model's
`findOneAndUpdate` middleware runs for each; the document it receives has only `_id`, and is
`null` when the preview was already stored or the media is gone. `MongoMediaStore.verify()` fails
with `RESIZE_MONGO_MEDIA_MODEL_OUTDATED` when the media schema declares preview rows as
sub-documents without `identity` (a mixed or plain `previews` array passes),
`MongoLockStore.verify()` with `RESIZE_MONGO_LOCK_MODEL_OUTDATED` when a strict lock schema has no
`owner` field (for example a `ResizeLock` model registered on the connection before this
version), and `MongoTaskQueue.verify()` with `RESIZE_MONGO_MODEL_OUTDATED` when the `ResizeTask`
schema lacks a field the queue writes (`active` and `cooldownUntil` among them; it does not check
indexes). `MongoTaskQueue` sets `gatesByTask` and `claimFilters`: its rows are the gate (see
[Coordination](#coordination)), and a claim takes only tasks of the Resizers the worker serves. Its
`add()` counts a duplicate key as the gate only on the gate index; a duplicate key on another unique
index of your model is logged, and the add is `unconfirmed`.

**`SqsTaskQueue`**

| Option | | |
|---|---|---|
| `queueUrl` | required | The `'default'` queue |
| `queues` | optional | Other named queues: `{ bulk: 'https://sqs…/bulk' }` |
| `deadLetterQueueUrl` | optional | Dead tasks are sent here with their error, then deleted; without it they are logged and deleted |
| `timing` | optional | Queue timing (below); the lease is the message visibility timeout |
| `waitTimeSeconds` | `10` | Long poll per claim (0–20) |
| `region`, `endpoint`, `client` | optional | An existing `SQSClient`, or one built on first use |
| `logger` | `console` | A queue built from a framework config file gets the app logger |

Credentials come from the AWS provider chain. Retries and dead-lettering are the core's, the same
as for Mongo (attempts = `ApproximateReceiveCount`), and `onTaskDeadLettered` fires for SQS too. Use
it with any media and lock store: media and locks stay in your database. It has neither
`gatesByTask` nor `claimFilters`: its gate is a lock in the Resizer's lock store, so the Resizer
needs `locks`, and each message carries that lock's owner (`gateOwner`). Its timing is its own
`timing` option (the framework config's `queue` section passes its timing); the core validates it
when the Resizer starts, not when the queue is constructed (invalid timing makes `verify()` and the
worker reject; see `ready()` above). A redrive policy on the SQS queue is optional; if you keep
one, set its
`maxReceiveCount` above `maxAttempts`, so the module dead-letters a task first. SQS fences less
strictly than Mongo: it accepts a delete with an outdated receipt, so a task whose lease ran out
can report `completed` and still run again (the worker skips previews that exist), and a dead
task can reach the dead-letter queue twice.

The core takes one kind of lock: the gate lock of a task queue without `gatesByTask`, one per
Resizer, media and pipeline (see [Coordination](#coordination)). There are no per-identity locks.
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
- `LockStore`: `acquire(key, owner, ttlMs)` (`true` when the key was free or its lock had expired;
  `false` while a live lock holds it, even one with the same owner), `extend(key, owner, ttlMs)`
  (only the owner's live lock), `release(key, owner)` (only while `owner` holds it, expired or
  not), and optionally `verify()`, awaited at startup. Keep the owner with the lock, not in process
  memory: one process may release a lock that another took (a read takes the gate lock, a worker
  extends and releases it).
- `TaskQueue` — each method one atomic operation:
  - `add(task)` stores `{ resizer, queue, mediaId, pipeline, previews, gateOwner? }` and resolves
    with a `TaskAddResult`: `{ status: 'added', taskId }`; `{ status: 'in-flight', taskId? }` (a
    task of this Resizer, media and pipeline is active, so nothing was stored; `taskId` when the
    queue knows it); or `{ status: 'unconfirmed' }` (the write could not be confirmed). A value in
    none of these shapes (a queue written for an older version, e.g. one that resolves a task id)
    is never counted as queued: the Resizer logs it once, and `prewarm()` reports its variants
    with a non-retryable `RESIZE_ENQUEUE_UNCONFIRMED`.
  - Optionally `gatesByTask: true`: the queue itself keeps at most one active task per Resizer,
    media and pipeline, whatever variants either asks for, and `add()` reports `in-flight` while
    one exists. Such a queue must keep a task active from `add()` through its retries and
    give-backs until `complete()`, and keep a dead task active for the `cooldownMs` that `fail()`
    passes; the Resizer then takes no gate lock and needs no `locks`. Without the flag, `add()`
    stores every task it is given, and the core takes a gate lock instead.
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
    (`FailOptions`) is how long a queue with `gatesByTask` keeps the dead task as the gate.
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
  - Optionally `findActive({ resizer, mediaId, pipeline })`: the active (pending or processing)
    tasks of that Resizer, media and pipeline on any queue, each with the previews it covers; at
    most one on a queue with `gatesByTask`, and `[]` when there are none. The core reads it only
    after an `in-flight` add, so `prewarm()` can accept the variants the active task holds. Also
    optionally `servesQueue(queue)`, `getTiming()` and `verify()`.

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

Queue timing belongs to the **task queue** (`timing` on `MongoTaskQueue`,
`mongoParts` and `SqsTaskQueue`; `FrameworkResizer` reads them from the config file's `queue`
section). In a framework app, every Resizer on the database queue shares one task queue, and so
do Resizers whose config selects SQS with the same settings; config files
that share a queue must set the same timing (and SQS `waitTimeSeconds`, where unset counts as the
default 10), or first use, `verify()`
and worker start fail with `ResizeConfigError` `RESIZE_CONFIG_QUEUE_TIMING_CONFLICT`, naming both
files and the keys. A config file's timing is validated with the file, on first use. The core
validates a task queue's own `timing` when the Resizer starts: invalid timing makes `verify()` and
the worker reject, while reads serve stored previews and queue nothing and `prewarm()` reports it
(see `ready()` under [Drivers](#drivers)). How long locks last is not timing: it is the
Resizer's [coordination](#coordination). The timing defaults are `defaultQueueOptions` in
`…/config/resize.js`:

| Option | Default | Notes |
|---|---|---|
| `leaseMs` | `60000` | Set to at least ~2× the slowest encode. Above `600000`, raise `coordination.gateTtlMs` with it |
| `retryBackoffMs` | `{ base: 5000, max: 300000 }` | Retry delay |
| `maxAttempts` | `5` | Every lease counts, including reclaimed ones |
| `idlePollMs` | `1000` | Polling interval of an idle worker (a claim that waited counts toward it); each poll is one indexed query on Mongo. Claim errors back off from it up to 10× |
| `taskTimeoutMs` | `600000` | A longer task is failed |

Sharp process tuning is a worker option: `runWorker({ sharp: { concurrency, cache } })`. Keep
`concurrency × sharp.concurrency ≈ CPU cores`.

**Framework config file.** `src/config/resize.ts` spreads `defaultFrameworkResizeConfig` from
`…/config/resize.js` and adds `mediaModelName`, `storage` and `queue`. The framework merges
`resize.<NODE_ENV>.ts` over it (objects merge field by field, arrays are replaced); the module
does not merge again. Only `FrameworkResizer` reads the extra keys:
- `mediaModelName` (required): the host media model, used by `FrameworkMediaStore`.
- `storage`: `{ driver: 'local', rootDir, publicBaseUrl, privateRootDir? }` or `{ driver: 's3',
  bucketPublic, bucketPrivate?, publicBaseUrl?, region?, endpoint?, forcePathStyle? }`. Required
  unless the code passes `storage`. S3 is imported only when selected; credentials come from the
  AWS SDK's default chain. Switching the driver in an environment file keeps the other keys of
  the merged section, so set `publicBaseUrl` there too.
- `queue`: `{ driver: 'database' }` (tasks in the app's `ResizeTask` model; the default
  driver) or `{ driver: 'sqs', queueUrl, queues?, deadLetterQueueUrl?, waitTimeSeconds?,
  region?, endpoint? }`, plus any of the timing options above (the rest default). Missing or
  `false`: eager only.
- `coordination`: `{ gateTtlMs, cooldownMs }` for the Resizers that read this file
  (`defaultFrameworkResizeConfig` holds the defaults); see [Coordination](#coordination). Each file
  has its own: Resizers that share a task queue may set different values.
- `worker`: `{ enabled: false, sharpConcurrency: 1, sharpCache: false }`, used by the
  `ResizeWorker` command. `enabled` allows the command to run. The worker process reads `worker`
  from `resize.ts`, whatever files its Resizers read;
  `npm run cli ResizeWorker -- --config=<name>` reads it from another file (needed when the app
  has no `resize.ts`).

A second Resizer can read its own file with
`new FrameworkResizer({ name: 'listings', configName: 'resizeListings' })`.

Without the framework, buckets, URLs and queue URLs are driver options. The 0.2.x keys
`webpAvifOnly`, `encode.quality`, `encode.effort`, `encode.mozjpeg`, `encode.chromaSubsampling`
and `encode.flattenBackground` fail with `RESIZE_CONFIG_REMOVED_KEY`, and so do `queue` and
`worker` in a core config, `worker.concurrency` in a framework config file (use the top-level
`concurrency`), and `lockTtlMs` in a task queue's `timing` or a config file's `queue` section (use
[coordination](#coordination): `failed` → `cooldownMs`, `dispatch` → `gateTtlMs`, drop `worker`).

### Coordination

A Resizer with a task queue keeps one **gate** per Resizer, media and pipeline: at most one of
their tasks is active at a time, whether it is queued, running, waiting for a retry, or cooling
down after a dead-letter. While the gate is held, a read that finds variants missing queues
nothing, whatever variants the active task covers: a new size for that media waits for the active
task, and the next read after the task ends queues it. So 1000 concurrent reads of a cold media
create one task.

- On `MongoTaskQueue` (`gatesByTask`) the task row is the gate. Its `active` field is `true` from
  `add()` until the task completes, through its retries, and a unique index on
  `{ resizer: 1, fileId: 1, pipeline: 1 }` with `partialFilterExpression: { active: true }` lets one
  row per gate be active. A dead row keeps the gate until its `cooldownUntil` (`deadAt` +
  `cooldownMs`); the next `add()` after that retires it (`active: false`, its `error` kept) and
  inserts a new row. No lock is taken.
- On a task queue without `gatesByTask` (`SqsTaskQueue`, most custom queues) the gate is one lock in
  the Resizer's `LockStore`, `resize_gate:<resizer>:<mediaId>:<pipeline>`. The core takes it for
  `gateTtlMs` with a fresh random owner when it queues a task, and the owner travels in the task as
  `gateOwner`. The worker extends the lock: to one lease from now when the task starts and on every
  heartbeat, to the retry time plus one lease after a failed attempt, and to `cooldownMs` from now
  after a dead-letter; it releases the lock when the task completes. When the queue does not store
  the task, the core releases the lock at once.

There are no per-identity locks. The lease keeps a task with one worker at a time, its token fences
every write, and `appendPreviews` keeps one row per preview identity when an expired lease lets two
workers render the same variant.

| Option | Default | Notes |
|---|---|---|
| `gateTtlMs` | `600000` | How long a new gate lock holds its media and pipeline before a worker extends it (a task queue without `gatesByTask`; `MongoTaskQueue` takes no lock, but the value is still checked). Must be at least the task queue's `leaseMs` |
| `cooldownMs` | `600000` | After a task is dead-lettered, no new task for that media and pipeline is queued for this long |

Pass it as `new Resizer({ coordination: { gateTtlMs, cooldownMs } })` (or a function returning it)
or `new FrameworkResizer({ coordination })`, or set the `coordination` section of a framework config
file. Missing values take `defaultCoordination` from `…/config/resize.js` (the types are
`CoordinationOptions`); an eager-only Resizer never reads it. Only the core validates it, when the
Resizer sets up its task queue: a section that is not an object, or a value that is not a positive
safe integer (ms), is `ResizeConfigError` `RESIZE_CONFIG_COORDINATION_INVALID` (the message names
the key, or the value when the whole section is wrong), and a `gateTtlMs` below the task queue's
`leaseMs` is `RESIZE_CONFIG_GATE_TTL_BELOW_LEASE`. Either degrades like a task queue that cannot
be used (see `ready()` under [Drivers](#drivers)), in a config file too, so a host whose `leaseMs`
is above `600000` must raise `gateTtlMs` with it. Each dead-letter gets the `cooldownMs` of the
task's own Resizer.

## Operations

- **Task states (Mongo):** `pending → processing → completed`. A row's `active` is `true` from
  `add()` until the task completes: the row is the gate of its Resizer, media and pipeline (see
  [Coordination](#coordination)). Rows written before the gate have no `active` and never block a
  new task.
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
  one active row per Resizer, media and pipeline:

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
); // a duplicate-key error (11000) means another task for this media and pipeline is active
```

- **Your app's responsibilities:** deleting media and their storage objects, access checks, the
  response shape, migrating legacy data, and domain image analysis such as face blurring (in
  pipeline steps).

## Development

`npm test` runs the `node:test` suite. Core tests construct `new Resizer({ … })` with fakes and
need no framework app. Framework-adapter tests install a fake app with `setAppInstance()`.
`src/importGraph.test.ts` fails if the main entry ever reaches framework code. Before a release,
run `npm run build` and `npm run smoke`.

## License

MIT
