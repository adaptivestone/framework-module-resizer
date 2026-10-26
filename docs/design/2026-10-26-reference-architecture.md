# Reference architecture: narrow ports, explicit dependencies, task-row gate

Status: **proposed** 2026-10-26, decisions taken by the owner the same day. Follows
[database, queue and framework wrapper](./2026-10-05-database-queue-framework-wrapper.md) (R1–R2,
merged). Pre-release: breaking changes are fine; hosts migrate their own data.

## Goal

The module should be an architecture one can publish as a reference example: a core that works on
any backend through small ports, every service owning exactly one job with its dependencies in its
constructor, a read path that costs nothing when the cache is warm and exactly one write when it is
cold, a processor that is a pure function over a decoded source, and enough signal in the logs to
see what happened and why.

The owner's expectation, in their words: an abstract core that resizes different files; upload
through a storage driver; after upload the file may be pre-resized in the background, or nothing
happens; on read the module hands out batched work; the work checks the database, resizes what is
missing and stores it under a lock; high performance, a cache, statistics; no dependency on the
framework ("give it a config and that's it") plus an easy framework integration; isolation, no
overlaps.

## What is wrong today

The 2026-10-26 review (three internal reviewers, one external review, verified in code) found
that the outer shape matches the expectation and the inside does not:

1. **One function does everything.** `generatePreviews` (`src/resizeTask.ts:172-735`) holds the
   download, the SVG raster, `beforeSteps`, the size policy, the Sharp pipeline, encoding, upload,
   preview rows, worker and dispatch locks, persistence with a 70-line reconciliation, and the
   observers. SVG is an `if` branch, so "different files" has no seam. The comment "decode is
   shared via `clone()`" is wrong: every size × format decodes again (measured 4345 ms vs
   3535 ms for 24 MP × 3 sizes × 3 formats when resizing once per size).
2. **The Resizer is a service locator.** Every core function takes the whole `Resizer` and pulls
   `db`, `tasks`, `storage`, `logger`, hooks out of it (`enqueue(resizer, …)`,
   `generatePreviews(resizer, …)`). A dispatcher test must build a full Resizer; four type cycles
   run through `resizer.ts`; nothing stops a function from reaching a port it should not use.
3. **One contract, three jobs.** `ResizeDatabase` holds media operations, locks and `tasks?`
   (`src/contracts/database.ts`). Media is used only by the worker, locks only by the queued path,
   `tasks` never by the core. Eager hosts implement lock methods that never run; the framework
   adapter subclasses `MongoDatabase` just to override the two lock methods.
4. **Lock policy has no owner and a bug.** Keys, acquire and release live in four files; the TTLs
   sit on the queue's timing although the queue never locks, so `SqsTaskQueue` imports core
   validators (`src/drivers/sqs.ts:24-25`). On a variant failure the worker releases the worker
   lock, then `finally` releases the dispatch lock too (`src/resizeTask.ts:632-636, 725-731`), so
   during the retry backoff every read enqueues again. Dispatch locks are per identity, so
   concurrent reads of one media split into several tasks, and a pending media costs one lock
   round trip per missing identity on every read.
5. **The framework adapter owns core policy.** "One queue per backend with one timing" is
   enforced with module-level state (`queueUsers`, `backendQueues`, `appQueue`,
   `buildingForResizer` in `src/framework/database.ts`), because a process-wide queue is described
   inside each Resizer's config file. Config-to-driver construction exists only there, with a
   closed driver list, and the core rejects a partial image config.
6. **No invalidation, no metrics.** The preview identity omits the encode options and the
   original, so a quality change or a re-upload into the same document silently serves old
   previews. Statistics are four worker-side observers; reads emit nothing.

## Decisions

**F1. Three narrow ports.** `ResizeDatabase` is replaced by `MediaStore` and `LockStore`;
`TaskQueue` stays. `tasks?` leaves every contract.

