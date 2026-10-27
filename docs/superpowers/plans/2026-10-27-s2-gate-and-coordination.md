# S2 — Gate and coordination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At most one active task per `(resizer, mediaId, pipeline)`. A cold media then costs one task however many reads arrive, and a task in backoff or in its dead-letter cooldown blocks new ones. The Resizer owns the coordination policy (`gateTtlMs`, `cooldownMs`), and only the core validates it. The per-identity dispatch and worker locks go away, and task events carry `attempts`.

**Architecture:** `TaskQueue.add` reports `added`, `in-flight` or `unconfirmed`. A queue that can enforce the gate declares `gatesByTask`.
- `MongoTaskQueue`: a row is `active` from `add` until `complete`, or until a dead row's `cooldownUntil` has passed. A unique partial index on `{ resizer, fileId, pipeline }` (`active: true`) turns `add` into one insert that either wins or reports `in-flight`.
- Any other queue (SQS, custom): the `Dispatcher` takes one owned lock, `resize_gate:<resizer>:<mediaId>:<pipeline>`, under a fresh token. The task carries that token as `gateOwner`. The `Consumer` extends the lock through the lease and the retry backoff, holds it for the cooldown after a dead-letter, and releases it on completion. On a gating queue it passes `cooldownMs` to `fail('dead')` instead.
- `fillCoordination` (`src/coordination.ts`) validates `new Resizer({ coordination })` against the queue's lease while the Resizer sets up its task queue.
- The worker passes the names of the Resizers it serves to `claim`, so a queue that declares `claimFilters` never hands it another Resizer's task.
- The `Processor` takes no locks: the lease token fences task writes, and `appendPreviews` keeps one row per identity.

**Tech Stack:** Node ≥ 24, TypeScript 7 (`erasableSyntaxOnly`, ESM, `.ts` specifiers), `node:test`, Biome 2, sharp 0.35, mongoose 9 and mongodb-memory-server (tests only).

**Spec:** docs/design/2026-10-26-reference-architecture.md (F2, F3, task events with `attempts`; the S2 row of Phases; Host migration 2, 4 and 6)

## Global Constraints

- **Branch and repository.**
  - Work on branch `refactor/s2-gate-and-coordination` in the worktree `.claude/worktrees/s1-ports-and-composition-root`, on top of S1 (`1ba0a5c`).
  - Each task ends with one commit. Nothing is pushed, including the docs-site branch `docs/s2-gate` (stacked on `docs/s1-ports`).
  - Use plain git in the worktree, never `git -C`. The docs-site step runs from inside that repository.
- **Scope.** F2, F3 and task events with `attempts`. Out of scope:
  - F4 (decoders);
  - F6 (named queues: the queue-sharing state in `src/framework/queue.ts` stays);
  - F7;
  - F8 (metrics, including an "enqueue skipped" count);
  - F9;
  - the `owner` field on the framework `Lock` schema. That is a separate, human-reviewed PR in the framework repository, and `FrameworkLockStore` keeps its native-collection path.
- **Unchanged.**
  - The preview identity string.
  - `appendPreviews` as one guarded write per row.
  - The retry and dead-letter rules, and lease-token fencing.
  - The give-back path (`accepts` + `release`) for queues that cannot filter claims.
  - `resolve()` and `prewarm()` never throw and never run Sharp.
  - Queue timing is validated once per queue instance.
- **Per-variant errors keep their S1 semantics.** A variant that fails counts as failed, even with `retryable: false`, and the task fails with the retryable `RESIZE_WORKER_INCOMPLETE`. Document this; do not change it.
- **Error codes.**
  - New: `RESIZE_CONFIG_COORDINATION_INVALID`, `RESIZE_CONFIG_GATE_TTL_BELOW_LEASE`, and the prewarm issue `RESIZE_TASK_IN_FLIGHT`.
  - Removed: `RESIZE_CONFIG_QUEUE_LOCK_TTL_INVALID`, `RESIZE_CONFIG_LOCK_EXCEEDS_LEASE`.
  - `RESIZE_CONFIG_REMOVED_KEY` now also covers `lockTtlMs`.
- **Pre-release.** Breaking changes ship without migration code, and hosts migrate their own data and indexes. The module never creates, changes or drops indexes. Keep `minimize: false`.
- **House rules from S1.**
  - Classes own their behaviour. Module-private helpers take narrow parameters, never a whole deps bag.
  - No service imports `resizer.ts`.
  - `drivers/**` import only contracts, errors, helpers, types and other drivers.
  - Shipped code never uses `instanceof` on errors; it uses the `isResizeError` brand.
  - No test-only seams in shipped code.
  - No `any`, except with a `biome-ignore` that gives the reason.
  - `src/types.d.ts` stays dependency-free.
  - Comments state reasons in plain words, with no spec-section references and no private project names.
  - Tests never spread class-typed values; write the object out.
- **Checks.**
  - Every task ends with `npm run types:check`, `npm run check` and `npm test` passing.
  - Tasks 1, 6, 11, 12 and 13 also run `npm run build && npm run smoke`.
  - One file: `node --experimental-strip-types --test src/<file>.test.ts`. The Mongo tests start mongodb-memory-server themselves.
- **No renames.** No file is renamed in S2, so S1's "pure `git mv` commit first" rule does not apply.
- **Commit messages** use a conventional prefix, with NO `Co-Authored-By` and no "Generated with" trailer.
- **Task order keeps every commit green.**
  1. The contract and the fakes.
  2. The queues and the policy.
  3. The Consumer and the worker, which already handle `gateOwner` and pass `cooldownMs`.
  4. The Dispatcher, which starts setting `gateOwner`.
  5. The lock removal, then the `lockTtlMs` removal.

## Review Focus

1. **Rolling deploy.** A worker from before the gate completes or dead-letters a row that the new API inserted. The row keeps `active: true`, and a dead one has no `cooldownUntil`. `add` must take that row over, not report `in-flight` until the row's 24 h or 30 d TTL removes it. (Test: Task 3.)
2. **Ejected model missing a field.** An ejected or hand-written `ResizeTask` model lacks `active` or `cooldownUntil`, so strict mode drops the field. Without `active` the gate is silently off; without `cooldownUntil` a dead row is never taken over. `verify()` must reject with `RESIZE_MONGO_MODEL_OUTDATED` naming the field, and `resize-scaffold --check` must report the drift. (Test: Tasks 3 and 4.)
3. **Rows without a `resizer`** (written before tasks recorded one), under claim filtering. A worker that serves `default` must still claim them, and a worker that serves only `listings` must not. (Test: Task 3.)
4. **`prewarm()` during a dead-letter cooldown** on a gating queue. The active row is the dead task, so nothing will run. `prewarm()` must report every variant `unconfirmed` with the retryable `RESIZE_TASK_IN_FLIGHT`, never `accepted` with the dead task as the receipt. (Test: Tasks 3 and 9.)
5. **A gate lock taken over by another request.** The lock expired while its task waited, and another request took it with its own owner. The first task's worker must neither extend nor release the new owner's lock, at heartbeat, retry or completion. A gate call that returns `false` or rejects never changes the task's outcome. (Test: Task 7.)

---

## File structure

| File | Change | Responsibility after S2 |
|---|---|---|
| `src/contracts/taskQueue.ts` | Modify | `TaskAddResult`, `gatesByTask`, `claimFilters`, `ClaimOptions`, `FailOptions`, `gateOwner`, `attempts` on every task; no `requestKey` |
| `src/coordination.ts` | Create | `Coordination`, `TaskCoordination`, `fillCoordination`: the coordination policy, filled in and validated against the lease |
| `src/lockKeys.ts` | Modify | Only `gateKey(resizer, mediaId, pipeline)` |
| `src/dispatcher.ts` | Modify | One gate per media and pipeline (the task row, or a gate lock); prewarm's in-flight coverage; no `buildRequestKey`, no per-identity locks |
| `src/consumer.ts` | Modify | Holds the gate lock through the lease, the backoff and the cooldown; passes `cooldownMs` to `fail('dead')` and the served names to `claim`; logs only through `logNeverThrow` |
| `src/worker.ts` | Modify | Gives each task the coordination of its Resizer; claim filter; `refuseUnservedSharers` only for queues that cannot filter; no cooldown locks |
| `src/processor.ts` | Modify | No locks: no worker locks, no dispatch releases, no `holdFailedCooldown` |
| `src/resizer.ts` | Modify | `coordination` option; `RESIZE_LOCKS_REQUIRED` only beside a queue without `gatesByTask`; internal `taskCoordinationOf()` |
| `src/reader.ts` | Modify | `prewarmFailure` decides by the error's brand and name, not `instanceof` |
| `src/timing.ts`, `src/resizeConfig.ts` | Modify | Queue timing without lock TTLs; `lockTtlMs` is a removed key |
| `src/helpers/log.ts` | Modify | `logNeverThrow(logger, message, err?, level?)` |
| `src/config/resize.ts` | Modify | `defaultCoordination`; `defaultQueueOptions` without `lockTtlMs`; `defaultFrameworkResizeConfig.coordination` |
| `src/types.d.ts` | Modify | `CoordinationOptions`; `FrameworkResizeConfig.coordination`; `QueueTimingOptions` without `lockTtlMs`; the issue code `RESIZE_TASK_IN_FLIGHT` |
| `src/index.ts` | Modify | Type exports `TaskAddResult`, `ClaimOptions`, `FailOptions`, `CoordinationOptions` |
| `src/drivers/mongo/taskQueue.ts`, `schemas.ts` | Modify | The gate: `active`, `cooldownUntil`, the unique partial index, takeover, claim filter, `findActive` of the one active task |
| `src/drivers/sqs.ts` | Modify | The message carries `gateOwner`; the new `add` result |
| `src/framework/config.ts`, `src/framework/resizer.ts` | Modify | A `coordination` section per config file; `queue.lockTtlMs` is a removed key |
| `src/framework/scaffold/templates/ResizeTask.model.full.ts.tpl`, `resize.config.ts.tpl`, `src/framework/scaffold/command.ts` | Modify | The ejected model carries the gate; the drift-check fields; a `coordination` hint in the config template |
| `src/testHelpers/fakes.ts` | Modify | Gating `MemoryTaskQueue` (with `claimFilters`), `PlainTaskQueue`, `clockLocks`; `ReleasingTaskQueue` on the non-gating base |
| `src/testHelpers/contractShapes.ts`, `consume.ts` | Modify | Plain-object pins of the new contract; `consume()` passes `resizers` and `coordinationOf` |
| `src/gate.test.ts`, `src/coordination.test.ts` | Create | The S2 "done when" scenarios in memory; validation of the policy |
| Tests | Modify | `dispatcher`, `consumer`, `worker`, `processor`, `prewarm`, `prewarmCoverage`, `reader`, `resizer`, `timing`, `config/resize`, `architecture`, `testHelpers/fakes`, `drivers/sqs`, `drivers/mongo/taskQueue`, `framework/*` |
| `README.md`, `AGENTS.md`, `CHANGELOG.md`, `docs/host-adoption.md`, docs site `docs/12-resize.md` | Modify | The gate, coordination and the migration |

