// Hand-authored public types for @adaptivestone/framework-module-resize.
// This file is copied verbatim into dist by postBuild.ts (tsc does not emit it),
// so it MUST stay dependency-free: no imports of source (.ts) modules and no
// runtime imports. Source-coupled types live in src/contracts/: the driver contracts
// (ResizeStorage, MediaStore, LockStore, TaskQueue) and the pipeline and hook types that
// reference them or sharp (Pipeline, BeforeStep, VariantStep, HookName, HookSignatures,
// HookTaps, HookFn). ResizerOptions stays beside the Resizer in resizer.ts.

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
  // The full preview identity (resizer:pipeline:sizeKey:format:filters). The media store keeps one
  // row per identity; absent on rows written before previews carried it.
  identity?: string;
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
  preview: Preview; // the stored preview this entry serves
  contentType: string; // preview.contentType
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
    | 'RESIZE_ENQUEUE_NO_QUEUE'
    | 'RESIZE_ENQUEUE_LOCK_CONTENDED'
    | 'RESIZE_ENQUEUE_LOCK_FAILED'
    | 'RESIZE_ENQUEUE_QUEUE_FAILED'
    | 'RESIZE_ENQUEUE_UNCONFIRMED'
    | 'RESIZE_ENQUEUE_CONFIRM_FAILED'
    | 'RESIZE_ENQUEUE_VARIANT_CONFLICT'
    | 'RESIZE_PIPELINE_UNKNOWN' // the pipeline is not registered on this Resizer
    | 'RESIZE_FORMAT_NOT_CONFIGURED' // a requested format has no encode.formats entry
    | 'RESIZE_ENQUEUE_INTERNAL_ERROR'; // prewarm caught an unexpected error (see message)
  message: string;
  retryable: boolean;
  previews: MissingPreview[];
}

// What prewarm() reports for every requested variant. ready / accepted / notRequired / unconfirmed
// split the requested catalog; `tasks` holds the task-queue receipts; `issues` say why a variant is
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
// Options of the Resizer's methods, named so hosts can annotate their call sites
// ---------------------------------------------------------------------------

/**
 * A part given as a function: called once, on first use, sync or async. It lets a Resizer be
 * constructed at import time and build a driver later, e.g. from config that is not loaded yet or
 * from an optional peer imported only when selected.
 */
export type LazyPart<T> = () => T | Promise<T>;

export interface ResolveOpts {
  media: MediaLike;
  sizes: SizeInput[];
  pipeline?: string; // selects a registered pipeline; default 'default'
  formats?: PreviewFormat[]; // default = config.formats
  ctx?: Record<string, unknown>; // threaded to the read-path hooks
  enqueueMissing?: boolean; // default true when a task queue is set, false otherwise
  queue?: string; // queue for missing variants; default resizer.queue
}

export interface PrewarmOpts {
  media: MediaLike;
  sizes: SizeInput[];
  pipeline?: string; // selects a registered pipeline; default 'default'
  formats?: PreviewFormat[]; // default = config.formats
  ctx?: Record<string, unknown>; // reaches the read-path waterfalls only (worker ctx stays {})
  queue?: string; // queue for missing variants; default resizer.queue
}

// Options for eager `generate`.
export interface GenerateOpts {
  media: MediaLike;
  sizes: SizeInput[];
  pipeline?: string; // selects a registered pipeline; default 'default'
  formats?: PreviewFormat[]; // default = config.formats
  ctx?: Record<string, unknown>; // real ctx reaches pipeline steps (eager mode)
  persist?: boolean; // default true → $push previews + backfill dims
}

// `created` is only the rows THIS call produced. Empty + `failed === 0` is success
// (already stored or an empty catalog). Total failure throws.
export interface GenerateResult {
  created: Preview[];
  failed: number;
}

// ---------------------------------------------------------------------------
// Config (the framework returns the fully resolved value from app.getConfig('resize'))
//
// MODULE behavior only. Storage-specific options (buckets, base URL, signed-URL
// settings) live in the storage driver; queue-specific options (SQS queue URL, region) live in
// the task queue — both are passed to the Resizer constructor. The core config never knows what a
// "bucket" or "queue URL" is, so a new storage driver or task queue is self-contained and the
// module never changes.
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

