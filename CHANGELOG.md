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

# 0.1.0

Initial release. Lazy, pre-warm and eager generation over one shared resize core; `previews[]`
persisted on the host media document; swappable transport / storage / media-store / lock-provider
seams injected in a single constructor literal; Mongo and SQS transports; S3 storage; named
per-media-type pipelines and typed cross-cutting hooks; `resize-scaffold` bin; `AGENTS.md` guide.
