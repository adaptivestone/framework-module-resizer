// Hand-authored public types for @adaptivestone/framework-module-resize.
// This file is copied verbatim into dist by postBuild.ts (tsc does not emit it),
// so it MUST stay dependency-free: no imports of source (.ts) modules and no
// runtime imports. Source-coupled types (Pipeline, BeforeStep, VariantStep,
// QueueTransport, ResizeStorage, MediaStore, LockStore, HookName, HookFn)
// live next to their code.

// Recursive partial for environment-specific config overrides. Arrays stay whole because
// the framework replaces them while merging resize.ts with resize.<NODE_ENV>.ts.
export type DeepPartial<T> = T extends readonly (infer _U)[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

// ---------------------------------------------------------------------------
// Logging and events a Resizer is given (the framework adapter passes the app's own).
// ---------------------------------------------------------------------------

export interface ResizeLogger {
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
}

export interface ResizeEventBus {
  emit(name: string, ...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

// Sharp format ids are deliberately open strings. A host using a custom libvips build can
// enable additional input/output formats in config without changing this package.
export type PreviewFormat = string;
export type OriginalFormat = string;

// Canonical filter bag. Host-defined semantics; the module only canonicalizes it
// into the identity. e.g. { blur: 40 }. Empty / undefined → 'none' in the identity.
export type Filters = Record<string, string | number | boolean>;

// A JSON-compatible locator owned and validated by the active storage driver.
export type StorageRef = unknown;

export interface Original {
  storageRef: StorageRef;
  format?: string;
  size?: number;
  contentType?: string;
  width?: number; // captured at upload; backfilled by the worker if missing
  height?: number;
}

export interface UploadOriginalOpts {
  body: Buffer | Uint8Array;
  visibility: 'public' | 'private';
  namespace?: string;
}

// Which Resizer and pipeline rendered a preview. Part of the preview identity, so different
// renderings of the same media at the same size never share a stored preview.
export interface PreviewScope {
  resizer: string; // Resizer name
  pipeline: string; // pipeline name
}

export interface Preview {
  storageRef: StorageRef;
  resizer?: string; // Resizer that generated it; absent → 'default'
  pipeline?: string; // pipeline that generated it; absent → 'default'
  sizeKey: string; // canonical size key — see 03 · Identity
  filters?: Filters; // part of identity — see 03 · Identity
  requestedWidth?: number;
  requestedHeight?: number;
  actualWidth?: number;
  actualHeight?: number;
  format: PreviewFormat;
  contentType: string;
  fit?: boolean; // true = uncropped "full"/contain variant (the `fit` token)
}

export interface MediaLike {
  id?: string; // media id precedence: `media.id ?? String(media._id)`
  _id?: { toString(): string };
  original?: Original;
  previews?: Preview[];
}

// fit:true → the uncropped variant bounded by config.maxSize (size key "fit").
// width/height present → a cropped (cover) variant. filters → keyed alternate rendering.
export interface SizeInput {
  width?: number;
  height?: number;
  fit?: boolean;
  filters?: Filters;
}

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
  preview?: Preview; // present for generated previews; ABSENT for original-backed entries
  isOriginal?: boolean; // true when `url` points at the untouched original
  contentType?: string; // preview.contentType, or original.contentType when isOriginal
}

export interface ReadDecision {
  ready: ReadyEntry[];
  missing: MissingPreview[];
}

export type PrewarmStatus =
  | 'ready'
  | 'accepted'
  | 'not-required'
  | 'incomplete';

export interface EnqueueReceipt {
  taskId: string;
  previews: MissingPreview[];
}

export interface EnqueueIssue {
  code:
    | 'RESIZE_ENQUEUE_NO_ORIGINAL'
    | 'RESIZE_ENQUEUE_NO_TRANSPORT'
    | 'RESIZE_ENQUEUE_LOCK_CONTENDED'
    | 'RESIZE_ENQUEUE_LOCK_FAILED'
    | 'RESIZE_ENQUEUE_TRANSPORT_FAILED'
    | 'RESIZE_ENQUEUE_UNCONFIRMED'
    | 'RESIZE_ENQUEUE_CONFIRM_FAILED'
    | 'RESIZE_ENQUEUE_VARIANT_CONFLICT'
    | 'RESIZE_ENQUEUE_INTERNAL_ERROR'; // prewarm caught an unexpected error (see message)
  message: string;
  retryable: boolean;
  previews: MissingPreview[];
}

// What prewarm() reports for every requested variant. ready / accepted / notRequired / unconfirmed
// split the requested catalog; `tasks` holds the transport receipts; `issues` say why a variant is
// unconfirmed and whether a retry can help.
export interface PrewarmResult {
  status: PrewarmStatus;
  reason?: 'empty-request' | 'filtered';
  requested: MissingPreview[];
  ready: MissingPreview[];
  accepted: MissingPreview[];
  notRequired: MissingPreview[];
  unconfirmed: MissingPreview[];
  tasks: EnqueueReceipt[];
  issues: EnqueueIssue[];
}

// Generic `<picture>` map produced by `formatPictureUrls` (0.2). A convenience — not
// "the" host contract. `sizeKey` is whatever identity already is (`720x720`, `620w`, `fit`).
export interface PictureUrls {
  mediaType?: string;
  id?: string;
  sizes: {
    [sizeKey: string]: {
      [format: string]: { url: string; contentType?: string };
    };
  };
}

// ---------------------------------------------------------------------------
// Config (the framework returns the fully resolved value from app.getConfig('resize'))
//
// MODULE behavior only. Storage-specific options (buckets, base URL, signed-URL
// settings) live in the storage driver; transport-specific options (SQS queue URL,
// region) live in the transport driver — both drivers are passed to the Resizer
// constructor (see 05). The core config never knows what a "bucket" or "queue URL" is, so a new
// storage/transport driver is self-contained and the module never changes.
// ---------------------------------------------------------------------------

export interface ResizeConfig {
  formats: PreviewFormat[]; // generated output formats, e.g. ['jpeg','webp','avif']
  upload: {
    maxBytes: number;
    formats: OriginalFormat[];
  };
  maxSize: { width: number; height: number }; // default { 2000, 1200 } (the `fit` cap)
  animated: boolean; // default false — true keeps GIF/WebP frames

  // Options are passed to sharp.toFormat(format, options). Keys are format ids, so hosts with
  // additional libvips codecs can configure them without a module code change.
  encode: {
    formats: Record<string, Record<string, unknown>>;
    sharpen: { cover: boolean; fit: boolean } | false;
    flatten: { formats: string[]; background: string };
  };

  // Decode/decompression-bomb guards.
  limits: {
    inputPixels: number; // default 268402689 — sharp limitInputPixels (decoder bomb guard)
    sourcePixels: number; // default 50_000_000 — rejected BEFORE decode (width*height*frames)
    resultDimension: number; // default 5000 — clamp on the cover branch
    animationFrames: number; // default 64 — cap decoded frames (animation-bomb guard)
    processingTimeoutSeconds: number; // default 30 — Sharp native processing timeout
  };

  // Variants processed in parallel per queued task or generate() call. Default 4; keep
  // concurrency × the worker's Sharp concurrency ≈ CPU cores.
  concurrency: number;
}

// Queue timing and lock TTLs: options of the queue transport (MongoTransport takes all of them;
// the framework config file's `queue` section feeds createFrameworkMongoTransport()).
export interface QueueTimingOptions {
  lockTtlMs: { dispatch: number; worker: number }; // worker must be ≤ leaseMs
  leaseMs: number; // default 60000 — the heartbeat renews at leaseMs / 2
  retryBackoffMs: { base: number; max: number }; // default { base: 5000, max: 300000 }
  maxAttempts: number; // default 5 — deliveries before dead-letter (every lease counts, incl. reclaims)
  idlePollMs: number; // default 1000 — sleep after an empty poll
  taskTimeoutMs: number; // default 600000 — a task running longer is failed
}

// The framework worker command's settings (the config file's `worker` section).
export interface FrameworkWorkerConfig {
  enabled: boolean; // default false — permits `npm run cli ResizeWorker` to run
  sharpConcurrency: number; // default 1 — sharp.concurrency()
  sharpCache: boolean; // default false — sharp.cache()
}

// The config file a framework host writes (`src/config/resize.ts`, or another file per Resizer).
// The image settings go to the Resizer; the framework adapter reads the rest: the media model,
// the Mongo transport's timing (`queue`) and the worker command's settings (`worker`).
export interface FrameworkResizeConfig extends ResizeConfig {
  mediaModelName: string; // host media model, e.g. 'File' or 'Media'
  queue?: QueueTimingOptions; // default: defaultQueueOptions (a present section must be complete)
  worker?: FrameworkWorkerConfig; // default: defaultWorkerOptions
}