---

### Task 1: The task-queue contract: the `add` result, gate flags, claim and fail options, `attempts` on every task

**Files:**
- Modify:
  - `src/contracts/taskQueue.ts:13-111`;
  - `src/contracts/hooks.ts` (the observer docs mention `attempts`);
  - `src/consumer.ts:26-36`;
  - the `add` methods of `src/drivers/mongo/taskQueue.ts:126-192`, `src/drivers/sqs.ts:125-140` and `src/testHelpers/fakes.ts:110-134`;
  - `src/dispatcher.ts:171-191, 254-279`;
  - `src/index.ts`.
- Test: `src/testHelpers/contractShapes.ts`, `src/consumer.test.ts`, `src/worker.test.ts`. Also every test whose `add` fake resolves `{ taskId }` or that builds a `LeasedTask`: the `dispatcher`, `reader`, `prewarm`, `prewarmCoverage`, `processor`, `drivers/sqs` and `drivers/mongo/taskQueue` tests.

**Interfaces:**
Produces:
```ts
// src/contracts/taskQueue.ts
export interface NewTask { resizer: string; queue: string; mediaId: string; pipeline: string; previews: MissingPreview[]; requestKey: string; gateOwner?: string } // requestKey leaves in Task 3
export interface LeasedTask { taskId: string; resizer: string; queue: string; mediaId: string; pipeline: string; previews: MissingPreview[]; attempts: number } // attempts moves up from ClaimedTask
export interface ClaimedTask extends LeasedTask { token: string; gateOwner?: string } // gateOwner: what add() received, handed back by claim()
export type TaskAddResult = { status: 'added'; taskId: string } | { status: 'in-flight'; taskId?: string } | { status: 'unconfirmed' };
export interface ClaimOptions { resizers?: readonly string[] } // a queue with claimFilters claims only tasks of these Resizers
export interface FailOptions { cooldownMs?: number }           // with 'dead': how long a gating queue keeps the dead task as the gate
export abstract class TaskQueue {
  readonly gatesByTask?: true;  // add() keeps at most one active task per (resizer, mediaId, pipeline)
  readonly claimFilters?: true; // claim() honours ClaimOptions.resizers
  abstract add(task: NewTask): Promise<TaskAddResult>;
  abstract claim(queue: string, leaseMs: number, signal?: AbortSignal, opts?: ClaimOptions): Promise<ClaimedTask | null>;
  abstract fail(task: ClaimedTask, next: { retryAt: Date } | 'dead', error: string, opts?: FailOptions): Promise<boolean>;
  // renew, complete, release?, findActive?, servesQueue?, getTiming?, verify?: signatures unchanged
}
```
**Decision (a mechanical step):** Task 1 changes the shape, not the behaviour.
- Every shipped `add` maps today's non-null `taskId` to `{ status: 'added', taskId }`, and `null` to `{ status: 'unconfirmed' }`.
- The Dispatcher treats any status other than `'added'` the way it treats `null` today.
- No queue declares `gatesByTask` or `claimFilters` yet, and `requestKey` stays until Task 3.

- [ ] **Step 1: Write the failing tests.**
  - In `src/testHelpers/contractShapes.ts`, `tasks.add` becomes `async () => ({ status: 'unconfirmed' })`, and `fullTasks.add` becomes `async () => ({ status: 'added', taskId: 't' })`.
  - Append the following. The four-parameter `claim` and `fail` do not type-check against the old three-parameter signatures, so they pin the new parameters:
```ts
export const gatingTasks: TaskQueue = {
  gatesByTask: true,
  claimFilters: true,
  add: async () => ({ status: 'in-flight' }),
  claim: async (_queue, _leaseMs, _signal, opts) => (opts?.resizers?.length === 0 ? null : null),
  renew: async () => true,
  complete: async () => true,
  fail: async (_task, _next, _error, opts) => opts?.cooldownMs !== undefined,
};
export const oldAddTasks: TaskQueue = {
  // @ts-expect-error — add resolves with a status; a bare taskId is the older contract.
  add: async () => ({ taskId: 'x' }),
  claim: async () => null, renew: async () => true, complete: async () => true, fail: async () => true,
};
export const falseGate: TaskQueue = {
  // @ts-expect-error — gatesByTask is `true` or absent.
  gatesByTask: false,
  add: async () => ({ status: 'unconfirmed' }),
  claim: async () => null, renew: async () => true, complete: async () => true, fail: async () => true,
};
```
In `src/consumer.test.ts`:
```ts
test('task events carry the delivery count', …)
  // retryBackoffMs { base: 1, max: 1 }; the handler throws once, then resolves
  // → events.map((e) => [e.event, e.task.attempts]) deepEqual [['failed', 1], ['completed', 2]]
```
In `src/worker.test.ts`:
```ts
test('task observers and their resize:<hook> events carry attempts', …)
  // a Resizer with an events recorder; storage.download rejects once with ResizeStorageError, then returns png
  // onTaskFailed sees task.attempts === 1, afterTaskComplete sees 2; the emitted 'resize:onTaskFailed' args[0].attempts === 1
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `npm run types:check`, then `node --experimental-strip-types --test src/consumer.test.ts src/worker.test.ts`. Expected: FAIL.
  - The type check reports TS2322 for the `status` results, the `gatesByTask` and `claimFilters` members and the four-parameter `claim` and `fail`, plus TS2578 for the two unused `@ts-expect-error` directives.
  - The tests see `attempts` undefined.
- [ ] **Step 3: Implement the contract in `src/contracts/taskQueue.ts`.**
  - Document each member with the semantics above. The header adds: "a queue that gates by task keeps at most one active task per Resizer, media and pipeline".
  - `findActive`'s doc becomes: "the one active task (pending or processing) of this Resizer, media and pipeline, or `[]`; the Dispatcher reads it after an `in-flight` add".
  - Map the three `add` methods and the Dispatcher's two `add` call sites as the decision says.
  - `toLeasedTask` copies `attempts`.
  - Export the four types from `src/index.ts`.
- [ ] **Step 4: Update the listed tests.**
  - `{ taskId: 'x' }` becomes `{ status: 'added', taskId: 'x' }`, and `{ taskId: null }` becomes `{ status: 'unconfirmed' }`.
  - Every hand-built `LeasedTask` gets `attempts: 1`.
  - The expected task in 'a successful task is completed and reported, without its lease token' gains `attempts: 1`.
- [ ] **Step 5: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS.
- [ ] **Step 6: Commit.** `git add -A src && git commit -m "feat!: TaskQueue.add reports added, in-flight or unconfirmed; task events carry attempts"`

### Task 2: Test fakes: a gating `MemoryTaskQueue`, `PlainTaskQueue` and `clockLocks`

**Files:**
- Modify: `src/testHelpers/fakes.ts:79-255`
- Test: `src/testHelpers/fakes.test.ts`, plus the tests that the gate changes (Step 5)

**Interfaces:**
Consumes: `TaskAddResult`, `ClaimOptions`, `FailOptions`, `gatesByTask`, `claimFilters` (Task 1).
Produces:
```ts
// src/testHelpers/fakes.ts
export interface MemoryTaskQueueOptions { timing?: Partial<QueueTimingOptions>; now?: () => number } // now: the cooldown clock only (default Date.now); leases and retry times stay on Date.now
export class MemoryTaskQueue extends TaskQueue {   // the gate, the claim filter and findActive
  readonly gatesByTask = true; readonly claimFilters = true;
  readonly rows: Row[];      // Row gains active: boolean; cooldownUntil?: number
  readonly added: NewTask[]; // every add call, also the in-flight ones
  constructor(opts?: MemoryTaskQueueOptions);
}
export class PlainTaskQueue extends TaskQueue {   // the SQS shape: no gatesByTask, no claimFilters, no findActive; every add stores a row
  readonly rows: Row[]; readonly added: NewTask[];
  constructor(opts?: { timing?: Partial<QueueTimingOptions> });
}
export class ReleasingTaskQueue extends PlainTaskQueue { /* release() unchanged */ }
export interface ClockLocks extends LockStore { entry(key: string): { owner: string; expiresAt: number } | undefined }
export function clockLocks(now?: () => number): ClockLocks; // TTL expiry and takeover as the LockStore contract says; default Date.now
```
The gate rules of `MemoryTaskQueue`, the same ones `MongoTaskQueue` follows in Task 3:
- `add` looks for an active row with the same `resizer`, `mediaId` and `pipeline`.
  - If that row is dead and its `cooldownUntil` is unset or `≤ now()`, `add` sets the row's `active` to `false` and stores a new row (`added`).
  - Any other active row gives `{ status: 'in-flight', taskId: row.id }`.
- `complete` sets `active` to `false`. A retry and `release` keep the row active.
- `fail('dead')` sets `cooldownUntil = now() + (opts?.cooldownMs ?? 0)`.
- `findActive` returns `[{ taskId, previews }]` while the active row is pending or processing, and `[]` otherwise.
- `claim` with `opts.resizers` takes only rows whose `resizer` is in the list.

**Decision (the fakes' structure):**
- An unexported base class holds the rows and the lease logic.
- `MemoryTaskQueue` adds the gate, the claim filter and `findActive`. `PlainTaskQueue` adds nothing.
- `ReleasingTaskQueue` moves onto `PlainTaskQueue`. It tests the give-back path, and a queue that filters claims never gives back tasks of Resizers it does not serve.

- [ ] **Step 1: Write the failing tests.** In `src/testHelpers/fakes.test.ts` (these replace the `requestKey` de-duplication test):
```ts
test('MemoryTaskQueue gates by task: one active task per Resizer, media and pipeline', …)
  // add(m1) → { status: 'added', taskId: 'task-1' }; add(m1) → { status: 'in-flight', taskId: 'task-1' };
  // add(m1, pipeline 'wm') and add(m1, resizer 'listings') → 'added'; rows.length 3; added.length 4
test('retry backoff and release keep the gate; complete opens it', …)
  // claim; fail({ retryAt: +60 s }) → add → 'in-flight'; (after the retry time) claim; complete → add → 'added'
test('a dead task holds the gate until its cooldown ends; then one add takes it over', …)
  // let t = 0; MemoryTaskQueue({ now: () => t }); claim; fail('dead', 'x', { cooldownMs: 1000 }) → add → 'in-flight'
  // t = 1000 → add → 'added'; the dead row: status 'dead', active false, error 'x'
test('findActive returns only a pending or processing active task', …)
  // [] for none, [receipt] while pending, [] once the task is dead (cooldown running)
