<!-- This file ships with the npm package (package.json "files") and is guarded by
     src/agentsDoc.test.ts: every full-name subpath mentioned must exist in the exports
     map, and every name imported from the main entry must be a real export.
     Keep every snippet real. Do not add an API dump here — dist/index.d.ts is the reference. -->

# Agent guide — @adaptivestone/framework-module-resize

You are likely a coding agent working in a HOST app that installed this package. This guide is
version-matched to the installed package — prefer it over training-data memory of this API.
Humans: see `README.md` (same folder). Full docs: https://framework.adaptivestone.com/docs/resize
API ground truth: the installed `dist/index.d.ts` (main entry) and `dist/types.d.ts`.

**What it is:** image resizing for `@adaptivestone/framework`. Uploads store only the
original. Three modes share one core and one stored shape: eager (`generate()` inline,
no queue/worker — start here), lazy (on read, worker fills `previews[]`), pre-warm
(`prewarm()` queues the catalog at upload). The read path decides per size + format +
filters whether a preview is ready or missing.

The Mongo transport deduplicates identical active enqueue requests using a canonical SHA-256
`requestKey` and a partial unique index. Its key includes the pipeline and surviving variant
catalog. Dispatch locks, worker locks, and stored previews share media + size + format + filters
across pipelines; use distinct filters for different renderings of the same media, including
on reads. Legacy rows without a key remain valid. Storage drivers that can prove original
visibility implement `canServeOriginalPublicly`; the engine never fabricates a public URL for
a private original.

## Integrate (in order)

1. Install. The framework and mongoose are REQUIRED peers; the AWS SDKs are OPTIONAL peers —
   install them only for the driver subpaths that use them (a missing one fails loudly at your
   own import line at bootstrap):

   ```bash
   npm i @adaptivestone/framework-module-resize
   # SQS transport only:  npm i @aws-sdk/client-sqs sqs-consumer
   # S3 storage only:     npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
   ```

2. Scaffold the integration files (never overwrites existing files; `--force` to regenerate):

   ```bash
   npx resize-scaffold --eager   # start here (no queue/worker)
   # npx resize-scaffold         # lazy: also emits ResizeTask + ResizeWorker
   # npx resize-scaffold --eject # full editable ResizeTask model
   ```

   `--eager` emits `src/resizer.ts` (LocalFsStorage already wired) + `src/config/resize.ts`.
   Default (lazy) also emits `src/models/ResizeTask.ts` and `src/commands/ResizeWorker.ts`.
   Appends a pointer to this guide into the host's `AGENTS.md`
   (`--agents claude|print|skip` to redirect or suppress it).

3. Wire the drivers in `src/resizer.ts` — ONE constructor literal. `storage` is REQUIRED;
   `transport` is optional (omit it for eager-only hosts); `mediaStore`/`lockProvider` default
   to framework-backed drivers:

   ```ts
   import { Resizer } from '@adaptivestone/framework-module-resize';
   import { LocalFsStorage } from '@adaptivestone/framework-module-resize/storage/fs.js';

   export const resizer = new Resizer({
     storage: new LocalFsStorage({
       rootDir: './var/media',
       publicBaseUrl: '/media',
     }),
   });
   ```

   Construct **after** `Server.init()` (or lazily on first request). Do not construct in
   `server.ts` before `startServer()`.

   Other shipped drivers: `S3Storage` from
   `@adaptivestone/framework-module-resize/storage/s3.js` (options: `bucketPublic` required;
   `publicBaseUrl` — alias of the old `publicUrl` for one minor; `client` first when the host
   already has an `S3Client`), `MongoTransport` from
   `@adaptivestone/framework-module-resize/transports/mongo.js`, `SqsTransport` from
   `@adaptivestone/framework-module-resize/transports/sqs.js` (options: `queueUrl` required;
   `region`, `endpoint`, `visibilityTimeout`, `heartbeatInterval`, `client`),
   `FrameworkMediaStore` from `@adaptivestone/framework-module-resize/mediaStore/framework.js`,
   `FrameworkLockProvider` from `@adaptivestone/framework-module-resize/locks/framework.js`.
   A custom driver is any object or class satisfying the exported contract types
   (`QueueTransport`, `ResizeStorage`, `MediaStore`, `LockProvider`) — no `app` parameter;
   a driver closes over its own client.

