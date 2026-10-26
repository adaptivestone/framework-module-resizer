# S1 — Ports and composition root Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `ResizeDatabase` with the `MediaStore` and `LockStore` ports, and split the Resizer's work into services that get only the ports they use in their constructor, with `Resizer` as the one composition root. Hosts see no behaviour change beyond the new wiring.

**Architecture:** `ResizeDatabase` did three jobs. Three narrow ports replace it: `MediaStore`, `LockStore` and the existing `TaskQueue`. The Mongo driver returns them as one `mongoParts()` bundle, and the framework adapter combines `FrameworkMediaStore` and `FrameworkLockStore` instead of subclassing. `Resizer` loads its lazy parts once in `ready()` and builds `Catalog`, `Uploader`, `Dispatcher`, `Reader` and `Processor`; it builds `HookBus` and `PipelineRegistry` at construction. The worker builds one `Consumer` per task queue. No service imports `resizer.ts`. `ResizeError.retryable` replaces the consumer's list of error codes, and guard tests pin the import graph.

**Tech Stack:** Node ≥ 24, TypeScript 7 (`erasableSyntaxOnly`, ESM, `.ts` specifiers), `node:test`, Biome 2, sharp 0.35, mongoose 9 and mongodb-memory-server (tests only).

**Spec:** docs/design/2026-10-26-reference-architecture.md (F1, F5, F10 import rule, `retryable`)

## Global Constraints

- Branch `refactor/s1-ports-and-composition-root` from `main`. Every task ends with one commit on it, and nothing is pushed (the docs-site branch `docs/s1-ports` is not pushed either).
- Scope is S1 only: F1, F5, the F10 import rule, `ResizeError.retryable` and the SQS import fix. F2, F3, F4 and F6–F9 belong to later phases.
- These stay as they are: per-identity dispatch locks `resize_dispatch:<mediaId>:<identity>` and worker locks `resize_worker:<mediaId>:<identity>`, with TTLs `lockTtlMs.dispatch` 60000, `.worker` 60000 and `.failed` 600000, still on the queue timing.
- `generatePreviews`' steps stay as they are (download → SVG raster → beforeSteps → per-variant resize/encode/upload → one persist). Only its inputs become constructor dependencies.
- The framework queue-sharing code moves to `src/framework/queue.ts` without changes: `queueUsers`, `backendQueues`, `appQueue`, `sharedQueue`, `backendTiming` and `RESIZE_CONFIG_QUEUE_TIMING_CONFLICT`.
- `appendPreviews` stays one guarded `findOneAndUpdate` per row. There is no `replacePreviews`. Drivers implement `LockStore.extend`, but the core does not call it.
- Lock owners: each worker-lock acquire uses a fresh `randomHex()` owner, kept beside its key and passed to `release`. Dispatch locks use the fixed owner `'resize:dispatch'` (Task 7 explains why).
- Pre-release: breaking changes ship without migration code, and hosts migrate their own data.
- Every task ends with `npm run types:check`, `npm run check` and `npm test` passing. Tasks 7, 16 and 17 also run `npm run build && npm run smoke`.
- To run one file: `node --experimental-strip-types --test src/<file>.test.ts`. The `*.mongo.integration.test.ts` files start mongodb-memory-server themselves.
- Contracts are abstract classes, and a plain object of the same shape must type-check as one. The core never uses `instanceof` on a driver or on an error that reaches the queue: `retryable === false` is duck-typed.
- Shipped drivers are classes (`class X extends Contract`). No test-only seams in shipped code. A generic helper lives once, in `src/helpers/`. No `any`, except a `biome-ignore` with a reason where today's code already has one.
- `src/types.d.ts` stays dependency-free, because it is copied verbatim into dist. Types that reference contracts or sharp go to `src/contracts/`.
- Keep `minimize: false`. The module never creates or changes indexes. The only schema change is `owner` on `resizeLockFields`.
- New error codes: `RESIZE_MEDIA_REQUIRED` (replaces `RESIZE_DATABASE_REQUIRED`), `RESIZE_LOCKS_REQUIRED` and `RESIZE_MEDIA_APPEND_RESULT_INVALID`.
- Comments state reasons in plain words, as densely as the surrounding file. No spec-section references. No private project names (the repository is public).
- Commit messages use a conventional prefix, with NO `Co-Authored-By` and no "Generated with" trailer.
- Use `git mv` for every file that keeps its content under a new name, so its history follows it.

## Review Focus

1. A custom `MediaStore` written to the old contract resolves `appendPreviews` with nothing. It must fail with `RESIZE_MEDIA_APPEND_RESULT_INVALID`, not report every preview as "already stored by another worker" and return `created: []`. (Test: Task 7.)
2. A host passes `tasks` without `locks`, or a lazy `locks` that resolves to nothing. `resolve()` must still never throw (it returns the safe empty decision), `prewarm()` returns `incomplete` with a non-retryable issue, and `verify()` and `generate()` reject with `RESIZE_LOCKS_REQUIRED`. (Test: Task 7.)
3. The worker releases dispatch locks that the API process acquired, and takes them again for the dead-letter cooldown. With owner checks, these cross-process calls still work only because dispatch locks share the owner `resize:dispatch` and `FrameworkLockStore` stores that owner in the database, not in process memory. (Test: Task 6, two store instances; Task 7, the cooldown test with an owner-checking store.)
4. A worker lock expires and another caller takes it over. The first owner's late `release` must return `false` and leave the new holder's lock in place; today it deletes it. (Test: Task 4.)
5. An error that reaches the consumer as a plain object (`{ code, retryable: false }`, no prototype) is dead-lettered at once. An error with a formerly terminal code but no `retryable: false` is now retried, because the code list is gone. (Test: Task 1.)

---

## File structure