test('claim with resizers takes only their tasks', …)
  // rows of 'a' and 'b' → claim('default', 1000, undefined, { resizers: ['b'] }).resizer === 'b', then null
test('PlainTaskQueue stores every add and declares no gate, no claim filter and no findActive', …)
  // two adds of m1 → both 'added'; rows.length 2; gatesByTask, claimFilters and findActive are all undefined
test('clockLocks expires locks, lets them be taken over, and checks owners', …)
  // t = 0: acquire('k','A',10) true; acquire('k','B',10) false; extend('k','B',10) false
  // t = 10: extend('k','A',10) false; acquire('k','B',10) true; release('k','A') false; entry('k') deepEqual { owner: 'B', expiresAt: 20 }
test('clockLocks: an expired lock can be released by its owner until someone takes it over', …)
  // acquire('k','A',10); t = 50; release('k','A') true; entry('k') undefined
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/testHelpers/fakes.test.ts`. Expected: FAIL with "does not provide an export named 'PlainTaskQueue'".
- [ ] **Step 3: Implement the fakes in `src/testHelpers/fakes.ts`** as the Interfaces and rules above say. Update the file's header comment. `MemoryTaskQueue` stops matching `requestKey`.
- [ ] **Step 4: Run the new tests to verify they pass.** Run Step 2's command. Expected: PASS.
- [ ] **Step 5: Migrate the tests that the gate changes.** Run `npm test`. Some tests add two tasks for one Resizer, media and pipeline and expect two rows (likely in `consumer`, `processor`, `worker`, `prewarm*`, `reader` and `framework/resizer` tests). In each, either give the second task another `mediaId`, or use `PlainTaskQueue` when the duplicate is what the test is about. Keep every other assertion. Expected: PASS.
- [ ] **Step 6: Commit.** `git add -A src && git commit -m "test: a gating MemoryTaskQueue, PlainTaskQueue and clock-driven locks"`

### Task 3: `MongoTaskQueue`: the task row is the gate

**Files:**
- Modify:
  - `src/drivers/mongo/taskQueue.ts:34-53, 126-192, 200-233, 242-302, 338-349`;
  - `src/drivers/mongo/schemas.ts:20-22, 83-94`;
  - `src/contracts/taskQueue.ts` (`NewTask` loses `requestKey`);
  - `src/dispatcher.ts:21-48, 520-543` (`buildRequestKey` and the task's `requestKey` go).
- Test:
  - `src/drivers/mongo/taskQueue.test.ts` (the describes `MongoTaskQueue setup`, `.add` and `.claim`);
  - `src/framework/ResizeTaskModel.test.ts:57-61, 119, 179-195`;
  - `src/framework/queueIndexes.mongo.integration.test.ts:103-250`;
  - `src/dispatcher.test.ts:416-436` (delete `describe('buildRequestKey')`);
  - every fixture that sets `requestKey` (the `consumer`, `worker`, `processor`, `drivers/sqs` and `drivers/mongo/drivers.mongo.integration` tests).

**Interfaces:**
Consumes: `TaskAddResult`, `ClaimOptions`, `FailOptions` (Task 1).
Produces:
```ts
// src/drivers/mongo/taskQueue.ts
export class MongoTaskQueue extends TaskQueue {
  readonly gatesByTask = true; readonly claimFilters = true;
  add(task: NewTask): Promise<TaskAddResult>;
  claim(queue: string, leaseMs: number, signal?: AbortSignal, opts?: ClaimOptions): Promise<ClaimedTask | null>; // opts.resizers → resizer: { $in }, plus null when 'default' is listed
  complete(task: ClaimedTask): Promise<boolean>;                                 // also sets active: false
  fail(task: ClaimedTask, next: { retryAt: Date } | 'dead', error: string, opts?: FailOptions): Promise<boolean>; // dead: cooldownUntil = now + (opts?.cooldownMs ?? 0); active stays true
  findActive(query: { resizer: string; mediaId: string; pipeline: string }): Promise<EnqueueReceipt[]>; // { resizer, fileId, pipeline, active: true, status pending|processing } → [receipt], else []
}
// src/drivers/mongo/schemas.ts
// resizeTaskFields: requestKey removed; active: { type: Boolean, default: false }; cooldownUntil: { type: Date }
// resizeTaskIndexes: the requestKey index removed; [{ resizer: 1, fileId: 1, pipeline: 1 }, { unique: true, partialFilterExpression: { active: true } }] added (still six)
// WRITTEN_PATHS: requestKey removed; active and cooldownUntil added
// src/contracts/taskQueue.ts: NewTask = { resizer, queue, mediaId, pipeline, previews, gateOwner? }
```
**Decision (`add`):** at most two rounds.
1. Insert `{ fileId, resizer, queue, pipeline, previews, status: 'pending', attempts: 0, availableAt: now, active: true }` through the model, with `writeConcern: { w: 'majority' }`. On success: `{ status: 'added', taskId }`.
2. On a duplicate key (11000), read the active row: `findOne({ resizer, fileId, pipeline, active: true }, { _id: 1, status: 1, cooldownUntil: 1 })`.
   - No row: the active task has just finished; start the next round.
   - The row can be taken over: it is `'completed'` (left by a worker from before the gate), or it is `'dead'` with `cooldownUntil` missing or `≤ now`. Retire it with `findOneAndUpdate({ _id, active: true, $or: [{ status: 'completed' }, { status: 'dead', cooldownUntil: { $not: { $gt: now } } }] }, { $set: { active: false } })`, then start the next round.
   - Any other row: `{ status: 'in-flight', taskId: String(row._id) }`.
3. Any other error is logged and gives `{ status: 'unconfirmed' }`. A missing model also gives `unconfirmed`.
4. After two rounds: `{ status: 'in-flight' }`.

The old row is retired, not rewritten, so a dead row and its `error` stay for inspection until the row's 30-day TTL. A read while a task is pending costs one failed insert and one read.

- [ ] **Step 1: Write the failing tests.** In `src/drivers/mongo/taskQueue.test.ts`, these replace the requestKey de-duplication tests of `describe('MongoTaskQueue.add')` (`fid()` is a fresh ObjectId string):
```ts
describe('MongoTaskQueue.add: one active task per Resizer, media and pipeline', () => {
  test('a second add is in-flight with the active task id; another pipeline, Resizer or media is a new task', …)
  test('fifty concurrent adds store one active row; the others are in-flight with its id', …)
    // results.filter((r) => r.status === 'added').length === 1; every in-flight taskId === the winner's; countDocuments({ fileId, active: true }) === 1
  test('a task in retry backoff, or given back, keeps the gate', …)
    // claim; fail(task, { retryAt: +60 s }, 'x') → add → 'in-flight'; claim; release → add → 'in-flight'
  test('complete opens the gate: the next add is a new task', …) // the completed row has active false
  test('a dead task holds the gate for cooldownMs; then one of twenty adds takes it over and the dead row keeps its error', …)
    // fail(task, 'dead', 'boom', { cooldownMs: 200 }) → add → 'in-flight'; wait 250 ms; 20 concurrent adds → exactly one 'added'
    // the dead row: status 'dead', active false, error 'boom'; countDocuments({ fileId, active: true }) === 1
  test('a row completed or dead-lettered by a worker from before the gate does not hold it', …)
    // M.collection.insertOne({ fileId, resizer: 'default', pipeline: 'default', queue: 'default', previews: [], status: 'completed', active: true, attempts: 1 }) → add → 'added'
    // the same with status 'dead' and no cooldownUntil → add → 'added'
  test('a write error other than a duplicate key is logged and unconfirmed; a missing model is unconfirmed', …)
});
describe('MongoTaskQueue.findActive', () => {
  test('returns the one pending or processing task, and [] for a dead row that still holds the gate', …)
});
test('claim with resizers takes only their tasks; a row without a resizer belongs to default', …)
  // tasks of 'default' and 'listings', and M.collection.insertOne of a pending row without resizer (and without active)
  // claim(…, { resizers: ['listings'] }) → the listings task, then null; claim(…, { resizers: ['default'] }) → the default task and the legacy row, then null
test('verify rejects a model without active or cooldownUntil, naming the field', …)
  // a schema from resizeTaskFields('File') without 'active' → RESIZE_MONGO_MODEL_OUTDATED, /active/; without 'cooldownUntil' → /cooldownUntil/
```
In `src/framework/ResizeTaskModel.test.ts`, these replace the `requestKey` tests:
```ts
test('active is a Boolean defaulting to false; cooldownUntil is a Date; there is no requestKey', …)
test('{ resizer:1, fileId:1, pipeline:1 } is unique among active rows', …) // options deepEqual { unique: true, partialFilterExpression: { active: true } }
```
In `src/framework/queueIndexes.mongo.integration.test.ts`, 'prepared indexes preserve concurrent enqueue deduplication' becomes `test('prepared indexes enforce the gate: concurrent adds create one active row', …)`. It finds the index by its exact key and options; 20 concurrent `add`s then leave one active row.
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/drivers/mongo/taskQueue.test.ts src/framework/ResizeTaskModel.test.ts`. Expected: FAIL. The second add reports `'added'`, and `modelSchema.active` is undefined.
- [ ] **Step 3: Implement the schema and the queue** as the Interfaces and the decision say. `toClaimedTask` stays, `activeRequestFilter` is deleted, and the file header is rewritten around the gate.
- [ ] **Step 4: Remove `requestKey` everywhere.** It leaves `NewTask`, the Dispatcher's `newTask()` and every test fixture. Delete `buildRequestKey`, its `node:crypto` import and `describe('buildRequestKey')`.
- [ ] **Step 5: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test`. Expected: PASS.
- [ ] **Step 6: Commit.** `git add -A src && git commit -m "feat(mongo)!: the ResizeTask row is the gate: one active task per Resizer, media and pipeline"`

### Task 4: Scaffold: the ejected `ResizeTask` model carries the gate

**Files:**
- Modify: `src/framework/scaffold/templates/ResizeTask.model.full.ts.tpl:36-38, 100-111`, `src/framework/scaffold/command.ts:34-45, 172`
- Test: `src/framework/scaffold/command.test.ts:196-240, 336-368`

**Interfaces:**
Consumes: the fields and the index from Task 3.
Produces: `EJECTED_MODEL_FIELDS` checks `resizer`, `queue`, `availableAt`, `active` and `cooldownUntil`. The drift hint reads "port the resizer, queue, availableAt, active and cooldownUntil fields (and the gate index)".

- [ ] **Step 1: Write the failing tests.** In `command.test.ts`, under `describe('runScaffold — --eject')`:
```ts
test('the ejected schema carries active, cooldownUntil and the gate index, and no requestKey', …)
  // match /active:\s*\{\s*type:\s*Boolean/, /cooldownUntil:\s*\{\s*type:\s*Date/, /\{ resizer: 1, fileId: 1, pipeline: 1 \}/, /partialFilterExpression:\s*\{\s*active:\s*true\s*\}/; doesNotMatch /requestKey/