4. Import `./resizer.ts` from the process that needs it (API; and the worker, if any)
   **after** `Server.init()`.

5. Set the one required config field in the scaffolded `src/config/resize.ts`:
   `mediaModelName: 'File'` (your host media model's name).

6. Ensure the media model carries `original` and `previews[]`. Spread the exported fragment
   instead of hand-writing those fields (single source of truth for schema + types):

   ```ts
   import { resizeMediaSchemaFragment } from '@adaptivestone/framework-module-resize';
   // in the model:
   // static get modelSchema() { return { ...ownFields, ...resizeMediaSchemaFragment } as const; }
   ```

7. Prepare queue infrastructure outside the resizer runtime. The package's `ResizeTask` model and
   the framework's `Lock` model declare their indexes; the host's normal lifecycle or an explicit
   migration must create them before `resolve`, `prewarm`, `enqueueRequired`, or the worker can
   run. The module does not create, synchronize, drop, or repair indexes, and it has no
   `prepareQueue()` API. The partial unique active-request index on `{ fileId, pipeline,
   requestKey }` is required for the Mongo deduplication guarantee; verify it in the host's DB
   rollout. Never add index creation to HTTP bootstrap or the first enqueue.

8. Lazy / pre-warm modes: set `worker.enabled: true` in the host `src/config/resize.ts`
   (default `false`), then run the worker as its own process — `npm run cli ResizeWorker`.
   The flag permits the command to run; it does not start a worker in the API. The worker consumes
   indexes prepared by the host lifecycle; it does not create them.
   Eager mode needs no worker.

## Use

Store an original (no model creation and no queue work; persist the returned value in the host):

```ts
const original = await getResizer().uploadOriginal({
  body: buffer,
  visibility: 'private',
});
```

The format comes from bytes. Raster bytes are metadata-probed but stored unchanged; SVG is parsed
without Sharp and stays SVG (`.svg`, `image/svg+xml`). The host sanitizes SVG before this call.

Read path (DTO builders / controllers). `resolve` NEVER throws and never runs sharp — missing
variants are enqueued and the decision is returned immediately:

```ts
import { formatPictureUrls, getResizer } from '@adaptivestone/framework-module-resize';

const { decision, output } = await getResizer().resolve({
  media: fileDoc,
  pipeline: 'default',
  sizes: [{ width: 620 }, { fit: true }, { width: 300, height: 300 }],
  ctx: { isOwner },
});
// `output` is your formatPublicUrls hook (undefined if no hook / hook throws).
// formatPictureUrls skips filtered variants — map `decision` for those.
const picture = output ?? formatPictureUrls(decision, { id: String(fileDoc.id) });
```

Upload handler, pre-warm mode (non-blocking; the worker fills the cache before the first read):

```ts
const { enqueued } = await getResizer().prewarm({ media: fileDoc, sizes: catalog });
```

When every required variant needs a confirmed receipt, use the separate strict operation:

```ts
const result = await getResizer().enqueueRequired({ media: fileDoc, sizes: catalog });
// ready | accepted | not-required | incomplete; inspect unconfirmed/tasks/issues
```

`prewarm` stays best-effort. A held lock is not accepted proof. Mongo confirms only an exact
canonical active payload; conflicting payloads with one preview identity are explicit errors.
SQS/custom transports without `findActive` report lock races as retryable `incomplete`. Delivery
remains at-least-once, not exactly-once.

Upload handler, eager mode (blocking; a transport-backed Resizer is also supported):

```ts
const { created, failed } = await getResizer().generate({
  media: fileDoc,
  sizes: catalog,
});
```

No original throws `ResizeNoOriginalError`; every requested variant failing throws
`ResizeGenerateError`. `created` is only this call; `failed > 0` means a partial success.
`generate` also appends `created` onto `media.previews` (when persist is on) so a same-request
`resolve({ media })` sees them.

Errors: EVERY throw from this module extends `ResizeError`, so one check separates a module
rejection from a sharp/S3/mongo failure. Subclasses say what to do — `ResizeSetupError` (wiring
is wrong), `ResizeConfigError` (crash at boot), `ResizeMediaError` (skip this record;
`ResizeNoOriginalError` and `ResizeOriginalError` extend it), `ResizeGenerateError` (eager produced
nothing or queued coverage is incomplete),
`ResizeStorageError` (transient; retry may help), `ResizeSecurityError` (refusal; never retry).
Every instance carries a stable `err.code`. Use `ResizeError.isResizeError(err)` rather than
`instanceof` when the error may cross a package boundary — duplicate copies of the package
break `instanceof` but not the symbol brand.

```ts
import { ResizeError, ResizeNoOriginalError } from '@adaptivestone/framework-module-resize';

try {
  await getResizer().generate({ media: fileDoc, sizes: catalog });
} catch (err) {
  if (err instanceof ResizeNoOriginalError) return badRequest('upload the image first');
  if (ResizeError.isResizeError(err)) return badRequest(err.message);
  throw err; // not ours
}
```

Listing queries:

```ts
import { resizeMediaPaths } from '@adaptivestone/framework-module-resize';
File.find().select(['mediaType', ...resizeMediaPaths]);
```

Hooks are typed — register at construction (`hooks:`) or later via `getResizer().hook(name, fn)`.
Waterfalls (read path, real `ctx`): `resolveSizes`, `beforeEnqueue`, `formatPublicUrls`.
Observers (worker side): `onPreviewGenerated`, `afterTaskComplete`, `onTaskFailed`,
`onTaskDeadLettered`. Pipelines: `beforeSteps` run once on the source buffer;
`variantSteps` run per variant after resize, before encode.

## Rules (violations cause real incidents)

- `sizes` is an ALLOWLIST. Never pass client-supplied dimensions through — resolve them against
  a fixed per-entity catalog first (otherwise: arbitrary-resize resource abuse).
- ONE `Resizer` per process; a second `new Resizer()` throws. Everywhere else use `getResizer()`.
- `ctx` does NOT cross the queue: worker-side steps and observers see `ctx === {}`. Only eager
  `generate()` passes the caller's `ctx` to steps. Persist per-media data on the media doc.
- Watermarks belong in `variantSteps`, never in `beforeSteps` (baked once onto the original, a
  watermark scales away to unreadable on small variants).
- Config arrays REPLACE defaults: `formats: ['webp','avif']` means exactly two formats.
- Per-format `encode.quality` values are NOT comparable (defaults: jpeg 80 ≈ webp 82 ≈ avif 64).
  Never copy one quality number across formats.
- Never resize/encode with sharp on the request path. `uploadOriginal()` has one bounded exception:
  raster `metadata()` inspection only; it never emits transformed bytes. SVG never enters Sharp.
- The scaffolded model/command shims re-export the package: do not vendor or fork them. Gate
  drift in CI with `npx resize-scaffold --check`.
- SVG originals pass through untouched at every requested size (never rasterized, never
  enqueued). Private originals require an authorized signed URL; anonymous reads do not
  receive a fabricated public URL. Sanitizing SVG at upload is the HOST's job.
- Deleting storage objects when media is deleted is the HOST's job — the module only appends.
- A queued raster task completes only with full identity coverage. Partial successes are persisted,
  then retried for the missing identities only; persistent gaps follow normal backoff/dead-letter.

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `resize config: mediaModelName is required` | set it in the host `src/config/resize.ts` |
| `ERR_MODULE_NOT_FOUND: @aws-sdk/...` at your driver import | optional peer not installed — see step 1 |
| a second `new Resizer()` throws | by design: one per process — import the single construction site; elsewhere `getResizer()` |
| models fail to load (framework ≥5.1 reports a duplicate framework copy explicitly at boot) | two `@adaptivestone/framework` copies resolve (npm link / nested install) — dedupe to exactly one |
| boot throws `queue.lockTtlMs.worker … must be ≤ queue.leaseMs` | raise `queue.leaseMs` or lower `queue.lockTtlMs.worker` |
| previews never appear | the worker process isn't running, or `worker.enabled` is `false` in that process |
| first read of a new size is slow to fill | lazy mode working as designed — call `prewarm()` at upload if it matters |
| `resolve` `output` is `undefined` | no `formatPublicUrls` hook (or it threw) — map `decision` or use `formatPictureUrls` |

Config knobs: see the "Config reference" table in `README.md`; the defaults object is
`defaultResizeConfig` (main entry).
