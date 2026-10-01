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
| **Pre-warm**: fast upload, previews made in the background | `prewarm()` / `enqueueRequired()` | + a transport and a worker |
| **Lazy**: previews only for sizes readers request | `resolve()` with a transport | + a transport and a worker |

All three write the same `previews[]` and read URLs with `resolve()`, so you can mix them or
switch later without migrating data. `sharp` never runs on the read path.

## Install

```bash
npm i @adaptivestone/framework-module-resize
```

Requires Node `>=24`. `@adaptivestone/framework` and `mongoose` are required peers. The AWS SDKs
are optional peers; install them only for the driver you import:

| You use | Also install |
|---|---|
| `S3Storage` (`…/storage/s3.js`) | `@aws-sdk/client-s3` `@aws-sdk/s3-request-presigner` |
| `SqsTransport` (`…/transports/sqs.js`) | `@aws-sdk/client-sqs` `sqs-consumer` |

A missing optional peer fails at your own import line, not at the first upload.

## Quick start (framework, eager)

```bash
npx resize-scaffold --eager   # src/resizer.ts + src/config/resize.ts
```

```ts
// src/config/resize.ts
import type { FrameworkResizeConfig } from '@adaptivestone/framework-module-resize/framework.js';
import defaultResizeConfig from '@adaptivestone/framework-module-resize/config/resize.js';

export default { ...defaultResizeConfig, mediaModelName: 'File' } satisfies FrameworkResizeConfig;
```

```ts
// src/resizer.ts
import { createFrameworkResizer } from '@adaptivestone/framework-module-resize/framework.js';
import { LocalFsStorage } from '@adaptivestone/framework-module-resize/storage/fs.js';

export const resizer = createFrameworkResizer({
  storage: new LocalFsStorage({ rootDir: './var/media', publicBaseUrl: '/media' }),
});
```

```ts
// src/server.ts: create the Resizer after init(); a static import would run too early
await server.init();
await import('./resizer.ts');
await server.startServer();
```

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

The scaffolded command loads `src/resizer.ts` before the worker starts. Keep that import, and run
`npx resize-scaffold --check` in CI to catch drift.

## Without the framework

The main entry imports no framework code. Create every part yourself:

```ts
import { Resizer, runWorker } from '@adaptivestone/framework-module-resize';
import defaultResizeConfig from '@adaptivestone/framework-module-resize/config/resize.js';
import { MongoTransport } from '@adaptivestone/framework-module-resize/transports/mongo.js';

export const resizer = new Resizer({
  config: { ...defaultResizeConfig, formats: ['webp', 'avif'] },
  logger,       // default console
  storage,      // a shipped or custom ResizeStorage
  mediaStore,   // { load(id), appendPreviews(id, previews, dims?) } over your database
  transport: new MongoTransport({ model: ResizeTask, logger }), // queued workflows only
  lockProvider, // { acquire(key, ttlMs), release(key) }; required with a transport
});

// Worker process; abort the signal on SIGTERM to stop it
await runWorker({ signal, queue: 'default', sharp: { concurrency: 1, cache: false } });
```

`ResizeTask` is your own Mongoose model. It needs the fields and indexes declared in
`src/models/ResizeTask.ts`, including the `{ queue, status, createdAt }` lease index and the
partial unique index on active requests.

## Package exports

| Import | Contents |
|---|---|
| `@adaptivestone/framework-module-resize` | `Resizer`, `getResizer`, `listResizers`, `runWorker`, helpers (`formatPictureUrls`, `isCatalogCovered`, `resizeMediaPaths`, `resizeMediaSchemaFragment`), errors, contract types |
| `…/framework.js` | Framework adapter: `createFrameworkResizer`, `createFrameworkMongoTransport`, `appLogger`, `getResizeConfig`, `runResizeWorker`, `FrameworkResizeConfig` |
| `…/config/resize.js` | Default config |
| `…/storage/fs.js`, `…/storage/s3.js` | `LocalFsStorage`, `S3Storage` |
| `…/transports/mongo.js`, `…/transports/sqs.js` | `MongoTransport`, `SqsTransport` |
| `…/mediaStore/framework.js`, `…/locks/framework.js` | `FrameworkMediaStore`, `FrameworkLockProvider` |
| `…/models/ResizeTask.js`, `…/commands/ResizeWorker.js` | Framework model and CLI command (the scaffold extends them) |

