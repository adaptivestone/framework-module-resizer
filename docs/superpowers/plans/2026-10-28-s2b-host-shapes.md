# S2b — Host-facing shapes first Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every shape a host writes by hand is final before S3–S6, and ships as `0.3.0-rc.1`. That covers:
- the config file with named `queues`, typed `FrameworkResizeConfig` in every file;
- `queueName`;
- the import paths of the schema fragment and the framework defaults;
- the new preview and task-row fields;
- `MediaStore.replacePreviews` and `resizer.invalidate`;
- the scaffold output.

**Architecture:**
- `src/config/resize.ts` gets two kinds of sections:
  - process-wide: `queues`, `worker`, `coordination`;
  - per Resizer: image settings, `mediaModelName`, `storage`, and `queue` as a name.
- The framework adapter builds one task queue per backend and shares it across Resizers:
  - one `MongoTaskQueue` serves every `database` name;
  - one `SqsTaskQueue` serves every SQS name with the same connection settings.
- Each name is its own claim lane with its own timing, through `TaskQueue.getTiming(queue)` and `timingOf(tasks, queue)`.
  - The worker and `consume()` read the timing of their lane.
  - The Dispatcher reads the timing of each call's queue.
- Routing between backends stays in S4. Until then, the Dispatcher refuses a call whose queue its task queue does not serve: the read path logs it once, and `prewarm()` reports the issue `RESIZE_QUEUE_NOT_SERVED`.
- The Processor writes four new fields on every row it builds: `bytes`, `createdAt`, `origin` and `encodeSig`. `origin` and `encodeSig` come from a pure `src/signatures.ts`.
- `invalidate` removes this Resizer's rows through one atomic `MediaStore.replacePreviews` call.

**Tech Stack:** Node ≥ 24, TypeScript 7 (`erasableSyntaxOnly`, `verbatimModuleSyntax`, ESM, `.ts` specifiers), `node:test`, Biome 2.6, sharp 0.35, mongoose 9 and mongodb-memory-server (tests only).

**Spec:** docs/design/2026-10-26-reference-architecture.md. This plan implements:
- F6, the config shape only;
- F8, only the `Preview` and task-row fields;
- F9, the fields, `Pipeline.version`, `replacePreviews` and `invalidate`, but not the read-path freshness check;
- F10, the moves and the `queue` → `queueName` rename;
- Host migration 3–5.

The S4, S5 and S6 rows of Phases say what stays in those phases.

## Decisions

Each line gives the cost if the decision is wrong. The owner summary has examples.

1. **A `queues` entry is a driver section plus that queue's timing keys.**
   - Database: `{ driver: 'database', leaseMs?, retryBackoffMs?, maxAttempts?, idlePollMs?, taskTimeoutMs? }`.
   - SQS: `{ driver: 'sqs', queueUrl, deadLetterQueueUrl?, waitTimeSeconds?, region?, endpoint?, …timing }`.
   - `driver` is required. Timing is per queue. `worker` and `coordination` are process-wide.
   - Cost if wrong: one more config change for hosts; S4 can still widen the entry.
2. **Missing names.**
   - A Resizer file without `queue` uses `'default'` when `queues` has entries, and is eager only when `queues` is absent or empty.
   - A name that is not in `queues` is the config error `RESIZE_CONFIG_QUEUE_UNKNOWN`. This includes the implied `'default'`.
   - `queue: false` is eager only.
   - A missing `resize.ts` means no queues, the default worker settings and the default coordination. The framework returns a new `{}` for a missing file and logs a warning on every request, so `getProcessConfig()` remembers an empty result per app instance and does not ask again.
   - Cost if wrong: a host with only `queues.bulk` fails loudly instead of running silently eager.
3. **A FrameworkResizer given `tasks` in code does not choose its queue from `queues`.** (Amended by Ruling S2b-6: only the lane choice skips `queues`; a `src/config/resize.ts` that exists is still validated whole when `worker` or `coordination` is read from it, so a broken `queues` there fails `verify()` unless `coordination` is passed in code too.)
   - Its `queueName` is the `queueName` option, else the file's `queue` name, else `'default'`.
   - `verify()` checks that `tasks.servesQueue(queueName)` is true.
   - `tasks: false` is eager only, as today.
4. **Backend: one task queue object, built once per process.**
   - All `database` entries are one backend: the app's `ResizeTask` model.
   - SQS entries that share `region`, `endpoint`, `deadLetterQueueUrl` and the effective `waitTimeSeconds` (default 10) are one backend: one `SqsTaskQueue` with a name → URL map.
   - Different values in any of those make a different backend.
   - The brief asked for one `TaskQueue` instance per name. That cannot work before S4: a Resizer holds one task queue, but its calls may name other queues on the same backend (`prewarm({ queue: 'bulk' })`), and the worker finds the queues it consumes through the Resizers. So the instance is per backend, and each name is a lane with its own timing.
   - An environment override that moves only some queues to another backend splits them, in that environment only. For example, a production file that sets only `queues.default` to SQS, while `bulk` stays on the database. Calls on the other backend's names then fail with `RESIZE_QUEUE_NOT_SERVED` there (Decision 5), and a Resizer whose own queue moved away fails `verify()`. The docs say to move all of a Resizer's queues together until S4.
   - Cost if wrong: hosts see no difference; S4 wraps several backends in `RoutingTaskQueue`.
5. **A call on a queue the task queue does not serve.**
   - This covers an unknown name, or a name on another backend.
   - Before any gate lock or `add`, the Dispatcher returns `not-served`.
   - `resolve()` logs a warning once per queue name and queues nothing.
   - `prewarm()` reports every variant `unconfirmed`, with the issue `RESIZE_QUEUE_NOT_SERVED` and `retryable: false`.
   - The message: `resize enqueue: Resizer '<name>' cannot queue to '<queue>': its task queue does not serve that queue (an unknown queue name, or a queue on another backend; one Resizer cannot use two backends yet)`.
   - A Resizer's own `queueName` on another backend is caught by `verify()` and worker start (`RESIZE_QUEUE_NOT_SERVED`, as today).
   - This is a call-time setup error, not a config error, because a per-call name is unknown at config time.
6. **The timing-conflict check is gone.**
   - `RESIZE_CONFIG_QUEUE_TIMING_CONFLICT`, `queueUsers`, `addQueueUser`, `backendTiming`, `checkQueueUser` and `appTaskQueue` are deleted.
   - Each name is defined once, in one file, so two files can no longer disagree.
   - The per-backend instances stay as module state in `src/framework/queue.ts`. S4 removes them.
7. **The process-wide sections are read only from `src/config/resize.ts`.**
   - `queues`, `worker` or `coordination` in another config file, or in the FrameworkResizer `config` option, is `RESIZE_CONFIG_INVALID` naming the key. The type still allows them in every file (Decision 18).
   - The worker's `--config` flag and `runResizeWorker({ configName })` are removed. `--config` is rejected with `RESIZE_CONFIG_REMOVED_KEY`.
   - `src/config/resize.ts` needs `mediaModelName` only when the default Resizer reads it. A `resize.ts` that holds only process-wide sections writes `satisfies Partial<FrameworkResizeConfig>`, the form environment overrides use (Decision 18).
   - The framework merges `resize.<NODE_ENV>.ts` before the module sees a value, so the messages name ``src/config/<name>.ts (or its resize.<NODE_ENV>.ts override)``.
8. **The old shape is rejected.**
   - A `queue` object, in any file, is `RESIZE_CONFIG_REMOVED_KEY`: ``resize config: `queue` in src/config/<name>.ts (or its resize.<NODE_ENV>.ts override) is now a queue name — define the queue once in src/config/resize.ts as queues: { default: { driver: 'database', …timing } } and set queue: 'default' (or queue: false for eager only)``.
   - `queues.<name>.queues` is `RESIZE_CONFIG_REMOVED_KEY`: give each SQS queue its own entry.
   - `queues.<name>.lockTtlMs` keeps its `coordination` message.
9. **`queueName`.**
   - The option is `queueName?: string | (() => string)`.
   - A string is validated and readable at construction: `resizer.queueName` returns it without `ready()`.
   - A function is called on first use; this is how the adapter passes a name from the config file. Until then, `resizer.queueName` throws `RESIZE_NOT_READY`. A FrameworkResizer given the `queueName` option passes it as a string, so it is readable at once.
   - `resizer.queue` is gone.
   - `RESIZE_QUEUE_INVALID` means "not a non-empty string".
   - The old `queue` option is also `RESIZE_QUEUE_INVALID` (``resize: `queue` is now `queueName` ``).
   - `resolve` and `prewarm` keep `queue` per call.
10. **`resizeMediaSchemaFragment` and `resizeMediaPaths` move to `…/drivers/mongo.js`.**
    - `…/framework.js` re-exports them. They are removed from the main entry.
    - The fragment is plain data, but it is Mongoose schema syntax.
    - Removing it from the main entry later would break hosts; adding it back would not.
11. **Defaults.**
    - `defaultFrameworkResizeConfig` and `defaultWorkerOptions` move to `…/framework.js`, in `src/framework/defaults.ts`.
    - `defaultFrameworkResizeConfig` keeps only the per-Resizer defaults, which are the image settings, so a second Resizer file can spread it.
    - `…/config/resize.js` stays as the framework-free core defaults: the default export, `defaultQueueOptions` and `defaultCoordination`. It re-exports nothing from the framework, so every name has one import path.
    - Cost if wrong: S4's `createResizer` may make this subpath unnecessary; removing it then is one more import change for plain-Node hosts.
12. **`origin`.**
    - `sha256(canonicalJson({ storageRef, width, height }))`, as hex, first 16 characters.
    - `width` and `height` are the dimensions the media holds after this write, the same rule as the backfill: the measured display dimensions when the original lacks either one, else the stored ones.
    - They are computed before the rows are built, whether persist is on or off, so `generate({ persist: false })` and the worker write the same `origin`.
13. **`encodeSig`, one per row, scoped to the inputs that affect that row.**
    - `sha256(canonicalJson({ format, encode: encode.formats[format] ?? {}, sharpen: encode.sharpen !== false && (fit ? encode.sharpen.fit : encode.sharpen.cover), flatten: encode.flatten.formats.includes(format) ? encode.flatten.background : null, maxSize: fit ? maxSize : null, resultDimension: limits.resultDimension, animated: ['webp', 'gif'].includes(format) ? { animated, animationFrames: limits.animationFrames, pixelBudget: Math.min(limits.sourcePixels, limits.inputPixels) } : null, version: pipeline.version ?? null }))`, as hex, first 16 characters.
    - Amended in the final fix round (Ruling S2b-8): a row signs only the sharpen half of its own fit mode (a boolean; `sharpen: false` signs as false), and the animated slot also carries `limits.animationFrames`, so a sharpen half the row does not use no longer marks it stale, and a changed frame cap now does. The vectors in Task 6 below are the pre-amendment ones; `src/signatures.test.ts` holds the current ones.
    - Amended again in the second review round (Ruling S2b-10): the animated slot also carries `pixelBudget`, `min(limits.sourcePixels, limits.inputPixels)`, the budget that also caps the frames rendered (`framesOf` in `src/processor.ts`); a changed budget now marks an animated row stale. The recipe is final from this commit.
    - `fit` is the row's own `fit` flag.
    - `maxSize` counts only for `fit` rows, and `animated`, `limits.animationFrames` and the pixel budget only for the formats that can animate (webp, gif).
    - That format list is a frozen copy inside `src/signatures.ts`, part of the recipe, not a call to `isAnimatedFormat`. If Sharp later animates another format, that format's rows keep their signatures; changing the list would be a recipe change. `sharpen` (the row's own half), `flatten` (when applied to that format), the format's encode options, `limits.resultDimension`, `format` and the pipeline `version` count for every row.
    - The recipe is final now. S5 compares against rows written from rc.1 on, so any later refinement would regenerate every rc.1 preview.
    - There is no recipe version, for the same reason.
    - `canonicalJson(v) = JSON.stringify(canonicalizeFilterValue(JSON.parse(JSON.stringify(v))))`: keys sorted at every depth, `undefined` dropped, Dates as ISO strings. A `null` input value stays in the JSON.
    - The fixed vectors are in Task 6.
14. **`replacePreviews(mediaId, identities, rows): Promise<{ stored, removed }>`.**
    - It removes every stored row whose `identity` is in `identities` or belongs to one of `rows`, then appends `rows`, as one atomic write per media.
    - A row without a stored `identity` is never removed.
    - Mongo uses one `findOneAndUpdate` with an update pipeline (`updatePipeline: true`, `returnDocument: 'before'`, `lean: true`), so `removed` is exactly what the write removed, as plain objects.
    - The rows are first cast to the declared row shape with the model's `castObject` (Mongoose's `Model.castObject`): undeclared paths are dropped on strict rows, and values are cast. So it stores what `appendPreviews` stores, except the sub-document `_id`, which nothing reads.
    - A model-shaped object without `castObject` gets the rows as given, minus `undefined` keys.
    - A value `castObject` cannot cast (for example `bytes: 'abc'`) makes it throw a Mongoose `ValidationError` before the write, so `replacePreviews` rejects with that error, not a `ResizeError`, and nothing is removed. The Processor's rows are typed, so it does not happen there; the contract doc says so.
    - The spec sketched `Promise<Preview[]>`. `invalidate` needs the removed rows, and reading them before the write would miss a row that a worker rewrites in between, which would leak its file.
    - It takes no `backfillDims`. S5 backfills through `appendPreviews(id, [], dims)`, which already writes the dimensions whether or not it stores a row. The contract doc says so.
