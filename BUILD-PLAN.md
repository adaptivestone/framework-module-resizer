# Build plan & handoff — `@adaptivestone/framework-module-resize`

> **Purpose:** the live implementation status + how to continue. The **design** source of
> truth is [`BUILD-SPEC.md`](./BUILD-SPEC.md) + [`spec/`](./spec/); this file tracks *what is
> built* and *how to build the rest*. Keep the status table below in sync as modules land.
>
> **Last updated:** 2026-06-28.

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
| 3 | Config | `src/config/resize.ts` | spec/08 §13 | ✅ done (TDD) | 8 |
| 4 | Registry + hooks | `src/registry.ts`, `src/hooks.ts` | spec/04 | ⬜ next | — |
| 5 | Engine read-path + enqueue | `src/engine.ts`, `src/enqueue.ts` | spec/06, spec/02 | ⬜ | — |
| 6 | Models | `src/models/ResizeTask.ts`, `src/models/mediaFragment.ts` | spec/08 §12 | ⬜ | — |
| 7 | Transports | `src/transports/mongo.ts`, `src/transports/sqs.ts` | spec/05 | ⬜ | — |
| 8 | Worker | `src/worker.ts`, `src/resizeTask.ts`, `src/commands/ResizeWorker.ts` | spec/07, spec/11 | ⬜ | — |
| 9 | Scaffold | `src/scaffold/command.ts` + `templates/` | spec/08 §12, spec/09 §3 | ⬜ | — |
| 10 | Public entry | `src/index.ts` | spec/02 §6 | ⬜ | — |

**Suite total so far: 39 tests, all green.** Full target test plan is spec/09 §20.

---

## Remaining build order (dependency-first)

Each step lists the spec section to implement against and the key behaviors to test.

**4 — `src/registry.ts` + `src/hooks.ts` (spec/04).** Pure logic, no infra.
- registry: module-scope maps for the single-active **transport** + **storage**
  (`register*`/`getActive*`; last-wins; `getActive*` returns the value or `undefined`, never
  throws) and named **pipelines** (`registerPipeline`/`getPipeline`; last-wins per name;
  unknown name → empty pipeline `{}`). Define `Pipeline`/`BeforeStep`/`VariantStep` here.
- hooks: `hook(name, fn)` appends; `runWaterfall(app,name,value,ctx)` threads value through
  taps in registration order, **guarding each tap** (throw → log + skip, keep prior value);
  `runObservers(app,name,...args)` fires `app.events?.emit('resize:'+name, …)` (fire-and-forget)
  then awaits each typed tap **error-isolated**.

**5 — `src/engine.ts` + `src/enqueue.ts` (spec/06, spec/02 §6).**
- `enqueue`: dedup by `getPreviewIdentity`; per-identity **dispatch lock**
  (`resize_dispatch:${mediaId}:${identity}`, TTL `config.queue.lockTtlMs.dispatch`); only
  lock-winners survive; `transport.enqueue`; on throw **or** `taskId===null` release the
  survivors' locks; never throw to caller.
- `ResizeEngine.resolve`: the read-path algorithm (spec/06 §17) incl. SVG pass-through
  (`isOriginal:true`, `preview` omitted), "original already fits" fast-path, URLs via
  `storage.publicUrl(app, ref)` (driver required — log + safe-empty if absent), `runWaterfall`
  for `resolveSizes`/`beforeEnqueue`/`formatPublicUrls`, and the **never-throw** wrapper.
  `ResizeEngine` also holds the static registration methods (delegates to registry/hooks).

**6 — `src/models/ResizeTask.ts` + `src/models/mediaFragment.ts` (spec/08 §12).**
- `ResizeTaskModel extends BaseModel` (framework) with `static get modelSchema()` (fields in
  spec/08), `static initHooks(schema)` (the five indexes), overridable `static fileRef='File'`
  (schema uses `ref: this.fileRef`). Export `type TResizeTask = GetModelTypeFromClass<typeof
  ResizeTaskModel>`. Must stay a literal `class … extends` so the framework's `npm run gen`
  AST codegen types `getModel('ResizeTask')`.
- `mediaFragment.ts`: optional `as const` POJO schema fragment (String/Number/Boolean globals,
  **no mongoose import**) the host spreads into File/Media.

**7 — `src/transports/mongo.ts` + `src/transports/sqs.ts` (spec/05).**
- `QueueTransport`/`LeasedTask`/`ResizeStorage`/`StorageRef` interfaces (StorageRef already in
  types.d.ts). Mongo: lease (fencing `leaseToken`) / complete / fail (backoff→dead-letter) /
  renew / dead-letter sweep (per-row `findOneAndUpdate` so one worker fires the observer).
  `mongoTransport` = option-less singleton. SQS: `sqsTransport({queueUrl,region?,endpoint?})`
  **factory**, lazy-loads `@aws-sdk/client-sqs` + `sqs-consumer`. Test mongo against
  `mongodb-memory-server`; SQS against mocked SDK.

**8 — `src/worker.ts` + `src/resizeTask.ts` + `src/commands/ResizeWorker.ts` (spec/07, spec/11).**
- `runResizeWorker(app)` (sharp globals, transport loop) + `processTask` (download once →
  EXIF display-orientation math → beforeSteps → decode-once `base.clone()` per variant bounded
  by `config.worker.concurrency` → rotate/resize/colorspace/sharpen/variantSteps/flatten/encode
  → `storage.upload({…,visibility:'public'})` persist returned ref → single `$push` → locks →
  poison-variant guard). Command is an `AbstractCommand` with `isShouldInitModels=true`.
  `ResizeEngine.generate` (eager mode, spec/11) shares this core.

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

---

## Prior review (still applies)

The pre-build deep review's punch-list (peerDep, EXIF display-orientation, `actualWidth` from
encoded `info`, alpha-flatten, animation cap, poison-variant throw, `ref:this.fileRef`,
observers mirrored to `app.events`, optional media-schema fragment, sharpen/mozjpeg/chroma,
colorspace order + ICC note, decode-once + sharp globals) is **already folded into the spec**.
Implement step 8 (worker) against spec/07 as written — those fixes are in it.