| File | Change | Responsibility after S1 |
|---|---|---|
| `src/contracts/media.ts` | Create | `MediaStore` port: load media, append previews (resolves with the stored rows), optional `verify` |
| `src/contracts/locks.ts` | Create | `LockStore` port: TTL locks with owners (`acquire`, `extend`, compare-and-delete `release`) |
| `src/contracts/hooks.ts` | Create | Hook names, `HookSignatures`, `HookFn`, `HookTaps` (moved out of `resizer.ts`) |
| `src/contracts/pipeline.ts` | Create | `Pipeline`, `BeforeStep`, `VariantStep` (moved out of `resizer.ts`) |
| `src/contracts/database.ts` | Delete | (replaced by the two ports) |
| `src/lockKeys.ts` | Create | Lock key builders and the fixed dispatch-lock owner |
| `src/helpers/log.ts` | Create | `logNeverThrow`: log on a never-throw path, with a console fallback for a throwing logger |
| `src/hooks.ts` | Create | `HookBus`: guarded waterfalls and observers, mirrored to the event bus |
| `src/pipelines.ts` | Create | `PipelineRegistry`: named pipelines, fixed at construction |
| `src/registry.ts` | Create | Process registry: `registerResizer`, `getResizer`, `listResizers`, test reset hooks |
| `src/catalog.ts` | Create | `Catalog`: size × format expansion, identities, stored identities, configured formats |
| `src/uploader.ts` | `git mv` from `original.ts` | `Uploader`: `uploadOriginal` |
| `src/dispatcher.ts` | `git mv` from `enqueue.ts` | `Dispatcher`: the read path's enqueue and the prewarm confirmation |
| `src/reader.ts` | `git mv` from `engine.ts` | `Reader`: the `resolve` decision and the request half of `prewarm` |
| `src/processor.ts` | `git mv` from `resizeTask.ts` | `Processor`: eager `generate`, one queued task, the dead-letter cooldown, task observers |
| `src/consumer.ts` | Create | `Consumer`: the worker loop (`consumeQueue` moved), `backoffMs`, `toLeasedTask` |
| `src/timing.ts` | `git mv` from `queue.ts` | Queue timing: `QueueTiming`, `fillTiming`, `timingOf` |
| `src/resizer.ts` | Modify | Composition root and facade: options, lazy parts, building the services, public methods |
| `src/worker.ts` | Modify | `runWorker({ resizers? })`: one `Consumer` per task queue, routing to each Resizer's `Processor` |
| `src/images.ts` | Modify | Pure helpers, one implementation each: stored identities, canonical variants, configured formats |
| `src/errors.ts` | Modify | `ResizeError.retryable` |
| `src/types.d.ts` | Modify | Gains `LazyPart`, `GenerateOpts`, `GenerateResult`, `ResolveOpts`, `PrewarmOpts` |
| `src/index.ts` | Modify | Exports `MediaStore`, `LockStore`; drops `ResizeDatabase`; types from their new homes |
| `src/drivers/sqs.ts` | Modify | No core imports; no lock-TTL validation in its constructor |
| `src/drivers/mongo/locks.ts` | Create | `MongoLockStore` over `ResizeLock` |
| `src/drivers/mongo/media.ts` | Create | `MongoMediaStore` (the media half of today's `MongoDatabase`) |
| `src/drivers/mongo/parts.ts` | Create | `mongoParts(connection, opts)` → `{ media, locks, tasks }` |
| `src/drivers/mongo/database.ts` | Delete | (`MongoDatabase` / `mongoDatabase` replaced) |
| `src/drivers/mongo/schemas.ts` | Modify | `resizeLockFields.owner` |
| `src/drivers/mongo/index.ts` | Modify | New exports |
| `src/framework/media.ts` | Create | `FrameworkMediaStore`: the app's media model by name |
| `src/framework/locks.ts` | Create | `FrameworkLockStore`: owner-checked locks in the framework `Lock` collection |
| `src/framework/queue.ts` | Create | The queue-sharing state moved from `framework/database.ts`, and `appTaskQueue()` |
| `src/framework/database.ts` | Delete | (`FrameworkDatabase` replaced) |
| `src/framework/resizer.ts`, `framework/index.ts`, `framework/worker.ts` | Modify | `media` / `locks` / `tasks` options; new exports; registry import |
| `src/testHelpers/fakes.ts` | Modify | `fakeMedia`, owner-honouring `memoryLocks`; `fakeDb` and `FakeLocks` deleted |
| `src/testHelpers/imports.ts` | Create | `sourceFiles()`, `localImports()` for the guard tests |
| `src/testHelpers/consume.ts` | Create | `consume(tasks, opts)`: runs a `Consumer` with the old `consumeQueue` options |
| `src/testHelpers/contractShapes.ts` | Modify | Plain-object shapes of the new ports |
| `src/importGraph.test.ts`, `src/architecture.test.ts` | Modify | Driver import rule, `resizer.ts` importer rule, no cycle back into `resizer.ts`, core-file rule |
| Tests | Modify / `git mv` | `enqueue.test.ts`→`dispatcher.test.ts`, `engine.test.ts`→`reader.test.ts`, `resizeTask.test.ts`→`processor.test.ts`, `original.test.ts`→`uploader.test.ts`, `queue.test.ts`→`consumer.test.ts` (+ new `timing.test.ts`), `framework/database.test.ts`→`framework/stores.test.ts`, `drivers/mongo/database.mongo.integration.test.ts`→`media.mongo.integration.test.ts`; new `hooks.test.ts`, `pipelines.test.ts`, `catalog.test.ts`, `framework/locks.mongo.integration.test.ts` |
| `smokeTest.ts`, `README.md`, `AGENTS.md`, `CHANGELOG.md`, docs site `docs/12-resize.md` | Modify | Exports and docs |

---

### Task 1: `ResizeError.retryable`; the consume loop dead-letters on it

**Files:**
- Modify: `src/errors.ts:22-149`, `src/queue.ts:113-129, 179, 346`, the throw sites `src/resizeTask.ts:252-255, 264-268, 333-337, 404-408`, `src/helpers/svgRaster.ts:152-155`, `src/original.ts:116-120`, `src/index.ts:31-41`
- Test: `src/errors.test.ts`, `src/queue.test.ts:209-276, 521-557`, `src/worker.test.ts:37-186`, `src/resizeTask.test.ts:1937, 2326, 2597`, `src/helpers/svgRaster.test.ts:154`, `src/original.test.ts:308`

**Interfaces:**
Produces:
```ts
// src/errors.ts
export interface ResizeErrorOptions { code?: string; cause?: unknown; retryable?: boolean }
export class ResizeError extends Error {
  readonly code: string;
  readonly retryable: boolean; // default true; false: no retry can help, the consumer dead-letters at once
  constructor(message: string, opts?: ResizeErrorOptions);
}
// ResizeSetupError, ResizeConfigError, ResizeStorageError, ResizeSecurityError, ResizeOriginalError: (message, opts?: ResizeErrorOptions)
// ResizeMediaError: (message, opts?: ResizeErrorOptions & { mediaId?: string })
// ResizeNoOriginalError(mediaId): always retryable false. ResizeGenerateError: unchanged options, retryable true.
```

- [ ] **Step 1: Write the failing tests.** In `src/errors.test.ts`:
```ts
describe('ResizeError.retryable', () => {
  test('defaults to true and follows the option bag', () => {
    assert.equal(new ResizeError('m').retryable, true);
    for (const Ctor of [ResizeSetupError, ResizeConfigError, ResizeStorageError, ResizeSecurityError, ResizeMediaError, ResizeOriginalError]) {
      assert.equal(new Ctor('m', { retryable: false }).retryable, false, Ctor.name);
    }
    assert.equal(new ResizeGenerateError({ mediaId: 'm', failed: 1, requested: 1 }).retryable, true);
  });
  test('a media without an original is never retryable', () => {
    assert.equal(new ResizeNoOriginalError('m1').retryable, false);
  });
  test('survives JSON serialization (structured logs)', () => {
    assert.equal(JSON.parse(JSON.stringify(new ResizeMediaError('m', { retryable: false }))).retryable, false);
  });
});
```
In `src/queue.test.ts`, replace the two `for (const code of […])` loops (lines 225-276 and 521-557) with:
```ts
test('an error with retryable: false is dead on the first failure', …)
  // handler throws new ResizeMediaError('resize: unusable source', { mediaId: 'm1', code: 'RESIZE_ANY', retryable: false })
  // → tasks.rows[0].attempts === 1, events ['deadLettered']
test('a plain object with retryable: false is dead on the first failure', …)
  // handler throws { code: 'RESIZE_SOURCE_TOO_LARGE', retryable: false, message: 'crossed a process boundary' }
  // → status 'dead', attempts 1
test('a formerly terminal code without retryable: false is retried', …)
  // retryBackoffMs { base: 60_000, max: 60_000 }; throws new ResizeMediaError('x', { code: 'RESIZE_SOURCE_TOO_LARGE' })
  // → attempts 1, status 'pending', events ['failed']
test('a non-retryable error during shutdown is still dead-lettered, not given back', …)
  // same harness as today's loop body, rejecting with { code: 'RESIZE_ANY', retryable: false }
  // → events ['deadLettered'], status 'dead', releaseCalls []
```
Keep the test `${code} stays a retryable failure`. At each existing throw-site test, add `&& err.retryable === false` to the `assert.rejects` predicate: `resizeTask.test.ts:1937` (`RESIZE_SOURCE_TOO_LARGE`), `:2326` (`RESIZE_SVG_DIMENSIONS_UNSUPPORTED`), `:2597` (`RESIZE_SVG_RENDER_TIMEOUT`), `svgRaster.test.ts:154`, `original.test.ts:308`. In `worker.test.ts`, add `assert.equal(events[0].error.retryable, false)` next to the code assertions near lines 100 and 180.
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/errors.test.ts src/queue.test.ts`. Expected: FAIL, because `retryable` is `undefined` and the formerly-terminal-code test is dead-lettered instead of retried.
- [ ] **Step 3: Implement `ResizeError.retryable` in `src/errors.ts` and `notRetryable(error: unknown): boolean` in `src/queue.ts`.** `ResizeError` stores `opts?.retryable ?? true` as an enumerable field, every subclass forwards the whole option bag, and `ResizeNoOriginalError` passes `retryable: false`. Add `retryable: false` at the throw sites of the five codes. No test can produce `RESIZE_SOURCE_METADATA_MISSING` from a real image, so its site changes along with the others without a test. In `queue.ts`, `finish` and the shutdown branch call `notRetryable` (`typeof error === 'object' && error !== null && (error as { retryable?: unknown }).retryable === false`). Delete `TERMINAL_ERROR_CODES` and `isTerminal`, and export `type ResizeErrorOptions` from `src/index.ts`.
- [ ] **Step 4: Run the tests to verify they pass.** Run Step 2's command, then `node --experimental-strip-types --test src/worker.test.ts src/resizeTask.test.ts src/helpers/svgRaster.test.ts src/original.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/errors.ts src/queue.ts src/resizeTask.ts src/helpers/svgRaster.ts src/original.ts src/index.ts src/errors.test.ts src/queue.test.ts src/worker.test.ts src/resizeTask.test.ts src/helpers/svgRaster.test.ts src/original.test.ts && git commit -m "feat: ResizeError.retryable decides dead-lettering instead of a list of codes"`

### Task 2: SqsTaskQueue imports only what a driver may; the driver import rule

**Files:**
- Create: `src/testHelpers/imports.ts`
- Modify: `src/drivers/sqs.ts:23-25, 81-85`, `src/resizeConfig.ts:173-187` (delete `validateLockTtlMs`; this was its only caller), `src/queue.ts:34-48` (`validateFailedLockTtl` becomes module-private)
- Test: `src/importGraph.test.ts`, `src/drivers/sqs.test.ts:993-1020`

**Interfaces:**
Produces:
```ts
// src/testHelpers/imports.ts
export function sourceFiles(): string[]; // every non-test .ts under src/ (testHelpers excluded), src-relative, '/'-separated
export function localImports(file: string, opts: { types: boolean }): string[]; // src-relative targets of the file's relative import/export specifiers; types: true includes `import type` / `export type`
```
`new SqsTaskQueue(opts)` no longer throws `RESIZE_CONFIG_QUEUE_LOCK_TTL_INVALID`; `timingOf(queue)` does.

- [ ] **Step 1: Write the failing tests.** In `src/importGraph.test.ts`:
```ts
test('drivers import only contracts, errors, helpers, types and other drivers', () => {
  const allowed = (t: string) => t.startsWith('contracts/') || t === 'errors.ts' || t.startsWith('helpers/') || t === 'types.d.ts' || t.startsWith('drivers/');
  const offending = sourceFiles().filter((f) => f.startsWith('drivers/')).flatMap((f) => localImports(f, { types: true }).filter((t) => !allowed(t)).map((t) => `${f} → ${t}`));
  assert.deepEqual(offending, []);
});
```
In `src/drivers/sqs.test.ts`, replace `rejects invalid lock TTLs at construction` with:
```ts
test('accepts any timing at construction; the core rejects bad lock TTLs when it reads the timing', () => {
  const ttl = (err: Error & { code?: string }) => err.code === 'RESIZE_CONFIG_QUEUE_LOCK_TTL_INVALID';
  assert.throws(() => timingOf(new SqsTaskQueue({ queueUrl: 'q', timing: { lockTtlMs: { dispatch: 0, worker: 0 } } })), ttl);
  assert.throws(() => timingOf(new SqsTaskQueue({ queueUrl: 'q', timing: { lockTtlMs: { dispatch: 1000, worker: 1000, failed: 0 } } })), (err: Error & { code?: string }) => ttl(err) && /lockTtlMs\.failed/.test(err.message));
  assert.equal(timingOf(new SqsTaskQueue({ queueUrl: 'q', timing: { lockTtlMs: { dispatch: 1000, worker: 1000 } } })).lockTtlMs.failed, 600_000);
});
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/importGraph.test.ts src/drivers/sqs.test.ts`. Expected: FAIL. `offending` equals `['drivers/sqs.ts → queue.ts', 'drivers/sqs.ts → resizeConfig.ts']`, and the first `new SqsTaskQueue` throws in its constructor.
- [ ] **Step 3: Implement `sourceFiles` and `localImports` in `src/testHelpers/imports.ts`.** Use `readdirSync(SRC, { recursive: true })` and the specifier regexes that `importGraph.test.ts` already has. Then delete the two core imports and the constructor check from `src/drivers/sqs.ts`, delete `validateLockTtlMs`, and stop exporting `validateFailedLockTtl` (`fillTiming` still calls it).
- [ ] **Step 4: Run the tests to verify they pass.** Run Step 2's command and `npm run types:check`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/testHelpers/imports.ts src/importGraph.test.ts src/drivers/sqs.ts src/drivers/sqs.test.ts src/resizeConfig.ts src/queue.ts && git commit -m "fix: SqsTaskQueue stops importing core validators; drivers import only contracts, errors, helpers and types"`

### Task 3: The `MediaStore` and `LockStore` ports

**Files:**
- Create: `src/contracts/media.ts`, `src/contracts/locks.ts`
- Modify: `src/index.ts:11-21`, `src/testHelpers/contractShapes.ts`
- Test: `src/testHelpers/contractShapes.ts` (compiled by `npm run types:check`), `src/index.test.ts:14-37, 63-76`

**Interfaces:**
Produces:
```ts
// src/contracts/media.ts
export abstract class MediaStore {
  abstract loadMedia(mediaId: string): Promise<MediaLike | null>; // null (deleted media): the task is a logged no-op
  abstract appendPreviews(mediaId: string, previews: Preview[], backfillDims?: { width: number; height: number }): Promise<Preview[]>; // one row per identity; resolves with the rows it stored
  verify?(): void | Promise<void>;
}
// src/contracts/locks.ts — a TTL key-value store with owners
export abstract class LockStore {
  abstract acquire(key: string, owner: string, ttlMs: number): Promise<boolean>; // true: free, or expired and taken over
  abstract extend(key: string, owner: string, ttlMs: number): Promise<boolean>;  // false: not held by owner
  abstract release(key: string, owner: string): Promise<boolean>;                // compare-and-delete; false: not held by owner
  verify?(): void | Promise<void>;
}
```

- [ ] **Step 1: Write the failing tests.** Append to `src/testHelpers/contractShapes.ts`:
```ts
export const media: MediaStore = { loadMedia: async () => null, appendPreviews: async (_id, previews) => previews };
export const verifiedMedia: MediaStore = { ...media, verify: () => {} };
export const locks: LockStore = { acquire: async () => true, extend: async () => true, release: async () => true };
// @ts-expect-error — appendPreviews resolves with the stored rows, never with nothing.
export const voidAppendMedia: MediaStore = { loadMedia: async () => null, appendPreviews: async () => {} };
// @ts-expect-error — a media store is not a lock store.
export const locklessMedia: LockStore = { loadMedia: async () => null, appendPreviews: async () => [] };
```
In `src/index.test.ts`, add `'MediaStore'` and `'LockStore'` to `EXPECTED_VALUE_EXPORTS` and to the constructor-check list.
- [ ] **Step 2: Run the tests to verify they fail.** Run: `npm run types:check`, then `node --experimental-strip-types --test src/index.test.ts`. Expected: FAIL with "Cannot find module '../contracts/media.ts'", and the export list lacks both names.
- [ ] **Step 3: Implement `MediaStore` in `src/contracts/media.ts` and `LockStore` in `src/contracts/locks.ts`.** Copy the header style of `contracts/storage.ts`: extend the class or pass any object of the same shape, because the core never checks `instanceof`. Export both from `src/index.ts`.
- [ ] **Step 4: Run the tests to verify they pass.** Run Step 2's commands. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/contracts/media.ts src/contracts/locks.ts src/index.ts src/index.test.ts src/testHelpers/contractShapes.ts && git commit -m "feat: MediaStore and LockStore ports"`

### Task 4: `MongoLockStore`: owner-checked locks over `ResizeLock`

**Files:**
- Create: `src/drivers/mongo/locks.ts`
- Modify: `src/drivers/mongo/schemas.ts:97-101`, `src/drivers/mongo/index.ts`
- Test: `src/drivers/mongo/drivers.mongo.integration.test.ts` (new `describe('MongoLockStore')`)

**Interfaces:**
Consumes: `LockStore` (Task 3).
Produces:
```ts
// src/drivers/mongo/locks.ts
export interface MongoLockModel {
  create(doc: { _id: string; owner: string; expiredAt: Date }): PromiseLike<unknown>;
  updateOne(filter: object, update: object): PromiseLike<{ matchedCount: number }>;
  deleteOne(filter: object): PromiseLike<{ deletedCount?: number }>;
}
export interface MongoLockStoreOptions { model?: MongoLockModel; getModel?: () => MongoLockModel | null | undefined } // exactly one
export class MongoLockStore extends LockStore {
  constructor(opts: MongoLockStoreOptions); // neither or both → ResizeSetupError RESIZE_MONGO_MODEL_REQUIRED
  protected lockModel(): MongoLockModel;     // unresolved → ResizeSetupError RESIZE_MONGO_MODEL_MISSING
  verify(): void;                            // lockModel() resolves
  acquire(key: string, owner: string, ttlMs: number): Promise<boolean>;
  extend(key: string, owner: string, ttlMs: number): Promise<boolean>;
  release(key: string, owner: string): Promise<boolean>;
}
// src/drivers/mongo/schemas.ts
// resizeLockFields = { _id: { type: String, required: true }, owner: { type: String }, expiredAt: { type: Date, required: true } }
```

- [ ] **Step 1: Write the failing tests.** Use the file's harness: `const { ResizeLock } = createResizeModels(connection); const store = new MongoLockStore({ model: ResizeLock });`, plus an `expire(key)` helper that sets `expiredAt` to `Date.now() - 1000`, like the existing one.
```ts
test("one owner at a time; the owner's release frees the lock", …)
  // acquire('l1','A',60_000) → true; acquire('l1','B',60_000) → false; release('l1','A') → true; acquire('l1','B',60_000) → true
test('another owner can neither release nor extend the lock', …)
  // acquire('l2','A',60_000); release('l2','B') → false; extend('l2','B',60_000) → false; acquire('l2','C',60_000) → false
test("extend moves a live lock's expiry; an expired lock cannot be extended", …)
  // acquire('l3','A',1000); extend('l3','A',120_000) → true; (await ResizeLock.findById('l3').lean()).expiredAt - Date.now() > 100_000
  // expire('l3'); extend('l3','A',1000) → false
test("an expired lock goes to one caller, and the old owner's late release leaves it", …)
  // acquire('l4','A',60_000); expire('l4'); results = await Promise.all(['B0','B1','B2','B3','B4'].map((o) => store.acquire('l4', o, 60_000)))
  // results.filter(Boolean).length === 1; release('l4','A') → false; (await ResizeLock.findById('l4').lean()).owner === the winner
test('getModel is resolved on use; an unresolved model fails verify()', …)
  // calls === 0 after construction, 2 after acquire + release; new MongoLockStore({ getModel: () => null }).verify() throws RESIZE_MONGO_MODEL_MISSING
test('needs exactly one of model or getModel', …)
  // new MongoLockStore({}) and new MongoLockStore({ model, getModel }) both throw RESIZE_MONGO_MODEL_REQUIRED
test('the ResizeLock schema stores the owner', () => assert.deepEqual(resizeLockFields.owner, { type: String }));
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/drivers/mongo/drivers.mongo.integration.test.ts`. Expected: FAIL with "does not provide an export named 'MongoLockStore'".
- [ ] **Step 3: Implement `MongoLockStore` in `src/drivers/mongo/locks.ts`.** `acquire` calls `create({ _id: key, owner, expiredAt })`. On duplicate key (11000) it calls `updateOne({ _id: key, expiredAt: { $lte: now } }, { $set: { owner, expiredAt } })` and returns `matchedCount === 1`. `extend` calls `updateOne({ _id: key, owner, expiredAt: { $gt: now } }, { $set: { expiredAt } })` and returns `matchedCount === 1`. `release` calls `deleteOne({ _id: key, owner })` and returns `deletedCount === 1`. Add `owner` to `resizeLockFields`, and export `MongoLockStore` with its two types from `src/drivers/mongo/index.ts`.
- [ ] **Step 4: Run the test to verify it passes.** Run Step 2's command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/drivers/mongo/locks.ts src/drivers/mongo/schemas.ts src/drivers/mongo/index.ts src/drivers/mongo/drivers.mongo.integration.test.ts && git commit -m "feat(mongo): MongoLockStore with owner-checked acquire, extend and release"`

### Task 5: `MongoMediaStore` and `mongoParts`

**Files:**
- Create: `src/drivers/mongo/media.ts`, `src/drivers/mongo/parts.ts`
- Modify: `src/drivers/mongo/database.ts:21-188` (the media half moves out; `MongoDatabase` delegates `loadMedia`, `appendPreviews` and `verifyMediaModel` to a private `MongoMediaStore` until Task 7 deletes it), `src/drivers/mongo/index.ts`
- Test: `git mv src/drivers/mongo/database.mongo.integration.test.ts src/drivers/mongo/media.mongo.integration.test.ts`, `src/drivers/mongo/drivers.mongo.integration.test.ts` (new `describe('mongoParts')`)

**Interfaces:**
Consumes: `MediaStore` (Task 3), `MongoLockStore` (Task 4), the existing `new MongoTaskQueue({ model, timing?, logger? })` and `createResizeModels(connection, { mediaModelName? })`.
Produces:
```ts
// src/drivers/mongo/media.ts
export interface MongoMediaModel { /* moved unchanged from database.ts:21-29 */ }
export interface MongoMediaStoreOptions { model?: MongoMediaModel; getModel?: () => MongoMediaModel | null | undefined } // exactly one
export class MongoMediaStore extends MediaStore {
  constructor(opts: MongoMediaStoreOptions); // RESIZE_MONGO_MODEL_REQUIRED
  protected mediaModel(): MongoMediaModel;  // RESIZE_MONGO_MODEL_MISSING
  verify(): void;                            // model resolves; strict preview rows keep `identity` (RESIZE_MONGO_MEDIA_MODEL_OUTDATED)
  loadMedia(mediaId: string): Promise<MediaLike | null>;
  appendPreviews(mediaId: string, previews: Preview[], backfillDims?: { width: number; height: number }): Promise<Preview[]>;
}
// src/drivers/mongo/parts.ts
export interface MongoPartsOptions { mediaModel: MongoMediaModel; timing?: Partial<QueueTimingOptions>; logger?: ResizeLogger }
export interface MongoParts { media: MongoMediaStore; locks: MongoLockStore; tasks: MongoTaskQueue }
// biome-ignore lint/suspicious/noExplicitAny: a Mongoose connection (types only, no import)
export function mongoParts(connection: any, opts: MongoPartsOptions): MongoParts;
```

- [ ] **Step 1: Write the failing tests.** In `media.mongo.integration.test.ts`, replace every `new MongoDatabase({ mediaModel: M })` with `new MongoMediaStore({ model: M })` and keep every assertion. In `drivers.mongo.integration.test.ts`:
```ts
describe('mongoParts', () => {
  test('returns exactly the Resizer options media, locks and tasks, on the package models', async () => {
    const parts = mongoParts(connection, { mediaModel: Media(), timing: { maxAttempts: 2 } });
    assert.deepEqual(Object.keys(parts).sort(), ['locks', 'media', 'tasks']);
    assert.ok(parts.media instanceof MongoMediaStore && parts.locks instanceof MongoLockStore && parts.tasks instanceof MongoTaskQueue);
    assert.equal(timingOf(parts.tasks).maxAttempts, 2);
    assert.equal(await parts.locks.acquire('p1', 'A', 1000), true);
    assert.equal((await connection.models.ResizeLock.findById('p1').lean())?.owner, 'A');
  });
  test('each call makes its own task queue (call it once per process)', () => {
    assert.notEqual(mongoParts(connection, { mediaModel: Media() }).tasks, mongoParts(connection, { mediaModel: Media() }).tasks);
  });
});
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/drivers/mongo/media.mongo.integration.test.ts src/drivers/mongo/drivers.mongo.integration.test.ts`. Expected: FAIL with missing exports `MongoMediaStore` and `mongoParts`.
- [ ] **Step 3: Implement `MongoMediaStore` in `src/drivers/mongo/media.ts` and `mongoParts` in `src/drivers/mongo/parts.ts`.** Move the media code out of `database.ts`, renaming `mediaModel` / `getMediaModel` to `model` / `getModel`. `mongoParts` calls `createResizeModels` once (passing the media model's `modelName` as today's `mongoDatabase` does) and builds the three parts. Export all of it from `src/drivers/mongo/index.ts`.
- [ ] **Step 4: Run the tests to verify they pass.** Run Step 2's command and `node --experimental-strip-types --test src/framework/database.test.ts`. Expected: PASS, because `FrameworkDatabase` still works through the delegating `MongoDatabase`.
- [ ] **Step 5: Commit.** `git add src/drivers/mongo && git commit -m "feat(mongo): MongoMediaStore and mongoParts"`

### Task 6: `FrameworkMediaStore` and `FrameworkLockStore`

**Files:**
- Create: `src/framework/media.ts`, `src/framework/locks.ts`
- Modify: `src/framework/index.ts`
- Test: `git mv src/framework/database.test.ts src/framework/stores.test.ts`, new `src/framework/locks.mongo.integration.test.ts`

**Interfaces:**
Consumes: `MongoMediaStore` (Task 5), `MongoLockStore` and `MongoLockModel` (Task 4).
Produces:
```ts
// src/framework/media.ts
export interface FrameworkMediaStoreOptions { modelName?: string; configName?: string; config?: FrameworkResizeConfig } // today's FrameworkDatabaseOptions
export class FrameworkMediaStore extends MongoMediaStore { constructor(opts?: FrameworkMediaStoreOptions) }
// getModel → getApp().getModel(modelName ?? <config>.mediaModelName); unregistered → ResizeConfigError RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN (today's message)
// src/framework/locks.ts
export class FrameworkLockStore extends MongoLockStore {
  constructor(); // getModel → the framework `Lock` model's native collection, adapted to MongoLockModel
  verify(): void; // no `Lock` model → ResizeSetupError RESIZE_MONGO_MODEL_MISSING ("the framework's Lock model is not registered — FrameworkLockStore keeps its locks there")
}
```
**Decision (owner storage):** the framework `Lock` schema is strict, and its statics take no owner, so they cannot store one. `FrameworkLockStore` writes the same documents (`_id`, `expiredAt`, plus `owner`) through `Lock.collection`, the native driver, which strict mode does not filter. Owners then hold across processes (the worker extends and releases locks that the API took, now and in S2), nothing grows in process memory, the framework's TTL index still removes expired locks, and the framework's own `acquireLock` still sees them. The adapter is `{ create: (doc) => c.insertOne(doc), updateOne: (f, u) => c.updateOne(f, u), deleteOne: (f) => c.deleteOne(f) }`.

- [ ] **Step 1: Write the failing tests.** In `stores.test.ts`, the describes `FrameworkDatabase.loadMedia`, `FrameworkDatabase.appendPreviews` and `FrameworkDatabase.verify: the media schema` run against `new FrameworkMediaStore()` with unchanged assertions. Replace `describe('FrameworkDatabase locks')` with:
```ts
test("FrameworkLockStore.verify() fails when the framework's Lock model is not registered", …)
  // setAppInstance({ getModel: (name) => (name === 'Lock' ? undefined : {}) }) → throws code RESIZE_MONGO_MODEL_MISSING, /Lock model/
```
In `locks.mongo.integration.test.ts`, register the framework's Lock model on a memory-server connection: `const schema = new mongoose.Schema(Lock.modelSchema); Object.assign(schema.statics, Lock.modelStatics);`, with `Lock` imported from `@adaptivestone/framework/models/Lock.js`, and install it with `setAppInstance({ getModel: () => LockModel })`.
```ts
test('two stores (two processes) share one lock and check owners', …)
  // a = new FrameworkLockStore(), b = new FrameworkLockStore()
  // a.acquire('k1','A',60_000) → true; b.acquire('k1','B',60_000) → false; b.release('k1','B') → false; a.release('k1','A') → true; b.acquire('k1','B',60_000) → true
test('a dispatch lock taken by one store is released and taken again by another with the fixed owner', …)
  // a.acquire('resize_dispatch:m1:x','resize:dispatch',60_000); b.release('resize_dispatch:m1:x','resize:dispatch') → true; b.acquire(…,'resize:dispatch',600_000) → true
test('the owner is stored despite the strict schema, and the framework statics still see the lock', …)
  // a.acquire('k3','A',60_000); (await LockModel.collection.findOne({ _id: 'k3' }))?.owner === 'A'; await LockModel.acquireLock('k3', 30) === false
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/framework/stores.test.ts src/framework/locks.mongo.integration.test.ts`. Expected: FAIL with "Cannot find module './media.ts'" or './locks.ts'.
- [ ] **Step 3: Implement `FrameworkMediaStore` in `src/framework/media.ts` and `FrameworkLockStore` in `src/framework/locks.ts`.** The media store's model getter is `FrameworkDatabase`'s `getMediaModel` closure (`database.ts:216-233`), moved. Export both, with `FrameworkMediaStoreOptions`, from `src/framework/index.ts`.
- [ ] **Step 4: Run the tests to verify they pass.** Run Step 2's command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/framework && git commit -m "feat(framework): FrameworkMediaStore and FrameworkLockStore"`

### Task 7: The Resizer takes `media` and `locks`; `ResizeDatabase` is gone

**Files:**
- Create: `src/lockKeys.ts`, `src/framework/queue.ts`
- Modify: `src/resizer.ts:10-57, 140-375, 405-426`; `src/enqueue.ts:141-162, 297-318, 498-542`; `src/resizeTask.ts:203-223, 437-475, 627-637, 655-745, 763, 812`; `src/worker.ts:14, 47-95`; `src/framework/resizer.ts:13-131, 211-260`; `src/framework/index.ts`; `src/drivers/mongo/index.ts`; `src/index.ts:11-12`; `src/testHelpers/fakes.ts:4-81`; `src/testHelpers/contractShapes.ts:36-56`; `smokeTest.ts`
- Delete: `src/contracts/database.ts`, `src/drivers/mongo/database.ts`, `src/framework/database.ts`
- Test: `src/resizer.test.ts`, `src/enqueue.test.ts`, `src/resizeTask.test.ts`, `src/worker.test.ts`, `src/testHelpers/fakes.test.ts`, and the migration list in Step 7

**Interfaces:**
Consumes: `MediaStore`, `LockStore` (Task 3); `MongoLockStore` (Task 4); `MongoMediaStore`, `mongoParts` (Task 5); `FrameworkMediaStore`, `FrameworkLockStore` (Task 6).
Produces:
```ts
// src/resizer.ts
export interface ResizerOptions {
  name?: string; config?: ResizeConfig | (() => ResizeConfig); logger?: ResizeLogger; events?: ResizeEventBus;
  storage: ResizeStorage | LazyPart<ResizeStorage>;
  media: MediaStore | LazyPart<MediaStore>;            // missing → RESIZE_MEDIA_REQUIRED (construction, or ready() for a lazy part)
  locks?: LockStore | LazyPart<LockStore | undefined>; // required when tasks resolves → RESIZE_LOCKS_REQUIRED at ready()
  tasks?: TaskQueue | LazyPart<TaskQueue | undefined>;
  queue?: string; pipelines?: Record<string, Pipeline>; hooks?: { [N in HookName]?: HookSignatures[N] | HookSignatures[N][] };
}
// Resizer getters: storage: ResizeStorage; media: MediaStore; locks: LockStore | undefined; tasks: TaskQueue | undefined. `db` is removed.
// src/lockKeys.ts
export const DISPATCH_LOCK_OWNER = 'resize:dispatch';
export function dispatchLockKey(mediaId: string, identity: string): string; // `resize_dispatch:${mediaId}:${identity}` (moved from enqueue.ts)
export function workerLockKey(mediaId: string, identity: string): string;   // `resize_worker:${mediaId}:${identity}`
// src/framework/queue.ts — moved unchanged from framework/database.ts:35-198:
//   QueueUser, DATABASE_BACKEND, addQueueUser, backendKey, backendTiming, checkQueueUser, sharedQueue; plus
export function appTaskQueue(): MongoTaskQueue; // the process's one queue over the app's ResizeTask model
// src/framework/resizer.ts
export interface FrameworkResizerOptions extends Omit<ResizerOptions, 'config' | 'storage' | 'media' | 'locks' | 'tasks' | 'logger' | 'events'> {
  configName?: string; config?: FrameworkResizeConfig; storage?: ResizeStorage;
  media?: MediaStore;        // default: new FrameworkMediaStore({ configName }) or ({ config, configName })
  locks?: LockStore;         // default: new FrameworkLockStore()
  tasks?: TaskQueue | false; // default: built from the config's `queue`
  logger?: ResizeLogger; events?: ResizeEventBus;
}
// src/testHelpers/fakes.ts
export function fakeMedia(parts?: { load?: (mediaId: string) => Promise<MediaLike | null>; appendPreviews?: MediaStore['appendPreviews']; previews?: Map<string, Preview[]>; verify?: () => void | Promise<void> }): MediaStore;
export function memoryLocks(): LockStore; // owners honoured, no expiry
```
**Decision (dispatch-lock owner):** in S1 the worker releases dispatch locks that a read took, possibly in another process: when it skips an existing preview, in its `finally`, and in the dead-letter cooldown (release, then acquire for `lockTtlMs.failed`). A random owner chosen by the read would make those calls fail, silently bringing in S2 behaviour and shortening the cooldown to the dispatch TTL for errors that dead-letter at once. So every dispatch lock uses `DISPATCH_LOCK_OWNER`, and only worker locks get a fresh `randomHex()` owner. S2 replaces dispatch locks with the gate, whose owner travels in the task payload.

- [ ] **Step 1: Write the failing tests.** In `src/resizer.test.ts`, add `describe('ports')`:
```ts
test('a missing media store is RESIZE_MEDIA_REQUIRED at construction', () =>
  assert.throws(() => new Resizer({ storage } as unknown as ResizerOptions), (e: unknown) => e instanceof ResizeSetupError && e.code === 'RESIZE_MEDIA_REQUIRED' && /FrameworkResizer/.test(e.message) && /mongoParts/.test(e.message)));
test('a lazy media store that returns nothing is RESIZE_MEDIA_REQUIRED at ready()', …) // media: () => undefined as unknown as MediaStore
test('a task queue without locks: ready(), verify() and generate() reject; resolve() and prewarm() never throw', async () => {
  const r = new Resizer({ storage, media: fakeMedia(), tasks: new MemoryTaskQueue() });
  const locksRequired = (e: unknown) => e instanceof ResizeSetupError && e.code === 'RESIZE_LOCKS_REQUIRED';
  await assert.rejects(() => r.ready(), locksRequired);
  await assert.rejects(() => r.verify(), locksRequired);
  await assert.rejects(() => r.generate({ media: { id: 'm1' }, sizes: [] }), locksRequired);
  assert.deepEqual(await r.resolve({ media: { id: 'm1' }, sizes: [{ width: 10 }] }), { decision: { ready: [], missing: [] }, output: undefined });
  const result = await r.prewarm({ media: { id: 'm1' }, sizes: [{ width: 10 }] });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_INTERNAL_ERROR');
  assert.equal(result.issues[0].retryable, false);
});
test('a lazy locks part that resolves to nothing beside a task queue is RESIZE_LOCKS_REQUIRED', …) // locks: () => undefined
test('an eager-only Resizer needs no locks, and has no db', async () => {
  const r = new Resizer({ storage, media: fakeMedia() });
  await r.ready();
  assert.equal(r.locks, undefined); assert.equal(r.tasks, undefined); assert.equal('db' in r, false);
});
test('media, locks and tasks given as objects are exposed as given', …) // r.media === media && r.locks === locks && r.tasks === tasks
```
In `src/enqueue.test.ts`, the lock recorder records `{ key, owner }`:
```ts
test('dispatch locks are taken and released with the fixed owner resize:dispatch', …)
  // tasks.add throws → acquired[0].owner === 'resize:dispatch'; released deepEqual [{ key: acquired[0].key, owner: 'resize:dispatch' }]
```
In `src/resizeTask.test.ts`, the lock recorder records `{ key, owner }`:
```ts
test('a worker lock is released with the owner that took it; dispatch locks with resize:dispatch', …)
  // processTask(task({ previews: [variant()] })): the acquire of 'resize_worker:m1:default:default:20x20:jpeg:none' has owner /^[0-9a-f]{32}$/;
  // released includes { key: that key, owner: that owner } and { key: 'resize_dispatch:m1:default:default:20x20:jpeg:none', owner: 'resize:dispatch' }
test('a MediaStore whose appendPreviews resolves undefined fails loudly', …)
  // eager generate with media: fakeMedia({ appendPreviews: async () => undefined as unknown as Preview[] })
  // rejects: e instanceof ResizeSetupError && e.code === 'RESIZE_MEDIA_APPEND_RESULT_INVALID' && /must resolve with the previews it stored/.test(e.message)
```
In `src/worker.test.ts`, `expiringLocks(clock)` becomes an owner-checking `LockStore`: `release` and `extend` by another owner return `false` and keep the lock. The test 'after a dead-letter, reads do not queue that variant again until the cooldown ends' must pass unchanged with it. In `src/testHelpers/fakes.test.ts`:
```ts
test('memoryLocks honours owners', …)
  // acquire('k','A',1) → true; acquire('k','B',1) → false; release('k','B') → false; extend('k','B',1) → false; extend('k','A',1) → true; release('k','A') → true; acquire('k','B',1) → true
test('fakeMedia keeps one row per identity and resolves with the stored rows', …) // the fakeDb test, ported
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/resizer.test.ts src/testHelpers/fakes.test.ts`. Expected: FAIL. `fakeMedia` is not exported, and the constructor throws `RESIZE_DATABASE_REQUIRED`.
- [ ] **Step 3: Implement `ResizerOptions` / the getters / `ready()` in `src/resizer.ts`.** The part names are `'storage' | 'media' | 'locks' | 'tasks'`. After the parts load, `ready()` throws `RESIZE_LOCKS_REQUIRED` when `tasks` is set and `locks` is not. `verify()` runs `media.verify?.()`, then `locks?.verify?.()`, then today's task-queue checks. Both new messages carry today's `FRAMEWORK_HINT` and name `mongoParts(connection, { mediaModel })`.
- [ ] **Step 4: Switch the call sites to the ports in `enqueue.ts`, `resizeTask.ts` and `worker.ts`.** Every lock call goes through `resizer.locks`, with keys from `src/lockKeys.ts`. Dispatch locks use `DISPATCH_LOCK_OWNER`. A worker lock gets `randomHex()`, and `heldLocks` becomes a `Map<string, string>` (key → owner). `processTaskWith` throws `RESIZE_LOCKS_REQUIRED` when `resizer.locks` is undefined. Media calls go through `resizer.media`. Replace the `Array.isArray(stored)` branch (`resizeTask.ts:699`) with a `ResizeSetupError` `RESIZE_MEDIA_APPEND_RESULT_INVALID` ("MediaStore.appendPreviews must resolve with the previews it stored") thrown before any observer runs. Put the decision above in a comment beside `DISPATCH_LOCK_OWNER`.
- [ ] **Step 5: Implement `FrameworkResizerOptions` and move the queue-sharing code into `src/framework/queue.ts`.** Export `appTaskQueue()`. Delete `databaseForResizer`, `buildingForResizer` and `isAppTaskQueue`: they only kept a `FrameworkDatabase` from registering itself as a queue user. `buildQueue(config, file)` returns `appTaskQueue()` for `'database'` (after `backendTiming(DATABASE_BACKEND)`). The Resizer's queue user is `backend: (config) => backendKey(config.queue)`.
- [ ] **Step 6: Delete the three files, and update the exports and fakes.** Remove `ResizeDatabase` from `src/index.ts`. Remove `MongoDatabase`, `mongoDatabase`, `MongoDatabaseOptions` and `MongoDatabaseFactoryOptions` from `drivers/mongo/index.ts`; `MongoMediaModel` and `MongoLockModel` are now exported from `media.ts` / `locks.ts`. Remove `FrameworkDatabase` and its options type from `framework/index.ts`. Delete `db`, `dbWithQueue` and `locklessDb` from `contractShapes.ts`, and `fakeDb` and `FakeLocks` from `fakes.ts`. Add `fakeMedia` and the owner-honouring `memoryLocks`.
- [ ] **Step 7: Migrate the tests with this mapping.**

| Old | New |
|---|---|
| `db: fakeDb({ load, appendPreviews, previews, verify })` | `media: fakeMedia({ load, appendPreviews, previews, verify })` |
| `fakeDb({ locks })` / a `FakeLocks` recorder | `locks:` a `LockStore` recorder (`acquire(key, owner, ttlMs)`, `extend`, `release(key, owner)` → boolean); `locks: memoryLocks()` wherever `tasks` is set or the test calls `processTask`, and the test does not inspect locks |
| a fake app whose `Lock` model fakes `acquireLock` / `releaseLock` | the fake `Lock` model fakes `collection.insertOne` / `updateOne` / `deleteOne` (`FrameworkLockStore`, Task 6) |
| `fakeDb({ tasks })` | the Resizer's `tasks` option |
| an `appendPreviews` fake resolving `void` | resolves with the previews it was given |
| `resizer.db` | `resizer.media` / `resizer.locks` |
| `new MongoDatabase({ mediaModel, lockModel })` | `new MongoMediaStore({ model })` + `new MongoLockStore({ model })` |
| `mongoDatabase(connection, opts)`, `db.tasks` | `const parts = mongoParts(connection, opts)`, `new Resizer({ …, ...parts })` |
| `new FrameworkDatabase(opts)` | `new FrameworkMediaStore(opts)` |

Files: `src/resizer.test.ts`, `src/engine.test.ts`, `src/enqueue.test.ts`, `src/prewarm.test.ts`, `src/prewarmCoverage.test.ts`, `src/resizeTask.test.ts`, `src/worker.test.ts`, `src/index.test.ts` (`ResizeDatabase` leaves the expected list; `MongoDatabase`, `mongoDatabase` and `FrameworkDatabase` in `DRIVER_NAMES` become `MongoMediaStore`, `mongoParts` and `FrameworkMediaStore`), `src/drivers/sqs.test.ts`, `src/drivers/mongo/taskQueue.test.ts`, `src/drivers/mongo/drivers.mongo.integration.test.ts` (delete the describes `MongoDatabase locks`, `MongoDatabase media` and `mongoDatabase`; Tasks 4–5 cover them), `src/drivers/mongo/frameworkFree.integration.test.ts` (uses `mongoParts`), `src/framework/resizer.test.ts` (delete "the 'database' queue needs a database with its own queue" and "a host-built FrameworkDatabase is checked against the Resizers that share its queue"; in "Resizers and databases with default wiring share one database task queue", drop the `direct` lines and assert `media.media !== listings.media`), `src/framework/worker.mongo.integration.test.ts` (the test name `FrameworkDatabase keeps one preview row …` becomes `FrameworkMediaStore …`), `src/framework/queueIndexes.mongo.integration.test.ts`, `src/framework/stores.test.ts`.
- [ ] **Step 8: Update `smokeTest.ts`.** Every `ResizeDatabase` / `MongoDatabase` / `mongoDatabase` / `FrameworkDatabase` reference (lines 58-81, 121-126, 141, 153-161, 187-201, 227-274) becomes `MediaStore` / `LockStore`, `MongoMediaStore` / `MongoLockStore`, `mongoParts`, and `FrameworkMediaStore` / `FrameworkLockStore`. The custom-driver check becomes `class MemoryMedia extends mod.MediaStore`.
- [ ] **Step 9: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS.
- [ ] **Step 10: Commit.** `git add -A src smokeTest.ts && git commit -m "feat!: the Resizer takes media and locks; ResizeDatabase, MongoDatabase and FrameworkDatabase are removed"`

### Task 8: Hook bus, pipeline registry and process registry leave `resizer.ts`

**Files:**
- Create: `src/contracts/hooks.ts`, `src/contracts/pipeline.ts`, `src/hooks.ts`, `src/pipelines.ts`, `src/registry.ts`, `src/hooks.test.ts`, `src/pipelines.test.ts`
- Modify: `src/resizer.ts:48-195, 238-241, 300-322, 428-494, 537-569`; `src/types.d.ts:1-6` (header) plus a new section; `src/engine.ts:35-52`; `src/index.ts:22-26, 54-75`; `src/framework/queue.ts`, `src/framework/worker.ts:5`, `src/worker.ts:18-23` (registry imports); and every test that imports `resetResizerForTests` / `getResizer` / `listResizers`, a contract type or `Pipeline` from `./resizer.ts`
- Test: `src/resizer.test.ts:198-227, 413-563, 565-720`

**Interfaces:**
Produces:
```ts
// src/contracts/pipeline.ts — BeforeStep, VariantStep, Pipeline: moved unchanged from resizer.ts:64-77
// src/contracts/hooks.ts — WaterfallName, ObserverName, HookName, HookSignatures, HookFn: moved unchanged from resizer.ts:85-138, plus
export type HookTaps = { [N in HookName]?: HookSignatures[N] | HookSignatures[N][] };
// src/types.d.ts — LazyPart<T>, GenerateOpts, GenerateResult (from resizer.ts), ResolveOpts, PrewarmOpts (from engine.ts): moved unchanged
// src/hooks.ts
export interface HookBusDeps { logger: ResizeLogger; events?: ResizeEventBus; taps?: HookTaps }
export class HookBus {
  constructor(deps: HookBusDeps);
  add<N extends HookName>(name: N, fn: HookSignatures[N]): void;
  runWaterfall(name: WaterfallName, value: unknown, ctx: Record<string, unknown>, mode?: 'identity' | 'optional'): Promise<unknown>;
  runObservers(name: ObserverName, ...args: unknown[]): Promise<void>;
}
// src/pipelines.ts
export class PipelineRegistry {
  constructor(pipelines?: Record<string, Pipeline>);
  get(name: string): Pipeline; // unknown → one frozen empty pipeline
  has(name: string): boolean;  // 'default' always
}
// src/registry.ts
export function registerResizer(resizer: Resizer): void; // duplicate name → ResizeSetupError RESIZE_DUPLICATE_RESIZER
export function getResizer(name?: string): Resizer;       // default 'default'; missing → RESIZE_NO_RESIZER
export function listResizers(): Resizer[];
export function resetResizerForTests(): void;
export function onResetResizerForTests(reset: () => void): void;
// src/resizer.ts: ResizerOptions['hooks'] is HookTaps. The Resizer keeps hook() and hasPipeline(), and keeps runWaterfall(),
// runObservers() and getPipeline() as one-line delegates until Task 13. registerPipeline() is removed: pipelines are fixed at construction.
```
**Decision (registry edge):** `registry.ts` keeps an `import type { Resizer }`, because the constructor calls `registerResizer(this)` and `getResizer()` must return the class type. This is the one edge back into `resizer.ts`, and it is type-only; Task 16 allows exactly this edge.

- [ ] **Step 1: Write the failing tests.** Move the describes `runWaterfall` (`resizer.test.ts:594-641`) and `runObservers` (`:643-720`) to `src/hooks.test.ts`. Each one builds `new HookBus({ logger, events })` instead of a Resizer, with unchanged assertions. Add:
```ts
test('taps seeded as a function or an array run in order, and add() appends', …)
  // taps: { resolveSizes: [a, b] }, then add('resolveSizes', c) → call order ['a', 'b', 'c']
test("'optional' mode returns undefined with no taps or when every tap throws", …)
```
`src/pipelines.test.ts` replaces the describe `named pipelines` (`resizer.test.ts:565-592`):
```ts
test('a seeded pipeline is returned by get()', …)
test('an unknown name returns one frozen empty pipeline', …) // deepEqual {}, Object.isFrozen, get('a') === get('b')
test("has() is true for 'default' and seeded names only", …)
```
In `resizer.test.ts`, the describe `Resizer registry` imports from `./registry.ts`; add:
```ts
test('resetResizerForTests() runs every onResetResizerForTests hook', …) // a counter hook → 1 after one reset
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/hooks.test.ts src/pipelines.test.ts src/resizer.test.ts`. Expected: FAIL with "Cannot find module './hooks.ts'".
- [ ] **Step 3: Implement `HookBus`, `PipelineRegistry` and the registry functions.** The bodies move from `resizer.ts`. The constructor builds `#hooks = new HookBus({ logger, events, taps: opts.hooks })` and `#pipelines = new PipelineRegistry(opts.pipelines)`, and calls `registerResizer(this)` as its last statement. `resizer.ts` stops re-exporting contract types. `index.ts` takes the pipeline and hook types from `contracts/`, the option types from `types.d.ts`, and `getResizer` / `resetResizerForTests` from `registry.ts`. Update the `types.d.ts` header to name `contracts/` as the home of source-coupled types.
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A src && git commit -m "refactor: hook bus, pipeline registry and the Resizer registry get their own modules"`

### Task 9: One implementation of the stored-identity and format rules, and the `Catalog` that wraps it

**Files:**
- Create: `src/catalog.ts`, `src/catalog.test.ts`
- Modify: `src/images.ts:201-235` (plus the new functions); `src/enqueue.ts:19-65` (`canonicalizeVariants` moves out); `src/engine.ts:100-112, 360-410, 549-606` (the inline sets and format helpers are replaced by the pure functions; logging stays here); `src/resizeTask.ts:73-82, 126-137, 197-209, 655-675, 781-797` (`identityOf`, `unconfiguredFormats` and the inline sets are replaced); `src/worker.ts:14`; `src/architecture.test.ts`
- Test: `src/catalog.test.ts`, `src/images.test.ts`, `src/architecture.test.ts`, `src/enqueue.test.ts` (import path)

**Interfaces:**
Produces:
```ts
// src/images.ts — pure, the single implementation of each rule
export function storedPreviews(media: MediaLike, scope: PreviewScope): Map<string, Preview>; // usable rows of `scope` by identity; a later row wins
export function storedIdentities(media: MediaLike, scope: PreviewScope): Set<string>;
export function canonicalizeVariants(variants: readonly MissingPreview[]): MissingPreview[]; // moved from enqueue.ts
export function configuredFormats(encoders: Record<string, unknown>, requested: readonly PreviewFormat[]): { formats: PreviewFormat[]; dropped: PreviewFormat[] }; // dropped deduplicated
export function splitConfigured(encoders: Record<string, unknown>, variants: readonly MissingPreview[]): { configured: MissingPreview[]; unconfigured: MissingPreview[] }; // a malformed entry is unconfigured
// src/catalog.ts
export interface CatalogDeps { config: ResizeConfig }
export class Catalog {
  constructor(deps: CatalogDeps);
  identity(scope: PreviewScope, variant: Pick<MissingPreview, 'sizeKey' | 'format' | 'filters'>): string;
  expand(sizes: SizeInput[], formats: PreviewFormat[], scope: PreviewScope): MissingPreview[];
  missing(media: MediaLike, sizes: SizeInput[], formats: PreviewFormat[], scope: PreviewScope): MissingPreview[];
  storedPreviews(media: MediaLike, scope: PreviewScope): Map<string, Preview>;
  storedIdentities(media: MediaLike, scope: PreviewScope): Set<string>;
  canonicalize(variants: readonly MissingPreview[]): MissingPreview[];
  configuredFormats(requested?: readonly PreviewFormat[]): { formats: PreviewFormat[]; dropped: PreviewFormat[] }; // default config.formats
  splitConfigured(variants: readonly MissingPreview[]): { configured: MissingPreview[]; unconfigured: MissingPreview[] };
}
```
A row's identity is always derived from its fields (`previewScope(row)`, `sizeKey`, `format`, `filters`), as the read path does today. The worker writes rows whose `identity` equals that derivation.

- [ ] **Step 1: Write the failing tests.** In `src/catalog.test.ts` (with `config = makeImageConfig({ formats: ['jpeg', 'webp'] })`, whose `encode.formats` has jpeg, webp and avif):
```ts
test('storedIdentities keeps the usable rows of the scope only', …)
  // previews: usable default 10x10 jpeg; no storageRef; contentType 'image/svg+xml'; pipeline 'wm'; a 20x20 webp row without resizer/pipeline fields
  // storedIdentities(media, { resizer: 'default', pipeline: 'default' }) deepEqual Set(['default:default:10x10:jpeg:none', 'default:default:20x20:webp:none'])
test('storedPreviews keeps the later of two rows with one identity', …)
test('missing skips stored identities and sizes without a key', …)
  // sizes [{ width: 10, height: 10 }, {}, { width: 30 }], formats ['jpeg'] → sizeKeys ['30w']
test('configuredFormats keeps configured ids in order and names the rest once', …)
  // catalog.configuredFormats(['jpeg', 'jpg', 'webp', 'jpg']) deepEqual { formats: ['jpeg', 'webp'], dropped: ['jpg'] }; configuredFormats() → { formats: ['jpeg', 'webp'], dropped: [] }
test('splitConfigured treats a malformed tap entry as unconfigured', …)
  // [{ sizeKey: '10x10', format: 'webp' }, { sizeKey: '10x10', format: 'raw' }, null as never] → configured.length 1, unconfigured.length 2
```
In `src/architecture.test.ts`:
```ts
test('only images.ts decides which stored rows count', () => {
  const users = sourceFiles().filter((f) => f !== 'images.ts' && readFileSync(new URL(`./${f}`, import.meta.url), 'utf8').includes('isUsablePreview('));
  assert.deepEqual(users, []);
});
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/catalog.test.ts src/architecture.test.ts`. Expected: FAIL. `./catalog.ts` is missing, and `users` equals `['engine.ts', 'resizeTask.ts']`.
- [ ] **Step 3: Implement the five pure functions in `src/images.ts` and `Catalog` in `src/catalog.ts`.** `expandMissingPreviews` and `isCatalogCovered` use `storedIdentities`. `Catalog` methods bind `config` and delegate. `engine.ts`, `resizeTask.ts`, `enqueue.ts` and `worker.ts` call the pure functions; Tasks 12–13 switch them to an injected `Catalog`.
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm test && npm run types:check && npm run check`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A src && git commit -m "refactor: one implementation of stored identities and configured formats, wrapped by Catalog"`

### Task 10: `Uploader`, and the composition root starts building services

**Files:**
- Create: none (`git mv src/original.ts src/uploader.ts`, `git mv src/original.test.ts src/uploader.test.ts`)
- Modify: `src/uploader.ts:129-205`, `src/resizer.ts` (`ready()`, `uploadOriginal`)
- Test: `src/uploader.test.ts`

**Interfaces:**
Consumes: `Catalog`, `CatalogDeps` (Task 9).
Produces:
```ts
// src/uploader.ts
export interface UploaderDeps { storage: ResizeStorage; config: ResizeConfig }
export class Uploader { constructor(deps: UploaderDeps); upload(opts: UploadOriginalOpts): Promise<Original> }
// src/resizer.ts (private)
interface Services { catalog: Catalog; uploader: Uploader } // grows in Tasks 11–13
// ready(): loads the parts, checks RESIZE_LOCKS_REQUIRED, then builds Services once from the validated config;
// a failed build is retried by the next call. #services(): Promise<Services> awaits ready() and returns them.
```
**Decision:** `Uploader` takes no logger, because `uploadOriginal` logs nothing.

- [ ] **Step 1: Write the failing test.** In `src/uploader.test.ts`:
```ts
test('an Uploader stores an original with only storage and config', async () => {
  const uploads: StorageUploadArgs[] = [];
  const storage: ResizeStorage = { download: async () => Buffer.alloc(0), upload: async (args) => { uploads.push(args); return { key: args.key }; }, publicUrl: () => '' };
  const original = await new Uploader({ storage, config: makeImageConfig() }).upload({ body: png64x48, visibility: 'private' });
  assert.match(uploads[0].key, /^originals\/[0-9a-f]{32}\.png$/);
  assert.deepEqual({ format: original.format, contentType: original.contentType, width: original.width, height: original.height }, { format: 'png', contentType: 'image/png', width: 64, height: 48 });
});
```
`png64x48` is built once with sharp in the file, like the existing fixtures.
- [ ] **Step 2: Run the test to verify it fails.** Run: `node --experimental-strip-types --test src/uploader.test.ts`. Expected: FAIL with "does not provide an export named 'Uploader'".
- [ ] **Step 3: Implement `class Uploader` in `src/uploader.ts`, and `Services` with `#services()` in `src/resizer.ts`.** `uploadOriginalImpl`'s body becomes `upload()` (`resizer.storage` → `deps.storage`, `resizer.config` → `deps.config`). `Resizer.uploadOriginal` returns `(await this.#services()).uploader.upload(opts)`.
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm test && npm run types:check && npm run check`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A src && git commit -m "refactor: Uploader owns uploadOriginal; the Resizer builds its services in ready()"`

### Task 11: `Dispatcher`, which needs only a lock store and a task queue

**Files:**
- Create: `src/helpers/log.ts` (`git mv src/enqueue.ts src/dispatcher.ts`, `git mv src/enqueue.test.ts src/dispatcher.test.ts`)
- Modify: `src/dispatcher.ts`; `src/resizer.ts` (`Services`, `resolve`, `prewarm`); `src/engine.ts:60-71, 190-219, 252-290, 493-499, 621-628` (until Task 12, `resolveImpl` and `prewarmImpl` take the dispatcher as an argument instead of calling `ready()`)
- Test: `src/dispatcher.test.ts`, `src/resizer.test.ts`

**Interfaces:**
Consumes: `LockStore` (Task 3); `DISPATCH_LOCK_OWNER`, `dispatchLockKey` (Task 7); `canonicalizeVariants` (Task 9); `QueueTiming`, `timingOf` (`src/queue.ts`); `Services` (Task 10).
Produces:
```ts
// src/dispatcher.ts
export interface DispatcherDeps { tasks: TaskQueue; locks: LockStore; timing: QueueTiming; name: string; logger: ResizeLogger }
export interface DispatchRequest { mediaId: string; pipeline: string; previews: MissingPreview[]; queue: string }
export interface ConfirmedEnqueueResult { accepted: MissingPreview[]; unconfirmed: MissingPreview[]; tasks: EnqueueReceipt[]; issues: EnqueueIssue[] } // unchanged
export class Dispatcher {
  constructor(deps: DispatcherDeps);
  enqueue(req: DispatchRequest): Promise<number>;                           // today's enqueue(): best effort, never throws
  enqueueConfirmed(req: DispatchRequest): Promise<ConfirmedEnqueueResult>; // today's enqueueConfirmed() for prewarm
}
export function noQueueResult(previews: MissingPreview[]): ConfirmedEnqueueResult; // RESIZE_ENQUEUE_NO_QUEUE, not retryable
export function buildRequestKey(task: { mediaId: string; resizer: string; queue: string; pipeline: string; previews: readonly MissingPreview[] }): string; // unchanged
// src/engine.ts (moves to reader.ts in Task 12) — the body of prewarmImpl's catch, now shared with the facade's guard
export function prewarmFailure(err: unknown, requested: MissingPreview[]): PrewarmResult; // RESIZE_ENQUEUE_INTERNAL_ERROR; retryable unless ResizeMediaError / ResizeConfigError / ResizeSetupError
// src/helpers/log.ts — engine.ts's logNeverThrow, generalized
export function logNeverThrow(logger: ResizeLogger, message: string, err: unknown): void; // a throwing logger falls back to console.error
// src/resizer.ts: Services gains `dispatcher: Dispatcher | undefined`, built only when tasks resolves, with timing: timingOf(tasks)
```
**Decision (timing at `ready()`):** the Dispatcher gets its timing at construction, so `ready()` now validates the task queue's timing. An invalid timing fails every method's first call (`resolve` and `prewarm` still never throw), as a framework timing conflict already does today.
**Decision (where prewarm lives):** the Dispatcher owns what counts as queued (`enqueueConfirmed`: locks, receipts, `findActive` proof, issues). The request half of `prewarm` (host waterfalls, catalog expansion, the ready/required split) runs host hooks, so it moves to `Reader` in Task 12, beside `resolve`. This keeps the Dispatcher's dependencies to the five the brief lists (the spec's later `coordination` and `metrics` arrive in S2 and S5).

