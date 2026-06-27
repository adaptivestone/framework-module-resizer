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
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT',  () => controller.abort());
  await transport.startWorker(app, (task) => handle(app, task, transport), { signal: controller.signal });
  app.logger.info('resize worker stopped');
}
// handle = processTask → complete (mongo, leaseToken-guarded) / ack (sqs) → afterTaskComplete;
//          on throw → transport.fail: retries (backoff) up to config.maxAttempts (onTaskFailed
//          each attempt), then dead-letters (onTaskDeadLettered). See 05 · Transport §10.2.
//          The Mongo transport wraps handleTask in a heartbeat (renew at leaseMs/2) so a long
//          resize keeps its lease. (Graceful: finish in-flight, then stop.)
```

`processTask(app, { mediaId, pipeline, previews })` (`src/resizeTask.ts`):

1. Load media by id (via `config.mediaModelName`). If no `original` → return (log).
   **Defensive SVG guard:** if `original` is SVG (`contentType === 'image/svg+xml'` /
   `format === 'svg'`) → complete the task as a no-op (log). SVG is pass-through and should
   never be enqueued (the read path short-circuits it — [06](./06-read-and-enqueue.md) §17
   step 6); this guard only stops a stray task from rasterizing it or looping.
2. **Download the original once** (`storage.download`). If no storage → throw.
3. `origMeta = await sharp(buf).metadata()`; capture the **true** original `origW0/origH0`.
   **Source-pixel guard (before any decode/resize):** if `origW0*origH0 > config.maxSourcePixels`
   → fail the task (image-bomb defense at the metadata stage, à la imgproxy — cheaper than the
   decoder-level `limitInputPixels`). **Backfill:** if `media.original.width/height` are missing,
   include `$set: { 'original.width': origW0, 'original.height': origH0 }` in the final update.
4. Resolve the named pipeline (`getPipeline(pipeline)`); run its **`beforeSteps`** chain
   over `buf` once: `buf = await step(buf, { media, metadata: origMeta, ctx })`.
5. `procMeta = await sharp(buf).metadata()`; use `procW/procH` for resize math.
6. Build the existing-preview set from `media.previews` (identity
   `getPreviewIdentity(sizeKey, format, filters)`).
7. For each requested preview, **bounded by `config.workerConcurrency`** (default 4 — do
   NOT use unbounded `Promise.all`):
   - If it already exists → skip and release its **dispatch** lock.
   - Acquire the **worker lock** `resize_worker:${mediaId}:${identity}` TTL
     `config.lockTtlMs.worker` (default 120s). If not acquired → skip.
   - `{ width, height } = calculateResizedDimensions(procW, procH, reqW, reqH, variant.fit, config.maxSize)`.
   - Build the sharp pipeline (`.rotate()` on **every** branch — EXIF; every `sharp()` call
     in the worker uses `{ failOn: 'none', limitInputPixels: config.limitInputPixels }`):
     ```ts
     // for the cover branch, clamp width/height to config.maxResultDimension first (fit is already capped by maxSize)
     let img = sharp(buf, { failOn: 'none', sequentialRead: true,
                            limitInputPixels: config.limitInputPixels, animated: config.animated })
       .rotate()  // = autoOrient(): orient by EXIF tag, then strip it — MANDATORY on every branch
       .resize(width, height,
         variant.fit ? { fit: 'inside', withoutEnlargement: true } : { fit: 'cover', position: 'center' });
     for (const step of pipeline.variantSteps ?? []) img = await step(img, { variant, ctx }); // per-variant filters/watermark
     img = img.toColorspace('srgb');  // normalize wide-gamut → sRGB before encode (AWS converts, doesn't just drop ICC)
     ```
   - Encode by format with **per-format** settings: `jpeg({ quality: config.quality.jpeg })`,
     `webp({ quality: config.quality.webp, effort: config.effort.webp })`,
     `avif({ quality: config.quality.avif, effort: config.effort.avif })`. Encode via
     `toBuffer({ resolveWithObject: true })` and set `contentType` from the **actual encoded**
     `info.format` (`image/${info.format}`), not the requested format. (Never reuse one quality int
     across codecs — see [08 · Config](./08-config-and-scaffold.md).)
   - Upload to the **public** bucket with a **random/unguessable** key
     `${prefix}/${randomBytes(16).hex}.${format}` (prefix = original key's folder).
   - Collect `{ bucket, key, sizeKey, filters, format, contentType, actualWidth: width,
     actualHeight: height, requestedWidth?, requestedHeight?, fit? }`.
   - On error: log, release the worker lock, continue (one bad variant must not fail the
     whole task).
8. `$push` all generated previews (and the backfill `$set`) in **one** media update.
9. Release every dispatch + worker lock for processed variants (success and error paths).
10. Fire `onPreviewGenerated` (observer) per preview.

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