## Drivers

A `Resizer` takes one driver per seam: `storage` (required), `mediaStore` (required),
`transport` (queued workflows), and `lockProvider` (required with a transport). Drivers receive
no `app` argument; each one uses its own clients. `createFrameworkResizer` adds the media store
and lock provider for you.

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
| `queues` | optional | Other named queues: `{ bulk: 'https://sqs…/bulk' }` |
| `region`, `endpoint`, `client` | optional | An existing `SQSClient`, or one built on first use |
| `visibilityTimeout`, `heartbeatInterval` | optional | Seconds; the heartbeat extends visibility during long tasks |
| `logger` | `console` | Framework apps: `appLogger` |

Credentials come from the AWS provider chain. Dead-lettering is native SQS: set the redrive
policy's `maxReceiveCount` to `queue.maxAttempts`. `onTaskDeadLettered` does not fire for SQS.

**Custom drivers** implement the exported contract types:

- `ResizeStorage`: `upload`, `download`, `publicUrl` (pure, no I/O), and optionally `signedUrl`
  and `canServeOriginalPublicly`.
  - The ref you return from `upload()` is opaque to the module and comes back unchanged.
  - `upload()` may receive a `namespace` hint (from `uploadOriginal`) or a `parentRef` (the
    original's ref, for previews). Never both.
- `MediaStore`: `load`, `appendPreviews`, and an optional `verify()` that the worker awaits once
  at startup. Throw there to stop the worker before it leases anything.
- `LockProvider`: `acquire(key, ttlMs)` and `release(key)`.
- `QueueTransport`: `enqueue(task)` with `{ resizer, queue, mediaId, pipeline, previews }`; store
  `resizer` and `queue`.
  - `startWorker(handle, { signal, queue, onEvent })` consumes only that queue and reports
    `onEvent('completed' | 'failed' | 'deadLettered', task, error?)`.
  - Optionally, `findActive(task)` lets `enqueueRequired()` confirm work that another request
    queued.

## Config reference

`src/config/resize.ts` spreads the defaults from `…/config/resize.js`. The framework merges
`resize.<NODE_ENV>.ts` over it: objects merge field by field, and arrays are replaced. The module
validates the result when a Resizer is created and does not merge again. A second Resizer can read
its own file with `createFrameworkResizer({ configName: 'resizeListings', … })`.

| Key | Default | Notes |
|---|---|---|
| `mediaModelName` | required (framework only) | The host media model, e.g. `'File'` |
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
| `queue.lockTtlMs` | `{ dispatch: 60000, worker: 60000 }` | `worker` must be ≤ `queue.leaseMs` |
| `queue.leaseMs` | `60000` | Set to at least ~2× the slowest encode |
| `queue.retryBackoffMs` | `{ base: 5000, max: 300000 }` | Retry delay |
| `queue.maxAttempts` | `5` | Every lease counts, including reclaimed ones |
| `queue.idlePollMs` | `1000` | Sleep after an empty poll |
| `queue.taskTimeoutMs` | `600000` | A longer task is failed |
| `worker.enabled` | `false` | Allows the worker command to run |
| `worker.concurrency` | `4` | Variants in parallel per task or `generate()` call |
| `worker.sharpConcurrency` | `1` | `sharp.concurrency()`; keep `concurrency × sharpConcurrency ≈ CPU cores` |
| `worker.sharpCache` | `false` | Sharp's cache mostly wastes memory on distinct images |

Who reads what:
- **Each Resizer:** `queue.lockTtlMs` and `worker.concurrency`.
- **`createFrameworkMongoTransport()`:** the other `queue.*` keys. A core `MongoTransport` takes
  them as constructor options instead.
- **The framework worker command:** `worker.enabled` and the Sharp keys, from the `resize`
  config.
- **Not config:** buckets, URLs and queue URLs are driver options.

The 0.2.x keys `webpAvifOnly`, `encode.quality`, `encode.effort`, `encode.mozjpeg`,
`encode.chromaSubsampling` and `encode.flattenBackground` fail with `RESIZE_CONFIG_REMOVED_KEY`.

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