// Queue timing and lock TTLs: a task queue's timing (MongoTaskQueue / SqsTaskQueue `timing`; the
// framework config file's `queue` section feeds the framework's queue).
export interface QueueTimingOptions {
  // dispatch: default 60000 — one read's enqueue holds each variant this long;
  // worker: default 60000, must be ≤ leaseMs;
  // failed: default 600000 — after a task is dead-lettered, reads do not queue its variants again
  // for this long.
  lockTtlMs: { dispatch: number; worker: number; failed?: number };
  leaseMs: number; // default 60000 — the heartbeat renews at leaseMs / 2
  retryBackoffMs: { base: number; max: number }; // default { base: 5000, max: 300000 }
  maxAttempts: number; // default 5 — deliveries before dead-letter (every lease counts, incl. reclaims)
  idlePollMs: number; // default 1000 — sleep after an empty poll
  taskTimeoutMs: number; // default 600000 — a task running longer is failed
}

// How a Resizer with a task queue coordinates its queued work, in ms
// (`new Resizer({ coordination })`, or the framework config file's `coordination` section). Missing
// values take the defaults (defaultCoordination); only the core validates them, when the Resizer
// sets up its task queue. An eager-only Resizer never reads them.
export interface CoordinationOptions {
  // default 600000 — how long the gate lock of a queued task holds its media and pipeline until a
  // worker extends it (on a task queue without its own gate, e.g. SQS); must be ≥ the task queue's
  // leaseMs.
  gateTtlMs?: number;
  // default 600000 — after a task is dead-lettered, no new task for that media and pipeline is
  // queued for this long.
  cooldownMs?: number;
}

// The framework worker command's settings (the config file's `worker` section).
export interface FrameworkWorkerConfig {
  enabled: boolean; // default false — permits `npm run cli ResizeWorker` to run
  sharpConcurrency: number; // default 1 — sharp.concurrency()
  sharpCache: boolean; // default false — sharp.cache()
}

// Where a FrameworkResizer keeps files: the config file's `storage` section. Credentials are not
// config: the AWS SDK reads them from its default provider chain.
export interface FrameworkLocalStorageConfig {
  driver: 'local'; // LocalFsStorage
  rootDir: string; // public previews; serve only this directory
  publicBaseUrl: string; // URL prefix, e.g. '/media'
  privateRootDir?: string; // private originals; default rootDir + '-private'
}
export interface FrameworkS3StorageConfig {
  driver: 's3'; // S3Storage (needs @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner)
  bucketPublic: string; // previews
  bucketPrivate?: string; // originals; must differ from bucketPublic
  publicBaseUrl?: string; // CDN/base URL
  region?: string;
  endpoint?: string; // S3-compatible: MinIO / localstack / R2
  forcePathStyle?: boolean;
}
export type FrameworkStorageConfig =
  | FrameworkLocalStorageConfig
  | FrameworkS3StorageConfig;

// Where a FrameworkResizer's tasks wait: the config file's `queue` section, with the queue's
// timing (any QueueTimingOptions key; the rest default).
export interface FrameworkDatabaseQueueConfig
  extends Partial<QueueTimingOptions> {
  driver?: 'database'; // the app's queue over its ResizeTask model (default driver)
}
export interface FrameworkSqsQueueConfig extends Partial<QueueTimingOptions> {
  driver: 'sqs'; // SqsTaskQueue (needs @aws-sdk/client-sqs)
  queueUrl: string; // the 'default' queue
  queues?: Record<string, string>; // other named queues → URLs
  deadLetterQueueUrl?: string;
  waitTimeSeconds?: number; // long poll per claim; default 10
  region?: string;
  endpoint?: string;
}
export type FrameworkQueueConfig =
  | FrameworkDatabaseQueueConfig
  | FrameworkSqsQueueConfig;

// The config file a framework host writes (`src/config/resize.ts`, or another file per Resizer).
// The image settings go to the Resizer; FrameworkResizer builds the rest: the media model, the
// storage, the task queue and the worker command's settings. resize.<NODE_ENV>.ts overrides any
// of them per environment.
export interface FrameworkResizeConfig extends ResizeConfig {
  mediaModelName: string; // host media model, e.g. 'File' or 'Media'
  storage?: FrameworkStorageConfig; // required unless the code passes `storage`
  queue?: FrameworkQueueConfig | false; // missing or false: eager only (no task queue)
  coordination?: CoordinationOptions; // default: defaultCoordination; read only beside a queue
  worker?: FrameworkWorkerConfig; // default: defaultWorkerOptions
}
