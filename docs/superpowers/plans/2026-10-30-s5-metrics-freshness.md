# S5 — Metrics port and preview freshness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Resizer reports what it does through a small metrics port. By default that is one summary log line per minute plus one line per worker outcome. A stored preview made with other settings, or from another original, is regenerated on its next read; it is served until its replacement lands, and the replacement is swapped in with one media-store write.

**Architecture:**
- **Metrics.** A port `ResizeMetrics` (`count`, `timing`, optional `flush`) lives in `src/contracts/metrics.ts`; `LogMetrics` and `NoopMetrics` live in `src/metrics.ts`. Each Resizer holds one sink: its `metrics` option, or by default `new LogMetrics(logger)`. Its services get a bound copy of the sink. The copy adds the `resizer` label, keeps every label bounded, and never throws or rejects. The Reader, Uploader, Processor and Consumer record events from a closed set of names (D1). `LogMetrics` sums request-path events in memory and writes one `info` line per window, only when something was counted. Each worker outcome gets its own `info` line.
- **Freshness.** Pure rules live in `src/freshness.ts`:
  - the expected `origin` comes from the media's original;
  - the expected `encodeSig` comes from the row's own format and fit flag, the live config and the pipeline's live `version`.

  The Catalog applies the rules on every call. It caches nothing across calls and splits a media's stored rows into fresh and stale; when an identity has both, the fresh row wins. The read path serves a stale row (marked `stale`) and queues it like a missing one. `prewarm()`, `generate()` and the worker treat a stale row as not done. The PreviewRecorder stores replacements with `replacePreviews` (one write per media) and new rows, plus any dimension backfill, with `appendPreviews`. The `origin` and `encodeSig` recipes (`src/signatures.ts`) do not change.

**Tech Stack:** Node ≥ 24 (planned on 26.12.1), TypeScript 7 (`erasableSyntaxOnly`, `verbatimModuleSyntax`, ESM, `.ts` specifiers), `node:test` (with `mock.timers`), Biome 2.6, sharp 0.35, mongoose 9 and mongodb-memory-server (tests only), the framework 5.5 (dev).

**Spec:** docs/design/2026-10-26-reference-architecture.md. This plan covers:
- F8 and F9;
- the F10 item "the per-read logs for media without original or with an unknown pipeline become metrics";
- the S5 row of Phases and the S5 entry of "Open questions".

Controller rulings: `.superpowers/sdd/2026-10-30-s5-metrics-freshness/plan-review-notes.md` (R-S5-1 … R-S5-15).

Shipped in S2b (0.3.0-rc.1) and not planned again:
- `bytes`, `createdAt`, `origin` and `encodeSig` on every row (`src/processor.ts:288-321`);
- `replacePreviews` (`src/contracts/media.ts:39-56`) and `invalidate()` (`src/processor.ts:457-517`);
- task `startedAt` and `finishedAt`, the observers' `attempts`, and `Pipeline.version` (`src/contracts/pipeline.ts:36`);
- the frozen recipes (`src/signatures.ts:34-83`; `.superpowers/sdd/2026-10-28-s2b-host-shapes/decisions.md` items 12–13).

## Decisions for the owner

The controller has ruled on all of these (R-S5-1; corrections R-S5-5 … R-S5-15). "Today" means the code on this branch (main 3a5820d).

**O1. Metric names and labels.** Accepted.
- **Events.** The closed set of D1: five events (`read`, `upload`, `variant`, `task`, `claim`) plus three byte/cell counters. Each event is one port call.
- **Labels.** Labels carry only bounded values: the Resizer, a registered pipeline or `'unregistered'`, a configured format, a consumed queue, the outcome, the mode, and a module error code or `'other'`. The bound sink normalizes the last three (D4).
- **Context.** Media ids, task ids, preview identities, raw pipeline names and raw codes go in an optional fourth argument, `context` (D2).

**O2. The summary line.** Accepted. One `info` line per Resizer per window, written only when something was counted (D3). The worker flushes when it stops and awaits a flush that returns a promise, for at most 5 s. A host that wants the API's last window calls `await resizer.metrics.flush?.()` at shutdown.

**O3. Timer lifetime.** Accepted. Each `LogMetrics` instance owns one `setTimeout`. The first event of a window arms it, it is `unref()`'d, and it is gone after it fires or after `flush()`.

**O4. Where metrics are configured.** Accepted.
- `metrics?: ResizeMetrics` on `ResizerOptions`, inherited by `createResizer` and `FrameworkResizer`.
- The default is a separate `LogMetrics(logger)` for each Resizer. `FrameworkResizer` defaults to `new LogMetrics(appLogger, { debug: true })`.
- The services' internal `metrics` dependency is optional and defaults to `NoopMetrics` (R-S5-11).

**O5. Freshness on read.** Accepted with R-S5-5, R-S5-6, R-S5-10 and R-S5-14.
- A stale row is served (`stale: true`) and queued, and is listed in `decision.stale`.
- The expected signatures are recomputed from the live config and pipeline objects on every read (D8).
- A media without stored dimensions has no row proven fresh on the read path (D7).
- A fresh row beats a stale row of the same identity whatever the store's order.
- A stale cell whose `publicUrl` throws is still queued.

**O6. Rows written before rc.1.** Accepted. A row without `origin` or `encodeSig` is stale. The storage cost and the host's cleanup are documented in Task 8.

**O7. Preview rows' Mongo `_id`.** Accepted. The fragment is unchanged. Rows are keyed by `identity`, and `_id: false` is a 0.4.0 follow-up.

**O8. Per-read logs.** Accepted. The table is D6, with the once-log sets capped (R-S5-8).

## Decisions

### D1. The metric names (owner O1)

Each event is ONE call: `timing` for events with a duration, `count` otherwise. The bound sink (D4) adds `resizer` to every call.

| Name | Call | Value | Labels (besides `resizer`) | Context |
|---|---|---|---|---|
| `resize.read` | count | 1 per `resolve()` | `pipeline`, `outcome` (D5) | `mediaId`, `ready`, `missing`, `stale` (cell counts) |
| `resize.preview.stale` | count | stale cells found by one read | `pipeline` | `mediaId` |
| `resize.upload` | timing | ms of `uploadOriginal()` | `outcome`: `stored` \| `rejected`; `format` (stored); `code` (rejected) | — |
| `resize.upload.bytes` | count | stored original bytes | `format` | — |
| `resize.variant` | timing | ms of encode + upload | `pipeline`, `format`, `mode`: `task` \| `eager`, `outcome`: `stored` \| `duplicate` \| `rendered` \| `failed`; `code` (failed) | `mediaId`, `identity`, `taskId` (task mode) |
| `resize.variant.bytes` | count | uploaded preview bytes (stored, duplicate, rendered) | `pipeline`, `format` | — |
| `resize.task` | timing | ms from claim to the task's event | `queue`, `pipeline`, `outcome`: `completed` \| `failed` \| `dead`; `code` (failed/dead, when the error is branded) | `taskId`, `mediaId`, `attempts`, `variants` |
| `resize.claim` | timing | ms the loop waited for this task | `queue` | `taskId` |

- `format` is a configured format, or a decoder id for uploads.
- `queue` is a consumed queue name.
- `rendered` is a `generate({ persist: false })` variant.
- `duplicate` is a variant another worker stored first, when the row holding the identity is fresh.
- A variant whose append was skipped because a row with OTHER signatures holds its identity records `failed` with code `RESIZE_WORKER_INCOMPLETE`. That row does not count as coverage (D11), so the task fails and its retry replaces the row.
- The callers pass `pipeline` and `code` raw; the bound sink normalizes them (D4).
- The F8 example summary also lists `missing`. Here missing-cell counts travel only in the read context: the spec's open question leaves the fields to S5, and outcomes are what an operator acts on.

### D2. The port

```ts
// src/contracts/metrics.ts
export type MetricLabels = Readonly<Record<string, string>>;
export type MetricContext = Readonly<Record<string, string | number>>; // high-cardinality details for logs; never labels
export abstract class ResizeMetrics {
  abstract count(name: string, value: number, labels?: MetricLabels, context?: MetricContext): void | Promise<void>;
  abstract timing(name: string, ms: number, labels?: MetricLabels, context?: MetricContext): void | Promise<void>;
  flush?(): void | Promise<void>; // write what is pending now (LogMetrics: the summary)
}
```

- The 4th argument departs from the spec's sketch (owner O1). A host class written with three parameters still conforms.
- A method may be `async`. The module never awaits `count` or `timing`, but it catches their rejections (D4).

### D3. `LogMetrics` (owner O2, O3), in `src/metrics.ts`

- **Constructor.** `new LogMetrics(logger: ResizeLogger, opts?: LogMetricsOptions)`, where `LogMetricsOptions = { summaryIntervalMs?: number; debug?: boolean }` (defaults 60 000 and false).
  - An interval that is not a positive safe integer is a `ResizeSetupError` with code `RESIZE_METRICS_INVALID`, `retryable: false`, and the message "resize: LogMetrics `summaryIntervalMs` must be a positive safe integer (ms)".
- **Summed** (counted, never a line of their own), kept per `resizer` label in first-seen order:
  - `resize.read` by outcome;
  - `resize.preview.stale`;
  - `resize.upload` (stored and rejected), with `resize.upload.bytes`;
  - `resize.variant` with outcome `stored`, `duplicate` or `rendered`, with `resize.variant.bytes`;
  - `resize.claim` (count and total wait).
- **Written at once**, one `info` line each: every `resize.task`, and every `resize.variant` with outcome `failed`. The exact formats:
  - `resize: task <taskId> of media <mediaId> <outcome> in <ms> ms (Resizer '<resizer>', queue '<queue>', pipeline '<pipeline>', attempt <attempts>, variants <variants>[, code <code>])`
  - `resize: variant <identity> of media <mediaId> failed in <ms> ms (Resizer '<resizer>', pipeline '<pipeline>', format '<format>'[, code <code>])`

  `<ms>` is `Math.round(ms)`. A missing value prints as `?`. `<code>` prints the raw code from `context.code` when the label is `'other'`, and the label otherwise.
- **The summary**, one line per Resizer: `resize: Resizer '<r>' over <S> s: ` followed by the non-empty sections, joined with `, `:
  - `reads <n> (<outcome> <k>, …)`, listing the non-zero outcomes in the order of D5;
  - `stale previews served <s>`;
  - `uploads <n> (<b> bytes[, rejected <r>])`, where `<n>` = stored + rejected; when nothing was stored the section is `(rejected <r>)` alone;
  - `variants <n> (<b> bytes)`;
  - `claims <n> (average wait <w> ms)`, with `<w>` rounded.

  `<S>` = `Math.max(1, Math.round((flushTime − windowStart) / 1000))`, using `Date.now()`. Calls without a `resizer` label are summed under none, and that line starts `resize: over <S> s: `.
- **The window.** When no window is open, the first summed event records `windowStart`, arms `setTimeout(flush, summaryIntervalMs)` and calls `unref?.()` on it. `flush()` clears the timer, writes one line per Resizer that has counts, and empties the window. With nothing counted it writes nothing. No timer exists between windows.
- **`debug: true`.** Only when `typeof logger.debug === 'function'`, every call also writes `` logger.debug(`resize metric ${name} ${value} ${JSON.stringify(labels ?? {})} ${JSON.stringify(context ?? {})}`) ``. A throwing `debug` is ignored, and `info` goes through `logNeverThrow(…, 'info')`. The cost is two `JSON.stringify` calls per event. `appLogger.debug` always exists, so a `FrameworkResizer` pays that cost even when the app drops debug lines; this is documented in Task 8. A name `LogMetrics` does not know gets only the debug line.
- **`NoopMetrics extends ResizeMetrics`**: both methods do nothing.

### D4. The bound sink (R-S5-8, R-S5-9)

`boundMetrics(metrics: ResizeMetrics, opts: { resizer: string; logger: ResizeLogger; pipelineLabel?: (name: string) => string }): ResizeMetrics & { flush(): Promise<void> }` is internal, in `src/metrics.ts`. Every service and the worker use only bound sinks. On every `count` and `timing` call it:
- adds `resizer`;
- rewrites `labels.pipeline` through `pipelineLabel` (the Resizer passes `(p) => (this.hasPipeline(p) ? p : 'unregistered')`), and when the value changes, moves the raw value to `context.pipeline`;
- rewrites `labels.code` to `'other'` when it is not in `RESIZE_ERROR_CODES` (D13), and moves the raw value to `context.code`.

It never throws and never lets a rejection escape:
- A synchronous throw is caught.
- A returned thenable gets `.then(undefined, onFailure)`.
- The first failure of each method (`count`, `timing`, `flush`) is logged once per bound sink through `logNeverThrow`: "resize: the metrics sink of Resizer '<r>' failed on '<name>' — further failures of <method>() are not logged".