- [ ] **Step 1: Write the failing tests.** Convert `src/dispatcher.test.ts` to build `makeDispatcher({ tasks?, locks? })` = `new Dispatcher({ tasks, locks, timing: timingOf(tasks), name: 'default', logger: recordingLogger })`, with no `FrameworkResizer` and no fake app. Every existing assertion stays. First test:
```ts
test('a Dispatcher works with only a lock store and a task queue', async () => {
  const tasks = new MemoryTaskQueue();
  const dispatcher = new Dispatcher({ tasks, locks: memoryLocks(), timing: timingOf(tasks), name: 'default', logger: silent });
  const req: DispatchRequest = { mediaId: 'm1', pipeline: 'default', previews: [variant()], queue: 'default' };
  assert.equal(await dispatcher.enqueue(req), 1);
  assert.equal(await dispatcher.enqueue(req), 0); // the dispatch lock is held
  assert.equal(tasks.added.length, 1);
  const confirmed = await dispatcher.enqueueConfirmed({ ...req, mediaId: 'm2' });
  assert.deepEqual(confirmed.accepted, [variant()]);
  assert.equal(confirmed.tasks[0].taskId, 'task-2');
});
test('noQueueResult reports every variant as unconfirmed with a non-retryable issue', …)
```
In `src/resizer.test.ts`:
```ts
test('ready() validates the task queue timing; resolve() still never throws', …)
  // tasks: new MemoryTaskQueue({ timing: { leaseMs: 0 } }), locks: memoryLocks() → ready() rejects code RESIZE_CONFIG_QUEUE_LEASE_INVALID; resolve() → safe empty decision
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/dispatcher.test.ts src/resizer.test.ts`. Expected: FAIL with "does not provide an export named 'Dispatcher'".
- [ ] **Step 3: Implement `class Dispatcher` in `src/dispatcher.ts`.** The two functions become methods: `resizer.tasks`/`.locks`/`.name`/`.logger` → `deps`, and `timingOf(tasks).lockTtlMs.dispatch` → `deps.timing.lockTtlMs.dispatch`. Lock fan-out, releases and issue wording are unchanged. Move `logNeverThrow` to `src/helpers/log.ts`, and export `prewarmFailure` from `engine.ts`. In `src/resizer.ts`, `resolve` and `prewarm` await `#services()` inside a never-throw guard: a failure goes to `logNeverThrow` and returns the safe decision, or `prewarmFailure(err, [])`. They then call `resolveImpl(this, services.dispatcher, opts)` / `prewarmImpl(this, services.dispatcher, opts)`. `enqueueMissing` defaults to `dispatcher !== undefined`, and the no-queue prewarm path uses `noQueueResult`.
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm test && npm run types:check && npm run check`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A src && git commit -m "refactor: Dispatcher takes only its task queue, locks, timing, name and logger"`

