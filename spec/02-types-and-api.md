# 02 · Types & Public API

> Part of the [`@adaptivestone/framework-module-resize` build spec](../BUILD-SPEC.md).
> Prev: [01 · Architecture](./01-architecture.md) · Next: [03 · Identity](./03-identity.md)

The minimal app interface, the data shapes (`src/types.d.ts`), and the `Resizer`
public surface (`src/index.ts`).

---

## §4. Minimal app interface (`src/types.d.ts`) — consumed via the ambient `appInstance`

**The app is never a parameter.** The framework sets a process-wide singleton at Server
construction (`setAppInstance`, one-server-per-process **enforced** — a second Server throws)
and exports it from `@adaptivestone/framework/helpers/appInstance.js`. The module reads it
through one internal gateway — **`getApp()` in `src/app.ts`** (clear error if called before
the Server exists) — and `TMinimalResizeApp` documents the **slice** of that app the module
actually consumes. It is also the shape a test fake must satisfy: tests call
`setAppInstance(fake)` / `resetAppInstance()` (per-file isolation is free — the node:test
runner executes each test file in its own process).

```ts
export type TMinimalResizeApp = {
  getConfig(name: 'resize'): DeepPartial<ResizeConfig>;  // host overrides any field at any depth; arrays REPLACE (08 · §13)
  // Returns a Mongoose model registered by the host. At minimum:
  //  - 'Lock'       (framework built-in: acquireLock/releaseLock/waitForUnlock)
  //  - 'ResizeTask' (scaffolded into the host app; only for the Mongo transport)
  //  - the host media model, by name from config.mediaModelName
  getModel(name: string): any;
  logger: {
    info(msg: string, ...rest: unknown[]): void;
    warn(msg: string, ...rest: unknown[]): void;
    error(msg: string, ...rest: unknown[]): void;
  };
  events?: { emit(name: string, ...args: unknown[]): void };  // framework EventEmitter (app.events); observers are mirrored as `resize:<name>` — duck-typed, NOT a framework import (04 · §9)
  foldersConfig?: { [k: string]: string | undefined };  // part of the framework app shape; NOT read by the resize module (the standalone scaffold bin resolves write paths from cwd + `--out` — 08 · §12)
};
```

The framework `Lock` model contract:

```ts
Lock.acquireLock(key: string, ttlSeconds?: number): Promise<boolean>; // true if acquired
Lock.releaseLock(key: string): Promise<void>;
Lock.waitForUnlock(key: string): Promise<void>;                       // optional, may be unused
```

> **Storage is NOT on the app interface.** It is an injected strategy
> (the required `storage:` constructor option, see [05 · Transport & storage](./05-transport-and-storage.md)),
> which keeps the app contract minimal and the storage-specific options (buckets, base URL) in the
> driver rather than `ResizeConfig`. The read path does call the storage driver's **pure,
> I/O-free `publicUrl`** to build URLs, so the driver must be registered in the API process too —
> but no storage I/O is on the read path.

---

## §5. Data shapes (`src/types.d.ts`)

```ts
export type PreviewFormat = 'jpeg' | 'webp' | 'avif';

// Canonical filter bag. Host-defined semantics; the module only canonicalizes it into
// the identity. e.g. { blur: 40 }. Empty / undefined → 'none' in the identity.
export type Filters = Record<string, string | number | boolean>;

// Opaque storage locator round-tripped between the module and the active storage driver
// (05 · §10.4). `key` is always present; `bucket` is S3-specific — a filesystem/GCS/other
// driver may omit it. The module never interprets these; it passes them back to the driver.
export interface StorageRef {
  key: string;
  bucket?: string;
}

export interface Original extends StorageRef {
  format?: string;
  size?: number;
  contentType?: string;
  width?: number;   // captured at upload; backfilled by the worker if missing
  height?: number;
}

export interface Preview extends StorageRef {
  sizeKey: string;            // canonical size key — see 03 · Identity
  filters?: Filters;          // part of identity — see 03 · Identity
  requestedWidth?: number;
  requestedHeight?: number;
  actualWidth?: number;
  actualHeight?: number;
  format: PreviewFormat;
  contentType: string;
  fit?: boolean;              // true = uncropped "full"/contain variant (the `fit` token)
}

export interface MediaLike {
  id?: string;            // media id precedence: `media.id ?? String(media._id)` (06 · §17 step 4)
  _id?: { toString(): string };
  original?: Original;
  previews?: Preview[];
}

// fit:true → the uncropped variant bounded by config.maxSize (size key "fit").
// width/height present → a cropped (cover) variant. filters → keyed alternate rendering.
export interface SizeInput { width?: number; height?: number; fit?: boolean; filters?: Filters; }

export interface MissingPreview {
  sizeKey: string;
  filters?: Filters;
  requestedWidth?: number;
  requestedHeight?: number;
  format: PreviewFormat;
  fit?: boolean;
}

export interface ReadyEntry {
  sizeKey: string;
  format: PreviewFormat;
  filters?: Filters;
  url: string;
  preview?: Preview;       // present for generated previews; ABSENT for original-backed entries
  isOriginal?: boolean;    // true when `url` points at the untouched original (SVG pass-through, or "original already fits")
}

export interface ReadDecision {
  ready: ReadyEntry[];
  missing: MissingPreview[];
}
```

