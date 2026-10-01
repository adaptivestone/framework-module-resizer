# P4 — The Framework Becomes an Adapter: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The package's main entry works without `@adaptivestone/framework`. Framework integration becomes one opt-in subpath, `@adaptivestone/framework-module-resize/framework.js`, and a framework-free host can run eager generation, reads and the Mongo-queued worker with explicit options.

**Architecture:**
- **Core needs explicit parts.** `new Resizer()` requires `config` and `mediaStore`, takes `logger` (default `console`), and requires `lockProvider` when a `transport` is given. It never reads the framework app.
- **One adapter module holds all framework code.** `src/framework/` contains the app gateway, config loading, `createFrameworkResizer()` (which fills those parts from the app), `createFrameworkMongoTransport()`, the framework worker entry, the `ResizeWorker` CLI command, and `ResizeTaskModel`.
- **Transports take explicit options.** `MongoTransport` gets its model, logger and timing through options instead of the global config. `SqsTransport` gets a `logger` option.
- **Tests enforce it.** A guard test walks the main entry's import graph and fails if it reaches the framework, and a framework-free example runs in the suite.

**Tech Stack:** Node ≥ 24, TypeScript 7 (`erasableSyntaxOnly`, ESM), `node:test`, Biome, mongoose 9 (tests: `mongodb-memory-server`).

**Spec:** [`docs/design/2026-09-30-multi-resizer.md`](../../design/2026-09-30-multi-resizer.md): decision D7, D8 (partially; see below), and the P4 section of §6. Builds on P1–P3.

**Scope decision on D8.** Config keys keep their current names and places, so no new removed-key errors. `MongoTransport` takes its own timing options, and the framework adapter maps `config.queue.*` onto them. `config.worker.*` is read by the framework worker entry. `mediaModelName` leaves the core `ResizeConfig` and becomes part of `FrameworkResizeConfig`. The open question in design §8 is settled like this: each Resizer reads its own framework config file, `createFrameworkResizer({ configName: 'resizeListings' })`, defaulting to `'resize'`.

## Global Constraints

- The module is pre-release: breaking API changes are allowed and ship without data migrations.
- Every task ends with `npm run types:check`, `npm run check`, `npm run build`, `npm test`, `npm run smoke` all passing.
- No new runtime dependencies. No dynamic `import()` for optional dependencies (subpath entries with static imports instead). No test-only code paths in shipped modules.
- Classes for shipped drivers; contracts stay interfaces.
- `src/architecture.test.ts` keeps passing; P2's rule (no `getResizer` in transports) and P3's rule (identities only through `getPreviewIdentity`) keep holding.
- New comments state reasons in plain words; no archived-spec section references. Public repository: no private project names. Commit messages: conventional prefix, no `Co-Authored-By`, no AI attribution.

## Review Focus

1. A framework host upgrading with an unchanged `src/resizer.ts` (`new Resizer({ storage, transport })`) must get a named error telling it to use `createFrameworkResizer`, not a `TypeError`. (Test: Task 2.)
2. A framework-free host constructs a `Resizer` before (or without) any framework `Server` → no framework access at all; `logger` defaults to `console`. (Test: Task 6.)
3. A `transport` without a `lockProvider` → `RESIZE_LOCK_PROVIDER_REQUIRED` at construction, not a crash on the first read. (Test: Task 2.)
4. A `MongoTransport` whose lease is shorter than a Resizer's worker lock TTL → the worker refuses to start (`RESIZE_CONFIG_LOCK_EXCEEDS_LEASE`), because the lease must outlive the lock. (Test: Task 4.)
5. Two framework Resizers reading different config files (`resize`, `resizeListings`) must each validate and use their own file, and a missing `mediaModelName` must be reported for the file it is missing from. (Test: Task 3.)

---

## File Structure