### Task 12: `Reader`: `resolve` and the request half of `prewarm`

**Files:**
- Create: none (`git mv src/engine.ts src/reader.ts`, `git mv src/engine.test.ts src/reader.test.ts`)
- Modify: `src/reader.ts`; `src/resizer.ts` (`Services`, `resolve`, `prewarm`)
- Test: `src/reader.test.ts`

**Interfaces:**
Consumes: `Catalog` (Task 9); `HookBus`, `PipelineRegistry` (Task 8); `Dispatcher`, `DispatchRequest`, `noQueueResult`, `prewarmFailure`, `logNeverThrow` (Task 11); `Services` (Task 10); `ResolveOpts`, `PrewarmOpts` (Task 8, `types.d.ts`).
Produces:
```ts
// src/reader.ts
export interface ReaderDeps {
  catalog: Catalog; dispatcher: Dispatcher | undefined; hooks: HookBus; pipelines: PipelineRegistry;
  storage: ResizeStorage; logger: ResizeLogger; name: string; queue: string; // queue: the Resizer's default queue name
}
export class Reader {
  constructor(deps: ReaderDeps);
  resolve(opts: ResolveOpts): Promise<{ decision: ReadDecision; output: unknown }>; // never throws
  prewarm(opts: PrewarmOpts): Promise<PrewarmResult>;                              // never throws
}
// prewarmFailure moves here with the file (git mv); signature unchanged from Task 11
// src/resizer.ts: Services gains `reader: Reader`; resolve()/prewarm() → services.reader (the guard around #services() stays)
```
**Decision:** `ReaderDeps` adds `pipelines` (resolve and prewarm check `has(pipeline)`) and `queue` (the default queue for missing variants) to the brief's list.

