# 04 · Pipelines & hooks

> Part of the [`@adaptivestone/framework-module-resize` build spec](../BUILD-SPEC.md).
> Prev: [03 · Identity](./03-identity.md) · Next: [05 · Transport & storage](./05-transport-and-storage.md)

Two extension layers: **named per-media-type pipelines** (the pixel work) and
**cross-cutting hooks** (sizes / DTO / enqueue / observers).

---

## §8. Named pipelines — per-media-type processing (`src/registry.ts`)

Different media types need different pixel work: avatars need none; some photos need
license-plate or face detection-and-blur; a premium image needs a blurred teaser variant. So processing
is organized as **named pipelines**, registered once at bootstrap and selected per read
call by name. The worker is a separate process — functions cannot ride the queue — so the
task carries only the pipeline **name**, and the worker resolves the functions from its
own registry (bootstrap runs in both API and worker processes).

```ts
export type BeforeStep = (
  buffer: Buffer,
  meta: { media: MediaLike; metadata: sharp.Metadata; ctx: Record<string, unknown> },
) => Buffer | Promise<Buffer>;

export type VariantStep = (
  img: sharp.Sharp,
  meta: { variant: MissingPreview; ctx: Record<string, unknown> },   // variant carries `filters`, `fit`
) => sharp.Sharp | Promise<sharp.Sharp>;

export interface Pipeline {
  beforeSteps?: BeforeStep[];    // async; run ONCE on the original buffer, before any resize
  variantSteps?: VariantStep[];  // run PER variant, after resize, before encode
}
```

> **`ctx` does NOT cross the queue boundary.** Pipeline steps run in the **worker**, a
> separate process reached over the queue. The task carries only `{ mediaId, pipeline,
> previews }` — never the read-path `ctx` (which holds request-scoped, often non-serializable
> data). So in the **queued (lazy) worker, `ctx === {}`**; durable per-media data a step needs
> must be read from the loaded `media` document (the worker loads it — [07](./07-worker.md)
> step 1) or persisted onto it earlier. The full read/caller `ctx` is available to steps
> **only in eager mode** (`ResizeEngine.generate`, synchronous in the request process —
> [11 · Modes](./11-modes.md)). Write steps to depend on `media`/`metadata`, not `ctx`.

```ts
// bootstrap (server.ts) — runs in API and worker
ResizeEngine.registerPipeline('photo', {
  beforeSteps:  [detectAndBlurPlates, detectAndBlurFaces],           // safety: applies to every variant
  variantSteps: [(img, { variant }) => variant.filters?.blur ? img.blur(Number(variant.filters.blur)) : img],
});
ResizeEngine.registerPipeline('avatar', {});                         // no special processing
```

Semantics (validated against thumbor's production detector/filter pipeline — see
[Appendix C4](./appendix.md)):
- **`beforeSteps`** run as an ordered, awaited chain over the source buffer, **once per
  task**, after download and before the per-variant loop. The native home for things that
  must apply to **every** variant identically and are correct to bake into the source:
  **detection metadata** (NSFW score, focal points) and **pixel redaction** (plate/face blur).
  A step that throws fails the task (so a host can hard-stop on, e.g., an NSFW verdict).
  - *Metadata vs pixel:* a detection step that only produces metadata (a score, regions) is
    cheap and ideal to **cache keyed by the source** (`media.original.key`); a pixel-redaction
    step makes the shared intermediate a full buffer — fine (you *want* the redaction
    irreversible), just size the cache accordingly.
  - *"Once" is per task, not per source.* Two concurrent tasks for the same media each run
    `beforeSteps`. If detection is expensive, the host must cache its result by source on the
    media doc (the module does not cache detection) — thumbor caches detector data by source url.
- **`variantSteps`** run as an ordered chain (**registration order** — matters when steps
  interact, e.g. blur-then-sharpen ≠ sharpen-then-blur) over the per-variant `sharp.Sharp`
  instance, **after resize, before encode**. The home for the keyed `filters` (a `300x300:blur40`
  variant) **and anything sized relative to the output** — **watermark**, rounded corners,
  frames. ⚠ Do **not** put a watermark in `beforeSteps`: baked onto the original once, it
  scales down with each variant and becomes inconsistent/unreadable on small sizes (thumbor
  runs watermark post-resize for exactly this reason). The host owns what a filter does; the
  module owns the identity key.
