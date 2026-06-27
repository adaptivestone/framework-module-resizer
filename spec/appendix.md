# Appendix · Bugs fixed & research

> Part of the [`@adaptivestone/framework-module-resize` build spec](../BUILD-SPEC.md).
> Prev: [11 · Modes](./11-modes.md)

---

## A. Bugs this spec fixes

This spec consolidates the lessons of several prior production image-resize
implementations (SQS- and Mongo-queue based, with both flat and nested DTO shapes). It is
authoritative where they differed. The concrete bugs and gaps it resolves, observed across
those implementations:

- **`.rotate()` missing.** EXIF orientation wasn't applied, so portrait phone photos
  rendered sideways. One implementation omitted it entirely; another omitted it *only on the
  uncropped/modal branch* (sideways only in the full view, exactly the path `fit` serves). →
  rotate on **every** branch.
- **Original dimensions never persisted.** A `canUseOriginal` "serve the original" fast-path
  was permanently dead because width/height were never captured. → capture at upload +
  backfill in the worker.
- **Filters keyed but never applied.** Variant signatures encoded filters that no code
  applied and no caller used. → genuine host-applied `variantSteps`, plus an
  empty-filter-bag canonicalization bug fixed.
- **Enqueue failures swallowed while the dispatch lock was held.** A failed enqueue left the
  lock to expire, blocking retries. → release the lock on failure.
- **Long fire-and-forget locks.** A single ~30-min lock per job. → two-tier short locks
  (dispatch + worker).
- **Hand-built keys mismatched.** A `_`-vs-`x` lock-key typo leaked locks; a `620w`
  width-only key split on `'x'` and parsed to `NaN`. → one shared identity / `parseSizeKey`
  helper builds every key.
- **No readiness in the DTO.** The frontend couldn't show a placeholder before a preview
  existed. → readiness carried in `decision`, rendered transparently by `formatPublicUrls`.
- **Synchronous upload-time resize.** `sharp` + S3 on the HTTP create/update path. → lazy,
  queued generation off the request path.

Usage facts that shaped this spec: readiness flags exist purely to let the **frontend** show
a placeholder before a preview is ready (no backend polling exists); format negotiation is
done by the **frontend** `<picture>` element (so the module emits all formats); the worker
was under-deployed in practice (so `workerEnabled` + graceful read degradation are mandatory).

---

## B. Deep-research findings

A deep-research pass (2026-06-26 · 29 sources → 138 claims → 23 verified; adversarial
3-vote verification) against OSS resizers and primary docs. Citations are inline; full
source list at the end.

### Validated (no change — the architecture is sound)

- **Lazy / on-demand generation** is the model AWS's reference solution uses (Serverless
  Image Handler → "Dynamic Image Transformation for CloudFront"): transform on-demand, don't
  pre-generate/store multiple versions. [AWS DIT docs]
- **sharp/libvips** is the de-facto engine (AWS uses it; ~3–5× ImageMagick). [AWS docs]
- **CDN-in-front + object storage** is the textbook topology. [AWS docs]
- **Mongo-as-queue** (atomic `findOneAndUpdate` lease + visibility timeout + dead-letter) is
  a proven "no new infra" pattern — implemented by `mongomq2` and `chilts/mongodb-queue`.
  [mongomq2, mongodb-queue]
- **`maxAttempts` ↔ SQS `maxReceiveCount`→DLQ + redrive.** Avoid 1; sane 3–5 (SQS default 10,
  mongodb-queue 5). Ours: 3. [AWS SQS DLQ guide]
