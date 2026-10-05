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
switch later without migrating data. `sharp` never runs on the read path.

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
storage, the task queue, the database (`FrameworkDatabase`) and the app logger and events. Import
`src/resizer.ts` wherever you need it; a normal static import is fine. To fail at boot on a bad
config, call `await resizer.verify()` after `await server.init()`. Switch to S3 per environment
in `resize.production.ts`:

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
import { mongoDatabase } from '@adaptivestone/framework-module-resize/drivers/mongo.js';

// Media, locks and the task queue, with the package's ResizeTask / ResizeLock models
const db = mongoDatabase(mongoose.connection, { mediaModel: File }); // File spreads resizeMediaSchemaFragment

export const resizer = new Resizer({
  config: { ...defaultResizeConfig, formats: ['webp', 'avif'] }, // optional; image settings only
  storage: new LocalFsStorage({ rootDir: './var/media', publicBaseUrl: '/media' }),
  db,
  tasks: db.tasks, // queued workflows only; or new SqsTaskQueue({ queueUrl })
});

// Worker process; abort the signal on SIGTERM to stop it
await runWorker({ signal, queue: 'default', sharp: { concurrency: 1, cache: false } });
```

Create the indexes of both models through your migration process (for example
`await mongoose.connection.models.ResizeTask.createIndexes()`, and the same for `ResizeLock`); the
module never creates them at runtime (`createResizeModels` sets `autoIndex: false`).

## Package exports

| Import | Contents |
|---|---|
| `@adaptivestone/framework-module-resize` | `Resizer`, `getResizer`, `listResizers`, `runWorker`, `consumeQueue`, the contracts (`ResizeStorage`, `ResizeDatabase`, `TaskQueue`), helpers (`formatPictureUrls`, `isCatalogCovered`, `resizeMediaPaths`, `resizeMediaSchemaFragment`), errors, types |
| `…/config/resize.js` | Default config |
| `…/drivers/fs.js` | `LocalFsStorage` |
| `…/drivers/s3.js` | `S3Storage` |
| `…/drivers/mongo.js` | `mongoDatabase`, `MongoDatabase`, `MongoTaskQueue`, `createResizeModels`, the schemas |
| `…/drivers/sqs.js` | `SqsTaskQueue` |
| `…/framework.js` | Framework adapter: `FrameworkResizer`, `FrameworkDatabase`, `ResizeTaskModel`, `ResizeWorker`, `runResizeWorker`, `appLogger`, `appEvents`, `getApp`, `getResizeConfig`, `FrameworkResizeConfig` and its section types |
| `…/framework/ResizeTaskModel.js` | `ResizeTaskModel` as the default export, for the scaffolded model shim |

## Drivers

A `Resizer` takes three parts:
- `storage` (required, a `ResizeStorage`): files;
- `db` (required, a `ResizeDatabase`): media documents and locks;
- `tasks` (queued workflows, a `TaskQueue`): where tasks wait — the database's own `db.tasks`, or
  an `SqsTaskQueue`.

The core owns the queue logic (the worker loop, lease heartbeat, task timeout, retry with backoff,
dead-lettering, de-duplication keys and events), so every queue behaves the same; adapters only
implement atomic operations. Drivers receive no `app` argument; each one uses its own clients.
`FrameworkResizer` builds `FrameworkDatabase`: the app's media model, the framework's own
`Lock` model, and the scaffolded `ResizeTask` model as its queue. Any part may also be a function
(sync or async), called once on first use: `new Resizer({ storage: async () => …, db, tasks })`.
`await resizer.ready()` loads them; the Resizer's own methods and the worker do it for you. When
one part fails to load, the next call retries only that part.

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

**`mongoDatabase(connection, { mediaModel, timing?, logger? })`** builds a `MongoDatabase` with the
package's `ResizeTask` and `ResizeLock` models on that connection (registered with `autoIndex` off:
create their indexes through your migration process). For other setups, `new MongoDatabase({
mediaModel | getMediaModel, lockModel | getLockModel, tasks })` and `new MongoTaskQueue({ model |
getModel, timing | getTiming, logger })` take the models directly.

**`SqsTaskQueue`**

| Option | | |
|---|---|---|
| `queueUrl` | required | The `'default'` queue |
| `queues` | optional | Other named queues: `{ bulk: 'https://sqs…/bulk' }` |
| `deadLetterQueueUrl` | optional | Dead tasks are sent here with their error, then deleted; without it they are logged and deleted |
| `timing` | optional | Queue timing (below); the lease is the message visibility timeout |
| `waitTimeSeconds` | `10` | Long poll per claim (0–20) |
| `region`, `endpoint`, `client` | optional | An existing `SQSClient`, or one built on first use |
| `logger` | `console` | Framework apps: `appLogger` |

Credentials come from the AWS provider chain. Retries and dead-lettering are the core's, the same
as for Mongo (attempts = `ApproximateReceiveCount`), and `onTaskDeadLettered` fires for SQS too. Use
it with any `db`: media and locks stay in the database. Its timing is its own `timing` option (the
framework config's `queue` section passes its timing). A redrive policy on the SQS queue is
optional; if you keep one, set its `maxReceiveCount` above `maxAttempts`, so the module
dead-letters a task first. SQS fences less strictly than Mongo: it accepts a delete with an
outdated receipt, so a task whose lease ran out can report `completed` and still run again (the
worker skips previews that exist), and a dead task can reach the dead-letter queue twice.

Locks only prevent duplicate work; correctness never depends on them. `releaseLock(key)` deletes by
key, as the framework `Lock` model does: if a lock expired and another holder took it over, the
first holder's late release removes it, and at worst a variant is generated twice.

**Custom drivers** extend the exported abstract class, or are any object of the same shape:

- `ResizeStorage`: `upload`, `download`, `publicUrl` (pure, no I/O), and optionally `signedUrl`
  and `canServeOriginalPublicly`.
  - The ref you return from `upload()` is opaque to the module and comes back unchanged.
  - `upload()` may receive a `namespace` hint (from `uploadOriginal`) or a `parentRef` (the
    original's ref, for previews). Never both.
- `ResizeDatabase`: `loadMedia(id)`, `appendPreviews(id, previews, dims?)`, `acquireLock(key,
  ttlMs)` (resolves `true` when taken), `releaseLock(key)`; optionally `tasks` (its own queue) and
  `verify()`, awaited at startup — throw there to stop the worker before it claims anything.
- `TaskQueue` — each method one atomic operation:
  - `add(task)` stores `{ resizer, queue, mediaId, pipeline, previews, requestKey }`; an active task
    with the same `requestKey` may be returned instead.
  - `claim(queue, leaseMs, signal?)` takes the oldest due task (a waiting one whose retry time has
    passed, or one whose lease expired), increments `attempts` and returns a fencing `token`. It is
    how a worker receives tasks: it may return `null` at once (the core polls every `idlePollMs`)
    or wait for a task first (long poll, LISTEN/NOTIFY, a change stream). A waiting claim returns
    once `signal` aborts, claims only when called (a prefetched task's lease would run out), and
    treats a notification as a hint, since only one of the woken workers' claims wins.
  - `renew(task, leaseMs)`, `complete(task)`, `fail(task, { retryAt } | 'dead', error)` act only
    while the token still holds (`false` = lease lost).
  - Optionally `release(task)`: give a claimed task back unprocessed (`false` = lease lost). It
    becomes claimable at once, and the delivery should not count as an attempt; a backend that
    cannot take a delivery back may still count it (`MongoTaskQueue` takes the attempt back;
    `SqsTaskQueue` cannot, since SQS counts receives). The worker calls it at shutdown for a task
    it stopped, with no `onTaskFailed` / `onTaskDeadLettered` event and no backoff; a terminal
    media error (`RESIZE_NO_ORIGINAL`, `RESIZE_SOURCE_METADATA_MISSING`,
    `RESIZE_SOURCE_TOO_LARGE`) is still dead-lettered with its event. Without `release`, the core
    retries the task at once through `fail`, which counts.
  - Optionally `findActive({ resizer, mediaId, pipeline })` (lets `prewarm()` confirm work queued by
    another request), `servesQueue(queue)`, `getTiming()` and `verify()`.

## Config reference

The Resizer's config holds image settings only. `new Resizer({ config })` defaults to
`…/config/resize.js`; spread it to change keys. A config object is validated when the Resizer is
created; a config function (the framework adapter passes one) on first use or `verify()`.

| Key | Default | Notes |
|---|---|---|
| `formats` | `['jpeg', 'webp', 'avif']` | Generated formats; each needs an `encode.formats` entry |
| `upload.maxBytes` | `26214400` (25 MiB) | Largest accepted original |
| `upload.formats` | `['jpeg', 'png', 'webp', 'avif', 'gif', 'svg']` | Accepted originals, detected from the bytes |
| `maxSize` | `{ width: 2000, height: 1200 }` | Box for `fit` |
| `animated` | `false` | `true`: WebP and GIF previews of an animated original keep its frames, for a pipeline without `variantSteps`; other formats, pipelines with variant steps, and animations with an EXIF orientation get the first frame. `actualWidth`/`actualHeight` are one frame's size |
| `encode.formats` | jpeg `{ quality: 80, mozjpeg: true, chromaSubsampling: '4:2:0' }`, webp `{ quality: 82, effort: 4 }`, avif `{ quality: 64, effort: 4 }` | Passed to `sharp.toFormat(id, options)`; `{}` keeps Sharp's defaults |
| `encode.sharpen` | `{ cover: true, fit: false }` | Mild sharpening after downscaling, or `false` |
| `encode.flatten` | `{ formats: ['jpeg'], background: '#ffffff' }` | Formats whose transparency is flattened |
| `limits.inputPixels` | `268402689` | Sharp decoder limit |
| `limits.sourcePixels` | `50000000` | Largest frame, rejected before decoding |
| `limits.resultDimension` | `5000` | Largest output side for width/height sizes; when the side derived from the aspect ratio of a width-only or height-only size would exceed it, the preview is cropped to it |
| `limits.animationFrames` | `64` | Frame limit for animated input; an animation is also shortened to the frames that fit `sourcePixels` and `inputPixels` |
| `limits.processingTimeoutSeconds` | `30` | Timeout per Sharp operation |
| `concurrency` | `4` | Variants processed in parallel per task or `generate()` call |

Queue timing and lock TTLs belong to the **task queue** (`timing` on `MongoTaskQueue`,
`mongoDatabase` and `SqsTaskQueue`; `FrameworkResizer` reads them from the config file's `queue`
section). The core validates them on first use or in `verify()`. Their defaults are
`defaultQueueOptions` in `…/config/resize.js`:

| Option | Default | Notes |
|---|---|---|
| `lockTtlMs` | `{ dispatch: 60000, worker: 60000 }` | `worker` must be ≤ `leaseMs` |
| `leaseMs` | `60000` | Set to at least ~2× the slowest encode |
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
- `mediaModelName` (required): the host media model, used by `FrameworkDatabase`.
- `storage`: `{ driver: 'local', rootDir, publicBaseUrl, privateRootDir? }` or `{ driver: 's3',
  bucketPublic, bucketPrivate?, publicBaseUrl?, region?, endpoint?, forcePathStyle? }`. Required
  unless the code passes `storage`. S3 is imported only when selected; credentials come from the
  AWS SDK's default chain. Switching the driver in an environment file keeps the other keys of
  the merged section, so set `publicBaseUrl` there too.
- `queue`: `{ driver: 'database' }` (the database's own queue: the `ResizeTask` model; the
  default driver) or `{ driver: 'sqs', queueUrl, queues?, deadLetterQueueUrl?, waitTimeSeconds?,
  region?, endpoint? }`, plus any of the timing options above (the rest default). Missing or
  `false`: eager only.
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
`worker` in a core config and `worker.concurrency` in a framework config file (use the top-level
`concurrency`).

## Operations

- **Task states (Mongo):** `pending → processing → completed`.
  - A failed attempt returns to `pending` with backoff.
  - After `maxAttempts` the task is `dead`, and the lease never reclaims it. A task is `dead` at
    once when no retry can help: the media has no original (`RESIZE_NO_ORIGINAL`), or the source
    has no dimensions or exceeds the pixel limits (`RESIZE_SOURCE_METADATA_MISSING`,
    `RESIZE_SOURCE_TOO_LARGE`).
  - Completed rows expire after 24 h and dead rows after ~30 days (the `expireAfterSeconds` in
    the model).
- **At-least-once delivery:** a task can run more than once. The worker skips previews that
  already exist, so a repeat never duplicates them. A task completes only when every requested
  variant is stored. When an attempt is only partly successful, its previews are saved and the
  next attempt makes only the missing ones.
- **Retrying a dead task:** after fixing the cause, call `prewarm()` for that media. To replay the
  row itself, reset it only when no active row has the same request. The partial unique index
  allows one active copy:

```ts
const active = await ResizeTask.findOne({
  fileId: row.fileId,
  pipeline: row.pipeline,
  requestKey: row.requestKey,
  status: { $in: ['pending', 'processing'] },
});
if (!active) {
  await ResizeTask.updateOne(
    { _id: row._id, status: 'dead' },
    { $set: { status: 'pending', attempts: 0, leaseExpiresAt: null } },
  ); // a duplicate-key error (11000) means another operator re-queued it first
}
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