15. **`invalidate({ media, pipeline? }): Promise<StorageRef[]>`.**
    - It loads the media fresh and picks this Resizer's rows that carry an `identity`: one pipeline, or all of them (missing `resizer` or `pipeline` counts as `'default'`).
    - It calls `replacePreviews(id, identities, [])` once and returns the removed rows' `storageRef`s.
    - It drops those rows from the caller's `media.previews` too.
    - It takes no gate:
      - a task running for that media can store rows after `invalidate` returns;
      - a row stored between the load and the write with a new identity stays;
      - `removed` is still exactly what the write removed.
    - A media that is gone gives `[]`. A store failure rejects as it is: one write, so nothing was removed. It never deletes files and never queues.
    - Rows without an `identity` (from before 0.3.0) stay; the host removes those itself.
    - `verify()` rejects a media store without `replacePreviews` (`RESIZE_MEDIA_REPLACE_MISSING`), because S5's worker needs it too.
16. **Strict mode.**
    - Media: strict sub-document preview rows must declare `identity`, `origin` and `encodeSig`, or `verify()` throws `RESIZE_MONGO_MEDIA_MODEL_OUTDATED`. Without `origin` and `encodeSig`, S5 would regenerate every row forever.
    - `bytes` and `createdAt` are informational and not checked.
    - `ResizeTask`: `startedAt` and `finishedAt` are informational. `RESIZE_MONGO_MODEL_OUTDATED` does not list them: that error makes every add unconfirmed, which is too heavy for two times that nothing reads. `resize-scaffold --check` reports an ejected model without them as drift.
17. **`--check` on an old config.**
    - `src/config/resize.ts` is drift when, ignoring `//` comment lines, it has a `queue:` object or imports `defaultFrameworkResizeConfig` from `…/config/resize.js`.
    - The hint names the new shape. The file is still never diffed.
    - So right after the upgrade, `--check` reports every config scaffolded before this version, and every ejected model (Task 9). That is the intended signal, and the docs say how to clear it.
18. **Type names are final now.**
    - Every config file, `src/config/resize.ts` and each other Resizer's file, writes `satisfies FrameworkResizeConfig`. Two files write `satisfies Partial<FrameworkResizeConfig>` instead: an environment override, and a `resize.ts` that holds only process-wide sections (no default Resizer, so no `mediaModelName`).
    - That type includes the optional process-wide sections; Decision 7 rejects them at runtime outside `resize.ts`.
    - S4 keeps `FrameworkResizeConfig` as the alias of the core per-Resizer config plus `mediaModelName`.
    - The queue entry types get their core names now, without the `Framework` prefix: `QueueConfig`, `DatabaseQueueConfig` and `SqsQueueConfig`, because S4's `createResizer` takes the same `queues` map. They are exported from the main entry and re-exported from `…/framework.js`.
    - `FrameworkQueueConfig`, `FrameworkDatabaseQueueConfig` and `FrameworkSqsQueueConfig` are removed.
19. **Per-call lane timing in the Dispatcher.**
    - The Dispatcher reads `timingOf(tasks, req.queue)` per call. It is cached per name. One use is shortening the SQS gate lock after an unconfirmed `add` to that lane's lease.
    - A call whose queue has invalid timing queues nothing:
      - `prewarm()` reports it the way it reports an invalid timing of the Resizer's own queue today (`prewarmFailure`): every variant `unconfirmed`, one `RESIZE_ENQUEUE_INTERNAL_ERROR` issue with the timing error's message, and `retryable: false`, because the error is a `ResizeConfigError`. The Dispatcher hands the error back, and the Reader builds that result (Task 4);
      - `resolve()` logs once per queue name.
    - `verify()` validates the timing of the Resizer's own `queueName`. The `TaskQueue` contract cannot list the other names a queue serves, so a name used only per call is checked by its first `prewarm()` or `resolve()` and by the worker of its lane. The framework adapter validates every `queues` entry when it resolves the config.

## Global Constraints

- **Branch and repository.**
  - Work on branch `refactor/s2b-host-shapes` from `main` (`dbc9780`), in the worktree `.claude/worktrees/s1-ports-and-composition-root`. The controller creates the branch.
  - Each task ends with one commit. Nothing is pushed.
  - Use plain git in the worktree. Never `git -C`, and no compound git commands.
  - The docs site is `/Users/andrey/Work/framework-documenation-github`, branch `docs/s2b-host-shapes`, page `docs/12-resize.md`.
  - Do not read or touch the untracked `docs/superpowers/plans/2026-10-28-s3-decoder-port.md`.
- **Scope.** The nine brief items above. Out of scope:
  - S3: decoders, decode-once, and the step signature itself;
  - F7: `createResizer` and `fromConfig`;
  - S4 routing between backends;
  - the F8 metrics port and events;
  - the S5 read-path freshness check;
  - the `processTask` export, S3 `Cache-Control`, and the superseded notes;
  - the `metrics` and `decoders` options.
- **Unchanged.**
  - The preview identity string and the random preview keys.
  - The gate and coordination, and lease-token fencing.
  - `resolve()` never throws and never runs Sharp.
  - `appendPreviews` is one guarded write per row.
  - The SVG and private-original policies.
  - The `ResizeTask` gate index and claim index.
  - `mongoParts` keeps one timing for every name.
- **Error codes.**
  - **New:**
    - `RESIZE_CONFIG_QUEUE_UNKNOWN` (`ResizeConfigError`): a Resizer's queue name is not in `queues`.
    - `RESIZE_MEDIA_REPLACE_MISSING` (`ResizeSetupError`): `verify()` or `invalidate` met a media store without `replacePreviews`.
    - `RESIZE_MEDIA_REPLACE_RESULT_INVALID` (`ResizeSetupError`): `replacePreviews` resolved with something other than two arrays.
    - The prewarm issue `RESIZE_QUEUE_NOT_SERVED` (`retryable: false`). An invalid per-call lane timing reuses `RESIZE_ENQUEUE_INTERNAL_ERROR` (Decision 19).
  - **Removed:** `RESIZE_CONFIG_QUEUE_TIMING_CONFLICT`.
  - **Wider meaning:**
    - `RESIZE_CONFIG_REMOVED_KEY` also covers a `queue` object, `queues.<n>.queues`, `queues.<n>.lockTtlMs` and the worker's `--config`. In a core config, its `queue` and `worker` messages now point framework hosts at `queues` and `worker` in `src/config/resize.ts`.
    - `RESIZE_CONFIG_INVALID` also covers:
      - a malformed `queues` map or entry;
      - a duplicate SQS `queueUrl`;
      - a `queue` that is not a name or `false`;
      - a process-wide section outside `src/config/resize.ts`.
    - `RESIZE_QUEUE_INVALID` now names `queueName`, and also covers the old `queue` option.
    - `RESIZE_QUEUE_NOT_SERVED` is also a prewarm issue.
    - `RESIZE_SQS_QUEUE_URL_REQUIRED` now means "neither `queueUrl` nor a `queues` entry".
    - `RESIZE_MONGO_MEDIA_MODEL_OUTDATED` also covers missing `origin` and `encodeSig`.
    - `RESIZE_NOT_READY` also covers `queueName` before first use, when it comes from the config.
  - **Rerouted:** a call that names an SQS queue without a URL now gets `RESIZE_QUEUE_NOT_SERVED` before `add`, instead of the logged `RESIZE_SQS_QUEUE_UNKNOWN` and `RESIZE_ENQUEUE_QUEUE_FAILED`. The driver keeps `RESIZE_SQS_QUEUE_UNKNOWN` for direct callers.
  - Every host-visible change appears in Task 10.
- **Pre-release.**
  - Breaking changes ship without migration code. Hosts migrate their own data and indexes, and the module never creates indexes.
  - Keep `minimize: false`.
  - The version becomes `0.3.0-rc.1` in Task 10. The owner publishes with `--tag next`.
- **House rules from S1 and S2.**
  - Classes own their behaviour. Module-private helpers take narrow parameters, never a whole deps bag.
  - No service imports `resizer.ts`.
  - `drivers/**` import only contracts, errors, helpers, types and other drivers.
  - `src/types.d.ts` stays dependency-free.
  - No `any`, except with a `biome-ignore` that gives the reason.
  - No test-only seams in shipped code.
  - Shipped code uses the `isResizeError` brand, never `instanceof`, on errors.
  - Comments state reasons in plain words, with no spec-section references and no private project names.
  - Tests never spread class-typed values; write the object out.
  - The main entry imports no framework code and no mongoose.
- **Checks.**
  - Every task ends with `npm run types:check`, `npm run check` and `npm test` passing. `npm test` runs every `*.test.ts`, including the `*.integration.test.ts` files. Test files stay outside `types:check` (about 65 errors already exist there); add none.
  - Tasks 1, 2, 4, 5, 6, 7, 8 and 10 also run `npm run build && npm run smoke`.
  - One file: `node --experimental-strip-types --test src/<file>.test.ts`. The Mongo tests start mongodb-memory-server themselves.
  - `src/config/resize.framework.integration.test.ts` runs only when `dist/` exists, so run it after `npm run build` in Tasks 2 and 5.
- **Renames.**
  - Use `git mv` for every file that keeps its content under a new name.
  - Task 1's moved files stay byte-identical in its commit. The commit also carries the import lines of their importers and the export lines, because a move alone cannot be green: the main entry may not reach `drivers/` (`src/index.test.ts`), and AGENTS.md's main-entry imports are pinned (`src/agentsDoc.test.ts`).
  - Check it with `git diff --cached -M --stat` before the commit.
- **Commit messages** use a conventional prefix, with NO `Co-Authored-By` and no "Generated with" trailer.

## Review Focus

1. **Two Resizers on two database queue names, under one worker.**
   - `queues: { default: { driver: 'database' }, bulk: { driver: 'database', leaseMs: 30_000 } }`, with Resizer `a` on `default` and `listings` on `bulk`.
   - Both share one task queue.
   - A worker started with `--queue=bulk` claims only `bulk` tasks, with a 30 s lease. The `default` lane keeps 60 s.
   - A `prewarm({ queue: 'bulk' })` that the queue does not confirm keeps the gate lock for `bulk`'s lease.
   - (Test: Tasks 3 and 4 in memory, Task 5 through the adapter.)
2. **`prewarm({ queue })` naming a queue on another backend** (a database Resizer, `queues.bulk` on SQS) or an unknown name.
   - Every variant is `unconfirmed` with the non-retryable `RESIZE_QUEUE_NOT_SERVED`.
   - No `add`, and no gate lock.
   - `resolve()` with that queue logs once and returns its decision.
   - (Test: Task 4 in memory, Task 5 through the adapter.)
3. **An old-shape config file** (`queue: { driver: 'database' }` in `resize.ts`).
   - First use, `verify()` and worker start reject with `RESIZE_CONFIG_REMOVED_KEY`, naming `queues: { default: … }` and `queue: 'default'`.
   - `resolve()` still never throws.
   - `resize-scaffold --check` reports drift.
   - (Test: Task 5.)
4. **A media doc whose previews were written before this phase** (no `bytes`, `createdAt`, `origin` or `encodeSig`).
   - `resolve()` serves them as ready and queues nothing.
   - A task for the same sizes renders nothing for them.
   - (Test: Task 6.)