- **`.rotate()` no-args** delegates to `autoOrient()` (orient by EXIF tag, then strip) — correct.
  And the **per-branch gotcha is real**: sharp 0.31.1 didn't auto-orient without another
  transform in the pipeline → apply rotate on **every** branch. [sharp docs, sharp#3422]

### Corrections applied to the spec

- **Per-format encode** ([08](./08-config-and-scaffold.md), [07](./07-worker.md)): sharp
  defaults differ by codec (JPEG 80, WebP 80, AVIF 50) and aren't perceptually comparable —
  JPEG q80 ≈ AVIF q64 ≈ WebP q82. Config is now `quality.{jpeg:80,webp:80,avif:64}` +
  `effort.{webp:4,avif:4}` (AVIF lowered from 6 to sharp's default 4 — see the AVIF-effort
  correction below). AVIF is "encode-once/decode-many" CPU-heavy — which itself
  justifies persisting+caching derivatives over per-request regen. [sharp docs, sharp#4227,
  industrialempathy]
- **Idempotent worker invariant** ([01](./01-architecture.md), [05](./05-transport-and-storage.md)):
  delivery is *at-least-once*; "effectively exactly-once" needs an idempotent consumer. The
  existing-preview check is that guard. [mongomq2]
- **Hardening** ([01](./01-architecture.md), [07](./07-worker.md)): added
  `config.limitInputPixels` (decompression-bomb guard) on every worker `sharp()`; SSRF note —
  the module reads by internal `bucket+key`, but a host fetching remote originals must
  host-allowlist, reject raw user URLs, and disable redirects. [OWASP SSRF]

### Decisions confirmed (kept, with stronger reasoning)

- **Random preview keys (knob a) — stand.** The research's deterministic-key argument is for
  idempotency/dedup, but its recommended pairing is *signed URLs over deterministic keys* —
  which conflicts with our **public, CDN-cached** preview URLs. We keep random (unguessable)
  keys + the existing-preview idempotency guard; orphan-on-crash stays an accepted limitation
  ([07](./07-worker.md)).
- **Emit-all-formats (knob b) — stand.** Accept-header negotiation adds `Vary`/cache-key
  complexity for a CDN; emitting all formats + frontend `<picture>` is simpler for cached
  public previews. *When to drop JPEG* (`webpAvifOnly`) stays the host's call, gated on its
  browser-support floor. [web.dev, Cloudflare Vary-for-images]
- **Two-tier dispatch/worker lock — justified.** The claim "CDN caching is the primary
  stampede mitigation" was **refuted (0–3)** — a CDN does not coalesce concurrent
  first-requests for an uncached variant, so our dispatch lock is doing real work.

### Still open (honest gaps — not blockers)

- **Derivative lifecycle / orphan reaping** when an original is deleted or a transform
  changes — no verified guidance; host-owned ([01 §15](./01-architecture.md)), revisit if it
  bites.
- **Exact JPEG-drop browser threshold** — product/analytics call, not a module default.
- **Quality numbers are corpus-dependent** — JPEG q80 ≈ AVIF q64 rests on a small dssim
  study; pin the sharp version (encoder defaults shift between releases) and validate
  `quality.avif` on a real image sample before committing.

### Sources
AWS DIT/Serverless Image Handler docs · AWS SQS dead-letter-queue guide · `morris/mongomq2` ·
`chilts/mongodb-queue` · sharp docs (api-output, api-operation) · sharp issues #4227, #3422 ·
industrialempathy AVIF/WebP quality study · OWASP SSRF Prevention Cheat Sheet · web.dev
responsive-images · Cloudflare "Vary for images" · imgproxy / thumbor / Next.js image docs.

Full deep-research report (all 17 findings + evidence + votes): [research-report.md](./research-report.md).

---

## C. Reference-repo source review (2026-06-26)

Cloned and **read the actual source** of five reference projects (not just docs) and mapped
patterns back to this spec. Repos: `morris/mongomq2` (TS), `chilts/mongodb-queue` (JS),
`aws-solutions/dynamic-image-transformation-for-amazon-cloudfront` (TS/Node + sharp),
`imgproxy/imgproxy` (Go), `thumbor/thumbor` (Python).

### C1. Mongo queue libs → our Mongo transport (`05`)

Both libs encode lease state in **timestamps only** (no `status`); we use an explicit `status`
enum, which is fine, but the timestamp designs expose guards we were missing.

- **🐞 FIX — fencing/ack token (data-corruption bug).** mongodb-queue mints a random `ack`
  per claim and guards ack/ping with `{ ack, visible:{$gt:now} }` (`mongodb-queue.js:124,192`);
  mongomq2 excludes acked docs by token. **Our `complete`/`fail` keyed on `_id` alone let a
  slow worker A — whose lease expired and was re-leased to B — clobber B's task.** Fix: store a
  random `leaseToken` in the claim's `$set`; make `complete`/`fail`/`renew` filter
  `{ _id, leaseToken, status:'processing', leaseExpiresAt:{$gt:now} }`; 0-matched update ⇒
  worker lost the lease, drop the result. **(Folded into `05`/`08`.)**
- **FIX — lease heartbeat.** Both libs renew (`ping` / `hide`). A resize longer than `leaseMs`
  gets double-claimed. Add `renew(taskId, leaseToken)` called periodically by the worker;
  set `leaseMs` ≥ ~2× worst-case encode regardless. **(Folded into `07`/`08`.)**
- **FIX — retry backoff.** Our `fail → pending` makes a poison task thrash through all attempts
  back-to-back. Add delayed re-lease (`leaseExpiresAt = now + backoff(attempts)`; pending branch
  also honors it). mongomq2 `context.retry(s)`, mongodb-queue `delay`. **(Folded into `05`/`08`.)**
- **NOTE — attempt boundary.** We `$inc attempts` in the claim and return the after-image, so the
  returned `attempts` already counts the current delivery; keep `attempts >= maxAttempts → dead`
  consistent with the claim's `attempts < maxAttempts`. (mongodb-queue dead-letters on
  `tries > maxRetries` post-increment; mongomq2 on `retries >= maxRetries` pre-increment.)
