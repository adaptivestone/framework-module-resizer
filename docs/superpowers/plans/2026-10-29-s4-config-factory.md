# S4 — Named queues across backends and the config factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Resizer can use queues on several backends (a database queue and an SQS queue side by side), one worker can consume several queues, a plain Node app builds a Resizer from one config object with `createResizer(config, { drivers })`, every shipped driver builds itself from its config section with `static fromConfig`, and the framework adapter owns no shared queue state.

**Architecture:**
- **Routing with lazy carriers.** The core gets `RoutingTaskQueue` (`src/routing.ts`): one `TaskQueue` over several backends, keyed by queue name. A route is a task queue or a function that builds one on first need. The contract gets one optional async method, `routeOf(queue)`, and the core asks every per-queue capability question (`gatesByTask`, `claimFilters`, `findActive`, `release`, the lock store, `verify`) of the backend that carries that queue (`await carrierOf(tasks, queue)`); timing stays a question for the Resizer's task queue (D4). A backend is built, and its optional SDK imported, only when a call or a worker first needs one of its names; a failed build affects only that backend's names, and a worker checks only the names it consumes.
- **The worker** takes one queue or a list (`runWorker({ queue: ['default', 'bulk'] })`, `--queue` repeatable) and runs one Consumer per (backend, queue name).
- **The factory.** `src/factory/` holds `createResizer`, the built-in driver table (loaded with dynamic `import()`, so the main entry statically reaches no driver), the image merge over the package defaults, the queue-entry validation, the lane rules and the queue set (one backend task queue, or a `RoutingTaskQueue` with lazy routes when the available backends are more than one). Driver factories are typed in `src/contracts/drivers.ts`.
- **The framework adapter** becomes config files + app models + app logger and events + `configuredOptions()` from the factory. Its database parts are a driver, `FrameworkDatabase` (`src/framework/database.ts`). The process-wide queue set and its backends are kept in the core process registry, so `src/framework/queue.ts` and its `WeakMap` go away.

**Tech Stack:** Node ≥ 24 (planned on 26.12.1), TypeScript 7 (`erasableSyntaxOnly`, `verbatimModuleSyntax`, ESM, `.ts` specifiers), `node:test`, Biome 2.6, sharp 0.35, mongoose 9 and mongodb-memory-server (tests only), the framework 5.5 (dev).

**Spec:** docs/design/2026-10-26-reference-architecture.md — F6 (the remainder: `RoutingTaskQueue`, the module-level state), F7, "Target usage", the S4 row of Phases. F6's host shape (`queues`, `queue` as a name, process-wide `worker` and `coordination`, `queueName`, one task queue per backend, the removed timing-conflict check) shipped in S2b (0.3.0-rc.1) and is not re-planned.

## Decisions for the owner

Each item is one decision. "Today" is the code on this branch. Three reviewers agreed with A in O1–O4; their notes are folded in.

**O1. The new core config types, and the old `Framework*` names.**
- Today: the storage config types are called `FrameworkStorageConfig`, `FrameworkLocalStorageConfig` and `FrameworkS3StorageConfig`. Hosts may write these names in their code.
- The spec says these types "become core `*Config` types". `createResizer` needs the same types, without the framework.
- Example: a host file has `const s: FrameworkLocalStorageConfig = { driver: 'local', rootDir, publicBaseUrl }`.
- Option A: add the core names (`LocalStorageConfig`, `S3StorageConfig`, `StorageConfig`), and keep each `Framework*` name as an alias of the same type, marked `@deprecated` in its doc comment. The host file keeps compiling.
- Option B: rename. The host file stops compiling. This breaks the rc.1 promise ("rc.1 holds every host-facing shape").
- **Recommendation: A.** Cost: two names for one type until 0.4.0. `FrameworkResizeConfig` keeps its name and its exact shape.

