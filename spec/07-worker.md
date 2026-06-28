# 07 · Worker

> Part of the [`@adaptivestone/framework-module-resize` build spec](../BUILD-SPEC.md).
> Prev: [06 · Read & enqueue](./06-read-and-enqueue.md) · Next: [08 · Config & scaffold](./08-config-and-scaffold.md)

The async side: a transport-agnostic loop plus `processTask`, where the named pipeline's
`beforeSteps` run once, then each variant is resized (`cover` or `fit`), passed through
`variantSteps`, encoded, uploaded, and `$push`ed.

---

## §11. Worker (`src/worker.ts` + `src/resizeTask.ts`)

`runResizeWorker(app)` is the transport-agnostic entry; `ResizeWorker` is a thin
`AbstractCommand`-shaped class whose `run()` calls it (host registers it via scaffold or
re-export and launches `npm run cli ResizeWorker`).

```ts
async function runResizeWorker(app) {
  const config = getResizeConfig(app);
  if (config.workerEnabled === false) { app.logger.info('resize worker disabled (workerEnabled=false)'); return; }
  const transport = getActiveTransport();
  if (!transport) { app.logger.error('resize worker: no queue transport registered'); return; }
  // Tune sharp ONCE for a concurrent worker: keep workerConcurrency × sharp.concurrency ≈ nCPU
  // (avoid libvips thread oversubscription), and disable the op-cache (distinct images per task).
  sharp.concurrency(config.sharpConcurrency);
  sharp.cache(config.sharpCache);
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT',  () => controller.abort());
  // The worker only supplies the WORK. The TRANSPORT owns completion/redelivery (05 · §10.1):
  // it runs lease → handleTask → complete | fail, keeping the leaseToken/attempts in its own
  // closure (they never ride on `task`). processTask SUCCEEDS by returning, FAILS by throwing.
  await transport.startWorker(app, (task, taskOpts) => processTask(app, task, taskOpts), { signal: controller.signal });
  app.logger.info('resize worker stopped');
}
// Completion + observer firing are the TRANSPORT's job (05 · §10.2), not the worker's:
//   returns → transport.complete (mongo, leaseToken-guarded) / ack (sqs) → fire afterTaskComplete
//   throws  → transport.fail: retry (backoff) up to config.maxAttempts (fire onTaskFailed each
//             attempt), then dead-letter (fire onTaskDeadLettered). SQS: throw → redeliver → DLQ.
// processTask itself fires onPreviewGenerated per preview it writes. The Mongo transport wraps
// handleTask in a heartbeat (renew at leaseMs/2) so a long resize keeps its lease. (Graceful:
// finish in-flight, then stop on opts.signal.)
```

`processTask(app, { mediaId, pipeline, previews }, taskOpts?)` (`src/resizeTask.ts`).
`taskOpts?.signal` is the per-task lease-loss `AbortSignal` (§10.2 `renew`); between variants
(step 7) the loop checks `taskOpts?.signal?.aborted` and stops launching new variants if set —
**best-effort only**; correctness holds via the fencing token regardless:

   Throughout `processTask`, **`ctx = {}`** — the read-path ctx does not cross the queue
   ([04 · Pipelines](./04-pipelines-and-hooks.md) §8); pipeline steps depend on `media`/`metadata`.
1. Load media by id (via `config.mediaModelName`). If no `original` → **return** (log) — a
   no-op success; the transport then marks the task complete.
   **Defensive SVG guard:** if `original` is SVG (`contentType === 'image/svg+xml'` /
   `format === 'svg'`) → **return** (no-op success; log). SVG is pass-through and should
   never be enqueued (the read path short-circuits it — [06](./06-read-and-enqueue.md) §17
   step 6); this guard only stops a stray task from rasterizing it or looping.