Its `flush()` calls the sink's `flush` when present, with the same guard, and resolves (never rejects) when that call settles.

### D5. The read outcome

`Reader.resolve` decides the outcome in this order (D9 defines the queue list):
1. An unregistered pipeline → `unknown-pipeline`.
2. No missing cell and no stale cell → `ready`.
3. Nothing left to queue after `beforeEnqueue` and the format split → `suppressed`.
4. The caller passed `opts.enqueueMissing === false` → `suppressed`.
5. No `original.storageRef` → `no-original`.
6. No Dispatcher → `failed` when `queueFailure` is set, else `eager-only`. The warning is written (once, D6) only when the caller passed `enqueueMissing: true`; today's branch is `src/reader.ts:186-197`.
7. Otherwise, the Dispatcher's outcome: `enqueued` for `added`; `in-flight` for `in-flight` and `gate-held`; `failed` for every other status.

An error caught by the never-throw guard, and `Resizer.resolve` when the services cannot start (`src/resizer.ts:679-688`), give `failed`.

Summary order: `ready`, `enqueued`, `in-flight`, `suppressed`, `eager-only`, `no-original`, `unknown-pipeline`, `failed`.

The Dispatcher gains `enqueueWithOutcome(req): Promise<{ added: number; outcome: 'enqueued' | 'in-flight' | 'suppressed' | 'failed' }>`; no variants gives `suppressed`. `enqueue(req)` keeps its signature and returns `.added`, so `src/dispatcher.test.ts` does not change.

### D6. Per-read logs (owner O8, F10)

| Today | After S5 |
|---|---|
| `src/reader.ts:84-88` unknown pipeline, `error` per read | `error` once per pipeline name per Reader, with the set capped at 100 names (no new ones after that); outcome `unknown-pipeline` |
| `src/reader.ts:188-191` no original, `info` per read | no log; outcome `no-original` |
| `src/reader.ts:193-197` eager-only, `warn` per read | `warn` once per Reader; outcome `eager-only` |
| `src/reader.ts:101,179` dropped formats, `error` per read | once per distinct `label + JSON list` per Reader, capped at 100 keys; `prewarm()` unchanged |
| `src/reader.ts:135-138` `publicUrl` failed; `:208-211` enqueue threw | unchanged |

A Reader is rebuilt only when its Dispatcher's state changes (`src/resizer.ts:464-469, 474-512`). The rebuild re-arms the once-logs; this is accepted.

### D7. The freshness rules (owner O5, O6; R-S5-6), pure, in `src/freshness.ts`

```ts
export function expectedOrigin(original: Original | undefined, dims?: { width: number; height: number }): string | undefined;
// previewOrigin(original.storageRef, d) where d = dims ?? the original's stored { width, height } (both numbers);
// undefined when there is no storageRef or no d
export function isFreshRow(row: Preview, expect: { encodeSig: string; origin: string | undefined }): boolean;
// expect.origin !== undefined && row.origin === expect.origin && typeof row.encodeSig === 'string' && row.encodeSig === expect.encodeSig
```