- **NOTE — index.** `{leaseExpiresAt}` *sparse* won't exclude `leaseExpiresAt:null` (pending)
  rows; use `partialFilterExpression:{ status:'processing' }` instead. **(Folded into `08`.)**
- **NOTE — clock skew.** These designs compare app-clock `now` to a stored deadline; document
  the NTP assumption (or anchor timing to the DB clock via `$$NOW`).
- **Validated:** our atomic `findOneAndUpdate` claim, the `$or(fresh, expired)` shape, and our
  **dead-letter sweep + `deadAt` TTL** are sound — the sweep is *better* than both libs (fixes
  mongodb-queue's "crashed worker never dead-letters" and mongomq2's "dead docs accumulate").
  We do **not** add a unique `(fileId,pipeline)` index — our tasks are ephemeral work items
  deduped by the dispatch `Lock`, not long-lived keyed messages. Use `w:'majority'` on
  `ResizeTask.create` for durable enqueue.

### C2. AWS DIT → our sharp pipeline (`07`)

AWS runs two sharp implementations (Lambda + an ECS container worker; the container is closest
to our model).

- **Validated — rotate-before-resize.** AWS resizes *then* rotates (a latent bug: target W/H
  computed on unoriented dims). **Our rotate-before-resize order is correct — keep it.**
- **🐞 FIX — animated images silently flatten.** AWS passes `animated:true` for GIF/WebP and
  re-checks `metadata.pages` (`image-processor.service.ts:62`); our spec never sets `animated`,
  so multi-frame inputs collapse to frame 1. **(Folded into `07` as a documented v1 limitation +
  config flag.)**
- **FIX — `sequentialRead:true`** (`sharp-utils.ts:26`) cuts peak RAM on large/progressive
  JPEGs — add to worker `sharp()` options. **(Folded into `07`.)**
- **FIX — ContentType from the *encoded* output** (`finalImage.info.format`,
  `image-processor.service.ts:80`), not the requested format — set it on PutObject. **(Folded.)**
- **FIX — ICC/colour.** Default sharp strips ICC → colour shift on wide-gamut sources. AWS keeps
  ICC and, when stripping, **converts to sRGB** (`image-handler.ts:47`). Strip metadata for
  privacy (GPS EXIF) but normalize to sRGB. **(Folded into `07`.)**
