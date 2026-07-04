import merge from 'deepmerge';
import { getApp } from '../app.ts';
import type { PreviewFormat, ResizeConfig } from '../types.d.ts';

// Every TUNABLE is defaulted (and completeness-checked by the Omit type). Only the
// host-required `mediaModelName` is absent — the host sets it in src/config/resize.ts.
// Storage/transport options (buckets, URLs, queue URL) are NOT here: they are driver
// options passed at registerStorage()/registerQueueTransport() — see 05.
const defaultResizeConfig: Omit<ResizeConfig, 'mediaModelName'> = {
  formats: ['jpeg', 'webp', 'avif'],
  maxSize: { width: 2000, height: 1200 },
  animated: false,
  encode: {
    quality: { jpeg: 80, webp: 82, avif: 64 },
    effort: { webp: 4, avif: 4 },
    mozjpeg: true,
    chromaSubsampling: '4:2:0',
    sharpen: { cover: true, fit: false },
    flattenBackground: '#ffffff',
  },
  limits: {
    inputPixels: 268402689,
    sourcePixels: 50_000_000,
    resultDimension: 5000,
    animationFrames: 64,
  },
  queue: {
    lockTtlMs: { dispatch: 60000, worker: 60000 },
    leaseMs: 60000,
    retryBackoffMs: { base: 5000, max: 300000 },
    maxAttempts: 5,
    idlePollMs: 1000,
    taskTimeoutMs: 600000,
  },
  worker: {
    enabled: false,
    concurrency: 4,
    sharpConcurrency: 1,
    sharpCache: false,
  },
};

export default defaultResizeConfig;

// arrayMerge: a host config array REPLACES the default (so formats:['webp','avif'] does
// not concat to five). Without this, deepmerge concatenates arrays.
const overwrite = (_dest: unknown[], src: unknown[]): unknown[] => src;

/**
 * Deep-merge the host's `resize` config (read from the ambient app — src/app.ts) over
 * the module defaults, then fail fast if the one required field is still missing.
 * Returns a fully-resolved ResizeConfig. Never mutates `defaultResizeConfig`
 * (deepmerge returns a fresh object).
 */
export function getResizeConfig(): ResizeConfig {
  const host = getApp().getConfig('resize') ?? {};
  const merged = merge(defaultResizeConfig, host, {
    arrayMerge: overwrite,
  }) as ResizeConfig;
  if (!merged.mediaModelName) {
    throw new Error(
      'resize config: `mediaModelName` is required — set it in the host src/config/resize.ts',
    );
  }
  // Doneness invariant (07 · Worker): a worker lock MUST expire within the lease window, else a
  // crashed worker's lock outlives its lease and blocks the re-leased task from regenerating the
  // skipped variant. Enforce lockTtlMs.worker ≤ leaseMs at config resolution (08 · §13).
  if (merged.queue.lockTtlMs.worker > merged.queue.leaseMs) {
    throw new Error(
      `resize config: queue.lockTtlMs.worker (${merged.queue.lockTtlMs.worker}) must be ≤ queue.leaseMs (${merged.queue.leaseMs}) — a worker lock must expire within the lease window (07 · doneness invariant)`,
    );
  }
  return merged;
}

/** The SINGLE source for the active format list (read path + worker MUST agree). */
export function requiredFormats(config: ResizeConfig): PreviewFormat[] {
  return config.webpAvifOnly ? ['webp', 'avif'] : config.formats;
}
