# 02 · Types & Public API

> Part of the [`@adaptivestone/framework-module-resize` build spec](../BUILD-SPEC.md).
> Prev: [01 · Architecture](./01-architecture.md) · Next: [03 · Identity](./03-identity.md)

The minimal app interface, the data shapes (`src/types.d.ts`), and the `ResizeEngine`
public surface (`src/index.ts`).

---

## §4. Minimal app interface (`src/types.d.ts`)

```ts
export type TMinimalResizeApp = {
  getConfig(name: 'resize'): Partial<ResizeConfig>;
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
  foldersConfig?: { [k: string]: string | undefined };
};
```

The framework `Lock` model contract:

```ts
Lock.acquireLock(key: string, ttlSeconds?: number): Promise<boolean>; // true if acquired
Lock.releaseLock(key: string): Promise<void>;
Lock.waitForUnlock(key: string): Promise<void>;                       // optional, may be unused
```

> **Storage is NOT on the app interface.** It is a registered strategy
> (see [05 · Transport & storage](./05-transport-and-storage.md)), keeping the read
> path storage-free and the contract minimal.

---

## §5. Data shapes (`src/types.d.ts`)

```ts
export type PreviewFormat = 'jpeg' | 'webp' | 'avif';

// Canonical filter bag. Host-defined semantics; the module only canonicalizes it into
// the identity. e.g. { blur: 40 }. Empty / undefined → 'none' in the identity.
export type Filters = Record<string, string | number | boolean>;

export interface Original {
  bucket: string;
  key: string;
  format?: string;
  size?: number;
  contentType?: string;
  width?: number;   // captured at upload; backfilled by the worker if missing
  height?: number;
}

export interface Preview {
  bucket: string;
  key: string;
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
  id?: string;
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

export interface ReadyEntry { sizeKey: string; format: PreviewFormat; filters?: Filters; preview: Preview; url: string; }

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
export { default as ResizeEngine } from './engine.ts';
export { default as ResizeWorker, runResizeWorker } from './worker.ts';
export { processTask } from './resizeTask.ts';
export {
  getSizeKey, parseSizeKey, getFilterSig, getPreviewIdentity,
  calculateResizedDimensions, getImageContentType,
} from './images.ts';
export { default as defaultResizeConfig, getResizeConfig, requiredFormats } from './config/resize.ts';
export { mongoTransport } from './transports/mongo.ts';
export { sqsTransport } from './transports/sqs.ts';   // optional (lazy-loads aws sdk)
export { makeResizeTaskModel } from './models/ResizeTask.ts';  // factory the host re-exports (Mongo transport)
export type * from './types.d.ts';
```

> The `ResizeTask` model factory and the `ResizeWorker` command are also exposed as deep
> package subpaths (`@adaptivestone/framework-module-resize/models/ResizeTask.js` and
> `/commands/ResizeWorker.js`) so the scaffolded host files can re-export them — see
> [08 · Scaffold](./08-config-and-scaffold.md) and the `exports` map in
> [09 · Packaging](./09-packaging-and-tests.md).
```

`ResizeEngine` — process-wide registries (static methods over module-scope maps, like
email's `registerTemplateEngine`):

```ts
class ResizeEngine {
  // --- extension registration (call once at host bootstrap, e.g. src/server.ts) ---
  static hook(name: HookName, fn: HookFn): void;             // cross-cutting hooks (04)
  static registerPipeline(name: string, p: Pipeline): void;  // per-media-type processing (04)
  static registerQueueTransport(t: QueueTransport): void;    // exactly one active (05)
  static registerStorage(s: ResizeStorage): void;            // exactly one active (05)

  // --- read path (host calls this from its DTO builders) ---
  static async resolve(app: TMinimalResizeApp, opts: {
    media: MediaLike;
    sizes: SizeInput[];
    pipeline?: string;              // selects a registered pipeline; default 'default'
    formats?: PreviewFormat[];      // default = requiredFormats(config)
    publicURL?: string;             // default from config (cdnURL ?? publicURL)
    ctx?: Record<string, unknown>;  // threaded to hooks + steps (e.g. { entity:'event', isOwner:true })
    enqueueMissing?: boolean;       // default true
  }): Promise<{ decision: ReadDecision; output: unknown /* whatever formatPublicUrls returns */ }>;

  // --- eager mode (synchronous generate at upload; no queue/worker) — see 11 · Modes ---
  static async generate(app: TMinimalResizeApp, opts: {
    media: MediaLike;
    sizes: SizeInput[];
    pipeline?: string;
    formats?: PreviewFormat[];
    ctx?: Record<string, unknown>;
    persist?: boolean;              // default true → $push previews + backfill dims
  }): Promise<{ previews: Preview[] }>;
}
```

The read-path behavior of `resolve` is specified in
[06 · Read & enqueue](./06-read-and-enqueue.md); the synchronous `generate` (eager mode) in
[11 · Modes](./11-modes.md).
