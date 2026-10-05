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
| **Pre-warm**: fast upload, previews made in the background | `prewarm()` | + a transport and a worker |
| **Lazy**: previews only for sizes readers request | `resolve()` with a transport | + a transport and a worker |

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
| `…/framework.js` (framework apps) | `@adaptivestone/framework` `mongoose` (already in a framework app) |
| `…/drivers/mongo.js` | `mongoose` |
| `S3Storage` (`…/drivers/s3.js`) | `@aws-sdk/client-s3` `@aws-sdk/s3-request-presigner` |
| `SqsTransport` (`…/drivers/sqs.js`) | `@aws-sdk/client-sqs` `sqs-consumer` |

A missing optional peer fails at your own import line, not at the first upload.

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
} satisfies FrameworkResizeConfig;
```

```ts
// src/resizer.ts
import { createFrameworkResizer } from '@adaptivestone/framework-module-resize/framework.js';
import { LocalFsStorage } from '@adaptivestone/framework-module-resize/drivers/fs.js';

export const resizer = createFrameworkResizer({
  storage: new LocalFsStorage({ rootDir: './var/media', publicBaseUrl: '/media' }),
});
```

Import `src/resizer.ts` wherever you need it; a normal static import is fine, because nothing is
read from the framework until first use. To fail at boot on a bad config, call
`await resizer.verify()` after `await server.init()`.

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

1. Pass `transport: createFrameworkMongoTransport()` to `createFrameworkResizer`.
2. Set `worker.enabled: true` in the config.
3. Create the indexes through your migration process.
4. Run `npm run cli ResizeWorker` as a separate process.

The scaffolded command is `import '../resizer.ts'` plus a re-export of the module's command, so the
worker has the same Resizers as the API. Keep that import, and run
`npx resize-scaffold --check` in CI to catch drift.

## Without the framework

The main entry imports no framework code, and the shipped drivers need no framework either. With
MongoDB, a plain Node app writes no driver code:

```ts
import mongoose from 'mongoose';
import { Resizer, runWorker } from '@adaptivestone/framework-module-resize';
import defaultResizeConfig from '@adaptivestone/framework-module-resize/config/resize.js';
import { LocalFsStorage } from '@adaptivestone/framework-module-resize/drivers/fs.js';
import {
  createResizeModels,
  MongoLockStore,
  MongoMediaStore,
  MongoTransport,
} from '@adaptivestone/framework-module-resize/drivers/mongo.js';

// ResizeTask (the queue) and ResizeLock, with the package's schemas and indexes
const { ResizeTask, ResizeLock } = createResizeModels(mongoose.connection);

export const resizer = new Resizer({
  config: { ...defaultResizeConfig, formats: ['webp', 'avif'] }, // optional; image settings only
  storage: new LocalFsStorage({ rootDir: './var/media', publicBaseUrl: '/media' }),
  mediaStore: new MongoMediaStore({ model: File }), // File spreads resizeMediaSchemaFragment
  transport: new MongoTransport({ // queued workflows only
    model: ResizeTask,
    locks: new MongoLockStore({ model: ResizeLock }),
  }),
});