- **RECONSIDER — AVIF `effort`.** AWS never raises AVIF effort above sharp's default 4. Our
  `effort.avif:6` is a real CPU/latency trap. **Lowered default to 4; raise only if the worker's
  CPU budget allows.** **(Folded into `08`.)**
- **Validated — `limitInputPixels`** (their container default `1e9`); our explicit guard + the
  `2000×1200` `fit` cap are *better* than AWS, which never clamps output dimensions — but **add a
  clamp on the `cover` branch too**. **(Folded into `07`/`08`.)**

### C3. imgproxy → security / limits / config defaults (`08`)

- **FIX — check source pixels *before* decode.** imgproxy reads header dims and rejects "image
  bombs" before allocation (`security/checker.go:53`), with explicit defaults: `MAX_SRC_RESOLUTION`
  **50 MP**, `MAX_RESULT_DIMENSION`, `MAX_SRC_FILE_SIZE`, `MAX_ANIMATION_FRAMES=1`. We already read
  `metadata()` for dims (worker step 3) — add a `origW0*origH0 > config.maxSourcePixels` guard
  there + a max-result-dimension cap. **(Folded into `07`/`08`; default `maxSourcePixels:
  50_000_000`.)**
- **NOTE — presets-only.** imgproxy's anti-resize-bomb tool (`ONLY_PRESETS` /
  `ALLOWED_PROCESSING_OPTIONS`) is its substitute for URL signing. Our size catalogs are
  **host-owned** → the host must treat its catalog as a hard allowlist and never pass raw client
  dims into `resolve`. (Strengthened note in `01 §15`.) We correctly skip URL signing.
- **Validated — quality defaults.** imgproxy q80 / WebP 79 / AVIF 63 ≈ ours jpeg80/webp80/avif64.
  Adopt `autorotate=true` + `strip-metadata=true` (privacy) + `keep-copyright`.
- **NOTE — SSRF.** imgproxy blocks loopback/link-local by default but **allows private addresses
  by default** (foot-gun). Our bucket+key model avoids URL-SSRF; if a host fetches by URL, block
  private/loopback/link-local by default and cap redirects.

### C4. thumbor → our pipeline model (`04`)

thumbor has run this exact detector+filter design in production for years.

- **🐞 FIX — watermark belongs in `variantSteps`, not `beforeSteps`.** thumbor runs watermark
  post-resize because it sizes *relative to output dimensions* (`filters/watermark.py:36`). Baking
  it onto the original once (our beforeSteps example) scales it inconsistently per variant →
  unreadable on small sizes. Same for rounded corners / frames. **(Fixed the example + rule in `04`.)**
- **REFINE — metadata vs pixel steps.** thumbor's "once, cached by source" stage produces only
  *metadata* (focal points / NSFW score), kept tiny; pixel redaction (plate/face blur) is the
  legitimate "bake once" case but makes the shared artifact a full buffer. Distinguish them.
- **REFINE — "run once" is a CACHE keyed by source.** thumbor caches detector data by source url
  (`transformer.py:149`) and dedups the detection queue. Two concurrent tasks for the same source
  can both run detection unless the host caches by source — strengthened the note in `04`.
- **REFINE — degraded-but-don't-persist.** thumbor's `prevent_result_storage` serves a degraded
  result but doesn't cache it (retries next time). A beforeStep "ran degraded → skip `$push`"
  signal — noted in `04` as a v1.1 primitive.
- **FUTURE — focal-point crop.** thumbor crops `cover` around the detector center-of-mass; ours
  uses `position:'center'`. Focal point on `cover` is a natural future enhancement (`fit` never
  needs it). Out of scope v1; noted.
- **NOTE — step order.** Pin that `variantSteps` run in **registration order** (matters when steps
  interact, e.g. blur≠sharpen order). Noted in `04`.

**Net:** the review **confirmed the architecture**, caught **two real bugs** (lease-fencing on
complete/fail; watermark phase) + one silent-flatten gap (animation), and produced cheap hardening
wins (sequentialRead, sRGB, ContentType-from-output, pre-decode pixel guard, AVIF effort 4) — all
folded into `04`/`05`/`07`/`08`.
