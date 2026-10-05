import type {
  FrameworkResizeConfig,
  FrameworkWorkerConfig,
  QueueTimingOptions,
  ResizeConfig,
} from '../types.d.ts';

// Canonical defaults, pure data. The default export is the core image config (what
// `new Resizer({ config })` takes). Framework hosts spread `defaultFrameworkResizeConfig`, which adds
// the `worker` section, and set `mediaModelName`, `storage` and `queue` themselves; the framework
// applies resize.<NODE_ENV>.ts overrides.
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
      jpeg: { quality: 88, mozjpeg: true, chromaSubsampling: '4:2:0' },
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

/** Queue timing and lock TTL defaults (a task queue's missing timing values). */
export const defaultQueueOptions = {
  lockTtlMs: { dispatch: 60_000, worker: 60_000, failed: 600_000 },
  leaseMs: 60_000,
  retryBackoffMs: { base: 5_000, max: 300_000 },
  maxAttempts: 5,
  idlePollMs: 1_000,
  taskTimeoutMs: 600_000,
} satisfies QueueTimingOptions;

/** Framework worker command defaults. */
export const defaultWorkerOptions: FrameworkWorkerConfig = {
  enabled: false,
  sharpConcurrency: 1,
  sharpCache: false,
};

/**
 * What a framework host's config file spreads; it adds `mediaModelName`, `storage` and (for
 * background generation) `queue`. `worker` is typed as present, so
 * `worker: { ...defaultFrameworkResizeConfig.worker, enabled: true }` stays a complete section
 * under strict TypeScript.
 */
export const defaultFrameworkResizeConfig: Omit<
  FrameworkResizeConfig,
  'mediaModelName' | 'worker'
> & { worker: FrameworkWorkerConfig } = {
  ...defaultResizeConfig,
  worker: defaultWorkerOptions,
};

export default defaultResizeConfig;