| File | Change | Responsibility after P4 |
|---|---|---|
| `src/resizeConfig.ts` | Modify | Pure validation only: no framework import, no `mediaModelName` check. |
| `src/types.d.ts` | Modify | `ResizeConfig` without `mediaModelName`; `FrameworkResizeConfig`; `TMinimalResizeApp` moves to the adapter. |
| `src/config/resize.ts` | Modify | `defaultResizeConfig: ResizeConfig`. |
| `src/resizer.ts` | Modify | No framework defaults; required `config` / `mediaStore`; `lockProvider` required with `transport`. |
| `src/worker.ts` | Modify | Core `runWorker({ queue, signal, logger, sharp })`; no framework, no process signals. |
| `src/transports/mongo.ts`, `src/transports/sqs.ts` | Modify | Explicit options (`model`, `logger`, timing); no `app.ts` import. |
| `src/framework/app.ts` | Move from `src/app.ts` | The framework app gateway. |
| `src/framework/config.ts` | Create | `getResizeConfig(configName?)`: read + validate + `mediaModelName` check. |
| `src/framework/resizer.ts` | Create | `createFrameworkResizer(opts)`, `createFrameworkMongoTransport(opts?)`. |
| `src/framework/worker.ts` | Create | `runResizeWorker({ queue?, configName? })`: enabled check, process signals, app logger. |
| `src/framework/index.ts` | Create | The `./framework.js` subpath entry. |
| `src/commands/ResizeWorker.ts`, `src/models/ResizeTask.ts`, `src/mediaStore/framework.ts`, `src/locks/framework.ts` | Modify | Import the gateway from `src/framework/app.ts`; subpaths unchanged. |
| `src/index.ts` | Modify | Main entry: no `ResizeWorker`, `ResizeTaskModel`, `runResizeWorker`; adds `runWorker`, `listResizers`. |
| `package.json` | Modify | `exports["./framework.js"]`. |
| `src/scaffold/templates/*` | Modify | Use `createFrameworkResizer` / `createFrameworkMongoTransport`; config `satisfies FrameworkResizeConfig`. |
| `src/importGraph.test.ts` | Create | Guard: main entry's import graph reaches no framework code. |
| `src/frameworkFree.test.ts` | Create | Eager generate + resolve with no framework app installed. |
| `smokeTest.ts` | Modify | Export surface; framework subpath; main entry importable with the framework absent. |
| Tests | Modify | Construct Resizers through `createFrameworkResizer` (framework-style tests) or with explicit parts. |

---

### Task 1: Pure core config; framework config loading moves to the adapter

**Files:** `src/resizeConfig.ts`, `src/types.d.ts`, `src/config/resize.ts`, move `src/app.ts` → `src/framework/app.ts`, create `src/framework/config.ts`. Update the imports of `app.ts` in `src/mediaStore/framework.ts`, `src/locks/framework.ts`, `src/transports/*`, `src/worker.ts`, `src/resizer.ts` for now (later tasks remove most of them). Tests: `src/config/resize.test.ts`, new `src/framework/config.test.ts`.

**Interfaces:**

```ts
// src/types.d.ts
export interface ResizeConfig { /* unchanged, minus mediaModelName */ }
export interface FrameworkResizeConfig extends ResizeConfig {
  mediaModelName: string; // host media model for FrameworkMediaStore
}
// TMinimalResizeApp moves to src/framework/app.ts (exported from there, and from ./framework.js as a type).
```

```ts
// src/resizeConfig.ts — pure
export function validateResizeConfig(config: unknown): ResizeConfig; // no mediaModelName rule

// src/framework/config.ts
export function getResizeConfig(configName?: string): FrameworkResizeConfig; // default 'resize'
// Reads getApp().getConfig(configName), validates with validateResizeConfig, then requires a
// non-empty mediaModelName (RESIZE_CONFIG_MEDIA_MODEL_MISSING, message names the config file).
```

- [ ] **Step 1: Tests.** Move the `mediaModelName` assertions from `src/config/resize.test.ts` into `src/framework/config.test.ts`: `getResizeConfig()` reads `'resize'`, `getResizeConfig('resizeListings')` reads that name, and a missing `mediaModelName` throws `RESIZE_CONFIG_MEDIA_MODEL_MISSING` with the config name in the message. In `src/config/resize.test.ts`, assert that `validateResizeConfig` accepts a config *without* `mediaModelName`, and that `src/resizeConfig.ts` has no import of `framework/app.ts` (read the file and check).
- [ ] **Step 2:** Run them; expect FAIL.
- [ ] **Step 3: Implement.** Use `git mv src/app.ts src/framework/app.ts` and fix every import path. Remove the `mediaModelName` rule and the `getApp` import from `src/resizeConfig.ts`. Make `defaultResizeConfig` a `ResizeConfig` (drop the `Omit`). Put `TMinimalResizeApp` in `src/framework/app.ts`, typed with `getConfig(name: string): unknown`.
- [ ] **Step 4:** Run `npm run types:check` and the two test files; PASS.
- [ ] **Step 5: Commit** — `refactor: core config validation no longer reads the framework`