**O2. One worker for several queues.**
- Today: a worker consumes exactly one queue (`--queue=bulk`). Two Resizers on two queues need two worker processes.
- The spec's "Done when" says: "two Resizers on different named queues run under one worker".
- Example: Resizer `a` uses `default` (database), Resizer `listings` uses `bulk` (SQS). With this change: `npm run cli ResizeWorker -- --queue=default --queue=bulk` runs both in one process.
- Option A: `--queue` may be repeated; `runWorker({ queue })` and `runResizeWorker({ queue })` take a string or a list of strings. One flag works exactly as today.
- Option B: a comma list, `--queue=default,bulk`. A queue name that contains a comma (allowed today) could then not be named.
- Option C: keep one queue per worker, and read the "Done when" as "one worker process per queue".
- **Recommendation: A.** It only adds; no name rules change. (The framework CLI passes `multiple: true` straight to Node's `parseArgs`.)

**O3. Framework config files are merged over the package defaults.**
- Today: a framework config file must be complete. It spreads `defaultFrameworkResizeConfig`, and a partial file is `RESIZE_CONFIG_UPLOAD_INVALID` (or another missing-key code).
- The spec says: "the core's merge over package defaults is the only other merge". `createResizer` needs that merge (its example writes only `formats: ['webp']`).
- Example: with the merge, a `resize.ts` that omits `limits` gets the default `limits`.
- The merge rule (D5) leaves every complete config unchanged, even the same objects: `encode.formats` is replaced as a whole, and a host object that needs no default key is passed on as it is.
- Option A: `FrameworkResizer` uses the same merge. A complete file works as today; a partial file now works too.
- Option B: only `createResizer` merges; framework files stay complete.
- **Recommendation: A.** One rule for both paths. The scaffold keeps the spread and `satisfies FrameworkResizeConfig`. A partial file writes `satisfies PartialFrameworkResizeConfig`, a new type that makes nested keys optional too (for example `limits: { sourcePixels: 1 }` alone). `Partial<FrameworkResizeConfig>` keeps compiling for files that only leave out top-level keys.

**O4. A custom driver named in a framework config file.**
- Today: `storage.driver` must be `'local'` or `'s3'`, and a `queues` entry's driver `'database'` or `'sqs'`.
- With F7 every driver registers by name. `createResizer(config, { drivers })` takes the registry.
- Example: `new FrameworkResizer({ drivers: { storage: { gcs: GcsStorage } } })` and, in `resize.ts`, `storage: { driver: 'gcs', bucket: '…' }`.
- Option A: `FrameworkResizer` takes the same `drivers` option. The queues are built once per process, so every `FrameworkResizer` must pass the same queue drivers. This is checked when each `FrameworkResizer` is constructed (the whole `drivers.queue` map, every key), so the result does not depend on which call runs first: a different map is `RESIZE_DRIVER_CONFLICT` from the constructor.
- Option B: custom drivers only in `createResizer`; framework hosts pass a custom storage object in code (`storage: new GcsStorage(…)`), as today.
- **Recommendation: A.** Typing: `satisfies FrameworkResizeConfig<{ storage: { gcs: typeof GcsStorage } }>`, and the same type parameter on the `config` option of `FrameworkResizer` (D7).

**O5. Driver names are checked against the Resizer's driver list.**
- Today: the framework adapter rejects a storage driver other than `'local'`/`'s3'` and a queue driver other than `'database'`/`'sqs'` whenever it reads the config file.
- With O4, a name is valid when it is registered, and the registry belongs to a Resizer. So the name check runs when a Resizer first reads that section, against its own driver list.
- What does not move: the SQS entry checks (`queueUrl`, two entries with one URL) and every shape check still run when the file is read. A Resizer given `tasks` in code still checks the queue driver names when it reads `coordination` from the file (today's "the file is validated whole" rule), so no check disappears.
- What moves, with the same codes and texts: a worker whose `worker.enabled` is `false` logs "disabled" even when a queue driver name is unknown (today it fails).
- What stays the same: an eager-only Resizer (`queue: false`, no `tasks`) does not read the queues today and does not read them after this change, so an unknown queue driver name does not fail it.
- Option A: accept this.
- Option B: keep a framework-only early check that knows no custom names, which would make O4 impossible.
- **Recommendation: A.**

## Decisions

- **D1. Lazy carriers (ruling R-S4-1).** A backend is built, and its optional SDK imported, only when a call or a worker first needs one of its queue names. Backends are cached per backend; in a framework host the cache is the process registry, shared by every `FrameworkResizer`. A failed build is forgotten (the next need retries it) and affects only that backend's names:
  - `prewarm()` on such a name reports every variant `unconfirmed` with one issue built from the build error (D13): its code when the issue union has it, else `RESIZE_ENQUEUE_QUEUE_FAILED` with the error's code in `causeCode`; always the error's own `retryable`;
  - `resolve()` logs it once per queue name and message, and serves the stored previews;
  - a worker refuses to start only when a name it was given fails; a worker for other names never builds that backend and never checks it (D15), even when it carries the served Resizer's own `queueName`.
  - The single-backend case keeps today's rule: when exactly one backend is available, the Resizer's task queue is that backend, built when the Resizer loads, and a failure rejects as today.
  - The rejected alternatives: building every backend eagerly (a database Resizer would need the SQS SDK of an unused entry, and a failed build would empty `resolve()`), and an eager "broken route" (it loads `drivers/sqs.ts`, which `src/framework/resizer.test.ts:753-825` forbids).
- **D2. Availability before building.** Each built-in driver that needs an optional peer declares it in the built-in table (D8). Before a backend is used, the factory probes its peers with `import.meta.resolve(peer)` from `src/factory/builtins.ts`: no module is loaded (verified on Node 26.12: a `registerHooks` resolve hook that throws for the peer makes `import.meta.resolve` throw `ERR_MODULE_NOT_FOUND`).
  - A backend whose peer is missing is not available in this process, and its names are not routed. Each such name keeps its reason: the `RESIZE_PEER_MISSING` error that `probePeers` built (today's text, naming the driver, the packages and the config).
  - **How the reason reaches callers.** `src/routing.ts` keeps the reasons beside the task queue they belong to: `markUnavailable(tasks, reasons: ReadonlyMap<string, ResizeError>)` and `unavailableReason(tasks, queue): ResizeError | undefined`, both internal (not on the main entry), over a module-level `WeakMap` keyed by the task queue object (like the timing cache in `src/timing.ts`; core state, not the adapter's). `planQueueSet` marks whatever task queue it returns, the single backend object or the router, so `resizer.tasks` stays a plain `MongoTaskQueue` in the single-backend case. A task queue the factory did not build has no reasons, and every message stays today's.
    - The Dispatcher, when a call's queue has no carrier: outcome `not-served` with the reason, so the issue stays `RESIZE_QUEUE_NOT_SERVED` (`retryable: false`), and the message adds "(its driver '<driver>' needs <packages>, which is not installed)". `resolve()` logs the same text once per name.
    - The worker, for a listed name with no carrier: `RESIZE_QUEUE_NOT_SERVED` naming the queue and adding the same text, taken from the first served Resizer whose task queue has a reason for that name.
    - `verify()`, when the Resizer's own `queueName` has a reason: rejects with that `RESIZE_PEER_MISSING` error (today's code for a missing peer of the Resizer's own queue).
  - No backend available at all: the task queue part rejects with the first reason, `RESIZE_PEER_MISSING`, as today (`src/framework/resizer.peers.test.ts` unchanged).
  - So `src/framework/resizer.test.ts:753-825` (a database Resizer, `bulk` on SQS without its SDK) stays green unchanged: the only available backend is the database one, so `resizer.tasks` is a `MongoTaskQueue`, `prewarm({ queue: 'bulk' })` is `RESIZE_QUEUE_NOT_SERVED` with `retryable: false` (the test checks only the code and `retryable`), no model is read, and `drivers/sqs.ts` is never resolved.
- **D3. The contract change is one optional method.**
  ```ts
  // src/contracts/taskQueue.ts, on TaskQueue
  /** Optional: the task queue that carries `queue`, for a queue that routes names to several backends. Resolves undefined for a name it does not route; rejects when that backend cannot be built. The core asks every per-queue question of the result. */
  routeOf?(queue: string): Promise<TaskQueue | undefined>;
  ```
  - `carrierOf(tasks, queue): Promise<TaskQueue | undefined>` in `src/routing.ts`: `tasks.routeOf ? tasks.routeOf(queue) : (tasks.servesQueue && !tasks.servesQueue(queue) ? undefined : tasks)`.
  - The core calls it wherever it used the Resizer's task queue for one queue name: the Dispatcher (`gatesByTask`, `add`, `findActive`, the lock store), `Resizer.verify()` (its own `queueName`), the worker (which task queues to consume, the startup checks) and the Consumer (it gets the carrier). Timing is not a carrier question: the core keeps reading `timingOf(tasks, name)` on the Resizer's task queue (D4).
  - `carrierOf` is exported from the main entry (value), so a host can find the backend of a name (the docs point to it instead of `instanceof MongoTaskQueue`).
  - `servesQueue` stays synchronous: a router answers from its routes, without building anything.
- **D4. `RoutingTaskQueue`.**
  - `new RoutingTaskQueue(routes: Record<string, TaskQueue | (() => Promise<TaskQueue>)>, opts?: { getTiming?(queue: string): Partial<QueueTimingOptions> | undefined })`. The same backend object or builder may carry several names.
  - At construction: `routes` must be a non-empty plain object; each object route must have the five required methods (`add`, `claim`, `renew`, `complete`, `fail`); an object route whose own `servesQueue(name)` is false is refused; each value must be a task queue or a function. Every failure is `ResizeSetupError` `RESIZE_QUEUE_ROUTES_INVALID`, `retryable: false`, naming the route. A route that is itself a router is resolved through its own `routeOf(name)` on first need.
  - A builder route is called once; its promise is kept, and a rejected one is forgotten. What it resolves is duck-checked as a task queue (`RESIZE_DRIVER_INVALID` otherwise).
  - It implements `add` and `claim` by the queue name, `renew`, `complete` and `fail` by `task.queue`, `findActive` (the carrier's, or `[]` when the carrier has none), `routeOf`, `servesQueue`, `getTiming` and `verify`. `add` or `claim` on a name with no route rejects with `ResizeSetupError` `RESIZE_QUEUE_NOT_SERVED`.
  - **Flags (ruling R-S4-4).** No getters: `TaskQueue` declares `gatesByTask` and `claimFilters` as properties, and an accessor over them is TS2611 (reproduced with the repo's `tsc`). The constructor sets each flag with `Object.defineProperty(this, name, { value: true, enumerable: true })` only when every route is an object route with that flag (a builder route's flags are unknown until it is built); the class declares no field. The core never reads a router's flags: per-queue capability comes from `carrierOf` (D3), and the lock rules are D15.
  - **Timing (ruling R-S4-3).** The core reads timing only as `timingOf(resizer.tasks, name)`, before and after any build, so one answer per name holds for the Dispatcher and the worker. The router's `getTiming(name)` answers it:
    - an object route: `timingOf(route, name)`, so the route's own `getTiming` runs once per name however many paths ask;
    - a builder route: `opts.getTiming?.(name)` only. The router's option is the one authority for a builder route's names; the built carrier's own `getTiming`, if any, is not asked for them, because the answer is needed before the build and must not change after it. (The factory passes each entry's validated timing, the same values the built backend gets.)
    - The worker, for a carrier that several served Resizers route a name to, uses `timingOf` of the first such Resizer's task queue (the factory gives them one queue set, so the same values).
  - `verify()` verifies the object routes; builder routes are verified when they are carriers (D15).
  - No `release`: the core asks the carrier, and a router cannot promise it for a backend that lacks it.
  - Exported from the main entry (value).
- **D5. The image merge over the package defaults** (`mergeImageConfig`, `src/factory/image.ts`; owner O3).
  - Plain objects merge key by key, recursively. Arrays replace. `encode.formats` replaces as a whole. A key whose value is `undefined` takes the default. Keys the defaults do not have pass through, so `validateResizeConfig` still reports removed and unknown keys.
  - Identity: a host object in which no key needs a default is returned as that same object; an object is copied only when a key is filled in; a value taken from the defaults is a deep copy, so the result never shares an object with the defaults. So `src/config/resize.test.ts:78` (`image.formats` is the host's array) and `:251` (`image.encode` is the host's object) stay green.
  - A value that is not a plain object is returned as it is, so validation reports it.
- **D6. Driver factories** (`src/contracts/drivers.ts`).
  ```ts
  export interface DriverContext { logger: ResizeLogger; where: string } // `where`: the config as messages name it
  export interface StorageDriver<S = never> { fromConfig(section: S, ctx: DriverContext): ResizeStorage | Promise<ResizeStorage> }
  export interface DatabaseParts {
    media: MediaStore;
    locks?: LockStore; // used only beside a carrier without gatesByTask (D15)
    taskQueue?(opts: { queues: readonly string[]; getTiming(queue: string): Partial<QueueTimingOptions> | undefined; logger: ResizeLogger }): TaskQueue;
  }
  export interface DatabaseDriver<S = never> { fromConfig(section: S, ctx: DriverContext): DatabaseParts | Promise<DatabaseParts> }
  export type QueueSection = { driver: string } & Record<string, unknown>;
  export interface QueueEntry<S = QueueSection> { name: string; section: S; timing: QueueTimingOptions } // timing: complete, validated
  export interface QueueDriverContext extends DriverContext { database: DatabaseParts | undefined }
  export interface QueueDriver<S = never> {
    // Optional, synchronous, loads nothing: which entries share one backend. Default: all entries of this driver.
    backendOf?(section: S): string;
    // Optional, synchronous, loads nothing: checks the entries of this driver (all of them, so it can compare them).
    validate?(entries: readonly QueueEntry<S>[], ctx: { where: string }): void;
    // The entries of ONE backend → that backend's task queue, serving exactly their names.
    fromConfig(entries: readonly QueueEntry<S>[], ctx: QueueDriverContext): TaskQueue | Promise<TaskQueue>;
  }
  export interface DriverRegistry { storage?: Record<string, StorageDriver>; database?: Record<string, DatabaseDriver>; queue?: Record<string, QueueDriver> }
  ```
  - A registry value is anything with a `fromConfig` function: a class with a static method (`LocalFsStorage`) or a plain object. Checked by duck typing at construction: `ResizeSetupError` `RESIZE_DRIVER_INVALID` naming `drivers.<kind>.<name>`, before the Resizer's name is registered.
  - A part a driver returns is duck-checked at build: storage needs `upload`, `download`, `publicUrl`; media needs `loadMedia`, `appendPreviews` and `replacePreviews`; a task queue needs the five required methods. Otherwise `RESIZE_DRIVER_INVALID`.
  - Queue drivers differ from the spec's `fromConfig(section, ctx)` shape: grouping names into backends and comparing entries (two SQS names with one URL) are the driver's knowledge, and both must work without loading the driver (D1, D2), hence `backendOf` and `validate`.
  - Host drivers win over built-in names, per kind (like decoders), so a test or a host can replace `'sqs'`.
- **D7. Types.** `src/types.d.ts` stays dependency-free.
  - New in `types.d.ts`: `LocalStorageConfig`, `S3StorageConfig`, `StorageConfig` (their union), `MongoDatabaseConfig` (`{ driver: 'mongo'; connection: unknown; mediaModel: unknown }`; the driver checks the values), `ResizerSections` (`storage?`, `database?`, `queue?: string | false`, `queues?: Record<string, QueueConfig>`, `coordination?`).
  - The `…SectionOf` helpers (`StorageSectionOf<D>`, `DatabaseSectionOf<D>`, `QueueSectionOf<D>`) are pure type-level code in `types.d.ts`, over a structural registry shape declared there (`{ storage?: Record<string, { fromConfig(section: never, ctx: never): unknown }>; … }`), so they need no import. Each reads the section type off a registered driver's `fromConfig` parameter (for a queue driver, off its entries' `section`) and adds `{ driver: K }`. `DriverRegistry` (`src/contracts/drivers.ts`) is assignable to that shape.
  - The `Framework*` storage names become `@deprecated` aliases (owner O1). `FrameworkResizeConfig<D = {}>` keeps its exact shape for `D = {}`; `D` adds custom storage and queue sections.
  - **The generic reaches the framework options (ruling R-S4-7):** `FrameworkResizerOptions<D extends DriverRegistry = {}>` has `drivers?: D` and `config?: FrameworkResizeConfig<D>`. The class is generic: `class FrameworkResizer<D extends DriverRegistry = {}> extends Resizer`, with a non-generic `constructor(opts: FrameworkResizerOptions<D> = {})` (a type parameter on a constructor is TS1092; checked with the repo's `tsc`: the class form compiles, `D` is inferred from `drivers`, `new FrameworkResizer()` takes `D = {}`, and a custom section without its driver is an error). `FrameworkDatabaseConfig.config?: FrameworkResizeConfig<DriverRegistry>`.
  - `PartialFrameworkResizeConfig<D = {}>` (`DeepPartial<FrameworkResizeConfig<D>>`: plain objects become optional key by key, arrays and `encode.formats` stay whole) for files that override part of a config (owner O3). Exported wherever `FrameworkResizeConfig` is.
  - `src/factory/types.ts` (imports no `resizer.ts`): `ResizerConfig<D extends DriverRegistry = {}>` = `DeepPartial<ResizeConfig>` & the sections, where `storage` is `StorageConfig | StorageSectionOf<D>`, each `queues` entry is `QueueConfig | QueueSectionOf<D>`, and `database` is `MongoDatabaseConfig | DatabaseSectionOf<D>`. `CreateResizerOptions<D>` (which extends `ResizerOptions`) lives in `src/factory/createResizer.ts`, the one factory file the import allowlist lets import `resizer.ts`.
  - Type tests in `src/testHelpers/factoryTypes.ts` (checked by `tsconfig.test-helpers.json`) pin all of this (Tasks 4 and 7).
- **D8. Built-in drivers and the main entry.**
  - `src/factory/builtins.ts` holds the table: storage `local` (`LocalFsStorage`, no peer), `s3` (`S3Storage`, peers `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`); database `mongo` (`MongoDatabase`, no peer: the mongo driver imports mongoose as types only); queue `database` (in the core, `src/factory/databaseQueue.ts`) and `sqs` (`SqsTaskQueue`, peer `@aws-sdk/client-sqs`, with `backendOf` and `validate` from the peer-free `src/helpers/queueSections.ts`).
  - Each driver module is loaded with a literal dynamic `import('../drivers/….ts')` inside the entry's `fromConfig`, through `importDriver` (moved to `src/helpers/peers.ts`), so a missing peer that the probe did not catch is still `RESIZE_PEER_MISSING` naming the driver, the packages and `ctx.where`. A `probePeers(peers, driver, where)` helper beside it builds the same error from `import.meta.resolve`.
  - The main entry's static graph still reaches no driver module (`src/index.test.ts`); a new guard allows dynamic driver imports only in `src/factory/builtins.ts` (extended to `src/framework/` in Task 7).
- **D9. `createResizer` and `configuredOptions`.**
  - `createResizer(config, opts?)` returns a `Resizer` at once; parts are built on first use. It is `new Resizer(configuredOptions(sourceOf(config), opts))`.
  - The config source (internal):
    ```ts
    interface ConfigSource {
      own(): OwnSections; // image (unmerged), storage?, queue?
      process(): ProcessSections; // queues (validated entries), coordination; read only when needed
      database(): unknown; // the database section; read on first need (ruling R-S4-5)
      eagerDatabase?: true; // build the database parts at construction when the driver is synchronous
      where: { own: string; process: string };
    }
    interface ProcessSections { queues: readonly QueueEntry[]; coordination: CoordinationOptions | null | undefined; validated: ReadonlySet<QueueDriver['validate']> } // validated: the validate functions the source already ran
    ```
    `createResizer` reads all three from its one config (`where` = `'the config passed to createResizer()'`); for an object config it resolves and validates the queue entries at construction (no driver is built), for a function config on first read.
  - `configuredOptions(source, opts)` (internal, in `src/factory/createResizer.ts`) turns a source into `ResizerOptions`:
    - `config`: the merged image settings (D5). An object config is merged and validated at construction; a function config on first use.
    - Own sections: when read, a `storage` section's driver name is checked against the registry even when `storage` is given in code (as today, where the adapter checks it at read): `RESIZE_CONFIG_INVALID` "`storage` in <where> needs driver 'local' or 's3'" (with custom names: "'local', 's3' or 'gcs'").
    - `queueName` and the lane: today's `chooseLane` rules, moved to `src/factory/lane.ts` with the messages taking `where`. A `queue` object is `RESIZE_CONFIG_REMOVED_KEY` (today's text); any other non-name is `RESIZE_CONFIG_INVALID`.
    - Process sections, whenever read (the lane, or `coordination`): `validateQueueDrivers(entries, registry, where, validated)` checks each entry's driver is registered (`RESIZE_CONFIG_INVALID` "`queues.<name>` in <where> needs driver 'database' or 'sqs'", custom names added as for storage) and calls each selected driver's `validate(entries, { where })` unless that same function is in `validated`. The skip is by function identity, not by name: a host driver registered under `'sqs'` has its own `validate`, which always runs, even though the framework already ran the built-in SQS checks. With `tasks` in code the lane is not looked up, but `coordination` still reads and checks the process sections (ruling R-S4-6).
    - `storage`: the option, else the section through the registry. No section: `RESIZE_CONFIG_STORAGE_MISSING`.
    - Database parts: built once, from `source.database()` through the registry; none without a section. With `eagerDatabase` and a synchronous `fromConfig`, they are built at construction, so `media` and `locks` are objects at once (keeps `FrameworkResizer`'s `resizer.media` and `resizer.locks` readable before first use, as today).
    - `media`: the option, else the parts' `media`; neither: `RESIZE_MEDIA_REQUIRED` naming `where`.
    - `tasks`: `false` → none; given → it; else the queue set (D11) when the lane is not eager.
    - `locks`: the option; else, with a single-backend task queue, the parts' `locks` only when it lacks `gatesByTask` (today's `gateLockStore`); with a router, the parts' `locks` (D15 decides when it is required and verified).
    - `coordination`: the option, else the process sections' `coordination`, where only `undefined` becomes `{}` (ruling R-S4-2): `null` and any other value go to the core as they are, which rejects `null` (`RESIZE_CONFIG_COORDINATION_INVALID`).
  - Two `createResizer` calls each build their own queue set (sharing is a follow-up); the worker still runs each task with its own Resizer.
- **D10. The framework adapter on the factory.**
  - `FrameworkDatabase` (`src/framework/database.ts`, static synchronous `fromConfig({ driver: 'framework', configName, config? })`): `media` = `FrameworkMediaStore` (as today), `locks` = `FrameworkLockStore`, `taskQueue` = `MongoTaskQueue` over `getApp().getModel('ResizeTask')` with the given names, timing and logger. Registered under `'framework'` in the adapter's driver map; a host's `drivers.database.framework` is overwritten (the name is internal).
  - `FrameworkResizer` passes `configuredOptions` a source over its file and `resize.ts` (`database()` returns the constant framework section, `eagerDatabase: true`), the app logger and events, the host's `drivers`, `shareQueues: 'framework'` and `queueLogger: appLogger`.
  - `shareQueues`: the queue set is `sharedPart('framework:queues', …)` and each backend `sharedPart('framework:backend:<driver>:<backendOf>', …)`; the drivers of the shared set get the app logger (ruling R-S4-9), never one Resizer's `logger` option.
  - **Conflict at construction (ruling R-S4-9).** The constructor records its `drivers.queue` map with `sharedValue('framework:queue-drivers', map)` and compares it with an earlier one, key by key and by driver object identity; a difference is `RESIZE_DRIVER_CONFLICT`, thrown before the name is registered.
  - `src/framework/queue.ts` is deleted. `src/framework/config.ts`: `resolveProcessConfig` validates the queue map through the core's `resolveQueueEntries` and the SQS entries through `validateSqsEntries` (same moment, codes and texts as today; `config.ts` calls `validateSqsEntries(sqsEntries, { where })`, wrapping the string `where` it has today at `src/framework/config.ts:241,285`; it passes `validated: new Set([validateSqsEntries])`. `validateSqsEntries` has exactly the `QueueDriver.validate` signature, `(entries, ctx: { where: string })`, and the built-in `'sqs'` entry uses that same function as its `validate`, so the identity check holds), accepts any non-empty driver name (O5), and no longer computes `backend`. `resolveFrameworkConfig` checks `storage` is an object with a non-empty string `driver` (the name check is the factory's) and merges the image settings before validating them (O3).
  - Options keep winning over the config files; every option of `FrameworkResizerOptions` stays, and `drivers` is added.
- **D11. The queue set** (`planQueueSet`, `src/factory/queueSet.ts`).
  - Group the validated entries by driver, then by the driver's `backendOf` (default: one backend per driver). For each backend, probe its peers (D2): an available backend gets a builder (`driver.fromConfig(itsEntries, { logger, where, database })`, cached per backend: in the registry with `shareQueues`, else per set); an unavailable one records its `RESIZE_PEER_MISSING` error for each of its names.
  - One available backend → the Resizer's task queue is that backend, built when the task queue part loads (today's object, today's moment and failure). More → a `RoutingTaskQueue` over the builders, with `getTiming` from the entries; nothing is built until a name is needed. No backend available → the task queue part rejects with the first recorded error.
  - The returned task queue is marked with the recorded reasons (`markUnavailable`, D2). The Resizer's own lane on an unavailable backend does not reject the task queue part while another backend is available: its calls are not served (with the reason), `verify()` rejects with the reason, and a worker for another name still starts (D15).
  - A builder's result is checked to serve every name of its entries (`RESIZE_DRIVER_INVALID` otherwise).
- **D12. `resolveQueueEntries(value, where): QueueEntry[]`** (`src/factory/queues.ts`), moved from `src/framework/config.ts`: `undefined` → none; not an object → `RESIZE_CONFIG_INVALID`; an entry set to `undefined` is skipped; a blank name, `lockTtlMs`, nested `queues`, an entry that is not an object or has no non-empty string `driver` keep today's codes and texts ("needs driver 'database' or 'sqs'" for a missing driver); each entry's timing through `fillTiming`, named. `validateSqsEntries(entries, ctx: { where: string })` (the `QueueDriver.validate` signature) and `sqsBackendKey(section)` (today's `backendKey` for SQS) live in `src/helpers/queueSections.ts`.
- **D13. Error codes.**
  - New: `RESIZE_QUEUE_ROUTES_INVALID`, `RESIZE_DRIVER_INVALID`, `RESIZE_DRIVER_CONFLICT` (each `ResizeSetupError`, `retryable: false`).
  - No new issue code (the union stays closed, below). A call on a carrier without `gatesByTask` and no lock store is the existing `RESIZE_ENQUEUE_LOCK_FAILED` (the gate lock cannot be taken) with `causeCode: 'RESIZE_LOCKS_REQUIRED'` and `retryable: false`.
  - New optional issue field (additive): `EnqueueIssue.causeCode?: string`, the code of the error behind an issue when that code is not itself in the union.
  - **A backend that fails to build** (Dispatcher outcome `route-failed`, reported in `src/reader.ts` beside the other outcomes):
    - a branded error (`isResizeError`) whose code is in the issue union: the issue keeps that code, the error's message and the error's own `retryable`;
    - a branded error with any other code (a custom driver's, or a module code that is not an issue code such as `RESIZE_PEER_MISSING`): `RESIZE_ENQUEUE_QUEUE_FAILED`, the error's message, `causeCode` = the error's code, and the error's own `retryable`. So a custom driver's `new ResizeError('…', { code: 'GCS_BUCKET_MISSING', retryable: false })` is `{ code: 'RESIZE_ENQUEUE_QUEUE_FAILED', causeCode: 'GCS_BUCKET_MISSING', retryable: false }`, and a `RESIZE_PEER_MISSING` (default `retryable: true`) is `{ code: 'RESIZE_ENQUEUE_QUEUE_FAILED', causeCode: 'RESIZE_PEER_MISSING', retryable: true }`;
    - the prewarm advice rule of `prewarmFailure` (`src/reader.ts:452-458`) is not applied on this path: a branded error's `retryable` is passed on as it is (ruling R-S4-12);
    - an error without the brand: `RESIZE_ENQUEUE_QUEUE_FAILED`, `retryable: true`, the error's message, no `causeCode`.
  - **The closed union.** `EnqueueIssue.code` stays exactly today's closed union (`src/types.d.ts:147`): a host's exhaustive `switch` with `assertNever` keeps compiling (the rc promise). Nothing is added to it in S4; the driver's own code travels in `causeCode`.
  - Narrower: `RESIZE_QUEUE_NOT_SERVED` no longer covers "a queue on another available backend". It stays for a name no task queue defines, and for a backend whose optional peer is missing (D2). The Dispatcher's text keeps its start, "cannot queue to '<queue>': its task queue does not serve that queue", and its parenthesis becomes "(a queue name it does not route)", or D2's reason for an unavailable backend.
  - Wider: `RESIZE_PEER_MISSING`, `RESIZE_CONFIG_STORAGE_MISSING`, `RESIZE_CONFIG_QUEUE_UNKNOWN`, `RESIZE_MEDIA_REQUIRED` also come from `createResizer`, naming its config; `RESIZE_QUEUE_INVALID` also covers a bad worker `queue` list; `RESIZE_LOCKS_REQUIRED` also at worker start for a consumed carrier, and as a prewarm issue's `causeCode`.
  - Renamed or removed: none.
- **D14. The process registry keeps shared parts; the framework adapter owns no shared state.**
  - `Registry` replaces `onReset` with `shared(key, build)` (a promise, built once per key, a rejected build forgotten) and `sharedValue(key, value)` (records `value` under `key` if absent, returns the recorded one); `reset()` forgets items, shared parts and shared values. `src/resizer.ts` exports the internal `sharedPart` and `sharedValue` (not on the main entry) and drops `onResetResizerForTests`.
  - The invariant, stated precisely (ruling R-S4-10): the adapter keeps no state that decides which object is shared (task queues, backends, driver maps) at module level; that state is in the process registry. `src/framework/config.ts` keeps its three `WeakMap`s (`resolvedFiles`, `resolvedProcess`, `missingProcessFile`), which only memoize validation of the framework's own config object; the guard allows exactly these.
- **D15. The lock store follows the routes a Resizer uses (ruling R-S4-1).**
  - A non-router task queue: today's rules (the Dispatcher is not built without a lock store beside a queue without `gatesByTask`; `verify()` verifies a given lock store).
  - A router: no Resizer-wide requirement. A call whose carrier lacks `gatesByTask` and has no lock store queues nothing: `prewarm()` reports `RESIZE_ENQUEUE_LOCK_FAILED` with `causeCode: 'RESIZE_LOCKS_REQUIRED'` (D13), `resolve()` logs once per queue name.
  - **`verify()` is split in two internal steps** in `src/resizer.ts`, exported for the worker only (not on the main entry), like `tasksPartOf`:
    - `verifyServicesOf(resizer)`, in today's order: `ready()`; the Resizer-wide `#queueFailure` (an invalid `coordination`; for a non-router task queue, the missing lock store); the media store's `verify()` and `replacePreviews`; the lock store's `verify()` whenever a lock store is supplied, with or without a task queue, unless the task queue is a router; the decoders' `verify()`. So `src/customDecoder.test.ts:349` (media, locks, decoder; no task queue) stays unchanged. It builds no route and reads no timing.
    - `verifyRouteOf(resizer, queue)`: an unavailable reason for `queue` rejects with it (D2); then `await carrierOf(resizer.tasks, queue)` (a build failure rejects; no carrier is `RESIZE_QUEUE_NOT_SERVED`, today's text); then `timingOf(resizer.tasks, queue)` (invalid timing rejects with its `RESIZE_CONFIG_QUEUE_*` error); then the carrier's `verify()`; then, only for a router, when the carrier lacks `gatesByTask`, a lock store is required (`RESIZE_LOCKS_REQUIRED`) and verified. For a non-router task queue the carrier is the task queue itself, so the checks are today's: timing, its `verify()`, `servesQueue`.
    - `verify()` = `verifyServicesOf(this)` then `verifyRouteOf(this, this.queueName)` when there is a task queue. So `verify()` with a router builds only the carrier of the Resizer's own `queueName`, and a database Resizer beside an unused SQS entry never checks the framework `Lock` model.
    - **Why a router's lock store is not verified in the shared step:** with a router, the factory passes the database parts' lock store (the framework `Lock` model) whether or not any route needs one, so verifying it there would make a database Resizer beside an unused SQS entry require the `Lock` model. A router's lock store is verified by the route check of a carrier that lacks `gatesByTask`. A Resizer without a task queue, or with a non-router one, keeps today's shared check (ruling R-S4-12 (e)).
    - **Timing is a route check only (ruling R-S4-12 (d)),** for routers and plain task queues alike: `#buildDispatcher` no longer reads `timingOf(tasks, this.queueName)` (`src/resizer.ts:499` today) and checks only the lock store (non-router) and `coordination`. A name's invalid timing is checked by `verify()` (the own name), at worker start (each consumed name), and per call (today's `timing-invalid` outcome: `prewarm()` reports `RESIZE_ENQUEUE_INTERNAL_ERROR`, not retryable; `resolve()` logs once per queue name and serves stored previews).
  - **Worker start** replaces today's loop of `resizer.verify()` (`src/worker.ts:196`): every served Resizer runs `verifyServicesOf`; then for every consumed name, every served Resizer whose task queue routes that name runs `verifyRouteOf(resizer, name)`, which reads that name's timing (an invalid timing rejects start). A served Resizer's own `queueName` is never checked unless the worker consumes it. Each carrier's `verify()` and each lock store's `verify()` run once.
- **D16. The worker and several queues** (owner O2, option A).
  - `RunWorkerOptions.queue?: string | readonly string[]` (default `'default'`). A list is de-duplicated. An empty list, or an entry that is not a non-empty string, is `ResizeSetupError` `RESIZE_QUEUE_INVALID`.
  - For each name: the carriers of the served Resizers (`await carrierOf(r.tasks, name)`), de-duplicated by identity. A name with no carrier is `RESIZE_QUEUE_NOT_SERVED` naming it, with D2's reason when one is marked (with one name and no reason, today's text); a carrier whose build fails rejects start with that error, naming the queue. Both before anything is claimed.
  - One Consumer per (carrier, name), each with the timing of D4 (`timingOf` of the first served Resizer's task queue that routes the name to that carrier), on one stop signal; the first failure stops the others (today's rule).
  - **The startup check** (`RESIZE_QUEUE_SHARED_RESIZER_UNLISTED`, today's `refuseUnservedSharers`) runs per name, comparing the unserved Resizers' carriers for that name with the consumed carriers that do not filter claims. It is conservative, as today's check is for a task queue that cannot be loaded: when any consumed carrier for the name does not filter claims, every unserved Resizer that routes the name has its carrier for that name resolved, which builds a cold route. Two routers whose builders return one shared queue object are thus caught. A route build that fails is reported as today's "failed to load" problem and refuses start. An unserved Resizer whose name is unavailable (D2) has no carrier and is skipped; one that does not route the name is never built. When every consumed carrier filters claims, no unserved route is built (today's rule).
  - Then the checks of D15 (worker start), then the Consumers.
  - `ResizeWorker` declares `queue: { type: 'string', multiple: true }`; `run()` passes one name as a string and several as a list. `runResizeWorker({ queue?: string | readonly string[] })`.
- **D17. Task order keeps every commit green.** Registry and guard first (1), routing in the core (2), the worker (3), contracts, types and the moved validation (4), the drivers' `fromConfig` (5), `createResizer` (6), the framework adapter on it (7), docs and templates (8). Every existing test a task breaks is listed in that task with its new assertion.

## Global Constraints

- **Branch and repository.**
  - Branch `refactor/s4-config-factory` in the worktree `.claude/worktrees/s1-ports-and-composition-root`, on top of S3 (`391821e`, PR #61, not merged); S4 is stacked on it.
  - Each task ends with one commit. Nothing is pushed, including the docs-site branch.
  - Plain git in the worktree, one command per call (stage, then commit, as two calls), never `git -C`, no compound git commands. The docs-site step runs from inside that repository: `/Users/andrey/Work/framework-documenation-github`, branch `docs/s4-config-factory` (the controller creates it on top of `docs/s3-decoder`), page `docs/12-resize.md`.
- **Scope.** F6's remainder, F7, the scaffold templates. Out of scope: F8 metrics, F9 freshness (S5); the rest of F10 and the S6 hygiene; an engine port; sharing queues between `createResizer` calls.
- **The rc promise.** S4 ships as `0.3.0-rc.3`. It adds API (`createResizer`, `RoutingTaskQueue`, `fromConfig`, the registry, `routeOf`, a worker queue list, the `drivers` option) and makes a rejected setup work (a Resizer's call on a queue of another available backend). It renames and removes nothing a host writes: every option, config key, type name (O1), import path and export of rc.2 stays. A setup that works today keeps working without a new package (D1, D2).
- **Unchanged.**
  - The preview identity, random keys, the SVG and private-original policies.
  - The S2 gate per Resizer, media, pipeline and queue; the lease-token fencing; the `ResizeTask` indexes.
  - `resolve()` never throws and never runs Sharp. The decoders and steps of S3.
  - `FrameworkResizer`'s lazy reads: nothing is read from the app until first use; `media` (and a `locks` computed from a code `tasks`) is readable at once; options win over files.
  - `mongoParts` (one timing for every name), `new Resizer({...})` hand wiring and its `verify()`, `getResizer`, `runWorker` with one queue.
- **Error codes:** D13. Same texts for every moved check unless D13 says otherwise.
- **Main-entry exports.** New values: `createResizer`, `RoutingTaskQueue`, `carrierOf`. `PartialFrameworkResizeConfig` is a new type beside `FrameworkResizeConfig` (main entry types and `…/framework.js`). New types: `ResizerConfig`, `CreateResizerOptions`, `DriverRegistry`, `DriverContext`, `StorageDriver`, `DatabaseDriver`, `DatabaseParts`, `QueueDriver`, `QueueDriverContext`, `QueueEntry`, `QueueSection`, `StorageConfig`, `LocalStorageConfig`, `S3StorageConfig`, `MongoDatabaseConfig`, `ResizerSections`. `…/drivers/mongo.js` adds `MongoDatabase`.
- **House rules from S1–S3.**
  - Classes own their behaviour. Module-private helpers take narrow parameters, never a whole deps bag.
  - No service imports `resizer.ts`; the factory is composition (the import allowlist adds `factory/createResizer.ts` only).
  - `drivers/**` import only contracts, errors, helpers, types and other drivers.
  - Shipped code uses the `isResizeError` brand, never `instanceof`, on errors; drivers, routes and parts are checked by duck typing.
  - No test-only seams in shipped code. No `any`, except with a `biome-ignore` that gives the reason. `src/types.d.ts` stays dependency-free.
  - Comments state reasons in plain words, with no spec-section references and no private project names.
  - Tests never spread class-typed values.
  - The main entry imports no framework code and no mongoose, and statically reaches no driver.
- **Renames.** `git mv src/framework/peers.ts src/helpers/peers.ts` (Task 4): byte-identical in its commit, with the importers' lines; check `git diff --cached -M --stat`.
- **Checks.**
  - Every task ends with `npm run types:check`, `npm run check` and `npm test` passing (`npm test` runs the Mongo integration tests too).
  - Tasks 2, 3, 6, 7 and 8 also run `npm run build && npm run smoke`; Task 7 also `node --experimental-strip-types --test src/config/resize.framework.integration.test.ts` after the build.
  - One file: `node --experimental-strip-types --test src/<file>.test.ts`.
  - Test files stay outside `types:check` (about 65 errors exist there); add none. `src/testHelpers/**` is type-checked.
- **Commit messages** use a conventional prefix, with NO `Co-Authored-By` and no "Generated with" trailer.

## Review Focus

1. **A database Resizer beside an SQS entry whose SDK is not installed.** Expected: `src/framework/resizer.test.ts:753-825` unchanged; stored previews are served by `resolve()`; `prewarm()` on `default` is accepted (a database task row, no lock); `prewarm({ queue: 'bulk' })`'s message and a worker given `bulk` both name `@aws-sdk/client-sqs`; a worker for `default` starts and completes a task; `verify()` needs no `Lock` model; `drivers/sqs.ts` is never resolved. (Test: Task 6 and Task 7, child process.)
6. **The inverse: the Resizer's own queue cannot be used, the consumed one can.** Own `default` on a route whose build fails (or, through the adapter, on SQS without its SDK), `bulk` healthy: a worker for `bulk` starts, completes a task and checks no lock store for `default`; `verify()` still rejects for `default`. (Test: Task 2 in memory, Task 7 through the adapter.)
7. **Two routers whose builders return one shared queue that does not filter claims.** A worker serving only the first router's Resizer refuses to start (`RESIZE_QUEUE_SHARED_RESIZER_UNLISTED`), although the second router's route was never built. (Test: Task 2.)
2. **An environment override that moves only `queues.default` to SQS, with the SDK installed.** Expected: no `RESIZE_QUEUE_NOT_SERVED`; a call on `bulk` takes no lock (its task row is the gate) and a call on `default` takes the gate lock; retries, the dead-letter cooldown and the shutdown give-back each use their own backend's gate; `--queue=default` consumes SQS and `--queue=bulk` the database. (Test: Task 2 in memory, Task 7 through the adapter.)
3. **A complete framework config through the new merge.** The same objects reach the Resizer (`image.formats`, `image.encode`), and a file with `encode.formats: { webp }` only still treats `jpeg` as unconfigured (`RESIZE_FORMAT_NOT_CONFIGURED` for a per-call `jpeg`). (Test: Task 4, Task 7.)
4. **A worker given one good and one unknown queue** (`--queue=default --queue=typo`). Expected: `RESIZE_QUEUE_NOT_SERVED` naming `'typo'` before any claim, not a silent skip. (Test: Task 3.)
5. **Timing read once per name.** A route whose `getTiming` counts its calls is read once for a name used by the Dispatcher and by the worker. (Test: Task 2.)

---

## File structure

| File | Change | Responsibility after S4 |
|---|---|---|
| `src/registry.ts` | Modify | Items by name, shared parts and shared values, all forgotten by `reset()` |
| `src/resizer.ts` | Modify | `sharedPart`, `sharedValue`, `verifyServicesOf`, `verifyRouteOf` (internal); `onResetResizerForTests` removed; `verify()` and the Dispatcher build per D15 |
| `src/contracts/taskQueue.ts` | Modify | Optional async `routeOf` |
| `src/routing.ts` | Create | `RoutingTaskQueue`, `carrierOf` (public); `markUnavailable`, `unavailableReason` (internal) |
| `src/dispatcher.ts` | Modify | Per call: the carrier's gate, `add`, `findActive`, the lock rule; the unavailable reason in `not-served` |
| `src/reader.ts` | Modify | The `route-failed` and `locks-missing` outcomes: prewarm issues (D13), `resolve()` logs once per name |
| `src/worker.ts` | Modify | A queue list; one Consumer per (carrier, name); per-name checks; service checks split from route checks |
| `src/contracts/drivers.ts` | Create | The driver factory types (D6) |
| `src/types.d.ts` | Modify | Core config section types, `…SectionOf`, the `Framework*` aliases, new issue codes |
| `src/factory/types.ts` | Create | `ResizerConfig<D>` |
| `src/factory/image.ts` | Create | `mergeImageConfig` (D5) |
| `src/factory/queues.ts` | Create | `resolveQueueEntries`, `validateQueueDrivers` |
| `src/helpers/queueSections.ts` | Create | `validateSqsEntries`, `sqsBackendKey` (peer-free) |
| `src/factory/lane.ts` | Create | `chooseLane` |
| `src/factory/databaseQueue.ts` | Create | The built-in `'database'` queue driver |
| `src/factory/builtins.ts` | Create | The built-in driver table, the peer probe; the only dynamic driver imports |
| `src/factory/queueSet.ts` | Create | `planQueueSet` (D11) |
| `src/factory/createResizer.ts` | Create | `createResizer`, `CreateResizerOptions`, `configuredOptions`, `ConfigSource` |
| `src/helpers/peers.ts` | Move from `src/framework/peers.ts` | `importDriver`; `probePeers` added in Task 6 |
| `src/drivers/fs.ts`, `s3.ts`, `sqs.ts` | Modify | `static fromConfig` |
| `src/drivers/mongo/database.ts` | Create | `MongoDatabase.fromConfig` |
| `src/framework/database.ts` | Create | `FrameworkDatabase.fromConfig`; no module-level state |
| `src/framework/queue.ts` | Delete | (moved into the factory and the helpers) |
| `src/framework/resizer.ts` | Rewrite | `FrameworkResizer<D>` over `configuredOptions`; the `drivers` option |
| `src/framework/config.ts` | Modify | Queues through the core helpers; any driver name; image merge; no `backend` |
| `src/framework/worker.ts`, `ResizeWorkerCommand.ts` | Modify | A queue list; repeatable `--queue` |
| `src/framework/scaffold/templates/*.tpl` | Modify | Comments: mixed backends, repeatable `--queue` |
| `src/index.ts`, `src/drivers/mongo/index.ts`, `smokeTest.ts` | Modify | The new exports |
| `src/testHelpers/fakes.ts` | Modify | `memoryStorage()` moved here from two tests; a `leases` record of successful claims beside `claims` |
| `src/testHelpers/factoryTypes.ts` | Create | The type tests (D7) |
| `README.md`, `AGENTS.md`, `CHANGELOG.md`, `RELEASE.md`, `docs/host-adoption.md`, `package.json`, docs site | Modify | Docs and `0.3.0-rc.3` |

---

### Task 1: Shared parts in the process registry; the framework adapter owns no shared state

**Files:**
- Modify: `src/registry.ts` (replace `#resetHooks` / `onReset` with shared parts and values), `src/resizer.ts:695-708` (drop `onResetResizerForTests`; add `sharedPart`, `sharedValue`), `src/framework/queue.ts:42-79` (`taskQueueOf` keeps its signature and builds through `sharedPart('framework:queue:' + backend, …)`; the `built` WeakMap and the reset hook go).
- Modify: `src/architecture.test.ts`.
- Test: `src/registry.test.ts`, `src/resizer.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  // src/registry.ts, on Registry<T>
  shared<V>(key: string, build: () => Promise<V>): Promise<V>; // once per key; a rejected build is forgotten
  sharedValue<V>(key: string, value: V): V; // records `value` if the key is free; returns the recorded value
  reset(): void; // forgets the items, the shared parts and the shared values
  // src/resizer.ts (internal; not on the main entry)
  export function sharedPart<V>(key: string, build: () => Promise<V>): Promise<V>;
  export function sharedValue<V>(key: string, value: V): V;
  ```

- [ ] **Step 1: Write the failing tests.** In `src/registry.test.ts`:
  ```ts
  test('shared() builds once per key and hands every caller the same promise', …) // two calls, build called once, same resolved object
  test('a rejected shared build is forgotten, so the next call builds again', …)
  test('sharedValue() keeps the first value under a key', …) // sharedValue('k', a) === a; sharedValue('k', b) === a
  ```
  Existing tests this task changes:
  - `src/registry.test.ts:55-70` 'reset() forgets every item and runs every onReset hook' → 'reset() forgets every item, shared part and shared value': after `reset()`, `list()` is `[]`, `shared('k', build)` builds again, `sharedValue('k', b) === b`, and a forgotten name can be registered again (the test's last assertion, kept).
  - `src/resizer.test.ts:1228-1244` 'resetResizerForTests() runs every onResetResizerForTests hook' → 'resetResizerForTests() forgets the shared parts': `sharedPart('k', build)` twice builds once; after `resetResizerForTests()` it builds again. Drop the `onResetResizerForTests` import (`:19`).

  In `src/architecture.test.ts`:
  ```ts
  test('the framework adapter keeps no module-level state except the config-validation caches', …)
  // every shipped file under framework/ (not scaffold/, not tests): no line matching /^let /m and no
  // /^(export )?const \w+ = new (Map|Set|WeakMap|WeakSet)\b/m, except config.ts's resolvedFiles,
  // resolvedProcess and missingProcessFile
  test('onResetResizerForTests is gone', …) // no shipped file names it
  ```
- [ ] **Step 2: Run them to verify they fail.** Run: `node --experimental-strip-types --test src/registry.test.ts src/architecture.test.ts`. Expected: FAIL (`shared` is not a function; `queue.ts` has `let built`).
- [ ] **Step 3: Implement** the registry methods, the two internal functions, and `taskQueueOf` over `sharedPart`. The framework tests reset the registry in their `afterEach` (`src/framework/resizer.test.ts:90`), so string keys do not leak between fake apps.
- [ ] **Step 4: Run everything.** Run: `npm run types:check && npm run check && npm test`. Expected: PASS, including `src/framework/resizer.test.ts` 'resetResizerForTests forgets the per-backend task queues' and 'a per-backend task queue whose build failed is built again on the next call', unchanged.
- [ ] **Step 5: Stage.** `git add src`
- [ ] **Step 6: Commit.** `git commit -m "refactor: the process registry keeps shared parts; the framework adapter keeps no shared queue state"`

---

### Task 2: `RoutingTaskQueue`, `routeOf`, the per-queue carrier and the per-route lock rule

**Files:**
- Modify: `src/contracts/taskQueue.ts` (after `servesQueue`), `src/dispatcher.ts:98-100,330-563` (the `notServed` text; `#dispatch`, `#add`, `#confirmActive` take the carrier; new outcomes `route-failed` and `locks-missing`; `not-served` carries the unavailable reason), `src/reader.ts` (the outcomes: prewarm issues per D13, `resolve()` logs once per name), `src/resizer.ts:546-569` (`verify()` split into `verifyServicesOf` and `verifyRouteOf`; `#buildDispatcher` per D15), `src/worker.ts:55-103,122-332` (carriers per name, including the skip loop at `:163-181`; the conservative `refuseUnservedSharers`; the `verify()` loop at `:196` replaced per D15; still one name until Task 3), `src/types.d.ts:147-161` (`EnqueueIssue.causeCode`, D13; the code union unchanged).
- Create: `src/routing.ts`.
- Modify: `src/index.ts`, `src/index.test.ts`, `smokeTest.ts` (`RoutingTaskQueue` and `carrierOf` in both export lists).
- Test: `src/routing.test.ts`, `src/dispatcher.test.ts`, `src/worker.test.ts`, `src/resizer.test.ts`, `src/prewarm.test.ts`, `src/customDecoder.test.ts` (unchanged).

**Interfaces:**
- Produces:
  ```ts
  // src/routing.ts
  export type Route = TaskQueue | (() => Promise<TaskQueue>);
  export class RoutingTaskQueue extends TaskQueue {
    constructor(routes: Record<string, Route>, opts?: { getTiming?(queue: string): Partial<QueueTimingOptions> | undefined });
    routeOf(queue: string): Promise<TaskQueue | undefined>;
    // add, claim, renew, complete, fail, findActive, servesQueue, getTiming, verify (D4)
  }
  export function carrierOf(tasks: TaskQueue, queue: string): Promise<TaskQueue | undefined>; // D3; public
  export function markUnavailable(tasks: TaskQueue, reasons: ReadonlyMap<string, ResizeError>): void; // D2; internal
  export function unavailableReason(tasks: TaskQueue, queue: string): ResizeError | undefined; // D2; internal
  // src/resizer.ts (internal; for the worker)
  export function verifyServicesOf(resizer: Resizer): Promise<void>; // D15
  export function verifyRouteOf(resizer: Resizer, queue: string): Promise<void>; // D15
  ```

- [ ] **Step 1: Write the failing tests.** Fakes: `MemoryTaskQueue` (gates, filters claims), `PlainTaskQueue` (neither), `ReleasingTaskQueue` (plain, with `release`), `memoryLocks()` / `clockLocks()` from `src/testHelpers/fakes.ts`.
  Existing tests this task changes:
  - `src/prewarm.test.ts:255-280` (`prewarm({ queue: 'bulk' })` on a task queue that does not serve it): the expected `message` becomes "cannot queue to 'bulk': its task queue does not serve that queue (a queue name it does not route)"; `code`, `retryable`, `previews` and the rest unchanged.
  - `src/dispatcher.test.ts:546` (the `message` constant of the not-served case): becomes "cannot queue to 'bulk': its task queue does not serve that queue (a queue name it does not route)"; the deep-equal result, the once-per-name warning and the rest unchanged.
  - `src/resizer.test.ts:760-770` 'invalid queue timing: reads serve stored previews, uploads and generate() work, prewarm() reports it, verify() rejects' (D15 timing move): the name stays true, and the timing case no longer goes through the shared `assertDegraded` helper's start-up log. New assertions: `prewarm()` still reports one issue `RESIZE_ENQUEUE_INTERNAL_ERROR`, `retryable: false`, message matching `/leaseMs/`, and `tasks.added` stays empty; `verify()` rejects twice with the `RESIZE_CONFIG_QUEUE_LEASE_INVALID` error; the log is the Dispatcher's once-per-queue-name error "cannot queue to 'default': its timing is invalid" (`src/dispatcher.ts:171-178`), not the "cannot use its task queue" error at start. The lock-store case of `assertDegraded` (`:772`) is unchanged.
  - `src/resizer.test.ts:783-825` 'a queue timing that becomes valid is used from the next call, and the failure is logged again only when it changes' (D15 timing move): renamed 'a queue timing that becomes valid is used from the next call; an invalid timing is logged once per queue name'. New log expectations, exactly:
    - after the two `ready()` calls (`:806-808`): `errors.length === 0`, as building the Dispatcher no longer reads timing (the first value, `{ leaseMs: 0 }`, is never read);
    - after `timing = { maxAttempts: 0 }` and the two `resolve()` calls (`:809-812`): `errors.length === 1`; `errors[0][0]` matches `/cannot queue to 'default': its timing is invalid/` and `errors[0][1]` is a `ResizeConfigError` whose message names `maxAttempts` (the Dispatcher logs `timing-invalid` once per queue name, `src/dispatcher.ts:171-178`); `tasks.added` stays `[]`;
    - the recovery is kept: after `timing = {}`, `resolve()` reports `20x20` missing and queues `[['20x20']]` (`:814-822`);
    - after `await r.verify()` (`:824-825`): `verify()` passes and `errors.length === 1`.
  - `src/worker.test.ts:1076-1100` (a task queue that cannot be used rejects start): the timing case still rejects with `RESIZE_CONFIG_QUEUE_LEASE_INVALID` before any claim (now from `verifyRouteOf` of the consumed name); unchanged.
  - `src/customDecoder.test.ts:349` (the order media, locks, decoder in `verify()`): unchanged (D15).
  - Any `src/worker.test.ts` case that counts `verify()` calls on a served Resizer: for a non-router task queue the same checks run in the same order (D15), so the assertions stay; a case that stubs `resizer.verify` to make start fail stubs the failing part instead (the media store's `verify`), with the same expected rejection.
  In `src/routing.test.ts`:
  ```ts
  test('add, claim, renew, complete and fail go to the route of the queue name', …)
  // routes { default: memory, bulk: plain }: add({ queue: 'bulk', … }) → plain.added has it, memory.added empty;
  // claim('default') comes from memory; complete(claimedFromPlain) → plain row completed
  test('a builder route is built once, on first need; a rejected build is forgotten', …)
  // builder called 0 times after construction and servesQueue('bulk'); once after two routeOf('bulk'); after a rejection, again
  test('routeOf resolves a nested router; an unknown name resolves undefined; servesQueue answers without building', …)
  test('the flags are set only when every route is an object route with them, and are own data properties', …)
  // { a: memory } → gatesByTask true, claimFilters true; { a: memory, b: plain } → undefined; { a: memory, b: builder } → undefined;
  // Object.getOwnPropertyDescriptor(router, 'gatesByTask')?.get === undefined
  test('getTiming goes through timingOf on an object route and through opts.getTiming for a builder route', …)
  test('a builder route\'s timing is the router\'s option before and after the build, even when its carrier has no getTiming or another one', …)
  // opts.getTiming('bulk') → { maxAttempts: 2 }; builder returns a PlainTaskQueue without getTiming: timingOf(router, 'bulk').maxAttempts === 2
  // before routeOf('bulk') and after it; a worker for bulk dead-letters a failing task after its 2nd attempt.
  // A second builder whose carrier's getTiming says maxAttempts 9: timingOf(router, name).maxAttempts still 2
  test('a route\'s getTiming runs once for a name read by the Dispatcher and by the worker', …)
  // object route with a counting getTiming; prewarm on that name, then runWorker for it → count 1 (Review Focus 5)
  test('markUnavailable keeps a reason per name; carrierOf ignores it; a task queue without reasons has none', …)
  test('findActive is the carrier\'s, or [] when the carrier has none', …)
  test('invalid routes are RESIZE_QUEUE_ROUTES_INVALID', …)
  // {}, null, { a: {} }, { a: 42 }, { a: memory-with-queues-['x'] }: each throws ResizeSetupError, that code, retryable false
  test('a builder that resolves something that is not a task queue is RESIZE_DRIVER_INVALID', …)
  test('add or claim on a name without a route rejects with RESIZE_QUEUE_NOT_SERVED', …)
  test('carrierOf: a queue without routeOf carries every name it serves', …)
  ```
  In `src/dispatcher.test.ts`:
  ```ts
  test('on a router, each call gets its queue\'s gate: the gating route adds with no lock, the plain route takes the gate lock', …)
  // locks.acquire count 0 after a 'default' prewarm, 1 after a 'bulk' prewarm; plain.added[0].gateOwner set; memory.added[0].gateOwner undefined
  test('prewarm({ queue }) on the other backend of a router is accepted, not RESIZE_QUEUE_NOT_SERVED', …)
  test('after an in-flight add, findActive is asked of the route', …)
  test('a route whose build fails: prewarm reports its code and retryable, resolve logs once per name and serves stored previews, the other route still queues', …)
  // builder rejects with ResizeSetupError RESIZE_PEER_MISSING → { code: 'RESIZE_ENQUEUE_QUEUE_FAILED', causeCode: 'RESIZE_PEER_MISSING', retryable: true } (its own retryable);
  // with new ResizeError('…', { code: 'GCS_BUCKET_MISSING', retryable: false }) → { code: 'RESIZE_ENQUEUE_QUEUE_FAILED', causeCode: 'GCS_BUCKET_MISSING', retryable: false };
  // with a branded error whose code is in the union, e.g. code 'RESIZE_QUEUE_NOT_SERVED', retryable false → { code: 'RESIZE_QUEUE_NOT_SERVED', retryable: false }, no causeCode;
  // with a branded ResizeSetupError retryable true (the default) → retryable true (no prewarm advice rule on this path);
  // a plain Error('boom') → { code: 'RESIZE_ENQUEUE_QUEUE_FAILED', retryable: true, message containing 'boom' }, no causeCode
  test('a name marked unavailable: prewarm is RESIZE_QUEUE_NOT_SERVED, not retryable, and the message names the package; resolve logs it once', …)
  // markUnavailable(tasks, new Map([['bulk', peerMissingError]])) on a MemoryTaskQueue serving only 'default'
  test('a call on a plain route without a lock store reports RESIZE_ENQUEUE_LOCK_FAILED with causeCode RESIZE_LOCKS_REQUIRED; the gating route still queues', …) // retryable false
  ```
  In `src/worker.test.ts` (mixed backends through one router; Review Focus 2):
  ```ts
  test('a worker for bulk consumes the plain route of a Resizer\'s router', …) // the task completes; memory.claims empty
  test('the startup check compares routes: an unserved Resizer routing bulk to the consumed plain queue is RESIZE_QUEUE_SHARED_RESIZER_UNLISTED', …)
  test('on a router, a failed task retries on its own backend: the plain route keeps the gate lock until the retry, the gating route keeps its row active', …)
  test('on a router, a dead-letter cools down on its own backend: a gate lock for the plain route, the row for the gating route', …)
  test('on a router, a stopped worker gives a plain task back with release and keeps its gate lock', …) // ReleasingTaskQueue route
  test('worker start needs a lock store for a consumed route without gatesByTask', …) // RESIZE_LOCKS_REQUIRED before any claim
  test('a worker for bulk starts although the served Resizer\'s own queue default cannot be used', …)
  // router { default: builder that rejects (and would be a plain queue), bulk: memory }; Resizer queueName 'default', no locks;
  // runWorker({ queue: 'bulk' }) starts and completes a bulk task; the default builder was never called; no RESIZE_LOCKS_REQUIRED;
  // resizer.verify() still rejects with the builder's error (Review Focus 6)
  test('a worker for a healthy bulk starts while default has invalid timing', …)
  // router { default: new MemoryTaskQueue({ timing: { leaseMs: 0 } }), bulk: memory2 } (object routes: the invalid timing is the default route's own,
  // read through timingOf(route, 'default') per D4); Resizer queueName 'default';
  // runWorker({ queue: 'bulk' }) starts and completes a bulk task; runWorker({ queue: 'default' }) rejects with RESIZE_CONFIG_QUEUE_LEASE_INVALID before any claim
  test('a worker given a name marked unavailable fails with RESIZE_QUEUE_NOT_SERVED naming the queue and the package', …)
  test('two routers whose cold builders return one shared plain queue: a worker serving only the first refuses to start', …)
  // shared = new PlainTaskQueue({ queues: ['bulk'] }); a: router { bulk: async () => shared }; b: router { bulk: async () => shared }, b unserved;
  // runWorker({ queue: 'bulk', resizers: [a] }) → RESIZE_QUEUE_SHARED_RESIZER_UNLISTED naming 'b'; nothing claimed (Review Focus 7).
  // Variant: b's builder rejects → the same code, with the "failed to load" text and the error as cause.
  // Variant: shared is a MemoryTaskQueue (filters claims) → start succeeds and b's builder is never called.
  ```
  In `src/resizer.test.ts`:
  ```ts
  test('a Resizer with a router builds its Dispatcher without a lock store; verify() checks the lock store only for its own queue\'s carrier', …)
  // own queue on the gating route, no locks → verify() passes; own queue on the plain route, no locks → RESIZE_LOCKS_REQUIRED;
  // with a lock store whose verify rejects and the own queue on the gating route → verify() passes (the store is not verified)
  test('a non-router task queue keeps today\'s lock rules', …) // PlainTaskQueue without locks → verify() RESIZE_LOCKS_REQUIRED; a given lock store is verified
  test('verify() rejects with the unavailable reason of the Resizer\'s own queue', …) // markUnavailable for its queueName → that RESIZE_PEER_MISSING error
  test('verifyServicesOf builds no route and reads no timing; verifyRouteOf builds only the named one', …)
  test('verify() of a router whose own name has invalid timing rejects with RESIZE_CONFIG_QUEUE_LEASE_INVALID; a call on its other name still queues', …)
  // router { default: new MemoryTaskQueue({ timing: { leaseMs: 0 } }), bulk: memory2 } (object routes; the invalid timing is the route's own, per D4); queueName 'default'.
  // A second case with a builder route for default and opts.getTiming('default') → { leaseMs: 0 } rejects the same way
  test('a plain task queue with invalid timing builds its Dispatcher: generate() works, prewarm() reports RESIZE_ENQUEUE_INTERNAL_ERROR, verify() rejects', …)
  test('a supplied lock store is verified in the shared step, with no task queue and with a plain one, but not with a router', …)
  ```
- [ ] **Step 2: Run them to verify they fail.** Run: `node --experimental-strip-types --test src/routing.test.ts src/dispatcher.test.ts src/worker.test.ts src/resizer.test.ts`. Expected: FAIL (`src/routing.ts` does not exist).
- [ ] **Step 3: Implement** D3, D4, D15, and the Dispatcher's per-call carrier with the D13 texts and issue codes.
- [ ] **Step 4: Run everything.** Run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS.
- [ ] **Step 5: Stage.** `git add src smokeTest.ts`
- [ ] **Step 6: Commit.** `git commit -m "feat: RoutingTaskQueue routes queue names to lazily built backends; each call uses its queue's gate and lock rule"`

---

### Task 3: One worker, several queues

**Files:**
- Modify: `src/worker.ts` (`RunWorkerOptions.queue`, the per-name loop), `src/framework/worker.ts`, `src/framework/ResizeWorkerCommand.ts:39-66`, `src/testHelpers/fakes.ts:12,68` (`leases`).
- Test: `src/worker.test.ts`, `src/framework/worker.test.ts`, `src/framework/ResizeWorkerCommand.test.ts`.

**Interfaces:**
- Consumes: `carrierOf` (Task 2).
- Produces: `RunWorkerOptions.queue?: string | readonly string[]`; `runResizeWorker(opts?: { queue?: string | readonly string[] })`; `ResizeWorker.commandArguments.queue` is `{ type: 'string', multiple: true, description }`.

- [ ] **Step 1: Write the failing tests.** In `src/worker.test.ts`:
  ```ts
  test('one worker runs two Resizers on two queues of two backends', …)
  // a: MemoryTaskQueue, queueName 'default'; listings: PlainTaskQueue + memoryLocks(), queueName 'bulk';
  // prewarm one media on each; runWorker({ queue: ['default', 'bulk'], signal }) until both media have previews;
  // each Resizer's own storage receives its files
  test('a listed queue that no task queue serves is RESIZE_QUEUE_NOT_SERVED naming it, before any claim', …)
  // queue: ['default', 'typo'] → rejects; the message names 'typo'; memory.claims is empty (Review Focus 4)
  test('a listed queue whose route fails to build rejects start naming it; a worker for the other queue never builds it', …)
  test('an empty queue list, or a blank name in it, is RESIZE_QUEUE_INVALID', …)
  test('a queue listed twice is consumed by one Consumer', …)
  // A PlainTaskQueue whose claim() waits on its signal (a long poll) and records the number of claim calls in flight at once.
  // queue: ['default', 'default'] with one queued task: after the task completes, queue.leases.length === 1 (successful claims only);
  // then, once a claim call is waiting again, the most claim calls ever in flight at once is 1 (two Consumers would both be
  // waiting); abort and await the worker. No timers.
  ```
  `src/testHelpers/fakes.ts` gains `readonly leases: LeasedTask[]` on the in-memory task queues, pushed only when `claim` returns a task (`claims` keeps recording every call, empty polls included, so existing assertions on it stay).
  In `src/framework/ResizeWorkerCommand.test.ts`:
  ```ts
  test('--queue may be repeated; one --queue passes a single name', …)
  // args { queue: ['default', 'bulk'] } → runResizeWorker gets ['default', 'bulk']; { queue: ['bulk'] } → 'bulk'
  ```
  Existing tests this task changes: in `src/framework/ResizeWorkerCommand.test.ts`, a case that passes `args: { queue: 'bulk' }` (a string, the old parser output) now passes `{ queue: ['bulk'] }` and keeps its assertion that `runResizeWorker` receives `'bulk'`.

  In `src/framework/worker.test.ts`:
  ```ts
  test('runResizeWorker passes a queue list to runWorker', …)
  ```
- [ ] **Step 2: Run them to verify they fail.** Run: `node --experimental-strip-types --test src/worker.test.ts src/framework/ResizeWorkerCommand.test.ts src/framework/worker.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** D16.
- [ ] **Step 4: Run everything.** Run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS.
- [ ] **Step 5: Stage.** `git add src`
- [ ] **Step 6: Commit.** `git commit -m "feat: one worker consumes several queues (--queue may be repeated)"`

---

### Task 4: Driver contracts, core config types, the image merge and the queue entries in the core

**Files:**
- Create: `src/contracts/drivers.ts`, `src/factory/types.ts`, `src/factory/image.ts`, `src/factory/queues.ts`, `src/helpers/queueSections.ts`, `src/testHelpers/factoryTypes.ts`.
- Move: `git mv src/framework/peers.ts src/helpers/peers.ts` (byte-identical), with the import lines in `src/framework/resizer.ts` and `src/framework/queue.ts`.
- Modify: `src/types.d.ts:325-386` (D7), `src/framework/config.ts:236-325` (`resolveQueues` and `entryTiming` become calls to `resolveQueueEntries` and `validateSqsEntries`; the `'database' or 'sqs'` name check and `backend` stay in `config.ts` until Task 7), `src/framework/queue.ts` (`backendKey` for SQS calls `sqsBackendKey`), `src/index.ts` (type exports).
- Test: `src/factory/image.test.ts`, `src/factory/queues.test.ts`, `src/helpers/helpers.test.ts`.

**Interfaces:**
- Produces: the D6 types; the D7 types;
  ```ts
  // src/factory/image.ts
  export function mergeImageConfig(partial: unknown): unknown; // D5; the Resizer validates the result
  // src/factory/queues.ts
  export function resolveQueueEntries(value: unknown, where: string): QueueEntry[]; // D12, in the map's order
  export function validateQueueDrivers(entries: readonly QueueEntry[], drivers: Record<string, QueueDriver>, where: string, validated: ReadonlySet<QueueDriver['validate']>): void; // D9: skips a driver whose validate is in the set
  // src/helpers/queueSections.ts
  export function validateSqsEntries(entries: readonly QueueEntry[], ctx: { where: string }): void; // the QueueDriver.validate signature; today's queueUrl and shared-URL texts
  export function sqsBackendKey(section: QueueSection): string; // today's 'sqs:[region,endpoint,dlq,wait]'
  ```
  Transitional (ruling R-S4-8): `ResolvedProcessConfig.queues` is `ReadonlyMap<string, QueueEntry<QueueConfig> & { backend: string }>` until Task 7, so `src/framework/queue.ts` keeps reading `backend`.

- [ ] **Step 1: Write the failing tests.** In `src/factory/image.test.ts`:
  ```ts
  test('a complete config comes back deep-equal, with the host\'s own objects', …)
  // c = makeImageConfig(); m = mergeImageConfig(c): deepEqual c; m.formats === c.formats; m.encode === c.encode; m.limits === c.limits
  test('encode.formats is replaced as a whole', …) // { encode: { formats: { webp: {} } } } → merged.encode.formats deepEqual { webp: {} }, and is the host's object
  test('objects merge key by key; arrays replace; undefined takes the default', …)
  // { formats: ['webp'] } → formats ['webp'], limits deepEqual defaults; { limits: { sourcePixels: 1 } } → other limits default;
  // { upload: { formats: ['png'] } } → upload.maxBytes default, formats ['png']; { encode: { sharpen: false } } → false; { maxSize: undefined } → default
  test('the result shares no object with the defaults', …) // mutate merged.limits of a partial merge → defaultResizeConfig.limits unchanged
  test('a value that is not an object is returned as it is; unknown and removed keys pass through', …) // 'x' → 'x'; { webpAvifOnly: true } keeps the key
  ```
  In `src/factory/queues.test.ts`: one test per D12 rule asserting today's code and text (copied from `src/config/resize.test.ts:295-337,342-415`); `test('each entry\'s timing fills the defaults and names the entry when invalid', …)`; and for `validateQueueDrivers`:
  ```ts
  test('an unregistered driver is RESIZE_CONFIG_INVALID with today\'s text, custom names listed after the built-in ones', …)
  // { driver: 'redis' } with built-ins only → "`queues.bulk` in <where> needs driver 'database' or 'sqs'";
  // with drivers.queue.plain registered → "needs driver 'database', 'sqs' or 'plain'"
  test('each driver\'s validate runs once on all its entries, unless that same function was already run', …)
  test('a host driver registered under sqs has its own validate run, even when validateSqsEntries is marked as run', …)
  // drivers.queue.sqs = { validate() { throw new ResizeConfigError('custom', { code: 'X_INVALID' }) }, fromConfig } and
  // validated = new Set([validateSqsEntries]) → throws X_INVALID
  ```
  In `src/helpers/helpers.test.ts`: `validateSqsEntries` (missing and empty `queueUrl`, one URL on two names: today's texts) and `sqsBackendKey` (the cases of `src/framework/resizer.test.ts:1166-1189`, same strings).
  In `src/testHelpers/factoryTypes.ts` (type-only; never run):
  ```ts
  const local: LocalStorageConfig = { driver: 'local', rootDir: 'r', publicBaseUrl: '/m' };
  const legacy: FrameworkLocalStorageConfig = local; // alias (O1)
  const file = { ...defaultFrameworkResizeConfig, mediaModelName: 'File', storage: local, queue: 'default', queues: { default: { driver: 'database' } } } satisfies FrameworkResizeConfig;
  class MemoryStorageDriver { static fromConfig(section: { driver: 'memory'; bucket: string }, ctx: DriverContext): ResizeStorage { … } }
  const custom: ResizerConfig<{ storage: { memory: typeof MemoryStorageDriver } }> = { storage: { driver: 'memory', bucket: 'b' } };
  // @ts-expect-error a custom section without its driver registered
  const unregistered: ResizerConfig = { storage: { driver: 'memory', bucket: 'b' } };
  // @ts-expect-error rootDir must be a string
  const wrong: ResizerConfig = { storage: { driver: 'local', rootDir: 1, publicBaseUrl: '/m' } };
  const partial: ResizerConfig = { formats: ['webp'], limits: { sourcePixels: 1 } };
  const withCustom = { ...file, storage: { driver: 'memory', bucket: 'b' } } satisfies FrameworkResizeConfig<{ storage: { memory: typeof MemoryStorageDriver } }>;
  const override = { limits: { sourcePixels: 1 }, encode: { sharpen: false }, upload: { maxBytes: 10 } } satisfies PartialFrameworkResizeConfig; // nested partial (O3)
  const envFile = { storage: { driver: 's3', bucketPublic: 'b' } } satisfies Partial<FrameworkResizeConfig>; // the rc.2 form still compiles
  // @ts-expect-error Partial<> leaves nested keys required
  const shallow = { limits: { sourcePixels: 1 } } satisfies Partial<FrameworkResizeConfig>;
  // @ts-expect-error a nested key still has its type
  const wrongNested = { limits: { sourcePixels: 'x' } } satisfies PartialFrameworkResizeConfig;
  ```
- [ ] **Step 2: Run them to verify they fail.** Run: `node --experimental-strip-types --test src/factory/image.test.ts src/factory/queues.test.ts src/helpers/helpers.test.ts`, then `npm run types:check`. Expected: FAIL (modules missing; `types:check` reports the missing types).
- [ ] **Step 3: Move `peers.ts`.** `git mv src/framework/peers.ts src/helpers/peers.ts`; fix the two import lines.
- [ ] **Step 4: Stage the move.** `git add src`
- [ ] **Step 5: Check the move.** `git diff --cached -M --stat` shows a 100% rename.
- [ ] **Step 6: Implement** the contracts, the types, `mergeImageConfig`, `resolveQueueEntries`, `validateQueueDrivers`, the two SQS helpers; point `src/framework/config.ts` and `src/framework/queue.ts` at them. `src/importGraph.test.ts`'s rules hold: `factory/types.ts` imports no `resizer.ts`; `helpers/queueSections.ts` imports only types and errors.
- [ ] **Step 7: Run everything.** Run: `npm run types:check && npm run check && npm test`. Expected: PASS, with every existing framework and config test unchanged in its assertions.
- [ ] **Step 8: Stage.** `git add src`
- [ ] **Step 9: Commit.** `git commit -m "refactor: driver factory contracts, core config types, the image merge and queue entries in the core"`

---

### Task 5: `static fromConfig` on every shipped driver

**Files:**
- Modify: `src/drivers/fs.ts`, `src/drivers/s3.ts`, `src/drivers/sqs.ts`.
- Create: `src/drivers/mongo/database.ts`; `src/factory/databaseQueue.ts`.
- Modify: `src/drivers/mongo/index.ts` (export `MongoDatabase`), `smokeTest.ts` (the mongo subpath list).
- Test: `src/drivers/fs.test.ts`, `src/drivers/s3.test.ts`, `src/drivers/sqs.test.ts`, `src/drivers/mongo/drivers.mongo.integration.test.ts`, `src/factory/databaseQueue.test.ts`.

**Interfaces:**
- Consumes: D6 types (Task 4).
- Produces:
  ```ts
  LocalFsStorage.fromConfig(section: LocalStorageConfig, ctx: DriverContext): LocalFsStorage;
  S3Storage.fromConfig(section: S3StorageConfig, ctx: DriverContext): S3Storage;
  SqsTaskQueue.fromConfig(entries: readonly QueueEntry<SqsQueueConfig>[], ctx: QueueDriverContext): SqsTaskQueue; // one backend's entries
  class MongoDatabase { static fromConfig(section: MongoDatabaseConfig, ctx: DriverContext): DatabaseParts }
  export const databaseQueueDriver: QueueDriver<DatabaseQueueConfig>; // src/factory/databaseQueue.ts
  ```
- Rules:
  - Each storage `fromConfig` passes only its own keys to its constructor (an environment file that switched drivers leaves the other driver's keys in the merged section, today's `buildStorage` rule), drops `undefined` values, and validates types: a missing or non-string required key is `ResizeConfigError` `RESIZE_CONFIG_INVALID` "`storage.<key>` in <where> must be a non-empty string"; `forcePathStyle` must be a boolean.
  - `SqsTaskQueue.fromConfig` gets the entries of one backend (the factory groups them with `sqsBackendKey` and has run `validateSqsEntries`): one instance with their name → URL map, the shared connection settings of the first entry, `getTiming: (name) => entry.timing`, and `ctx.logger`.
  - `MongoDatabase.fromConfig`: `connection` needs a `model` function, `mediaModel` must be an object or function (else `RESIZE_CONFIG_INVALID` naming the key); parts as `mongoParts` builds them, with `taskQueue({ queues, getTiming, logger })` → `new MongoTaskQueue({ model: ResizeTask, queues, getTiming, logger })`.
  - `databaseQueueDriver`: no `backendOf` (all database names are one backend); `fromConfig`: `ctx.database?.taskQueue` missing → `RESIZE_CONFIG_INVALID` "`queues.<first name>` in <where> uses driver 'database', which needs a `database` section"; else one task queue for every name.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  test('LocalFsStorage.fromConfig builds from its own keys and ignores another driver\'s', …) // { driver:'local', rootDir, publicBaseUrl, bucketPublic:'x' } works
  test('LocalFsStorage.fromConfig rejects a missing rootDir with RESIZE_CONFIG_INVALID naming where', …)
  test('S3Storage.fromConfig needs bucketPublic and drops undefined keys', …)
  test('SqsTaskQueue.fromConfig: one queue for one backend\'s entries, each name with its URL and timing', …)
  // servesQueue('a') and ('b') true, ('c') false; timingOf(q, 'a').maxAttempts from a's entry
  test('MongoDatabase.fromConfig gives media, locks and a task queue over the package models', …)
  // integration: parts.taskQueue({ queues: ['default','bulk'], … }).servesQueue('bulk') true, gatesByTask true; media has replacePreviews
  test('MongoDatabase.fromConfig rejects a connection without model() and a missing mediaModel', …)
  test('the database queue driver needs a database section', …)
  test('the database queue driver gives every name one task queue from the database parts', …)
  ```
- [ ] **Step 2: Run them to verify they fail.** Run: `node --experimental-strip-types --test src/drivers/fs.test.ts src/drivers/s3.test.ts src/drivers/sqs.test.ts src/factory/databaseQueue.test.ts`. Expected: FAIL (`fromConfig` is not a function).
- [ ] **Step 3: Implement** the four `fromConfig`s and the database queue driver.
- [ ] **Step 4: Run everything.** Run: `npm run types:check && npm run check && npm test`. Expected: PASS.
- [ ] **Step 5: Stage.** `git add src smokeTest.ts`
- [ ] **Step 6: Commit.** `git commit -m "feat: every shipped driver builds itself from its config section with fromConfig"`

---

### Task 6: `createResizer`

**Files:**
- Create: `src/factory/builtins.ts` (with the peer probe), `src/factory/lane.ts` (a copy of `chooseLane` with `where` in the messages; the framework keeps its own until Task 7), `src/factory/queueSet.ts`, `src/factory/createResizer.ts`.
- Modify: `src/helpers/peers.ts` (`probePeers`), `src/index.ts`, `src/index.test.ts`, `smokeTest.ts` (`createResizer` and the new types), `src/importGraph.test.ts` (allowlist: `factory/createResizer.ts` imports `resizer.ts`), `src/testHelpers/fakes.ts` (`memoryStorage()` moved from `src/customDecoder.test.ts` and `src/drivers/mongo/frameworkFree.integration.test.ts`; both import it now).
- Test: `src/factory/createResizer.test.ts`, `src/factory/peers.test.ts` (child process, modelled on `src/framework/resizer.peers.test.ts`), `src/drivers/mongo/frameworkFree.integration.test.ts`.

**Interfaces:**
- Consumes: Tasks 2, 4, 5.
- Produces:
  ```ts
  // src/factory/createResizer.ts
  export interface CreateResizerOptions<D extends DriverRegistry = {}> extends Omit<ResizerOptions, 'config' | 'storage' | 'media' | 'locks' | 'tasks' | 'coordination' | 'queueName'> {
    drivers?: D; storage?: ResizeStorage; media?: MediaStore; locks?: LockStore;
    tasks?: TaskQueue | false; coordination?: CoordinationOptions; queueName?: string;
  }
  export function createResizer<D extends DriverRegistry = {}>(config: ResizerConfig<D> | (() => ResizerConfig<D>), opts?: CreateResizerOptions<D>): Resizer;
  export interface ConfigSource { … } // D9
  export interface OwnSections { image: unknown; storage?: unknown; queue?: unknown }
  export interface ProcessSections { queues: readonly QueueEntry[]; coordination: CoordinationOptions | null | undefined; validated: ReadonlySet<QueueDriver['validate']> }
  export function configuredOptions(source: ConfigSource, opts: CreateResizerOptions<DriverRegistry> & { shareQueues?: string; queueLogger?: ResizeLogger }): ResizerOptions; // internal
  // src/factory/queueSet.ts
  export function planQueueSet(entries: readonly QueueEntry[], drivers: Record<string, QueueDriver>, ctx: { where: string; logger: ResizeLogger; database: () => Promise<DatabaseParts | undefined>; share?: string }): QueueSetPlan;
  export interface QueueSetPlan { taskQueue(): Promise<TaskQueue> } // D11; the result is marked with markUnavailable (D2), which is how the reasons reach the Dispatcher, verify() and the worker
  // src/helpers/peers.ts
  export function probePeers(peers: readonly string[], driver: string, where: string, resolve: (specifier: string) => string): ResizeSetupError | undefined; // builtins.ts passes import.meta.resolve
  ```

- [ ] **Step 1: Write the failing tests.** In `src/factory/createResizer.test.ts`, with test drivers registered by name: `MemoryStorageDriver` (`fromConfig` → `memoryStorage()`), `FakeDatabase` (`fromConfig` → `{ media: fakeMedia(…), locks: memoryLocks(), taskQueue: ({ queues }) => new MemoryTaskQueue({ queues }) }`), `PlainQueueDriver` (`fromConfig(entries)` → one `PlainTaskQueue` serving their names; counts its builds):
  ```ts
  test('a config object and one call: custom storage and database drivers registered by name run upload, prewarm, the worker and resolve', …)
  // createResizer({ formats: ['webp'], storage: { driver: 'memory' }, database: { driver: 'fake' }, queues: { default: { driver: 'database' } } },
  //   { drivers: { storage: { memory: MemoryStorageDriver }, database: { fake: FakeDatabase } } })
  // → uploadOriginal, prewarm status 'accepted', runWorker one task, resolve: every variant ready
  test('a custom queue driver registered by name: queues on two backends route, and the plain backend is built on first need', …)
  // queues { default: database, bulk: { driver: 'plain' } } → after ready(), PlainQueueDriver builds 0;
  // resizer.tasks instanceof RoutingTaskQueue (a test may use instanceof); prewarm on 'default' and on 'bulk' both 'accepted'; builds 1
  test('a database-only Resizer gets no lock store; a router gets the database parts\' lock store', …)
  test('a function config reads its database section on first use and runs upload, enqueue and the worker', …) // ruling R-S4-5; no media option
  test('image settings merge over the package defaults', …) // resizer.config.limits deepEqual defaults; formats ['webp']
  test('coordination: undefined takes the defaults; null is RESIZE_CONFIG_COORDINATION_INVALID from verify() and prewarm()', …) // ruling R-S4-2
  test('lanes: no queue is default when queues exist; an unknown name is RESIZE_CONFIG_QUEUE_UNKNOWN; false is eager; a queue object is RESIZE_CONFIG_REMOVED_KEY', …)
  test('an unregistered storage or queue driver is RESIZE_CONFIG_INVALID listing the registered names; resolve() still never throws', …)
  test('with tasks in code, an unregistered queue driver still fails verify() through coordination', …) // ruling R-S4-6
  test('a drivers entry without fromConfig is RESIZE_DRIVER_INVALID at construction, and the name stays free', …)
  test('a driver that returns something that is not the part is RESIZE_DRIVER_INVALID at first use', …)
  // storage without publicUrl; media without replacePreviews; a queue driver whose queue does not serve its names
  test('a host driver under a built-in name wins', …) // drivers.storage.local = MemoryStorageDriver
  test('without a database section or media, first use is RESIZE_MEDIA_REQUIRED naming the config', …)
  test('without a storage section or option, first use is RESIZE_CONFIG_STORAGE_MISSING', …)
  test('a database queue without a database section is RESIZE_CONFIG_INVALID', …)
  test('options win over the config: storage, media, tasks: false, queueName', …)
  ```
  In `src/factory/peers.test.ts` (each case in a child process with a `registerHooks` resolve hook, as `resize.peers.test.ts` does):
  ```ts
  test('s3 storage without @aws-sdk/client-s3: first use and verify() reject with RESIZE_PEER_MISSING naming the config passed to createResizer(); resolve() returns the empty decision', …)
  test('an sqs own queue without @aws-sdk/client-sqs: RESIZE_PEER_MISSING naming queues.<name>', …)
  test('a database Resizer beside an sqs queue without its SDK: database reads, enqueue and the worker work; bulk is RESIZE_QUEUE_NOT_SERVED; drivers/sqs.ts is never resolved', …)
  // prewarm({ queue: 'bulk' }).issues[0].message includes '@aws-sdk/client-sqs'; runWorker({ queue: 'bulk' }) rejects with
  // RESIZE_QUEUE_NOT_SERVED whose message names 'bulk' and '@aws-sdk/client-sqs'
  test('an sqs own queue without its SDK beside a database queue: a worker for the database queue starts; verify() rejects with RESIZE_PEER_MISSING', …)
  // queueName 'default' on sqs (SDK missing), 'bulk' on database: resizer.tasks is the database task queue; runWorker({ queue: 'bulk' })
  // completes a task with no lock store; prewarm() on 'default' is RESIZE_QUEUE_NOT_SERVED naming the package (Review Focus 6)
  test('local storage and a host database load no AWS module', …) // the hook records every resolved specifier: none starts with '@aws-sdk/'
  ```
  In `src/drivers/mongo/frameworkFree.integration.test.ts`:
  ```ts
  test('createResizer: a config object and one call on MongoDB, with no framework app', …)
  // createResizer({ storage: { driver: 'local', rootDir: tmp, publicBaseUrl: '/media' }, database: { driver: 'mongo', connection, mediaModel: File },
  //   queues: { default: { driver: 'database' } } }); create the ResizeTask indexes; verify(); upload; prewarm; runWorker one task; resolve all ready
  ```
  In `src/importGraph.test.ts`:
  ```ts
  test('only src/factory/builtins.ts imports a driver dynamically from the core', …) // shipped files outside drivers/ and framework/: /import\(\s*['"][^'"]*drivers\//
  ```
- [ ] **Step 2: Run them to verify they fail.** Run: `node --experimental-strip-types --test src/factory/createResizer.test.ts src/factory/peers.test.ts`. Expected: FAIL (`createResizer` missing).
- [ ] **Step 3: Implement** D2, D8, D9, D11. `configuredOptions` with `shareQueues` caches the set and each backend in the registry (D10).
- [ ] **Step 4: Run everything.** Run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS; the smoke's main-entry list has `createResizer`, `RoutingTaskQueue` and `carrierOf`.
- [ ] **Step 5: Stage.** `git add src smokeTest.ts`
- [ ] **Step 6: Commit.** `git commit -m "feat: createResizer(config, { drivers }) builds a Resizer from one config object"`

---

### Task 7: `FrameworkResizer` on the factory

**Files:**
- Create: `src/framework/database.ts`.
- Rewrite: `src/framework/resizer.ts` (D10; `chooseLane`, `gateLockStore` and `buildStorage` go: the factory has them).
- Delete: `src/framework/queue.ts`.
- Modify: `src/framework/config.ts` (D10: any non-empty driver name, no `backend`, image merge, `validated: new Set([validateSqsEntries])`), `src/types.d.ts` and `src/framework/index.ts` (`PartialFrameworkResizeConfig`), `src/importGraph.test.ts` (the dynamic-import guard now covers `framework/` too).
- Test: `src/framework/resizer.test.ts`, `src/config/resize.test.ts`, `src/framework/scaffold/command.test.ts`, `src/config/resize.framework.integration.test.ts`, `src/framework/queueIndexes.mongo.integration.test.ts`, `src/framework/worker.mongo.integration.test.ts`, `src/framework/resizer.peers.test.ts` (unchanged), `src/testHelpers/factoryTypes.ts`.

**Interfaces:**
- Consumes: `configuredOptions`, `ConfigSource` (Task 6), `sharedPart`, `sharedValue` (Task 1).
- Produces:
  ```ts
  // src/framework/database.ts
  export interface FrameworkDatabaseConfig { driver: 'framework'; configName: string; config?: FrameworkResizeConfig<DriverRegistry> }
  export class FrameworkDatabase { static fromConfig(section: FrameworkDatabaseConfig, ctx: DriverContext): DatabaseParts }
  // src/framework/resizer.ts
  export interface FrameworkResizerOptions<D extends DriverRegistry = {}> { …every rc.2 option…; drivers?: D; config?: FrameworkResizeConfig<D> }
  export class FrameworkResizer<D extends DriverRegistry = {}> extends Resizer { constructor(opts: FrameworkResizerOptions<D> = {}) } // generic class, non-generic constructor (TS1092; D7)
  ```

- [ ] **Step 1: Write the failing tests** (in `src/framework/resizer.test.ts`, with the fake app the file already uses):
  ```ts
  test('a database Resizer beside an SQS entry without its SDK: stored previews are served, database prewarm is accepted, a database worker starts, verify() needs no Lock model', …)
  // child process; the same hook as the test at :753 (the SDK missing, drivers/sqs.ts recorded); a media with one stored preview →
  // resolve() returns it ready; prewarm on 'default' accepted with no lock calls; runResizeWorker({ queue: 'default' }) completes the task;
  // verify() passes with getModel('Lock') undefined; sqsDriver stays [] (Review Focus 1)
  test('an environment override that moves only queues.default to SQS routes both names', …)
  // resize.ts: queues { default: { driver: 'sqs', queueUrl }, bulk: { driver: 'database' } }; drivers: { queue: { sqs: PlainQueueDriver } } (replaces the built-in, D6);
  // Resizer on 'default': resizer.tasks is a RoutingTaskQueue; prewarm({ queue: 'bulk' }) accepted with no lock taken;
  // prewarm() on 'default' takes the gate lock in the framework Lock model; verify() requires the Lock model (Review Focus 2)
  test('a database Resizer beside an unused SQS entry with its SDK: verify() needs no Lock model, and the SQS backend is never built', …)
  test('the own queue on SQS without its SDK, bulk on the database: a worker for bulk starts and needs no Lock model; verify() is RESIZE_PEER_MISSING', …)
  // child process, the hook of :753 with the queues swapped (default: sqs, bulk: database), getModel('Lock') undefined;
  // runResizeWorker({ queue: 'bulk' }) completes a task; sqsDriver stays []; prewarm() on 'default' is RESIZE_QUEUE_NOT_SERVED naming the package (Review Focus 6)
  test('a host driver registered under sqs has its own validate run after the built-in SQS checks of the file', …)
  // drivers: { queue: { sqs: { validate() { throw new ResizeConfigError('custom', { code: 'X_INVALID' }) }, fromConfig } } }, an sqs entry
  // with a queueUrl → verify() rejects with X_INVALID (the built-in checks passed at file read; the skip is by function identity)
  test('two Resizers on different named queues run under one worker', …)
  // a on 'default' (database), listings on 'bulk' (PlainQueueDriver under 'sqs'); runResizeWorker({ queue: ['default', 'bulk'] }) processes one task of each
  test('a custom storage driver named in the config file', …) // drivers: { storage: { gcs: MemoryStorageDriver } }, storage: { driver: 'gcs' }
  test('a partial config file is merged over the package defaults; a complete one reaches the Resizer with the same objects', …)
  // { mediaModelName, storage } → resizer.config deepEqual defaults; a file with encode.formats { webp } only → per-call jpeg prewarm issue RESIZE_FORMAT_NOT_CONFIGURED (Review Focus 3)
  test('resizer.media is readable before first use, as before', …)
  test('two FrameworkResizers share one queue set built with the app logger; a different queue driver map is RESIZE_DRIVER_CONFLICT from the constructor', …)
  // a's logger option receives nothing from the queue drivers; b with drivers.queue.sqs = OtherDriver → the constructor throws, b's name stays free
  ```
  In `src/testHelpers/factoryTypes.ts` (ruling R-S4-7):
  ```ts
  new FrameworkResizer({ drivers: { storage: { memory: MemoryStorageDriver } }, config: { ...file, storage: { driver: 'memory', bucket: 'b' } } });
  // @ts-expect-error a custom storage section in the config option without its driver
  new FrameworkResizer({ config: { ...file, storage: { driver: 'memory', bucket: 'b' } } });
  new FrameworkResizer({ drivers: { queue: { plain: PlainQueueDriverType } }, config: { ...file, queues: { bulk: { driver: 'plain' } } } });
  // @ts-expect-error a registered driver's section keeps its field types
  new FrameworkResizer({ drivers: { storage: { memory: MemoryStorageDriver } }, config: { ...file, storage: { driver: 'memory', bucket: 1 } } });
  const plainResizer: Resizer = new FrameworkResizer(); // D = {}; still a Resizer
  ```
  Existing tests this task changes, each with its new assertion:
  - `src/framework/resizer.test.ts:34` imports `backendKey, taskQueueOf` from `./queue.ts` → removed; `sqsBackendKey` from `../helpers/queueSections.ts` where needed, `carrierOf` from `../routing.ts`.
  - `:216-243` (`taskQueueOf` equality) → `r.tasks` equals the `tasks` of a second `new FrameworkResizer({ name: 'second' })` after `ready()`; the other assertions unchanged.
  - `:391-413` 'invalid storage or queues sections are config errors' → unchanged (the storage name is still checked when the own config is read, the queue name when `coordination`/the lane is read, `queueUrl` at file read).
  - `:753-825` → unchanged (D2).
  - `:1122-1164` 'SQS entries with the same connection settings share one SqsTaskQueue; a different dead-letter queue is another backend' → the two backends now route: `media.tasks === bulk.tasks === audit.tasks` (one shared router); `await carrierOf(media.tasks, 'default') === await carrierOf(media.tasks, 'bulk')`, an `SqsTaskQueue`; `await carrierOf(media.tasks, 'audit')` another `SqsTaskQueue`; `media.tasks.servesQueue('audit') === true`; `sqsBackendKey` replaces `backendKey` in the two key assertions.
  - `:1166-1189` (`backendKey`) → deleted here (Task 4 moved it to `src/helpers/helpers.test.ts`).
  - `:1192-1246` (a failed build retried) → the hook's importer becomes `context.parentURL?.endsWith('/factory/builtins.ts')`; the specifier stays `'../drivers/sqs.ts'`; every assertion unchanged.
  - `:1248-1289` (`resetResizerForTests` forgets the queues) → `:1287` becomes `assert.ok((await carrierOf(nextSqs.tasks, 'sqs')) instanceof SqsTaskQueue)`; the rest unchanged.
  - `src/config/resize.test.ts:97` → `assert.deepEqual(Object.keys(entry ?? {}).sort(), ['name', 'section', 'timing'])` instead of `entry?.backend`.
  - `src/config/resize.test.ts:147` 'rejects a partial host config because the framework config must be complete' → 'merges a partial host config over the package defaults': `install({ mediaModelName: 'File' })`; `getResizeConfig().image` deepEqual `defaultResizeConfig`.
  - `src/config/resize.test.ts:295-337` → the `{ bulk: { driver: 'redis' } }` row leaves the table (an unregistered name is the factory's, covered by `:391` and Task 6); the two `.backend` assertions are deleted (moved to `sqsBackendKey`); every other row unchanged.
  - `src/framework/scaffold/command.test.ts:189` and `src/config/resize.framework.integration.test.ts:91` → `assert.equal(processConfig.queues.get('default')?.section.driver, 'database')`.
  - `src/framework/queueIndexes.mongo.integration.test.ts:16,92` → the fixture's `tasks` is `FrameworkDatabase.fromConfig({ driver: 'framework', configName: 'resize' }, { logger: appLogger, where: 'test' }).taskQueue?.({ queues: ['default'], getTiming: () => undefined, logger: appLogger })`.
- [ ] **Step 2: Run them to verify they fail.** Run: `node --experimental-strip-types --test src/framework/resizer.test.ts src/config/resize.test.ts`. Expected: FAIL (routing through the adapter, the `drivers` option, the merge).
- [ ] **Step 3: Implement** D10; delete `src/framework/queue.ts`.
- [ ] **Step 4: Run everything.** Run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke`, then `node --experimental-strip-types --test src/config/resize.framework.integration.test.ts`. Expected: PASS; the Task 1 guard passes with `src/framework/database.ts` present.
- [ ] **Step 5: Stage.** `git add -A src`
- [ ] **Step 6: Commit.** `git commit -m "refactor: FrameworkResizer is the config files, the app models and createResizer's options; queues route across backends"`

---

### Task 8: Docs, scaffold templates and `0.3.0-rc.3`

**Files:**
- Modify: `src/framework/scaffold/templates/resize.config.ts.tpl`, `ResizeWorker.command.ts.tpl`; `src/framework/scaffold/command.test.ts`.
- Modify: `README.md`, `AGENTS.md`, `CHANGELOG.md`, `RELEASE.md`, `docs/host-adoption.md`, `package.json` (`"version": "0.3.0-rc.3"`), and `package-lock.json`'s version lines.
- Docs site: `/Users/andrey/Work/framework-documenation-github/docs/12-resize.md`.
- Test: `src/agentsDoc.test.ts` (existing: every main-entry import in AGENTS.md snippets is a real export).

- [ ] **Step 1: Templates.**
  - `resize.config.ts.tpl`: under `queues`, the comment says a queue may use another backend, e.g. `bulk: { driver: 'sqs', queueUrl: '…' }` beside the database `default` (needs `@aws-sdk/client-sqs`; without it the name is not served in that process), and that one worker can consume several: `npm run cli ResizeWorker -- --queue=default --queue=bulk`.
  - `resize.config.ts.tpl:36-38` (the closing comment about `resize.<NODE_ENV>.ts`): an override that leaves out nested keys (for example only `limits.sourcePixels`) ends with `satisfies PartialFrameworkResizeConfig`; the old `satisfies Partial<FrameworkResizeConfig>` stays valid for one that leaves out only top-level keys, and for a `resize.ts` that holds only the process-wide sections. The type is named in the comment only; the template imports nothing new, so a scaffolded file compiles unchanged.
  - `ResizeWorker.command.ts.tpl`: "(…, --queue, repeatable)".
  - Test in `command.test.ts`: `test('the config template shows a second backend, the repeatable --queue and PartialFrameworkResizeConfig', …)` matching the three strings in the scaffolded `src/config/resize.ts`. Run: `node --experimental-strip-types --test src/framework/scaffold/command.test.ts`. Expected: FAIL before the edit, PASS after. (`--check` compares markers, not text, so hosts see no drift.)
- [ ] **Step 2: README.md.**
  - "Without the framework": lead with the `createResizer` example (`formats`, `storage`, `database: { driver: 'mongo', connection, mediaModel: File }`, `queues`), then the hand-wired `new Resizer` example. One paragraph: options win over the config; only selected drivers load; parts are built on first use; two calls build their own queues.
  - New "Drivers by name" subsection under "Drivers": the kinds (`storage`, `database`, `queue`), `fromConfig(section, ctx)` for storage and database, the queue driver's `backendOf` / `validate` / `fromConfig(entries, ctx)` and why, duck typing, host names win, `RESIZE_DRIVER_INVALID`, `RESIZE_DRIVER_CONFLICT`; a `GcsStorage` example for `createResizer` and for `FrameworkResizer` with `satisfies FrameworkResizeConfig<{ storage: { gcs: typeof GcsStorage } }>`.
  - "Backends" (line ~790): rewrite. Names on different backends route through `RoutingTaskQueue`; `resizer.tasks` is a `RoutingTaskQueue` when the available backends are more than one (no `release`; `findActive` delegates; check `carrierOf`, not `instanceof MongoTaskQueue`); a backend is built when one of its names is first needed; a backend whose SDK is not installed is not served in that process (`RESIZE_QUEUE_NOT_SERVED`, its message names the package, in `prewarm()` and at worker start); `verify()` rejects with `RESIZE_PEER_MISSING` when that is the Resizer's own queue, and the task queue fails with it when no backend is available at all; each call is gated by its queue's backend; the `Lock` model is checked by `verify()` only when the Resizer's own queue is on a backend without its own gate (SQS), and by the worker only for each SQS queue it consumes (a worker checks only the queues it consumes, never a served Resizer's own queue otherwise). A builder route's timing comes from the router's `getTiming` option (D4). Delete "move all of a Resizer's queues together until routing … ships" and the two-backends `region` warning.
  - "The worker": `queue` takes a list; one Consumer per backend and name; an unserved or unbuildable listed name fails start.
  - The `TaskQueue` contract: `routeOf`; `RoutingTaskQueue`'s routes (objects or builders), flags and timing.
  - "Config reference": the merge rule (O3, D5), and `PartialFrameworkResizeConfig` for override files that leave out nested keys.
  - `prewarm()` issues table: `RESIZE_QUEUE_NOT_SERVED` without "or a queue on another backend (one Resizer cannot use two backends yet)", plus the missing-SDK case; `RESIZE_ENQUEUE_LOCK_FAILED` also with `causeCode: 'RESIZE_LOCKS_REQUIRED'` (a call on a queue without its own gate and no lock store); `RESIZE_ENQUEUE_QUEUE_FAILED` also for a backend that failed to build, with the error's code in `causeCode` and the error's own `retryable` (a branded code that is already an issue code is kept as the issue's code) (D13). A note on the new optional `causeCode` field.
  - "Package exports": the new main-entry values (`createResizer`, `RoutingTaskQueue`, `carrierOf`) and types; `MongoDatabase` on `…/drivers/mongo.js`.
- [ ] **Step 3: AGENTS.md.**
  - Intro and step 5: replace "One Resizer uses one backend … until routing between backends ships …" with the routing sentence, "a backend is built when first needed; a name whose driver's SDK is not installed is not served there", and the merge sentence of O3 (replacing "reads that final config without a second merge" and the Rule "The module reads that final config without a second merge").
  - Step 3: `createResizer(config, { drivers })` first for plain Node, then `new Resizer`; `FrameworkResizer` options gain `drivers`; the sentence at line ~86 ("the database queue … needs no Lock model") gains "unless the Resizer's own queue is on SQS; a database Resizer beside SQS queues still needs none"; `resizer.tasks` may be a `RoutingTaskQueue`.
  - Step 8: `npm run cli ResizeWorker -- --queue=default --queue=bulk`.
  - Troubleshooting: rewrite the `RESIZE_QUEUE_NOT_SERVED` rows (an unknown name, or a backend whose SDK is missing); add rows for `RESIZE_QUEUE_ROUTES_INVALID`, `RESIZE_DRIVER_INVALID`, `RESIZE_DRIVER_CONFLICT`, the prewarm issue `RESIZE_ENQUEUE_LOCK_FAILED` / `RESIZE_ENQUEUE_QUEUE_FAILED` with a `causeCode`; the invalid-timing row: a task queue's timing is checked by `verify()` for the Resizer's own queue and at worker start for consumed queues, and `resolve()` logs it once per queue name (no longer at start); `RESIZE_PEER_MISSING` also from `createResizer`; `RESIZE_CONFIG_INVALID`'s row: an unregistered driver name is checked when the Resizer reads that section.
  - A snippet importing `createResizer` from the main entry, so `src/agentsDoc.test.ts` checks the name.
- [ ] **Step 4: CHANGELOG.md** under `# 0.3.0`.
  - Prereleases: add "`0.3.0-rc.3`: new APIs a host may use, no required host change: `createResizer`, `fromConfig` and drivers by name, routing between backends, `carrierOf`, one worker for several queues, partial config files (see Changed behaviour for what a host may notice)." Keep "Later release candidates: internal changes that need no host change."
  - **Features:** `createResizer`; driver registry and `fromConfig`; `RoutingTaskQueue` and `routeOf`; mixed backends in `queues`; the worker queue list; `FrameworkResizer({ drivers })`; partial framework config files; the new core type names.
  - **Changed behaviour:** for a host whose `queues` span two available backends, `resizer.tasks` is a `RoutingTaskQueue` (no `release`; an `instanceof MongoTaskQueue` check fails; use `carrierOf`); `verify()` checks the `Lock` model only for a Resizer whose own queue is on SQS; owner O5 in one sentence; `RESIZE_QUEUE_NOT_SERVED` narrower; `EnqueueIssue` gains the optional `causeCode` (the union is unchanged); invalid timing of a task queue is logged per queue name by `resolve()` instead of at start; a worker no longer checks a served Resizer's own queue unless it consumes it; the `Framework*` storage type names deprecated.
  - **Internal:** the adapter keeps no shared queue state; the factory.
- [ ] **Step 5: RELEASE.md and host adoption.** RELEASE.md's prerelease sentence adds rc.3 (additions only). `docs/host-adoption.md`:
  - The prerelease paragraph (line ~44, "later release candidates change nothing a host sees"): say that `0.3.0-rc.3` adds APIs a host may choose to use (`createResizer`, drivers by name, `RoutingTaskQueue`, `carrierOf`, a worker queue list, partial config files) and requires no host change; name the two things a host may notice without changing anything: `resizer.tasks` can be a `RoutingTaskQueue` when `queues` span two available backends, and a call on a queue of another backend now queues instead of `RESIZE_QUEUE_NOT_SERVED`. Later candidates after rc.3: internal changes only.
  - Replace item 5 "Mixed backends from an environment override" with "now routes; a backend is built when first needed", and the line ~168 sentence.
- [ ] **Step 6: Docs site.** `cd /Users/andrey/Work/framework-documenation-github` (never `git -C`; the branch `docs/s4-config-factory` is checked out). In `docs/12-resize.md`: a short "Without the framework: `createResizer`" section linking the README reference; mixed backends and the repeatable `--queue` in the queues section; custom drivers by name in "Drivers"; the operations table rows of Step 3. Keep the guide there and the reference in README. Run `npx docusaurus build`. Expected: success (do not run `generate-llm-context`).
- [ ] **Step 7: Commit the docs site.** `git commit -am "docs(resize): createResizer, drivers by name, routing between backends"`, then return to the worktree.
- [ ] **Step 8: Version.** `package.json` and `package-lock.json` to `0.3.0-rc.3` (edit by hand; do not run `npm version`).
- [ ] **Step 9: Run everything.** Run: `node --experimental-strip-types --test src/agentsDoc.test.ts && npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS.
- [ ] **Step 10: Stage.** `git add README.md AGENTS.md CHANGELOG.md RELEASE.md docs/host-adoption.md package.json package-lock.json src/framework/scaffold`
- [ ] **Step 11: Commit.** `git commit -m "docs: createResizer, drivers by name, routing between backends; 0.3.0-rc.3"`

---

## Follow-ups (later phases, not in S4)

- Sharing queues between two `createResizer` calls without hand wiring (for example a `share` option or a factory that builds several Resizers from one `queues`).
- A typed way for a framework config file to name a custom queue driver's section without the type parameter.
- Removing the deprecated `Framework*` storage type aliases in 0.4.0.

## Definition of done (S4)

- **`src/framework/database.ts` has no module-level state:** the file holds `FrameworkDatabase` and no state; the guard 'the framework adapter keeps no module-level state except the config-validation caches' (Task 1) covers every adapter file; `src/framework/queue.ts` and `onResetResizerForTests` are gone (Tasks 1, 7).
- **A plain-Node example is a config object and one call:** `createResizer(…)` in `src/drivers/mongo/frameworkFree.integration.test.ts` (Task 6), and the README example (Task 8).
- **A custom driver registers by name:** `src/factory/createResizer.test.ts` 'a config object and one call: custom storage and database drivers registered by name …' and 'a custom queue driver registered by name …' (Task 6), and the framework case 'a custom storage driver named in the config file' (Task 7).
- **Two Resizers on different named queues run under one worker:** `src/worker.test.ts` 'one worker runs two Resizers on two queues of two backends' (Task 3) and the framework case of Task 7.
- **F6 coverage:** `RoutingTaskQueue` routes `add` and answers `servesQueue` (Task 2); the adapter wraps names on different backends (Tasks 6, 7); a worker started with `--queue=bulk` consumes that queue's backend (Tasks 2, 3); the module-level state is deleted (Tasks 1, 7). The host shape and the removed timing-conflict check shipped in S2b.
- **F7 coverage:**

  | F7 item | Task |
  |---|---|
  | `createResizer(config, { drivers })` in the main entry; `DeepPartial<ResizeConfig>` over the defaults | 4 (merge), 6 |
  | `static fromConfig` on every shipped driver, validating its own section once | 5 (SQS entries: `validate`, D6) |
  | Optional peers imported only when selected (`RESIZE_PEER_MISSING`) | 6 (built-in table, probe, child-process tests) |
  | `FrameworkResizer` = getConfig + getModel + app logger and events + the factory | 7 |
  | Core `*Config` types; `FrameworkResizeConfig` adds `mediaModelName` | 4 (aliases kept, owner O1) |
  | Framework hosts keep the environment merge; the core merge is the only other | 4, 7 (owner O3) |

- **Gates and docs.** `npm test`, `npm run types:check`, `npm run check`, `npm run build` and `npm run smoke` pass; README, AGENTS.md, CHANGELOG, RELEASE.md, host adoption and the docs site describe the factory, drivers by name, routing and the worker list; the version is `0.3.0-rc.3` (Task 8).

## Self-review notes

- **Spec coverage.** F6's remainder and F7 map to tasks (tables above). Already done before S4: F6's host shape, `RESIZE_CONFIG_QUEUE_TIMING_CONFLICT` removal, the core-named queue entry types (S2b). Departures, each a decision: queue drivers take one backend's entries and add `backendOf` / `validate` (D6); the `Framework*` names stay as aliases (O1); `FrameworkResizeConfig` keeps `worker` beside `mediaModelName`.
- **Step scan.** Every task names its files, the tests by name with their assertions, the command and the expected result, and every existing test it changes with the new assertion. Each commit is two plain git calls.
- **Type consistency.** `carrierOf` (async, public), `RoutingTaskQueue` with `Route`, `markUnavailable` / `unavailableReason` and `verifyServicesOf` / `verifyRouteOf` (Task 2) are used in Tasks 3, 6, 7. `ProcessSections.validated` is a set of `validate` functions in D9, Task 4's `validateQueueDrivers`, Task 6 and Task 7's `config.ts`. `FrameworkResizer<D>` is a generic class with a non-generic constructor in D7 and Task 7 (checked with the repo's `tsc`). `QueueEntry`, `QueueDriver` (`backendOf`, `validate`, `fromConfig`), `DatabaseParts`, `DriverContext`, `QueueDriverContext`, `DriverRegistry` (Task 4) are the parameter types of every `fromConfig` (Task 5), `planQueueSet` and `configuredOptions` (Task 6) and `FrameworkDatabase` (Task 7). `resolveQueueEntries`, `validateQueueDrivers`, `validateSqsEntries`, `sqsBackendKey` (Task 4) feed `ProcessSections` (Task 6) and `config.ts` (Tasks 4, 7). `sharedPart` / `sharedValue` (Task 1) are the `shareQueues` cache and the conflict record (Tasks 6, 7). `CreateResizerOptions` lives in `createResizer.ts` in D7, Task 6 and the exports.
- **Review Focus:** 1 in Tasks 6 and 7; 2 in Tasks 2 and 7; 3 in Tasks 4 and 7; 4 in Task 3; 5 in Task 2; 6 in Tasks 2, 6 and 7; 7 in Task 2.
- **Round 2 consistency.** The missing-SDK reason has one channel (`markUnavailable`), read by the Dispatcher, `verify()` and the worker; no other place decides "not served". The single-backend result stays a plain backend object, so `src/framework/resizer.test.ts:753-825` checks hold (its `queue`, `models`, `sqsDriver`, issue code and `retryable`; it does not check the message). The worker builds a route only for a name it consumes, except the conservative sharing check, which builds an unserved Resizer's route only for a consumed name and only when a consumed carrier does not filter claims.
- **Proportion.** About as long as the first draft plus the review's tests; bodies are left to the implementer wherever the signatures and named tests fix them. The decisions spell out the lazy-carrier, availability, lock, merge and part rules that tests alone would not fix.

## Review changes

| Finding | Where the plan handles it |
|---|---|
| R-S4-1 / Sol C1 / Astra 1 / Opus I1 (O6 eager backends) | O6 removed; D1 (lazy carriers, isolated failures), D2 (availability probe; `:753-825` unchanged), D11, D15, D16; Task 2 tests, Task 6 peers tests, Task 7 regression (stored previews, database enqueue, database worker start, no `Lock` model); Review Focus 1 |
| R-S4-1 / Sol I1 / Astra 1 (aggregate lock requirement) | D15; Task 2 `resizer.test.ts` and worker tests; Task 7 'unused SQS entry with its SDK' test |
| R-S4-2 / Sol I2 / Astra 2 (`coordination: null`) | D9 (`coordination`); Task 6 test; Task 7 keeps `src/framework/resizer.test.ts:572` unchanged |
| R-S4-3 / Sol M1 / Astra 3 (timing cache) | D4 (Timing); Task 2 counting test; Review Focus 5 |
| R-S4-4 / Opus I2 (TS2611) | D4 (Flags): constructor `Object.defineProperty`, no field, no getter (checked with the repo's `tsc`: the getter is TS2611, the constructor form compiles); Task 2 test |
| R-S4-5 / Sol I3 / Astra question (lazy database) | D9 `ConfigSource.database()` / `eagerDatabase`; Task 6 function-config test |
| R-S4-6 / Sol I4 (code-supplied tasks) | O5 rewritten; D9 (process sections checked whenever read, `coordination` included); Task 6 test; Task 7 keeps `src/framework/resizer.test.ts:962` and `:1024` unchanged |
| R-S4-7 / Astra 4 (generic to framework options) | D7; Task 7 Interfaces and type tests |
| R-S4-8 / Sol I5 / Astra 5 / Opus I3, M1 | Task 4 transitional `backend`; `CreateResizerOptions` in `createResizer.ts` (D7); Task 1 and Task 7 lists of changed tests (`registry.test.ts:55`, `resizer.test.ts:1228`, `framework/resizer.test.ts:34,216,1122,1166,1192,1248`, `config/resize.test.ts:97,147,295-337`, `command.test.ts:189`, `resize.framework.integration.test.ts:91`, `queueIndexes.mongo.integration.test.ts:16,92`) |
| R-S4-9 / Opus M3, M4 (logger, conflict order) | D10; O4; Task 7 test |
| R-S4-10 / Opus M2 (chained git) | Global Constraints; every task's Stage and Commit steps |
| R-S4-10 / Opus M7 (docs: RoutingTaskQueue, Lock model) | Task 8 Steps 2–4 |
| R-S4-10 / Astra 8 (state invariant) | D14; Task 1 guard name |
| R-S4-10 / Astra 6 (`replacePreviews` duck check) | D6; Task 6 test |
| R-S4-10 / Astra (mixed retry, cooldown, give-back) | Task 2 worker tests |
| Opus M5 (unknown queue driver text and timing) | D9 (`validateQueueDrivers` text; object configs at construction) |
| Opus M6 (where SQS checks live) | D10, D12: SQS checks stay at file read through `validateSqsEntries` |
| Opus M8 (flaky de-dup test) | Task 3 test reworded; finished in round 2 (Sol M1) |
| Opus M9 (DoD citation) | Definition of done cites both Task 6 tests |
| Opus M10 (line hints) | Tasks 2 and 4 Files |
| Opus M11 (dynamic-import guard on framework/) | D8; Task 7 Files |
| Astra 7 (`onReset` test, retry hook) | Task 1 and Task 7 changed-test lists |

### Round 2 (Sol and Astra re-checks of revision 1)

| Finding | Where the plan handles it |
|---|---|
| R2-I1 (both): `constructor<D>` is TS1092 | D7 (generic class, non-generic constructor; checked with the repo's `tsc`); Task 7 Interfaces and type tests |
| R2-I2 (both): worker start verified each Resizer's own queue | D15 (`verifyServicesOf` / `verifyRouteOf`; worker start replaces the `verify()` loop at `src/worker.ts:196`); D1; Task 2 inverse test and `verifyServicesOf` test; Task 6 and Task 7 SDK-less own-queue tests; Review Focus 6 |
| R2-I3 (both): cold routes bypassed the sharing guard | D16 (conservative check builds the unserved route for a consumed name when a consumed carrier does not filter claims); Task 2 two-router test with its two variants; Review Focus 7 |
| R2-I4 (both): no channel for the missing-SDK reason | D2 (`markUnavailable` / `unavailableReason`, read by the Dispatcher, `verify()` and the worker); D11; Task 2 tests; Task 6 peers test asserting the package in `prewarm()` and worker errors; `:753-825` unchanged |
| R2-I5 (Sol): a host `sqs` driver skipped its own `validate` | D9 and D10 (skip by function identity); Task 4 and Task 7 override tests |
| R2-I6 (both): branded build errors lost their code and `retryable` | D13 (branded: own code, prewarm advice rule; unbranded: `RESIZE_ENQUEUE_QUEUE_FAILED`; the union's documented opening); Task 2 test with a non-listed, non-retryable code; Task 8 issues table. Superseded in round 3 (R3-b, R3-c) |
| R2-I7 (Astra): `src/prewarm.test.ts:268` | Task 2 "Existing tests this task changes" |
| R2-M1 (both): O5's eager-only claim | O5 ("What stays the same") |
| R2-M2 (both): `carrierOf` not exported | D3; Global Constraints exports; Task 2 export lists; Task 6 smoke; Task 8 README |
| R2-M3 (Astra): host-adoption prerelease paragraph | Task 8 Step 5; CHANGELOG prerelease line in Step 4 |
| R2-M4 (Sol): Task 3 counted empty polls | Task 3 test (`leases`, concurrent-claim count, no timers); `src/testHelpers/fakes.ts` |
| R2-M5 (Sol): nested partial override types | O3; D7 `PartialFrameworkResizeConfig`; Task 4 type tests; Task 7 Files; Task 8 Config reference |
| R2-M6 (Sol): timing precedence for builder routes | D4 (the router's option is the authority for builder routes; the core reads only `timingOf(resizer.tasks, name)`); D3; D16; Task 2 test with a carrier without `getTiming` |

### Round 3 (ruling R-S4-12)

| Finding | Where the plan handles it |
|---|---|
| R3-a: two validator signatures | D6 `validate(entries, ctx: { where })` is the only one; D12 and Task 4 `validateSqsEntries(entries, ctx: { where })`; D9 calls `validate(entries, { where })`; D10 names the `src/framework/config.ts:241,285` call sites |
| R3-b: branded errors keep their own `retryable` | D1; D13 (the prewarm advice rule is not applied on this path); Task 2 build-failure test |
| R3-c: closed union, `causeCode` | D13 (union unchanged; `causeCode?: string`; `RESIZE_ENQUEUE_QUEUE_FAILED` for codes outside the union; the missing lock store is `RESIZE_ENQUEUE_LOCK_FAILED` + `causeCode`); D15; Task 2 tests (custom non-union, non-retryable code); Task 8 issues table, Troubleshooting, CHANGELOG |
| R3-d: timing only in route verification | D15 (`#buildDispatcher` reads no timing; `verifyRouteOf` reads it); worker start; Task 2 tests (worker on healthy `bulk` with bad `default` timing; router `verify()` with bad own timing; plain queue); `src/resizer.test.ts:760` listed with its new assertions |
| R3-e: existing tests | Task 2 lists `src/dispatcher.test.ts:546`; `src/customDecoder.test.ts:349` unchanged (D15 shared step verifies a supplied lock store before the decoders, without a task queue too); `src/worker.test.ts:1076` unchanged |
| R3-f: paths and template | Task 7 Files `src/framework/index.ts`; Task 8 Step 1 template comment and its test |

### Round 4 (ruling R-S4-14)

| Finding | Where the plan handles it |
|---|---|
| R4-1: the timing regressions put invalid timing in `opts.getTiming` of object routes | Task 2 worker and resizer tests: the invalid timing is the object route's own (`timing: { leaseMs: 0 }`), plus a builder-route case using `opts.getTiming`; D4 unchanged |
| R4-2: `src/resizer.test.ts:783-825` changes with the timing move | Task 2 "Existing tests this task changes" lists it with exact log counts (0 after `ready()`, 1 after the invalid `resolve()` calls, 1 after `verify()`) and keeps the recovery assertion; the `:760-770` entry names the Dispatcher's error-level log |