test('an ejected model that still declares requestKey is not drift', …) // --check exits 0 with the field added back
```
The drift cases `['requestKey']` and `['resizer', 'queue', 'requestKey', 'availableAt']` become `['active']`, `['cooldownUntil']` and `['resizer', 'queue', 'availableAt', 'active', 'cooldownUntil']`, with the new hint.
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/framework/scaffold/command.test.ts`. Expected: FAIL. The template still has `requestKey`, and a model without `active` passes `--check`.
- [ ] **Step 3: Update the template and `command.ts`.**
  - In the template, `requestKey` becomes `active` and `cooldownUntil`. `active` gets the comment "true while the task is the gate of its media and pipeline".
  - The requestKey index becomes the gate index, with the comment from `schemas.ts`.
  - `command.ts` gets the new patterns and hint.
- [ ] **Step 4: Run the tests to verify they pass.** Run Step 2's command, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/framework/scaffold && git commit -m "feat(scaffold): the ejected ResizeTask model carries active, cooldownUntil and the gate index"`

### Task 5: `SqsTaskQueue` carries the gate owner

**Files:**
- Modify: `src/drivers/sqs.ts:45-52, 125-187`
- Test: `src/drivers/sqs.test.ts` (`describe('SqsTaskQueue.add')`, `describe('SqsTaskQueue.claim')`)

**Interfaces:**
Consumes: `NewTask.gateOwner`, `ClaimedTask.gateOwner`, `ClaimOptions` (Task 1).
Produces:
- The message body is `{ resizer, queue, mediaId, pipeline, previews, gateOwner? }`.
- `claim` ignores `opts`: SQS cannot select messages by their content.
- No `gatesByTask` and no `claimFilters`.
- The dead-letter body is unchanged (no `gateOwner`).

- [ ] **Step 1: Write the failing tests.**
```ts
test('add sends gateOwner in the body and claim returns it; the dead-letter body leaves it out', …)
  // add({ …, gateOwner: 'g1' }) → JSON.parse(sent[0].input.MessageBody).gateOwner === 'g1'
  // a received body with gateOwner 'g1' → claimed.gateOwner === 'g1'; fail(claimed, 'dead', 'x') → the DLQ body has no gateOwner key
test('a body without gateOwner (queued before the gate) is claimed without one', …) // 'gateOwner' in claimed === false
test('claim ignores a resizers filter: SQS cannot filter by Resizer', …) // body resizer 'other'; claim(…, { resizers: ['default'] }) → resizer 'other'
test('SqsTaskQueue declares neither gatesByTask nor claimFilters', …)
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/drivers/sqs.test.ts`. Expected: FAIL. The body has no `gateOwner`.
- [ ] **Step 3: Implement it in `src/drivers/sqs.ts`.**
  - `TaskBody` gains `gateOwner?: string`.
  - `add` writes `gateOwner` only when it is set.
  - `claim` copies it only from a string `gateOwner` in the body.
  - Add the header line "`gateOwner` is the core's gate-lock token; SQS only carries it".
- [ ] **Step 4: Run the tests to verify they pass.** Run Step 2's command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/drivers/sqs.ts src/drivers/sqs.test.ts && git commit -m "feat(sqs): task messages carry the gate owner"`

### Task 6: The coordination policy belongs to the Resizer

**Files:**
- Create: `src/coordination.ts`, `src/coordination.test.ts`
- Modify:
  - `src/types.d.ts` (new `CoordinationOptions`; `FrameworkResizeConfig.coordination?`);
  - `src/config/resize.ts:39-68`;
  - `src/resizer.ts:50-69, 74-77, 151-159, 404-420, 557-576`;
  - `src/framework/config.ts:20-28, 73, 134-141`;
  - `src/framework/resizer.ts:45-108`;
  - `src/index.ts`;
  - `src/framework/scaffold/templates/resize.config.ts.tpl` (one comment line).
- Test: `src/coordination.test.ts`, `src/resizer.test.ts`, `src/framework/resizer.test.ts`, `src/config/resize.test.ts`

**Interfaces:**
Consumes: `QueueTiming`, `timingOf` (`src/timing.ts`); `LockStore`.
Produces:
```ts
// src/types.d.ts
export interface CoordinationOptions { gateTtlMs?: number; cooldownMs?: number }
// FrameworkResizeConfig gains: coordination?: CoordinationOptions
// src/config/resize.ts
export const defaultCoordination = { gateTtlMs: 600_000, cooldownMs: 600_000 } satisfies Required<CoordinationOptions>;
// defaultFrameworkResizeConfig gains coordination: defaultCoordination (its type adds `coordination: Required<CoordinationOptions>`)
// src/coordination.ts
export type Coordination = Required<CoordinationOptions>;
export interface TaskCoordination { cooldownMs: number; locks?: LockStore } // what the worker needs for each task
export function fillCoordination(own: unknown, timing: QueueTiming): Coordination;
  // undefined → the defaults; not an object, or a value that is not a positive safe integer → ResizeConfigError RESIZE_CONFIG_COORDINATION_INVALID (names the key)
  // gateTtlMs < timing.leaseMs → ResizeConfigError RESIZE_CONFIG_GATE_TTL_BELOW_LEASE (names both values)
// src/resizer.ts
// ResizerOptions gains: coordination?: CoordinationOptions | (() => CoordinationOptions)
/** @internal */ export function taskCoordinationOf(resizer: Resizer): TaskCoordination;
  // { cooldownMs, locks }: the validated coordination, or defaultCoordination when the Resizer has no usable task queue; RESIZE_NOT_READY before ready()
// src/framework/config.ts: ResolvedFrameworkConfig gains coordination: CoordinationOptions | undefined (taken out of the image config and passed on unvalidated)
// src/framework/resizer.ts: FrameworkResizerOptions gains coordination?: CoordinationOptions (it wins over the file's section)
```
**Decision (where it is validated):**
- Only a Resizer with a task queue reads `coordination`. `#buildDispatcher` reads it, calling a function form once, and validates it with `fillCoordination(own, timingOf(tasks))` before it builds the Dispatcher.
- A failure takes the existing Dispatcher-failure path: it is logged once, reads serve stored previews and queue nothing, `prewarm()` reports it, and `verify()` and the worker reject.
- Neither the framework adapter nor any driver checks the values.
- `lockTtlMs` stays in queue timing until Task 11, and the Dispatcher starts using `coordination` in Task 9.

- [ ] **Step 1: Write the failing tests.** In `src/coordination.test.ts` (`timing = timingOf(new MemoryTaskQueue())`, whose `leaseMs` is 60 000):
```ts
test('fills the defaults and keeps the values that are set', …)
  // fillCoordination(undefined, timing) deepEqual defaultCoordination; ({ cooldownMs: 5 }) → { gateTtlMs: 600_000, cooldownMs: 5 }
test('a value that is not a positive safe integer is RESIZE_CONFIG_COORDINATION_INVALID, naming the key', …)
  // for gateTtlMs and cooldownMs: 0, -1, 1.5, '600000', null → the code and /gateTtlMs/ or /cooldownMs/; 'x' as the whole section → the same code
test('gateTtlMs below the lease is RESIZE_CONFIG_GATE_TTL_BELOW_LEASE; equal to it is fine', …)
  // timing leaseMs 120_000, gateTtlMs 60_000 → the code and /60000/ and /120000/; gateTtlMs 120_000 → no throw
```
In `src/resizer.test.ts`, `describe('coordination')` (Resizers with a task queue get `locks: memoryLocks()` until Task 9):
```ts
test('a bad coordination degrades like a bad queue: ready() resolves, verify() rejects, resolve() queues nothing, prewarm() reports it', …)
  // coordination: { cooldownMs: 0 }; verify rejects RESIZE_CONFIG_COORDINATION_INVALID; tasks.added.length 0 after a resolve;
  // the prewarm issue is RESIZE_ENQUEUE_INTERNAL_ERROR, retryable false
test('coordination given as a function is read once, when the task queue is set up; an eager-only Resizer never reads it', …)
test('taskCoordinationOf gives the cooldown and the lock store, or the defaults without a task queue', …)
```
In `src/framework/resizer.test.ts`:
```ts
test("the config file's coordination reaches the Resizer, and the option wins", …)
  // config { …, coordination: { cooldownMs: 1234 } } → taskCoordinationOf(r).cooldownMs === 1234 after ready(); the option { cooldownMs: 99 } → 99
```
In `src/config/resize.test.ts`:
```ts
test('defaultFrameworkResizeConfig carries the coordination defaults', …) // deepEqual defaultCoordination
test("a config file's coordination is passed on unvalidated, outside the image config", …)
  // resolveFrameworkConfig({ …valid, coordination: { gateTtlMs: 0 } }) does not throw; .coordination deepEqual { gateTtlMs: 0 }; 'coordination' in .image === false
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/coordination.test.ts src/resizer.test.ts`. Expected: FAIL with "Cannot find module './coordination.ts'".
- [ ] **Step 3: Implement `fillCoordination` in `src/coordination.ts`, plus the types and the defaults.**
  - Messages name the key and the value, for example "resize coordination: gateTtlMs must be a positive safe integer (ms), got 0".
  - The comment on the lease rule gives the reason: "a gate lock must outlive the lease it guards".
- [ ] **Step 4: Wire the option.**
  - Resizer: `#buildDispatcher` keeps the result in `#coordination`. `taskCoordinationOf` reads it through the static block, as `processorOf` does.
  - Framework: `resolveFrameworkConfig` takes `coordination` out before it validates the image config. `FrameworkResizer` passes `coordination ?? (explicit ? explicit.coordination : () => read().coordination)`.
  - Export `CoordinationOptions` from `src/index.ts`.
  - In `resize.config.ts.tpl`, under the `queue` line, add `// coordination: { gateTtlMs: 600_000, cooldownMs: 600_000 }, // the defaults; see README "Coordination"`.
- [ ] **Step 5: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS.
- [ ] **Step 6: Commit.** `git add -A src && git commit -m "feat: coordination policy (gateTtlMs, cooldownMs) on the Resizer, validated by the core"`

### Task 7: The Consumer holds the gate; dead-letters get the cooldown; a throwing logger never stops the loop

**Files:**
- Modify: `src/consumer.ts:46-305`, `src/lockKeys.ts` (adds `gateKey`), `src/helpers/log.ts`, `src/testHelpers/consume.ts`
- Test: `src/consumer.test.ts`

