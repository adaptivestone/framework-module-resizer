# Unreleased

Pending changes since 0.2.1. The release version will be chosen when these changes are ready.

**Breaking changes**

- Persisted locators are nested, driver-owned refs: `original.storageRef` and
  `previews[].storageRef` replace the flat `key`/`bucket` fields, and `StorageRef` is now an
  opaque JSON value. No reader or migration for old resize records is included; update host
  models, DTOs, custom storage drivers and the API/worker processes together. Keep
  `minimize: false` on the media schema so empty objects inside refs survive persistence.
- `ResizeStorage.upload()` receives optional `namespace` (a placement hint from
  `uploadOriginal({ namespace })`) and `parentRef` (the original's ref when the worker stores
  previews).
- Private originals need separate storage: `S3Storage` rejects a private upload unless
  `bucketPrivate` differs from `bucketPublic`; `LocalFsStorage` keeps private files under
  `privateRootDir` (default `<rootDir>-private`).
- SVG is an input format only. `uploadOriginal()` stores SVG privately and rejects public SVG
  uploads; the worker rasterizes accepted SVG into the configured preview formats through the
  normal task lifecycle. `resolve()` never returns uploaded SVG markup.
- The module no longer merges host config over its defaults and drops the `deepmerge`
  dependency. The framework's `resize.ts` + `resize.<NODE_ENV>.ts` merge is the only merge: the
  host `src/config/resize.ts` spreads the defaults from
  `@adaptivestone/framework-module-resize/config/resize.js`, and the final value must be complete.
  It is validated when `new Resizer()` is constructed.
- Config keys moved. The old keys now fail validation with `RESIZE_CONFIG_REMOVED_KEY` instead of
  being ignored:

  | 0.2.x | Unreleased |
  |---|---|
  | `webpAvifOnly: true` | `formats: ['webp', 'avif']` |
  | `encode.quality.<format>` | `encode.formats.<format>.quality` |
  | `encode.effort.<format>` | `encode.formats.<format>.effort` |
  | `encode.mozjpeg`, `encode.chromaSubsampling` | `encode.formats.jpeg.mozjpeg`, `encode.formats.jpeg.chromaSubsampling` |
  | `encode.flattenBackground` | `encode.flatten.background` (formats in `encode.flatten.formats`) |

- Format ids are open strings passed to `sharp.toFormat(id, encode.formats[id])`. Every `formats`
  entry needs an `encode.formats` entry (`{}` keeps Sharp defaults), so an alias such as `'jpg'`
  fails at boot instead of skipping the `'jpeg'` options and flatten step.
- `mediaModelName` must name a registered model. The worker checks it at startup, and
  `FrameworkMediaStore` throws `ResizeConfigError` (`RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN`) instead of
  completing every task as a deleted-media no-op.
- Worker setup uses an explicit `worker.enabled: true` in host config instead of an
  environment-variable convention. Updated the scaffold example, guidance, and disabled-worker
  message; the module default remains `false`.
- Several named Resizers can live in one process. `new Resizer({ name })` registers under its
  name (default `'default'`), a duplicate name throws `RESIZE_DUPLICATE_RESIZER`, and
  `getResizer(name?)` looks one up. Each Resizer reads its own `config`, `logger` and `events`
  (framework app defaults when omitted) at construction, instead of reading the app on every call.
- The `QueueTransport` contract changed. `enqueue()` receives an `EnqueueTask`
  (`{ resizer, queue, mediaId, pipeline, previews }`), `LeasedTask` carries `resizer` and `queue`,
  and `startWorker(handle, { signal, queue, onEvent })` consumes one named queue and reports
  `completed` / `failed` / `deadLettered` events instead of calling Resizer observers. The worker
  routes those events to the owning Resizer's hooks. Custom transports must follow.
- The Mongo `requestKey` is now `v2` and covers the Resizer name and the queue. `ResizeTask` gains
  `resizer` and `queue` fields, and its lease index becomes `{ queue, status, createdAt }`; create
  the new index through your migration. Rows without the new fields read as `'default'`.
- `processTask(task)` runs the task with the Resizer named in it; an unknown name rejects with
  `RESIZE_NO_RESIZER` (the task retries, then dead-letters).
- Preview identity includes the Resizer and pipeline: `getPreviewIdentity(scope, sizeKey, format,
  filters)` returns `resizer:pipeline:sizeKey:format:filterSig`. Generated preview rows store
  `resizer` and `pipeline` (rows without them belong to `default`), so different pipelines and
  Resizers keep separate previews of the same media instead of sharing whichever was generated
  first. Dispatch and worker lock keys change accordingly. `expandMissingPreviews` and
  `expandPreviewRequests` take a scope; `isCatalogCovered` takes an optional one. The
  "use distinct filters per pipeline" workaround is no longer needed.