The host stores `original` + `previews[]` on its media document in this shape (it may add
fields; the module ignores them).

> **SVG originals are pass-through.** When `original.contentType === 'image/svg+xml'` (or
> `original.format === 'svg'`), the read path serves the original at every requested
> size/format and never resizes or enqueues — see [06 · Read & enqueue](./06-read-and-enqueue.md)
> §17 step 6. So `PreviewFormat` stays the three raster formats: SVG is only ever an
> *original*, never a *preview*. (The host owns SVG sanitization — see that step's security note.)

---

## §6. Public API (`src/index.ts`)

```ts
export { Resizer, getResizer } from './resizer.ts';   // constructor-wired; one instance per process
export { default as ResizeWorker, runResizeWorker } from './worker.ts';
export { processTask } from './resizeTask.ts';
export {
  getSizeKey, parseSizeKey, getFilterSig, getPreviewIdentity,
  calculateResizedDimensions, getImageContentType,
} from './images.ts';
export { default as defaultResizeConfig, getResizeConfig, requiredFormats } from './config/resize.ts';
// DRIVERS ARE NOT IN THE MAIN ENTRY — the uniform rule (2026-07-04): the main entry is the
// CORE only; EVERY driver lives behind its own package subpath with plain STATIC imports
// inside (no dynamic-import ceremony) and its contract in a sibling Abstract*.ts interface
// file. Bootstrap imports exactly what it uses; the main entry never resolves any driver's
// dependencies (for the AWS drivers, a missing optional-peer SDK fails LOUDLY at the host's
// own import line at bootstrap, not at the first I/O call):
//   import { MongoTransport } from '@adaptivestone/framework-module-resize/transports/mongo.js';
//   import { SqsTransport }   from '@adaptivestone/framework-module-resize/transports/sqs.js';
//   import { S3Storage }      from '@adaptivestone/framework-module-resize/storage/s3.js';
//   import { FrameworkMediaStore }   from '@adaptivestone/framework-module-resize/mediaStore/framework.js';
//   import { FrameworkLockProvider } from '@adaptivestone/framework-module-resize/locks/framework.js';
// HOUSE STYLE (user decision 2026-07-04): shipped drivers are CLASSES implementing the
// Abstract* contract interfaces, constructed with `new X(opts?)` — e.g.
// `new Resizer({ transport: new MongoTransport(), storage: new S3Storage({...}) })`.
// The contracts stay INTERFACES (structural), so a CUSTOM host driver may be a class OR a
// plain object literal — both satisfy the seam. (The core constructs the two framework
// DEFAULTS internally — omitting mediaStore/lockProvider in ResizerOptions still needs zero
// host imports. Contract types re-export from the main entry via resizer.ts:
// QueueTransport, LeasedTask, ResizeStorage, MediaStore, LockProvider.)
export type {
  QueueTransport, LeasedTask, ResizeStorage, MediaStore, LockProvider,
  Pipeline, BeforeStep, VariantStep, HookName, HookFn, HookSignatures,
  ResizerOptions, GenerateOpts,
} from './resizer.ts';   // contract types for custom-driver authors (values live at the subpaths)
export type { ResolveOpts, PrewarmOpts } from './engine.ts';  // read-path / pre-warm option types
export { default as ResizeTaskModel } from './models/ResizeTask.ts';  // BaseModel subclass; the host's scaffolded model `extends` it (Mongo transport)
export type { TResizeTask } from './models/ResizeTask.ts';            // = GetModelTypeFromClass<typeof ResizeTaskModel>
export { resizeMediaSchemaFragment } from './models/mediaFragment.ts';  // optional `as const` schema fragment the host spreads into File/Media (08 · §12)
export type * from './types.d.ts';
```

> The `ResizeTaskModel` **class** and the `ResizeWorker` command are also exposed as deep
> package subpaths (`@adaptivestone/framework-module-resize/models/ResizeTask.js` and
> `/commands/ResizeWorker.js`) so the scaffolded host files can **`extend` the model class** and
> **re-export the command** — see [08 · Scaffold](./08-config-and-scaffold.md) and the `exports`
> map in [09 · Packaging](./09-packaging-and-tests.md). The host's `src/models/ResizeTask.ts` must
> be a literal `class … extends ResizeTaskModel` (not a factory call) so the framework's
> `npm run gen` AST codegen detects it as a `BaseModel` subclass and types `getModel('ResizeTask')`.

**`Resizer` — constructor-wired, one instance per process.** All drivers are injected in ONE
visible options literal at construction (no register-call sequence, no hidden global
registries). The constructor sets the process-wide **active instance** — a second
`new Resizer(...)` **throws** (mirroring the framework's `setAppInstance`
one-server-per-process rule); `resetResizerForTests()` is the test-only escape hatch. The
worker command and module internals reach the instance via `getResizer()` (throws a clear
error if no Resizer was constructed). The host constructs it in bootstrap code that runs in
**both** the API and worker processes (e.g. the scaffolded `src/resizer.ts`, imported from
`src/server.ts` — [08 · §12](./08-config-and-scaffold.md)).

```ts
export interface ResizerOptions {
  storage: ResizeStorage;                // REQUIRED — both modes need it (05 · §10.4); missing = boot-time type/throw error
  transport?: QueueTransport;            // lazy mode only (05 · §10.1); omit for eager-only hosts (11 · Modes)
  mediaStore?: MediaStore;               // default: frameworkMediaStore (05 · §10.6)
  lockProvider?: LockProvider;           // default: frameworkLockProvider (05 · §10.6)
  pipelines?: Record<string, Pipeline>;  // initial named pipelines (04 · §8)
  hooks?: Partial<Record<HookName, HookFn | HookFn[]>>;  // initial taps (04 · §9)
}

class Resizer {
  constructor(opts: ResizerOptions);     // fills defaults; sets the active instance (throws on a second construction).
                                         // ALSO validates at RUNTIME that opts.storage is present (2026-07-05 review
                                         // fix — protects JS hosts and half-filled scaffolds with a NAMED error,
                                         // not a downstream TypeError)

  // --- incremental extension (other modules can tap in via getResizer()) ---
  hook(name: HookName, fn: HookFn): void;             // appends (04 · §9)
  registerPipeline(name: string, p: Pipeline): void;  // last-wins per name (04 · §8)

  // --- read path (host calls this from its DTO builders) ---
  async resolve(opts: {
    media: MediaLike;
    sizes: SizeInput[];
    pipeline?: string;              // selects a registered pipeline; default 'default'
    formats?: PreviewFormat[];      // default = requiredFormats(config)
    ctx?: Record<string, unknown>;  // threaded to read-path hooks; reaches pipeline steps ONLY in eager mode (04 · §8). Keys read by the engine: ctx.isOwner / ctx.isAdmin gate signedUrl originals. e.g. { entity:'event', isOwner:true }
    enqueueMissing?: boolean;       // default true
  }): Promise<{ decision: ReadDecision; output: unknown /* whatever formatPublicUrls returns */ }>;

  // --- pre-warm (queue the catalog at upload, non-blocking) — see 11 · §11.1b ---
  async prewarm(opts: {
    media: MediaLike;
    sizes: SizeInput[];
    pipeline?: string;
    formats?: PreviewFormat[];
    ctx?: Record<string, unknown>;
  }): Promise<{ enqueued: number }>;

  // --- eager mode (synchronous generate at upload; no queue/worker) — see 11 · Modes ---
  async generate(opts: {
    media: MediaLike;
    sizes: SizeInput[];
    pipeline?: string;
    formats?: PreviewFormat[];
    ctx?: Record<string, unknown>;
    persist?: boolean;              // default true → $push previews + backfill dims
  }): Promise<{ previews: Preview[] }>;
}

export function getResizer(): Resizer;        // the active instance; THROWS a clear error if none constructed
export function resetResizerForTests(): void; // TEST-ONLY (not re-exported from index.ts docs)
```

**Wiring semantics** (constructor options above):
- **Drivers are fixed at construction** — no re-registration/last-wins mutation for
  transport/storage/mediaStore/lockProvider. Swapping a driver = constructing the Resizer
  differently (tests just build fresh instances after `resetResizerForTests()`).
- `storage` is **required** (the type system + constructor enforce it — the "forgot to
  register storage" runtime degradation class is gone). `transport` is **optional**: eager-only
  hosts ([11 · Modes](./11-modes.md)) omit it; with no transport, `resolve` logs once and skips
  enqueueing (missing variants stay placeholders), and the worker **logs and exits cleanly**
  ([07 · Worker](./07-worker.md)).
- `mediaStore` / `lockProvider` omitted → the framework-backed defaults
  (`frameworkMediaStore`, `frameworkLockProvider` — [05 · §10.6](./05-transport-and-storage.md)).
  The instance always has all four drivers resolved after construction.
- `pipelines` / `hooks` seed the initial sets; `resizer.registerPipeline(name, p)` (last-wins
  per name; unknown name → empty pipeline) and `resizer.hook(name, fn)` (appends; taps run in
  registration order) allow incremental additions later — e.g. another module tapping
  observers via `getResizer().hook(...)`.

The read-path behavior of `resolve` is specified in
[06 · Read & enqueue](./06-read-and-enqueue.md); the synchronous `generate` (eager mode) in
[11 · Modes](./11-modes.md).