**Interfaces:**
Consumes: `ClaimOptions`, `FailOptions`, `ClaimedTask.gateOwner`, `gatesByTask` (Task 1); `MemoryTaskQueue`, `PlainTaskQueue`, `clockLocks` (Task 2); `TaskCoordination`, `defaultCoordination` (Task 6).
Produces:
```ts
// src/lockKeys.ts
export function gateKey(resizer: string, mediaId: string, pipeline: string): string; // `resize_gate:${resizer}:${mediaId}:${pipeline}`
// src/helpers/log.ts
export function logNeverThrow(logger: ResizeLogger, message: string, err?: unknown, level?: 'error' | 'warn' | 'info'): void; // default 'error'; a throwing logger falls back to console[level]
// src/consumer.ts — ConsumerDeps gains:
resizers?: readonly string[];                                           // passed to claim as { resizers }
coordinationOf?: (task: LeasedTask) => TaskCoordination | undefined;    // must not throw; undefined: the default cooldown, no gate lock
// src/testHelpers/consume.ts: opts gain resizers? and coordinationOf?, passed through
```
The Consumer calls the gate lock only when all three hold: the queue has no `gatesByTask`, the task has a `gateOwner`, and `coordinationOf(task)` gives `locks`. The key is `gateKey(task.resizer, task.mediaId, task.pipeline)`, and the owner is `task.gateOwner`.

| Moment | Gate lock call |
|---|---|
| the task starts (after the `accepts` and `maxAttempts` checks) | `extend(key, owner, leaseMs)` |
| each heartbeat | `extend(key, owner, leaseMs)` |
| `complete` returned `true` | `release(key, owner)` |
| `fail({ retryAt })` returned `true` | `extend(key, owner, retryAt − now + leaseMs)` |
| `fail('dead')` returned `true` | `extend(key, owner, cooldownMs)` |
| the task was given back, or its lease was lost | nothing |

- `fail('dead')` always receives `{ cooldownMs: coordinationOf(task)?.cooldownMs ?? defaultCoordination.cooldownMs }`.
- A gate call that returns `false` is ignored, and one that rejects is logged. Neither changes the task's outcome or its event.
- The Consumer calls the host logger only through `logNeverThrow`, with shutdown messages at `'info'`.

**Decision (extend on start):** the Consumer extends the lock when the task starts, not only on heartbeats. A task that waited nearly `gateTtlMs` in the queue would otherwise lose its gate before the first heartbeat, `leaseMs / 2` later.

- [ ] **Step 1: Write the failing tests.** In `src/consumer.test.ts`:
```ts
describe('the gate lock on a task queue without gatesByTask', () => {
  // PlainTaskQueue({ timing: { leaseMs: 200, idlePollMs: 5, retryBackoffMs: { base: 60_000, max: 60_000 } } }); locks = clockLocks()
  // key = gateKey('default', 'm1', 'default'); locks.acquire(key, 'g1', 50); tasks.add({ …newTask(), gateOwner: 'g1' })
  // coordinationOf: () => ({ cooldownMs: 30_000, locks })
  test('is extended when the task starts and on every heartbeat, and released on completion', …)
    // in the handler: entry(key).expiresAt − Date.now() > 100 at once, and still > 0 after 250 ms (past the first lease); after the run: entry(key) undefined
  test('a retry holds it for the backoff plus one lease', …)
    // the handler throws once → after 'failed': expiresAt − Date.now() within [60_100, 60_200]
  test("a dead-letter holds it for the Resizer's cooldownMs", …)
    // throws new ResizeMediaError('x', { retryable: false }) → within [29_900, 30_000]
  test('a lock another request took over after it expired stays theirs', …)
    // let t = 0; clockLocks(() => t); acquire(key, 'g1', 10); t = 100; acquire(key, 'g2', 10_000) true
    // the task with gateOwner 'g1' completes → status 'completed', events ['completed'], entry(key).owner === 'g2'
  test('a rejecting lock store is logged and never changes the outcome', …) // extend and release reject → 'completed'; an error logged with /gate/
  test('a task without gateOwner touches no lock', …) // a recording store sees no call
});
describe('the dead-letter cooldown on a task queue with gatesByTask', () => {
  test("fail('dead') receives the Resizer's cooldownMs, and no lock is touched", …)
    // MemoryTaskQueue({ now: () => 1_000 }); a recording store; → rows[0].cooldownUntil === 31_000; lock calls []
  test('without coordination for the task, a dead-letter gets the default cooldown', …) // cooldownUntil − 1_000 === 600_000
});
test('claim receives the served Resizer names', …) // resizers ['a', 'b'] → the claim spy's opts deepEqual { resizers: ['a', 'b'] }
test('a throwing logger never stops the loop or fails a task', …)
  // every logger method throws; claim rejects once, then returns a task → status 'completed'; run() resolves after the abort
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/consumer.test.ts`. Expected: FAIL with "does not provide an export named 'gateKey'". Once that export exists, the tests still fail: the lock is never extended, and `cooldownUntil` stays at `now`.
- [ ] **Step 3: Implement it.**
  - `gateKey` goes into `src/lockKeys.ts`; the other lock keys stay until Task 10.
  - `logNeverThrow` gains `level`.
  - In `src/consumer.ts`, the private `#gate(task)`, `#holdGate(task, ttlMs)` and `#releaseGate(task)` follow the table, and `#finish` passes `FailOptions`.
  - Every `logger.x(` call becomes a `logNeverThrow` call. Update the header comment ("the gate lock of a queue without gatesByTask").
- [ ] **Step 4: Run the tests to verify they pass.** Run Step 2's command, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A src && git commit -m "feat(worker): the Consumer holds the gate through lease, backoff and cooldown; claims carry the served Resizers"`

### Task 8: `runWorker` wires each task's coordination and the claim filter

**Files:**
- Modify: `src/worker.ts:66-112, 130-315`
- Test: `src/worker.test.ts` (new tests; `describe('a worker that serves only some of the Resizers on a task queue')` moves to `PlainTaskQueue`), `src/processor.test.ts:3800-3840`, `src/architecture.test.ts`

**Interfaces:**
Consumes: `taskCoordinationOf` (Task 6); `ConsumerDeps.resizers` and `.coordinationOf`, `logNeverThrow` with a level (Task 7); `claimFilters` (Task 1); `PlainTaskQueue`, `clockLocks` (Task 2).
Produces: no new export. Each Consumer gets:
- `resizers`: the served names;
- `coordinationOf`: the served owner's `taskCoordinationOf`, or `undefined` for a task of a Resizer it does not serve; it never throws;
- `accepts`: only on a queue with `release` and without `claimFilters`.

`refuseUnservedSharers` checks only the consumed queues without `claimFilters`, and does not run when there are none. Every host-logger call in `worker.ts` goes through `logNeverThrow`.

**Decision (the first-failure path):** `runWorker` keeps its first-failure path for a Consumer that cannot start. After this task no test can reach that path, because timing is validated and cached when the Resizer starts. Its comment says so, and the test that reached it through a throwing logger is replaced.

