# Multi-resizer architecture — review and plan

Status: agreed direction, 2026-09-30. Implementation runs in phases; each phase gets its own
plan in `docs/superpowers/plans/`. Phase 1:
[`2026-09-30-p1-resizer-owns-context.md`](../superpowers/plans/2026-09-30-p1-resizer-owns-context.md).

The module's image logic is sound; its wiring is not. Core code reaches process-wide globals —
the framework app, "the" Resizer, "the" config — instead of receiving what it needs. As a
result a process holds exactly one Resizer with one config, queued tasks do not say which
Resizer they belong to, and the framework cannot be replaced. This document reviews the
original architecture (archived in [`docs/history/`](../history/README.md)), records the
decisions that replace parts of it, and splits the work into a docs catch-up (P0), four
refactor phases (P1–P4) and optional follow-ups (P5). The module is pre-release: breaking changes ship without data migrations.

## 1. Original architecture: what stays, what changes

Sources: `docs/history/spec/01-architecture.md` (§2 principles, §16 invariants) and
`docs/history/BUILD-SPEC.md` ("What this spec settles").

| Original decision | Verdict | Notes |
|---|---|---|
| Return the decision, never the DTO (§2.1) | Keep | |
| Behavior ships as package code; schema and config are scaffolded into the host (§2.2, settles 11c) | Keep for the framework adapter | A framework-free host passes models and config directly. |
| One framework gateway; "the app is ambient, never a parameter" (§2.3, settles 3) | **Replace — D1** | Root cause of the singleton and of the framework lock-in. |
| Every integration is a driver seam (§2.4) | Keep | The seams are right; core and drivers must stop reading globals. |
| "Drivers fixed at construction; one Resizer per process" (§2.4, settles 3) | **Replace — D2** | Many named Resizers per process. |
| The module deep-merges host config over its defaults (§2.5) | Already replaced (0.3.0) | The host spreads the defaults; the whole object is validated. |
| One shared identity helper for read, enqueue, worker and locks (§2.6) | Keep, extend — D5 | Identity gains the resizer and pipeline names. |
| Filters are part of identity (settles 4) | Keep | |
| Named pipelines chosen per call; tasks carry the name, never functions (settles 5, §16) | Keep | The pipeline name also enters identity (D5). |
| `fit` size token, size keys round-trip, `.rotate()` on every branch, `limitInputPixels` everywhere (§16) | Keep | |
| Preview storage keys are random and unguessable (settles 8, §16) | Keep | Public preview URLs must not be enumerable. Racing workers therefore leave orphan files, which is why the worker locks stay (§4). |
| The transport owns consumption: `enqueue` + `startWorker`; lease/complete/fail are internal (settles 2) | Keep, narrow — D6 | Retry and dead-letter stay in transports. Observer calls move out. |
| Poison tasks capped, then dead-lettered (settles 12, §16) | Keep | |
| Queues are at-least-once; the worker is idempotent (§16) | Keep | Basis of D4. |
| SVG is served as-is, never rasterized (settles 10b) | Already replaced (0.3.0) | SVG is untrusted: stored privately, rasterized by the worker, never served. |
| Two modes from one core (settles 11b) | Keep | `prewarm` and `enqueueRequired` were added since. |
| Framework imported in exactly two files; no mongoose imports (§16) | **Replace with a stricter rule — D7** | The main entry imports no framework code at all. |
| Encode options per format, never one shared quality (§16) | Keep | Now `encode.formats.<format>`. |
| Data migration is out of scope (§15) | Keep | Hosts migrate their own legacy data. |

## 2. What is wrong in the code today

- **Core reads globals.** `engine.ts`: 9 logger calls through `getApp()`, 3 `getResizeConfig()`
  reads. `enqueue.ts`: 7 and 2. `resizeTask.ts`, `original.ts`, `resizer.ts` and `worker.ts`
  do the same. The transports call `getResizer()` to fire observers (Mongo 4×, SQS 2×) and read
  queue timing from the global config (Mongo 6×).
- **One instance.** A second `new Resizer()` throws `RESIZE_DUPLICATE_RESIZER`, and
  `getResizer()` returns the only instance.
- **One config.** `app.getConfig('resize')` gives one `mediaModelName`, one `formats` list and
  one set of limits for the whole process.
- **Tasks carry no owner.** A task is `{ fileId, pipeline, previews }`. The worker assumes "the"
  Resizer, and `ResizeTask.fileRef` is hard-coded to `'File'`.
- **Identity omits the pipeline.** The key is `sizeKey:format:filterSig`. Two pipelines on one
  media share a key, so the first rendering generated is served for both. `AGENTS.md` documents
  a workaround (add a fake filter).