- **The expected `encodeSig`** of a row is `encodeSignature(config, { format: row.format, fit: row.fit === true, version })`. `version` is the registered pipeline's current `version`, read from the live object. The worker sets `row.fit` (`src/processor.ts:315-317`) and signs with it (`:820-824`), so the reader and the worker agree for every payload.
- **The expected `origin`** follows the writer's recipe exactly: `previewOrigin(storageRef, dims)`, where `dims` are the stored dimensions, or the decoded size when none are stored (`src/processor.ts:698-707`).
  - The read path cannot decode, so on a media without stored dimensions no row is proven fresh: every row is stale and gets queued.
  - The worker downloads and inspects the original (Sharp metadata, before any pixel decode), and passes the measured size as `dims`. It skips rows that turn out fresh and always records the dimensions (D10, D11). So such a media takes one download-and-inspect task with no upload, and the next read finds its rows fresh.
  - A store that drops the dimension backfill causes one download-and-inspect task (no upload) per read after each task. The gate bounds it. The worker warns once per Processor (D11), and the docs say a MediaStore must save `backfillDims` (Task 8).
  - "Stored dimensions" means both `width` and `height` are numbers, for the reader AND the worker. Today the writer counts any value other than `undefined` (`src/processor.ts:698-701`); Task 7 aligns it. A stored `null` is therefore treated as missing: the worker backfills it once (MongoMediaStore's `$set` overwrites it, `src/drivers/mongo/media.ts:235-246`), the rows regenerate once, and later reads are fresh.
  - Replacing `original.storageRef` always makes the rows stale.
- **A row missing either field is stale** (F9, owner O6).

### D8. The Catalog applies the rules (R-S5-5, R-S5-10)

`new Catalog({ config, versionOf })` takes `versionOf: (pipeline: string) => string | undefined`, which reads the live pipeline object. Nothing is cached across calls, and no host object is frozen. New methods:
- **`encodeSig(pipeline, format, fit): string`** computes the signature on each call.
- **`splitStored(media, scope, originDims?): { fresh: Map<string, Preview>; stale: Map<string, Preview> }`**:
  - computes the expected `origin` once per call;
  - computes the expected `encodeSig` at most once per `format` and `fit` within the call;
  - groups usable rows by identity through the new `storedPreviewRows`, and for each identity keeps the last fresh row in `fresh`, or the last row in `stale` when none is fresh.
- **`freshIdentities(media, scope, originDims?): Set<string>`**.

`src/images.ts` gains `storedPreviewRows(media, scope): Map<string, Preview[]>`: usable rows of the scope in store order. `storedPreviews` becomes its last row per identity (unchanged behaviour). This keeps "only images.ts decides which stored rows count" (`src/architecture.test.ts:76`).

In Task 7, `missing()` excludes only fresh identities. `storedIdentities()` keeps meaning "any usable row", because the PreviewRecorder's reconciliation uses it.

The per-call cost is one SHA-256 for the origin, plus one canonical JSON and one SHA-256 per distinct format and fit flag of the stored rows.

### D9. The read decision (owner O5; R-S5-14)

- **New fields.** `ReadyEntry.stale?: true` and `ReadDecision.stale?: MissingPreview[]`. Each is set only when there is a stale cell, so `deepEqual` on a fresh decision does not change.
- **One queue list.** For each stale cell, its variant joins the queue list BEFORE `publicUrl` is called. When `publicUrl` throws, the cell is not served but stays queued: a new render gets a new ref. A fresh cell whose `publicUrl` throws is skipped as today.
- **Hook and split.** Stale and missing variants form one list, in cell order, for `beforeEnqueue`. After the hook and the format split:
  - a variant whose identity was stale goes to `decision.stale`;
  - every other variant goes to `decision.missing`;
  - both are queued as one task.
- **Unregistered pipeline.** Every stored row is served as fresh; nothing can be queued for it.
- **`prewarm()`.** `ready` holds only fresh variants. Stale ones are required and queued like missing ones.

### D10. Writing replacements (R-S5-7; Opus M4, M7)

`PreviewRecorder.record(mediaId, scope, previews, backfillDims?, replacing?: ReadonlySet<string>)`:
1. `requireReplacePreviews(mediaStore)` runs first whenever `replacing` holds an identity. `requireReplacePreviews` and the result check move from `src/processor.ts:105-120` to `src/previewRecorder.ts`, exported as `requireReplacePreviews` and `checkReplaced`. `src/processor.ts` (`invalidate`, `:478-487`) and `src/resizer.ts:29,607` import them from there.
2. The rows not in `replacing` go to `appendPreviews(mediaId, rows, backfillDims)`, with today's reconciliation. The call is made when there are rows to append OR `backfillDims` is set; it is `appendPreviews(mediaId, [], dims)` when only backfilling, as the contract requires (`src/contracts/media.ts:47-48`).
3. The rows in `replacing` go to ONE `replacePreviews(mediaId, [], rows)`.
   - A result that is not `{ stored, removed }` is `RESIZE_MEDIA_REPLACE_RESULT_INVALID`, with today's text.
   - A rejected replace logs the uploads no row points at (as the append path does, `src/previewRecorder.ts:76-92`) and rethrows.
   - A replace that stores nothing and removes nothing means the media is gone: today's warning, with the refs.
   - When `removed.length > 0`, one `info` line: "resize: replaced <n> outdated preview(s) of media <id>; their files are not deleted: storage refs <refs>".
4. `RecordResult` gains `removed: Preview[]`. A concurrent fresh row of the same identity is removed too (last write wins), and its ref is in that log line.

### D11. `generate()` and the worker (R-S5-14)

- **Pending.** Pending = requested minus fresh identities, so stale ones render. `replacing` = the pending identities that `storedIdentities` holds.
- **No stored dimensions.** `storedDims` (`src/processor.ts:698-701`) requires both values to be numbers (D7). After the source is loaded and measured (`:698-707`, before the pixel decode), `#renderPending` removes from pending the identities that `catalog.freshIdentities(media, scope, mediaDims)` holds.
- **Persist.** The persist runs when `persist` is on and there are rows OR `backfillDims` is set (`:854`). The second case covers the D7 download-and-inspect task.
- **A store that dropped the backfill.** In `processTask`, when `#renderPending` passed `backfillDims` and the reloaded media (`:566`) still has no numeric `original.width`/`height`, the Processor warns once per Processor: "resize worker: the media store did not record the original's dimensions of media <m> — every read of such a media queues a task that downloads the original; a MediaStore must save backfillDims in appendPreviews".
- **`generate()` and the caller's media.** When `generate()` backfilled, it also sets `media.original.width` and `media.original.height` on the caller's in-memory media, as it already appends `media.previews` (`:443-445`). The edit is guarded like `invalidate`'s in-memory edit: an object that cannot be changed logs a warning and nothing throws. So a `resolve()` or `generate()` on that object in the same request finds the rows fresh.
- **Completion check.** The worker's completion check (`:576-591`) counts only identities in `catalog.freshIdentities({ original: refreshed.original, previews: [...media.previews, ...refreshed.previews, ...generated] }, scope, originDims)`, where `originDims` is the size `#renderPending` signed with (returned from it). The identity-only `alreadyStored` shortcut no longer counts as coverage. A concurrent row with other signatures leaves the variant uncovered, so the task fails with `RESIZE_WORKER_INCOMPLETE` and the retry replaces it. `alreadyStored` stays for the duplicate log.
- **`generate()`** also swaps in memory: rows whose `identity` string was replaced leave `media.previews`, then the new rows are appended. `GenerateResult.replaced?: StorageRef[]` holds the removed refs. It is set only when non-empty (like `decision.stale`), so it is absent for `persist: false`.
- **Metrics when the persist throws.** Each rendered variant records `resize.variant` with outcome `failed` and the error's code, then the error propagates as today (Task 3).

### D12. API and workers with different settings (Opus I6, M9; R-S5-13)

- **The worker's view wins.** The worker judges freshness by its own config. A variant the reader queued that is fresh for the worker is skipped: nothing is uploaded, and it counts as covered.
- **The warning.** On a task's first delivery (`attempts === 1`), the media has stored dimensions, and every requested identity is already fresh. The Processor then warns once per pipeline per Processor: "resize worker: task <id> of media <m> found every requested preview of pipeline '<p>' already fresh — if this repeats, the API and the worker may run different image settings or pipeline versions, or resolve() was given the media without its stored original (storageRef, width, height)". The second cause is a projection that drops `original.width`/`height`, or a reshaped ref. It may fire once after an eager `generate()` filled variants a read had queued; the text says "if this repeats".
- **Churn.** The gate bounds it: at most one no-op task per read after the previous task ends.
- **Two worker versions with different settings** (a rolling deploy or a canary) are not a no-op. Each re-renders the other's rows, which costs one render, one upload and one orphaned file per read-after-task while both run. Task 8 documents the rollout: change image settings or a pipeline `version` with every worker at once (drain the old workers first). No code change (R-S5-13).

### D13. Error codes

- **New:** `RESIZE_METRICS_INVALID` (`ResizeSetupError`, `retryable: false`), raised for:
  - a `metrics` option without `count` and `timing` functions: "resize: `metrics` must have count() and timing() functions — e.g. new LogMetrics(logger) or new NoopMetrics()". It is thrown in the constructor, before the name is registered.
  - a bad `summaryIntervalMs`.
- **New internal set** `src/errorCodes.ts`: `export const RESIZE_ERROR_CODES: ReadonlySet<string>`, holding every code literal that a shipped source file uses. That is 106 distinct literals today, plus `RESIZE_METRICS_INVALID`.
  - `src/architecture.test.ts` checks two things:
    - every `'RESIZE_[A-Z0-9_]+'` literal in a shipped source file (not a test, not under `testHelpers/`) is in the set;
    - every entry occurs in a shipped source file OTHER than `src/errorCodes.ts`. Without that exclusion the check is always true.
  - The existing guard 'lock settings are validated only in the core' (`src/architecture.test.ts:117-131`) forbids `RESIZE_CONFIG_COORDINATION_INVALID` outside `coordination.ts`. Its second filter becomes `f !== 'coordination.ts' && f !== 'errorCodes.ts'`. The declarative list may then name the code, while only `coordination.ts` validates and throws it. The `drivers/` half of that guard is unchanged.
  - The set is not exported from the main entry.
- **Renamed or removed:** none. `EnqueueIssue.code` and `HookName` stay closed unions.

### D14. Task order keeps every commit green

1. The port, the bound sink and the code set.
2. Read metrics, with the `stampFresh` test helper.
3. Upload and variant metrics.
4. Worker metrics.
5. The pure freshness rules and the Catalog.
6. Freshness on the read path; this task stamps the read-path test seeds.
7. Freshness in `generate()` and the worker; this task stamps the processor and worker seeds.
8. Docs.

## Global Constraints

- **Branch and repository.**
  - Branch `refactor/s5-metrics-freshness` in the worktree `.claude/worktrees/s1-ports-and-composition-root`, from main `3a5820d`.
  - Each task ends with one commit; nothing is pushed.
  - Git is plain, one command per call (stage, then commit). Never `git -C`, no compound commands.
  - The docs-site step runs inside `/Users/andrey/Work/framework-documenation-github`, branch `docs/s5-metrics-freshness`, page `docs/12-resize.md`.
- **Scope.** F8, F9 (the read-path check and the replacing write), and the F10 per-read-log item. Out of scope:
  - S6 hygiene: tests in `types:check`, superseded notes, S3 `Cache-Control`, the scaffold/README/AGENTS export match;
  - an engine port;
  - a `Resizer.close()`.
- **The rc promise.** This ships as `0.3.0-rc.4` and only adds API:
  - values `ResizeMetrics`, `LogMetrics`, `NoopMetrics`; types `MetricLabels`, `MetricContext`, `LogMetricsOptions`;
  - `ResizerOptions.metrics` and `resizer.metrics`;
  - `ResizeLogger.debug?`, `ReadyEntry.stale?`, `ReadDecision.stale?`, `GenerateResult.replaced?`;
  - the code `RESIZE_METRICS_INVALID`.

  Nothing a host wrote is renamed or removed. These behaviour changes each get a CHANGELOG entry:
  - freshness regeneration, with its storage cost;
  - `beforeEnqueue` also receives stale variants;
  - per-read logs become once-logs and metrics;
  - one summary line per window and one line per task outcome, at `info`.
- **Unchanged:**
  - the preview identity;
  - `src/signatures.ts`, byte for byte;
  - `resolve()`: it never throws, never runs Sharp, and does no I/O beyond today's one enqueue;
  - the S2 gate and `invalidate()`;
  - `isCatalogCovered`, which checks identities only (documented);
  - `resizeMediaSchemaFragment` (owner O7).
- **House rules.**
  - Classes own their behaviour; module-private helpers take narrow parameters.
  - No service imports `resizer.ts`.
  - `drivers/**` import only contracts, errors, helpers, types and drivers. `src/contracts/metrics.ts` imports only types.
  - Errors are recognized by the `isResizeError` brand, never `instanceof`. Sinks are checked by duck typing.
  - No test-only seams in shipped code; tests use `mock.timers`.
  - No `any` without a `biome-ignore` reason. `src/types.d.ts` stays dependency-free.
  - Comments state reasons in plain words, with no spec-section references and no private project names.
  - Tests never spread class-typed values.
  - The main entry imports no framework code and no mongoose.
  - `src/consumer.ts` and `src/worker.ts` log only through `logNeverThrow` (`src/architecture.test.ts:86-103`).
- **Checks.**
  - Every task ends with `npm run types:check`, `npm run check` and `npm test` passing.
  - Tasks 1, 4, 7 and 8 also run `npm run build` and then `npm run smoke`.
  - To run one file: `node --experimental-strip-types --test src/<file>.test.ts`.
  - Test files stay outside `types:check`. Add no new type errors in `src/testHelpers/**`, which is checked.
- **Existing tests.** Each task names every existing test whose assertion it reverses, as a rewrite. A test that fails for any reason the task does not name stops the task: report it.
- **Commit messages** use a conventional prefix, with NO `Co-Authored-By` and no "Generated with" trailer.

## Review Focus

1. **The API and the worker run different image settings** (a worker deployed with `webp.quality` 70 while the API still has 80). Expected: no loop inside the worker, no upload, one warning naming the possible mismatch, and at most one no-op task per read after the previous task ends. (Test: Task 7.)
2. **A stale row whose regeneration keeps failing** (its original is gone from storage). Expected: `resolve()` keeps serving the stale row with `stale: true`, the task dead-letters, and reads queue nothing during the cooldown. (Test: Task 7.)
3. **A media whose original has no width and height, with stored rows.** Expected:
   - the read marks the rows stale and queues once;
   - the worker downloads and inspects the original, uploads nothing for rows that are fresh by the measured size, and records the dimensions (a store that drops them gets one warning);
   - the next read finds the rows fresh and queues nothing;
   - a row with another `encodeSig`, or an original whose `storageRef` changed, is regenerated.

   (Tests: Tasks 5, 6 and 7.)
4. **A host metrics sink that throws or rejects** (a broken or `async` Prometheus adapter). Expected: `resolve()`, `uploadOriginal()`, `generate()` and the worker loop behave as without metrics, there is no `unhandledRejection`, and one error line per failing method names the sink. (Tests: Tasks 1, 2 and 4.)
5. **A store whose rows of one identity come in an unexpected order.** Examples: a custom `replacePreviews` that puts the new row first, or a stale row from before 0.3.0 with no `identity` that is never removed. Expected: the fresh row is served and the next read queues nothing, whatever the order. (Tests: Tasks 5 and 7.)

---

## File structure

| File | Change | Responsibility after S5 |
|---|---|---|
| `src/contracts/metrics.ts` | Create | `ResizeMetrics`, `MetricLabels`, `MetricContext` |
| `src/metrics.ts` | Create | `LogMetrics`, `LogMetricsOptions`, `NoopMetrics`; internal `boundMetrics`, `isMetrics` |
| `src/errorCodes.ts` | Create | `RESIZE_ERROR_CODES` (internal) |
| `src/freshness.ts` | Create | `expectedOrigin`, `isFreshRow` (pure) |
| `src/images.ts` | Modify | `storedPreviewRows`; `storedPreviews` built on it |
| `src/catalog.ts` | Modify | `versionOf`; `encodeSig`, `splitStored`, `freshIdentities`; fresh-aware `missing` |
| `src/reader.ts` | Modify | Read outcome and metrics; once-logs; stale cells served and queued |
| `src/dispatcher.ts` | Modify | `enqueueWithOutcome` |
| `src/uploader.ts` | Modify | Upload metrics |
| `src/processor.ts` | Modify | Variant metrics; stale variants rendered and replaced; post-decode fresh filter; `replaced`; the D12 warning |
| `src/previewRecorder.ts` | Modify | Append or backfill, then one replace; `removed`; `requireReplacePreviews`, `checkReplaced` |
| `src/consumer.ts` | Modify | Claim and task metrics (`metricsOf`) |
| `src/worker.ts` | Modify | `metricsOf` per task's Resizer; awaited flush at stop |
| `src/resizer.ts` | Modify | `metrics` option and getter; bound sink to services; internal `metricsOf` |
| `src/types.d.ts` | Modify | `ResizeLogger.debug?`, `ReadyEntry.stale?`, `ReadDecision.stale?`, `GenerateResult.replaced?` |
| `src/framework/app.ts`, `src/framework/resizer.ts` | Modify | `appLogger.debug`; default `LogMetrics` with `debug: true` |
| `src/index.ts`, `src/index.test.ts`, `smokeTest.ts` | Modify | New exports |
| `src/testHelpers/fakes.ts` | Modify | `recordingMetrics()`; `docMedia` replaces on the document, applies `backfillDims` (also with no rows), and records its calls |
| `src/testHelpers/fresh.ts` | Create | `stampFresh()` |
| `src/testHelpers/consume.ts` | Modify | Passes `metricsOf` |
| `src/contracts/pipeline.ts` | Modify | `version` JSDoc (Task 8) |
| `README.md`, `AGENTS.md`, `CHANGELOG.md`, `RELEASE.md`, `docs/host-adoption.md`, `package.json`, `package-lock.json`, docs site | Modify | Docs and `0.3.0-rc.4` |

---

### Task 1: The metrics port, `LogMetrics`, `NoopMetrics`, the bound sink and the `metrics` option

**Files:**
- Create: `src/contracts/metrics.ts`, `src/metrics.ts`, `src/errorCodes.ts`, `src/metrics.test.ts`.
- Modify:
  - `src/types.d.ts:23-27`: add `debug?(msg: string, ...rest: unknown[]): void` to `ResizeLogger`.
  - `src/resizer.ts`:
    - `ResizerOptions.metrics?: ResizeMetrics`;
    - the constructor check runs before `registry.register` (`:321`);
    - `get metrics(): ResizeMetrics`;
    - a private bound sink;
    - internal `metricsOf` through the static block (`:217-240`).
  - `src/framework/app.ts:39-43`: `debug: (msg, ...rest) => getApp().logger.debug?.(msg, ...rest)`.
  - `src/framework/resizer.ts:106-133`: `metrics: rest.metrics ?? new LogMetrics(logger ?? appLogger, { debug: true })`.
  - `src/index.ts`, `src/index.test.ts:64` (the exact value-export list gains `LogMetrics`, `NoopMetrics`, `ResizeMetrics`) and `smokeTest.ts` (the same three).
  - `src/testHelpers/fakes.ts`: add `recordingMetrics()`.
  - `src/architecture.test.ts`: add the code-set check (D13). The existing guard 'lock settings are validated only in the core' (`:117-131`) also allows `errorCodes.ts` in its `RESIZE_CONFIG_COORDINATION_INVALID` filter. That is a named change to an existing test: without it, Task 1 is red.
- Test: `src/metrics.test.ts`, `src/resizer.test.ts`, `src/framework/resizer.test.ts`, `src/architecture.test.ts`.

**Interfaces:**
- Produces:
  - D2's `ResizeMetrics`, `MetricLabels`, `MetricContext`;
  - D3's `LogMetrics`, `LogMetricsOptions`, `NoopMetrics`;
  - D4's `boundMetrics` and `isMetrics(value: unknown): value is ResizeMetrics` (both internal);
  - D13's `RESIZE_ERROR_CODES`;
  - on `Resizer`: `readonly metrics: ResizeMetrics` (the host's sink or the default);
  - in `src/resizer.ts`: `export function metricsOf(resizer: Resizer): ReturnType<typeof boundMetrics>` (the bound sink; internal, `@internal`, not on the main entry).

  ```ts
  // src/testHelpers/fakes.ts
  export interface MetricCall { kind: 'count' | 'timing'; name: string; value: number; labels: MetricLabels; context: MetricContext }
  export function recordingMetrics(): ResizeMetrics & { calls: MetricCall[]; flushes: number }; // labels/context default {}
  ```

- [ ] **Step 1: Write the failing tests.**

  `src/metrics.test.ts` uses `mock.timers.enable({ apis: ['setTimeout', 'Date'] })` in a `beforeEach`, `mock.timers.reset()` in `afterEach`, and a logger that records `info`, `warn`, `error` and `debug` lines:
  ```ts
  test('request-path events are summed into one info line per window, only when something was counted', …)
  // 50 × count('resize.read', 1, { resizer: 'default', pipeline: 'default', outcome: 'ready' }) → info.length 0;
  // tick(59_999) → 0; tick(1) → info deepEqual ["resize: Resizer 'default' over 60 s: reads 50 (ready 50)"];
  // tick(600_000) → still 1 line
  test('the summary lists its sections in a fixed order', …)
  // reads: ready 3, enqueued 1, in-flight 2; count('resize.preview.stale', 2); timing('resize.upload', 5, { outcome: 'stored', format: 'png' }) twice with
  // count('resize.upload.bytes', 100) and (…, 50); timing('resize.upload', 1, { outcome: 'rejected', code: 'RESIZE_ORIGINAL_EMPTY' });
  // timing('resize.variant', 9, { outcome: 'stored', … }) ×3 with count('resize.variant.bytes', 300) once; timing('resize.claim', 10) and (…, 30) — all with resizer 'default';
  // tick(60_000) → "resize: Resizer 'default' over 60 s: reads 6 (ready 3, enqueued 1, in-flight 2), stale previews served 2, uploads 3 (150 bytes, rejected 1), variants 3 (300 bytes), claims 2 (average wait 20 ms)"
  test('one summary line per resizer label, in first-seen order; a call without one goes to a line without a Resizer', …)
  test('a task outcome and a failed variant are written at once, one info line each, and not summed', …)
  // timing('resize.task', 1234.4, { resizer: 'default', queue: 'default', pipeline: 'default', outcome: 'completed' }, { taskId: 't1', mediaId: 'm1', attempts: 1, variants: 3 })
  //   → "resize: task t1 of media m1 completed in 1234 ms (Resizer 'default', queue 'default', pipeline 'default', attempt 1, variants 3)"
  // timing('resize.task', 5, { …, queue: 'bulk', outcome: 'dead', code: 'RESIZE_SOURCE_DECODE_FAILED' }, { taskId: 't2', mediaId: 'm2', attempts: 5, variants: 1 })
  //   → "resize: task t2 of media m2 dead in 5 ms (Resizer 'default', queue 'bulk', pipeline 'default', attempt 5, variants 1, code RESIZE_SOURCE_DECODE_FAILED)"
  // timing('resize.variant', 40, { resizer: 'default', pipeline: 'default', format: 'webp', mode: 'task', outcome: 'failed', code: 'other' }, { mediaId: 'm1', identity: 'default:default:300x300:webp:none', code: 'HOST_X' })
  //   → "resize: variant default:default:300x300:webp:none of media m1 failed in 40 ms (Resizer 'default', pipeline 'default', format 'webp', code HOST_X)"
  // then tick(60_000) → no further line
  test('debug lines: one per call when debug is on, none by default, and a logger without debug is fine', …)
  // { debug: true }: count('resize.read', 1, { outcome: 'ready' }, { mediaId: 'm1' }) → debug ['resize metric resize.read 1 {"outcome":"ready"} {"mediaId":"m1"}']
  test('flush() writes the pending summary now and closes the window; with nothing counted it writes nothing', …)
  test('summaryIntervalMs must be a positive safe integer', …) // 0, -1, 1.5, NaN, '60000' → ResizeSetupError, code RESIZE_METRICS_INVALID, retryable false
  test('a logger whose info throws does not throw out of the window timer', …)
  test('NoopMetrics records nothing', …)
  test('boundMetrics adds the resizer label and normalizes pipeline and code labels', …)
  // pipelineLabel (p) => (p === 'default' ? p : 'unregistered'): count('x', 1, { pipeline: 'retired', code: 'HOST_X' }) → recorded labels
  // { resizer: 'r1', pipeline: 'unregistered', code: 'other' }, context { pipeline: 'retired', code: 'HOST_X' };
  // { pipeline: 'default', code: 'RESIZE_SOURCE_DECODE_FAILED' } passes unchanged with no context added
  test('boundMetrics never throws, and logs the first failure of each method once', …)
  // sink.count throws twice, sink.timing throws once → no throw; logger.error twice (one per method), messages match /metrics sink of Resizer 'r1' failed on 'resize\./
  test('boundMetrics catches rejected promises from count, timing and flush', …)
  // sink { async count() { throw new Error('x') }, async timing() { throw … }, async flush() { throw … } };
  // process.on('unhandledRejection', record) for the test, removed with process.off('unhandledRejection', record) in a finally;
  // call each, await bound.flush() (resolves), await setImmediate → no unhandledRejection recorded; logger.error three times (one per method)
  test("the window timer is unref'd: a process that counts one event exits at once", …)
  // spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', <import LogMetrics from src/metrics.ts by absolute URL; count one 'resize.read'>]) → status 0 within 5 s (timeout option 5000)
  ```

  In `src/architecture.test.ts`:
  ```ts
  test('every error code a shipped file uses is in RESIZE_ERROR_CODES, and every entry is used', …)
  // scan 1: every literal of shipped files (no *.test.ts, no testHelpers/) is in the set;
  // scan 2: every entry occurs in a shipped file other than errorCodes.ts
  ```
  In the same file, the existing 'lock settings are validated only in the core' (`:117-131`) changes its second filter to `f !== 'coordination.ts' && f !== 'errorCodes.ts'`; its assertions stay.

  Every test in this task that adds a `process.on('unhandledRejection', …)` listener removes it with `process.off` in a `finally` (Tasks 2 and 4 follow the same rule).

  In `src/resizer.test.ts`:
  ```ts
  test('metrics: the default is a LogMetrics on the Resizer logger; the option wins; resizer.metrics is that sink', …)
  test('a metrics option without count and timing is RESIZE_METRICS_INVALID, and the name stays free', …) // {} and { count() {} }; then new Resizer with the same name succeeds
  ```

  In `src/framework/resizer.test.ts`:
  ```ts
  test('the default metrics of a FrameworkResizer write debug lines through the app logger', …)
  // fake app logger with debug recording; r.metrics instanceof LogMetrics; r.metrics.count('x', 1) → one app debug line starting 'resize metric x 1'
  ```
- [ ] **Step 2: Run them to verify they fail.** Run: `node --experimental-strip-types --test src/metrics.test.ts`. Expected: FAIL (`Cannot find module './metrics.ts'`).
- [ ] **Step 3: Implement** the port, `LogMetrics`, `NoopMetrics`, `boundMetrics`, `isMetrics`, `RESIZE_ERROR_CODES` (filled from the shipped sources: 106 literals plus `RESIZE_METRICS_INVALID`), the option, the getter, `metricsOf`, the logger `debug`, the framework default and the exports, per D2–D4 and D13. The Resizer keeps the raw sink as `metrics` and keeps `boundMetrics(sink, { resizer: name, logger, pipelineLabel })` privately. Task 1 hands the bound sink to no service yet.
- [ ] **Step 4: Run everything.** Run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS.
- [ ] **Step 5: Stage.** `git add src smokeTest.ts`
- [ ] **Step 6: Commit.** `git commit -m "feat: a metrics port, LogMetrics and NoopMetrics, and the metrics option"`

---

### Task 2: Read metrics; per-read logs become metrics

**Files:**
- Modify:
  - `src/reader.ts`:
    - `ReaderDeps.metrics?: ResizeMetrics`, defaulting to a module-level `new NoopMetrics()`;
    - the D5 outcome, recorded once per `resolve()` call, the guard's error path included;
    - the once-logs of D6.
  - `src/dispatcher.ts`: add `enqueueWithOutcome`; `enqueue` delegates to it.
  - `src/resizer.ts`:
    - `#buildReader` (`:474-512`) passes the bound sink;
    - the start-failure catch in `resolve()` (`:679-688`) counts `failed`, with `pipeline` raw (the bound sink normalizes it).
- Create: `src/testHelpers/fresh.ts`.
- Test: `src/reader.test.ts`, `src/resizer.test.ts`.

**Interfaces:**
- Consumes: `recordingMetrics()` and `metricsOf` (Task 1).
- Produces:
  ```ts
  // src/reader.ts
  export type ReadOutcome = 'ready' | 'enqueued' | 'in-flight' | 'suppressed' | 'eager-only' | 'no-original' | 'unknown-pipeline' | 'failed';
  // src/dispatcher.ts, on Dispatcher
  enqueueWithOutcome(req: DispatchRequest): Promise<{ added: number; outcome: 'enqueued' | 'in-flight' | 'suppressed' | 'failed' }>;
  // src/testHelpers/fresh.ts
  export function stampFresh<M extends MediaLike>(
    media: M,
    opts?: { config?: ResizeConfig; version?: string | ((pipeline: string) => string | undefined) },
  ): M;
  // Sets origin and encodeSig on every row of media.previews in place, as D7 expects them:
  // origin = previewOrigin(original.storageRef, { width, height }) from the stored dims;
  // encodeSig = encodeSignature(config ?? defaultResizeConfig, { format: row.format, fit: row.fit === true, version }),
  // where version is opts.version, or opts.version(row.pipeline ?? 'default') when it is a function.
  // Throws a plain Error "stampFresh: the original needs storageRef, width and height" otherwise. Returns media.
  ```

- [ ] **Step 1: Write the failing tests and rewrite the reversed ones.**

  In `src/reader.test.ts`: the Resizer gets `metrics: recordingMetrics()`, and seeded rows go through `stampFresh(media, { config: r.config })` after `await r.ready()`.
  ```ts
  test('each resolve() counts one read with its outcome', …)
  // calls filtered to name 'resize.read', labels.outcome per case:
  //  stored rows only → 'ready' (context { mediaId: 'm1', ready: 1, missing: 0, stale: 0 }); a missing cell on MemoryTaskQueue → 'enqueued';
  //  the same read again → 'in-flight'; enqueueMissing: false → 'suppressed'; a beforeEnqueue tap returning [] → 'suppressed';
  //  no task queue (enqueueMissing not passed) → 'eager-only' and no warn; no task queue with enqueueMissing: true → 'eager-only' and one warn;
  //  no original → 'no-original'; pipeline 'retired' (unregistered) → 'unknown-pipeline' with labels.pipeline 'unregistered' and context.pipeline 'retired';
  //  PlainTaskQueue without locks (queueFailure) → 'failed'; labels.resizer is the Resizer's name in every case
  test('a route whose build fails: resolve() serves the stored previews, logs once, and counts failed', …)
  // router { default: memory, bulk: async () => { throw new Error('boom') } }; media with one stamped stored cell AND one missing cell;
  // two resolve({ queue: 'bulk' }) → the stored cell served both times, one error line matching /its backend could not be built/,
  // two 'failed' reads (this is the S4 deferred minor, now tested through Resizer.resolve())
  test('a read on a media without original logs nothing', …) // three reads: info, warn, error all empty
  test('an unregistered pipeline is logged once per name, and at most 100 names', …) // 'retired' ×2 and 'old' ×1 → errors.length 2; 150 distinct names → errors.length 100
  test('the eager-only warning is written once', …) // enqueueMissing: true, no task queue, three reads → warn.length 1
  test('a dropped per-call format list is logged once per list', …) // ['jpg'] ×2, ['bmp'] ×1 → 2 errors
  test('a metrics sink that throws or rejects never breaks a read', …)
  // metrics { count() { throw new Error('x') }, timing() { throw … } } and an async rejecting one → decision as without, one error naming the sink,
  // no unhandledRejection (Review Focus 4)
  ```

  In `src/resizer.test.ts` (Done-when, part 1):
  ```ts
  test('with the default metrics, 50 warm reads write no info line until the summary', …)
  // new Resizer({ storage, media, logger: recording }) (default LogMetrics); mock.timers.enable({ apis: ['setTimeout', 'Date'] }) before the first read;
  // media with one stamped stored preview; 50 × resolve → info.length 0; tick(60_000) → info deepEqual ["resize: Resizer 'default' over 60 s: reads 50 (ready 50)"]
  test('resolve() on a Resizer that cannot start counts one failed read', …)
  ```

  Existing tests this task reverses (rewrite them):
  - `src/reader.test.ts:934` ('… original without storageRef …', FrameworkResizer): `assert.equal(info.length, 1)` becomes `assert.equal(info.length, 0)`. The rest is unchanged.
  - `src/reader.test.ts:955` ('an absent original leaves variants missing without enqueueing or locking'): the same change.

  Unchanged: the direct-construction fixtures (`src/reader.test.ts:120-135` `readerDeps`), because `metrics` is optional. `src/reader.test.ts:1002` (the eager-only warning, first read) and `:1439` (one dropped-format error) still pass, because their first read still logs.
- [ ] **Step 2: Run them to verify they fail.** Run: `node --experimental-strip-types --test src/reader.test.ts`. Expected: FAIL (no `resize.read` calls; `stampFresh` missing).
- [ ] **Step 3: Implement** `stampFresh`, `enqueueWithOutcome` (the D5 mapping; `enqueue` returns its `added`), the outcome in `Reader.resolve` in D5's order, the context counts (`stale: 0` until Task 6), and the once-logs of D6 (Reader-private `Set`s that stop growing at 100 keys).
- [ ] **Step 4: Run everything.** Run: `npm run types:check && npm run check && npm test`. Expected: PASS.
- [ ] **Step 5: Stage.** `git add src`
- [ ] **Step 6: Commit.** `git commit -m "feat: reads are counted with their outcome; per-read logs become metrics and once-logs"`

---

### Task 3: Upload and variant metrics

**Files:**
- Modify:
  - `src/uploader.ts`: `UploaderDeps.metrics?: ResizeMetrics`, defaulting to `NoopMetrics`; `upload()` times itself from entry to return or throw.
  - `src/processor.ts`:
    - `ProcessorDeps.metrics?: ResizeMetrics`, defaulting to `NoopMetrics`;
    - `RenderPendingArgs.mode: 'task' | 'eager'` and `taskId?: string`;
    - each variant is timed from encode start to upload end in `renderVariant` (`:788-844`);
    - failures are recorded in its `catch`;
    - successes are recorded after the persist (`:851-866`);
    - a persist that throws records `failed` with the error's code for each rendered variant, then rethrows.
  - `src/resizer.ts:443-463`: pass the bound sink to both.
- Test: `src/uploader.test.ts`, `src/processor.test.ts`.

**Interfaces:**
- Consumes: `recordingMetrics()` (Task 1).
- Produces: nothing later tasks rely on, beyond the D1 calls.

- [ ] **Step 1: Write the failing tests.**

  In `src/uploader.test.ts` (an `Uploader` with `metrics: recordingMetrics()`):
  ```ts
  test('a stored upload records its time and its bytes', …)
  // a 20×20 PNG → calls: timing 'resize.upload' labels { outcome: 'stored', format: 'png' } (value ≥ 0); count 'resize.upload.bytes' value body.length, labels { format: 'png' }
  test('a rejected upload records its code and still throws', …)
  // body Buffer.alloc(0) → rejects RESIZE_ORIGINAL_EMPTY; one call: timing 'resize.upload' labels { outcome: 'rejected', code: 'RESIZE_ORIGINAL_EMPTY' }; no bytes count
  ```

  In `src/processor.test.ts`:
  ```ts
  test('generate() records each stored variant in eager mode, with its bytes', …)
  // two variants → two timing 'resize.variant' labels { pipeline: 'default', format, mode: 'eager', outcome: 'stored' }, context { mediaId, identity };
  // two count 'resize.variant.bytes' with value === the row's bytes
  test('persist: false records rendered variants', …)
  test('a failed variant records failed with its code and is still logged at error', …) // a variantStep that throws a ResizeMediaError code 'RESIZE_PIPELINE_STEP_INVALID'
  test('a variant another worker stored first records duplicate', …) // appendPreviews leaves it out; the reload shows its identity
  test('a persist that throws records failed for every rendered variant and rethrows', …) // appendPreviews rejects new Error('db') → two 'failed', no code label
  test('processTask records task mode with the task id in the context', …)
  ```

  Existing tests: none change. The fixtures (`src/uploader.test.ts:124-128` and every direct `new Uploader({…})`; `src/processor.test.ts:420-438` `processorDeps` and `rowDeps`) need no edit, because `metrics` is optional.
- [ ] **Step 2: Run them to verify they fail.** Run: `node --experimental-strip-types --test src/uploader.test.ts src/processor.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Measure durations with `performance.now()`. `code` is the raw `err.code` of a branded error (`ResizeError.isResizeError(err)`). Leave the label out otherwise; the bound sink normalizes it. Every upload rejection is a `ResizeError`, so it always carries `code`.
- [ ] **Step 4: Run everything.** Run: `npm run types:check && npm run check && npm test`. Expected: PASS.
- [ ] **Step 5: Stage.** `git add src`
- [ ] **Step 6: Commit.** `git commit -m "feat: uploads and variants are timed and counted"`

---

### Task 4: Worker metrics: claims and task outcomes; the awaited flush at stop; a timing-sensitive test

**Files:**
- Modify:
  - `src/consumer.ts`:
    - `ConsumerDeps.metricsOf?: (task: LeasedTask) => ResizeMetrics | undefined`, which must not throw;
    - record the claim wait;
    - thread `runStart` into `#report(event, task, error?, runStart?)` (`:410-427`), with 0 ms for the over-`maxAttempts` dead-letter (`:210-221`).
  - `src/worker.ts`:
    - `metricsOf: (task) => owner ? metricsOf(owner) : undefined`;
    - after the loops end, in the `finally` around them, `await` each distinct bound sink's `flush()` once per distinct `resizer.metrics` object of the served Resizers, each bounded by `METRICS_FLUSH_TIMEOUT_MS = 5_000` (an `unref`'d timer).
  - `src/testHelpers/consume.ts`: pass `metricsOf`.
  - `src/consumer.test.ts:2016-2076`: the timing-sensitive test (Step 1).
- Test: `src/consumer.test.ts`, `src/worker.test.ts`.

**Interfaces:**
- Consumes: `metricsOf(resizer)` (Task 1).
- Produces: nothing later tasks rely on.
- The Consumer records:
  - **`timing('resize.claim', now − waitStart, { queue }, { taskId })`** when a claim returns a task. `waitStart` is set when the loop starts, and again after each claimed task is handled, given back or finished. An empty poll or a claim error does not reset it.
  - **`resize.task`**, in `#report`, after the queue call succeeded: `timing('resize.task', now − runStart, { queue, pipeline: task.pipeline, outcome, code? }, { taskId, mediaId, attempts, variants: task.previews.length })`.
    - `completed` → `'completed'`, `failed` → `'failed'`, `deadLettered` → `'dead'`.
    - `task.pipeline` is passed raw; the bound sink maps an unregistered name to `'unregistered'`.
    - A lost lease or a give-back records no task outcome.

- [ ] **Step 1: Make the timing-sensitive test deterministic.** In `src/consumer.test.ts:2016-2076` ('a renewal that never answers uses up the gate bound…'), the wrapped `release` resolves a `releaseLanded` promise after `base.release(...)` returns. Replace `await sleepMs(40)` (`:2052`) with `await releaseLanded`. The assertions do not change. Run: `node --experimental-strip-types --test src/consumer.test.ts`. Expected: PASS.
- [ ] **Step 2: Write the failing tests.**

  In `src/consumer.test.ts` (`consume(…, { metricsOf: () => rec })` with `rec = recordingMetrics()`):
  ```ts
  test('a claimed task records its wait, and its completion records the run', …)
  // calls: timing 'resize.claim' labels { queue: 'default' } context { taskId: 'task-1' };
  //        timing 'resize.task' labels { queue: 'default', pipeline: 'default', outcome: 'completed' } context { taskId: 'task-1', mediaId: 'm1', attempts: 1, variants: 1 }
  test('a retried task records failed with the error code, its last attempt records dead', …)
  // maxAttempts 2, handler rejects with new ResizeMediaError('x', { code: 'RESIZE_SOURCE_DECODE_FAILED' }) → outcomes ['failed', 'dead'], both labels.code 'RESIZE_SOURCE_DECODE_FAILED';
  // a plain Error → no code label
  test('a task given back at shutdown records no outcome', …)
  ```

  In `src/worker.test.ts` (Done-when, part 2):
  ```ts
  test('with the default metrics each task outcome writes one info line', …)
  // a Resizer with the default metrics on a recording logger; workUntil the task completes → info lines matching /^resize: task \S+ of media m1 completed in \d+ ms/ : exactly 1;
  // a failing task with maxAttempts 2 → one /failed in/ line then one /dead in/ line
  test('a task of an unregistered pipeline is labelled unregistered', …) // labels.pipeline 'unregistered', context.pipeline the raw name
  test('the worker awaits each served sink\'s flush once when it stops', …)
  // two Resizers given one recordingMetrics() whose flush returns a promise resolved 20 ms later → flushes === 1, and the stop promise settles after it
  test('a metrics sink that throws or rejects never stops the worker', …) // the task completes; one error per failing method naming the sink; no unhandledRejection (Review Focus 4)
  ```

  Existing tests: a test that compares a worker's full `info` output now filters out lines starting with `resize: task ` and `resize: Resizer ` (the summary flushed at stop). Expected file: `src/worker.test.ts`, where such a filter is needed.
- [ ] **Step 3: Run them to verify they fail.** Run: `node --experimental-strip-types --test src/consumer.test.ts src/worker.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** per the Interfaces. Measure durations with `performance.now()`.
- [ ] **Step 5: Run everything.** Run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS. Run `npm test` a second time. Expected: PASS (including the Step 1 test).
- [ ] **Step 6: Stage.** `git add src`
- [ ] **Step 7: Commit.** `git commit -m "feat: the worker records claim waits and task outcomes and flushes its metrics when it stops"`

---

### Task 5: The freshness rules and the Catalog

**Files:**
- Create: `src/freshness.ts`, `src/freshness.test.ts`.
- Modify:
  - `src/images.ts:203-233`: add `storedPreviewRows`; `storedPreviews` uses it.
  - `src/catalog.ts`: D8.
  - `src/resizer.ts:443`: `new Catalog({ config, versionOf: (p) => (this.#pipelines.has(p) ? this.#pipelines.get(p).version : undefined) })`.
- Test: `src/freshness.test.ts`, `src/catalog.test.ts`.

**Interfaces:**
- Produces: D7's `expectedOrigin` and `isFreshRow`; `storedPreviewRows(media, scope): Map<string, Preview[]>`; on `Catalog`:
  ```ts
  constructor(deps: { config: ResizeConfig; versionOf?: (pipeline: string) => string | undefined });
  encodeSig(pipeline: string, format: string, fit: boolean): string;
  splitStored(media: MediaLike, scope: PreviewScope, originDims?: { width: number; height: number }): { fresh: Map<string, Preview>; stale: Map<string, Preview> };
  freshIdentities(media: MediaLike, scope: PreviewScope, originDims?: { width: number; height: number }): Set<string>;
  ```

- [ ] **Step 1: Write the failing tests.**

  In `src/freshness.test.ts`:
  ```ts
  test('expectedOrigin signs the original ref with its dimensions', …)
  // { storageRef: { key: 'o' }, width: 20, height: 10 } → previewOrigin({ key: 'o' }, { width: 20, height: 10 });
  // no width or no height → undefined; width: null, height: null → undefined (Opus M2);
  // with dims { width: 20, height: 10 } passed → the same value as above; no storageRef → undefined
  test('isFreshRow', …)
  // expect { encodeSig: 'e', origin: 'o' }: row { encodeSig: 'e', origin: 'o' } → true; encodeSig 'x' → false; no encodeSig → false; no origin → false;
  // origin 'x' → false; expect.origin undefined → false for every row
  ```

  In `src/catalog.test.ts`:
  ```ts
  test('splitStored: rows made with the current settings are fresh; another quality, a missing signature or another original is stale', …)
  // config A (default) and B (webp quality changed); rows stamped with stampFresh(media, { config: A }); a Catalog on B → the webp row stale, the jpeg row fresh;
  // a row with its signatures deleted → stale; the same rows with original.storageRef changed → all stale
  test('a fit row is judged with the fit settings', …) // config with sharpen { cover: true, fit: false }; a fit row stamped → fresh; the same row without fit: true → stale
  test('the live pipeline version and config are read on every call', …) // R-S5-5
  // one Catalog, versionOf reading a mutable pipeline object; rows stamped with version 'v1' → fresh; set pipeline.version = 'v2' → stale;
  // stamp again with 'v2' → fresh; mutate config.encode.formats.webp.quality → the webp row stale
  test('a media without stored dimensions has no fresh row, unless the decoded size is passed', …) // R-S5-6
  // original { storageRef: { key: 'o' } }, rows signed with previewOrigin({ key: 'o' }, { width: 64, height: 48 }) and the current encodeSig:
  // splitStored(media, scope) → all stale; splitStored(media, scope, { width: 64, height: 48 }) → all fresh;
  // the same with storageRef { key: 'o2' } and the dims passed → all stale
  test('a fresh row of an identity wins over a stale one, whatever their order', …) // R-S5-10
  // [newFresh, oldStaleWithoutIdentity] and [oldStaleWithoutIdentity, newFresh] → fresh.get(identity) === newFresh, stale.size 0 in both
  test('freshIdentities holds the fresh identities only; storedIdentities keeps every usable row', …)
  ```

  Existing tests: none change. `storedPreviews` keeps "the later row wins" (`src/catalog.test.ts:70-86`).
- [ ] **Step 2: Run them to verify they fail.** Run: `node --experimental-strip-types --test src/freshness.test.ts src/catalog.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per D7 and D8.
- [ ] **Step 4: Run everything.** Run: `npm run types:check && npm run check && npm test`. Expected: PASS (nothing reads the new methods yet).
- [ ] **Step 5: Stage.** `git add src`
- [ ] **Step 6: Commit.** `git commit -m "feat: freshness rules for stored previews, applied by the Catalog"`

---

### Task 6: Freshness on the read path

**Files:**
- Modify:
  - `src/reader.ts`, in `resolve`:
    - use `catalog.splitStored` for a registered pipeline and `catalog.storedPreviews` otherwise (`:103-106`);
    - serve and queue stale cells per D9, queueing each one before its `publicUrl` call (`:125-140`);
    - call `count('resize.preview.stale', n, { pipeline }, { mediaId })` when `n > 0`;
    - fill the read context's `stale`.
  - `src/reader.ts`, in `prewarm`: `readyIdentities = catalog.freshIdentities(media, scope)` (`:313`).
  - `src/types.d.ts:124-136`: `ReadyEntry.stale?: true` and `ReadDecision.stale?: MissingPreview[]`, each with a doc comment.
- Test: `src/reader.test.ts`, `src/prewarm.test.ts`, plus the existing seeds in the files listed in Step 1.

**Interfaces:**
- Consumes: `Catalog.splitStored` and `freshIdentities` (Task 5); `stampFresh` (Task 2).

- [ ] **Step 1: Write the failing tests, and list the reversed test and the seeds to stamp.**

  In `src/reader.test.ts` (rows stamped with another config, `{ …, encode: { …, formats: { …, webp: { quality: 50 } } } }`, are stale for the Resizer's config):
  ```ts
  test('a stale row is served, marked stale, and queued', …)
  // ready[0]: url of the stored row, stale === true; decision.stale deepEqual [the variant]; decision.missing []; tasks.added[0].previews [the variant];
  // calls: count 'resize.preview.stale' value 1; read outcome 'enqueued' with context.stale 1
  test('a fresh decision has no stale key', …) // Object.hasOwn(decision, 'stale') === false; Object.hasOwn(ready[0], 'stale') === false
  test('stale and missing variants are queued as one task; the next read is in-flight', …) // MemoryTaskQueue: tasks.added.length 1 after two reads; second outcome 'in-flight'
  test('a beforeEnqueue tap that drops a stale variant keeps it served and queues nothing', …) // outcome 'suppressed'; no stale key
  test('a stale cell whose publicUrl throws is not served but is queued', …) // R-S5-14: ready []; decision.stale [the variant]; one task; one publicUrl error line
  test('an unregistered pipeline serves its stored rows unmarked and queues nothing', …)
  test('a media without stored dimensions: its rows are served stale and queued once', …) // Review Focus 3 (read side)
  ```

  In `src/prewarm.test.ts`:
  ```ts
  test('a stale row is not ready: it is required and accepted', …) // result.ready []; accepted [the variant]; status 'accepted'
  ```

  The existing test this task reverses (rewrite it):
  - `src/reader.test.ts:1661`, 'rows without bytes, createdAt, origin or encodeSig are served, and nothing is queued'. Rename it to 'rows without bytes, createdAt, origin or encodeSig are served marked stale, and queued once'. Both rows are served with `stale: true`; `decision.stale` holds both variants; `tasks.added.length` is 1.

  Seeds to stamp: every test that seeds a stored row meant to be current, then reads through `resolve()` or `prewarm()`, gets `stampFresh(media, { config })` on that media (after `await r.ready()`, or with the config the test built). Its assertions do not change. A seed whose original has no `width`/`height` gets the test image's size (or 64×48 when no image is decoded), unless the test is about missing dimensions. Expected files:
  - `src/reader.test.ts`, including the `readerDeps` fixtures;
  - `src/prewarm.test.ts`, `src/prewarmCoverage.test.ts`, `src/resizer.test.ts`, `src/customDecoder.test.ts`, `src/routing.test.ts`, `src/framework/stores.test.ts`;
  - any `*.mongo.integration.test.ts` that reads a seeded row.
- [ ] **Step 2: Run them to verify they fail.** Run: `node --experimental-strip-types --test src/reader.test.ts src/prewarm.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per D9.
- [ ] **Step 4: Stamp the seeds and rewrite `:1661`.** Then run: `npm run types:check && npm run check && npm test`. Expected: PASS.
- [ ] **Step 5: Stage.** `git add src`
- [ ] **Step 6: Commit.** `git commit -m "feat: resolve() serves a stale preview and queues its replacement; prewarm() counts only fresh previews as ready"`

---

### Task 7: Freshness in `generate()` and the worker: regenerate and replace

**Files:**
- Modify:
  - `src/previewRecorder.ts`: D10.
  - `src/processor.ts`:
    - D11 and D12 in `generate` (`:417-445`), the `processTask` coverage (`:576-591`), and `#renderPending` (`:666-681` pending; after `:707` the post-decode fresh filter; `:851-866` persist);
    - `invalidate` (`:478-487`) uses the recorder's `requireReplacePreviews` and `checkReplaced`.
  - `src/resizer.ts:29`: the `requireReplacePreviews` import moves to `./previewRecorder.ts`.
  - `src/catalog.ts`: `missing` excludes fresh identities only.
  - `src/types.d.ts:242-245`: `GenerateResult.replaced?: StorageRef[]`.
  - `src/testHelpers/fakes.ts:660-685`, `docMedia`:
    - add a `replacePreviews` that writes on the document, per the media contract;
    - its `appendPreviews` applies `backfillDims` to `doc.original.width`/`height` BEFORE storing rows, and also when `previews` is empty, as MongoMediaStore does (`src/drivers/mongo/media.ts:233-246`);
    - it records every call in a spy. The return type becomes `MediaStore & { appendCalls: Array<{ mediaId: string; previews: Preview[]; backfillDims?: { width: number; height: number } }>; replaceCalls: Array<{ mediaId: string; identities: string[]; rows: Preview[] }> }`.

    Existing callers that use the result as a `MediaStore` are unaffected.
- Create: `src/regenerate.test.ts`.
- Test: `src/regenerate.test.ts`, `src/processor.test.ts`, `src/previewRecorder.test.ts`, `src/catalog.test.ts`, `src/drivers/mongo/frameworkFree.integration.test.ts`, plus the existing seeds in the files listed in Step 1.

**Interfaces:**
- Consumes: Task 5's Catalog methods; `stampFresh`.
- Produces:
  ```ts
  // src/previewRecorder.ts
  export interface RecordResult { stored: Preview[]; alreadyStored: string[]; removed: Preview[] }
  record(mediaId: string, scope: PreviewScope, previews: Preview[], backfillDims?: { width: number; height: number }, replacing?: ReadonlySet<string>): Promise<RecordResult>;
  export function requireReplacePreviews(media: MediaStore): void; // moved, unchanged text
  export function checkReplaced(result: unknown): ReplacedPreviews; // RESIZE_MEDIA_REPLACE_RESULT_INVALID otherwise (today's text)
  ```

- [ ] **Step 1: Write the failing tests, and list the reversed tests and the seeds to stamp.**

  In `src/regenerate.test.ts`: real Sharp, `memoryStorage()`, `docMedia(docs)` and `MemoryTaskQueue`. `resetResizerForTests()` runs between Resizers that share a name; it stands in for a redeploy.
  ```ts
  test('changing webp.quality regenerates on the next read', …) // Done-when
  // Resizer A (webp quality 80): uploadOriginal a 64×64 PNG, generate({ sizes: [{ width: 20, height: 20 }], formats: ['webp'] }) → row R1;
  // reset; Resizer B (quality 70) on the same docs, storage and tasks: resolve → ready[0].stale true with R1's url, one task queued;
  // workUntil the task completes → doc.previews holds one row for the identity, encodeSig === encodeSignature(B.config, { format: 'webp', fit: false }),
  // storageRef ≠ R1's; R1's file is still in files; one info line matching /replaced 1 outdated preview\(s\) of media m1; their files are not deleted/;
  // resolve again → ready[0] without stale, decision has no stale key, no new task
  test('a pipeline version or encode option changed at run time regenerates, and the new row is fresh', …) // R-S5-5
  // one Resizer; generate; set the registered pipeline object's version = 'v2' → resolve marks stale and queues; work → resolve fresh;
  // then mutate r.config.encode.formats.webp.quality → stale again; work → fresh
  test('generate() regenerates a stale row in one replace and returns the old ref in replaced', …)
  // created.length 1; replaced deepEqual [R1.storageRef]; media.previews (in memory) has one row for the identity; replacePreviews called once, appendPreviews not called for it
  test('generate() leaves fresh rows alone', …) // created [], no replaced key, no download
  test('a task over one stale and one missing variant appends one row and replaces one', …)
  test('a media without stored dimensions: one download-and-inspect task records them, uploads nothing, and the next read is fresh', …) // Review Focus 3, R-S5-7
  // rows made by A on a doc whose original then had width/height removed: resolve → stale, one task; work → files.size unchanged,
  // store.appendCalls deepEqual [{ mediaId: 'm1', previews: [], backfillDims: { width: 64, height: 64 } }]; doc.original has the dims;
  // resolve → fresh, no task; no D12 warning; no "did not record the original's dimensions" warning
  test('a stored null width is treated as missing: backfilled once, regenerated once, then fresh', …) // Opus M2
  // doc.original { storageRef, width: null, height: null } with rows signed for 64×64: resolve → stale, one task; work → appendCalls has backfillDims { 64, 64 };
  // doc.original.width === 64; resolve → fresh, no task
  test('a store that drops the backfill gets one warning, and still uploads nothing', …) // Opus I3 (a)
  // docMedia wrapped so appendPreviews ignores backfillDims: two read-work cycles → each task completes with files.size unchanged;
  // warn lines matching /the media store did not record the original's dimensions of media m1/ : exactly 1
  test('generate() sets the backfilled dimensions on the caller\'s media, even when the store keeps its own copy', …) // Opus I3 (b)
  // a store whose loadMedia returns structuredClone(doc) and whose appendPreviews writes only its doc; the caller's media has no dims;
  // generate() → caller's media.original.width/height === 64; a same-request resolve({ media }) has no stale key and queues nothing
  test('a stale row from before 0.3.0 (no identity) gets a new row beside it, which the next read serves', …) // Review Focus 5: two rows on the doc; resolve → the new row, no task
  test('a store that returns the replacement before the old row still serves the new row', …) // Review Focus 5, R-S5-10
  // docMedia variant whose replacePreviews prepends its rows; identity-less stale row kept → resolve serves the new row, queues nothing
  test('API and worker with different settings: the worker completes a no-op task, uploads nothing, and warns once', …)
  // Review Focus 1: rows stamped with config W; reader Resizer on config A queues; reset; worker Resizer on W: task completes, files.size unchanged,
  // one warn matching /already fresh — if this repeats, the API and the worker may run different image settings or pipeline versions/;
  // reset; reader on A again: one more task queued for one read (not more)
  test('a stale row whose regeneration keeps failing stays served', …)
  // Review Focus 2: the original's file deleted from storage; maxAttempts 1 → the task is dead; resolve → ready[0].stale true;
  // a second resolve within the cooldown queues nothing (tasks.added.length unchanged)
  ```

  In `src/previewRecorder.test.ts`:
  ```ts
  test('record() appends new rows, then replaces the rows in replacing, and returns the removed rows', …)
  test('an all-replacement batch with backfillDims calls appendPreviews(id, [], dims) before the replace', …) // R-S5-7
  test('a replace on a store without replacePreviews is RESIZE_MEDIA_REPLACE_MISSING', …) // Opus M7
  test('a replace result that is not { stored, removed } is RESIZE_MEDIA_REPLACE_RESULT_INVALID', …)
  test('a rejected replace logs the unrecorded refs and rethrows', …)
  test('a replace that stores and removes nothing means the media is gone: one warning with the refs', …)
  test('no replaced line when nothing was removed', …) // an identity-less stale row: removed [] → no info line
  ```

  In `src/processor.test.ts`:
  ```ts
  test('a concurrent row with other signatures does not cover the variant: the task fails incomplete', …) // R-S5-14
  // appendPreviews leaves the row out; the reload shows a row of that identity stamped with another config → rejects RESIZE_WORKER_INCOMPLETE;
  // with metrics: recordingMetrics(), that variant records 'resize.variant' outcome 'failed', code 'RESIZE_WORKER_INCOMPLETE' (not 'duplicate'; D1, Opus M6)
  ```

  In `src/drivers/mongo/frameworkFree.integration.test.ts`:
  ```ts
  test('a stale preview is replaced in the media document', …)
  // createResizer with webp quality 80 → generate; reset; quality 70 → generate: the document holds one row for the identity with the new encodeSig; replaced has the old ref
  ```

  Existing tests this task reverses (rewrite them):
  - **`src/processor.test.ts:5198-5244`**, 'a task treats rows written before this version as stored and renders nothing for them'. Rename it to 'a task re-renders rows written before this version: the identity row is replaced, the identity-less row gets a new row beside it'.
    - The routing follows D11. `storedIdentities` derives the identity from the row's fields (`src/images.ts:210-241`), so BOTH old rows are in `replacing`, the identity-less fit row included.
    - Assertions:
      - `downloads === 1` and `uploads.length === 2`;
      - one `replacePreviews` call with identities `[]` holding both new rows (cover and fit);
      - one `appendPreviews` call `(mediaId, [], { width: 64, height: 48 })`.
    - That backfill call happens because `mediaDoc()` (`src/processor.test.ts:356-370`) has no dimensions and `redPng` is 64×48 (`:88-92`).
    - The test's `fakeMedia({ load, appendPreviews, replacePreviews })` records both calls. Its `load` returns a fresh `mediaDoc` each time, so the reload still has no dimensions. The I3 (a) warning is therefore written once; the test runs with a silent logger and may assert it.
  - **`src/catalog.test.ts:87-107`**, 'missing skips stored identities and sizes without a key':
    - give the media `original: { storageRef: { key: 'o' }, width: 10, height: 10 }` and `stampFresh` its row, keeping the existing assertions;
    - add an assertion that the same media with its row's `encodeSig` deleted gives `['10x10', '30w']`.
  - **`src/processor.test.ts:720-739`**, 'a stored png original holding SVG markup is rendered by the SVG decoder in its child process':
    - Its `makeMediaStore` (`:309-330`) drops `backfillDims` and its `mediaDoc` has no dimensions, so the I3 (a) warning is now written as well.
    - `assert.equal(logs.warn.length, 1)` becomes a check on the warnings that do not match `/did not record the original's dimensions/`: exactly one remains, and the `assert.match` on it is unchanged.
    - The other exact warn-count assertions in that file (`:753`, `:1359`, `:1390`) are `generate()` tests, which write no such warning, so they are unchanged.

  Seeds to stamp: every test that seeds a row meant to be already stored, then runs `generate()`, `processTask()` or the worker, gets `stampFresh` with that Resizer's config (and dims, as in Task 6). Its assertions do not change. Expected files:
  - `src/processor.test.ts`, `src/worker.test.ts`, `src/consumer.test.ts`, `src/customDecoder.test.ts`;
  - `src/invalidate.test.ts`, only where it generates first;
  - `src/framework/queueIndexes.mongo.integration.test.ts`, `src/framework/storageRef.persistence.integration.test.ts`, `src/framework/worker.mongo.integration.test.ts`.

  `invalidate()`'s own tests are otherwise unchanged; the check only moved.
- [ ] **Step 2: Run them to verify they fail.** Run: `node --experimental-strip-types --test src/regenerate.test.ts src/previewRecorder.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** D10–D12. The D12 warning uses a Processor-private `Set` of pipeline names.
- [ ] **Step 4: Stamp the seeds and rewrite the three changed tests.** Then run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS.
- [ ] **Step 5: Stage.** `git add src`
- [ ] **Step 6: Commit.** `git commit -m "feat: generate() and the worker regenerate stale previews and replace them in one write"`

---

### Task 8: Docs and `0.3.0-rc.4`

**Files:**
- Modify: `README.md`, `AGENTS.md`, `CHANGELOG.md`, `RELEASE.md`, `docs/host-adoption.md`, `src/contracts/pipeline.ts:33-34`, `src/contracts/media.ts:20-30` (the `appendPreviews` JSDoc), and `package.json` with `package-lock.json` (`0.3.0-rc.4`, edited by hand; do not run `npm version`).
- Docs site: `/Users/andrey/Work/framework-documenation-github/docs/12-resize.md`.
- Test: `src/agentsDoc.test.ts` (existing; it checks that every main-entry import in the AGENTS.md snippets is a real export).

- [ ] **Step 1: README.md.**
  - **New "Metrics" section.**
    - The port (D2): the 4th argument, and that methods may be `async`.
    - `LogMetrics`: its options; the summary format with one example; the two per-event formats; `debug` and its cost; the window and `unref`; `flush()`, and `await resizer.metrics.flush?.()` at shutdown.
    - `NoopMetrics`; the D1 table; the label rule (pipeline `'unregistered'`, code `'other'`, raw values in `context`).
    - The `metrics` option and its defaults (owner O4); the bound sink never throws or rejects; `RESIZE_METRICS_INVALID`.
    - A ten-line Prometheus adapter sketch that uses only labels.
  - **New "Freshness" section.**
    - **What makes a row stale (D7):**
      - the encode inputs of the frozen recipe. For webp and gif rows this includes the animation pixel budget, which is the SMALLER of `limits.sourcePixels` and `limits.inputPixels`: changing the smaller one changes those signatures, changing only the larger one changes nothing;
      - a pipeline `version`;
      - another `original.storageRef` or other dimensions;
      - a row without signatures.
    - **On read:** stale rows are served (`ReadyEntry.stale`, `decision.stale`) and queued through `beforeEnqueue`. A stale cell whose `publicUrl` throws is queued.
    - **A media without stored dimensions** takes one task that downloads and inspects the original (no pixel decode, no upload) and records the dimensions.
    - **A `MediaStore` must save `backfillDims`** in `appendPreviews`, including when `previews` is empty. A store that drops it makes every read of such a media queue a task that downloads the original; the worker warns once.
    - **Counting and replacing:** `prewarm()` and `generate()` count only fresh rows; `GenerateResult.replaced` lists the removed refs; the replacing write logs a line.
    - **Old files are never deleted.** Cleanup works from the log line, or with a sweep of preview objects no row references. A row without an `identity` stays referenced beside its replacement, so a sweep never finds its file: delete such rows yourself (O6).
    - **An eager-only host** (no task queue) never regenerates on read: its stale rows are served with `stale: true` until it calls `generate()`.
    - **`resolve()` must receive `original` as stored** (the same `storageRef` and dimensions; a stored `null` dimension counts as missing). A projection that drops `original.width`/`height`, or a reshaped ref, makes every row stale and queues a no-op task per read. The worker's "already fresh" warning names this cause.
    - **Rolling out a settings change** (D12): the API and the workers must share image settings and pipeline versions. Change them with every worker at once and drain the old workers first. A mixed rollout costs one render, one upload and one orphaned file per read-after-task while both versions run. The regeneration wave shares the queue with new uploads' previews, which wait behind it.
    - **`isCatalogCovered`** checks identities only; use `generate()`, which is idempotent and freshness-aware.
    - **Mongo `_id`:** preview rows written by `replacePreviews` have none, so key rows by `identity` (owner O7).
  - **Replace `:802-803`** ("They are not regenerated yet; a later release's freshness check will regenerate them") **and `:1213`** with the shipped behaviour. In the read-path section, describe the per-read logs of D6.
  - **"Package exports":** add the new values and types.
- [ ] **Step 2: AGENTS.md.**
  - **Use:**
    - add a `metrics` sentence to step 3's option list;
    - on the read path, mention `decision.stale` and `ReadyEntry.stale`;
    - in pipelines, a `version` change regenerates on the next read (drop "stored previews are not regenerated yet");
    - in "Old rows", rows without `origin`/`encodeSig` are regenerated on their next read and the old files stay (cleanup as in the README);
    - the rollout rule of D12.
  - **Troubleshooting rows:**
    - add `RESIZE_METRICS_INVALID`;
    - add "previews are re-rendered after a config change or an upgrade": freshness, its storage cost, the cleanup;
    - add "one task per read that renders nothing, and the warning 'already fresh'": the API and worker settings differ;
    - add "previews re-rendered over and over during a deploy": two worker versions with different settings;
    - in the `RESIZE_MEDIA_REPLACE_MISSING` row, add "or from `generate()` and the worker when a stale preview is replaced";
    - add "the warning 'the media store did not record the original's dimensions'": a custom `MediaStore` drops `backfillDims`, so make it save the dimensions;
    - rewrite the "previews written before 0.3.0-rc.1" row.
  - **A snippet** importing `LogMetrics` from the main entry, so `src/agentsDoc.test.ts` checks the name.
- [ ] **Step 3: CHANGELOG.md**, under `# 0.3.0`.
  - **Prereleases:** add "`0.3.0-rc.4`: metrics (`ResizeMetrics`, `LogMetrics`, `NoopMetrics`, the `metrics` option) and the freshness check, which regenerates outdated previews (see Changed behaviour for the storage cost).", and move "Later release candidates" after it.
  - **Features:**
    - the metrics port and its defaults;
    - the freshness check;
    - `decision.stale`, `ReadyEntry.stale`, `GenerateResult.replaced` and `ResizeLogger.debug`.
  - **Changed behaviour:**
    - stale rows regenerate on their next read, prewarm or generate, with the storage cost of owner O6 and the cleanup;
    - the rollout rule of D12;
    - a media without stored dimensions (or with a stored `null`) takes one download-and-inspect task, and a `MediaStore` must save `backfillDims`;
    - `beforeEnqueue` also receives stale variants;
    - per-read logs (D6);
    - one `info` summary line per window, and one per task outcome and per failed variant;
    - changing the smaller of `limits.sourcePixels` and `limits.inputPixels` regenerates webp and gif previews.
  - **Replace** the "served for now, and will be regenerated once a later release's freshness check ships" sentence (`:168`) and the `version` "not regenerated yet" sentence (`:793`).
- [ ] **Step 4: RELEASE.md, host adoption and the pipeline JSDoc.**
  - **RELEASE.md:** the prerelease sentence (`:44-46`) adds rc.4 (metrics, freshness).
  - **`docs/host-adoption.md`:**
    - the prerelease paragraph (`:40-60`) says what rc.4 adds, and the one behaviour a host will notice: outdated previews regenerate on read, so plan worker capacity and storage, clean up the old files, and roll out settings with every worker at once;
    - item 6 "Old preview rows" (`:229-234`) is rewritten to the shipped behaviour.
  - **`src/contracts/pipeline.ts:33-34`:** "Part of each preview's encodeSig: bump it when a step's output changes, and stored previews of this pipeline are regenerated on their next read."
  - **`src/contracts/media.ts`, the `appendPreviews` JSDoc:** "optionally backfill the original's dimensions" becomes "save `backfillDims` on the original when it is given, whether or not a preview is stored (also for `previews: []`): the freshness check needs the original's dimensions, and a store that drops them makes every read of such a media queue a task that downloads the original". Only the documentation changes; the method signature is the same.
- [ ] **Step 5: Docs site.**
  - `cd /Users/andrey/Work/framework-documenation-github` (never `git -C`; the branch `docs/s5-metrics-freshness` is checked out).
  - In `docs/12-resize.md`:
    - add a short "Metrics" section (the defaults, the summary line, `NoopMetrics`, a custom sink) that links to the README reference;
    - replace `:424` and `:677` with the freshness behaviour and the rollout rule;
    - add the operations-table rows of Step 2.
  - Run `npx docusaurus build`. Expected: success. Do not run `generate-llm-context`.
- [ ] **Step 6: Stage the docs site.** `git add docs/12-resize.md`
- [ ] **Step 7: Commit the docs site.** `git commit -m "docs(resize): metrics and preview freshness"`, then return to the worktree.
- [ ] **Step 8: Version.** Set `package.json` and `package-lock.json` to `0.3.0-rc.4`.
- [ ] **Step 9: Run everything.** Run: `node --experimental-strip-types --test src/agentsDoc.test.ts && npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS.
- [ ] **Step 10: Stage.** `git add README.md AGENTS.md CHANGELOG.md RELEASE.md docs/host-adoption.md src/contracts/pipeline.ts src/contracts/media.ts package.json package-lock.json`
- [ ] **Step 11: Commit.** `git commit -m "docs: metrics and preview freshness; 0.3.0-rc.4"`

---

## Carried items

Folded in, because the task already touches that code:
- `src/consumer.test.ts:2016-2076`, the timing-sensitive test → Task 4 Step 1. The fixed `sleepMs(40)` becomes a promise the release resolves.
- The S4 Task 2 deferred minor "failed-build 'resolve logs once and serves stored previews' tested only at Dispatcher level" → the Task 2 test 'a route whose build fails …'.

Not in S5:
- **Originals read by a host's own decoder staying private** (S3 follow-up; R-S5-2). It adds a new upload rejection: a host's public PDF upload would start failing. That breaks the rc promise, so it moves to 0.4.0. Today `src/uploader.ts:155-160` rejects only public SVG.
- **Dead-lettering bytes no decoder can read at once** (S3 follow-up; R-S5-3). Bytes every decoder refuses already are dead-lettered at once (`RESIZE_SOURCE_FORMAT_UNSUPPORTED`, `retryable: false`, `src/decoderSet.ts:182-186`). `RESIZE_DECODER_MISSING` is retried on purpose, so a deploy that adds the decoder can still run the task (`src/decoderSet.ts:132-145`). `src/decoderSet.ts` is not touched in S5.
- **S4 M5** (SQS `PEER_MISSING` names the backend's first entry) and **M8** (the SQS build awaits the database build): left as they are by ruling. `src/factory/queueSet.ts` is not touched.
- **S4 deferred minors in files S5 does not touch:** the `architecture.test.ts` regex (Task 1 adds a separate test and leaves that regex alone), `registry.ts`, `routing.test.ts`, `ResizeWorkerCommand.ts`, `factory/queues.ts`, `databaseQueue.ts`, `s3.test.ts`, `fs.test.ts`, `drivers/mongo/database.ts`, `createResizer.ts`, `peers.test.ts`, `framework/config.ts`, and the CHANGELOG line wraps outside the touched paragraphs.
- **The two dispatcher items** (a throwing `servesQueue` logged as a build failure; `#loggedRouteFailed` keyed by name and message) stay as they are: Task 2 adds a method and changes no log.
- **S4 items already fixed by its final fix wave** (b33fafa, 2af0a30, 8d28e50): the `__proto__` routes, the backend-key tuple, the drivers-map snapshot, the explicit-config storage-name check, the worker queue-name inspector, README :564, and CHANGELOG :52 and :374-377.
- **S3 parked minors:** the uploader's class-name check and the `prepared` rename are done (`src/uploader.ts:41-70`). The rest (`plan.test.ts` coverage, `render.ts`, `svg.ts`, the bench) are in files S5 does not touch.

## Follow-ups (later phases, not in S5)

- **Queue latency** (the time from due to claim) needs an optional `ClaimedTask.queuedAt` from every queue driver. Until then, `resize.claim` measures the worker's wait.
- **An observer for replaced rows** (`onPreviewReplaced`) would widen the closed `HookName` union; 0.4.0.
- **Also for later:** `_id: false` on preview rows (owner O7); a `Resizer.close()` that flushes the metrics; a switch to pace or postpone the regeneration wave (R-S5-4).

## Definition of done (S5)

- **"With the default metrics, 50 reads produce no `info` line until the interval summary":** `src/resizer.test.ts`, 'with the default metrics, 50 warm reads write no info line until the summary' (Task 2).
- **"… and each task outcome produces one":** `src/worker.test.ts`, 'with the default metrics each task outcome writes one info line' (Task 4).
- **"Changing `webp.quality` regenerates on the next read":** `src/regenerate.test.ts`, 'changing webp.quality regenerates on the next read', plus the Mongo case in `src/drivers/mongo/frameworkFree.integration.test.ts` (both Task 7).
- **"`invalidate` returns the refs":** shipped in S2b, `src/invalidate.test.ts:97`. The test is unchanged; its result check moved in Task 7.
- **"`Preview` carries `bytes`, `createdAt`, `origin`, `encodeSig`":** shipped in S2b (`src/types.d.ts:88-96`, `src/processor.ts:288-321`).
- **F8 coverage:**
  - the port (Task 1);
  - the `LogMetrics` defaults and `NoopMetrics` (Task 1);
  - the events: `read` (Task 2), `upload` and `variant` (Task 3), `task` and `claim` (Task 4);
  - every event at debug (Task 1, `debug`).
- **F9 coverage:**
  - the read path's mismatch check (Tasks 5 and 6);
  - the worker's replacing write (Task 7);
  - rows without the fields are stale (Tasks 5, 6 and 7).
- **F10 item:** the per-read logs (Task 2).
- **Gates and docs:**
  - `npm test`, `npm run types:check`, `npm run check`, `npm run build` and `npm run smoke` pass;
  - README, AGENTS.md, CHANGELOG, RELEASE.md, host adoption and the docs site describe metrics, freshness and the rollout rule;
  - the version is `0.3.0-rc.4` (Task 8).

## Self-review notes

- **Spec coverage.**
  - **F8:** the port (D2, Task 1); the default and silencing (D3, owner O4); the split between request-path events and worker outcomes (D3); every event at debug (D3); the five events (D1, Tasks 2–4).
  - **F9:** `origin`/`encodeSig` are recorded (S2b); the mismatch check on read (D7–D9, Tasks 5–6); the replacement by the worker (D10–D11, Task 7); `invalidate` (S2b); rows without the fields are stale (owner O6).
  - **F10's per-read item:** D6, Task 2.
  - **Departures, each a decision:** the port's 4th argument (D2); stale rows served while they regenerate (owner O5); missing-cell counts kept in the read context rather than in the summary (D1).
- **Step scan.** Each task names:
  - its files with line numbers;
  - its tests with their assertions;
  - the command to run and the expected result;
  - every existing test it changes, as a rewrite:
    - Task 1: the `architecture.test.ts:117-131` guard filter;
    - Task 2: `reader.test.ts:934`, `:955`;
    - Task 6: `reader.test.ts:1661`;
    - Task 7: `processor.test.ts:5198-5244`, `processor.test.ts:720-739` and `catalog.test.ts:87-107`;
  - the seed stamping, by rule and file list;
  - two plain git calls.
- **Type consistency.**
  - `ResizeMetrics`, `MetricLabels` and `MetricContext` (Task 1) are the parameter types in Tasks 2–4.
  - `metricsOf` (Task 1) is used by the worker (Task 4), and `recordingMetrics` (Task 1) in Tasks 2–4.
  - `stampFresh` (Task 2) is used in Tasks 5–7.
  - `Catalog.splitStored`, `freshIdentities` and `encodeSig` (Task 5) are used in Tasks 6–7, with `originDims` used by the worker.
  - `RecordResult.removed`, `requireReplacePreviews` and `checkReplaced` (Task 7) are used in the Processor, `invalidate` and the Resizer.
  - `enqueueWithOutcome` (Task 2) is used only in the Reader.
- **Review Focus:** items 1, 2 and 5 are in Task 7; item 3 in Tasks 5, 6 and 7; item 4 in Tasks 1, 2 and 4.
- **Proportion.** The bodies are left to the implementer. The decisions fix what the tests alone would not: the names, labels and line formats, the outcome order, the freshness rules, and the write order.

## Review changes

Round 1: Opus (`plan-review-opus.md`), Sol and Astra (codex), with controller rulings R-S5-5 … R-S5-15.

| Finding | Where the plan handles it now |
|---|---|
| Opus I1: an async or rejecting sink causes an unhandled rejection (R-S5-9) | D2 (`void \| Promise<void>`); D4 (thenables caught, once per method); Task 1 test 'boundMetrics catches rejected promises…'; Task 4 awaited flush with a 5 s cap; Review Focus 4 |
| Opus I2: freshness depends on row order, so a loop is possible (R-S5-10) | D8: the fresh row wins per identity (`storedPreviewRows`); D11: the completion check uses fresh identities; Task 5 order test; Task 7 'a store that returns the replacement before the old row…'; Review Focus 5 |
| Opus I3: the dimension backfill is lost on an all-replacement batch (R-S5-7) | D10 step 2 (`appendPreviews(id, [], dims)`); D11 persist condition; Task 7 recorder test and the no-dims regenerate test |
| Opus I4: required `metrics` deps break the fixtures (R-S5-11) | O4: the internal `metrics?` defaults to `NoopMetrics`; Tasks 2–3 say the fixtures are unchanged |
| Opus I5: five existing tests reverse (R-S5-12) | Task 2 rewrites `reader.test.ts:934`, `:955`; Task 6 rewrites `:1661`; Task 7 rewrites `processor.test.ts:5198-5244` and `catalog.test.ts:87-107` |
| Opus I6: two worker versions re-render each other's rows (R-S5-13) | D12 last bullet; Task 8 README, AGENTS, CHANGELOG, host adoption and docs site rollout rule. Declined: the optional two-worker test (the ruling asks for docs only; the gate bound is pinned by the Review Focus 1 test) |
| Opus M1: `src/resizer.ts` line references | Corrected: Catalog `:443`, services `:443-470`, `#buildReader` `:474-512`, resolve catch `:679-688`, register `:321`, static block `:217-240` |
| Opus M2: does `alreadyStored` still count as coverage? | D11: no; stale duplicates fail with `RESIZE_WORKER_INCOMPLETE` and the retry replaces them (R-S5-14); Task 7 processor test |
| Opus M3: a stale cell whose `publicUrl` throws | D9: queued before `publicUrl`; Task 6 test (R-S5-14) |
| Opus M4: replace-step cases | D10 step 3 (a rejected replace logs and rethrows; the line only when `removed.length > 0`); D11 (`replaced` absent for `persist: false`; the metric when the persist throws); Task 3 and Task 7 tests |
| Opus M5: cardinality | D4 normalization; D6 caps at 100 (R-S5-8); Task 1, 2 and 4 tests |
| Opus M6: `replaced` always present | D11: set only when non-empty |
| Opus M7: `requireReplacePreviews` on the replace path | D10 step 1; Task 7 recorder test; AGENTS row (Task 8) |
| Opus M8: three docs points | Task 8 Step 1 (eager-only hosts, `original` as stored, identity-less rows and the sweep) |
| Opus M9: the D12 warning condition and the false first warning | D12: "every requested identity is fresh", the media has stored dims; the eager false positive noted |
| Opus M10: worker info output at stop | Task 4: filter both `resize: task ` and `resize: Resizer ` |
| Opus M11: cost of the debug lines | D3: skipped when `logger.debug` is absent; the FrameworkResizer cost documented (Task 8) |
| Opus M12: the route-failure test needs a missing cell | Task 2 test: one stored and one missing cell |
| Opus M13: which `enqueueMissing` | D5: steps 4 and 6 use the caller's value; Task 2 test cases |
| Opus M14: `stampFresh` version per pipeline; `runStart` in `#report`; `missing` in the summary | Task 2 `stampFresh` takes a function; Task 4 threads `runStart`; D1 note and self-review |
| Opus: A1 is not a defect | Overruled by R-S5-5: D8 caches nothing across calls |
| Sol S1 / Astra A1: the encodeSig cache diverges from mutable inputs (R-S5-5) | D8: recomputed per call from the live config and the live pipeline `version`; nothing frozen; Task 5 and Task 7 mutation tests |
| Sol S2 / Astra A4: unbounded labels (R-S5-8) | D1 and D4: pipeline `'unregistered'`, code `'other'` with raw values in `context`; D13 `RESIZE_ERROR_CODES` with an architecture test; D6 caps |
| Sol S3 / Astra A5: `reader.test.ts:934`, `:955` | Task 2, rewritten |
| Sol S4 / Astra A5: direct-construction fixtures | Optional deps (R-S5-11); Tasks 2–3 |
| Sol S5 / Astra A5: `processor.test.ts:5198-5244` and `catalog.test.ts:87-107` | Task 7, rewritten (not stamped) |
| Astra A2: origin skipped without dimensions (R-S5-6) | D7: no skip. A media without stored dims has no row proven fresh on read (the reader cannot know the decoded size the writer signs with); the worker computes the writer's exact origin after the decode, skips truly fresh rows and records the dims. Tests: Task 5 (`storageRef` change without dims gives stale), Task 7 (the download-and-inspect task converges) |
| Astra A3: replacement-only backfill | = Opus I3 |
| Sol and Astra minor: the animated budget is the minimum of the two limits | Task 8 README and CHANGELOG wording |
| Sol and Astra minor: `src/contracts/pipeline.ts:33-34` JSDoc | Task 8 Step 4 |
| Astra question: `alreadyStored` vs fresh-only coverage | = Opus M2 (R-S5-14) |
| Astra question: a stale variant whose `publicUrl` throws | = Opus M3 (R-S5-14) |
| Astra question: async sinks, rejected promises, awaiting `flush` | = Opus I1 (R-S5-9) |

Round 2 re-checks (Opus `plan-recheck-opus.md`, Sol, Astra), ruling R-S5-18:

| Finding | Where the plan handles it now |
|---|---|
| Astra 1 / Sol: the coordination-code guard (`architecture.test.ts:117-131`) makes Task 1 red | D13 last bullet; Task 1 Files and Step 1: the filter also allows `errorCodes.ts`, and the ownership check stays |
| Opus M1 / Astra / Sol: the `errorCodes` sync scan validates itself; the count | D13: scan 2 excludes `src/errorCodes.ts`; the count is 106 literals plus `RESIZE_METRICS_INVALID`; Task 1 Step 1 and Step 3 |
| Opus I1 / Astra 2 / Sol: the `processor.test.ts:5198` rewrite contradicts D11 | Task 7: both old rows go to one `replacePreviews`, plus one `appendPreviews(id, [], { width: 64, height: 48 })` backfill, because `mediaDoc()` has no dims |
| Opus I2 / Astra 3 / Sol: `docMedia` ignores `backfillDims` | Task 7 Files: `docMedia.appendPreviews` applies `backfillDims` (also with `[]`), and `appendCalls`/`replaceCalls` spies; the no-dims test asserts `appendCalls` |
| Opus I3 (a): a store that drops the backfill is silent | D11: one warning per Processor when the reload still lacks dims after a backfill; Task 7 test; the rewrite of `processor.test.ts:720-739`, whose fixture drops the backfill |
| Opus I3 (b) / Astra minor: `generate()` leaves the caller's media without dims | D11: `generate()` sets the dims in memory, with a guard; Task 7 test with a store that keeps its own copy |
| Opus I3 (c): document that a store must save `backfillDims` | Task 8: the `src/contracts/media.ts` JSDoc, README, AGENTS troubleshooting row, CHANGELOG |
| Opus M2: a stored `null` dimension never converges | D7 and D11: "stored" means both are numbers, in the reader and the worker; Task 5 assertion; Task 7 test 'a stored null width…' |
| Opus M3: the D12 warning should also name a `resolve()` given media without stored dims | D12 warning text; Task 8 README bullet |
| Opus M4: "decode" is really download + inspect | D7, D11, Review Focus 3, Task 7 test name, Task 8 README and CHANGELOG wording |
| Opus M5: the `unhandledRejection` listener leaks | Task 1 Step 1: `process.off` in a `finally`, the same rule for Tasks 2 and 4 |
| Opus M6: the variant outcome when a row with other signatures blocks the write | D1: `failed` with `RESIZE_WORKER_INCOMPLETE`, and `duplicate` only for a fresh row; Task 7 processor test asserts the metric |