- [ ] **Step 1: Write the failing tests.** In `src/worker.test.ts`:
```ts
test('on a task queue that filters claims, a worker starts beside unlisted Resizers and never claims their tasks', …)
  // Resizers a and b on one MemoryTaskQueue, one task each; runWorker({ resizers: [a] }) until a's row is 'completed'
  // → no RESIZE_QUEUE_SHARED_RESIZER_UNLISTED; b's row: 'pending', attempts 0
test("each dead-letter gets the cooldown of the task's own Resizer", …)
  // a (cooldownMs 30_000) and b (cooldownMs 90_000) on MemoryTaskQueue({ now: () => 0 }), sources over limits.sourcePixels
  // → the dead rows' cooldownUntil: 30_000 and 90_000
test("on a queue without gatesByTask, the gate lock lives in the task's Resizer's lock store", …)
  // PlainTaskQueue; the Resizer has locks: clockLocks() and coordination { cooldownMs: 30_000 }; a task added with gateOwner 'g1', its lock taken
  // → after the dead-letter, entry(key).expiresAt − Date.now() within [29_900, 30_000]
```
- Move `describe('a worker that serves only some of the Resizers on a task queue')` to `PlainTaskQueue` (non-filtering). It is still refused with `RESIZE_QUEUE_SHARED_RESIZER_UNLISTED`.
- In `src/processor.test.ts`, replace 'a loop that fails stops the other loops, and its error rejects the worker' with:
```ts
test('a throwing logger does not stop the loop', …)
  // every worker logger method throws; one queue's claim rejects once, then returns a task; the sibling queue's task completes too
  // → both rows 'completed'; runWorker resolves after the abort
```
- In `src/architecture.test.ts`, add a file helper `read(f)` (`readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')`, the read the file already does inline), then:
```ts
test('the worker loop logs only through logNeverThrow', () => {
  const direct = ['consumer.ts', 'worker.ts'].filter((f) => /\blogger\.(info|warn|error)\(/.test(read(f)));
  assert.deepEqual(direct, []);
});
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/worker.test.ts src/processor.test.ts src/architecture.test.ts`. Expected: FAIL. The filtering worker is refused at start, every dead row gets the default cooldown, and `worker.ts` calls `logger.error(` directly.
- [ ] **Step 3: Implement it in `src/worker.ts`** as the Interfaces say. Update the header and the `RunWorkerOptions.resizers` comment ("a task queue that filters claims never hands this worker another Resizer's task").
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A src && git commit -m "feat(worker): served Resizer names filter claims; each task gets its Resizer's coordination"`

### Task 9: The Dispatcher keeps one gate per media and pipeline; prewarm reports tasks in flight

**Files:**
- Modify: `src/dispatcher.ts:1-20, 50-56, 93-543`; `src/resizer.ts:114-118, 404-420, 506-511` (and the `prewarm` doc comment); `src/types.d.ts:137-154`; `src/reader.ts:422-455`
- Test:
  - `src/dispatcher.test.ts` (rewritten around the gate);
  - `src/prewarm.test.ts`, `src/prewarmCoverage.test.ts`, `src/reader.test.ts`, `src/resizer.test.ts`;
  - `src/worker.test.ts:746-890`;
  - `src/drivers/sqs.test.ts:241-290`;
  - `src/drivers/mongo/taskQueue.test.ts:722-757`;
  - `src/framework/queueIndexes.mongo.integration.test.ts:226-275`.

**Interfaces:**
Consumes: `gateKey` (Task 7); `Coordination` (Task 6); `TaskAddResult`, `gatesByTask`, `findActive` (Task 1); `MemoryTaskQueue`, `PlainTaskQueue`, `clockLocks` (Task 2).
Produces:
```ts
// src/dispatcher.ts — `timing` leaves the deps
export interface DispatcherDeps { tasks: TaskQueue; locks: LockStore | undefined; coordination: Coordination; name: string; logger: ResizeLogger }
// Dispatcher.enqueue / enqueueConfirmed, DispatchRequest, ConfirmedEnqueueResult, noQueueResult: signatures unchanged
// src/types.d.ts: EnqueueIssue['code'] gains 'RESIZE_TASK_IN_FLIGHT'
// src/resizer.ts: RESIZE_LOCKS_REQUIRED only when the queue has no gatesByTask and there are no locks;
//   the message names SqsTaskQueue and "one gate lock per media and pipeline"
```
One dispatch, after the variants are made canonical and de-duplicated by identity as today:

| Queue | Steps | Outcome |
|---|---|---|
| `gatesByTask` | `add(task)` | the `add` result |
| without it | `owner = randomHex()`; `acquire(gateKey(name, mediaId, pipeline), owner, coordination.gateTtlMs)`; `add({ …task, gateOwner: owner })` | `false` → held; a rejection → lock failed; any `add` result other than `'added'`, or a throw → `release(key, owner)` |

The `prewarm` report (`enqueueConfirmed`):

| Outcome | `accepted` / receipt | Issue (retryable) |
|---|---|---|
| `added` | every variant / the new task | — |
| `in-flight` | the variants that the active task holds with the same canonical payload (today's matching and conflict rules) / that task | the rest: `RESIZE_TASK_IN_FLIGHT` (true), "a task for this media and pipeline is active, or cooling down after a dead-letter; a read after it finishes queues these" |
| `findActive` rejects | — | `RESIZE_ENQUEUE_CONFIRM_FAILED` (true) |
| `unconfirmed` | — | `RESIZE_ENQUEUE_UNCONFIRMED` (true) |
| `add` throws | — | `RESIZE_ENQUEUE_QUEUE_FAILED` (true) |
| gate lock held | — | `RESIZE_ENQUEUE_LOCK_CONTENDED` (true), "the gate lock of this media and pipeline is held: another request queued it, or a dead task's cooldown runs" |
| `acquire` rejects | — | `RESIZE_ENQUEUE_LOCK_FAILED` (true) |
| an `add` result in none of the three shapes | — | `RESIZE_ENQUEUE_UNCONFIRMED` (false), naming the contract |

- An `in-flight` result from a queue without `findActive` reports every variant with `RESIZE_TASK_IN_FLIGHT`.
- A request with two payloads for one identity still gets `RESIZE_ENQUEUE_VARIANT_CONFLICT` (not retryable), and those variants stay out of the task.
- The read path (`enqueue`) takes the same steps and logs failures as today. It returns the variant count on `added` and `0` otherwise, and never throws.

**Decision (an older contract's result):** a queue written to the older contract resolves `{ taskId }`. The Dispatcher never counts that as queued, and logs it once (not on every read), naming `TaskAddResult`.
**Decision (`prewarmFailure`):** retryability is decided by `ResizeError.isResizeError(err)` and `err.name` (`ResizeMediaError`, `ResizeNoOriginalError`, `ResizeOriginalError`, `ResizeConfigError` or `ResizeSetupError`), not by `instanceof`. An error from a duplicate copy of the package then gets the same advice.

- [ ] **Step 1: Write the failing tests.** `src/dispatcher.test.ts` gets a new harness: `makeDispatcher({ tasks?, locks?, coordination?, name? })`, where `coordination` defaults to `defaultCoordination`, and a recording `ClockLocks` wrapper lists every lock call. Keep the canonicalization tests and replace the rest with:
```ts
describe('a task queue that gates by task', () => {
  test('one add per read and no lock call; a second read of the media is in-flight and queues nothing', …)
    // MemoryTaskQueue: enqueue → 1, enqueue → 0; rows.length 1; added.length 2; lock calls []
  test('needs no lock store', …) // locks: undefined → enqueue → 1
});
describe('a task queue without gatesByTask', () => {
  test('one gate lock per Resizer, media and pipeline, owned by a fresh token that the task carries', …)
    // PlainTaskQueue + clockLocks(): entry('resize_gate:default:m1:default').owner matches /^[0-9a-f]{32}$/ and === added[0].gateOwner;
    // its expiresAt − Date.now() ≈ gateTtlMs; a second enqueue → 0, rows.length 1
  test('the gate lock is released when add throws, resolves unconfirmed or in-flight', …) // each case: enqueue → 0, entry(key) undefined
  test('a held gate lock queues nothing; a rejecting acquire is logged and queues nothing', …)
  test('gate keys are separate per Resizer and per pipeline', …)
});
test('an add result without a status (an older TaskQueue) never counts as queued, and is logged once', …)
  // tasks.add = async () => ({ taskId: 'x' }) as never; enqueue twice → 0, 0; errors.filter((e) => /TaskAddResult/.test(String(e[0]))).length === 1
  // enqueueConfirmed → issues[0] { code: 'RESIZE_ENQUEUE_UNCONFIRMED', retryable: false }
describe('enqueueConfirmed', () => {
  test('a cold media: every variant accepted, and the new task is the receipt', …)
  test('an active task: the variants it holds are accepted with it as the receipt; the rest are RESIZE_TASK_IN_FLIGHT', …)
    // enqueue [300x300 jpeg]; prewarm [300x300 jpeg, 600x600 jpeg] → accepted [300…], tasks [{ taskId: 'task-1', previews: [300…] }],
    // unconfirmed [600…], issues [{ code: 'RESIZE_TASK_IN_FLIGHT', retryable: true, previews: [600…] }]
  test('during a dead-letter cooldown nothing is accepted: every variant is RESIZE_TASK_IN_FLIGHT', …)
    // MemoryTaskQueue({ now }); add, claim, fail('dead', 'x', { cooldownMs: 60_000 }) → prewarm → accepted [], tasks [], one RESIZE_TASK_IN_FLIGHT issue for all
  test('a held gate lock on a queue without gatesByTask is RESIZE_ENQUEUE_LOCK_CONTENDED', …)
  test('an active task that holds another payload for a requested identity confirms nothing for it', …) // RESIZE_ENQUEUE_VARIANT_CONFLICT, not accepted
});
```
In `src/resizer.test.ts`, 'a lazy locks part that resolves to nothing beside a task queue…' becomes:
```ts
test('a task queue with gatesByTask needs no locks; one without is RESIZE_LOCKS_REQUIRED from verify()', …)
  // MemoryTaskQueue, no locks → verify resolves; PlainTaskQueue with locks: () => undefined → ready() resolves, verify rejects RESIZE_LOCKS_REQUIRED, /SqsTaskQueue/
```
In `src/reader.test.ts`:
```ts
test('prewarmFailure advises against a retry for setup, config and media errors, also from a duplicate package copy', …)
  // { [Symbol.for('@adaptivestone/framework-module-resize.error')]: true, name: 'ResizeSetupError', message: 'm', code: 'X' } → retryable false
  // new Error('m') → true; a branded 'ResizeStorageError' → true
```
In `src/worker.test.ts`, 'after a dead-letter, reads do not queue that variant again until the cooldown ends' becomes 'after a dead-letter, reads queue nothing for that media and pipeline until cooldownMs ends'. It uses `MemoryTaskQueue({ now: () => t })` and a Resizer with `coordination: { cooldownMs: 10_000 }`, and counts `rows.length`, not `added.length`.
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/dispatcher.test.ts src/reader.test.ts`. Expected: FAIL. `DispatcherDeps` has no `coordination`, the per-identity `resize_dispatch:` keys are still acquired, and the duplicate-copy error is advised as retryable.
- [ ] **Step 3: Implement the Dispatcher.**
  - Delete `acquireDispatchLocks`, `releaseAll` and the uses of `DISPATCH_LOCK_OWNER` and `dispatchLockKey`.
  - One private `#dispatch(scope, previews)` returns the outcome, and `enqueue` and `enqueueConfirmed` map it as the two tables say. A private `#warnedInvalidAdd` flag makes the older-contract log happen once.
  - Rewrite the header comment around the gate.
  - In `src/resizer.ts`, `#buildDispatcher` passes `locks: this.#locks` and `coordination: this.#coordination`, and requires locks only beside a queue without `gatesByTask`. The `prewarm` doc comment says that a task in flight is reported, not counted as queued.
  - In `src/reader.ts`, update `prewarmFailure`.
  - **Controller ruling (framework lock store only where a gate lock is needed):** in `src/framework/resizer.ts` the default `locks` becomes a lazy part that first resolves the queue the adapter builds (the same memoised `buildQueue` / `appTaskQueue` result the `tasks` part uses) and yields `new FrameworkLockStore()` only when that queue has no `gatesByTask` (today: the `'sqs'` driver, or a `tasks` passed in code without the flag); with the database queue it yields `undefined`, so `verify()` no longer asks for the framework `Lock` model. A `locks` given in code still wins. Tests in `src/framework/resizer.test.ts`: `queue: { driver: 'database' }` with a fake app that has no `Lock` model → `verify()` resolves and `r.locks` is `undefined`; `queue: { driver: 'sqs', queueUrl }` → `r.locks` is a `FrameworkLockStore` and `verify()` without a `Lock` model rejects with `RESIZE_MONGO_MODEL_MISSING`.
- [ ] **Step 4: Migrate the listed tests.**
  - `prewarm.test.ts`: the describes 'dispatch-lock winners only' and 'queue and lock failures never throw' become gate cases ("a held gate lock queues nothing"; "add throwing releases the gate lock").
  - `prewarmCoverage.test.ts`: the describes 'dispatch-lock races and retries' and 'dispatch locks' become the `in-flight` and gate-lock cases. Delete 'partial lock coverage …': a gate covers a whole request.
  - SQS: the prewarm tests expect `RESIZE_ENQUEUE_LOCK_CONTENDED` on a held gate lock.
  - Mongo: 'prewarm confirms an existing Mongo task after losing its dispatch lock' becomes 'prewarm confirms the active Mongo task through findActive'.
