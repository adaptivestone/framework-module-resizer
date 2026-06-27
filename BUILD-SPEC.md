# Build Spec — `@adaptivestone/framework-module-resize`

> **Audience:** an engineering agent building this module from scratch, with no access to
> the conversation that produced this spec. This document set is **self-contained**. Build
> strictly to it.
>
> **Goal:** a reusable, lazy image-resize module for
> [`@adaptivestone/framework`](https://www.npmjs.com/package/@adaptivestone/framework),
> packaged like the existing `@adaptivestone/framework-module-email`. It provides the
> *engine* (read decision, async queue, worker, sharp resize) and *extension points*
> (hooks, named per-media-type processing pipelines, pluggable transport, pluggable
> storage, scaffolded models). It deliberately does **not** own any host-app concern
> (response DTO shape, which models attach media, data migrations, domain image analysis,
> S3 wiring, permissions).
>
> **Provenance:** this spec consolidates the lessons of several prior production
> image-resize implementations (SQS- and Mongo-queue based, with flat and nested DTO
> shapes) into one reusable module, resolving the bugs and inconsistencies found across
> them. Where prior approaches conflicted, this spec is authoritative and fixes their bugs
> (see [Appendix A](./spec/appendix.md#a-bugs-this-spec-fixes)).
>
> This file is the **index**. The detailed spec lives in [`spec/`](./spec/).

---

## Table of contents

| # | File | Covers (§) |
|---|---|---|
| 01 | [Architecture](./spec/01-architecture.md) | concept, principles, models touched, out-of-scope, invariants (§1, §2, §14–§16) |
| 02 | [Types & Public API](./spec/02-types-and-api.md) | `TMinimalResizeApp`, data shapes, `ResizeEngine` API (§4–§6) |
| 03 | [Identity helpers](./spec/03-identity.md) | size keys, filter sig, preview identity, dims (§7) |
| 04 | [Pipelines & hooks](./spec/04-pipelines-and-hooks.md) | named pipelines (`beforeSteps`/`variantSteps`) + cross-cutting hooks (§8, §9) |
| 05 | [Transport & storage](./spec/05-transport-and-storage.md) | `QueueTransport` (mongo/sqs) + `ResizeStorage` (§10) |
| 06 | [Read & enqueue](./spec/06-read-and-enqueue.md) | `resolve()` + `enqueue()` algorithms (§17, §18) |
| 07 | [Worker](./spec/07-worker.md) | worker loop + `processTask` + the `fit` rationale (§11) |
| 08 | [Config & scaffold](./spec/08-config-and-scaffold.md) | `ResizeConfig` + scaffolded `ResizeTask` model (§12, §13) |
| 09 | [Packaging & tests](./spec/09-packaging-and-tests.md) | package layout, build, `node:test` suite (§3, §20, §21) |
| 10 | [Host integration](./spec/10-host-integration.md) | bootstrap wiring + real per-entity size catalogs (§19) |
| 11 | [Modes — eager vs lazy](./spec/11-modes.md) | synchronous `generate` at upload vs the queued default; when to use each |
| — | [Appendix](./spec/appendix.md) | bugs fixed, research + repo review, framework contracts |

**Suggested build order:** 01 → 02 → 03 (foundation) → 04, 05 (seams) → 06, 07 (engine +
worker) → 08 (config/scaffold) → 09 (packaging/tests) → 10 (integration). The
identity helper (03) underpins everything; build and test it first.

---

## What this spec settles (read before building)

The substantive decisions baked in here, settled against real usage across the prior implementations:

1. **Storage is a registered strategy**, not part of the app interface. The worker reaches
   S3 via `ResizeEngine.registerStorage(...)`. The read path is storage-free.
2. **The queue transport owns consumption.** Its interface is `enqueue` + `startWorker`;
   `lease/complete/fail` are transport-internal (Mongo polls, SQS is push-driven). The
   worker is transport-agnostic.
3. **`app` is threaded into transport and storage methods** (stateless strategies;
   bootstrap stays `registerQueueTransport(mongoTransport)`).
4. **Filters are part of the preview identity.** A `300x300` regular preview and a
   `300x300` blurred preview coexist as distinct cached variants. Identity is
   `sizeKey:format:filterSig`; the host defines what a filter *does* to pixels.
5. **Named per-media-type pipelines.** Processing is not one global function. The host
   registers a pipeline per media type — `registerPipeline('photo', { beforeSteps,
   variantSteps })`; the read call selects it **by name** (`resolve({ pipeline:'photo' })`);
   the task carries the name; the worker resolves the functions from its own registry.
   `beforeSteps` are async, run **once** on the original (license-plate / face blur,
   watermark, NSFW mask — host-injected); `variantSteps` run **per variant** after resize.
6. **The uncropped variant is named `fit`** (not `MAX`). `fit` = whole image, aspect
   preserved, downscaled to fit `config.maxSize`, never cropped, never upscaled — the
   "modal / full-view" variant for mixed portrait+landscape uploads. Plain `WxH` sizes are
   `cover` (cropped) implicitly. (`fit` is a standalone size token; there is deliberately
   no separate `fit: cover|contain` property — that would collide.)
7. **Original `width`/`height` are captured.** At upload by the host, and **backfilled by
   the worker** on first process if missing.
8. **Preview S3 keys are random/unguessable** (not content-addressed) — so public preview
   URLs cannot be enumerated.
9. **Readiness is carried, not rendered.** The engine returns `decision.missing`; the
   host's `formatPublicUrls` renders `ready:false`/placeholder for the frontend.
10. **Format negotiation is the host's.** The module generates *all* configured formats
    (the "ground"); each product negotiates/renders however it wants.
10b. **SVG is pass-through, never resized.** An SVG original is served as-is at every
    size/format (the read path short-circuits — [06](./spec/06-read-and-enqueue.md) §17 step 6);
    it's never rasterized or enqueued, and `PreviewFormat` stays the three raster formats. The
    host owns SVG sanitization (XSS/SSRF).
11. **Tests use `node:test`** (zero deps, mirroring `framework-module-email`).
11b. **Two modes from one core.** Lazy/queued is the default ([06](./spec/06-read-and-enqueue.md),
    [07](./spec/07-worker.md)); **eager** (`ResizeEngine.generate`, synchronous at upload, no
    queue/worker/`ResizeTask`) is a documented simpler alternative — same `previews[]` shape, so
    a host can switch or mix. See [11 · Modes](./spec/11-modes.md).
11c. **Scaffold = thin re-exports.** The framework auto-scans `src/models`/`src/commands` by
    filename, so `ResizeTask`/`ResizeWorker` are 1-line re-exports of module-owned definitions
    (schema/behavior stay in npm; host injects only the `ref`) — no vendored-copy drift.
12. **Poison tasks are capped.** A task retries up to `config.maxAttempts` (default 3),
    then **dead-letters** — Mongo `status:'dead'` (retained ~30d, replayable) or SQS DLQ
    via the queue's redrive policy. New `onTaskDeadLettered` observer.
13. **Research-backed encode + hardening.** Per-format `quality`/`effort` (sharp codec
    defaults differ; JPEG q80 ≈ AVIF q64 ≈ WebP q82), an **idempotent-worker** invariant
    (queues are at-least-once), and a `limitInputPixels` decompression-bomb guard + SSRF note.

**Deep-research + reference-repo review done** (2026-06-26): a 29-source / 23-verified-claim
research pass ([Appendix B](./spec/appendix.md) · [research-report.md](./spec/research-report.md))
plus **reading the actual source** of 5 reference repos — mongomq2, mongodb-queue, AWS DIT,
imgproxy, thumbor ([Appendix C](./spec/appendix.md#c-reference-repo-source-review-2026-06-26)).
The architecture was validated, and the review caught **two real bugs** (lease-fencing token on
`complete`/`fail`; watermark must run per-variant, not on the original) plus a batch of hardening
wins — all folded into `04`/`05`/`07`/`08`. Remaining open gaps are flagged honestly in Appendix B/C.

---

## §22. Definition of done

1. Builds to `dist`, ESM, `tsc`+biome clean.
2. `ResizeEngine.resolve` returns correct ready/missing (incl. filtered variants), runs
   the cross-cutting hooks, threads the pipeline name into enqueue; never fabricates a
   DTO; enqueue failure never throws into the read.
3. Mongo transport: `enqueue` + atomic `lease` + reclaim + `complete/fail` +
   `maxAttempts`→dead-letter sweep, deduped by the two-tier framework `Lock`
   (`resize_dispatch:*` / `resize_worker:*`, keyed by identity).
4. `ResizeWorker` (transport-agnostic via `startWorker`) runs the named pipeline's
   `beforeSteps` once, then generates avif/webp/(jpeg) previews with EXIF rotation, `fit`
   inside/no-upscale, per-variant `variantSteps`/filters, bounded concurrency, random keys,
   `$push`, original-dims backfill, both-tier lock release; clean no-op when disabled.
5. Storage strategy registered and used by the worker; read path works without it (except
   optional signed-original).
6. `resize/scaffold` emits an editable `ResizeTask` model (+ `pipeline`/`filters`/`fit`) +
   config into a host app; `--check` reports drift.
7. No `@adaptivestone/framework` / `mongoose` import anywhere; only `TMinimalResizeApp`.
8. `node:test` suite ([09](./spec/09-packaging-and-tests.md#20-tests-nodetest-mirroring-the-email-module-no-live-awsmongo-where-avoidable))
   green.
9. README documents install, the registrations (transport, storage, pipelines, hooks),
   scaffold, worker, upload-time dims capture, and the real per-entity size catalogs.