- **Importing the package loads the framework.** The main entry exports `ResizeTaskModel`
  (extends the framework's `BaseModel`) and defaults to the framework drivers.
- **Import cycles.** Four cycles run through `resizer.ts` (`engine`, `enqueue`, `original`,
  `resizeTask`), because core functions import the registry to find their own Resizer.

## 3. Decisions

**D1 — Explicit context.** Core functions receive the Resizer and read `resizer.config`,
`resizer.logger` and the drivers from it. Core never calls `getApp()`, `getResizeConfig()` or
`getResizer()`. Looking a Resizer up by name is allowed only at entry points: the worker
command, the transport handler, and host code.

**D2 — Named Resizers.**
`new Resizer({ name?, config?, logger?, storage, transport?, mediaStore?, lockProvider?, pipelines?, hooks? })`.
`name` defaults to `'default'`. Each Resizer registers under its name, and a duplicate name
throws. `getResizer(name = 'default')` returns it. Most hosts construct one Resizer and never
pass a name.

**D3 — Named queues.**
- Every task has a queue name. When none is given, it is `'default'`.
- A Resizer sets its default queue (`queue` option), and a call may override it
  (`prewarm({ …, queue: 'bulk' })`).
- `ResizeWorker` with no flag consumes only `'default'`. `--queue=bulk` consumes only `'bulk'`.
- Any number of workers on any number of servers may consume one queue.
- Mongo: one `ResizeTask` collection with an indexed `queue` field that the lease query
  filters on.
- SQS: a map from queue name to queue URL.

**D4 — Delivery.**
- A task is held by one worker at a time. Mongo claims it with one atomic update that stamps a
  lease token; SQS hides a received message for its visibility timeout.
- Delivery is at-least-once: a crashed worker's task is re-claimed when its lease expires, and
  standard SQS can deliver a message twice.
- Processing therefore stays idempotent. The worker skips previews that already exist, and a
  worker that lost its lease cannot complete the task.
- Later, a worker may run several tasks in parallel slots (`worker.parallelTasks`, default 1).
  That is a change inside `startWorker` only.
- Prefetching tasks that then wait in memory is avoided, because their leases keep running.

**D5 — Identity.**
- The preview identity becomes `resizer:pipeline:sizeKey:format:filterSig`.
- Preview rows store `resizer` and `pipeline`; a stored row without them counts as `'default'`.
- Lock keys, the Mongo `requestKey` and the read path all build the key through the one helper.
- The fake-filter workaround is removed.
- Renaming a pipeline (for example `watermark` → `watermark-v2`) makes its images regenerate.

**D6 — What a transport does.**
- Transports keep what is backend-specific: enqueue, claim/lease, heartbeat, retry with
  backoff, and dead-lettering.
- They stop calling `getResizer()`.
- `startWorker` receives the queue name, a task handler and an event callback (`completed`,
  `failed`, `deadLettered`).
- The worker entry looks up `task.resizer`, runs the task with that Resizer, and fires that
  Resizer's observers.
- A task naming an unregistered Resizer fails with a setup error, so it retries and then
  dead-letters.

**D7 — The framework is an adapter.**
- The main entry imports no framework code.
- The framework pieces move behind subpath entries: the app gateway, config loading,
  `FrameworkMediaStore`, `FrameworkLockProvider`, `ResizeTaskModel`, the `ResizeWorker` command
  and the `resize:*` event mirror.
- A framework-free host constructs Resizers with explicit config, logger and drivers.
- A test fails the build if a core file imports the framework or the app gateway.

**D8 — Config ownership.**
- **Per Resizer:** `formats`, `upload`, `maxSize`, `animated`, `encode`, `limits`, lock TTLs,
  and its default queue name.
- **Per transport (constructor options):** lease length, backoff, `maxAttempts`, poll interval,
  task timeout.
- **Per worker process:** `enabled`, `concurrency`, `sharpConcurrency`, `sharpCache`, and later
  `parallelTasks`.
- `mediaModelName` becomes a `FrameworkMediaStore` option.
- The rule "worker lock TTL ≤ lease length" is checked when the worker starts, where both
  values are known.

## 4. Corrections to the first review

The first review (2026-09-30) proposed more than this plan keeps. Checked against the original
rationale:

| Proposal | Outcome | Why |
|---|---|---|
| Replace the dispatch and worker locks with idempotent writes | Rejected | Keys must stay random (non-enumerable URLs), so duplicate work leaves orphan files and wastes CPU. SQS has no durable dedupe. |
| Move retry and dead-letter into a shared runner | Rejected | Retry is backend-specific: document fields on Mongo, redrive policy on SQS. Only observer routing moves (D6). |
| Replace hooks with constructor callbacks | Rejected | Hooks are already per instance and can be seeded at construction. Only the framework event mirror moves (D7). |
| Merge `prewarm` and `enqueueRequired` | Deferred to phase 5 | Not needed for multiple Resizers. |

## 5. Target wiring (sketch — final names are set in each phase plan)

Framework host:

```ts
// src/resizer.ts, loaded after `await server.init()`
const transport = new MongoTransport();
export const media = new Resizer({ storage, transport });            // name 'default'
export const listings = new Resizer({
  name: 'listings',
  config: listingsConfig,                                            // own formats and limits
  storage: listingsStorage,
  transport,                                                         // same queue, same worker
  pipelines: { watermark },
});
```

Framework-free host (after phase 4):

```ts
const resizer = new Resizer({
  config: { ...defaultResizeConfig, formats: ['webp', 'avif'] },
  logger: console,
  storage: new LocalFsStorage({ rootDir: './media', publicBaseUrl: '/media' }),
  mediaStore,     // load + appendPreviews over the host's database
  lockProvider,   // only for queued mode
});
```

Queued task:

```ts
{ resizer: 'listings', queue: 'default', mediaId, pipeline: 'watermark', previews: [/* … */] }
```

Worker:

```sh
npm run cli ResizeWorker               # queue 'default'
npm run cli ResizeWorker --queue=bulk  # queue 'bulk' only
```

## 6. Phases

Each phase ends with types, lint, build, the full test suite and the packaging smoke test green,
and merges on its own. A phase that changes the public API is done only when the docs are
updated too:
- the module's `README.md`, `AGENTS.md` and `CHANGELOG.md`
- the framework docs site page `docs/12-resize.md` in `adaptivestone/framework-documenation`
  (published at <https://framework.adaptivestone.com/docs/resize>), via a PR to that repo
  within the same phase

**P0 — The docs site catches up with the merged 0.3.0 changes.** Must land before 0.3.0 is
published; the page still describes 0.2.
- `original.key`/`bucket` → `original.storageRef`.
- Document `uploadOriginal()` and `enqueueRequired()`.
- SVG: the page still says pass-through; it is now private and rasterized.
- Config: `upload`, `encode.formats`, `encode.flatten`, the removed-keys table, validation
  when `new Resizer()` runs, and the host spreading the defaults.
- `bucketPrivate` and `privateRootDir`, and `MediaStore.verify()`.
- Fix the `{ enqueued: 0 }` causes: SVG is no longer one of them.
- Done when: `grep -nE "original\.key|webpAvifOnly|encode\.quality|pass-through"
  docs/12-resize.md` in the docs repo finds nothing, and every example matches the package's
  `README.md`.

**P1 — The Resizer owns its context.** [Plan](../superpowers/plans/2026-09-30-p1-resizer-owns-context.md).
- The Resizer holds its own `name`, `config`, `logger` and event bus, registered in a
  named registry.
- Core files stop calling `getApp()`, `getResizeConfig()` and `getResizer()`.
- The default `FrameworkMediaStore` uses the Resizer's own `mediaModelName`.
- The transports and framework drivers still use framework globals until P4.
- **Temporary restriction:** only the default Resizer may have a transport. Tasks do not yet
  record which Resizer created them, so the worker would process a named Resizer's tasks with
  the default Resizer. P2 lifts this.
- Done when: two Resizers with different configs work in one process, and a guard test keeps
  the core free of globals.

**P2 — Tasks carry their resizer and queue.**
- The task envelope and `LeasedTask` gain `resizer` and `queue`.
- `ResizeTask` gains both fields, the lease query filters by queue, and the unique
  active-request index and the `requestKey` include the resizer.
- SQS gets a queue-name → URL map.
- Named Resizers may have a transport (the P1 restriction is lifted).
- `startWorker` takes a queue name and an event callback, and the transports stop calling
  `getResizer()`.
- The worker routes each task by `task.resizer`, and `ResizeWorker` gets `--queue`.
- `resolve`, `prewarm` and `enqueueRequired` accept `queue`.
- Done when:
  - Two Resizers share one queue and one worker processes both.
  - A `bulk` worker ignores `default` tasks and the reverse.
  - A task for an unknown Resizer dead-letters with a clear error.

**P3 — Identity includes resizer and pipeline.**
- Preview identity becomes `resizer:pipeline:sizeKey:format:filterSig`.
- Preview rows store `resizer` and `pipeline`.
- Every key builder moves to the new helper: the read map, `expandMissingPreviews`, the
  worker's existing-preview check, lock keys, `requestKey` and `enqueueRequired`.
- The media schema fragment gains the two fields, and the `AGENTS.md` workaround is removed.
- Done when:
  - Two pipelines on one media produce two previews, and each read gets its own.
  - A stored row without the new fields reads as `'default'`.

**P4 — The framework becomes an adapter.**
- A framework subpath takes the app gateway, config loading, the event mirror,
  `ResizeTaskModel` and `ResizeWorker`.
- `FrameworkMediaStore` takes `{ modelName }`.
- `MongoTransport` gets its own timing options and an optional injected model, so it also
  works without the framework.
- Config splits as in D8, and the scaffold templates are updated.
- Done when: a static check proves the main entry's import graph has no framework module, and a
  framework-free example runs in the test suite.

**P5 — Later, each optional and separate.**
- `worker.parallelTasks`.
- Merge `prewarm` into `enqueueRequired`.
- Strip archived-spec section references from comments.
- Check the AVIF/WebP quality defaults on real photos.

## 7. Non-goals

- No change to the SVG policy, `uploadOriginal`, the storage ref shapes, or strict enqueue
  semantics.
- No lock or dedupe redesign (§4).
- No data migrations.

## 8. Open questions (decided in the phase plan that needs them)

- **P2:** the SQS option shape for several queues. A `queues: { default: url, bulk: url }` map,
  or one transport instance per queue.
- **P4:** the framework config layout for several Resizers. One config file per Resizer (for
  example `resize.ts` and `resizeListings.ts`), or one file with a `resizers` map.