- [ ] **Step 5: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test`. Expected: PASS.
- [ ] **Step 6: Commit.** `git add -A src && git commit -m "feat!: the Dispatcher holds one gate per media and pipeline; prewarm reports tasks in flight"`

### Task 10: The Processor and the worker take no locks

**Files:**
- Modify: `src/processor.ts:1-10, 124-139, 150-185, 266-403, 426-487, 689-741, 905-1013`; `src/worker.ts:1-64, 197-233`; `src/resizer.ts:339-349`; `src/lockKeys.ts`; the comments that still mention dispatch or worker locks (`src/images.ts`, `src/reader.ts`, `src/resizeConfig.ts`, `src/resizer.ts`)
- Test: `src/processor.test.ts`, `src/worker.test.ts` (`describe('dead-letter cooldown')`), `src/framework/locks.mongo.integration.test.ts`, `src/framework/queueIndexes.mongo.integration.test.ts:103-160`, `src/framework/worker.mongo.integration.test.ts`

**Interfaces:**
Consumes: `gateKey` (Task 7); the Dispatcher's and the Consumer's gate (Tasks 7–9).
Produces:
```ts
// src/processor.ts
export interface ProcessorDeps { catalog: Catalog; media: MediaStore; storage: ResizeStorage; pipelines: PipelineRegistry; hooks: HookBus; config: ResizeConfig; logger: ResizeLogger; name: string } // no locks
processTask(task: LeasedTask, opts?: { signal?: AbortSignal }): Promise<void>; // no workerLockTtlMs, no RESIZE_LOCKS_REQUIRED
// holdFailedCooldown and releaseLock are deleted; generate() and notify() are unchanged
// src/worker.ts (internal): processTask(task: LeasedTask, taskOpts?: { signal: AbortSignal }): Promise<void> // the delivering-queue parameter is gone
// src/lockKeys.ts exports only gateKey
```
**Decision (`ProcessorDeps` drops `locks`):** the spec's service table gave the Processor locks and coordination. Without worker locks and the lock-based cooldown it uses neither. Duplicate work is still prevented:
- the queue leases each task to one worker at a time;
- the lease token fences the task's writes;
- `appendPreviews` keeps one row per identity when an expired lease lets two workers render the same variant.

- [ ] **Step 1: Write the failing tests.** In `src/processor.test.ts`:
```ts
test('a Processor renders a queued task with no lock store', …) // the S1 test without `locks`; uploads.length 1
test('two workers rendering one task at once leave one row per identity, and both succeed', …)
  // a shared previews map; fakeMedia({ load: async () => ({ ...mediaDoc(), previews: rows.get('m1') ?? [] }), previews: rows })
  // Promise.all([p.processTask(task()), p.processTask(task())]) resolves; rows.get('m1').length === 1; a warning /already stored by another worker/
test('lockKeys exports only gateKey', async () => assert.deepEqual(Object.keys(await import('./lockKeys.ts')), ['gateKey']));
```
In `src/worker.test.ts`, `describe('dead-letter cooldown')` is replaced by:
```ts
test('after a dead-letter on a queue without gatesByTask, reads queue nothing for that media and pipeline until cooldownMs ends', …)
  // PlainTaskQueue; let t = 0; the Resizer has locks: clockLocks(() => t) and coordination { cooldownMs: 10_000 }; sources over limits.sourcePixels
  // a read → 1 row; the worker dead-letters it; more reads → still 1; t = 10_001 → a read → 2 rows
```
Delete:
- 'a failing lock call is logged; nothing throws and the observer still fires' (Task 7 covers a rejecting store);
- 'the observer does not wait for the cooldown; the worker returns only after it' (the hold now happens before the event);
- 'a dead task of a Resizer unknown in this process takes no lock' (Task 7 covers 'a task without gateOwner …');
- in `processor.test.ts`: 'processTask without a lock store is RESIZE_LOCKS_REQUIRED', 'holdFailedCooldown …', 'a worker lock is released with the owner that took it …', and every test about a worker lock or a dispatch release.

In `framework/locks.mongo.integration.test.ts`, the fixed-owner dispatch-lock test becomes:
```ts
test('a gate lock taken by one store (the API) is extended and released by another (the worker) with the owner from the task', …)
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/processor.test.ts`. Expected: FAIL. `processTask` without a lock store rejects with `RESIZE_LOCKS_REQUIRED`, and `lockKeys` exports four names.
- [ ] **Step 3: Implement it.**
  - In the Processor, delete the lock code at the listed lines, `GenerateCoreArgs.locks`, the persist block's `finally` (it only released locks), and the lock check in `processTask`.
  - The comment "Re-read once so a worker-lock loser can observe…" now speaks of a concurrent worker running the same task.
  - In the worker, `runTask` drops the TTL lookup, and `eventsOf` drops the cooldown and the `cooldowns` set.
  - `resizer.ts` stops passing `locks` to the Processor.
  - `lockKeys.ts` keeps `gateKey`, with a header that explains the gate.
  - Search the non-test sources for "dispatch lock", "worker lock", "dispatch-lock" and "worker-lock", and reword every hit to the gate.
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A src && git commit -m "refactor!: per-identity dispatch and worker locks are gone; the lease and the identity guard deduplicate"`

### Task 11: Lock TTLs leave queue timing

**Files:**
- Modify: `src/types.d.ts:287-302`; `src/timing.ts`; `src/resizeConfig.ts:174-231`; `src/config/resize.ts:39-47`; `src/framework/config.ts:83-113`; the timing option comments in `src/drivers/mongo/taskQueue.ts:27` and `src/drivers/sqs.ts:36`
- Test: `src/timing.test.ts`, `src/config/resize.test.ts:142-157, 265-296`, `src/drivers/sqs.test.ts:998-1026`. Also every timing fixture that sets `lockTtlMs`: the `worker`, `consumer`, `processor`, `framework/resizer`, `framework/worker.mongo.integration`, `drivers/mongo/frameworkFree.integration` and `drivers/mongo/taskQueue` tests.

**Interfaces:**
Consumes: `CoordinationOptions` (Task 6).
Produces:
```ts
// src/types.d.ts
export interface QueueTimingOptions { leaseMs: number; retryBackoffMs: { base: number; max: number }; maxAttempts: number; idlePollMs: number; taskTimeoutMs: number }
// src/timing.ts
export type QueueTiming = QueueTimingOptions; // validateFailedLockTtl deleted
export function fillTiming(own: Partial<QueueTimingOptions> | Record<string, unknown>): QueueTiming;
  // `lockTtlMs` set → ResizeConfigError RESIZE_CONFIG_REMOVED_KEY: "…pass coordination: { gateTtlMs, cooldownMs } to the Resizer (lockTtlMs.failed → cooldownMs, lockTtlMs.dispatch → gateTtlMs; drop lockTtlMs.worker)"
// src/framework/config.ts: a `queue.lockTtlMs` → RESIZE_CONFIG_REMOVED_KEY naming the file and "coordination in the same file"
// Deleted codes: RESIZE_CONFIG_QUEUE_LOCK_TTL_INVALID, RESIZE_CONFIG_LOCK_EXCEEDS_LEASE
```
**Decision (reject it everywhere):** every timing source rejects `lockTtlMs`, not only the framework file. Otherwise a plain-Node host that passes it to `MongoTaskQueue` or `SqsTaskQueue` would lose its cooldown setting without a word.

- [ ] **Step 1: Write the failing tests.**
```ts
// src/timing.test.ts (replaces the four lockTtlMs tests)
test("lockTtlMs in a task queue's timing is RESIZE_CONFIG_REMOVED_KEY, pointing to coordination", …)
  // timingOf(new MemoryTaskQueue({ timing: { lockTtlMs: { failed: 1 } } as never })) throws; /coordination/ and /cooldownMs/
test('the filled timing has no lock TTLs', …)
  // Object.keys(timingOf(new MemoryTaskQueue())).sort() deepEqual ['idlePollMs', 'leaseMs', 'maxAttempts', 'retryBackoffMs', 'taskTimeoutMs']
// src/config/resize.test.ts
test('queue.lockTtlMs in a config file is RESIZE_CONFIG_REMOVED_KEY naming the file and coordination', …)
test('defaultQueueOptions has no lockTtlMs', …)
// src/drivers/sqs.test.ts (replaces 'accepts any timing at construction; the core rejects bad lock TTLs when it reads the timing')
test('accepts any timing at construction; the core validates it when it reads the timing', …)
  // timingOf(new SqsTaskQueue({ queueUrl: 'q', timing: { leaseMs: 0 } })) throws RESIZE_CONFIG_QUEUE_LEASE_INVALID
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/timing.test.ts src/config/resize.test.ts src/drivers/sqs.test.ts`. Expected: FAIL. `lockTtlMs` is accepted, and the filled timing has a `lockTtlMs` key.
- [ ] **Step 3: Implement it.**
  - Remove `lockTtlMs` from the type, the defaults, `TIMING_KEYS`, `validateQueueTiming` (including the lease check that compared against it) and the driver comments.
  - Add the two removed-key checks; the framework check runs before `fillTiming`.
- [ ] **Step 4: Remove `lockTtlMs` from the listed fixtures, then run everything.** Run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A src && git commit -m "feat!: lock TTLs leave queue timing; lockTtlMs is a removed key"`

### Task 12: The S2 "done when" scenarios, and the guards that keep them

**Files:**
- Create: `src/gate.test.ts`
- Modify (tests only): `src/drivers/mongo/taskQueue.test.ts` (new describe), `src/drivers/sqs.test.ts` (`describe('Consumer with SqsTaskQueue')`), `src/architecture.test.ts`

**Interfaces:**
Consumes: everything from Tasks 1–11, including `Resizer`, `runWorker`, `consume`, `gateKey`, `MemoryTaskQueue`, `PlainTaskQueue`, `clockLocks`, `fakeMedia` and `makeImageConfig`.
Produces: tests only.

- [ ] **Step 1: Write the scenario tests.** `src/gate.test.ts` builds every Resizer from one factory: `formats: ['webp']`, a media `{ id: 'm1', original: { storageRef: { key: 'o' } } }`, and `sizes [{ width: 10, height: 10 }]`.
```ts
test('1000 concurrent reads of a cold media create one task (a queue that gates by task)', …)
  // MemoryTaskQueue, no locks; Promise.all of 1000 resolve() → every decision.missing.length === 1; rows.length === 1
test('1000 concurrent reads of a cold media create one task (a queue without gatesByTask)', …)
  // PlainTaskQueue + clockLocks() → rows.length === 1; added.length === 1
test('a task in retry backoff blocks new tasks for its media and pipeline', …)
  // download rejects with ResizeStorageError; retryBackoffMs { base: 60_000, max: 60_000 }; onTaskFailed aborts the worker
  // → 10 reads (one of a new size) → rows.length === 1, rows[0].status 'pending'
test('the SQS path holds the gate through the backoff and releases it on completion', …)
  // PlainTaskQueue({ timing: { leaseMs: 1000, idlePollMs: 5, retryBackoffMs: { base: 100, max: 100 } } }), locks = clockLocks();
  // download rejects once, then returns png. In onTaskFailed: entry(gateKey('default','m1','default')).expiresAt − Date.now() within [1000, 1100],
  // and 10 reads → rows.length 1. In afterTaskComplete: entry undefined; then a read of a new size → rows.length 2
```
In `src/drivers/mongo/taskQueue.test.ts`, with a Resizer on the file's `tasks`, `fakeMedia()` and no locks:
```ts
describe('the gate under concurrent reads (MongoDB)', () => {
  test('1000 concurrent reads of a cold media create one task row', …) // M.countDocuments({ fileId }) === 1
  test('a task in retry backoff blocks new tasks', …) // claim; fail({ retryAt: +60 s }); 10 reads → countDocuments 1, status 'pending'
});
```
In `src/drivers/sqs.test.ts`:
```ts
test('a retry holds the gate lock for the backoff plus one lease; completion releases it', …)
  // two receives of a body with gateOwner 'g1'; consume(queue, { coordinationOf: () => ({ cooldownMs: 600_000, locks }) });
  // the handler throws first, then resolves → after 'failed' the lock lasts ≈ backoff + lease; after 'completed' entry undefined