```ts
abstract class MediaStore {
  abstract loadMedia(id: string): Promise<MediaLike | null>;
  abstract appendPreviews(id: string, rows: Preview[], dims?: Dims): Promise<Preview[]>;
  abstract replacePreviews(id: string, identities: string[], rows: Preview[]): Promise<Preview[]>; // F9
  verify?(): void | Promise<void>;
}
abstract class LockStore {               // a dumb TTL key-value with owners (F3)
  abstract acquire(key: string, owner: string, ttlMs: number): Promise<boolean>;
  abstract extend(key: string, owner: string, ttlMs: number): Promise<boolean>; // false: not held by owner
  abstract release(key: string, owner: string): Promise<boolean>;               // compare-and-delete
  verify?(): void | Promise<void>;
}
```

`new Resizer({ storage, media, locks?, tasks?, … })`. `locks` is required when `tasks` is set
(`RESIZE_LOCKS_REQUIRED` at `ready()`); eager-only hosts pass `storage` and `media`. The Mongo
driver returns a bundle shaped like the options, so wiring stays one call:

```ts
const parts = mongoParts(connection, { mediaModel: File, timing? }); // { media, locks, tasks }
new Resizer({ storage, ...parts });
new Resizer({ storage, ...parts, locks: new RedisLockStore(redis) });
```

