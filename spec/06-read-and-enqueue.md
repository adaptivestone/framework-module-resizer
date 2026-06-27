# 06 · Read & enqueue

> Part of the [`@adaptivestone/framework-module-resize` build spec](../BUILD-SPEC.md).
> Prev: [05 · Transport & storage](./05-transport-and-storage.md) · Next: [07 · Worker](./07-worker.md)

The synchronous HTTP-side path: `ResizeEngine.resolve` decides ready vs missing and hands
missing variants to `enqueue`. Neither may throw into the caller's read.

---

## §17. Read-path algorithm (`ResizeEngine.resolve` + `src/engine.ts`)

1. `sizes = await runWaterfall(app, 'resolveSizes', opts.sizes, ctx)` — host size magic
   (expand/inject/map/dedupe; e.g. add `{ fit:true }` for entity `event`). `runWaterfall`
   guards each host tap (a throwing tap is logged and skipped — [04 · Hooks](./04-pipelines-and-hooks.md) §9).
2. `formats = opts.formats ?? requiredFormats(config)`.
3. `publicURL = opts.publicURL ?? config.cdnURL ?? config.publicURL`.
4. `pipeline = opts.pipeline ?? 'default'`; `mediaId = media.id ?? String(media._id)`.
5. Build `previewMap: Map<identity, Preview>` from `media.previews` (only entries with
   both `key` and `contentType`), keyed by `getPreviewIdentity(p.sizeKey, p.format, p.filters)`.
6. **SVG originals are pass-through — never resized.** If `media.original` is SVG
   (`original.contentType === 'image/svg+xml'`, or `original.format === 'svg'`): for every
   requested `size × format` (skip a size whose `getSizeKey` throws, as in step 7), push a
   `ready` entry with **`preview` omitted and `isOriginal: true`** (`ReadyEntry` —
   [02 · Types](./02-types-and-api.md#5-data-shapes-srctypesdts)), whose `url` is the
   **original's** public URL (same `storage.publicUrl?.(app, { bucket: original.bucket, key:
   original.key }) ?? `${publicURL}/${original.key}`` rule as below), **ignoring the requested
   `format`** — an SVG renders crisply at any size and is always served as `image/svg+xml`. Leave
   `decision.missing` empty: SVG is **never enqueued and never rasterized** (vector resize is
   a no-op), so steps 7–8 become no-ops and the host's `formatPublicUrls` still runs over the
   ready-only decision. Then skip the per-size generation logic in step 7.
   > **Host responsibility (security).** A raw user-uploaded SVG is active content — it can
   > carry `<script>`, inline event handlers, or external references (XSS / SSRF). Because the
   > module passes the original URL straight through, the **host** must neutralize it:
   > sanitize on upload (strip scripts/handlers/external refs) and/or serve it from a
   > sandboxed, cookieless origin with `Content-Disposition: attachment` and a restrictive CSP.
   > The module never inspects SVG bytes.
7. For each `size`: `sizeKey = getSizeKey(size)` (skip on throw), for each `format`:
   - `identity = getPreviewIdentity(sizeKey, format, size.filters)`.
   - **exists** (`previewMap` hit) → push to `decision.ready` with `url = previewUrl(preview)`
     and `preview` set, where `previewUrl(p) = storage.publicUrl?.(app, { bucket: p.bucket, key: p.key }) ?? `${publicURL}/${p.key}``
     (`publicUrl` is pure string-building, so the read path stays I/O-free).
   - **original already fits** (optional fast-path; serve the original instead of generating).
     Apply **only when ALL** hold: (a) `size` has **no `filters`**; (b) `size` is a plain
     cover `WxH` (**not** `fit`, **not** width-only/height-only) — i.e. both `size.width` and
     `size.height` are set; (c) both `media.original.width` and `.height` are known; (d) the
     original is **not larger** than the box: `origW <= size.width && origH <= size.height`
     (so serving it never up- or down-scales below request — it already fits). Then push a
     `ready` entry with **`preview` omitted and `isOriginal: true`**, `url` = the original's
     public URL (or `storage.signedUrl(app, { bucket: original.bucket, key: original.key },
     ttl)` when `ctx.isOwner || ctx.isAdmin` and `signedUrl` exists). Skip generation. If any
     condition fails, fall through to **exists/missing** (do not serve the original).
   - **missing** → push `{ sizeKey, filters?, requestedWidth?, requestedHeight?, format,
     fit? }` (deduped by identity) to `decision.missing`.
8. `missing = await runWaterfall(app, 'beforeEnqueue', decision.missing, ctx)`; **assign it
   back to `decision.missing`** so steps 9–10 and the host's `formatPublicUrls` see the same
   (post-hook) set that was enqueued.
9. If `enqueueMissing` (default true) and `decision.missing.length` → `await enqueue(app,
   mediaId, pipeline, decision.missing)` (§18) inside try/catch — enqueue must never throw
   into the read.
10. `output = await runWaterfall(app, 'formatPublicUrls', decision, ctx)` — the host turns the
    decision into its response shape and renders placeholders/signed-originals for
    `decision.missing` (where `ready:false`/`isPlaceholder` is produced for the frontend).
    If no tap, `output === decision`.
11. Return `{ decision, output }`.

The engine never builds a response shape and never renders a placeholder; both are the
host's job, driven off `decision`.

> **Never-throw guarantee (the read must not break on a host error).** Three layers:
> (1) each waterfall tap is guarded inside `runWaterfall` (throws logged + skipped — §9);
> (2) `enqueue` is wrapped (step 9); (3) the **entire `resolve` body** runs inside a
> try/catch — any unexpected internal error is logged and `resolve` returns the safe value
> `{ decision: { ready, missing: [] }, output: decision }` (the `ready` entries built so far,
> nothing enqueued) instead of rejecting into the caller's read. `signedUrl` (the only I/O in
> the read, owner/admin-gated) is also caught and falls back to the public/original URL.

---

## §18. Enqueue algorithm (`src/enqueue.ts`)

```ts
async function enqueue(app, mediaId, pipeline: string, missing: MissingPreview[]): Promise<void>
```

1. Dedup `missing` by `getPreviewIdentity(sizeKey, format, filters)`.
2. For each, acquire the **dispatch lock** `resize_dispatch:${mediaId}:${identity}`, TTL
   `config.lockTtlMs.dispatch` (default 60s, converted to seconds for `acquireLock`). Keep
   only variants whose lock was acquired (others are already in flight — collapses a read
   fan-out into one task).
3. If none survive → return.
4. `const { taskId } = await transport.enqueue(app, { mediaId, pipeline, previews: survivors })`.
5. On enqueue failure — a **throw** OR a returned **`taskId === null`** (soft failure): log,
   and **release the survivors' dispatch locks** so a later read retries instead of waiting
   out the TTL. Never throw to the caller. (A non-null `taskId` = success; the dispatch locks
   are held to their TTL so a concurrent read fan-out collapses to this one task.)

Lock keys are always built from `getPreviewIdentity`. One helper, one identity.
