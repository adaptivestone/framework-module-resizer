import type { ResizeConfig } from '../types.d.ts';

// Canonical module defaults. A framework host extends this file from its own
// src/config/resize.ts, while the framework remains responsible for applying
// resize.<NODE_ENV>.ts overrides. mediaModelName is intentionally host-owned.
const defaultResizeConfig: Omit<ResizeConfig, 'mediaModelName'> = {
  formats: ['jpeg', 'webp', 'avif'],
  upload: {
    maxBytes: 25 * 1024 * 1024,
    formats: ['jpeg', 'png', 'webp', 'avif', 'gif', 'svg'],
  },
  maxSize: { width: 2000, height: 1200 },
  animated: false,
  encode: {
    formats: {
      jpeg: { quality: 80, mozjpeg: true, chromaSubsampling: '4:2:0' },
      webp: { quality: 82, effort: 4 },
      avif: { quality: 64, effort: 4 },
    },
    sharpen: { cover: true, fit: false },
    flatten: { formats: ['jpeg'], background: '#ffffff' },
  },
  limits: {
    inputPixels: 268402689,
    sourcePixels: 50_000_000,
    resultDimension: 5000,
    animationFrames: 64,
    processingTimeoutSeconds: 30,
  },
  queue: {
    lockTtlMs: { dispatch: 60_000, worker: 60_000 },
    leaseMs: 60_000,
    retryBackoffMs: { base: 5_000, max: 300_000 },
    maxAttempts: 5,
    idlePollMs: 1_000,
    taskTimeoutMs: 600_000,
  },
  worker: {
    enabled: false,
    concurrency: 4,
    sharpConcurrency: 1,
    sharpCache: false,
  },
};

export default defaultResizeConfig;