The framework adapter composes `FrameworkMediaStore` (the app's media model), `FrameworkLockStore`
(the framework `Lock` model) and the app's `ResizeTask` queue instead of subclassing.

**F2. Coordination policy belongs to the Resizer.** Lock durations and cooldowns are the core's
dedup policy, not queue timing: `new Resizer({ coordination: { gateTtlMs, cooldownMs } })` (framework
hosts: a `coordination` section in `resize.ts`). The core validates it against the queue timing
(`gateTtlMs ≥ leaseMs`); no driver validates lock settings. `QueueTimingOptions` loses `lockTtlMs`.

**F3. The task row is the gate.** One active task per `(resizer, mediaId, pipeline)`.

- `TaskQueue.add(task)` returns `{ status: 'added', taskId } | { status: 'in-flight', taskId? } |
  { status: 'unconfirmed' }`. A queue that can enforce this declares `gatesByTask: true`.
- **Mongo** (`gatesByTask`): rows carry `active: true` from `add` until `complete` or the end of
  the dead-letter cooldown; a unique partial index on `{ resizer, fileId, pipeline }` with
  `partialFilterExpression: { active: true }` makes `add` an insert that either succeeds or reports
  `in-flight`. A task in retry backoff stays active, so the lock-release bug disappears. A dead
  row keeps the gate for `cooldownMs`; `add` takes over an expired dead row atomically. No locks on
  the read path: a cold read costs one insert, a pending read costs one failed insert. The
  `requestKey` field and its index are removed (the gate replaces them); `findActive` returns the
  one active task so `prewarm` can report which requested variants it covers.
- **Queues without the gate** (SQS, custom): the dispatcher takes one owned lock
  `resize_gate:<resizer>:<mediaId>:<pipeline>` for `gateTtlMs` before `add` (owner = a request
  token stored in the task payload as `gateOwner`), and releases it if `add` fails. After claim the
  worker extends it on every heartbeat to `leaseMs`; on `fail({ retryAt })` it extends it to
  `retryAt + leaseMs`; on `complete` it releases with compare-and-delete; on `fail('dead')` it
  extends it to `cooldownMs`.
- Per-identity worker locks are removed: a media's task runs on one worker at a time by
  construction, the lease token fences task writes, and `appendPreviews` is identity-guarded.
- Cost accepted: a new size requested for a media whose task is active waits for that task to
  finish (the next read enqueues it). The BullMQ-style merge into a pending task was rejected:
  the merge window is about one poll interval, `prewarm` already queues the whole catalog in one
  task, and SQS cannot merge.

**F4. A decoder port and a pure processor.**

```ts
abstract class SourceDecoder {
  abstract readonly formats: readonly string[];                 // e.g. ['svg'], ['pdf']
  abstract inspect(bytes: Buffer, limits: ResizeLimits): Promise<SourceInfo>;   // format, contentType, width, height, pages?, animated?
  abstract render(bytes: Buffer, box: { width: number; height: number }, opts: { limits; signal }): Promise<Raster>; // raw pixels + info
}
```

`SharpDecoder` (raster formats, shrink-on-load) is the default; `SvgDecoder` (the existing child
process) is the first separate one. `new Resizer({ decoders: [new PdfDecoder()] })` adds more; the
decoder is chosen by `inspect` at upload and by the stored `original.format` in the worker.
`uploadOriginal` only calls `inspect`. The processing path becomes three pure steps:
`planVariants(info, requests, config) → VariantPlan[]` (sizes, fit, own-size rule, identities),
`renderSize(raster, plan) → raw` once per size, then per format `variantSteps → encode`.
`beforeSteps` run once on the decoded raster. Nothing in these steps touches a port.

**F5. Explicit dependencies, one composition root.** Internal services receive only what they
use, in their constructor; none receives the Resizer:

| Service | Owns | Depends on |
|---|---|---|
| `Catalog` | size × format expansion, identities, stored-identity set, freshness (F9) | config |
| `Uploader` | `uploadOriginal` | storage, decoders, config, metrics |
| `Reader` | `resolve` decision | catalog, dispatcher, hooks, metrics |
| `Dispatcher` | `prewarm`, the read path's enqueue, the gate (F3) | tasks, locks, coordination, name, logger, metrics |
| `Processor` | one task or one eager call: load, decode, plan, render, persist, observers | media, storage, decoders, pipelines, locks, coordination, observers, metrics |
| `Consumer` | the worker loop: claim, heartbeat, timeout, backoff, dead-letter, events | tasks, timing, processor, events, logger |

`Resizer` is the composition root and facade: it resolves lazy parts, builds the services, and
exposes `uploadOriginal`, `resolve`, `prewarm`, `generate`, `invalidate`, `hook`, `verify`. The
hook bus and pipeline registry become small classes. Service and port types move to `types.d.ts`
and `contracts/`, which removes the type cycles. The process registry moves to `registry.ts`:
`getResizer(name)` stays for hosts, `runWorker({ resizers })` takes an explicit list (default:
the registry), and `onResetResizerForTests` goes away with the queue-sharing state. `ResizeError`
gains `retryable`; the consumer checks it instead of a list of image error codes. An import-graph
rule allows `drivers/**` to import only `contracts`, `errors`, `helpers` and other drivers.

**F6. Queues are named resources.** The framework config file defines every queue once:

```ts
// src/config/resize.ts — process-wide sections, read only from this file
queues: {
  default: { driver: 'database' },
  bulk: { driver: 'sqs', queueUrl: '…', leaseMs: 120_000 },
},
worker: { enabled: false, sharpConcurrency: 1, sharpCache: false },
coordination: { gateTtlMs: 600_000, cooldownMs: 600_000 },
// per-Resizer sections: image settings, mediaModelName, storage, queue: 'default'
```

A second Resizer's file (`resizeListings.ts`) keeps image settings, `mediaModelName`, `storage`
and `queue: 'bulk'` (a name). Each named queue is built once per process. When names map to
different backends, the adapter wraps them in the core's `RoutingTaskQueue`, which routes
`add` by queue name and answers `servesQueue`; a worker started with `--queue=bulk` consumes
that backend. The timing-conflict check, `RESIZE_CONFIG_QUEUE_TIMING_CONFLICT` and the module-level
state in `src/framework/database.ts` are deleted.

**F7. Config-driven construction lives in the core.**

```ts
import { createResizer } from '@adaptivestone/framework-module-resize';
export const resizer = createResizer({
  formats: ['webp'],                                        // DeepPartial<ResizeConfig> over the defaults
  storage: { driver: 'local', rootDir: './var/media', publicBaseUrl: '/media' },
  database: { driver: 'mongo', connection, mediaModel: File },
  queues: { default: { driver: 'database' } },
}, { drivers: { storage: { gcs: GcsStorage } } });        // open registry; optional
```

Every shipped driver has `static fromConfig(section, ctx)` and validates its own section once.
Optional peers are imported only when their driver is selected (`RESIZE_PEER_MISSING` otherwise).
`FrameworkResizer({ configName })` becomes `getConfig` + `getModel(mediaModelName)` + the app
logger and events + this factory. The `Framework*` config types become core `*Config` types;
`FrameworkResizeConfig` adds only `mediaModelName`. Framework hosts keep the framework's
`resize.<NODE_ENV>.ts` merge; the core's merge over package defaults is the only other merge.

**F8. A metrics port, logging by default.**

```ts
abstract class ResizeMetrics {
  abstract count(name: string, value: number, labels?: Record<string, string>): void;
  abstract timing(name: string, ms: number, labels?: Record<string, string>): void;
}
```

`LogMetrics(logger, { summaryIntervalMs: 60_000 })` is the default; `NoopMetrics` silences it; a
host passes its own (Prometheus, StatsD). The default must not grow production logs with the
traffic: request-path events (`upload`, `read`, successful `variant`) are counted in memory and
written as ONE `info` summary line per interval, only when something was counted ("reads 4800,
ready 4788, missing 12, enqueued 3, in-flight 9, uploads 2"); worker outcomes (`task` completed,
failed, dead; a failed `variant`) are written one line each at `info`, because they are few and
they explain why. Every single event is also available at `debug` for local debugging. Events:
`upload` (format, bytes, ms); `read` (ready, missing, outcome `enqueued | in-flight | suppressed |
eager-only`); `variant` (identity, format, ms, bytes, outcome); `task` (`completed | failed |
dead`, attempts, ms, variants); `claim` (wait ms). `Preview` rows gain `bytes` and `createdAt`;
task rows gain `startedAt` and `finishedAt`; observers receive `attempts`.

**F9. Freshness on every preview, plus `invalidate`.** The identity string stays
`resizer:pipeline:sizeKey:format:filterSig`. Each stored preview also records `origin` (a
fingerprint of `original.storageRef` and its dimensions) and `encodeSig` (a hash of the format's
encode options, `sharpen`, `flatten`, `maxSize`, `limits.resultDimension` and the pipeline's
optional `version`). The read path treats a mismatch as missing; the worker's
`replacePreviews` swaps the stale row for the new one. `resizer.invalidate({ media, pipeline? })`
removes the rows and returns their `storageRef`s for the host to delete (deletion stays the
host's job). Rows without the fields are stale.

**F10. Hygiene bundled into the phases.** `resizeMediaSchemaFragment` moves to
`…/drivers/mongo.js` (re-exported by `…/framework.js`); `defaultFrameworkResizeConfig` and the
worker defaults move to `…/framework.js`; the `queue` option becomes `queueName`; `processTask`
is exported for push-delivered tasks; S3 previews get `Cache-Control: public, max-age=31536000,
immutable`; the per-read logs for media without original or with an unknown pipeline become
metrics; the 2026-10-02 and 2026-10-05 design docs get superseded notes; README's terminal-error
list is corrected.

## Target usage

Framework host, unchanged shape:

```ts
export const resizer = new FrameworkResizer({ pipelines, hooks });
```

Plain Node, config-driven (F7) or hand-wired (F1):

```ts
const resizer = createResizer({ ...config, database: { driver: 'mongo', connection, mediaModel: File } });
const resizer = new Resizer({ storage: new LocalFsStorage(opts), ...mongoParts(connection, { mediaModel: File }) });
```

A custom source kind (F4) and custom metrics (F8):

```ts
new Resizer({ …, decoders: [new PdfDecoder({ dpi: 150 })], metrics: new PrometheusMetrics(registry) });
```

## Unchanged

- The preview identity string, random preview keys, the SVG policy, the private-original policy.
- `ResizeStorage` and the fs and S3 drivers.
- Named queues per call (`prewarm({ queue: 'bulk' })`), at-least-once delivery, the retry and
  dead-letter rules, the lease token fencing of task writes.
- Hooks and pipelines (`Pipeline` gains an optional `version`).
- `resolve` never throws and never runs Sharp.

## Host migration

1. Replace `db` with `...mongoParts(connection, { mediaModel })`, or `media` + `locks` + `tasks`.
2. Move `lockTtlMs` out of queue timing into `coordination`; drop `lockTtlMs.worker`.
3. Framework hosts: move the `queue` section to `queues: { default: … }` in `resize.ts`, add
   `coordination` if the defaults do not fit, and change other Resizer files to `queue: '<name>'`.
   Re-run `resize-scaffold` (delete the old shims first).
4. Create the new `ResizeTask` index (`{ resizer, fileId, pipeline }`, partial on `active`), drop
   the `requestKey` index, add `active`, `startedAt`, `finishedAt` to an ejected model.
5. Previews stored before F9 are stale and regenerate on first read; call `invalidate` to
   collect their refs if the storage objects should be deleted.
6. Custom drivers: implement `MediaStore` / `LockStore` instead of `ResizeDatabase`; a custom
   `TaskQueue.add` returns the new result shape.

## Phases

Each phase is one PR with tests, README, AGENTS.md, CHANGELOG and the docs-site page; the owner
reviews between phases; the second review session re-reviews each branch.

| Phase | Scope | Done when |
|---|---|---|
| **S1** Ports and composition root | F1, F5, the F10 import rule, `retryable`, the SQS import fix | A dispatcher test constructs only a lock fake and a queue fake; no service imports `Resizer`; the import graph has no type cycle through `resizer.ts`; `drivers/**` import only contracts, errors, helpers, drivers |
| **S2** Gate and coordination | F2, F3, task events with `attempts` | 1000 concurrent `resolve` calls on a cold media create one task (in-memory and Mongo integration); a task in backoff blocks new tasks; the SQS path holds the gate through backoff and releases on complete; lock settings validated only in the core; per-identity locks gone |
| **S3** Decoder port and pure processor | F4 | A test-only `pdf` decoder produces previews with no core change; SVG tests pass through `SvgDecoder`; 3 sizes × 3 formats on a 24 MP source is not slower than the measured 3535 ms baseline; `generatePreviews` is gone |
| **S4** Named queues and config factory | F6, F7, scaffold templates | `src/framework/database.ts` has no module-level state; a plain-Node example is a config object and one call; a custom driver registers by name; two Resizers on different named queues run under one worker |
| **S5** Metrics and freshness | F8, F9 | With the default metrics, 50 reads produce no `info` line until the interval summary, and each task outcome produces one; changing `webp.quality` regenerates on the next read; `invalidate` returns the refs; `Preview` carries `bytes`, `createdAt`, `origin`, `encodeSig` |
| **S6** Hygiene and docs | the rest of F10, superseded notes on the two older design docs, docs site | `npx resize-scaffold --check` clean on a fresh scaffold; README and AGENTS.md match the exports |

## Open questions (decided in the phase plan that needs them)

- **S1:** whether `appendPreviews` becomes one write per task (`$concatArrays` with an identity
  filter) or stays one guarded write per row; the measured cost is small either way.
- **S2:** the exact `add` result for a queue that cannot confirm the write; the `gateOwner`
  field name; how `prewarm` reports variants outside the active task (`unconfirmed` with a
  retryable `RESIZE_TASK_IN_FLIGHT` issue is the proposal).
- **S3:** the `Raster` shape between decoder and renderer (raw buffer + info, or a Sharp
  instance); whether `beforeSteps` receive the raster or a Sharp instance.
- **S5:** metric names and label sets; the summary line's exact fields; whether the summary
  timer is unref'd so it never keeps a process alive.