```
In `src/architecture.test.ts`:
```ts
test('per-identity locks are gone: no source builds a dispatch or worker lock', () =>
  assert.deepEqual(sourceFiles().filter((f) => /resize_dispatch|resize_worker|DISPATCH_LOCK_OWNER|dispatchLockKey|workerLockKey/.test(read(f))), []));
test('lock settings are validated only in the core', () => {
  assert.deepEqual(sourceFiles().filter((f) => f.startsWith('drivers/') && /lockTtlMs|gateTtlMs/.test(read(f))), []);
  assert.deepEqual(sourceFiles().filter((f) => f !== 'coordination.ts' && /RESIZE_CONFIG_(COORDINATION_INVALID|GATE_TTL_BELOW_LEASE)/.test(read(f))), []);
});
```
- [ ] **Step 2: Run the tests.** Run: `node --experimental-strip-types --test src/gate.test.ts src/drivers/mongo/taskQueue.test.ts src/drivers/sqs.test.ts src/architecture.test.ts`. Expected: PASS, because the behaviour landed in Tasks 3–11. If one fails, fix the owning task's code here.
- [ ] **Step 3: Prove that the guards catch a violation.**
  - Add `// lockTtlMs` to `src/drivers/sqs.ts` and run `src/architecture.test.ts`. Expected: FAIL, naming `drivers/sqs.ts`. Revert.
  - Add `const k = 'resize_dispatch:x';` to `src/catalog.ts` and run it again. Expected: FAIL, naming `catalog.ts`. Revert.
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/gate.test.ts src/drivers/mongo/taskQueue.test.ts src/drivers/sqs.test.ts src/architecture.test.ts && git commit -m "test: S2 scenarios: one task per cold media under 1000 reads; backoff holds the gate; the SQS path releases it on completion"`

### Task 13: Documentation

**Files:**
- Modify:
  - `README.md:124-177, 179-190, 192-222, 285-352, 354-430, 432-482`;
  - `AGENTS.md` (the header, steps 3, 5 and 7, the prewarm paragraph, Errors, Troubleshooting);
  - `CHANGELOG.md` (`# 0.3.0` → **Breaking changes**);
  - `docs/host-adoption.md:36-90`;
  - `/Users/andrey/Work/framework-documenation-github/docs/12-resize.md:518, 542, 598, 609` (another repository).
- Test: `src/agentsDoc.test.ts`

**Interfaces:**
Consumes the public names from Tasks 1–11:
- the types `TaskAddResult`, `ClaimOptions`, `FailOptions`, `CoordinationOptions`, and `defaultCoordination`;
- `gatesByTask`, `claimFilters`, `gateOwner`;
- `new Resizer({ coordination })` and the config file's `coordination`;
- the codes `RESIZE_TASK_IN_FLIGHT`, `RESIZE_CONFIG_COORDINATION_INVALID`, `RESIZE_CONFIG_GATE_TTL_BELOW_LEASE` and `RESIZE_CONFIG_REMOVED_KEY` (`lockTtlMs`);
- the index `{ resizer: 1, fileId: 1, pipeline: 1 }`, partial on `active: true`.

- [ ] **Step 1: Update README.md.**
  - **"Without the framework" and "Drivers".** `locks` is required only beside a task queue without `gatesByTask` (`SqsTaskQueue`, most custom queues); `mongoParts` still returns one. In the `verify()` code list, `RESIZE_CONFIG_LOCK_EXCEEDS_LEASE` becomes the two coordination codes.
  - **"The worker".** Claims carry the served Resizer names. A queue with `claimFilters` never hands over another Resizer's task, so `RESIZE_QUEUE_SHARED_RESIZER_UNLISTED` applies only to queues that cannot filter. Task events carry `attempts`.
  - **"Package exports".** `…/config/resize.js` also exports `defaultCoordination`.
  - **The locks paragraph becomes the gate.**
    - One active task per Resizer, media and pipeline: the task row on Mongo, one owned gate lock elsewhere.
    - The lock's owner travels in the task as `gateOwner`.
    - The worker extends the lock through the lease and the retry backoff, holds it for `cooldownMs` after a dead-letter, and releases it on completion.
    - There are no per-identity locks.
    - A new size for a media whose task is active waits for that task; the next read queues it.
  - **The custom `TaskQueue` bullets.**
    - The `add` result.
    - `gatesByTask`, and what a queue that declares it must keep.
    - `claimFilters` with `claim(…, opts)`.
    - `fail(…, opts)` with `cooldownMs`.
    - `findActive` returns the one active task.
    - A queue without `gatesByTask` must return `gateOwner` on the claimed task.
  - **Config reference.**
    - Delete the `lockTtlMs` row.
    - Add a **Coordination** table: `gateTtlMs` (600000, at least `leaseMs`) and `cooldownMs` (600000), with `new Resizer({ coordination })` and the two validation codes.
    - The framework config file gets a `coordination` section per file.
    - The removed-keys sentence gains `lockTtlMs`.
  - **Operations.**
    - Task states with `active` and `cooldownUntil`.
    - "Retrying a dead task": after the cooldown, `prewarm()` takes the row over. To replay a dead row yourself, `$set: { status: 'pending', active: true, attempts: 0, cooldownUntil: null, leaseExpiresAt: null, availableAt: new Date() }`; a duplicate key means another task for that media and pipeline is active.
    - Keep the per-variant `RESIZE_WORKER_INCOMPLETE` paragraph unchanged.
- [ ] **Step 2: Update AGENTS.md.**
  - Header: the gate replaces the `requestKey` dedupe, and no per-identity locks remain.
  - Step 3: when `locks` is needed.
  - Step 5: the `coordination` section; the list of timing keys drops `lockTtlMs`.
  - Step 7: create the gate index. Drop the `{ fileId, pipeline, requestKey }` index when convenient: new rows never enter it.
  - The prewarm paragraph: `in-flight` and `RESIZE_TASK_IN_FLIGHT`.
  - Troubleshooting:
    - reword `RESIZE_LOCKS_REQUIRED`;
    - delete the `RESIZE_CONFIG_QUEUE_LOCK_TTL_INVALID` row;
    - `RESIZE_CONFIG_LOCK_EXCEEDS_LEASE` → `RESIZE_CONFIG_GATE_TTL_BELOW_LEASE`;
    - add `RESIZE_CONFIG_COORDINATION_INVALID` and `RESIZE_TASK_IN_FLIGHT` rows;
    - the `RESIZE_MONGO_MODEL_OUTDATED` field list becomes `resizer`, `queue`, `availableAt`, `active`, `cooldownUntil`;
    - the "~10 min" row names `coordination.cooldownMs`;
    - `RESIZE_CONFIG_REMOVED_KEY` names `lockTtlMs`.
- [ ] **Step 3: Update CHANGELOG.md** under `# 0.3.0`, **Breaking changes**:
  - `TaskQueue.add` returns `TaskAddResult`. New: `gatesByTask`, `claimFilters`, the `claim` and `fail` options, `gateOwner`. `findActive` returns the one active task.
  - `NewTask.requestKey` is removed, with its index.
  - `ResizeTask` gains `active`, `cooldownUntil` and the gate index. The host creates the index; an ejected model adds the fields.
  - `lockTtlMs` → `coordination`: `failed` → `cooldownMs`, `dispatch` → `gateTtlMs`, `worker` dropped.
  - `locks` is optional beside a gating queue.
  - The worker filters claims.
  - Task events and observers carry `attempts`.
  - The new and removed codes.
  - Rollout: deploy the API and the workers together. The next `add` takes over a row that a worker from before the gate completed or dead-lettered.
- [ ] **Step 4: Update `docs/host-adoption.md`.**
  - The index rollout: create the gate index, drop the requestKey index.
  - The ejected-model fields.
  - The `lockTtlMs` → `coordination` move.
  - The lock defaults line: no dispatch or worker locks; a gate lock lasts `gateTtlMs`, and the worker extends it.
- [ ] **Step 5: Update the docs site.**
  - `cd /Users/andrey/Work/framework-documenation-github` (never `git -C`), then `git checkout docs/s1-ports && git checkout -b docs/s2-gate`.
  - In `docs/12-resize.md`:
    - line 518: timing has no lock TTLs; `coordination` is a Resizer option;
    - line 542: the `queue.lockTtlMs` row becomes `coordination.gateTtlMs` and `coordination.cooldownMs`;
    - line 598: retry after `coordination.cooldownMs`;
    - line 609: the `RESIZE_MONGO_MODEL_OUTDATED` fields and the gate index.
  - Keep the guide on the docs site and the reference in README.
  - `git commit -am "docs(resize): the gate, coordination and attempts"`, then return to the worktree.
- [ ] **Step 6: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS, with `agentsDoc.test.ts` finding every snippet import among the real exports.
- [ ] **Step 7: Commit.** `git add README.md AGENTS.md CHANGELOG.md docs/host-adoption.md && git commit -m "docs: the gate, coordination and task attempts"`

---

## Definition of done (S2)

- **1000 concurrent `resolve` calls on a cold media create one task.**
  - In memory, on a gating queue and on one without `gatesByTask`: Task 12, `src/gate.test.ts`.
  - On MongoDB: Task 12, `taskQueue.test.ts`. The gate itself: Task 3.
- **A task in backoff blocks new tasks**, in memory and on MongoDB: Task 12; unit level in Tasks 2 and 3.
- **The SQS path holds the gate through the backoff and releases it on completion.**
  - End to end on `PlainTaskQueue`, and through the Consumer with `SqsTaskQueue`: Task 12.
  - The rules: Task 7. The token: Tasks 5 and 9.
- **Lock settings are validated only in the core.** `fillCoordination` (Task 6), `lockTtlMs` removed from queue timing (Task 11), and an architecture guard (Task 12).
- **Per-identity locks are gone.**
  - From the Dispatcher (Task 9), and from the Processor and the worker (Task 10).
  - `lockKeys.ts` keeps only `gateKey`, and an architecture guard keeps it so (Task 12).
- **Spec coverage.** F2 (Tasks 6 and 11), F3 (Tasks 1–5 and 7–10), task events with `attempts` (Task 1).
- **Gates and docs.** `npm test`, `npm run types:check`, `npm run check`, `npm run build` and `npm run smoke` pass. README, AGENTS.md, CHANGELOG, `docs/host-adoption.md` and the docs-site page describe the gate and coordination (Task 13).
