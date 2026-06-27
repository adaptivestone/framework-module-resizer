# Deep-research report — lazy / on-demand image-resize

> Generated 2026-06-27 by the deep-research harness. **6 angles → 29 sources fetched →
> 138 claims extracted → top 25 adversarially verified (3 skeptics each) → 23 confirmed,
> 2 killed → 17 after de-dup.** 112 agents, ~1.79M tokens, ~23 min. Raw output:
> `…/tasks/wbos01vvz.output`. Condensed conclusions live in [appendix.md](./appendix.md).

## Executive summary

The verified evidence strongly validates the spec's core architecture. AWS's reference
implementation (Serverless Image Handler → "Dynamic Image Transformation for CloudFront")
confirms the exact pattern as production-proven: on-demand generation (no pre-rendered
variant copies), Sharp/libvips as the engine, a CDN in front, S3 for durable originals. For
the queue, SQS (maxReceiveCount→DLQ + redrive) and two MongoDB-as-queue libraries (mongomq2,
mongodb-queue) implement precisely the atomic-lease / visibility-timeout / dead-letter
pattern — validating the "no new infra" choice — with the load-bearing caveat that delivery
is **at-least-once**, so the worker MUST be idempotent. For formats, sharp's defaults support
per-format tuning (JPEG/WebP ~80, AVIF 50 with a credible case for 64; effort default 4, AVIF
pushable higher) and confirm AVIF is CPU-heavy "encode-once-decode-many" — itself the
strongest argument for caching derivatives. `.rotate()` no-args is confirmed correct
(delegates to `autoOrient()`), but a historical bug shows it must be applied on every branch.
SSRF hardening for remote-origin fetches is essential.

---

## Confirmed findings (verified, with evidence)

### Architecture & topology

**F1 — On-demand model is the reference pattern.** `[high · 3-0, merged from 3]`
AWS DIT docs: "enables real-time image processing … eliminating the need for pre-processing
images or maintaining multiple versions"; repo: "By dynamically transforming a single source
image on-demand, it eliminates the need to store multiple versions." **Difference vs us:**
AWS caches results only at CloudFront and does NOT write derivatives back to S3; we persist
to S3+CDN — better for expensive AVIF (encode-once).
Sources: docs.aws.amazon.com/solutions/latest/serverless-image-handler/{architecture,welcome}.html ·
aws.amazon.com/blogs/architecture/fast-and-cost-effective-image-manipulation-with-serverless-image-handler/

**F2 — sharp/libvips is the production engine of choice.** `[high · 3-0]`
AWS: "It uses Sharp to provide high-speed image processing without sacrificing image
quality." (~3–5× ImageMagick.) Our engine choice matches the de-facto baseline.
Sources: AWS SIH architecture docs · AWS 2019 "Now Leverages Sharp" announcement.

**F3 — CDN-in-front + object storage is the textbook topology.** `[high · 3-0]`
AWS: "CloudFront for global content delivery and Amazon S3 for reliable and durable cloud
storage." Flow: CloudFront → (miss) → API GW → Lambda+Sharp → S3 original → return, cached at
edge. **Caveat:** the peer claim "CloudFront caching is the PRIMARY stampede mitigation" was
REFUTED (see R1) — explicit single-flight/locking is still required.
Source: AWS SIH architecture docs.

**F4 — Transforms exposed as URL params OR presets (allowlist mechanism).** `[medium · 2-1 split]`
AWS: "Users can specify image transformations either through URL query parameters or
predefined transformation policies." Policies ≈ allowlisted presets. **Why 2-1:** AWS frames
policies as consistency presets, not security; query params can override them, so presets
alone don't stop resize-bombing without request-signing. **Recommendation:** presets restrict
the menu; **signed URLs** restrict who can order — pair them.
Source: AWS SIH welcome docs.

### Queue / reliability