### Task 2: A core Resizer needs explicit parts; `createFrameworkResizer` fills them

**Files:** `src/resizer.ts`, create `src/framework/resizer.ts`, `src/mediaStore/framework.ts` (options unchanged: `{ modelName? }`; its fallback reads `getResizeConfig().mediaModelName` from `src/framework/config.ts`). Tests: `src/resizer.test.ts`, new `src/framework/resizer.test.ts`, and every test file that constructs Resizers.

**Interfaces:**

```ts
// src/resizer.ts
export interface ResizerOptions {
  name?: string;
  queue?: string;
  config: ResizeConfig;           // required
  logger?: ResizeLogger;          // default console
  events?: ResizeEventBus;        // default none
  storage: ResizeStorage;         // required
  mediaStore: MediaStore;         // required
  transport?: QueueTransport;
  lockProvider?: LockProvider;    // required when transport is set
  pipelines?: Record<string, Pipeline>;
  hooks?: { [N in HookName]?: HookSignatures[N] | HookSignatures[N][] };
}
// New codes: RESIZE_CONFIG_REQUIRED, RESIZE_MEDIA_STORE_REQUIRED, RESIZE_LOCK_PROVIDER_REQUIRED.
// Their messages say: "framework hosts: use createFrameworkResizer() from '@adaptivestone/framework-module-resize/framework.js'".
```

```ts
// src/framework/resizer.ts
export interface FrameworkResizerOptions
  extends Omit<ResizerOptions, 'config' | 'mediaStore' | 'logger' | 'events'> {
  configName?: string;     // framework config file; default 'resize'
  config?: FrameworkResizeConfig; // explicit config instead of reading configName
  mediaStore?: MediaStore; // default new FrameworkMediaStore({ modelName: config.mediaModelName })
  logger?: ResizeLogger;   // default app.logger
  events?: ResizeEventBus; // default app.events
}
export function createFrameworkResizer(opts: FrameworkResizerOptions): Resizer;
// lockProvider defaults to new FrameworkLockProvider() when a transport is given.
```

- [ ] **Step 1: Tests.** In `src/resizer.test.ts` (core):
  - `new Resizer({ storage })` throws `RESIZE_CONFIG_REQUIRED`, and the message mentions `createFrameworkResizer`.
  - A missing `mediaStore` throws `RESIZE_MEDIA_STORE_REQUIRED`.
  - A `transport` without `lockProvider` throws `RESIZE_LOCK_PROVIDER_REQUIRED`.
  - With no framework app installed, `new Resizer({ config, storage, mediaStore })` works and its `logger` is `console`.

  In `src/framework/resizer.test.ts`:
  - `createFrameworkResizer({ storage })` reads the `'resize'` config, uses the app logger, a `FrameworkMediaStore` bound to the config's `mediaModelName`, and no lock provider.
  - With a `transport`, it adds a `FrameworkLockProvider`.
  - `configName: 'resizeListings'` reads that config.
  - Explicit options win over every default.
- [ ] **Step 2:** Run them; expect FAIL.
- [ ] **Step 3: Implement.** Remove every framework import from `src/resizer.ts` (`getApp`, `FrameworkMediaStore`, `FrameworkLockProvider`, `frameworkEvents`). Add the three required-part checks, and throw them before the name is registered. Write `createFrameworkResizer`.
- [ ] **Step 4: Migrate tests.** Tests that relied on framework defaults (a fake app installed, then `new Resizer({ storage, … })`) switch to `createFrameworkResizer({ storage, … })` imported from `./framework/resizer.ts`; that keeps their meaning. Tests that are about the core use explicit `config: makeResizeConfig()` and a fake `mediaStore`. Keep assertions unchanged unless they tested the removed defaults.
- [ ] **Step 5:** Run the full suite; PASS.
- [ ] **Step 6: Commit** — `feat: core Resizer takes explicit parts; createFrameworkResizer fills them from the app`

