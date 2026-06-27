# 01 · Architecture

> Part of the [`@adaptivestone/framework-module-resize` build spec](../BUILD-SPEC.md).
> Next: [02 · Types & API](./02-types-and-api.md)

Covers concept, the non-negotiable principles, the models the module touches,
out-of-scope boundaries, and the global invariants.

---

## §1. Concept (what "lazy resize" means)

1. Only the **original** image is uploaded and stored (typically a private bucket).
   No previews are generated at upload time.
2. Generated **previews** (resized variants) are stored as metadata on the host's
   media document (`previews[]`), the **source of truth** for what is ready.
3. The **read path** decides, per requested `size + format + filters`, whether a
   preview exists. Missing previews are **enqueued** for async generation; the read
   returns immediately. The host renders a placeholder or a (signed) original URL for
   not-ready variants inside its `formatPublicUrls` hook.
4. A separate long-running **worker** consumes the queue, runs the media type's async
   `beforeSteps` once, generates previews with `sharp`, uploads them to public
   storage, and appends them to the media document. The next read returns real URLs.

This removes expensive `sharp` + S3 work from HTTP create/update handlers (it replaces the
legacy synchronous, all-or-nothing upload-time resize that prior implementations did).

---

## §2. Architecture principles (non-negotiable)

1. **Return the decision, never the DTO.** The engine's read method returns *which
   previews are ready and which are missing*. The host formats the public response via
   `formatPublicUrls`. The module never hardcodes a response shape (prior implementations
   used three different ones: a flat array, a flat object, and a nested `sizes[name][format]`
   map).
2. **Behavior is a dependency; schema is source the host owns.** Engine, worker, queue
   logic, helpers, hooks, and the pipeline registry ship as compiled npm code. The
   queue **model** and **config** are emitted into the host app as editable source by a
   scaffold command (the "shadcn" approach), because schema needs host-specific refs,
   fields, and indexes and must live in the host's own `src` for its typecheck/codegen.
3. **The framework is the environment, not a dependency.** Never
   `import '@adaptivestone/framework'` (or `mongoose`). Depend only on a minimal
   duck-typed `TMinimalResizeApp`. Reach host primitives (the framework `Lock` model,
   the scaffolded queue model, the host media model) via `app.getModel(...)`. A hard
   import would version-lock every host app and risk a duplicate framework
   instance with a split model registry.
4. **Four injected strategies, not baked behavior.** Divergence is injected via:
   **(a) hooks** (waterfall value-transforms + observers, see
   [04](./04-pipelines-and-hooks.md)), **(b) named pipelines** (`beforeSteps` +
   `variantSteps` per media type, [04](./04-pipelines-and-hooks.md)), **(c) one active
   queue transport** (`registerQueueTransport`, [05](./05-transport-and-storage.md)),
   **(d) one active storage** (`registerStorage`, [05](./05-transport-and-storage.md)).
5. **Ship defaults, merge host config.** Provide a default `resize` config; deep-merge
   it under `app.getConfig('resize')` (host wins; arrays replace, not concat).
6. **One shared identity helper** used by read, enqueue, worker, and scaffolded model.
   Never build the preview identity or a lock key by hand at a call site — mismatched
   keys leak locks and mis-parse sizes (the class of bug behind a `_`-vs-`x` lock-key leak
   and a `620w → NaN` size-key mis-parse seen in prior implementations). See
   [03 · Identity](./03-identity.md).

---

## §14. Models the module touches (all via `app.getModel`)

The module never imports mongoose or any schema. It reaches three models by name:

| Model | Source | Methods the module calls |
|---|---|---|
| `Lock` | framework built-in | `acquireLock(key, ttlSeconds) → bool`, `releaseLock(key)` |
| `ResizeTask` | **scaffolded** into host `src` (Mongo transport only) | `create`, `findOneAndUpdate`, `findByIdAndUpdate` |
| media (`config.mediaModelName`) | host-owned (`File`/`Media`) | `findById`, `findByIdAndUpdate` (`$push previews`, `$set original.width/height`) |

Naming seam: the module speaks **`mediaId`** everywhere; the scaffolded `ResizeTask`
uses **`fileId`** (host-owned ref). The Mongo transport is the only place that maps them
(`fileId: mediaId` on enqueue; `mediaId: String(doc.fileId)` on lease). Tests pass a fake
`app` whose `getModel` returns plain objects implementing only those few methods — no
live Mongo needed for the unit suite.