// Worker process; abort the signal on SIGTERM to stop it
await runWorker({ signal, queue: 'default', sharp: { concurrency: 1, cache: false } });
```

Create the indexes through your migration process (for example `ResizeTask.createIndexes()`);
the module never creates them at runtime (`createResizeModels` sets `autoIndex: false`).

## Package exports

| Import | Contents |
|---|---|
| `@adaptivestone/framework-module-resize` | `Resizer`, `getResizer`, `listResizers`, `runWorker`, the driver contracts (`ResizeStorage`, `MediaStore`, `QueueTransport`, `LockStore`), helpers (`formatPictureUrls`, `isCatalogCovered`, `resizeMediaPaths`, `resizeMediaSchemaFragment`), errors, types |
| `…/config/resize.js` | Default config |
| `…/drivers/fs.js` | `LocalFsStorage` |
| `…/drivers/s3.js` | `S3Storage` |
| `…/drivers/mongo.js` | `MongoTransport`, `MongoMediaStore`, `MongoLockStore`, `createResizeModels`, the schemas |
| `…/drivers/sqs.js` | `SqsTransport` |
| `…/framework.js` | Framework adapter: `createFrameworkResizer`, `createFrameworkMongoTransport`, `FrameworkMediaStore`, `FrameworkLockStore`, `ResizeTaskModel`, `ResizeWorker`, `runResizeWorker`, `appLogger`, `appEvents`, `getResizeConfig`, `FrameworkResizeConfig` |

## Drivers

A `Resizer` takes one driver per seam: `storage` (required), `mediaStore` (required) and
`transport` (queued workflows). The transport owns its `locks` (a `LockStore`), because locks
exist only for queued work. Drivers receive
no `app` argument; each one uses its own clients. `createFrameworkResizer` adds
`FrameworkMediaStore`, and `createFrameworkMongoTransport()` adds `FrameworkLockStore`. Those are
thin wrappers: the Mongo media store with the model taken from the app, and the framework's own
`Lock` model.

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
bucket policy, not a per-object ACL.

**`MongoTransport`**, or `createFrameworkMongoTransport()` in framework apps (it uses the
scaffolded model, the app logger and the config's `queue` timing):

| Option | Default | |
|---|---|---|
| `model` / `getModel` | one required | The `ResizeTask` model, or a getter called on each use |
| `locks` | required | A `LockStore`: `MongoLockStore`, or `FrameworkLockStore` in framework apps |
| `lockTtlMs` | `{ dispatch: 60000, worker: 60000 }` | `worker` must be ≤ `leaseMs` |
| `leaseMs` | `60000` | Heartbeat renews the lease at `leaseMs / 2` |
| `retryBackoffMs` | `{ base: 5000, max: 300000 }` | Delay before a failed task is retried |
| `maxAttempts` | `5` | Attempts before the task is `dead` |
| `idlePollMs` | `1000` | Sleep after an empty poll |
| `taskTimeoutMs` | `600000` | A longer task is failed |
| `logger` | `console` | |

**`SqsTransport`**

| Option | | |
|---|---|---|
| `queueUrl` | required | The `'default'` queue |
| `locks` | required | A `LockStore` (SQS has no lock primitive) |
| `lockTtlMs` | optional | Default `{ dispatch: 60000, worker: 60000 }` |
| `queues` | optional | Other named queues: `{ bulk: 'https://sqs…/bulk' }` |
| `region`, `endpoint`, `client` | optional | An existing `SQSClient`, or one built on first use |
| `visibilityTimeout`, `heartbeatInterval` | optional | Seconds; the heartbeat extends visibility during long tasks |
| `logger` | `console` | Framework apps: `appLogger` |

Credentials come from the AWS provider chain. Dead-lettering is native SQS: set the redrive
policy's `maxReceiveCount` to `queue.maxAttempts`. `onTaskDeadLettered` does not fire for SQS.

Locks only prevent duplicate work; correctness never depends on them. `release(key)` deletes by
key, as the framework `Lock` model does: if a lock expired and another holder took it over, the
first holder's late release removes it, and at worst a variant is generated twice.

**`MongoMediaStore`**, **`MongoLockStore`**: `{ model }`, or `{ getModel }` when the model is
registered later. The media model's schema spreads `resizeMediaSchemaFragment`; the lock model
comes from `createResizeModels(connection)`.

**Custom drivers** extend the exported abstract class, or are any object of the same shape:

- `ResizeStorage`: `upload`, `download`, `publicUrl` (pure, no I/O), and optionally `signedUrl`
  and `canServeOriginalPublicly`.
  - The ref you return from `upload()` is opaque to the module and comes back unchanged.
  - `upload()` may receive a `namespace` hint (from `uploadOriginal`) or a `parentRef` (the
    original's ref, for previews). Never both.
- `MediaStore`: `load`, `appendPreviews`, and an optional `verify()` that the worker awaits once
  at startup. Throw there to stop the worker before it leases anything.
- `LockStore`: `acquire(key, ttlMs)` (resolves `true` when taken) and `release(key)`.
- `QueueTransport`: `locks` (a `LockStore`, required) and `enqueue(task)` with
  `{ resizer, queue, mediaId, pipeline, previews }`; store `resizer` and `queue`.
  - `startWorker(handle, { signal, queue, onEvent })` consumes only that queue and reports
    `onEvent('completed' | 'failed' | 'deadLettered', task, error?)`.
  - Optionally, `verify()` fails at boot when the transport cannot work, and `findActive(task)`
    lets `prewarm()` confirm work that another request
    queued; `getLockTtlMs()` returns lock TTLs (default 60 s each); `servesQueue(queue)` tells
    the worker which queues it can consume (default: all).

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
| `animated` | `false` | `true` keeps GIF/WebP frames |
| `encode.formats` | jpeg `{ quality: 80, mozjpeg: true, chromaSubsampling: '4:2:0' }`, webp `{ quality: 82, effort: 4 }`, avif `{ quality: 64, effort: 4 }` | Passed to `sharp.toFormat(id, options)`; `{}` keeps Sharp's defaults |
| `encode.sharpen` | `{ cover: true, fit: false }` | Mild sharpening after downscaling, or `false` |
| `encode.flatten` | `{ formats: ['jpeg'], background: '#ffffff' }` | Formats whose transparency is flattened |
| `limits.inputPixels` | `268402689` | Sharp decoder limit |
| `limits.sourcePixels` | `50000000` | Rejected before decoding |
| `limits.resultDimension` | `5000` | Largest output side for cropped sizes |
| `limits.animationFrames` | `64` | Frame limit for animated input |
| `limits.processingTimeoutSeconds` | `30` | Timeout per Sharp operation |
| `concurrency` | `4` | Variants processed in parallel per task or `generate()` call |

Queue timing and lock TTLs are **transport options** (`MongoTransport`; `SqsTransport` takes
`lockTtlMs`), validated by the transport: a plain `MongoTransport` and `SqsTransport` when
created, `createFrameworkMongoTransport()` on first use or `verify()`. Their defaults are `defaultQueueOptions`
in `…/config/resize.js`:

| Option | Default | Notes |
|---|---|---|
| `lockTtlMs` | `{ dispatch: 60000, worker: 60000 }` | `worker` must be ≤ `leaseMs` |
| `leaseMs` | `60000` | Set to at least ~2× the slowest encode |
| `retryBackoffMs` | `{ base: 5000, max: 300000 }` | Retry delay |
| `maxAttempts` | `5` | Every lease counts, including reclaimed ones |
| `idlePollMs` | `1000` | Sleep after an empty poll |
| `taskTimeoutMs` | `600000` | A longer task is failed |

Sharp process tuning is a worker option: `runWorker({ sharp: { concurrency, cache } })`. Keep
`concurrency × sharp.concurrency ≈ CPU cores`.

**Framework config file.** `src/config/resize.ts` spreads `defaultFrameworkResizeConfig` from
`…/config/resize.js` and adds `mediaModelName`. The framework merges `resize.<NODE_ENV>.ts` over
it (objects merge field by field, arrays are replaced); the module does not merge again. Only the
adapter reads the extra keys:
- `mediaModelName` (required): the host media model, used by `FrameworkMediaStore`.
- `queue`: the transport options above, used by `createFrameworkMongoTransport()`.
- `worker`: `{ enabled: false, sharpConcurrency: 1, sharpCache: false }`, used by the
  `ResizeWorker` command. `enabled` allows the command to run.

`queue` and `worker` may be omitted (the defaults apply), but a section that is present must be
complete. A second Resizer can read its own file with
`createFrameworkResizer({ configName: 'resizeListings', … })`.

Buckets, URLs and queue URLs are not config; they are driver options. The 0.2.x keys
`webpAvifOnly`, `encode.quality`, `encode.effort`, `encode.mozjpeg`, `encode.chromaSubsampling`
and `encode.flattenBackground` fail with `RESIZE_CONFIG_REMOVED_KEY`, and so do `queue` and
`worker` in a core config.

## Operations

- **Task states (Mongo):** `pending → processing → completed`.
  - A failed attempt returns to `pending` with backoff.
  - After `maxAttempts` the task is `dead`, and the lease never reclaims it.
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