### Task 3: Several framework Resizers with their own config files

**Files:** `src/framework/resizer.ts`, `src/framework/config.ts`. Test: `src/framework/resizer.test.ts`.

- [ ] **Step 1: Test.** Install a fake app whose `getConfig(name)` returns different complete configs for `'resize'` (`formats: ['jpeg']`, `mediaModelName: 'File'`) and `'resizeListings'` (`formats: ['webp']`, `mediaModelName: 'Photo'`).
  - `createFrameworkResizer({ storage })` and `createFrameworkResizer({ name: 'listings', configName: 'resizeListings', storage })` get their own formats and media models.
  - A third config file without `mediaModelName` throws `RESIZE_CONFIG_MEDIA_MODEL_MISSING`, and the message names that file.
- [ ] **Step 2:** Run; FAIL if Task 2 did not already cover it, otherwise PASS. Either way, keep the test.
- [ ] **Step 3: Commit** — `test: framework Resizers read their own config files`

### Task 4: Transports take explicit options; the core worker runner

**Files:** `src/transports/mongo.ts`, `src/transports/sqs.ts`, `src/transports/AbstractTransport.ts`, `src/worker.ts`, create `src/framework/worker.ts`, `src/commands/ResizeWorker.ts`. Tests: `src/transports/mongo.test.ts`, `src/transports/sqs.test.ts`, `src/resizeTask.test.ts` (`runResizeWorker` / `runWorker` describes), `src/worker.mongo.integration.test.ts`.

**Interfaces:**

```ts
// src/transports/mongo.ts
type ModelSource = MongoTaskModel | (() => MongoTaskModel); // a mongoose model, or a lazy getter
export interface MongoTransportOptions {
  model: ModelSource;                 // required: the ResizeTask mongoose model
  logger?: ResizeLogger;              // default console
  leaseMs?: number;                   // default 60000
  retryBackoffMs?: { base: number; max: number }; // default { 5000, 300000 }
  maxAttempts?: number;               // default 5
  idlePollMs?: number;                // default 1000
  taskTimeoutMs?: number;             // default 600000
}
export class MongoTransport implements QueueTransport {
  constructor(opts: MongoTransportOptions);
  readonly leaseMs: number;
  // lifecycle methods unchanged from P2
}
// MongoTaskModel = the minimal model surface the transport calls (findOneAndUpdate, findOne, find), typed structurally.
```

```ts
// src/transports/AbstractTransport.ts: QueueTransport gains an optional
readonly leaseMs?: number; // lease length when the transport leases tasks; the worker checks lock TTLs against it

// src/transports/sqs.ts: SqsTransportOptions gains
logger?: ResizeLogger; // default console
```

```ts
// src/worker.ts (core)
export interface RunWorkerOptions {
  queue?: string;          // default 'default'
  signal: AbortSignal;     // stop the worker
  logger?: ResizeLogger;   // default console
  sharp?: { concurrency: number; cache: boolean }; // process-wide Sharp tuning; omitted = leave Sharp's settings
}
export function runWorker(opts: RunWorkerOptions): Promise<void>;
// Same behavior as P2's runResizeWorker minus: the enabled check, process signals, and framework
// logging. It adds: for each Resizer, when transport.leaseMs is a number and
// resizer.config.queue.lockTtlMs.worker > transport.leaseMs, throw ResizeConfigError
// RESIZE_CONFIG_LOCK_EXCEEDS_LEASE before leasing.
export function processTask(task: LeasedTask, taskOpts?: { signal: AbortSignal }): Promise<void>; // unchanged

// src/framework/worker.ts
export function runResizeWorker(opts?: { queue?: string; configName?: string }): Promise<void>;
// Reads getResizeConfig(configName).worker; returns early with the existing log line when
// enabled === false; wires SIGTERM/SIGINT to an AbortController; calls runWorker with the app
// logger and { concurrency: worker.sharpConcurrency, cache: worker.sharpCache }.

// src/framework/resizer.ts
export function createFrameworkMongoTransport(
  opts?: Partial<Omit<MongoTransportOptions, 'model'>> & { configName?: string },
): MongoTransport;
// model: () => getApp().getModel('ResizeTask') (resolved lazily, after models load);
// logger: the app logger (resolved at call time); timing: from getResizeConfig(configName).queue.
```