- [ ] **Step 1: Write the failing tests.** In `src/reader.test.ts` (the `resizer.resolve` tests stay; they now run through the `Reader`):
```ts
test('a Reader serves stored previews and queues the missing ones, with no Resizer and no media store', async () => {
  const tasks = new MemoryTaskQueue();
  const config = makeImageConfig({ formats: ['webp'] });
  const reader = new Reader({
    catalog: new Catalog({ config }),
    dispatcher: new Dispatcher({ tasks, locks: memoryLocks(), timing: timingOf(tasks), name: 'default', logger: silent }),
    hooks: new HookBus({ logger: silent }), pipelines: new PipelineRegistry(),
    storage: { download: async () => Buffer.alloc(0), upload: async () => ({ key: 'k' }), publicUrl: (ref) => `https://cdn/${(ref as { key: string }).key}` },
    logger: silent, name: 'default', queue: 'default',
  });
  const media: MediaLike = { id: 'm1', original: { storageRef: { key: 'o' } }, previews: [{ storageRef: { key: 'p' }, sizeKey: '10x10', format: 'webp', contentType: 'image/webp' }] };
  const { decision } = await reader.resolve({ media, sizes: [{ width: 10, height: 10 }, { width: 20, height: 20 }] });
  assert.deepEqual(decision.ready.map((e) => e.url), ['https://cdn/p']);
  assert.deepEqual(decision.missing.map((v) => v.sizeKey), ['20x20']);
  assert.deepEqual(tasks.added[0].previews.map((v) => v.sizeKey), ['20x20']);
  assert.equal((await reader.prewarm({ media, sizes: [{ width: 30, height: 30 }] })).status, 'accepted');
});
test('a Reader without a Dispatcher (eager only) reports RESIZE_ENQUEUE_NO_QUEUE from prewarm', …)
  // same deps with dispatcher: undefined → status 'incomplete', issues[0].code 'RESIZE_ENQUEUE_NO_QUEUE', retryable false
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/reader.test.ts`. Expected: FAIL with "does not provide an export named 'Reader'".
- [ ] **Step 3: Implement `class Reader` in `src/reader.ts`.** `resolveImpl` becomes `resolve`, and `prewarmImpl`/`prewarmStrict` become `prewarm`. Replace `resizer.runWaterfall` → `hooks`, `hasPipeline` → `pipelines.has`, the stored-identity and format helpers → `catalog`, and `enqueue`/`enqueueConfirmed` → `dispatcher` (`noQueueResult` when it is undefined). Each method's own catch uses `logNeverThrow` and `prewarmFailure`.
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm test && npm run types:check && npm run check`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A src && git commit -m "refactor: Reader owns resolve and the request half of prewarm"`

### Task 13: `Processor`: eager generate, queued tasks, cooldown and task observers

**Files:**
- Create: none (`git mv src/resizeTask.ts src/processor.ts`, `git mv src/resizeTask.test.ts src/processor.test.ts`)
- Modify: `src/processor.ts`; `src/resizer.ts` (`Services`, `generate`, the new `processor` getter; delete the delegates `runWaterfall`, `runObservers`, `getPipeline`); `src/worker.ts:27-95, 156-176`
- Test: `src/processor.test.ts`

**Interfaces:**
Consumes: `Catalog` (Task 9); `HookBus`, `PipelineRegistry` (Task 8); `MediaStore`, `LockStore` (Task 3); `DISPATCH_LOCK_OWNER`, `dispatchLockKey`, `workerLockKey` (Task 7); `Services` (Task 10); `GenerateOpts`, `GenerateResult` (Task 8).
Produces:
```ts
// src/processor.ts
export interface ProcessorDeps {
  catalog: Catalog; media: MediaStore; storage: ResizeStorage; locks: LockStore | undefined;
  pipelines: PipelineRegistry; hooks: HookBus; config: ResizeConfig; logger: ResizeLogger; name: string;
}
export class Processor {
  constructor(deps: ProcessorDeps);
  generate(opts: GenerateOpts): Promise<GenerateResult>;                                                   // today's generateImpl
  processTask(task: LeasedTask, opts: { signal?: AbortSignal; workerLockTtlMs: number }): Promise<void>;  // today's processTaskWith; no locks → RESIZE_LOCKS_REQUIRED
  holdFailedCooldown(task: LeasedTask, ttlMs: number): Promise<void>;                                     // moved from worker.ts; never rejects
  notify(event: TaskEvent, task: LeasedTask, error?: unknown): Promise<void>;                             // afterTaskComplete / onTaskFailed / onTaskDeadLettered with ctx {}
}
// generatePreviews becomes the private #generatePreviews(args: GenerateCoreArgs), with the same body apart from resizer.x → this.#deps.x
// src/resizer.ts: Services gains `processor: Processor`; `get processor(): Processor` (RESIZE_NOT_READY before ready()) is the worker's entry
```
**Decision:** `ProcessorDeps` holds the whole `HookBus` (eager `generate` runs the `resolveSizes` waterfall, and tasks fire observers) and a `Catalog` (stored identities in one place). The brief listed only the observer side and no catalog.

- [ ] **Step 1: Write the failing tests.** In `src/processor.test.ts` (with the file's `mediaDoc`, `task`, `variant`, `makeStorage`, `redPng`):
```ts
test('a Processor renders a task with only its ports (no Resizer)', async () => {
  const config = makeImageConfig({ formats: ['jpeg'] });
  const locks = memoryLocks();
  const { storage, uploads } = makeStorage(redPng);
  const processor = new Processor({ catalog: new Catalog({ config }), media: fakeMedia({ load: async () => mediaDoc() }), storage, locks,
    pipelines: new PipelineRegistry(), hooks: new HookBus({ logger: silent }), config, logger: silent, name: 'default' });
  await processor.processTask(task({ previews: [variant()] }), { workerLockTtlMs: 1000 });
  assert.equal(uploads.length, 1);
  assert.equal(await locks.acquire('resize_worker:m1:default:default:20x20:jpeg:none', 'other', 1000), true); // released
});
test('processTask without a lock store is RESIZE_LOCKS_REQUIRED', …) // locks: undefined → rejects ResizeSetupError code RESIZE_LOCKS_REQUIRED
test('notify maps task events to their observers with ctx {}', …)
  // hooks.add('onTaskFailed', (t, e, ctx) => seen.push([t.taskId, e, ctx])); notify('failed', task(), err) → seen deepEqual [['t1', err, {}]]