2. **Download the original once** (`storage.download`). If no storage → throw.
3. `origMeta = await sharp(buf).metadata()`. **Use DISPLAY orientation for ALL dimension math** —
   `.rotate()` auto-orients before resize, and EXIF orientations 5–8 swap width/height, so the
   *stored* dims are wrong for rotated phone photos:
   `const o = origMeta.orientation ?? 1; const [dispW, dispH] = o >= 5 ? [origMeta.height, origMeta.width] : [origMeta.width, origMeta.height]`.
   **Source-/animation-pixel guard (before any decode/resize):** `const frames = config.animated ?
   Math.min(origMeta.pages ?? 1, config.maxAnimationFrames) : 1`; if
   `origMeta.width * origMeta.height * frames > config.maxSourcePixels` → **throw** (image-/animation-bomb
   defense at the metadata stage, à la imgproxy — cheaper than the decoder-level `limitInputPixels`);
   the transport fails it → retries → dead-letters (a fixed-size oversized source won't recover, so
   surfacing it as dead is correct). **Backfill the DISPLAY dims** if missing:
   `$set: { 'original.width': dispW, 'original.height': dispH }` in the final update.
4. Resolve the named pipeline (`getPipeline(pipeline)`); run its **`beforeSteps`** chain
   over `buf` once: `buf = await step(buf, { media, metadata: origMeta, ctx })`.
5. `procMeta = await sharp(buf).metadata()`; derive **display** `procW/procH` the same way (swap when
   `procMeta.orientation >= 5`) and use those for resize math (since `.rotate()` runs before `.resize()`).
6. Build the existing-preview set from `media.previews` (identity
   `getPreviewIdentity(sizeKey, format, filters)`).
