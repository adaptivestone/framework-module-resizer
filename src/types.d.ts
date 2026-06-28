// Hand-authored public types for @adaptivestone/framework-module-resize.
// This file is copied verbatim into dist by postBuild.ts (tsc does not emit it),
// so it MUST stay dependency-free: no imports of source (.ts) modules and no
// runtime imports. Source-coupled types (Pipeline, BeforeStep, VariantStep,
// QueueTransport, ResizeStorage, HookName, HookFn) live next to their code.

// ---------------------------------------------------------------------------
// Minimal app interface (the slice of the framework app the module depends on)
// ---------------------------------------------------------------------------

export type TMinimalResizeApp = {
  getConfig(name: 'resize'): Partial<ResizeConfig>;
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

export type PreviewFormat = 'jpeg' | 'webp' | 'avif';

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
  format?: string;
  size?: number;
  contentType?: string;
  width?: number; // captured at upload; backfilled by the worker if missing
  height?: number;
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
}

export interface ReadDecision {
  ready: ReadyEntry[];
  missing: MissingPreview[];
}

// ---------------------------------------------------------------------------
// Config (merged with app.getConfig('resize') — see 08 · §13)
//
// MODULE behavior only. Storage-specific options (buckets, base URL, signed-URL
// settings) live in the storage driver; transport-specific options (SQS queue URL,
// region) live in the transport driver — each is passed to the driver at registration
// (see 05). The core config never knows what a "bucket" or "queue URL" is, so a new
// storage/transport driver is self-contained and the module never changes.
// ---------------------------------------------------------------------------

export interface ResizeConfig {
  mediaModelName: string; // host media model, e.g. 'File' or 'Media'
  formats: PreviewFormat[]; // default ['jpeg','webp','avif']
  webpAvifOnly?: boolean; // when true, requiredFormats() drops 'jpeg' (read + worker MUST agree)
  maxSize: { width: number; height: number }; // default { 2000, 1200 } (the `fit` cap)
  animated: boolean; // default false — true keeps GIF/WebP frames

  // Per-format encode settings. JPEG q80 ≈ AVIF q64 ≈ WebP q82 — NEVER reuse one quality int.
  encode: {
    quality: { jpeg: number; webp: number; avif: number }; // default { jpeg:80, webp:82, avif:64 }
    effort: { webp: number; avif: number }; // default { webp:4, avif:4 } (raise to 5–6 for persist-once)
    mozjpeg: boolean; // default true — jpeg({ mozjpeg:true }): progressive + trellis, ~10–20% smaller
    chromaSubsampling: '4:2:0' | '4:4:4'; // default '4:2:0'; '4:4:4' keeps full chroma for text/logos/UI
    sharpen: { cover: boolean; fit: boolean } | false; // default { cover:true, fit:false }
    flattenBackground: string; // default '#ffffff' — alpha source → jpeg flattened onto this
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
    lockTtlMs: { dispatch: number; worker: number }; // default { 60000, 60000 }; worker MUST be ≤ leaseMs
    leaseMs: number; // default 60000 — heartbeat renews at leaseMs/2
    retryBackoffMs: { base: number; max: number }; // default { base:5000, max:300000 }
    maxAttempts: number; // default 3 — retries before dead-letter
    idlePollMs: number; // default 1000
  };

  // Worker runtime tuning.
  worker: {
    enabled: boolean; // default false (env-driven in host)
    concurrency: number; // default 4 — variants resized in parallel per task
    sharpConcurrency: number; // default 1 — sharp.concurrency(); concurrency × this ≈ nCPU
    sharpCache: boolean; // default false — sharp.cache()
  };

  placeholderPrefix?: string; // e.g. 'placeholders/loading'
}
