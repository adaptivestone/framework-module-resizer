# Build plan & handoff — `@adaptivestone/framework-module-resize`

> **Purpose:** the live implementation status + how to continue. The **design** source of
> truth is [`BUILD-SPEC.md`](./BUILD-SPEC.md) + [`spec/`](./spec/); this file tracks *what is
> built* and *how to build the rest*. Keep the status table below in sync as modules land.
>
> **Last updated:** 2026-07-04.

---

## How this module is built

- **Mirror** the sibling module `@adaptivestone/framework-module-email` for all packaging
  conventions (ESM-only, TypeScript source authored with `.ts` import specifiers, `tsc`
  rewrites them to `.js`, publishes only `dist`, tests via the built-in `node:test`).
- **TDD is mandatory** for every module with logic (see `skills/test-driven-development` /
  the project's TDD discipline): write the test first, watch it fail (RED), implement the
  minimum to pass (GREEN), refactor. Pure-logic modules (`images`, `config`, `registry`,
  `hooks`, `engine`, `enqueue`) need no sharp/mongo. `transports`/`worker`/`models` use
  `mongodb-memory-server`; `worker`/`resizeTask` use real `sharp` on tiny fixtures.
- **Definition of done per module:** its `*.test.ts` is green **and** `npm run types:check`
  (tsc) is clean **and** `npm run check` (biome) is clean. Never mark done otherwise.

### Commands
```bash
npm test                      # node --test (type-stripped .ts) — whole suite, discovery-based
node --test src/images.test.ts   # one file while iterating
npm run types:check           # tsc --noEmit
npm run check                 # biome check        (npm run check:fix to auto-format)
npm run build                 # preBuild → tsc → postBuild (emits dist/)
```

### Install notes (environment-specific)
- Install with `MONGOMS_DISABLE_POSTINSTALL=1 npm install` — defers the mongod binary
  download to first test run (works around the sandbox's allow-scripts gate). `sharp` 0.34
  needs no install script: it resolves prebuilt `@img/sharp-*` platform packages.
- Peer deps (`@adaptivestone/framework`, `mongoose`) are also listed as **devDependencies**
  so local build/tests can resolve `BaseModel`/mongoose. `npm v7+` does not auto-install peers.

### Pinned environment (verified working)
| Thing | Version | Notes |
|---|---|---|
| Node (dev) | 26.3.1 | `engines` requires `>=24.0.0` (matches framework v5) |
| TypeScript | `7.0.1-rc` | the Go-native "Corsa" compiler; `tsc` bin works as before |
| `@adaptivestone/framework` | ^5.0.0 (5.0.1) | peer + dev |
| mongoose | ^9.0.0 | peer + dev |
| mongodb-memory-server | ^11.0.0 | dev (framework's peerOptional) |
| sharp | ^0.34.0 (0.34.5) | dep; vips 8.17.3 |
| deepmerge | ^4.3.1 | dep; config merge |
| biome | ^2.4.9 (2.5.1) | dev |

---

## Status

| # | Module | Files | Drives from | Status | Tests |
|---|--------|-------|-------------|--------|-------|
| 1 | Foundation | `package.json`, `tsconfig.json`, `biome.json`, `preBuild.ts`, `postBuild.ts`, `.gitignore`, `.npmignore`, `LICENSE` | spec/09 | ✅ done | build green |
| 1 | Type contract | `src/types.d.ts` | spec/02, spec/08 | ✅ done | — |
| 2 | Identity helpers | `src/images.ts` | spec/03 | ✅ done (TDD) | 31 |
| 3 | Config | `src/config/resize.ts` | spec/08 §13 | ✅ done (TDD) | 9 |
| 3 | Ambient app gateway | `src/app.ts` | spec/02 §4 | ✅ done (TDD) | 2 |
| 4 | Resizer class + hook bus + defaulted seams | `src/resizer.ts`, `src/mediaStore/{AbstractMediaStore,framework}.ts`, `src/locks/{AbstractLockProvider,framework}.ts` | spec/02 §6, spec/04, spec/05 §10.6 | ✅ done (TDD) | 32 |
| 5 | Engine read-path + enqueue | `src/engine.ts`, `src/enqueue.ts` | spec/06, spec/02 | ✅ done (TDD) | 31 (23 engine + 8 enqueue) |
| 6 | Models | `src/models/ResizeTask.ts`, `src/models/mediaFragment.ts` | spec/08 §12 | ✅ done (TDD) | 24 (23 + 1 skip) |
| 7 | Transports + storage driver | `src/transports/{AbstractTransport,mongo,sqs}.ts`, `src/storage/{AbstractStorage,s3}.ts` | spec/05 | ✅ done (TDD) | 36 (17 mongo + 7 sqs + 12 s3) |
| 8 | Worker | `src/worker.ts`, `src/resizeTask.ts`, `src/commands/ResizeWorker.ts` | spec/07, spec/11 | ✅ done (TDD, worktree build + squash-merge) | 29 |
| 9 | Scaffold | `src/scaffold/command.ts` + `templates/` | spec/08 §12, spec/09 §3 | ⬜ | — |
| 10 | Public entry | `src/index.ts` | spec/02 §6 | ⬜ | — |

**Suite total so far: 206 tests, all green (205 pass + 1 skipped live round-trip).** Full target test plan is spec/09 §20.

---

## Remaining build order (dependency-first)

Each step lists the spec section to implement against and the key behaviors to test.

**4 — `src/resizer.ts` + `src/mediaStore.ts` + `src/locks.ts` (spec/02 §6, spec/04, spec/05 §10.6).** Pure logic, no infra.
- **`Resizer` class** (spec/02 §6): constructor takes `ResizerOptions` (`storage` REQUIRED;
  `transport?`; `mediaStore?`/`lockProvider?` default to the framework drivers; `pipelines?`/
  `hooks?` seed the initial sets); drivers fixed at construction (instance fields); the
  constructor sets the **one-per-process active-instance slot** (second construction THROWS,
  mirroring setAppInstance); `getResizer()` returns it or throws a clear error;
  `resetResizerForTests()` clears it. Instance methods: `hook(name, fn)` (appends),
  `registerPipeline(name, p)` (last-wins per name; unknown → frozen empty `{}`), and the
  hook bus — `runWaterfall(name,value,ctx)` (guards each tap: throw → log + keep prior value)
  and `runObservers(name,...args)` (guarded `events?.emit('resize:'+name,…)` mirror first,
  then each tap awaited, error-isolated); logger/events via `getApp()` at call time. The
  `QueueTransport`/`LeasedTask`/`ResizeStorage`/`Pipeline`/`BeforeStep`/`VariantStep`
  interfaces live here (or a small `interfaces.ts` if cycles demand). `resolve`/`generate`
  method bodies come in step 5 (stubs may throw 'not implemented' until then).
- **defaulted seams** (spec/05 §10.6, unchanged): `MediaStore` + `frameworkMediaStore` (load via
  `getModel(config.mediaModelName)`; `appendPreviews` = ONE `findByIdAndUpdate` `$push {$each}`
  + optional `$set` dims) and `LockProvider` + `frameworkLockProvider` (framework `Lock`,
  ms→seconds conversion inside). Test with a fake `app.getModel` via setAppInstance.
- 2026-07-04 review fix (uniform driver layout): mediaStore/locks split into Abstract contract + framework driver subpath entries; mongo imports its contract from AbstractTransport.

**5 — `src/engine.ts` + `src/enqueue.ts` (spec/06, spec/02 §6).**
- `enqueue`: dedup by `getPreviewIdentity`; per-identity **dispatch lock**
  (`resize_dispatch:${mediaId}:${identity}`, TTL `config.queue.lockTtlMs.dispatch`); only
  lock-winners survive; `transport.enqueue`; on throw **or** `taskId===null` release the
  survivors' locks; never throw to caller.
- `resizer.resolve`: the read-path algorithm (spec/06 §17) incl. SVG pass-through
  (`isOriginal:true`, `preview` omitted), "original already fits" fast-path, URLs via
  `this.storage.publicUrl(ref)` (always present — required option), no-transport → log once +
  skip enqueue, `runWaterfall` for `resolveSizes`/`beforeEnqueue`/`formatPublicUrls`, and the
  **never-throw** wrapper. Implemented in `src/engine.ts`, called by the `Resizer` methods.

**6 — `src/models/ResizeTask.ts` + `src/models/mediaFragment.ts` (spec/08 §12).**
- `ResizeTaskModel extends BaseModel` (framework) with `static get modelSchema()` (fields in
  spec/08), `static initHooks(schema)` (the five indexes), overridable `static fileRef='File'`
  (schema uses `ref: this.fileRef`). Export `type TResizeTask = GetModelTypeFromClass<typeof
  ResizeTaskModel>`. Must stay a literal `class … extends` so the framework's `npm run gen`
  AST codegen types `getModel('ResizeTask')`.
- `mediaFragment.ts`: optional `as const` POJO schema fragment (String/Number/Boolean globals,
  **no mongoose import**) the host spreads into File/Media.

**7 — `src/transports/mongo.ts` + `src/transports/sqs.ts` + `src/storage/s3.ts` (spec/05).**
- `QueueTransport`/`LeasedTask`/`ResizeStorage`/`StorageRef` interfaces (StorageRef already in
  types.d.ts). Mongo: lease (fencing `leaseToken`) / complete / fail (backoff→dead-letter) /
  renew / dead-letter sweep (per-row `findOneAndUpdate` so one worker fires the observer).
  `mongoTransport` = option-less singleton. SQS: `sqsTransport({queueUrl,region?,endpoint?})`
  **factory**, lazy-loads `@aws-sdk/client-sqs` + `sqs-consumer`. Test mongo against
  `mongodb-memory-server`; SQS against mocked SDK.
- `s3Storage({bucketPublic,bucketPrivate?,publicUrl?,region?,endpoint?,forcePathStyle?})`
  **factory** (spec/05 §10.5): upload routes by `visibility` (no per-object ACL), pure
  `publicUrl` string-building (3 URL forms), presigner-backed `signedUrl`; lazy-loads
  `@aws-sdk/client-s3`/`@aws-sdk/s3-request-presigner`. Test against mocked SDK.
- 2026-07-04 review fix: `_setSdkForTests` seams removed; `client?` factory option (spec/05) is the injection point.
- 2026-07-04 review fix 2: drivers are subpath-only entries with STATIC SDK imports (no dynamic import()); contracts split into transports/AbstractTransport.ts + storage/AbstractStorage.ts (interfaces, re-exported from resizer.ts).
- 2026-07-04 review fix 4 (house style): drivers converted to classes — MongoTransport/SqsTransport/S3Storage/FrameworkMediaStore/FrameworkLockProvider, exported directly; Resizer builds defaults via new Framework*().

**8 — `src/worker.ts` + `src/resizeTask.ts` + `src/commands/ResizeWorker.ts` (spec/07, spec/11).**
- `runResizeWorker()` (sharp globals, transport loop) + `processTask` (download once →
  EXIF display-orientation math → beforeSteps → decode-once `base.clone()` per variant bounded
  by `config.worker.concurrency` → rotate/resize/colorspace/sharpen/variantSteps/flatten/encode
  → `storage.upload({…,visibility:'public'})` persist returned ref → single `$push` → locks →
  poison-variant guard). Command is an `AbstractCommand` with `isShouldInitModels=true`.
  `resizer.generate` (eager mode, spec/11) shares this core.
- 2026-07-04 review fix: generic internal utilities deduped into src/helpers/ (guards/random/sleep/concurrency).

**9 — `src/scaffold/command.ts` + `templates/` (spec/08 §12, spec/09 §3).**
- `resize-scaffold` package bin (shebang). Emits the `extends ResizeTaskModel` model shim, the
  command re-export, and an editable `src/config/resize.ts`; `--check`/`--eject`/`--force`/
  `--out`. Resolves paths from `process.cwd()`. Templates copied to dist by `postBuild.ts`.

**10 — `src/index.ts` (spec/02 §6).** Re-export the public surface exactly as listed there.

---

## Design decisions made during the build (deltas folded into the spec)

These were decided while implementing and are already reflected in `BUILD-SPEC.md`/`spec/` +
`src/types.d.ts`. Listed here so a reviewer sees them in one place.

1. **Driver-owned storage/transport options.** `bucketPublic`/`bucketPrivate`/`publicURL`/
   `cdnURL`/`sqs` were **removed from `ResizeConfig`**. The storage driver (host closure) owns
   buckets + base URL; `sqsTransport` is a factory taking `{queueUrl,region,endpoint}`;
   `mongoTransport` needs none. Rationale: storage is pluggable, so the core must not encode an
   S3-bucket shape. (`bucketPrivate` was dead config — originals carry `original.bucket`.)
2. **Storage interface** (spec/05 §10.4): `upload({key,body,contentType,visibility})` → returns
   a `StorageRef` to persist (driver picks the bucket); `publicUrl` is now **required + pure
   (no I/O)**; `download`/`signedUrl` take `StorageRef`. The read path therefore **requires** a
   registered storage for `publicUrl` (no longer "storage-free") — `resolve` logs + returns the
   safe-empty decision if none is registered.
3. **`StorageRef = { key: string; bucket?: string }`** (types.d.ts). `Original`/`Preview`
   `extends StorageRef` (bucket optional → non-S3 drivers omit it).
4. **Grouped core config** into `encode{}` / `limits{}` / `queue{}` / `worker{}` (e.g.
   `config.queue.maxAttempts`, `config.worker.concurrency`, `config.encode.quality`,
   `config.limits.inputPixels`). Only `mediaModelName` is host-required.
5. **`DeepPartial<T>`** added (types.d.ts). `getConfig('resize')` returns
   `DeepPartial<ResizeConfig>` so a host overrides one nested knob without restating the
   sub-object; arrays stay whole (they REPLACE via `getResizeConfig`'s `arrayMerge`).
6. `defaultResizeConfig` is typed `Omit<ResizeConfig,'mediaModelName'>` so the compiler
   enforces a default for every tunable.
7. **Shipped `s3Storage` driver (2026-07-04).** Storage now mirrors the queue seam: abstract
   interface + shipped drivers (v1: S3; filesystem/GCS/R2 possible later), instead of
   interface-only with a docs example. `s3Storage(opts)` factory per spec/05 §10.5. Custom
   backends remain host-implemented against `ResizeStorage`. Driver-abstraction direction
   confirmed by the user: core = resize logic only; every integration (storage, queue, …)
   must stay swappable.
8. **AWS deps are optional PEERS, not `optionalDependencies` (2026-07-04).** npm installs
   `optionalDependencies` by default, which forced the SQS SDK onto every host. Moved
   `@aws-sdk/client-sqs`/`sqs-consumer` (+ new `@aws-sdk/client-s3`/`s3-request-presigner`)
   to `peerDependencies` + `peerDependenciesMeta:{optional:true}`; also added as devDeps for
   local tests. Dynamic `import()` in the drivers stays the runtime guard.
9. **MediaStore + LockProvider seams (2026-07-04).** The last two DB touchpoints became
   registered strategies (spec/05 §10.6) with framework-backed defaults active out of the box
   (`frameworkMediaStore`, `frameworkLockProvider`) — the core is now fully DB-free; a host can
   swap the media persistence (other DB/ORM) and the locks (Redis) without touching the module.
   Worker/enqueue/generate now speak `mediaStore.load/appendPreviews` + `lockProvider.acquire/release`.
   User direction: core = main resize logic only; every integration abstract, multiple shipped
   drivers over time.
10. **AST-codegen compliance VERIFIED against framework v5 source (2026-07-04).** `npm run gen`
    is pure AST (oxc-parser) and resolves bare-package `extends` ancestors via
    `createRequire().resolve()` (`codegen/astModel.ts`) → the scaffolded
    `class ResizeTask extends ResizeTaskModel {}` is detected and fully typed (inherited
    `modelSchema` included). Commands are never AST-parsed → re-export shim safe. No module
    auto-discovery exists → host shims are the only integration path (as designed). Package
    obligations, all already satisfied: framework + mongoose as **peerDeps** (single-copy
    dedupe for `server.ts:423` `instanceof BaseModel` and the mongoose singleton in
    `BaseModel.ts`), `exports` subpaths, `declaration:true`, literal `extends BaseModel`
    (no mixin/factory). Spec §22.7 + 01 §2.3/§16 now carve out the one deliberate framework
    import (`src/models/ResizeTask.ts`). Optional FRAMEWORK-side improvements (our repo, not
    blockers): duck-typed brand check instead of nominal `instanceof` at `server.ts:423`;
    opt-in `modules:[…]` extra scan roots in `folderConfig` to eliminate host shims entirely;
    a throwing `getAppInstance()` getter next to `appInstance` in `helpers/appInstance.ts`
    (framework-side "not initialized" guard for every consumer — this module keeps `src/app.ts`
    for the `TMinimalResizeApp` type-slice cast either way, but its guard then becomes redundant).
11. **The app is ambient — no `app` parameter anywhere (2026-07-04).** The framework exports a
    process-wide `appInstance` singleton (`helpers/appInstance.js`, set at Server construction,
    one-server-per-process ENFORCED, `setAppInstance`/`resetAppInstance` test hooks; present in
    published 5.0.1). The module reads it through ONE gateway — `src/app.ts` `getApp()` (clear
    error before Server exists) — so `resolve(opts)`, `generate(opts)`, `runResizeWorker()`,
    `getResizeConfig()` and every driver method (`enqueue(task)`, `download(ref)`,
    `load(mediaId)`, `acquire(key,ttlMs)`, …) lost their `app` argument. `TMinimalResizeApp`
    remains as the documented SLICE getApp() returns + the test-fake shape. Framework import
    surface = exactly 2 files (`src/app.ts`, `src/models/ResizeTask.ts`). Tests install fakes
    via `setAppInstance` (node:test = per-file process isolation). Cost accepted: a duplicated
    framework copy now also breaks `appInstance` (peer-dep single-copy was already mandatory).
    Added `@types/express` devDep (framework's d.ts graph needs it once we import its helpers).
13. **House style: drivers are CLASSES (2026-07-04, user decision, step-7 review round 5).**
    Shipped drivers are `class X implements <Abstract contract>` exported directly (no factory
    wrappers): `MongoTransport` (option-less `new MongoTransport()`), `SqsTransport(opts)`,
    `S3Storage(opts)`, `FrameworkMediaStore`, `FrameworkLockProvider`. Resizer defaults become
    `opts.mediaStore ?? new FrameworkMediaStore()` etc. Contracts STAY interfaces (custom host
    drivers may be classes OR literals — the seam is structural). Constructors cheap +
    synchronous; a driver needing async setup adds `static async init(opts)` (none do today).
    Options interfaces (`SqsTransportOptions`, `S3StorageOptions` incl. `client?`) unchanged.
12a. **Uniform driver-entry rule (2026-07-04, user decision, step-7 review rounds 3–4).** The
    main entry is the CORE only; EVERY driver (mongo/sqs transports, s3 storage, framework
    mediaStore/lockProvider) is a package **subpath entry** with plain **static imports**
    (no dynamic `import()` anywhere) and its contract in a sibling `Abstract*.ts` interface
    file (interfaces, not abstract classes — drivers are object literals). Layout:
    `transports/{AbstractTransport,mongo,sqs}.ts`, `storage/{AbstractStorage,s3}.ts`,
    `mediaStore/{AbstractMediaStore,framework}.ts`, `locks/{AbstractLockProvider,framework}.ts`.
    Contract types re-export from the main entry via resizer.ts; exports map lists every
    driver subpath; the core imports the two framework defaults internally.
12. **Constructor-wired public API (2026-07-04, user decision).** `ResizeEngine` static
    registries → **`new Resizer(opts)`**: all drivers in ONE visible options literal, fixed at
    construction; `storage` REQUIRED (boot-time enforcement kills the "forgot to register
    storage" runtime degradation), `transport` optional (eager-only hosts omit it);
    `mediaStore`/`lockProvider` default to the framework drivers when omitted; `pipelines`/
    `hooks` seed initial sets, `resizer.hook`/`resizer.registerPipeline` for late additions.
    One instance per process: constructor sets the active slot (second construction throws,
    mirroring setAppInstance); worker + late taps use `getResizer()`. Scaffold gains an
    editable `src/resizer.ts` construction-site template. Step 4 reworked accordingly
    (registry.ts + hooks.ts fold into the Resizer class).

---

## Prior review (still applies)

The pre-build deep review's punch-list (peerDep, EXIF display-orientation, `actualWidth` from
encoded `info`, alpha-flatten, animation cap, poison-variant throw, `ref:this.fileRef`,
observers mirrored to `app.events`, optional media-schema fragment, sharpen/mozjpeg/chroma,
colorspace order + ICC note, decode-once + sharp globals) is **already folded into the spec**.
Implement step 8 (worker) against spec/07 as written — those fixes are in it.