**F5 — SQS maxReceiveCount controls dead-lettering; don't set it to 1.** `[high · 3-0]`
AWS: "the number of times a consumer can receive a message … before it is moved to a DLQ …
set the maxReceiveCount high enough to allow for sufficient retries." Default 10 (range
1–1000). Our `maxAttempts` is the analog; ~3–5 balances poison-isolation vs resilience.
Source: AWS SQS dead-letter-queues developer guide.

**F6 — SQS DLQs isolate poison messages + support redrive to source.** `[high · 3-0]`
"DLQs are useful for debugging … isolate unconsumed messages." Redrive (StartMessageMoveTask)
GA June 2023. **Recommendation:** our Mongo-DLQ design must also support a redrive/requeue
(replay) path — which it does (reset `status:'pending'`).
Sources: AWS SQS DLQ guide · AWS compute blog (DLQ redrive).

**F7 — MongoDB-as-queue is a viable "no new infra" default.** `[high · 3-0, merged from 3]`
`mongomq2`: consumers "bound by findOneAndUpdate"; "Configurable visibility timeouts",
"Configurable number of retries", deadLetter events. `mongodb-queue`: "we always use
MongoDB's … findAndModify() so that each message is updated atomically"; default 30s
visibility, auto-return if unacked. Our atomic-lease + visibility default is directly
supported by two real libraries — don't reinvent; borrow patterns.
Sources: github.com/morris/mongomq2 · github.com/chilts/mongodb-queue.

**F8 — The worker MUST be idempotent (at-least-once delivery).** `[high · 3-0]` ⚑ design-critical
`mongomq2`: "at-least-once delivery to queue consumers. Effectively exactly-once if consumer
workloads are idempotent." The queue cannot guarantee exactly-once. **Recommendation:** the
resize worker must produce the same output for the same `(sourceId, size, format, filter)` and
tolerate re-running a task that already produced a derivative (deterministic key / upsert /
check-then-skip). Intersects knob (a): deterministic keys make idempotent re-runs trivially
safe; random keys risk orphaned duplicates on retry.
Source: github.com/morris/mongomq2.

**F9 — Poison-message dead-lettering emulated on plain MongoDB.** `[high · 3-0]`
`mongodb-queue` source: option `deadQueue`, counter `tries` (`$inc tries:1`), default
`maxRetries=5`, "if (msg.tries > self.maxRetries) { self.deadQueue.add(msg) }". The deadQueue
is itself a Mongo collection → truly no new infra. Our maxAttempts ~3–5 aligns.
Source: github.com/chilts/mongodb-queue.

### Encoding (formats / quality / effort)

**F10 — sharp's default quality differs per format; do NOT share one value.** `[high · 3-0]` ⚑ knob (c)
sharp docs: JPEG 80, WebP 80, AVIF 50. Cross-format numbers aren't perceptually comparable
(JPEG 80 ≈ AVIF 64 ≈ WebP 82). **Recommendation:** configure quality per format —
JPEG 80, WebP 80, AVIF 50–64. (Applied: `quality.{jpeg:80,webp:80,avif:64}`.)
Sources: sharp.pixelplumbing.com/api-output/ · github.com/lovell/sharp/issues/4227.

**F11 — sharp `effort` ranges/defaults are per-codec.** `[high · 3-0]` knob (c)
WebP 0–6 (default 4); AVIF 0–9 (default 4). Because generation is async + cached
(encode-once), you can afford higher effort (AVIF/WebP 4–6) — trade worker CPU for smaller
files. Do NOT raise effort if regenerating per-request (we are not).
Source: sharp.pixelplumbing.com/api-output/.

**F12 — AVIF is CPU-intensive "encode-once decode-many."** `[high · 3-0]`
sharp maintainer (issue #4227): AVIF quality passed unaltered to libheif (libaom
`cq_level = ((100-quality)*63+50)/100`); "It's all rather CPU intensive so … AVIF remains
very much a format suitable for encode-once decode-many." Validates decoupling resize onto an
async worker and persisting/CDN-caching the AVIF derivative.
Sources: github.com/lovell/sharp/issues/4227 · github.com/strukturag/libheif.