5. **`invalidate` on a media with rows from two pipelines**, plus another Resizer's row and a row without an `identity`.
   - With `pipeline`, only that pipeline's rows of this Resizer go.
   - Without `pipeline`, all of this Resizer's rows go.
   - The returned refs are exactly the removed rows' refs, and the other two rows stay.
   - On MongoDB it is one write.
   - (Test: Task 8, with the Mongo store's atomicity in Task 7.)

---

## File structure

| File | Change | Responsibility after S2b |
|---|---|---|
| `src/drivers/mongo/mediaFragment.ts` (+ `.test.ts`) | `git mv` from `src/mediaFragment.ts` | The media schema fragment and `resizeMediaPaths`, now with `bytes`, `createdAt`, `origin`, `encodeSig` |
| `src/framework/defaults.ts` | Create | `defaultFrameworkResizeConfig` (per-Resizer image defaults), `defaultWorkerOptions` |
| `src/config/resize.ts` | Modify | Core defaults only: the default export, `defaultQueueOptions`, `defaultCoordination` |
| `src/contracts/taskQueue.ts`, `src/timing.ts` | Modify | `getTiming?(queue)`; `timingOf(tasks, queue)` cached per task queue and name |
| `src/drivers/mongo/taskQueue.ts`, `schemas.ts` | Modify | `queues` + `servesQueue`; per-name `getTiming`; `startedAt` / `finishedAt` |
| `src/drivers/sqs.ts` | Modify | `queueUrl` optional beside `queues`; per-name `getTiming` |
| `src/resizer.ts`, `src/reader.ts`, `src/dispatcher.ts` | Modify | `queueName`; per-call lane timing; the `not-served` outcome; `verify()` checks `replacePreviews`; `invalidate` facade |
| `src/types.d.ts` | Modify | `QueueConfig`, `DatabaseQueueConfig`, `SqsQueueConfig`, `FrameworkResizeConfig`, `Preview` fields, `InvalidateOpts`, issue codes |
| `src/resizeConfig.ts` | Modify | The core config's removed-key messages name `queues` and `src/config/resize.ts` |
| `src/framework/config.ts` | Modify | `resolveFrameworkConfig(raw, source)` (one Resizer's sections), `resolveProcessConfig(raw)`, `getProcessConfig()` |
| `src/framework/queue.ts` | Rewrite | One task queue per backend (`backendKey`, `taskQueueOf`); no timing-conflict state |
| `src/framework/resizer.ts`, `media.ts`, `worker.ts`, `ResizeWorkerCommand.ts`, `index.ts` | Modify | The queue name from the file, the task queue from `queues`, the process `worker` and `coordination`, `--config` removed |
| `src/framework/scaffold/templates/*.tpl`, `command.ts` | Modify | The final config shape; `--check` on old configs and on the task-row fields |
| `src/signatures.ts` (+ `.test.ts`) | Create | `canonicalJson`, `previewOrigin`, `encodeSignature` |
| `src/contracts/pipeline.ts` | Modify | `version?: string` |
| `src/processor.ts` | Modify | Writes the four fields; `invalidate` |
| `src/contracts/media.ts`, `src/drivers/mongo/media.ts` | Modify | `replacePreviews` + `ReplacedPreviews`; the cast, lean update pipeline; verify checks `origin` and `encodeSig` |
| `src/testHelpers/fakes.ts`, `contractShapes.ts`, `consume.ts`, `resizeConfig.ts` | Modify | Per-name timing and served names, claim records, `replacePreviews`, the new defaults path |
| `src/agentsDoc.test.ts` | Modify | Also pins AGENTS.md's named imports from `…/framework.js` and `…/drivers/mongo.js` |
| `src/index.ts`, `smokeTest.ts`, `package.json` | Modify | Exports; the published surface; `0.3.0-rc.1` |
| `README.md`, `AGENTS.md`, `CHANGELOG.md`, `RELEASE.md`, `docs/host-adoption.md`, site `docs/12-resize.md` | Modify | Everything a host sees |

---

### Task 1: The media schema fragment moves to `…/drivers/mongo.js`

**Files:**
- Move:
  - `git mv src/mediaFragment.ts src/drivers/mongo/mediaFragment.ts`;
  - `git mv src/mediaFragment.test.ts src/drivers/mongo/mediaFragment.test.ts`.
  - Both stay byte-identical; the test file's `./mediaFragment.ts` import still resolves.
- Modify:
  - the five other importers of `src/mediaFragment.ts`:
    - `src/drivers/mongo/media.mongo.integration.test.ts:9`;
    - `src/drivers/mongo/frameworkFree.integration.test.ts:14`;
    - `src/drivers/mongo/drivers.mongo.integration.test.ts:7`;
    - `src/framework/storageRef.persistence.integration.test.ts:17`;
    - `src/framework/worker.mongo.integration.test.ts:21`;
  - `src/index.ts:63-67` (drop the re-export);
  - `src/drivers/mongo/index.ts` and `src/framework/index.ts` (export);
  - `src/index.test.ts:34-35, 101-105`;
  - `src/agentsDoc.test.ts`;
  - `smokeTest.ts:45-46, 124-136, 247-290`;
  - `AGENTS.md`: only the two import lines (`:169`, `:347`) that name the main entry.
- Test: `src/index.test.ts`, `src/agentsDoc.test.ts`

**Interfaces:**
Produces: `resizeMediaSchemaFragment` and `resizeMediaPaths`, values unchanged.
- Exported from `src/drivers/mongo/index.ts`.
- Re-exported from `src/framework/index.ts` (`export { resizeMediaPaths, resizeMediaSchemaFragment } from '../drivers/mongo/mediaFragment.ts'`).
- Gone from `src/index.ts`.

- [ ] **Step 1: Move the files.**
  - Run `git mv src/mediaFragment.ts src/drivers/mongo/mediaFragment.ts`, then `git mv src/mediaFragment.test.ts src/drivers/mongo/mediaFragment.test.ts`.
  - Point the five importers at the new path:
    - `'../../mediaFragment.ts'` becomes `'./mediaFragment.ts'` in `src/drivers/mongo/`;
    - `'../mediaFragment.ts'` becomes `'../drivers/mongo/mediaFragment.ts'` in `src/framework/`.
  - Do not edit the moved files.
- [ ] **Step 2: Write the failing tests.**
  - In `src/index.test.ts`:
    - delete both names from `EXPECTED_VALUE_EXPORTS`;
    - delete the test 'the schema fragment is a real plain object' (the moved file covers the shape);
    - add:
```ts
describe('moved exports', () => {
  test('…/drivers/mongo.js and …/framework.js export the one fragment; the main entry does not', async () => {
    // const mongo = await import('./drivers/mongo/index.ts'); const framework = await import('./framework/index.ts');
    // framework.resizeMediaSchemaFragment === mongo.resizeMediaSchemaFragment; framework.resizeMediaPaths === mongo.resizeMediaPaths
    // mongo.resizeMediaPaths deepEqual ['original', 'previews']; 'resizeMediaSchemaFragment' in api === false; 'resizeMediaPaths' in api === false
  });
});
```
  - In `src/agentsDoc.test.ts`, add:
```ts
test('every value imported from …/framework.js or …/drivers/mongo.js in snippets is a real export of that entry', async () => {
  // for each `import { … } from '@adaptivestone/framework-module-resize/framework.js'` (and '/drivers/mongo.js') in AGENTS.md,
  // every name that is not `type …` is in (await import('./framework/index.ts')) (resp. './drivers/mongo/index.ts')
});
```
- [ ] **Step 3: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/index.test.ts src/agentsDoc.test.ts`. Expected: FAIL. Both files fail to load with ERR_MODULE_NOT_FOUND for `src/mediaFragment.ts`, because `src/index.ts` still imports the old path.
- [ ] **Step 4: Move the exports.**
  - Drop the two names from `src/index.ts`, and add them to `src/drivers/mongo/index.ts` and `src/framework/index.ts`.
  - In AGENTS.md, the two snippet imports become `from '@adaptivestone/framework-module-resize/framework.js'`. The prose waits for Task 10.
  - In `smokeTest.ts`:
    - `CHECK_CORE` drops the two names.
    - The subpath pairs gain `['/drivers/mongo.js', 'resizeMediaSchemaFragment']`, `['/drivers/mongo.js', 'resizeMediaPaths']`, `['/framework.js', 'resizeMediaSchemaFragment']` and `['/framework.js', 'resizeMediaPaths']`.
    - `CHECK_TYPES` imports the fragment from `…/drivers/mongo.js` and spreads it into a typed object.
- [ ] **Step 5: Run everything to verify it passes.**
  - Run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS, including the five integration tests that import the fragment, which `npm test` runs too.
  - Then, one command per line:
    - `git add -A src smokeTest.ts AGENTS.md`
    - `git diff --cached -M --stat`. Expected: `src/{ => drivers/mongo}/mediaFragment.ts | 0` and `src/{ => drivers/mongo}/mediaFragment.test.ts | 0`.
- [ ] **Step 6: Commit.** `git commit -m "refactor!: resizeMediaSchemaFragment and resizeMediaPaths move to …/drivers/mongo.js and …/framework.js"`

### Task 2: The framework defaults move to `…/framework.js`

**Files:**
- Create: `src/framework/defaults.ts`
- Modify:
  - `src/config/resize.ts`: drop `defaultWorkerOptions` and `defaultFrameworkResizeConfig`, and update the header comment;
  - `src/framework/index.ts`;
  - the imports in `src/framework/config.ts:6`, `src/testHelpers/resizeConfig.ts:1-3` and `src/framework/worker.test.ts:7`;
  - `src/framework/scaffold/templates/resize.config.ts.tpl:6-7, 25` and `resize.config.eager.ts.tpl:5-6`;
  - `smokeTest.ts:261-273`.
- Test: `src/config/resize.test.ts:17-21, 36-56, 300-310`, `src/framework/scaffold/command.test.ts:19, 99, 111`

**Interfaces:**
Produces:
```ts
// src/framework/defaults.ts (exported from …/framework.js)
export const defaultWorkerOptions: FrameworkWorkerConfig;  // { enabled: false, sharpConcurrency: 1, sharpCache: false }
export const defaultFrameworkResizeConfig: ResizeConfig;   // what any Resizer config file spreads: the image settings only (a copy of the core defaults), no worker, no coordination
// src/config/resize.ts (…/config/resize.js): default export, defaultQueueOptions, defaultCoordination — nothing else
```
**Decision:**
- `defaultFrameworkResizeConfig` stops carrying `worker` and `coordination`, so a second Resizer's file can spread it (Task 5 rejects process-wide sections there). A missing `coordination` already means the defaults.
- Both templates import from `…/framework.js`.
- The queue template writes `worker: { ...defaultWorkerOptions, enabled: false }`, uncommented, with a comment that `enabled: true` lets `npm run cli ResizeWorker` run. Its value equals today's default.

- [ ] **Step 1: Write the failing tests.** In `src/config/resize.test.ts`, replace 'defaultFrameworkResizeConfig carries the coordination defaults' and the `defaultFrameworkResizeConfig` asserts of 'ships the canonical host defaults…' with:
```ts
test('…/config/resize.js holds only the core defaults', async () => {
  // const mod = await import('./resize.ts'); Object.keys(mod).sort() deepEqual ['default', 'defaultCoordination', 'defaultQueueOptions']
});
test('defaultFrameworkResizeConfig is the per-Resizer defaults: the image settings, no process-wide section', async () => {
  // const { defaultFrameworkResizeConfig, defaultWorkerOptions } = await import('../framework/index.ts');
  // defaultFrameworkResizeConfig deepEqual defaultResizeConfig; 'worker', 'coordination', 'queue', 'queues', 'storage' not in it
  // defaultWorkerOptions deepEqual { enabled: false, sharpConcurrency: 1, sharpCache: false }
});
```
  - In `src/framework/scaffold/command.test.ts`, the config template must import `defaultFrameworkResizeConfig` and `defaultWorkerOptions` from `@adaptivestone/framework-module-resize/framework.js`, and contain no `…/config/resize.js`.
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/config/resize.test.ts src/framework/scaffold/command.test.ts`. Expected: FAIL.
  - The key list of `./resize.ts` also holds `defaultFrameworkResizeConfig` and `defaultWorkerOptions`.
  - The framework entry's `defaultWorkerOptions` is `undefined`, so `deepEqual` fails.
  - The template still imports `…/config/resize.js`.
- [ ] **Step 3: Create `src/framework/defaults.ts`, then update the importers and templates.** Every importer of the two names reads them from `../framework/defaults.ts` (inside the framework: `./defaults.ts`). In `CHECK_TYPES`, the host config imports both from `…/framework.js`.
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke && node --experimental-strip-types --test src/config/resize.framework.integration.test.ts`. Expected: PASS. The integration test shows that a scaffolded config which imports `…/framework.js` loads inside a real `Server.init()`.
- [ ] **Step 5: Commit.** One command per line:
  - `git add -A src smokeTest.ts`
  - `git commit -m "refactor!: defaultFrameworkResizeConfig and defaultWorkerOptions move to …/framework.js"`

### Task 3: Queue timing per queue name; task queues say which names they serve

**Files:**
- Modify:
  - `src/contracts/taskQueue.ts` (the `getTiming` doc and signature);
  - `src/timing.ts:63-78`;
  - the `timingOf` callers: `src/worker.ts:270`, `src/resizer.ts:449`, `src/testHelpers/consume.ts:24`;
  - `src/drivers/mongo/taskQueue.ts:36-46, 131-145`;
  - `src/drivers/sqs.ts:33-45, 76-128`;
  - `src/testHelpers/fakes.ts:152-170, 303-330`.
- Test: `src/timing.test.ts`, `src/drivers/mongo/taskQueue.test.ts`, `src/drivers/sqs.test.ts`, `src/testHelpers/fakes.test.ts`, `src/worker.test.ts`

**Interfaces:**
Produces:
```ts
// src/contracts/taskQueue.ts
getTiming?(queue: string): Partial<QueueTimingOptions> | undefined; // one queue name's timing; a queue with one timing ignores the name
// src/timing.ts
export function timingOf(tasks: TaskQueue, queue: string): QueueTiming; // filled and validated once per (task queue, name); an invalid name never caches
// src/drivers/mongo/taskQueue.ts
export interface MongoTaskQueueOptions {
  model?: MongoTaskModel; getModel?: () => MongoTaskModel | null | undefined; logger?: ResizeLogger;
  timing?: Partial<QueueTimingOptions>;                                    // every name
  getTiming?: (queue: string) => Partial<QueueTimingOptions> | undefined; // per name, over `timing`
  queues?: readonly string[];                                              // the names it serves; default: every name
}
servesQueue(queue: string): boolean;                   // this.#queues?.includes(queue) ?? true
getTiming(queue: string): Partial<QueueTimingOptions>; // opts.getTiming?.(queue) ?? opts.timing ?? {}
// src/drivers/sqs.ts
export interface SqsTaskQueueOptions { queueUrl?: string; queues?: Record<string, string>; getTiming?: (queue: string) => Partial<QueueTimingOptions> | undefined; /* the rest unchanged */ }
// 'default' → queueUrl ?? queues.default; another name → queues[name]; servesQueue(q) = a URL exists for q
// constructor: RESIZE_SQS_QUEUE_URL_REQUIRED unless queueUrl or at least one queues entry is set
// src/testHelpers/fakes.ts (RowQueue, so MemoryTaskQueue, PlainTaskQueue, ReleasingTaskQueue)
constructor(opts?: { timing?: Partial<QueueTimingOptions>; queueTiming?: Record<string, Partial<QueueTimingOptions>>; queues?: readonly string[] });
readonly claims: Array<{ queue: string; leaseMs: number }>; // every claim call
servesQueue(queue: string): boolean;                        // queues?.includes(queue) ?? true
getTiming(queue: string): Partial<QueueTimingOptions>;      // queueTiming?.[queue] ?? timing ?? {}
```
**Decision:** A queue without a `queues` list keeps serving every name, so `mongoParts` and custom queues behave as today. The cache in `timingOf` is a `WeakMap<TaskQueue, Map<string, QueueTiming>>`. The Dispatcher's per-call timing is Task 4.

- [ ] **Step 1: Write the failing tests.**
```ts
// src/timing.test.ts
test('timingOf reads each queue name once and keeps the names apart', …)
  // a queue whose getTiming(q) counts calls and returns { leaseMs: 30_000 } for 'bulk', {} otherwise
  // timingOf(q, 'bulk').leaseMs 30_000; timingOf(q, 'default').leaseMs 60_000; a second timingOf(q, 'bulk') makes no call
test("one name's invalid timing throws for that name only", …)
  // 'bad' → { leaseMs: 0 } rejects with RESIZE_CONFIG_QUEUE_LEASE_INVALID twice (not cached); 'default' still resolves
test('a getTiming that ignores the name gives every name the same timing', …)
// src/drivers/mongo/taskQueue.test.ts
test('servesQueue: every name without a list, only the listed names with one', …)
test('getTiming(queue) asks the option for that name and falls back to timing', …)
// src/drivers/sqs.test.ts
test('queueUrl may be left out when queues names the queues; queues.default serves default', …)
test('neither queueUrl nor a queues entry is RESIZE_SQS_QUEUE_URL_REQUIRED', …)
test('getTiming(queue) asks the option for that name', …)
// src/worker.test.ts — Review Focus 1, in memory
test('two Resizers on two names of one task queue: each lane is claimed by its own worker with its own lease', …)
  // tasks = new MemoryTaskQueue({ queues: ['default', 'bulk'], queueTiming: { bulk: { leaseMs: 30_000 } } })
  // a = Resizer({ name: 'a', tasks, … }); b = Resizer({ name: 'b', queue: 'bulk', tasks, … })  — `queue` becomes `queueName` in Task 4
  // a.resolve(cold m1); b.resolve(cold m2) → rows [{ queue: 'default', resizer: 'a' }, { queue: 'bulk', resizer: 'b' }]
  // runWorker({ queue: 'bulk', resizers: [a, b] }) until b's task completes → a's row still pending
  // every tasks.claims entry deepEqual { queue: 'bulk', leaseMs: 30_000 }
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/timing.test.ts src/drivers/mongo/taskQueue.test.ts src/drivers/sqs.test.ts src/worker.test.ts`. Expected: FAIL. `timingOf` ignores the name, the fakes take no `queueTiming`, and the SQS constructor still demands `queueUrl`.
- [ ] **Step 3: Implement the signatures above.**
  - Every `timingOf(tasks)` call passes its queue name:
    - the worker: its `queue`;
    - `#buildDispatcher`: `this.queue` (Task 4 renames it and makes the Dispatcher read each call's queue);
    - `consume()`: `opts.queue`.
  - `src/framework/queue.ts` keeps compiling as it is, because its `getTiming: () => …` ignores the name.
  - Update the contract doc of `getTiming` and `servesQueue`.
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** One command per line:
  - `git add -A src`
  - `git commit -m "feat: queue timing per queue name; MongoTaskQueue and SqsTaskQueue say which names they serve"`

### Task 4: `queueName`, per-call lane timing, and calls on a queue the task queue does not serve

**Files:**
- Modify:
  - `src/resizer.ts:78, 142, 192-197, 225, 404, 444-462, 505-520`;
  - `src/reader.ts:45, 203, 394`;
  - `src/dispatcher.ts:33-50, 80-88, 160-260, 270-345`;
  - `src/types.d.ts:137-150, 201, 210`;
  - `src/framework/resizer.ts:48-62`: `FrameworkResizerOptions` omits `queueName` from `ResizerOptions` and re-adds `queueName?: string`. Its value still defaults to `'default'` until Task 5.
- Test: `src/resizer.test.ts`, `src/dispatcher.test.ts`, `src/reader.test.ts`, `src/prewarm.test.ts`, `src/worker.test.ts`, and every test that passes `queue:` to a Resizer constructor. Two test helpers build a `Dispatcher` with `leaseMs` and must pass `timingOf` instead: `src/dispatcher.test.ts:94-98` (its `leaseMs` option becomes `timingOf`, default `() => fillTiming({})`) and `src/reader.test.ts:155-159`. Test files are outside `types:check`, so a missed one fails only at run time.

**Interfaces:**
Consumes: `servesQueue`, `timingOf(tasks, queue)`, and the fakes' `queues` and `queueTiming` (Task 3).
Produces:
```ts
// src/resizer.ts
interface ResizerOptions { queueName?: string | (() => string) /* default 'default'; a function is called once on first use, before the Dispatcher is built */ }
get queueName(): string; // a string option: at once, without ready(); a function: RESIZE_NOT_READY until first use
// construction: own `queue` key → ResizeSetupError RESIZE_QUEUE_INVALID "resize: `queue` is now `queueName`"
// a string that is empty or not a string → RESIZE_QUEUE_INVALID "resize: `queueName` must be a non-empty string" (a function's result: on first use)
// #buildDispatcher: validates timingOf(tasks, this.queueName) (a failure is the queue failure, as today) and passes timingOf: (queue) => timingOf(tasks, queue)
// src/reader.ts
interface ReaderDeps { queueName: string /* was queue */ }
// src/dispatcher.ts
interface DispatcherDeps { timingOf: (queue: string) => QueueTiming /* replaces leaseMs */; /* tasks, locks, coordination, name, logger unchanged */ }
type DispatchOutcome = … | { status: 'not-served' } | { status: 'timing-invalid'; error: unknown };
// #dispatch, before any gate lock or add: servesQueue(req.queue) === false → not-served; then timingOf(req.queue) throws → timing-invalid
// the unconfirmed-add shortening uses Math.min(timingOf(req.queue).leaseMs, coordination.gateTtlMs)
// src/types.d.ts
EnqueueIssue['code'] gains 'RESIZE_QUEUE_NOT_SERVED'
// ResolveOpts/PrewarmOpts `queue` comments say "default resizer.queueName"
```
**Decision:**
- `enqueue` (the read path) logs Decision 5's message once per queue name, at `warn`, through `logNeverThrow`. For `timing-invalid`, it logs the error once per queue name, at `error`.
- `enqueueConfirmed` marks every variant `unconfirmed`, with one issue:
  - `not-served`: `{ code: 'RESIZE_QUEUE_NOT_SERVED', retryable: false, message, previews }`;
  - `timing-invalid`: the Dispatcher builds no issue. `ConfirmedEnqueueResult` gains `timingError?: unknown`, set only for this outcome, with every variant `unconfirmed` and empty `accepted`, `tasks` and `issues`. The Reader's prewarm path maps it: `finish({ ...prewarmFailure(attempt.timingError, required), requested, ready, notRequired })`, exactly as it does for `queueFailure` (`src/reader.ts:380-389`). `src/dispatcher.ts` imports nothing from `src/reader.ts`, so the import direction stays reader → dispatcher.
- A queue without `servesQueue` serves every name.

- [ ] **Step 1: Write the failing tests.**
```ts
// src/resizer.test.ts
test('queueName defaults to default and names the queue of every task', …)            // resolve on a cold media → tasks.added[0].queue 'default'; with queueName 'bulk' → 'bulk'
test('a string queueName is readable at once; a function is read on first use', …)    // queueName 'bulk' → resizer.queueName 'bulk' before ready(); queueName () => 'bulk' → RESIZE_NOT_READY before ready(), 'bulk' after, the function ran once
test('the old queue option is RESIZE_QUEUE_INVALID naming queueName', …)              // new Resizer({ …, queue: 'bulk' } as never) throws, message /`queue` is now `queueName`/
test('an empty queueName is RESIZE_QUEUE_INVALID', …)
// src/dispatcher.test.ts — Review Focus 1, the Dispatcher half
test("an unconfirmed add keeps the gate lock for the lease of the call's lane", …)
  // a non-gating queue whose add resolves { status: 'unconfirmed' }, queueTiming { bulk: { leaseMs: 120_000 } }; clockLocks(() => 0); gateTtlMs 600_000
  // enqueue(m1 on 'bulk') → locks.entry(gateKey('default', 'bulk', 'm1', 'default')).expiresAt === 120_000
  // enqueue(m2 on 'default') → expiresAt === 60_000
test('a call on a queue with invalid timing queues nothing and reports it as the own queue would', …)
  // queueTiming { bulk: { leaseMs: 0 } } → prewarm on 'bulk': every variant unconfirmed, issues[0] { code: 'RESIZE_ENQUEUE_INTERNAL_ERROR', retryable: false }, message /leaseMs/; tasks.added empty
  // prewarm on 'default' still queues
// src/prewarm.test.ts — Review Focus 2, in memory
test('prewarm on a queue the task queue does not serve reports RESIZE_QUEUE_NOT_SERVED and queues nothing', …)
  // PlainTaskQueue({ queues: ['default'] }) + clockLocks(); prewarm({ media, sizes, queue: 'bulk' })
  // status 'incomplete'; unconfirmed = every requested variant; issues deepEqual [{ code: 'RESIZE_QUEUE_NOT_SERVED', retryable: false, … }]
  // tasks.added.length 0; no lock entry for the gate key
// src/reader.test.ts
test('resolve on such a queue logs once per queue name and returns its decision', …)
  // two resolve calls with queue 'bulk' → one warn naming 'bulk'; a third with queue 'other' → a second warn; tasks.added empty; decision.missing as requested
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/resizer.test.ts src/dispatcher.test.ts src/prewarm.test.ts src/reader.test.ts`. Expected: FAIL, because `queueName` is ignored, `add` is called, and the gate lock keeps the default lease.
- [ ] **Step 3: Implement the rename, the per-call timing and the two new outcomes.**
  - Rename the Reader dep.
  - `verify()` keeps `RESIZE_QUEUE_NOT_SERVED` and names `queueName` in its message.
  - Replace `queue:` with `queueName:` in every Resizer construction in the tests, including Task 3's worker test.
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS.
- [ ] **Step 5: Commit.** One command per line:
  - `git add -A src`
  - `git commit -m "feat!: the queue option is queueName; each call uses its own lane's timing; a call on a queue the task queue does not serve queues nothing"`

### Task 5: The framework config shape: named `queues`, process-wide sections, `queue` as a name

**Files:**
- Modify:
  - `src/types.d.ts:310-357`;
  - `src/index.ts` (type exports `QueueConfig`, `DatabaseQueueConfig`, `SqsQueueConfig`);
  - `src/resizeConfig.ts:25-30` (the `queue` and `worker` removed-key messages);
  - `src/framework/config.ts` (whole file);
  - `src/framework/queue.ts` (rewrite);
  - `src/framework/resizer.ts` (whole file);
  - `src/framework/media.ts:10-30`;
  - `src/framework/worker.ts`, `src/framework/ResizeWorkerCommand.ts`;
  - `src/framework/index.ts`: the type exports; the `Framework*QueueConfig` names go, and the three core names are re-exported;
  - `src/architecture.test.ts:18-23` (`GLOBAL_LOOKUPS` gains `getProcessConfig`);
  - `src/framework/scaffold/templates/resize.config.ts.tpl`, `resize.config.eager.ts.tpl`;
  - `src/framework/scaffold/command.ts:24, 152-205, 240-345`;
  - `src/testHelpers/resizeConfig.ts`;
  - `smokeTest.ts:247-300`.
- Test:
  - `src/config/resize.test.ts`;
  - `src/framework/resizer.test.ts`: the timing-conflict tests at `:689-915` are deleted, and the reset test at `:916` is rewritten for the per-backend instances;
  - `src/framework/resizer.peers.test.ts`, `src/framework/worker.test.ts`, `src/framework/ResizeWorkerCommand.test.ts`;
  - `src/framework/scaffold/command.test.ts`;
  - `src/framework/worker.mongo.integration.test.ts`, `src/framework/storageRef.persistence.integration.test.ts`;
  - `src/config/resize.framework.integration.test.ts`.

**Interfaces:**
Consumes: `timingOf(tasks, queue)`, `MongoTaskQueueOptions.queues` / `getTiming`, `SqsTaskQueueOptions.queues` (Task 3); `ResizerOptions.queueName` as a function (Task 4); `defaultWorkerOptions` (Task 2).
Produces:
```ts
// src/types.d.ts (Decision 18)
export interface DatabaseQueueConfig extends Partial<QueueTimingOptions> { driver: 'database' }
export interface SqsQueueConfig extends Partial<QueueTimingOptions> { driver: 'sqs'; queueUrl: string; deadLetterQueueUrl?: string; waitTimeSeconds?: number; region?: string; endpoint?: string } // no `queues`
export type QueueConfig = DatabaseQueueConfig | SqsQueueConfig;
// Every framework config file: src/config/resize.ts and each other Resizer's file. The process-wide sections are optional here;
// the adapter reads them only from src/config/resize.ts and rejects them elsewhere.
export interface FrameworkResizeConfig extends ResizeConfig {
  mediaModelName: string; storage?: FrameworkStorageConfig; queue?: string | false; // this Resizer
  queues?: Record<string, QueueConfig>; worker?: FrameworkWorkerConfig; coordination?: CoordinationOptions; // process-wide
}
// src/framework/config.ts
export interface ConfigSource { configName: string; explicit: boolean } // explicit: the FrameworkResizer / FrameworkMediaStore `config` option
export interface ResolvedFrameworkConfig { image: ResizeConfig; mediaModelName: string; storage: FrameworkStorageConfig | undefined; queue: string | false | undefined }
export interface ResolvedQueue { name: string; section: QueueConfig; timing: QueueTimingOptions; backend: string }
export interface ResolvedProcessConfig { queues: ReadonlyMap<string, ResolvedQueue>; worker: FrameworkWorkerConfig; coordination: CoordinationOptions | undefined }
export function resolveFrameworkConfig(raw: unknown, source: ConfigSource): ResolvedFrameworkConfig; // cached per raw object and source while its top-level values are the same
export function resolveProcessConfig(raw: unknown): ResolvedProcessConfig;                           // cached the same way
export function getResizeConfig(configName?: string): ResolvedFrameworkConfig;                        // default 'resize'
export function getProcessConfig(): ResolvedProcessConfig; // resolveProcessConfig(getApp().getConfig('resize')); an empty result is remembered per app, which is then not asked again (Decision 2)
// src/framework/queue.ts
export function backendKey(section: QueueConfig): string; // 'database', or 'sqs:' + JSON.stringify([region ?? null, endpoint ?? null, deadLetterQueueUrl ?? null, waitTimeSeconds ?? 10])
export function taskQueueOf(queue: ResolvedQueue, processConfig: ResolvedProcessConfig): Promise<TaskQueue>;
// one per backend per process; a failed build is forgotten so the next call retries
//   database: new MongoTaskQueue({ getModel: () => getApp().getModel('ResizeTask'), queues: <names on the backend>, getTiming: (q) => processConfig.queues.get(q)?.timing, logger: appLogger })
//   sqs (imported only when selected, RESIZE_PEER_MISSING otherwise): new SqsTaskQueue({ queues: { <name>: queueUrl, … }, deadLetterQueueUrl, waitTimeSeconds, region, endpoint, getTiming, logger: appLogger })
// src/framework/resizer.ts
interface FrameworkResizerOptions { queueName?: string; /* configName, config?: FrameworkResizeConfig, storage, media, locks, tasks, coordination, logger, events unchanged */ }
// src/framework/worker.ts
export function runResizeWorker(opts?: { queue?: string }): Promise<void>; // reads getProcessConfig().worker; `configName` is gone
```
**Resolution rules.** Where a message below names a file, it reads ``src/config/<name>.ts (or its resize.<NODE_ENV>.ts override)``, since the framework merges that file first.
- **`resolveProcessConfig`**:
  - A non-object raw value is `RESIZE_CONFIG_INVALID`.
  - A `queue` object is `RESIZE_CONFIG_REMOVED_KEY`, with Decision 8's message, so that worker start also catches it.
  - `queues` must be a plain object of non-blank names. Each entry needs `driver` `'database'` or `'sqs'` (`RESIZE_CONFIG_INVALID` ``` `queues.<name>` in src/config/resize.ts (or its resize.<NODE_ENV>.ts override) needs driver 'database' or 'sqs' ```). SQS needs a non-empty `queueUrl`.
  - `queues.<name>.queues` and `queues.<name>.lockTtlMs` are `RESIZE_CONFIG_REMOVED_KEY`.
  - Timing goes through `fillTiming`; its error is rethrown with the same code, the prefix `` `queues.<name>` in src/config/resize.ts: `` and `cause`.
  - Two SQS entries with one `queueUrl` are `RESIZE_CONFIG_INVALID`.
  - `worker` is validated as today (`worker.concurrency` is `RESIZE_CONFIG_REMOVED_KEY`). Without it, `defaultWorkerOptions` apply.
  - `coordination` passes on as it is: the core validates it.
  - Other keys are ignored. This includes `mediaModelName`, which is not required here.
- **`resolveFrameworkConfig`**:
  - The checks for `mediaModelName`, `storage` and the image settings stay as today.
  - `queue` must be `undefined`, `false` or a non-blank string. An object is `RESIZE_CONFIG_REMOVED_KEY` (Decision 8). Anything else is `RESIZE_CONFIG_INVALID`.
  - `queues`, `worker` and `coordination` are skipped when the source is `{ configName: 'resize', explicit: false }`. Anywhere else they are `RESIZE_CONFIG_INVALID`: ``` `<key>` in src/config/<name>.ts (or its resize.<NODE_ENV>.ts override) is process-wide: it is read only from src/config/resize.ts ```. With an explicit config, the message says "in the config passed to new FrameworkResizer()".
- **The core config's removed keys** (`src/resizeConfig.ts`): the `queue` message ends "; framework hosts define each queue in `queues` of src/config/resize.ts", and the `worker` message ends "; framework hosts keep `worker` in src/config/resize.ts".
- **FrameworkResizer at first use**:
  - It passes `queueName` to the core as a function of the file. The `queueName` option, when given, goes as a string, readable at once.
  - With `tasks` from code (a TaskQueue or `false`): `queueName` is `opts.queueName ?? (typeof file.queue === 'string' ? file.queue : 'default')`, and `queues` is never read.
  - Otherwise, the name is `opts.queueName ?? file.queue`:
    - `false` means eager only, with `queueName` `'default'`;
    - `undefined` means `'default'` when `processConfig.queues.size > 0`, and eager only otherwise;
    - a name that is not in `processConfig.queues` throws `RESIZE_CONFIG_QUEUE_UNKNOWN`: ``` resize config: Resizer '<n>' queues to '<name>'[ (the default when <file> sets no `queue`)], which `queues` in src/config/resize.ts does not define — add queues.<name>, set `queue` to a defined name, or queue: false for eager only ```.
  - `tasks` is `taskQueueOf(entry, processConfig)`, where `processConfig` is `getProcessConfig()`.
  - `locks` is a `FrameworkLockStore` only when the task queue has no `gatesByTask` (as today).
  - `coordination` is `opts.coordination ?? processConfig.coordination ?? {}`, read as a function.
  - The class no longer overrides `verify()`.
- **Worker**:
  - `runResizeWorker` reads `worker` from the process config. The disabled message names `src/config/resize.ts`.
  - `ResizeWorker` keeps the `config` argument declared, so the CLI parser accepts it. When it is given, `run()` throws `ResizeConfigError` `RESIZE_CONFIG_REMOVED_KEY`: ``resize worker: `--config` is removed — the worker reads `worker` and `queues` from src/config/resize.ts``.
- **Scaffold**:
  - `resize.config.ts.tpl` holds, in order:
    - the spread `defaultFrameworkResizeConfig`;
    - the per-Resizer sections: `mediaModelName`, `storage`, `queue: 'default'`;
    - a comment line "process-wide sections, read only from this file";
    - `queues: { default: { driver: 'database' } }`, with the index note and `// or { driver: 'sqs', queueUrl: '…' }`;
    - the commented `coordination` line;
    - `worker: { ...defaultWorkerOptions, enabled: false }`;
    - `satisfies FrameworkResizeConfig`, with the comment "a resize.ts that holds only the process-wide sections (no default Resizer) writes `satisfies Partial<FrameworkResizeConfig>`".
  - No line of either template matches Decision 17's patterns, comments included.
  - The eager template has no `queues`. Its closing comment says to add `queues: { default: { driver: 'database' } }` after re-running without `--eager`.
  - The `CONFIG` check item gets `validate` (Decision 17), and this hint: ``` uses the old config shape — define each queue once as queues: { default: { driver: 'database' } }, set queue: 'default' (a name), and import defaultFrameworkResizeConfig and defaultWorkerOptions from @adaptivestone/framework-module-resize/framework.js (CHANGELOG 0.3.0); or move the file aside, re-run resize-scaffold and copy your settings back ```.
  - `USAGE` and the next-step lines name `queues` and `worker.enabled`.

- [ ] **Step 1: Write the failing tests.**
```ts
// src/config/resize.test.ts
test('queues entries need a driver; an SQS entry needs queueUrl', …)
test('queues.<name>.lockTtlMs and queues.<name>.queues are RESIZE_CONFIG_REMOVED_KEY naming the entry', …)
test("a queue entry's invalid timing names the entry and keeps the timing code", …)            // queues.bulk.leaseMs 0 → RESIZE_CONFIG_QUEUE_LEASE_INVALID, message /queues\.bulk/
test('two SQS entries with one queueUrl are RESIZE_CONFIG_INVALID', …)
test('resize.ts with only process-wide sections resolves without mediaModelName', …)
test('a missing resize.ts means no queues, the default worker and no coordination, and is asked for once', …) // getConfig('resize') → a new {} each call; three getProcessConfig() calls → one getConfig call
test('queues, worker or coordination in another file, or in an explicit config, is RESIZE_CONFIG_INVALID naming the key and the override', …) // message /resize\.<NODE_ENV>\.ts/
test("a Resizer file's queue must be a name or false", …)                                       // 3 → RESIZE_CONFIG_INVALID
test("the core config's removed queue and worker keys point framework hosts at src/config/resize.ts", …)
// src/framework/resizer.test.ts
test('two Resizers on two database queue names share one task queue; each name keeps its timing and lane', …) // Review Focus 1
  // resize: makeResizeConfig({ queues: { default: { driver: 'database' }, bulk: { driver: 'database', leaseMs: 30_000 } } }); listings: makeResizeConfig({ queue: 'bulk' })
  // a = new FrameworkResizer(); b = new FrameworkResizer({ name: 'listings', configName: 'listings' }); await a.ready(); await b.ready()
  // a.tasks === b.tasks; a.queueName 'default'; b.queueName 'bulk'; tasks.servesQueue('bulk') true, ('nope') false
  // timingOf(tasks, 'bulk').leaseMs 30_000; timingOf(tasks, 'default').leaseMs 60_000
test("prewarm({ queue }) naming a queue on another backend reports RESIZE_QUEUE_NOT_SERVED and touches no queue", …) // Review Focus 2
  // queues: { default: { driver: 'database' }, bulk: { driver: 'sqs', queueUrl: 'https://sqs.example/bulk' } }; a media with an original
  // prewarm({ media, sizes, queue: 'bulk' }) → issues[0] { code: 'RESIZE_QUEUE_NOT_SERVED', retryable: false }; getModel('ResizeTask') never asked; the SQS driver never imported (no RESIZE_PEER_MISSING)
test('an old-shape queue section fails first use, verify() and worker start with RESIZE_CONFIG_REMOVED_KEY; resolve() still never throws', …) // Review Focus 3
  // resize: { ...makeResizeConfig(), queue: { driver: 'database' } }
  // verify() rejects: code 'RESIZE_CONFIG_REMOVED_KEY', message /queues: \{ default: \{ driver: 'database'/ and /queue: 'default'/
  // resolve({ media, sizes }) resolves; runResizeWorker() rejects with the same code
test("a file without queue uses 'default'; without a 'default' entry that is RESIZE_CONFIG_QUEUE_UNKNOWN", …)
test('without queues a Resizer is eager only; queue: false is eager only beside queues', …)
test('tasks from code never read queues: an undefined queue name in the file is no error', …)
test('a queueName option is readable before first use; a name from the file is RESIZE_NOT_READY until then', …)
test('SQS entries with the same connection settings share one SqsTaskQueue; a different dead-letter queue is another backend', …)
test("resize.ts's coordination reaches every Resizer; the option wins", …)
test('resetResizerForTests forgets the per-backend task queues', …) // rewritten from :916
// src/framework/worker.test.ts / ResizeWorkerCommand.test.ts
test('the worker reads worker from resize.ts, whatever file its Resizers read', …)
test('--config is RESIZE_CONFIG_REMOVED_KEY', …)
// src/framework/scaffold/command.test.ts — Review Focus 3, the scaffold half
test('--check reports an old-shape config as drift with the migration hint', …)
  // scaffold; overwrite src/config/resize.ts with `queue: { driver: 'database' }` and the …/config/resize.js import → --check exits 1; output has 'drift' and 'queues: { default'
test('a fresh scaffold passes --check; a commented-out old line is no drift', …)
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/config/resize.test.ts src/framework/resizer.test.ts src/framework/worker.test.ts src/framework/ResizeWorkerCommand.test.ts src/framework/scaffold/command.test.ts`. Expected: FAIL, because `queues` is unknown and `queue` must be an object.
- [ ] **Step 3: Implement the types, the two resolvers, `taskQueueOf`, the FrameworkResizer wiring, the worker, the command, the templates and `--check`, as the Interfaces and rules above say.**
  - Delete `queueUsers`, `addQueueUser`, `backendTiming`, `checkQueueUser`, `sharedQueue`, `appTaskQueue` and `RESIZE_CONFIG_QUEUE_TIMING_CONFLICT`.
  - Move every framework test, integration test and `CHECK_TYPES` config to the new shape. `CHECK_TYPES`:
    - types a second Resizer's file with `satisfies FrameworkResizeConfig`;
    - adds the production override `{ queues: { default: { driver: 'sqs', queueUrl: 'https://sqs.example/resize', maxAttempts: 3 } } } satisfies Partial<FrameworkResizeConfig>`;
    - adds a process-only `resize.ts`, `{ queues: { bulk: { driver: 'database' } }, worker: { ...defaultWorkerOptions, enabled: true } } satisfies Partial<FrameworkResizeConfig>`;
    - imports `type QueueConfig` from the main entry and types one entry with it.
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke && node --experimental-strip-types --test src/config/resize.framework.integration.test.ts`. Expected: PASS. `grep -rn "TIMING_CONFLICT\|addQueueUser\|backendTiming\|Framework\(Database\|Sqs\)\?QueueConfig" src` prints nothing.
- [ ] **Step 5: Commit.** One command per line:
  - `git add -A src smokeTest.ts`
  - `git commit -m "feat!: named queues in src/config/resize.ts; queue is a name; worker and coordination are process-wide"`

### Task 6: Preview rows record `bytes`, `createdAt`, `origin` and `encodeSig`

**Files:**
- Create: `src/signatures.ts`, `src/signatures.test.ts`
- Modify:
  - `src/types.d.ts:69-84`;
  - `src/contracts/pipeline.ts`;
  - `src/processor.ts:436, 700-760, 778-785`;
  - `src/drivers/mongo/mediaFragment.ts`: the four fields, and the usage comment, which now imports from `…/framework.js`;
  - `src/drivers/mongo/media.ts:58-85`.
- Test: `src/signatures.test.ts`, `src/processor.test.ts`, `src/reader.test.ts`, `src/drivers/mongo/mediaFragment.test.ts`, `src/drivers/mongo/media.mongo.integration.test.ts`, `src/framework/stores.test.ts`. Also every test that deep-compares stored or created rows.

**Interfaces:**
Produces:
```ts
// src/signatures.ts (pure; node:crypto and ./images.ts only)
export function canonicalJson(value: object): string;                                         // JSON.stringify(canonicalizeFilterValue(JSON.parse(JSON.stringify(value))))
export function previewOrigin(storageRef: StorageRef, dims: { width: number; height: number }): string; // sha256 hex of canonicalJson({ storageRef, width, height }), first 16
export function encodeSignature(config: ResizeConfig, row: { format: string; fit: boolean; version?: string }): string;
// sha256 hex, first 16, of canonicalJson({ format, encode: config.encode.formats[format] ?? {}, sharpen: config.encode.sharpen,
//   flatten: config.encode.flatten.formats.includes(format) ? config.encode.flatten.background : null,
//   maxSize: fit ? config.maxSize : null, resultDimension: config.limits.resultDimension,
//   animated: ANIMATED_FORMATS.includes(format) ? config.animated : null, version: version ?? null })
// const ANIMATED_FORMATS: readonly string[] = Object.freeze(['gif', 'webp']); — a deliberate frozen copy of the set behind
// isAnimatedFormat (src/helpers/imageFormat.ts), not an import: it is part of the recipe. Its comment says so: if Sharp later
// animates another format, isAnimatedFormat may grow, but the stored signatures of that format's rows must not change.
// src/types.d.ts — Preview gains
bytes?: number;     // the encoded preview's size
createdAt?: Date;   // when the preview was stored
origin?: string;    // previewOrigin of the original it was made from
encodeSig?: string; // encodeSignature of its format, settings and pipeline version
// src/contracts/pipeline.ts
version?: string;   // bump it to regenerate this pipeline's previews (from S5 on); part of encodeSig
```
**Decision:**
- Before it builds any row, the Processor computes the dimensions the media will hold: `{ width: dispW, height: dispH }` when `original.width` or `original.height` is missing, else the stored pair. The same value feeds `origin`, and, when persisting, `backfillDims`. This holds with persist on or off.
- `origin = previewOrigin(original.storageRef, dims)`, once per call.
- `encodeSig = encodeSignature(config, { format: v.format, fit: v.fit === true, version: pipeline.version })`, per variant.
- `bytes = data.length`, and `createdAt = new Date()`, set when the row is built.
- `generate()` and tasks get the same rows.
- `MongoMediaStore.verify()` names every missing path among `identity`, `origin` and `encodeSig` in the existing `RESIZE_MONGO_MEDIA_MODEL_OUTDATED` message.

- [ ] **Step 1: Write the failing tests.**
```ts
// src/signatures.test.ts — the fixed vectors S5 compares against
const ref = { key: 'originals/a1b2c3.jpg', visibility: 'private' };
test('canonicalJson sorts keys at every depth and drops undefined', …)
  // canonicalJson({ width: 4000, storageRef: ref, height: 3000 }) === '{"height":3000,"storageRef":{"key":"originals/a1b2c3.jpg","visibility":"private"},"width":4000}'
test('previewOrigin vectors', …)
  // previewOrigin(ref, { width: 4000, height: 3000 }) === '8c64760b02a9f12a'
  // previewOrigin({ visibility: 'private', key: 'originals/a1b2c3.jpg' }, { width: 4000, height: 3000 }) === '8c64760b02a9f12a'
  // previewOrigin(ref, { width: 3000, height: 4000 }) === '85fe58ff22d3ce0c'
  // previewOrigin({ key: 'originals/ffff.jpg', visibility: 'private' }, { width: 4000, height: 3000 }) === 'bda63bc43f25605a'
test('encodeSignature vectors on the default config', …)   // c = makeImageConfig(); version undefined unless named
  // the recipe itself, written out: sha256 hex, first 16, of these two strings equals encodeSignature(c, { format: 'jpeg', fit: false }) and (c, { format: 'webp', fit: true })
  //   '{"animated":null,"encode":{"chromaSubsampling":"4:2:0","mozjpeg":true,"quality":88},"flatten":"#ffffff","format":"jpeg","maxSize":null,"resultDimension":5000,"sharpen":{"cover":true,"fit":false},"version":null}'
  //   '{"animated":false,"encode":{"effort":4,"quality":82},"flatten":null,"format":"webp","maxSize":{"height":1200,"width":2000},"resultDimension":5000,"sharpen":{"cover":true,"fit":false},"version":null}'
  // jpeg cover 'c2e290f0d33595ae'; jpeg fit 'a20802f7b8adab7b'; webp cover 'a1505869c88e3331'; webp fit 'da2a7b4a2a82233e'
  // avif cover '2ff643ff6cb17b14'; avif fit '2c25efc6c41f5489'; gif cover (no encode entry) '4b5afbc181b0a5dc'; webp cover version 'v2' 'caa8e1b8ce43acc3'
test('encodeSignature changes only for the rows an input affects', …)
  // webp quality 70 → webp cover 'cb56c7fdee932190'; webp options { effort: 4, quality: 82 } (keys reordered) → 'a1505869c88e3331'
  // flatten.formats ['jpeg', 'webp'] → jpeg cover still 'c2e290f0d33595ae', webp cover 'ffd051bf0e215efb'
  // animated true → jpeg cover still 'c2e290f0d33595ae', avif cover still '2ff643ff6cb17b14', webp cover '8087ac9f83544054', gif cover 'cdc6e9d0d37ea008'
  // maxSize { width: 2400, height: 1600 } → jpeg cover still 'c2e290f0d33595ae', jpeg fit 'da288ee14dfbf632'
  // sharpen { cover: true, fit: true } → jpeg cover 'd49191720a3eb059' (the whole sharpen object counts for every row)
// src/processor.test.ts
test('generate writes bytes, createdAt, origin and encodeSig on every row', …)
  // the uploaded body's length === row.bytes; row.createdAt instanceof Date and within the call; row.origin === previewOrigin(original.storageRef, { width, height }); row.encodeSig === encodeSignature(config, { format: row.format, fit: row.fit === true, version: undefined })
test("origin uses the measured dimensions when the original lacks them, with persist on or off", …) // generate({ persist: false }) and a task on the same media write the same origin
test("a pipeline's version reaches encodeSig", …)                  // pipelines: { wm: { version: 'v2' } } → encodeSignature(config, { format: 'webp', fit: false, version: 'v2' })
test('a task treats rows written before this version as stored and renders nothing for them', …) // Review Focus 4, worker half: rows without the four fields → no upload
// src/reader.test.ts — Review Focus 4, read half
test('rows without bytes, createdAt, origin or encodeSig are served, and nothing is queued', …)
// src/drivers/mongo/media.mongo.integration.test.ts
test('the fragment stores the four fields; createdAt comes back as a Date', …)
test("origin recomputed from a loaded media equals the stored row's", …)
  // original.storageRef { key: 'originals/x.jpg', meta: {} } saved and loaded → previewOrigin(loaded.original.storageRef, { width, height }) === row.origin; the empty object survives (minimize: false)
test('strict preview rows without origin or encodeSig are RESIZE_MONGO_MEDIA_MODEL_OUTDATED naming them', …)
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/signatures.test.ts src/processor.test.ts src/reader.test.ts src/drivers/mongo/media.mongo.integration.test.ts`. Expected: FAIL with "Cannot find module './signatures.ts'".
- [ ] **Step 3: Implement `src/signatures.ts`, the fields, `Pipeline.version`, the Processor writes, the fragment fields (`bytes: { type: Number }`, `createdAt: { type: Date }`, `origin: { type: String }`, `encodeSig: { type: String }`) and the verify check.** Where a test deep-compares rows, compare without the four fields and assert them on their own.
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS.
- [ ] **Step 5: Commit.** One command per line:
  - `git add -A src`
  - `git commit -m "feat!: preview rows record bytes, createdAt, origin and encodeSig; Pipeline.version"`

### Task 7: `MediaStore.replacePreviews`

**Files:**
- Modify:
  - `src/contracts/media.ts`;
  - `src/drivers/mongo/media.ts:15-33` and a new method;
  - `src/testHelpers/fakes.ts:100-130` and `src/testHelpers/contractShapes.ts:37-60`;
  - `src/index.ts` (type export);
  - `smokeTest.ts:186-200, 290-305`: every plain media object and media class gains `replacePreviews`.
- Test: `src/drivers/mongo/media.mongo.integration.test.ts`, `src/testHelpers/fakes.test.ts`, `src/framework/stores.test.ts`

**Interfaces:**
Produces:
```ts
// src/contracts/media.ts
export interface ReplacedPreviews { stored: Preview[]; removed: Preview[] }
export abstract class MediaStore {
  /**
   * In one atomic step per media: remove every stored row whose `identity` is in `identities` or is the identity of one of
   * `rows`, then store `rows`. A row without a stored `identity` is never removed. Resolves with the rows it stored and the
   * rows it removed, as plain objects; a media that is gone gives { stored: [], removed: [] }. It takes no dimensions: a
   * caller that must backfill them uses appendPreviews(mediaId, [], dims), which writes them whether or not it stores a row.
   */
  abstract replacePreviews(mediaId: string, identities: string[], rows: Preview[]): Promise<ReplacedPreviews>;
}
// src/drivers/mongo/media.ts
export interface MongoMediaUpdateOptions { projection: Record<string, 1>; returnDocument?: 'before' | 'after'; updatePipeline?: boolean; lean?: boolean }
export interface MongoMediaModel {
  modelName?: string; findById(id: string): PromiseLike<unknown>;
  findOneAndUpdate(filter: object, update: object | object[], options: MongoMediaUpdateOptions): PromiseLike<unknown>;
  castObject?(doc: { previews: Preview[] }): { previews?: unknown[] }; // Mongoose's Model.castObject: cast to the schema, no write
}
// src/testHelpers/fakes.ts — fakeMedia parts gain replacePreviews?: MediaStore['replacePreviews']; the default one follows the contract on its `previews` map
```
**The Mongo write** (measured on mongoose 9.11.4: Mongoose 9 refuses an update pipeline without `updatePipeline: true`; `castObject` drops undeclared keys of strict rows and casts values; `lean: true` returns a plain pre-image):
```ts
const unique = <rows, keeping the first row per identity, each without its undefined-valued keys>;
const written = model.castObject ? model.castObject({ previews: unique }).previews ?? [] : unique;
const remove = [...new Set([...identities, ...rowIdentities])];
const update = [{ $set: { previews: { $concatArrays: [
  { $filter: { input: { $ifNull: ['$previews', []] }, cond: { $not: [{ $in: ['$$this.identity', remove] }] } } },
  { $literal: written } ] } } }];
const before = await model.findOneAndUpdate({ _id: mediaId }, update, { projection: { previews: 1 }, returnDocument: 'before', updatePipeline: true, lean: true });
// before === null → { stored: [], removed: [] }; removed = before.previews whose identity is in `remove`; stored = written
```
- Mongoose does not cast an update pipeline itself, and the driver would store an `undefined` value as `null`. So `undefined` keys are dropped first, then the rows are cast when the model has `castObject`. On a strict row schema, `castObject` drops undeclared keys and casts values (`bytes: '12'` → `12`); on a mixed `previews` array it keeps every key, as `appendPreviews` does.
- Dates stay Dates.
- Rows written this way get no sub-document `_id`; nothing reads it.
- A `findOneAndUpdate` middleware on the media model runs once per call. It sees an array (update-pipeline) update, and the result is the pre-image projected on `previews`.

- [ ] **Step 1: Write the failing tests.**
```ts
// src/drivers/mongo/media.mongo.integration.test.ts (the fragment's model)
test('replacePreviews swaps rows by identity in one write and returns what it removed, as plain objects', …)
  // rows: legacy (no identity, ref x0), a (ref a1), b (ref b1); replacePreviews(id, ['zzz'], [a' (ref a9, createdAt Date)])
  // → removed: [a1 row], Object.getPrototypeOf(removed[0]) === Object.prototype; stored: [a']
  // collection previews: x0, b1, a9 (in that order); a9's createdAt is a Date; no key holds null
test('replacePreviews stores what appendPreviews would on a strict schema', …)
  // a strict row schema without `origin`: a row with origin and bytes '12' → the stored row has no origin and bytes 12
test('replacePreviews with empty rows only removes', …)                     // (id, ['a', 'b'], []) → removed a1, b1; legacy x0 stays
test('replacePreviews on a media that is gone resolves with two empty lists', …)
test('concurrent replacePreviews of one identity leave one row', …)          // Promise.all of two replacements of 'a' → one 'a' row
// src/framework/stores.test.ts
test('FrameworkMediaStore.replacePreviews sends one update pipeline with returnDocument before', …)
  // a recording fake model: 1 call, options deepEqual { projection: { previews: 1 }, returnDocument: 'before', updatePipeline: true, lean: true }
test('a model without castObject gets the rows as given, minus undefined keys', …)
// src/testHelpers/fakes.test.ts
test("fakeMedia's replacePreviews follows the contract", …)
```
  - `src/testHelpers/contractShapes.ts` gains `replacePreviews: async () => ({ stored: [], removed: [] })` on every media shape, plus:
```ts
export const oldMedia: MediaStore = {
  loadMedia: async () => null,
  appendPreviews: async (_id, previews) => previews,
  // @ts-expect-error — replacePreviews resolves with { stored, removed }, never with the stored rows alone.
  replacePreviews: async (_id, _identities, rows) => rows,
};
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `npm run types:check`, then `node --experimental-strip-types --test src/drivers/mongo/media.mongo.integration.test.ts src/framework/stores.test.ts src/testHelpers/fakes.test.ts`. Expected: FAIL. The type check reports TS2353 for `replacePreviews` on the plain media shapes, because the contract has no such member yet, and the tests find no `replacePreviews`.
- [ ] **Step 3: Implement the contract, the Mongo method, the fakes and the smoke shapes.** Export `type ReplacedPreviews` from `src/index.ts`. The class doc of `MediaStore` says that `appendPreviews` and `replacePreviews` keep one row per identity.
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS.
- [ ] **Step 5: Commit.** One command per line:
  - `git add -A src smokeTest.ts`
  - `git commit -m "feat!: MediaStore.replacePreviews swaps preview rows by identity in one write"`

### Task 8: `resizer.invalidate`

**Files:**
- Modify:
  - `src/processor.ts` (new method);
  - `src/resizer.ts`: the facade, after `generate`, and the `replacePreviews` check in `verify()`;
  - `src/types.d.ts` (`InvalidateOpts`);
  - `src/index.ts` (type export);
  - `smokeTest.ts`: `CHECK_TYPES` calls `invalidate` in the never-run construction site.
- Test: `src/processor.test.ts` (or a new `src/invalidate.test.ts`), `src/resizer.test.ts`, `src/drivers/mongo/frameworkFree.integration.test.ts`

**Interfaces:**
Consumes: `MediaStore.replacePreviews`, `ReplacedPreviews` (Task 7); `previewScope`, `requireMediaId` (`src/images.ts`).
Produces:
```ts
// src/types.d.ts
export interface InvalidateOpts { media: MediaLike; pipeline?: string } // pipeline: only its rows; default: every pipeline of this Resizer
// src/processor.ts
invalidate(opts: InvalidateOpts): Promise<StorageRef[]>;
// src/resizer.ts
/**
 * Remove this Resizer's stored previews of `media` (one pipeline, or all) and resolve with their storage refs, for the host
 * to delete. It takes no gate: a task running for this media can still store rows after it returns, and a row stored
 * between its read and its write with a new identity stays; the refs are exactly the rows the write removed.
 */
async invalidate(opts: InvalidateOpts): Promise<StorageRef[]> // (await this.#services()).processor.invalidate(opts)
// verify(): typeof this.media.replacePreviews !== 'function' → ResizeSetupError RESIZE_MEDIA_REPLACE_MISSING (after media.verify?.())
```
**Behaviour (Decision 15):**
1. `requireMediaId(media)`.
2. `loadMedia(id)`. A `null` result resolves with `[]`.
3. Pick the rows with a string `identity` whose `previewScope(row).resizer` is this Resizer's name and, when `pipeline` is given, whose `previewScope(row).pipeline` is that pipeline. When none match, resolve with `[]` without a write.
4. A store without a `replacePreviews` function is `ResizeSetupError` `RESIZE_MEDIA_REPLACE_MISSING`: ``resize: the media store has no replacePreviews(mediaId, identities, rows) — a custom MediaStore needs it since 0.3.0``. The same message comes from `verify()`.
5. `replacePreviews(id, identities, [])`. A result without two arrays is `RESIZE_MEDIA_REPLACE_RESULT_INVALID`.
6. Remove those identities from `opts.media.previews` when it is an array.
7. Resolve with `removed.map((row) => row.storageRef)`.

- Store errors reject as they are.
- There is no pipeline-registration check, so cleaning up after a rename works.
- `#services()` builds the Processor without a task queue, so `invalidate` works on an eager-only Resizer.

- [ ] **Step 1: Write the failing tests.**
```ts
// Review Focus 5 — fakeMedia seeded with: default/default rows d1, d2; default/wm row w1; listings/default row l1; a row without identity x0
test('invalidate with a pipeline removes only that pipeline of this Resizer and returns their refs', …)
  // invalidate({ media, pipeline: 'wm' }) deepEqual [w1.storageRef]; the store keeps d1, d2, l1, x0
test("invalidate without a pipeline removes every pipeline of this Resizer, never another Resizer's rows or rows without an identity", …)
  // deepEqual [d1, d2, w1 refs]; the store keeps l1, x0; media.previews in memory keeps only l1, x0
test('invalidate on a media that is gone, or with nothing in scope, resolves with [] and writes nothing', …)
test('a store without replacePreviews is RESIZE_MEDIA_REPLACE_MISSING; a wrong result is RESIZE_MEDIA_REPLACE_RESULT_INVALID', …)
test('a store failure rejects as it is', …)
test('invalidate works on an eager-only Resizer and for an unregistered pipeline', …)
// src/resizer.test.ts
test('verify() rejects a media store without replacePreviews', …)  // code RESIZE_MEDIA_REPLACE_MISSING
// src/drivers/mongo/frameworkFree.integration.test.ts
test('invalidate on MongoDB removes one pipeline in one write; the next resolve queues it again', …)
  // generate default and wm rows; invalidate({ media, pipeline: 'wm' }) → the wm refs; the collection keeps the default rows; resolve(pipeline 'wm') → decision.missing = the wm sizes, one task added
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/processor.test.ts src/resizer.test.ts src/drivers/mongo/frameworkFree.integration.test.ts`. Expected: FAIL with "resizer.invalidate is not a function".
- [ ] **Step 3: Implement `Processor.invalidate`, the facade with its doc comment, and the `verify()` check, as the behaviour above says.** Export `type InvalidateOpts` from `src/index.ts`.
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS.
- [ ] **Step 5: Commit.** One command per line:
  - `git add -A src smokeTest.ts`
  - `git commit -m "feat: resizer.invalidate removes a media's previews and returns their storage refs"`

### Task 9: Task rows record `startedAt` and `finishedAt`

**Files:**
- Modify:
  - `src/drivers/mongo/schemas.ts:40-52`;
  - `src/drivers/mongo/taskQueue.ts:52-70` (comment only), `:253-330`;
  - `src/framework/scaffold/templates/ResizeTask.model.full.ts.tpl:60-70`;
  - `src/framework/scaffold/command.ts:41-47, 173`.
- Test: `src/drivers/mongo/taskQueue.test.ts`, `src/framework/ResizeTaskModel.test.ts`, `src/framework/scaffold/command.test.ts`

**Interfaces:**
Produces:
- `resizeTaskFields()` gains `startedAt: { type: Date }` and `finishedAt: { type: Date }`, and so does the ejected template.
- Every `claim` sets `startedAt: now`: the latest delivery's start.
- `complete` sets `finishedAt` (equal to `completedAt`), and `fail('dead')` sets `finishedAt` (equal to `deadAt`).
- A retry and `release` leave both alone.
- `WRITTEN_PATHS` stays as it is. Its comment says it lists the paths the gate and the lease need (Decision 16).
- `EJECTED_MODEL_FIELDS` gains `/\bstartedAt:\s*\{\s*type:/` and `/\bfinishedAt:\s*\{\s*type:/`. The hint's field list gains both.
- The indexes are unchanged.

- [ ] **Step 1: Write the failing tests.**
```ts
// src/drivers/mongo/taskQueue.test.ts
test('claim sets startedAt; a second delivery sets it again', …)
test('complete and a dead-letter set finishedAt; a retry and a release do not', …)
test('a strict model without startedAt and finishedAt still verifies and completes tasks', …) // the times are dropped; no RESIZE_MONGO_MODEL_OUTDATED
// src/framework/ResizeTaskModel.test.ts
test('the package model declares startedAt and finishedAt', …)
// src/framework/scaffold/command.test.ts
test('--check reports an ejected model without startedAt or finishedAt as drift naming them; the --eject template passes', …)
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/drivers/mongo/taskQueue.test.ts src/framework/ResizeTaskModel.test.ts src/framework/scaffold/command.test.ts`. Expected: FAIL, because `startedAt` is undefined.
- [ ] **Step 3: Implement the writes, the fields, the template and the check.**
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** One command per line:
  - `git add -A src`
  - `git commit -m "feat: ResizeTask rows record startedAt and finishedAt"`

### Task 10: Documentation and the `0.3.0-rc.1` prerelease

**Files:**
- Modify:
  - `package.json` and `package-lock.json` (version);
  - `CHANGELOG.md` (`# 0.3.0`);
  - `README.md`: sections at 48, 133, 206-218, 219, 442-523, 524, 588, 649, plus lines 40, 112, 127, 250, 256, 297-300, 345, 506;
  - `AGENTS.md`: the header; steps 3, 5, 6, 7 and 8; Use; Rules; Troubleshooting; plus lines 126, 147, 155, 159, 217 and the Troubleshooting rows 411, 413, 417, 419, 420, 421, 422, 428, 430, 433 and 437;
  - `RELEASE.md` §2–§4;
  - `docs/host-adoption.md:30-126`;
  - `/Users/andrey/Work/framework-documenation-github/docs/12-resize.md` (another repository).
- Test: `src/agentsDoc.test.ts`

**Interfaces:** Consumes every public name above:
- `queues`, `queue` as a name, `queueName`;
- `FrameworkResizeConfig` in every file, and `QueueConfig`, `DatabaseQueueConfig`, `SqsQueueConfig`;
- the fragment at `…/drivers/mongo.js` / `…/framework.js`;
- `defaultFrameworkResizeConfig` and `defaultWorkerOptions` at `…/framework.js`;
- `Preview.bytes`, `createdAt`, `origin`, `encodeSig`, and `Pipeline.version`;
- `ResizeTask.startedAt`, `finishedAt`;
- `MediaStore.replacePreviews`, `ReplacedPreviews`;
- `resizer.invalidate`, `InvalidateOpts`;
- the error codes in Global Constraints.

**What every host document must say** (CHANGELOG **Breaking changes**, host-adoption, and the AGENTS Troubleshooting rows):
1. **`resize-scaffold --check` reports drift right after the upgrade.** It does so for every config scaffolded before 0.3.0, and for every ejected `ResizeTask` model. This is intended. To clear it:
   - rewrite `src/config/resize.ts` to the new shape, or move it aside, re-run `npx resize-scaffold` and copy the settings back;
   - add `startedAt` and `finishedAt` to an ejected model, or re-run `--eject`.
   This corrects AGENTS.md:394 and :428, and README.md:127.
2. **A custom model-shaped `MongoMediaModel` must accept an update pipeline.** That means `findOneAndUpdate` with an array update and `{ updatePipeline: true, returnDocument: 'before', lean: true, projection: { previews: 1 } }`, plus an optional `castObject`. A `findOneAndUpdate` middleware also sees that kind of call. This corrects docs/host-adoption.md:77-81 and README.md:297-300.
3. **`runResizeWorker({ configName })` is removed**, together with `--config`.
4. **`resizer.queue` is gone; use `queueName`.**
   - A string `queueName` option is readable at once.
   - A name from the config file is known only after `ready()` or the first call; before that, `resizer.queueName` throws `RESIZE_NOT_READY`.
5. **Mixed backends from an environment override.** Moving only some queues to another backend in `resize.<NODE_ENV>.ts` splits them in that environment: those calls fail with `RESIZE_QUEUE_NOT_SERVED` there. So move a Resizer's queues together until S4. The same goes for SQS entries with different dead-letter queues.
6. **Old preview rows.**
   - Rows written before rc.1 (no `origin` or `encodeSig`) are served for now. They will regenerate once S5's freshness check ships, so plan the storage cost.
   - Rows without an `identity` are never removed by `invalidate` or `replacePreviews`; the host deletes their files itself.

- [ ] **Step 1: Set the version.** Run `npm version 0.3.0-rc.1 --no-git-tag-version`. Expected: `package.json` and `package-lock.json` read `0.3.0-rc.1`.
- [ ] **Step 2: Update CHANGELOG.md.**
  - Keep `# 0.3.0` as the release in progress. Under it, add a **Prereleases** note:
    - `0.3.0-rc.1`: the host-facing shapes of this phase;
    - `0.3.0-rc.2`: the new pipeline-step signature;
    - later rcs: internal changes that need no host change.
  - Add to **Breaking changes**:
    - the `queues` shape and the migration from `queue: { … }`, including the second-file change and `queues.<n>.queues`;
    - process-wide `worker` and `coordination`;
    - `--config` and `runResizeWorker({ configName })` removed;
    - `RESIZE_CONFIG_QUEUE_TIMING_CONFLICT` removed;
    - `queueName`, and `resizer.queue` gone;
    - the queue entry types renamed to `QueueConfig`, `DatabaseQueueConfig` and `SqsQueueConfig`;
    - the two import moves;
    - `defaultFrameworkResizeConfig` without `worker` and `coordination`;
    - `MediaStore.replacePreviews` required, and checked by `verify()`;
    - the update-pipeline call on the media model;
    - strict media rows need `origin` and `encodeSig`;
    - `RESIZE_QUEUE_NOT_SERVED` for a call on a queue of another backend or an unknown queue name; on SQS this replaces the logged `RESIZE_SQS_QUEUE_UNKNOWN` and the issue `RESIZE_ENQUEUE_QUEUE_FAILED`;
    - the SQS `queueUrl` relaxation;
    - the six statements above.
  - Add to **Features**: `invalidate`; the four preview fields; `Pipeline.version`; `startedAt` / `finishedAt`; per-queue timing.
  - Add this paragraph, worded as future: "In `0.3.0-rc.2`, both `beforeSteps` and `variantSteps` will receive and return a `Raster` (raw pixels plus their info), with the helpers `rasterToSharp` and `sharpToRaster`, because the image engine becomes replaceable. Hosts that write steps now should expect that signature."
- [ ] **Step 3: Update README.md.**
  - Install table (40): the SQS row as a `queues` entry.
  - Quick start, and the framework config file (491–515): the new template, `queue: 'default'`, `queues`, the process-wide sections, and the second-file example with `queue: 'bulk'`, typed `FrameworkResizeConfig`. A `resize.ts` that holds only process-wide sections, and an environment override, are typed `Partial<FrameworkResizeConfig>`.
  - Delete the timing-conflict paragraph (~467) and the `--config` text.
  - Lines 112, 127, 250, 256, 345 and 506: the `queue` section, the timing it passes, and `--check` after the upgrade (statement 1).
  - Package exports (206–218): the fragment, `defaultFrameworkResizeConfig` and `defaultWorkerOptions` paths; `…/config/resize.js` holds only the core defaults; the queue entry types.
  - Drivers (219), 297–300: `MongoTaskQueue` `queues` and per-name `getTiming`; `SqsTaskQueue` `queueUrl` optional beside `queues`; `MediaStore.replacePreviews` in the custom-store contract (rows are cast to the model's schema, the update pipeline, no gate); statement 2.
  - Config reference: per-queue timing; `queueName` and when it is readable; `Pipeline.version`; statement 5.
  - Operations (588): the preview fields, the task times, `invalidate` with the host deleting the returned refs, and statement 6.
  - prewarm issues (649): the `RESIZE_QUEUE_NOT_SERVED` row, and in the `RESIZE_ENQUEUE_INTERNAL_ERROR` row an invalid timing of the call's queue.
- [ ] **Step 4: Update AGENTS.md.**
  - Header: "one TaskQueue per backend; each name is a lane".
  - Step 3: the `queueName` option and when it is readable.
  - Step 4 (126): the `queues` entry, not the `queue` section.
  - Step 5 (147, 155, 159): the `queues`, `queue`, `worker` and `coordination` rules; one `coordination` per process; no `--config`; the second-file shape; `satisfies FrameworkResizeConfig` in every file, and `Partial<FrameworkResizeConfig>` for a process-only `resize.ts` and for an environment override; statement 5.
  - Step 6: fragment import, the four preview fields and the strict-row rule.
  - Step 7: the ejected model's `startedAt` / `finishedAt`.
  - Step 8 (217): `queues: { default: { driver: 'database' } }` and `worker.enabled` in `src/config/resize.ts`.
  - Use: an `invalidate` snippet, `replacePreviews` for custom stores, and statements 2 and 6.
  - Troubleshooting:
    - delete the `RESIZE_CONFIG_QUEUE_TIMING_CONFLICT` row;
    - add rows for `RESIZE_CONFIG_QUEUE_UNKNOWN`, `RESIZE_QUEUE_NOT_SERVED` (as a prewarm issue), `RESIZE_MEDIA_REPLACE_MISSING` and `RESIZE_MEDIA_REPLACE_RESULT_INVALID`;
    - reword these rows (line numbers as of `dbc9780`):
      - 411, `RESIZE_NAME_INVALID` / `RESIZE_QUEUE_INVALID`: the `queueName` option, and the old `queue` option;
      - 413, `RESIZE_CONFIG_QUEUE_INVALID` / `RESIZE_CONFIG_QUEUE_LEASE_INVALID`: the key is in `queues.<name>` of `src/config/resize.ts`; a per-call queue's invalid timing on a task queue from code is reported by that call's `prewarm()`;
      - 417, `RESIZE_CONFIG_INVALID`: the `queues` map and its entries, a duplicate SQS `queueUrl`, a `queue` that is not a name or `false`, and a process-wide section outside `src/config/resize.ts`;
      - 419, `RESIZE_NOT_READY`: also `queueName` before first use, when it comes from the config;
      - 420, `RESIZE_CONFIG_REMOVED_KEY` naming `queue` or `worker`: framework hosts define queues in `queues` of `src/config/resize.ts`;
      - 421, `RESIZE_CONFIG_REMOVED_KEY` naming `lockTtlMs`: "`queue` in the config file" becomes `queues.<name>`;
      - 422, `RESIZE_CONFIG_COORDINATION_INVALID`: `coordination` is process-wide, read only from `src/config/resize.ts`;
      - 428, `RESIZE_MONGO_MODEL_OUTDATED` / `--check` drift: statement 1;
      - 430, `RESIZE_MONGO_MEDIA_MODEL_OUTDATED`: also missing `origin` and `encodeSig`;
      - 437, `RESIZE_CONFIG_REMOVED_KEY`: also the old `queue` object, `queues.<name>.queues` and `--config`;
      - the `RESIZE_SQS_QUEUE_URL_REQUIRED` and `RESIZE_SQS_QUEUE_UNKNOWN` rows: `queueUrl` is optional beside `queues`, and a call on an unknown name is now `RESIZE_QUEUE_NOT_SERVED`.
- [ ] **Step 5: Update `docs/host-adoption.md` and RELEASE.md.**
  - host-adoption:
    - Rewrite the bullets at 34–37, 77–81 (statement 2), 92–99 and 118–119 for `queues`, `queue: 'default'` and the process-wide `worker` and `coordination`.
    - Add the import moves, `queueName`, the type names, strict media rows with `origin` and `encodeSig`, the ejected `ResizeTask` times, `replacePreviews` for custom stores, `invalidate`, the six statements and the rc.2 paragraph from Step 2.
  - RELEASE.md: prereleases publish with `npm publish --tag next` (`latest` stays on the last stable), are tagged `v0.3.0-rc.N`, and §2's "no bump is needed" note becomes the prerelease rule.
- [ ] **Step 6: Update the docs site.**
  - Run every command of this step from inside `/Users/andrey/Work/framework-documenation-github`, with plain git (never `git -C`, no `&&`). If the worktree guard refuses commands on that path, leave the files edited, skip the commit and say so in the report; the controller commits.
  - Check that `git status` is clean on `docs/s2b-host-shapes`.
  - In `docs/12-resize.md`:
    - lines 60 and 239: the fragment and `resizeMediaPaths` import from `…/framework.js`;
    - lines 80–83, 264–268, 526 and 550–551: the new config with `queues`, `queue: 'default'` and `defaultWorkerOptions`; the encode example spreads `defaultFrameworkResizeConfig.encode`, which is unchanged;
    - line 352: `queueName: 'bulk'`;
    - line 353: a per-call queue works only within the Resizer's backend until S4;
    - line 370: a second file holds only per-Resizer sections, not a complete config like `resize.ts`;
    - line 378: delete the "share one task queue" timing rule;
    - lines 380 and 608: no `--config`;
    - line 434: the `queues` row;
    - line 459: the SQS example as a `queues` entry;
    - line 615: `origin` and `encodeSig`;
    - line 616: delete the `RESIZE_CONFIG_QUEUE_TIMING_CONFLICT` row;
    - add short `invalidate` and preview-fields paragraphs, and statements 1, 5 and 6.
  - Keep the guide on the site and the reference in README.
  - Run `npx docusaurus build` (not `generate-llm-context`). Expected: success with no broken links.
  - Commit, one command per line:
    - `git add docs/12-resize.md`
    - `git commit -m "docs(resize): named queues, queueName, preview fields and invalidate (0.3.0-rc.1)"`
  - Return to the worktree.
- [ ] **Step 7: Run everything to verify it passes.** Run: `node --experimental-strip-types --test src/agentsDoc.test.ts && npm run types:check && npm run check && npm test && npm run build && npm run smoke && npm pack --dry-run`. Expected: PASS. The pack prints `adaptivestone-framework-module-resize-0.3.0-rc.1.tgz` and lists only `dist/**`, `AGENTS.md`, `README.md`, `LICENSE` and `package.json`.
- [ ] **Step 8: Commit.** One command per line:
  - `git add package.json package-lock.json CHANGELOG.md README.md AGENTS.md RELEASE.md docs/host-adoption.md`
  - `git commit -m "docs: named queues, queueName, preview fields, invalidate; 0.3.0-rc.1"`

---

## Publishing `0.3.0-rc.1` (the owner's step; the plan does not publish)

After the branch is reviewed and merged into `main`:

1. Run `git switch main`, then `git pull`, then confirm a clean `git status`.
2. Run `npm ci && npm run types:check && npm run check && npm test && npm run smoke`. All must pass.
3. Run `npm pack --dry-run`. The version must be `0.3.0-rc.1`, and the file list `dist/**`, `AGENTS.md`, `README.md`, `LICENSE` and `package.json`.
4. Run `npm view @adaptivestone/framework-module-resize dist-tags`, and note `latest`.
5. Run `npm publish --tag next`.
6. Run `npm view @adaptivestone/framework-module-resize dist-tags`. `next` must be `0.3.0-rc.1`, and `latest` unchanged.
7. Run `git tag v0.3.0-rc.1`, then `git push origin v0.3.0-rc.1`.
8. Merge the docs-site branch `docs/s2b-host-shapes`.
9. Tell the host developer: `npm i @adaptivestone/framework-module-resize@next`, then follow `docs/host-adoption.md`.

## Definition of done (S2b)

- **Config shape.**
  - One `queues` map in `src/config/resize.ts`, `queue` is a name, and every file is typed `FrameworkResizeConfig` (Task 5).
  - Two Resizers on two database names share one task queue, with per-name timing and lanes, in the worker and in the Dispatcher (Tasks 3, 4 and 5).
  - A call on another backend's queue queues nothing and says why (Tasks 4 and 5).
  - The old shape fails with the new path in its message (Task 5).
  - The timing-conflict code is gone (Task 5).
- **`queueName`** replaces `queue` on `Resizer` and `FrameworkResizer`, and the docs say when it is readable (Tasks 4 and 10).
- **Import moves.**
  - The fragment and `resizeMediaPaths` are at `…/drivers/mongo.js` and `…/framework.js`, and not on the main entry (Task 1).
  - The framework defaults are at `…/framework.js`, and `…/config/resize.js` holds the core defaults (Task 2).
- **Preview rows** carry `bytes`, `createdAt`, `origin` and `encodeSig`, with fixed vectors and scoped inputs, from the worker and from `generate()`. The fragment declares them. The read path does not check them yet (Task 6).
- **`replacePreviews`** is on the port, the Mongo store and the framework store; it casts rows and returns plain objects (Task 7).
- **`invalidate`** returns the removed refs, and `verify()` requires `replacePreviews` (Task 8).
- **Task rows** carry `startedAt` and `finishedAt`, and the ejected template and `--check` know them (Task 9).
- **Scaffold.** It emits the final shape, and `--check` reports old configs (Tasks 2 and 5).
- **Gates.**
  - `npm run types:check`, `npm run check`, `npm test`, `npm run build`, `npm run smoke` and `npm pack --dry-run` pass at `0.3.0-rc.1`.
  - README, AGENTS.md, CHANGELOG, RELEASE.md, host-adoption and the site page match, including the six host statements, and the site builds (Task 10).
