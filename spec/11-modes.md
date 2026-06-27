# 11 · Modes — eager (sync) vs lazy (queued)

> Part of the [`@adaptivestone/framework-module-resize` build spec](../BUILD-SPEC.md).
> Prev: [10 · Host integration](./10-host-integration.md) · Next: [Appendix](./appendix.md)

The module supports **two ways to generate previews from the same engine core**. Lazy
(queued) is the default and the subject of files `04`–`08`. **Eager (synchronous, at upload)**
is a simpler alternative for cases where a queue + worker is overkill. A host can pick one, or
mix them.

---

## The two modes at a glance

```
EAGER (sync, on upload)                          LAZY (queued, on read) — default
──────────────────────────                       ──────────────────────────────────────
upload ─▶ generate ALL sizes NOW ─▶ store        upload ─▶ store original only
         (request blocks until done)             read ─▶ resolve(): ready | enqueue ─▶ worker
read ─▶ every preview already present            next read ─▶ ready
                                                 (placeholder/signed-original meanwhile)

needs: storage, media model, (opt) pipelines     needs: + queue transport, ResizeWorker,
NO queue · NO worker · NO ResizeTask · NO locks         ResizeTask model, two-tier locks
simplest; predictable; zero new infra            scales; fast uploads; no wasted variants
```

## When eager makes more sense

- **Low / bursty upload volume** and uploads that aren't latency-critical (an admin uploads a
  photo; a 1–2 s wait to bake variants is fine).
- **Small, bounded size catalogs** you'll almost always use — pre-generating them wastes
  nothing.
- **Single-process deployments** where running a separate worker (and `workerEnabled`,
  scaffolded `ResizeTask`, a queue) is more operational weight than the problem deserves.
- **Strong-consistency reads** — the moment the upload returns, every size is ready; no
  placeholder phase, no "generating…" UX, no eventual consistency to reason about.

## When to stay lazy (the default)

- **High volume / fast uploads matter** — keep `sharp` + S3 off the request path.
- **Large or open-ended catalogs** (per-entity, per-DPR, MAX, filtered variants) where most
  variants are never requested — generate on first demand only.
- You can run a **separate worker** process.

---

## §11.1 Eager API — `ResizeEngine.generate`

Eager mode is just the **shared resize core called inline** (no queue, no lease, no
transport). The host calls it from its own create/update handler.

```ts
class ResizeEngine {
  // Synchronous generation: download once → beforeSteps → per-variant (bounded)
  // resize + variantSteps + encode + upload → returns (and optionally persists) previews.
  static async generate(app: TMinimalResizeApp, opts: {
    media: MediaLike;
    sizes: SizeInput[];
    pipeline?: string;              // same named pipeline registry as resolve() (default 'default')
    formats?: PreviewFormat[];      // default requiredFormats(config)
    ctx?: Record<string, unknown>;
    persist?: boolean;              // default true → $push previews + backfill original dims on the media doc
  }): Promise<{ previews: Preview[] }>;
}
```

Host usage (e.g. inside a file-upload controller):

```ts
// after the original is uploaded and the media doc created:
const { previews } = await ResizeEngine.generate(app, {
  media: fileDoc,
  sizes: getEventMediaSizes(),         // host's catalog
  pipeline: 'listing',
});
// persist:true already $push'd them; the read path now returns them all as ready.
```

### Behavior (`generate`)
1. Resolve config + storage + the named pipeline. **Storage is required** (throws if none).
2. `sizes = runWaterfall('resolveSizes', sizes, ctx)`; expand to `sizes × formats × filters`
   identities via `getPreviewIdentity` (same as the read path).
3. **Skip identities already present** in `media.previews` (idempotent — safe to re-run; e.g.
   re-upload, or adding new sizes later).
4. Run the **same core as `processTask`** ([07 · Worker](./07-worker.md) steps 2–8):
   download the original once, source-pixel guard, `beforeSteps` (once), then per-variant
   (bounded by `config.workerConcurrency`) `.rotate()` → `cover|fit` → `variantSteps` → encode
   → upload (random key).
5. If `persist` → one `$push` of all generated previews (+ `original.width/height` backfill);
   else return them for the host to store.
6. Return `{ previews }`.

> **Implementation note:** write the resize core ONCE (`generatePreviews(app, ctx)` in
> `resizeTask.ts`). The lazy worker's `processTask` = this core **plus** lease / locks /
> transport bookkeeping; `generate` = this core **without** them. Do not duplicate the sharp
> pipeline.

### What eager mode does NOT need
- **No queue transport, no `ResizeWorker`, no `ResizeTask` model** (don't scaffold them).
- **No dispatch/worker locks** by default — eager generation is typically a single writer per
  media at create time. (If two requests can generate the *same* media concurrently, the
  existing-preview check in step 3 prevents duplicate rows; the upload itself is naturally
  serialized per doc. Add the worker lock only if you truly fan out.)
- **No placeholders** — `formatPublicUrls` never sees `decision.missing` for eager media,
  because everything is generated before the first read.

### Config differences
Eager mode ignores the queue/worker knobs (`workerEnabled`, `leaseMs`, `lockTtlMs`,
`maxAttempts`, `retryBackoffMs`, `idlePollMs`). It still uses: `bucketPublic`, `publicURL`/
`cdnURL`, `formats`/`webpAvifOnly`, `maxSize`, `quality`/`effort`, `limitInputPixels`,
`maxSourcePixels`/`maxResultDimension`, `workerConcurrency` (the inline bound), `animated`.

---

## §11.2 Hybrid — eager for some, lazy for the rest

The two modes compose, because both write the same `previews[]` shape:

- **Eager-critical + lazy-rest:** at upload, `generate` only the above-the-fold sizes (e.g. the
  card thumbnail), and let `resolve` lazily fill the heavy ones (MAX, large media) on demand.
- **Eager with lazy fallback:** run `generate` at upload; if a later read still finds a size
  missing (a new catalog entry was added after upload), `resolve` enqueues it — provided the
  queue/worker are wired. If they're not (pure eager deployment), a missing size simply renders
  via the host's placeholder until the next `generate`/re-process.

A host that starts eager (simplest) can **graduate to lazy** later with no data migration: the
`previews[]` already written by `generate` are exactly what `resolve` reads.

---

## §11.3 README guidance (host-facing summary)

> **Default to lazy.** It keeps uploads fast and only does work that's actually needed.
> **Choose eager** when your app is low-volume, your size catalog is small and fully used, you
> don't want to run a worker, and you'd rather every image be ready the instant an upload
> finishes. You can switch later — the stored shape is identical — or mix the two.