**F13 — JPEG q80 ≈ AVIF q64; maintainer considered (didn't ship) raising the AVIF default.** `[high · 3-0]`
sharp maintainer #4227: "a JPEG quality of 80 is equivalent to an AVIF quality of 64 … I
could … default AVIF quality to a more comparable 64." industrialempathy table: JPEG q80 =
AVIF q64 = WebP q82. **Caveat:** the study used only 4 images and is encoder-dependent —
validate on your own corpus.
Sources: github.com/lovell/sharp/issues/4227 · industrialempathy.com/posts/avif-webp-quality-settings/.

### EXIF orientation

**F14 — `.rotate()` no-args = `autoOrient()` (orient by EXIF tag, then strip).** `[high · 3-0, merged]`
sharp docs: "if no angle is provided, .autoOrient() will be called"; autoOrient = "Auto-orient
based on the EXIF Orientation tag, then remove the tag. Mirroring … may infer the use of a
flip." Our EXIF approach is correct. (Explicit `.autoOrient()` exists since sharp 0.33.)
Sources: sharp.pixelplumbing.com/api-operation/ · github.com/lovell/sharp/issues/3422.

**F15 — Auto-orientation must be applied on EVERY branch (incl. fit/inside).** `[high · 3-0]`
Issue #3422 (sharp 0.31.1): "All of these images have an exif orientation, but are not
automatically oriented. If you add a resize(200,200) … it will however rotate them
correctly." Fixed 0.31.2; current 0.33+/0.34+ auto-orients on its own. **Recommendation:**
still apply rotate explicitly+consistently on both cover and inside branches, before
resize/extract — exactly the shared pipeline-builder concern the spec encodes.
Source: github.com/lovell/sharp/issues/3422.

### Security (SSRF on remote-origin fetch)

**F16 — Never accept full user-supplied URLs; allowlist the host/IP.** `[high · 3-0]`
OWASP SSRF cheat sheet: "Do not accept complete URLs from the user because URL are difficult
to validate and the parser can be abused"; "only accept a valid IP address or domain name"
against an allowlist. **Recommendation:** reference originals by internal `sourceId`/bucket+key,
not raw URLs.
Source: cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html.

**F17 — Disable redirect-following on the originals-fetch client.** `[high · 3-0]`
OWASP: "Disable the support for the following of the redirection … to prevent the bypass of
the input validation." Corroborated by PortSwigger. Combine with host-allowlist + private-IP
blocking.
Sources: OWASP SSRF cheat sheet · portswigger.net/web-security/ssrf.

---

## Refuted claims (killed by adversarial verification)

**R1 — "CloudFront caching is the PRIMARY thundering-herd/stampede mitigation."** `[0-3 ✗]`
A cached variant is served from the edge, but the CDN does NOT coalesce concurrent
*first-requests* for an *uncached* variant. **Consequence:** our two-tier dispatch/worker
Mongo lock is doing real, necessary work — do not lean on the CDN for first-request
coalescing.
Source (claimed): AWS architecture blog.

**R2 — "sharp's AVIF default 50 was deliberately chosen at the middle of the range to match libheif's own default."** `[0-3 ✗]`
Not supported by the evidence; the default is just the library default, and the maintainer
discussed raising it to 64. Don't treat 50 as a tuned optimum.
Source (claimed): github.com/lovell/sharp/issues/4227.

---

## Caveats & scope

- The 23 surviving claims **heavily cover** AWS's reference architecture, queue/lease
  backends, sharp format/effort/EXIF, and SSRF. They do **not** cover: Q1 thundering-herd
  single-flight specifics for imgproxy/thumbor; Q3 content-addressed vs random keys (no
  surviving claim — imgproxy/thumbor/Next behavior unverified here); Q4 format-NEGOTIATION
  mechanism (emit-all vs Accept vs `<picture>`, when to drop JPEG); Q6 sharp
  decompression-bomb limits (`limitInputPixels`/`failOn`/`sequentialRead`); Q7 "Generating…"
  UX (LQIP/BlurHash/dominant-color, push vs poll); Q9 derivative lifecycle/TTL. Absence is a
  gap, not a negative result.
- **Time-sensitivity:** sharp encoder defaults shift between versions (e.g. 0.35.0 changed the
  AVIF lossy "tune" to `iq`/ssimulacra2 while keeping quality 50) — pin your sharp version and
  re-test. `mongodb-queue` switched internally findAndModify→findOneAndUpdate (semantics
  unchanged). "Serverless Image Handler" renamed "Dynamic Image Transformation for CloudFront"
  (architecture unchanged on cited points).
- **Source quality:** anchored in primary sources (AWS docs, sharp docs/issues by the
  maintainer, OWASP, library READMEs/source). The JPEG80≈AVIF64 equivalence rests on a
  4-image dssim study — validate on your corpus. The F4 presets-as-security finding is medium
  (partly the claimant's inference).

## Open questions (still unresolved)

1. **Storage keys (knob a):** no surviving evidence settled deterministic vs random. The
   idempotency finding (F8) leans deterministic (retry overwrites same key, free dedup) but
   trades away unguessability. If keeping random, add an exactly-once-ish guard (unique index
   on identity + check-before-write). Research's own lean: signed URLs over deterministic keys
   (dedup AND access control) — but that conflicts with our public CDN-cached previews.
2. **Format negotiation (knob b):** emit-all vs Accept vs `<picture>`, and the precise JPEG-drop
   browser threshold — unresolved. Emit-all = simplest CDN; Accept = fewer bytes but
   Vary/cache-key complexity.
3. **Thundering-herd / single-flight (Q1):** what imgproxy/thumbor/imaginary actually do for
   concurrent first-requests; is a two-tier Mongo lock equivalent to HTTP-layer
   request-coalescing? (CDN-as-mitigation refuted — needs its own answer.)
4. **sharp hardening (Q6) + lifecycle (Q9):** no surviving claim on `limitInputPixels`,
   `failOn`, `sequentialRead`, concurrency/memory tuning, or orphaned-derivative reaping.
   Likely the most important gaps to close next.

## Sources (29 fetched)

Primary: AWS SIH/DIT architecture+welcome docs · AWS SQS DLQ guide · AWS DLQ-redrive blog ·
github.com/morris/mongomq2 · github.com/chilts/mongodb-queue · sharp.pixelplumbing.com
(api-output, api-operation) · sharp issues #4227, #3422 · OWASP SSRF cheat sheet ·
web.dev/articles/choose-the-right-image-format · docs.imgproxy.net/configuration/options ·
imgproxy.net/blog/v4-caching · thumbor.readthedocs.io/en/latest/security.html ·
nextjs.org/docs/app/api-reference/components/image.
Secondary/blog: evilmartians.com/chronicles/introducing-imgproxy · imgproxy.net benchmark ·
victoriametrics.com/blog/go-singleflight · redis.antirez.com cache-stampede ·
varnish-software request-coalescing · judoscale.com node-task-queues · oneuptime mongodb-queue
· pkgpulse bullmq-vs-pg-boss · web.dev/serve-responsive-images · unpic.pics/learn ·
blog.cloudflare.com vary-for-images · industrialempathy.com avif-webp-quality-settings ·
portswigger.net/web-security/ssrf · 1xapi.com nodejs cache-stampede.

## Stats

`6 angles · 29 sources · 138 claims extracted · 25 verified · 23 confirmed · 2 killed ·
17 after synthesis · 7 budget-dropped · 112 agent calls`