7. **Decode the original ONCE** into a base pipeline, then process each requested preview
   **bounded by `config.workerConcurrency`** (default 4 — NOT unbounded `Promise.all`), cloning
   the base per variant so the decode is shared across all variants (not redone N times):
   ```ts
   const base = sharp(buf, { failOn: 'none', sequentialRead: true,
     limitInputPixels: config.limitInputPixels, animated: config.animated,
     pages: config.animated ? config.maxAnimationFrames : 1 });
   ```
   For each requested preview:
   - If it already exists (in the step-6 existing-preview set) → skip and release its
     **dispatch** lock. *(This DB check — not the lock — is what makes re-runs idempotent.)*
   - Acquire the **worker lock** `resize_worker:${mediaId}:${identity}` TTL
     `config.lockTtlMs.worker` (default 60s, **must be ≤ `config.leaseMs`** — see the doneness
     invariant below). The lock is **best-effort dedup only** (avoids two concurrent tasks
     double-generating the same variant). If not acquired → **skip** this variant and leave it
     missing; a later read re-detects and re-enqueues it. Do **not** treat a lock-skip as "done".
   - `{ width, height } = calculateResizedDimensions(procW, procH, reqW, reqH, variant.fit, config.maxSize)` (cover branch: clamp each provided side to `config.maxResultDimension`; `fit` is already capped by `maxSize`).
   - Build the per-variant pipeline by **cloning the base** (`.rotate()` on **every** branch, normalize colorspace **before** `variantSteps`, sharpen after downscale, flatten alpha only when the output is jpeg):
     ```ts
     let img = base.clone()
       .rotate()                                  // autoOrient by EXIF then strip — MANDATORY, every branch
       .resize(width, height,
         variant.fit ? { fit: 'inside', withoutEnlargement: true } : { fit: 'cover', position: 'center' })
       .toColorspace('srgb');                     // normalize BEFORE variantSteps so composited overlay colors are predictable
     const sharpenOn = variant.fit ? config.sharpen && config.sharpen.fit : config.sharpen && config.sharpen.cover;
     if (sharpenOn) img = img.sharpen();          // mild unsharp to recover Lanczos downscale softening
     for (const step of pipeline.variantSteps ?? []) img = await step(img, { variant, ctx }); // watermark/filters, post-resize
     if (format === 'jpeg' && procMeta.hasAlpha) img = img.flatten({ background: config.flattenBackground }); // else transparent → black
     ```
   - Encode by format with **per-format** settings:
     `jpeg({ quality: config.quality.jpeg, mozjpeg: config.mozjpeg, chromaSubsampling: config.chromaSubsampling })`,
     `webp({ quality: config.quality.webp, effort: config.effort.webp, smartSubsample: config.chromaSubsampling === '4:4:4' })`,
     `avif({ quality: config.quality.avif, effort: config.effort.avif })`. Encode via
     `toBuffer({ resolveWithObject: true })` and set `contentType` from the **actual encoded**
     `info.format` (`image/${info.format}`), not the requested format. (Never reuse one quality int
     across codecs — see [08 · Config](./08-config-and-scaffold.md).)
     > **Color note:** `toColorspace('srgb')` sets the working space but does **not** ICC-transform a
     > tagged **Display-P3 / Adobe RGB / CMYK** source — and sharp strips ICC by default, so such a
     > source would be reinterpreted as sRGB (visible shift). Verify against a P3 and a CMYK sample;
     > either keep the source profile (`.keepIccProfile()`) so the browser color-manages, or do a real
     > profile→sRGB transform before stripping.
   - Upload to the **public** bucket with a **random/unguessable** key
     `${prefix}/${randomBytes(16).toString('hex')}.${format}` (prefix = original key's folder).
   - Collect `{ bucket, key, sizeKey, filters, format, contentType, actualWidth: info.width,
     actualHeight: info.height, requestedWidth?, requestedHeight?, fit? }` — **`actualWidth/Height`
     come from the encoded `info`, not the resize box** (box ≠ output for `fit`, and `info` already
     reflects the post-rotate dims).
   - On error: log, release the worker lock, **record this variant as failed**, and continue (one
     bad variant must not fail the whole task — but see step 10).
8. `$push` all generated previews (and the backfill `$set`) in **one** media update. Fire
   `onPreviewGenerated` per pushed preview.
9. Release every dispatch + worker lock for processed variants (success and error paths).
10. **Poison-variant guard.** If this run produced **zero** new previews **and** ≥1 variant errored,
    **throw** (after releasing locks) so the transport's retry → backoff → dead-letter path engages.
    Without it, a deterministically-failing variant makes the task "succeed" every time → the next
    `resolve` re-enqueues it → it loops forever with no operator signal. (A run that produced *some*
    previews returns success; its still-missing variants are simply re-enqueued by the next read.)

> **Doneness invariant (prevents silent loss).** The DB `media.previews[]` set — **not** task
> status, **not** lock state — is the single source of truth for what exists. `processTask`
> returning (→ the transport marking the task `completed`) does **not** assert every requested
> variant was produced: a variant that was skipped (lock held) or errored is simply absent from
> `previews[]`, and the next `resolve` re-detects it as missing and re-enqueues it. Because
> `lockTtlMs.worker ≤ leaseMs`, a worker that crashes mid-task has its in-flight worker locks
> expire within the lease window, so the re-leased (or next-read) task can regenerate the
> skipped variant promptly rather than waiting out a longer lock TTL. (A worker lock is **not**
> renewed; if a live task runs longer than the TTL its lock may lapse, at worst letting a rare
> concurrent task regenerate the same variant — a harmless duplicate row/object, the same
> accepted orphan limitation as a crash, never data loss.)

**Why `fit` exists (and why `.rotate()` is mandatory on it):** users upload a mix of
portrait and landscape originals. Grid/thumbnail variants use `cover` (cropped to a fixed
box). The **modal / full view must not crop** — it shows the whole image at its **original
aspect ratio**, merely downscaled to fit `config.maxSize` by the constraining side, never
upscaled. That is `fit:'inside'` + `withoutEnlargement:true` + the `maxSize` cap. A prior
implementation shipped this variant but **omitted `.rotate()` on its branch**, so portrait
phone photos rendered sideways *only in the modal* — exactly the path `fit` serves. Rotate on
every branch.

---

## Known limitation — orphaned derivatives (accepted for v1)

Preview S3 keys are random (unguessable), and the upload (step 7) happens before the
single `$push` (step 8). If the worker dies *after* uploading some variants but *before*
the `$push`, those S3 objects are orphaned: on the next lease the existing-preview check
(step 6) doesn't see them (no `previews[]` row was written), so they're regenerated under
fresh random keys. Generation stays correct; only storage accumulates a few orphans.

This is accepted for v1 — derived-image **cleanup/lifecycle is host-owned and out of scope**
(see [01 · Architecture §15](./01-architecture.md)). A host that cares can reconcile
storage against `previews[]` periodically, or (future) switch to content-addressed keys
(rejected here for URL unguessability — see
[Appendix B](./appendix.md#b-deep-research-findings)).