- The framework is an adapter. The main entry imports no framework code; framework wiring moves
  to the new `@adaptivestone/framework-module-resize/framework.js` subpath.
  - `new Resizer()` requires `config` and `mediaStore` (and `lockProvider` with a `transport`;
    `RESIZE_CONFIG_REQUIRED` / `RESIZE_MEDIA_STORE_REQUIRED` / `RESIZE_LOCK_PROVIDER_REQUIRED`),
    defaults `logger` to `console`, and never reads the framework app. Framework hosts construct
    through `createFrameworkResizer({ … })`, which fills config, logger, events, the framework
    media store and, with a transport, the framework lock provider. Re-scaffold or update
    `src/resizer.ts`.
  - `MongoTransport` takes `{ model }` or `{ getModel }` plus `logger`, `leaseMs`,
    `retryBackoffMs`, `maxAttempts`, `idlePollMs`, `taskTimeoutMs` instead of reading the global
    config (`RESIZE_MONGO_MODEL_REQUIRED` without a model). Framework hosts use
    `createFrameworkMongoTransport()`. `SqsTransport` takes a `logger` (framework hosts:
    `appLogger` from `…/framework.js`).
  - `ResizeConfig` no longer contains `mediaModelName`; `FrameworkResizeConfig` does. The scaffold
    config `satisfies FrameworkResizeConfig`.
  - The main entry no longer exports `ResizeWorker`, `ResizeTaskModel`, `runResizeWorker` or the
    `TResizeTask` type; import them from `…/framework.js` (the `…/commands/ResizeWorker.js` and
    `…/models/ResizeTask.js` subpaths still work).

**Features**

- Framework-free use: `new Resizer({ config, storage, mediaStore, … })`, `new MongoTransport({
  model })` and the core `runWorker({ queue, signal, logger, sharp })` run without
  `@adaptivestone/framework`. `runWorker` also refuses to start when a Resizer's
  `queue.lockTtlMs.worker` exceeds the transport's `leaseMs` (`RESIZE_CONFIG_LOCK_EXCEEDS_LEASE`).
- Each framework Resizer can read its own config file:
  `createFrameworkResizer({ name: 'listings', configName: 'resizeListings', storage })`.

- Named queues. A Resizer has a default `queue` (default `'default'`), and `resolve()`,
  `prewarm()` and `enqueueRequired()` accept a per-call `queue`.
  `npm run cli ResizeWorker -- --queue=<name>` consumes only that queue; without the flag it consumes `'default'`. `SqsTransport` maps queue
  names to URLs with the new `queues` option (`RESIZE_SQS_QUEUE_UNKNOWN` for an unknown name).
- One worker process serves every Resizer constructed in it, routing each task to the Resizer
  named in it. Its Resizers must share one transport instance (`RESIZE_WORKER_TRANSPORTS_DIFFER`
  otherwise), and every media store's `verify()` runs before leasing. Named Resizers may have a
  transport. `listResizers()` lists the registered Resizers.
- `resizer.uploadOriginal({ body, visibility, namespace? })` stores the original bytes unchanged
  and returns typed metadata. Format and dimensions come from `sharp().metadata()`; new
  `upload.maxBytes`, `upload.formats` and `limits.processingTimeoutSeconds` bound accepted inputs.
- Strict `enqueueRequired()` partitions ready, accepted, not-required and unconfirmed variants. A
  held lock is not treated as a task receipt: Mongo proves exact canonical active-payload coverage
  through the optional `QueueTransport.findActive()`, while SQS/custom transports without it
  report lock races as retryable `incomplete`. Conflicting payloads with one preview identity are
  explicit errors.
- The Mongo transport deduplicates identical active requests with a canonical SHA-256
  `requestKey` and a partial unique index on `{ fileId, pipeline, requestKey }`. The module does not
  create indexes; prepare them through the host's migration or lifecycle before rollout.
- Queued raster tasks retry only the identities still missing after partial generation.
  Successful previews stay persisted, and permanent gaps use the normal backoff and dead-letter
  path. Deleted media tasks remain successful no-ops.
- `MediaStore` gains an optional `verify()` startup check. The worker awaits it once before
  leasing tasks, so custom media stores can fail fast too; `FrameworkMediaStore.verify()` checks
  that `mediaModelName` names a registered model.
- `FrameworkMediaStore({ modelName })`; the default media store uses the Resizer's own
  `mediaModelName`.

**Fixes**

- `LocalFsStorage` normalizes root paths before deriving the private root and rejects a
  `privateRootDir` equal to or inside the public root. A trailing slash no longer places private
  originals in the public folder.
- Coverage builds the package before integration tests. Source-only test runs skip the Framework
  config integration test with a build instruction when the compiled config is absent.
- Host adoption documentation uses a generic checklist without internal project names or paths.
- The resolved config object is validated once instead of on every `getResizeConfig()` call, so
  the read path no longer re-runs full validation per `resolve()`.

# 0.2.1

**Fixes**

- `ResizeWorker` now exposes the `getMongoConnectionName` static required by the framework
  CLI without importing framework internals.
- Missing persisted originals raise `ResizeNoOriginalError`; Mongo tasks dead-letter this
  terminal condition immediately instead of retrying a download with no key.
- Resolve treats throwing original-visibility checks as private and continues enqueueing missing
  variants.
- Resolve preserves cached previews, missing variants, and URL formatting when a plain media
  record has `original: null`.