- An unknown/unregistered pipeline name → empty pipeline (no steps).
- `resolve({ pipeline })` selects the pipeline; the enqueued task stores the name; the
  worker runs that pipeline's `beforeSteps` + `variantSteps`.

This composes with filters: a plate-blurred original (`beforeSteps`) can still yield a
regular **and** an extra-blurred `300x300` variant (`variantSteps` + filter identity).

---

## §9. Hooks (`src/hooks.ts`) — cross-cutting, exact semantics

Hooks are the **cross-cutting** seams (sizes + DTO + enqueue + observers). Per-media-type
pixel work lives in pipelines (§8), not here. Process-wide registry, registered at
bootstrap, taps run **in registration order**, **awaited sequentially**.

**Waterfall** (value threads through taps):

| Name | Signature | Default if no tap |
|---|---|---|
| `resolveSizes` | `(sizes: SizeInput[], ctx) => SizeInput[] \| Promise<…>` | identity |
| `beforeEnqueue` | `(missing: MissingPreview[], ctx) => MissingPreview[] \| Promise<…>` | identity |
| `formatPublicUrls` | `(decision: ReadDecision, ctx) => unknown \| Promise<unknown>` | returns `decision` |

**Observer** (side effects; return ignored; errors logged via `app.logger`, never thrown
into the flow): `onPreviewGenerated(preview, ctx)`, `afterTaskComplete(task, ctx)`,
`onTaskFailed(task, error, ctx)` (per failed *attempt*, will retry),
`onTaskDeadLettered(task, error, ctx)` (task exhausted `config.maxAttempts` → dead-letter;
host can alert/page — see [05 · Transport](./05-transport-and-storage.md)).

> The **worker/transport-fired** observers (`onPreviewGenerated`, `afterTaskComplete`,
> `onTaskFailed`, `onTaskDeadLettered`) run in the worker process and receive **`ctx === {}`**
> (no read-path ctx crosses the queue — see the pipeline note above). `onPreviewGenerated` is
> fired by the worker per generated preview; the completion/failure observers are fired by the
> transport (§10.2). Only the **read-path** waterfalls below carry the caller's real `ctx`.
>
> **Also mirrored on the framework event bus.** Every observer is additionally emitted on
> `app.events` (the framework's `EventEmitter`, `server.ts`) as `resize:<name>` — e.g.
> `resize:onTaskDeadLettered` — so hosts can subscribe with the bus they already use for
> `'shutdown'` etc., without registering a module hook. The typed `ResizeEngine.hook(...)` registry
> stays the **primary contract** because it is **awaited and error-isolated** (a throwing observer
> is logged, not propagated) — raw `EventEmitter.emit` is synchronous, unawaited, and a throwing
> listener would propagate into the worker. So: `hook()` for guaranteed/awaited handling; `app.events`
> for fire-and-forget ecosystem subscribers. `app.events` is optional on `TMinimalResizeApp`.

```ts
// Waterfall taps are HOST code on the read path; a throwing tap must never break the read.
// Each tap is guarded: on throw, log and keep the prior value (treat the tap as identity).
async function runWaterfall(app, name, value, ctx) {
  for (const fn of hooks.get(name) ?? []) {
    try { value = await fn(value, ctx); }
    catch (e) { app.logger.error(`resize waterfall ${name} tap failed (skipped)`, e); }
  }
  return value;
}
async function runObservers(app, name, ...args) {
  try { app.events?.emit(`resize:${name}`, ...args); }       // fire-and-forget mirror onto the framework bus
  catch (e) { app.logger.error(`resize event ${name} listener failed`, e); }
  for (const fn of hooks.get(name) ?? []) {                  // primary: typed, awaited, error-isolated
    try { await fn(...args); } catch (e) { app.logger.error(`resize hook ${name} failed`, e); }
  }
}
```

The pipeline registry, queue transport, and storage are **NOT** hooks — each is a single
active strategy registered via its own method.
