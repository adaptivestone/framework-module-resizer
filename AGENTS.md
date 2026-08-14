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

7. Lazy / pre-warm modes: run the worker as its own process — `npm run cli ResizeWorker` —
   gated by config `worker.enabled` (default `false`; enable it via env in the worker process
   only). Eager mode needs no worker.

## Use

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

Upload handler, eager mode (blocking; requires a Resizer constructed WITHOUT `transport`):

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
- Never run sharp on the request path — preventing that is this module's reason to exist.
- The scaffolded model/command shims re-export the package: do not vendor or fork them. Gate
  drift in CI with `npx resize-scaffold --check`.
- SVG originals pass through untouched at every requested size (never rasterized, never
  enqueued). Sanitizing SVG at upload is the HOST's job.
- Deleting storage objects when media is deleted is the HOST's job — the module only appends.

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
