import type {
  FrameworkResizeConfig,
  FrameworkWorkerConfig,
  QueueTimingOptions,
  ResizeConfig,
} from '../types.d.ts';

// Canonical defaults, pure data. The default export is the core image config (what
// `new Resizer({ config })` takes). Framework hosts spread `defaultFrameworkResizeConfig`, which adds
// the `queue` and `worker` sections the framework adapter reads; the framework applies
// resize.<NODE_ENV>.ts overrides.
const defaultResizeConfig: ResizeConfig = {
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
  concurrency: 4,
};

/** Mongo transport timing and lock TTL defaults (also MongoTransport's own defaults). */
export const defaultQueueOptions: QueueTimingOptions = {
  lockTtlMs: { dispatch: 60_000, worker: 60_000 },
  leaseMs: 60_000,
  retryBackoffMs: { base: 5_000, max: 300_000 },
  maxAttempts: 5,
  idlePollMs: 1_000,
  taskTimeoutMs: 600_000,
};

/** Framework worker command defaults. */
export const defaultWorkerOptions: FrameworkWorkerConfig = {
  enabled: false,
  sharpConcurrency: 1,
  sharpCache: false,
};

/**
 * What a framework host's config file spreads; it adds `mediaModelName`. `queue` and `worker` are
 * typed as present, so `worker: { ...defaultFrameworkResizeConfig.worker, enabled: true }` stays
 * a complete section under strict TypeScript.
 */
export const defaultFrameworkResizeConfig: Omit<
  FrameworkResizeConfig,
  'mediaModelName' | 'queue' | 'worker'
> & { queue: QueueTimingOptions; worker: FrameworkWorkerConfig } = {
  ...defaultResizeConfig,
  queue: defaultQueueOptions,
  worker: defaultWorkerOptions,
};

export default defaultResizeConfig;