- [ ] **Step 1: Tests.**
  - `mongo.test.ts` constructs `new MongoTransport({ model: M, leaseMs: 300, idlePollMs: 20, maxAttempts: 3, retryBackoffMs: { base: 50, max: 200 } })` instead of relying on app config timings.
  - Add: timing comes from options (a `maxAttempts: 1` transport dead-letters on the first failure), and a lazy `model: () => M` works.
  - `sqs.test.ts`: the consumer error is logged through the `logger` option.
  - Worker tests call `runWorker({ signal, … })` for core behavior, and keep one test each for `runResizeWorker` (disabled → no-op; enabled → calls `runWorker` with the configured queue).
  - Add the lease check: a transport with `leaseMs: 1000` and a Resizer with `queue.lockTtlMs.worker: 60000` → `runWorker` rejects with `RESIZE_CONFIG_LOCK_EXCEEDS_LEASE`.
- [ ] **Step 2:** Run; FAIL.
- [ ] **Step 3: Implement.** Remove the `framework/app.ts` and `resizeConfig` imports from both transports. Move the framework parts of `worker.ts` into `src/framework/worker.ts`. `ResizeWorker.run()` calls the framework `runResizeWorker`.
- [ ] **Step 4:** Run the full suite; PASS.
- [ ] **Step 5: Commit** — `feat: transports take explicit options and the core worker runs without the framework`

### Task 5: The `./framework.js` subpath; the main entry drops framework exports

**Files:** create `src/framework/index.ts`, `src/index.ts`, `package.json` (`"./framework.js": "./dist/framework/index.js"`), `preBuild.ts` / `postBuild.ts` only if they list entry files (check them), scaffold templates, `smokeTest.ts`, `src/index.test.ts`, `src/scaffold/command.test.ts`, new `src/importGraph.test.ts`.

**Interfaces:**
- `./framework.js` exports:
  - values: `createFrameworkResizer`, `createFrameworkMongoTransport`, `getResizeConfig`, `runResizeWorker`, `FrameworkMediaStore`, `FrameworkLockProvider`, `ResizeTaskModel`, `ResizeWorker`
  - types: `FrameworkResizerOptions`, `FrameworkResizeConfig`, `TMinimalResizeApp`
- The main entry keeps `Resizer`, `getResizer`, `listResizers`, `resetResizerForTests`, `processTask`, `runWorker`, the helpers, errors and types. It loses `ResizeWorker`, `ResizeTaskModel`, `runResizeWorker` and `TResizeTask` (which moves to `./framework.js`).
- The existing subpaths (`./models/ResizeTask.js`, `./commands/ResizeWorker.js`, `./mediaStore/framework.js`, `./locks/framework.js`, `./transports/*`, `./storage/*`, `./config/resize.js`) stay.

- [ ] **Step 1: Guard test** `src/importGraph.test.ts`. Starting at `src/index.ts`, follow every *value* import with a relative `.ts` specifier: skip `import type …`, and skip specifiers where every name is `type X`. Collect every bare specifier reached. Assert that none starts with `@adaptivestone/framework`, and that no file under `src/framework/`, no `src/models/ResizeTask.ts`, and no `src/commands/` file is reached. Print the offending chain on failure.
- [ ] **Step 2: Scaffold templates.**
  - `resizer.ts.tpl`: `import { createFrameworkMongoTransport, createFrameworkResizer } from '@adaptivestone/framework-module-resize/framework.js';` then `export const resizer = createFrameworkResizer({ transport: createFrameworkMongoTransport(), storage: PROVIDE_YOUR_STORAGE_DRIVER, pipelines: { default: {} } });`
  - `resizer.eager.ts.tpl`: `createFrameworkResizer({ storage: new LocalFsStorage({ … }) })`.
  - `resize.config.ts.tpl`: `satisfies FrameworkResizeConfig`, with the type imported from `…/framework.js`.
  - Update `src/scaffold/command.test.ts` expectations.
