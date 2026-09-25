# 0.3.0

**Breaking changes**

- Private SVG originals now use the same `resolve()` / `prewarm()` / `enqueueRequired()` and
  worker lifecycle as raster images. The worker copies the original bytes to public storage and
  atomically persists the locator in `original.publicCopy`; it does not rasterize or rewrite SVG.
- Custom `MediaStore` implementations must add
  `setOriginalPublicCopy(mediaId, expectedOriginalKey, publicCopy): Promise<boolean>`. The
  conditional write prevents a completed worker from attaching a copy to a replaced original.

**Features**

- Restored the framework-style `./config/resize.js` subpath with canonical module defaults.
  Scaffolded hosts extend that config and declare only `mediaModelName` plus their overrides;
  framework environment merging remains the single runtime merge layer.
- `ResizeStorage` has an optional `copyToPublic()` optimization. `S3Storage` implements it with a
  server-side `CopyObject`; other drivers use the core download/upload fallback.
- `resolve()` now queues publication when an anonymous read reaches a private SVG without a valid
  public copy. After publication, every requested size and format resolves to the same SVG URL and
  reports its real `image/svg+xml` content type.
- `generate()` performs the same publication eagerly. `prewarm()` and `enqueueRequired()` skip it
  only when storage proves that the SVG original or its persisted copy is already public.

**Upload policy**

- `uploadOriginal()` still stores the exact input bytes. The module inspects SVG metadata but does
  not sanitize markup, remove scripts, or follow a host-specific trust policy. Hosts decide which
  SVG inputs they accept; this release adds no sanitizer.

**Also included since 0.2.1**

- Added `resizer.uploadOriginal({ body, visibility })`: byte-sniffed, unchanged original storage
  with typed metadata/errors and explicit SVG-as-SVG handling. New `upload.maxBytes` and
  `upload.formats` controls bound accepted inputs.
- Added strict `enqueueRequired()`, which partitions ready, accepted, not-required, and
  unconfirmed variants. A held lock is no longer treated as a task receipt; Mongo can prove
  exact canonical active-payload coverage, while SQS/custom transports report non-queryable
  races as incomplete. Conflicting payloads with one preview identity are explicit.
- Queued raster tasks now retry any missing identities after partial generation. Successful
  previews remain persisted, retries skip them, and permanent gaps use existing backoff and
  dead-letter handling. Deleted media tasks remain successful no-ops.
- Worker setup uses an explicit `worker.enabled: true` in host config instead of an
  environment-variable convention. Updated the scaffold example, guidance, and disabled-worker
  message; the module default remains `false`.

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