**Verified framework contracts** (read from `@adaptivestone/framework` source — see
[Appendix C](./appendix.md)):
- `Lock.acquireLock(name, ttlSeconds = 30) → Promise<boolean>` — TTL is **seconds** (the module
  converts its `lockTtlMs`); atomic via upsert + E11000. `releaseLock(name) → Promise<boolean>`,
  unconditional (no ownership token). `waitForUnlock` needs a replica set (change streams) — the
  module does **not** use it, so two-tier locks work on standalone Mongo.
- `app.getModel(name)` returns the model **or `false`** for an unknown name (never throws); keyed
  by **file name**. The worker/transport must tolerate `false`.
- `app.getConfig(name)` returns `{}` for unknown and does **not** deep-merge module defaults with
  host overrides (the host file *replaces* the framework file) — so `getResizeConfig(app)` must do
  its own deep-merge of module defaults + `app.getConfig('resize')`.
- The worker is an `AbstractCommand` with `async run(): Promise<boolean>`, `this.app` available,
  `static description`, and **`static isShouldInitModels = true`** (so models + the Mongo
  connection are ready before `run()`).

---

## §15. Out of scope (host app responsibilities — never put in the module)

- The public **response DTO shape** (host implements via `formatPublicUrls`).
- **Which domain models** attach media and the **size catalogs** per entity (host injects
  via `resolveSizes` and per-call `sizes`). Real catalogs are listed in
  [10 · Host integration](./10-host-integration.md).
- **Data migration** from any legacy preview schema (e.g. a legacy `resizedMetadata` shape).
- **Domain image analysis** — NSFW / object detection / plate or face blur / watermark /
  masking. The module provides the pipeline `beforeSteps`/`variantSteps` seams
  ([04](./04-pipelines-and-hooks.md)); the host injects the analysis.
- **Permissions** — who may delete/replace media ("owner"/admin). The host decides; it may
  pass `ctx.isOwner` to opt a read into a signed-original URL, but the module owns no
  permission logic.
- **Format negotiation / rendering** — the module generates all `requiredFormats`; the
  host/frontend negotiates. Dropping jpeg (`webpAvifOnly`) is a host decision with a
  frontend coupling.
- **Feature-flag rollout / canary gating** — the module is flag-agnostic.
- **Deleting media / S3 cleanup lifecycle** — host-owned.

---

## §16. Constraints / invariants

- Never `import '@adaptivestone/framework'` or `import 'mongoose'`; use
  `TMinimalResizeApp` + `getModel`.
- Build the preview identity and **all** lock keys from `getPreviewIdentity` only
  (`sizeKey:format:filterSig`).
- `fit` uses its own size key (`"fit"`); never collide with a `WxH` key.
- Width-only (`"620w"`) and height-only (`"400h"`) keys must round-trip.
- Filters are part of identity; empty/undefined filters canonicalize to `"none"`
  consistently (no `''`-vs-`'none'` mismatch).
- `.rotate()` on **every** resize branch (cover and `fit`).
- `fit`: `fit:'inside'`, `withoutEnlargement:true`, capped at `config.maxSize`.
- Original `width/height` are captured at upload and backfilled by the worker if missing.
- Preview S3 keys are random/unguessable.
- `beforeSteps` run once per task before resize; `variantSteps` run per variant after
  resize. Functions never enter the queue — the task carries the pipeline **name**.
- Enqueue and observer hooks must never throw into the read or worker flow. On enqueue
  failure, **release the dispatch locks** so a later read can retry.
- Read path returns the decision; it must not fabricate a response shape.
- Worker concurrency is bounded by `config.workerConcurrency`.
- Poison tasks are capped: a task is retried up to `config.maxAttempts`, then **dead-lettered**
  (Mongo `status:'dead'`, retained ~30d for inspection/replay; SQS via the queue's DLQ).
  The lease never reclaims a task past the cap, so no crash-loop runs forever.
- **The worker is idempotent.** Both transports are *at-least-once* — re-running a task for an
  already-generated identity must skip via the existing-preview check (worker §11 step 6),
  never duplicate. ("Effectively exactly-once" only holds for an idempotent consumer.)
- **Encode per format, never one shared quality.** `config.quality.{jpeg,webp,avif}` +
  `config.effort.{webp,avif}` — sharp codec defaults differ and aren't perceptually comparable.
- **Decompression-bomb guard:** every worker `sharp()` call passes `limitInputPixels:
  config.limitInputPixels`. If a host ever fetches originals by remote URL (the module itself
  uses internal `bucket+key`), apply OWASP SSRF mitigations: host-allowlist, no raw user URLs,
  redirects disabled.
- ESM only; `erasableSyntaxOnly` — no enums/namespaces/decorators/parameter-properties;
  prefer `as const` unions.