- Resolve and prewarm no longer enqueue variants when the media original has no storage key.
- Original visibility is explicit: public URLs are never fabricated for private S3 originals;
  authorized reads use signed URLs and local storage validates paths.
- Mongo enqueue canonicalizes variants and atomically deduplicates identical active requests
  with a partial unique index and SHA-256 request key, preserving schema validation on upserts.
  The key includes the pipeline and surviving catalog; dispatch locks and preview identities
  remain shared across pipelines. Legacy rows without a key remain valid.

# 0.2.0

**Breaking changes**

- `generate` now returns `{ created, failed }` instead of `{ previews }`. `created` is **only what
  this call made** — a second `generate` over the same catalog returns `{ created: [], failed: 0 }`
  because everything already exists. Treat an empty `created` as "nothing new was needed", never as
  failure. An SVG original is the same: pass-through, never rasterized.
- `generate` now throws instead of returning an ambiguous empty array: `ResizeNoOriginalError` when
  the media has no `original`, `ResizeGenerateError` when every requested variant failed. Some
  variants failing does not throw — `failed > 0` with the rest in `created`.
- `resolve`'s `output` is `undefined` when no `formatPublicUrls` hook is registered, or when every
  tap threw. It previously handed back the raw `{ ready, missing }` decision, which was easy to
  send to a frontend as if it were a DTO. Map `decision` yourself, or call `formatPictureUrls`.
- `enqueueMissing` now defaults to `false` when no `transport` is set (previously always `true`),
  so an eager-only host no longer enqueues-or-logs on every read.
- The `S3Storage` option `publicUrl` is renamed **`publicBaseUrl`**. The old name still works for
  one minor and is marked deprecated — it collided with the `publicUrl(ref)` method every storage
  driver implements, which silently broke anyone copying the option literal into a class.

**Features**

- New `LocalFsStorage` driver at `@adaptivestone/framework-module-resize/storage/fs.js` —
  `{ rootDir, publicBaseUrl }`, no optional peers. The default story for tests, CI and local
  development, and enough on its own for a complete eager-mode host.
- **Error hierarchy.** Every error the module throws now extends `ResizeError`, so one check
  separates a module rejection from a `sharp`/S3/mongo failure. Subclasses say what to do about it:
  `ResizeSetupError` (wiring is wrong), `ResizeConfigError` (crash at boot), `ResizeMediaError`
  (skip this record; `ResizeNoOriginalError` extends it), `ResizeGenerateError` (produced nothing),
  `ResizeStorageError` (transient; retry may help), `ResizeSecurityError` (refusal; never retry).
  Every instance carries a stable machine-readable `err.code` plus the usual `name` and `cause`.
- `ResizeError.isResizeError(err)` — prefer it over `instanceof` when the error may cross a package
  boundary. Two copies of this package in one `node_modules` tree produce two class identities, so
  `instanceof` silently returns `false`; the brand check does not.
- New `formatPictureUrls(decision, { id?, mediaType? })` — builds a generic `<picture>`-shaped map
  from a decision. A convenience, not a mandated DTO shape.
- New `isCatalogCovered(media, sizes, formats)` — true when every identity already exists (or the
  original is an SVG), so a host can skip a no-op `generate`/`prewarm`.
- New `resizeMediaPaths` — the `['original', 'previews'] as const` field list the module reads, for
  `.select()`. Append your own host fields.
- `resize-scaffold --eager` emits a filesystem-storage construction site and skips the queue files.

**Internal**

- Driver and `Resizer` internals moved from TypeScript `private` to real `#private` fields. These
  are engine-enforced rather than a compile-time convention, so a JS host can no longer read S3
  bucket configuration off the instance, and `console.log(storage)` cannot leak it. The emitted
  `.d.ts` collapses to `#private;` instead of naming the fields.
- The build specification (`spec/`, `BUILD-SPEC.md`, `BUILD-PLAN.md`, `ADOPTION-PLAN.md`) moved to
  `docs/history/` and is explicitly unmaintained. `README.md`, `AGENTS.md` and the docs site are
  the living documentation. Nothing under `docs/` has ever shipped to npm.
- Encode defaults were validated against the Kodak reference image set before release and left
  unchanged at `{ jpeg: 80, webp: 82, avif: 64 }`. At the sizes this module generates, raising
  AVIF to 90 cost +135% bytes for no difference visible at 1:1.
- Toolchain and dev dependencies refreshed (TypeScript 7.0.2; lockfile updates for mongoose, the
  AWS SDKs and the framework peer). **No consumer-facing dependency change** — `dependencies`,
  `peerDependencies`, `peerDependenciesMeta` and `engines` are identical to 0.1.0.

# 0.1.0

Initial release. Lazy, pre-warm and eager generation over one shared resize core; `previews[]`
persisted on the host media document; swappable transport / storage / media-store / lock-provider
seams injected in a single constructor literal; Mongo and SQS transports; S3 storage; named
per-media-type pipelines and typed cross-cutting hooks; `resize-scaffold` bin; `AGENTS.md` guide.