test('holdFailedCooldown re-takes every dispatch lock of the task for ttlMs and never rejects', …)
  // a recorder sees release then acquire of 'resize_dispatch:m1:default:default:20x20:jpeg:none' with owner 'resize:dispatch' and ttl 600_000; a throwing store → resolves
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/processor.test.ts`. Expected: FAIL with "does not provide an export named 'Processor'".
- [ ] **Step 3: Implement `class Processor` in `src/processor.ts`.** Make the three entry functions methods. Move `holdFailedCooldown` and the `OBSERVER` table here from `worker.ts`. `worker.ts`'s `processTask` and event handler call `resizer.processor.processTask(task, { signal, workerLockTtlMs })`, `.holdFailedCooldown(task, timingOf(tasks).lockTtlMs.failed)` and `.notify(event, task, error)`; the default TTL rule (`tasks ?? resizer.tasks`, otherwise `defaultQueueOptions.lockTtlMs.worker`) is unchanged. `Resizer.generate` returns `(await this.#services()).processor.generate(opts)`. Delete the three delegates, and move their remaining test callers in `resizer.test.ts` and `framework/resizer.test.ts` to observable behaviour (hooks via `resolve`/`generate`).
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm test && npm run types:check && npm run check`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A src && git commit -m "refactor: Processor owns generate, queued tasks, the dead-letter cooldown and task observers"`

### Task 14: `Consumer`, the worker loop

**Files:**
- Create: `src/consumer.ts`, `src/testHelpers/consume.ts`, `src/timing.test.ts` (`git mv src/queue.ts src/timing.ts`, `git mv src/queue.test.ts src/consumer.test.ts`)
- Modify: `src/timing.ts` (keeps `QueueTiming`, `fillTiming`, `timingOf`, the private `validateFailedLockTtl`); every importer of `./queue.ts` (`resizer.ts`, `dispatcher.ts`, `worker.ts`, `framework/config.ts`, `framework/queue.ts`) and of `consumeQueue` (`worker.ts`, `worker.test.ts`, `drivers/sqs.test.ts`, `drivers/mongo/taskQueue.test.ts`, `framework/resizer.test.ts`)
- Test: `src/consumer.test.ts`, `src/timing.test.ts`

**Interfaces:**
Consumes: `timingOf`, `QueueTiming` (now `src/timing.ts`).
Produces:
```ts
// src/consumer.ts
export interface ConsumerDeps {
  tasks: TaskQueue; timing: QueueTiming;
  handle: (task: LeasedTask, opts: { signal: AbortSignal }) => Promise<void>;
  events?: TaskEventHandler; logger: ResizeLogger;
}
export class Consumer { constructor(deps: ConsumerDeps); run(queue: string, signal: AbortSignal): Promise<void> } // today's consumeQueue body
export function backoffMs(attempts: number, timing: QueueTimingOptions): number; // moved
export function toLeasedTask(task: ClaimedTask): LeasedTask;                   // moved
// src/testHelpers/consume.ts — the old consumeQueue options, for tests
export function consume(tasks: TaskQueue, opts: { queue: string; signal: AbortSignal; handle: ConsumerDeps['handle']; onEvent?: TaskEventHandler; logger?: ResizeLogger }): Promise<void>;
```

- [ ] **Step 1: Write the failing tests.** In `src/consumer.test.ts`:
```ts
test('a Consumer completes a task with only its own deps', async () => {
  const tasks = new MemoryTaskQueue({ timing: fastTiming });
  await tasks.add(newTask());
  const stop = new AbortController();
  const events: TaskEvent[] = [];
  await new Consumer({ tasks, timing: timingOf(tasks), handle: async () => { stop.abort(); }, events: (event) => { events.push(event); },
    logger: { info() {}, warn() {}, error() {} } }).run('default', stop.signal);
  assert.equal(tasks.rows[0].status, 'completed');
  assert.deepEqual(events, ['completed']);
});
```
The other loop tests call `consume(tasks, …)`. Move the four `timingOf` tests of `describe('timingOf / backoffMs')` to `src/timing.test.ts`; 'backoff doubles per attempt up to the maximum' stays in `consumer.test.ts`.
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/consumer.test.ts src/timing.test.ts`. Expected: FAIL with "Cannot find module './consumer.ts'".
- [ ] **Step 3: Implement `class Consumer` in `src/consumer.ts` and `consume()` in `src/testHelpers/consume.ts`.** `consumeQueue`'s body becomes `run()`, with `opts.onEvent` → `deps.events` and `timingOf(tasks)` → `deps.timing`; delete `consumeQueue`. `worker.ts` builds `new Consumer({ tasks, timing: timingOf(tasks), handle, events, logger }).run(queue, stop.signal)`. Replace `consumeQueue(` with `consume(` in the listed tests.
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm test && npm run types:check && npm run check`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A src && git commit -m "refactor: Consumer owns the worker loop; queue timing moves to timing.ts"`

### Task 15: `runWorker({ resizers })`

**Files:**
- Modify: `src/worker.ts:97-217`
- Test: `src/worker.test.ts`

**Interfaces:**
Consumes: `Consumer` (Task 14), `Processor` and `resizer.processor` (Task 13), `listResizers` (Task 8).
Produces:
```ts
export interface RunWorkerOptions {
  queue?: string; signal: AbortSignal; logger?: ResizeLogger; sharp?: { concurrency: number; cache: boolean };
  resizers?: Resizer[]; // default listResizers(); tasks and events are routed by name among these only
}
export function runWorker(opts: RunWorkerOptions): Promise<void>;
// internal, unchanged signature (exported in S6): processTask(task: LeasedTask, taskOpts?: { signal: AbortSignal }, tasks?: TaskQueue): Promise<void>
```

- [ ] **Step 1: Write the failing tests.** In `src/worker.test.ts`:
```ts
test('runWorker({ resizers }) serves only the given Resizers', …)
  // Resizers 'a' and 'b' share one MemoryTaskQueue; one task each; runWorker({ signal, resizers: [a] }) until a's row is 'completed', then abort
  // → b's row: status 'pending', attempts 1, error matches /no Resizer named 'b'/
test('runWorker({ resizers: [] }) fails with RESIZE_NO_RESIZER', …) // rejects ResizeSetupError code RESIZE_NO_RESIZER, even with Resizers registered
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/worker.test.ts`. Expected: FAIL, because `resizers` is ignored and b's task completes.
- [ ] **Step 3: Implement `RunWorkerOptions.resizers` in `src/worker.ts`.** `runWorker` uses `opts.resizers ?? listResizers()` for readiness, verification, the queue set, the `handle` routing (an unknown name → `ResizeSetupError` `RESIZE_NO_RESIZER` with `getResizer`'s message) and the event routing. `processTask` keeps routing through the registry.
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm test && npm run types:check && npm run check`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/worker.ts src/worker.test.ts && git commit -m "feat: runWorker takes an explicit list of Resizers"`

### Task 16: Guards: who may import `resizer.ts`, and no cycle back into it

**Files:**
- Modify: `src/importGraph.test.ts` (`walk(entry, { types })`), `src/architecture.test.ts:7-51`
- Test: the same files

**Interfaces:**
Consumes: `sourceFiles`, `localImports` (Task 2).
Produces: (test-only) `walk(entry: string, opts?: { types: boolean }): { files: Map<string, string[]>; bare: Map<string, string[]> }`; `types: true` also follows type imports.

- [ ] **Step 1: Write the tests.** In `src/importGraph.test.ts`:
```ts
test('only index.ts, worker.ts, registry.ts and the framework adapter import resizer.ts', () => {
  const allowed = (f: string) => ['index.ts', 'worker.ts', 'registry.ts'].includes(f) || f.startsWith('framework/');
  assert.deepEqual(sourceFiles().filter((f) => !allowed(f) && localImports(f, { types: true }).includes('resizer.ts')), []);
});
test('nothing resizer.ts reaches imports it back, except registry.ts with import type', () => {
  const back = [...walk('resizer.ts', { types: true }).files.keys()].filter((f) => f !== 'resizer.ts' && localImports(f, { types: true }).includes('resizer.ts'));
  assert.deepEqual(back, ['registry.ts']);
  assert.equal(localImports('registry.ts', { types: false }).includes('resizer.ts'), false);
});
test('the Dispatcher and its test need no Resizer, framework, storage or media port', () => {
  assert.deepEqual([...walk('dispatcher.test.ts', { types: true }).files.keys()].filter((f) => f === 'resizer.ts' || f.startsWith('framework/')), []);
  assert.deepEqual(localImports('dispatcher.ts', { types: true }).filter((t) => t === 'contracts/storage.ts' || t === 'contracts/media.ts'), []);
});
```
In `src/architecture.test.ts`, replace `CORE_FILES` with `sourceFiles().filter((f) => !f.includes('/') && !['worker.ts', 'registry.ts', 'index.ts', 'types.d.ts'].includes(f))`, and add `'listResizers'` to `GLOBAL_LOOKUPS`.
- [ ] **Step 2: Run the tests, then prove that the guard catches a violation.** Run: `node --experimental-strip-types --test src/importGraph.test.ts src/architecture.test.ts`. Expected: PASS, because Tasks 10–13 removed the last importers. Then temporarily add `import type { Resizer } from './resizer.ts';` (plus `export type _R = Resizer;`) to `src/catalog.ts` and run again. Expected: FAIL, naming `catalog.ts` in both new `resizer.ts` tests. Revert the change.
- [ ] **Step 3: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS.
- [ ] **Step 4: Commit.** `git add src/importGraph.test.ts src/architecture.test.ts && git commit -m "test: guard the composition root: only entry points import resizer.ts, and nothing it reaches imports it back"`

### Task 17: Documentation

**Files:**
- Modify: `README.md:123-153, 154-166, 167-182, 212-223, 237-248, 276-282, 299-302, 329-337, 355, 384-390`; `AGENTS.md` (step 3, the "Errors" paragraph, the Troubleshooting rows); `CHANGELOG.md` (under `# 0.3.0` → **Breaking changes**); `/Users/andrey/Work/framework-documenation-github/docs/12-resize.md` (a separate repo)
- Test: `src/agentsDoc.test.ts`

**Interfaces:**
Consumes: every exported name from Tasks 1–15: `MediaStore`, `LockStore`, `mongoParts`, `MongoMediaStore`, `MongoLockStore`, `FrameworkMediaStore`, `FrameworkLockStore`, `ResizeError.retryable`, `RunWorkerOptions.resizers`, the codes `RESIZE_MEDIA_REQUIRED`, `RESIZE_LOCKS_REQUIRED` and `RESIZE_MEDIA_APPEND_RESULT_INVALID`.

- [ ] **Step 1: Update README.md.**
  - "Without the framework": `const parts = mongoParts(mongoose.connection, { mediaModel: File })` and `new Resizer({ config, storage, ...parts })`, with the "call it once" note.
  - "Package exports": main entry `MediaStore`, `LockStore` (no `ResizeDatabase`); mongo `mongoParts`, `MongoMediaStore`, `MongoLockStore`, `MongoTaskQueue`, …; framework `FrameworkMediaStore`, `FrameworkLockStore`.
  - "Drivers" intro: four parts (`storage`, `media`, `locks` when queued, `tasks`).
  - The `mongoParts` / `MongoMediaStore` / `MongoLockStore` option paragraph.
  - SQS: "with any media and lock store".
  - The locks paragraph: owners with compare-and-delete; dispatch locks share the owner `resize:dispatch` in this release; `FrameworkLockStore` stores the owner in the framework `Lock` collection.
  - Custom drivers: `MediaStore` (`appendPreviews` must resolve with the stored rows, otherwise `RESIZE_MEDIA_APPEND_RESULT_INVALID`) and `LockStore` bullets replace `ResizeDatabase`.
  - `release()` and Operations: dead at once = an error with `retryable: false` (name the five codes that set it).
  - Config reference: `mongoParts` replaces `mongoDatabase`, and the `FrameworkDatabase` mentions become `FrameworkMediaStore` / "every Resizer on the database queue". The lock TTL rows stay unchanged.
- [ ] **Step 2: Update AGENTS.md.**
  - Step 3: `FrameworkResizer` builds `FrameworkMediaStore` + `FrameworkLockStore`; the options are `media`, `locks`, `tasks`; without the framework, `new Resizer({ storage, media, locks?, tasks? })` with `...mongoParts(connection, { mediaModel, timing? })`; custom drivers extend `ResizeStorage`, `MediaStore`, `LockStore` or `TaskQueue`.
  - Errors: `err.retryable`.
  - Troubleshooting: `RESIZE_DATABASE_REQUIRED` → `RESIZE_MEDIA_REQUIRED`; new rows `RESIZE_LOCKS_REQUIRED` and `RESIZE_MEDIA_APPEND_RESULT_INVALID`; `RESIZE_NOT_READY` names `media` / `locks` / `tasks`; `RESIZE_MONGO_MODEL_MISSING` names the lock model passed to `MongoLockStore`; `RESIZE_MONGO_MODEL_REQUIRED` names `new MongoMediaStore()` / `new MongoLockStore()` / `new MongoTaskQueue()` / `mongoParts`.
- [ ] **Step 3: Update CHANGELOG.md** under `# 0.3.0`, **Breaking changes**:
  - `ResizeDatabase` → `MediaStore` + `LockStore`.
  - `new Resizer({ storage, media, locks?, tasks? })`; `resizer.db` removed.
  - `mongoDatabase` / `MongoDatabase` → `mongoParts` / `MongoMediaStore` / `MongoLockStore`.
  - `FrameworkDatabase` → `FrameworkMediaStore` / `FrameworkLockStore`; `FrameworkResizer({ media, locks, tasks })`.
  - `LockStore` owners; `ResizeLock.owner`.
  - `appendPreviews` must resolve with the stored rows.
  - `ResizeError.retryable` decides dead-lettering.
  - `SqsTaskQueue` validates lock TTLs at first use, not at construction.
  - `Resizer.registerPipeline` / `getPipeline` / `runWaterfall` / `runObservers` removed (pipelines are fixed at construction).
  - `runWorker({ resizers })`.
  - New codes.
- [ ] **Step 4: Update the docs site.** In `/Users/andrey/Work/framework-documenation-github`, run `git checkout -b docs/s1-ports`. In `docs/12-resize.md`, update "4. Create the Resizer" (line 114: `FrameworkMediaStore` + `FrameworkLockStore`), the "Drivers" table row at line 432 and the paragraphs at 437 and 470 (the ports `MediaStore` / `LockStore`), and "Without the framework" (489-516: `mongoParts`). Keep the guide there and the reference in README, without duplicating the reference. Then commit: `git -C /Users/andrey/Work/framework-documenation-github commit -am "docs(resize): media and lock ports, mongoParts"`.
- [ ] **Step 5: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS, with `agentsDoc.test.ts` finding every snippet import among the real exports.
- [ ] **Step 6: Commit.** `git add README.md AGENTS.md CHANGELOG.md && git commit -m "docs: media and lock ports, mongoParts, retryable errors"`

---

## Definition of done (S1)

- A Dispatcher unit test constructs only `memoryLocks()` and the in-memory `MemoryTaskQueue` (Task 11), and a guard pins it (Task 16).
- No service file imports `resizer.ts`, and nothing `resizer.ts` reaches imports it back, except `registry.ts` with `import type` (Task 16).
- `drivers/**` import only contracts, errors, helpers, types and other drivers (Task 2).
- `src/drivers/mongo/frameworkFree.integration.test.ts` wires through `mongoParts` (Task 7).
- `npm test`, `npm run types:check`, `npm run check`, `npm run build` and `npm run smoke` pass, and README, AGENTS.md, CHANGELOG and the docs-site page describe the ports (Task 17).