- [ ] **Step 3: Smoke test.** Update the expected main entry export list, and add a `./framework.js` import check for the exports listed above. Add a consumer install **without** peer dependencies (`npm install --legacy-peer-deps` or `--omit=peer`, whichever the smoke harness can do offline), then assert that `import('@adaptivestone/framework-module-resize')` succeeds and that `new Resizer({ config, storage, mediaStore })` works there. If the smoke harness cannot install without peers, record why in the final report and rely on `importGraph.test.ts`.
- [ ] **Step 4:** Run the full suite and `npm run smoke`; PASS.
- [ ] **Step 5: Commit** — `feat: framework integration moves to the ./framework.js subpath`

### Task 6: A framework-free example in the test suite

**Files:** create `src/frameworkFree.test.ts`.

- [ ] **Step 1: Test,** without installing any framework app (call `resetAppInstance()` first, and never `setAppInstance`):
  - an in-memory storage (`upload` keeps bytes in a Map and returns `{ id }`; `download` reads them; `publicUrl` returns `/m/<id>`);
  - an in-memory media store (a Map of media docs; `appendPreviews` pushes);
  - `new Resizer({ config: defaultConfigFromConfigResizeJs, storage, mediaStore, logger: silentLogger })`;
  - `uploadOriginal` of a small PNG (made with sharp), then `generate` of one `64x64` WebP, then `resolve` → one ready URL starting with `/m/`.

  Also a queued round trip with `MongoTransport({ model })` on `mongodb-memory-server` and a plain mongoose `ResizeTask` model built from `ResizeTaskModel.modelSchema` (as the transport tests do), `FrameworkLockProvider` replaced by a tiny in-memory `LockProvider`, `prewarm`, then `runWorker({ signal })` until the preview exists. No framework app anywhere.
- [ ] **Step 2:** Run; PASS.
- [ ] **Step 3: Commit** — `test: framework-free eager and queued example`

### Task 7: Documentation

**Files:** `README.md`, `AGENTS.md`, `CHANGELOG.md`, `docs/design/2026-09-30-multi-resizer.md`.

- [ ] **Step 1: README.**
  - Framework wiring uses `createFrameworkResizer` / `createFrameworkMongoTransport` from `…/framework.js`.
  - A new "Without the framework" section shows the core construction, the in-memory drivers as an example, `new MongoTransport({ model })`, and `runWorker({ signal })`.
  - Config: the core `ResizeConfig` versus `FrameworkResizeConfig` (`mediaModelName`), and one config file per Resizer via `configName`.
  - The driver table: `MongoTransport` options.
- [ ] **Step 2: AGENTS.md:**
  - Update the integration steps (construction site, imports).
  - State that the main entry is framework-free.
  - Add troubleshooting rows for `RESIZE_CONFIG_REQUIRED` and `RESIZE_LOCK_PROVIDER_REQUIRED`.
- [ ] **Step 3: CHANGELOG** (`# Unreleased`), **Breaking:**
  - `new Resizer()` requires `config` and `mediaStore`, and `lockProvider` with a transport.
  - Framework hosts use `createFrameworkResizer`.
  - `MongoTransport` requires `{ model }`; framework hosts use `createFrameworkMongoTransport()`.
  - The main entry no longer exports `ResizeWorker`, `ResizeTaskModel`, `runResizeWorker` (use `…/framework.js`).
  - `mediaModelName` lives in `FrameworkResizeConfig`.
  - New: `runWorker`, `listResizers`, `./framework.js`.
- [ ] **Step 4: Design doc.** Mark P4 done, and record the D8 scope decision from this plan's header.
- [ ] **Step 5:** Run `npm run build && npm test && npm run check && npm run smoke`; PASS.
- [ ] **Step 6: Commit** — `docs: framework adapter and framework-free usage`

---

## Definition of done (P4)

- `src/importGraph.test.ts` proves the main entry reaches no framework code, and `src/frameworkFree.test.ts` runs eager and queued flows with no framework app.
- Framework hosts wire through `…/framework.js`; the scaffold emits that wiring.
- Each framework Resizer can read its own config file.
- All checks pass, and the docs describe both ways of using the module.
