// Hand-authored public types for @adaptivestone/framework-module-resize.
// This file is copied verbatim into dist by postBuild.ts (tsc does not emit it),
// so it MUST stay dependency-free: no imports of source (.ts) modules and no
// runtime imports. Source-coupled types (Pipeline, BeforeStep, VariantStep,
// QueueTransport, ResizeStorage, MediaStore, LockProvider, HookName, HookFn)
// live next to their code.

// Recursive partial for environment-specific config overrides. Arrays stay whole because
// the framework replaces them while merging resize.ts with resize.<NODE_ENV>.ts.
export type DeepPartial<T> = T extends readonly (infer _U)[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

// ---------------------------------------------------------------------------
// Minimal app interface — the SLICE of the framework app the module consumes.
// The app is never a parameter: the module reads the framework's ambient
// appInstance through src/app.ts getApp() (set once per process at Server
// construction; the framework enforces one server per process). This type
// documents that slice and is the shape a test fake must satisfy when installed
// via setAppInstance() (see 02 · §4).
// ---------------------------------------------------------------------------

export type TMinimalResizeApp = {
  // Framework config loading has already combined the base and environment files.
  getConfig(name: 'resize'): ResizeConfig;
  // Returns a Mongoose model registered by the host. At minimum:
  //  - 'Lock'       (framework built-in: acquireLock/releaseLock/waitForUnlock)
  //  - 'ResizeTask' (scaffolded into the host app; only for the Mongo transport)
  //  - the host media model, by name from config.mediaModelName
  // biome-ignore lint/suspicious/noExplicitAny: returns a host-registered mongoose model; the module stays mongoose-type-free by design
  getModel(name: string): any;
  logger: {
    info(msg: string, ...rest: unknown[]): void;
    warn(msg: string, ...rest: unknown[]): void;
    error(msg: string, ...rest: unknown[]): void;
  };
  // Framework EventEmitter (app.events). Observers are mirrored as `resize:<name>`.
  // Duck-typed here, NOT a framework import (see 04 · §9).
  events?: { emit(name: string, ...args: unknown[]): void };
  // Part of the framework app shape; NOT read by the resize module (the standalone
  // scaffold bin resolves write paths from cwd + `--out` — see 08 · §12).
  foldersConfig?: { [k: string]: string | undefined };
};

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

// Opaque storage locator round-tripped between the module and the active storage
// driver. `key` is always present; `bucket` is S3-specific — a filesystem/GCS/other
// driver may omit it. The module never interprets these fields; it passes them back
// to the driver's download/publicUrl/signedUrl (see 05 · §10.4).
export interface StorageRef {
  key: string;
  bucket?: string;
}

export interface Original extends StorageRef {
  // Optional public copy of SVG bytes; the original locator above remains private.
  publicCopy?: StorageRef;
  format?: string;
  size?: number;
  contentType?: string;
  width?: number; // captured at upload; backfilled by the worker if missing
  height?: number;
}

export interface UploadOriginalOpts {
  body: Buffer | Uint8Array;
  visibility: 'public' | 'private';
}

export interface Preview extends StorageRef {
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

export type EnqueueRequiredStatus =
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
    | 'RESIZE_ENQUEUE_VARIANT_CONFLICT';
  message: string;
  retryable: boolean;
  previews: MissingPreview[];
}

export interface EnqueueRequiredResult {
  status: EnqueueRequiredStatus;
  reason?: 'empty-request' | 'filtered' | 'svg';
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
  mediaModelName: string; // host media model, e.g. 'File' or 'Media'
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
  };

  // Queue/lease tuning (used by the Mongo transport; harmless for SQS, which has native redrive).
  queue: {
    lockTtlMs: { dispatch: number; worker: number }; // worker MUST be ≤ leaseMs
    leaseMs: number; // default 60000 — heartbeat renews at leaseMs/2
    retryBackoffMs: { base: number; max: number }; // default { base:5000, max:300000 }
    maxAttempts: number; // default 5 — DELIVERY count before dead-letter (increments on every lease incl. reclaims, like SQS maxReceiveCount)
    idlePollMs: number; // default 1000
    taskTimeoutMs: number; // default 600000 — handleTask raced against this; on timeout: heartbeat stopped, task signal aborted, fail() fired (05 · §10.2)
  };

  // Worker runtime tuning.
  worker: {
    enabled: boolean; // default false; set true to enable the worker command
    concurrency: number; // default 4 — variants resized in parallel per task
    sharpConcurrency: number; // default 1 — sharp.concurrency(); concurrency × this ≈ nCPU
    sharpCache: boolean; // default false — sharp.cache()
  };

  placeholderPrefix?: string; // e.g. 'placeholders/loading'
}
