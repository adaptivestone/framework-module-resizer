import type {
  CoordinationOptions,
  QueueTimingOptions,
  ResizeConfig,
} from '../types.d.ts';

// The core defaults for a plain `new Resizer()`, pure data: the default export is the image config
// (what `new Resizer({ config })` takes), `defaultQueueOptions` fills a task queue's missing timing
// and `defaultCoordination` a Resizer's missing coordination. Framework hosts import
// `defaultFrameworkResizeConfig` and `defaultWorkerOptions` from …/framework.js instead.
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

/** Queue timing defaults (a task queue's missing timing values). */
export const defaultQueueOptions = {
  leaseMs: 60_000,
  retryBackoffMs: { base: 5_000, max: 300_000 },
  maxAttempts: 5,
  idlePollMs: 1_000,
  taskTimeoutMs: 600_000,
} satisfies QueueTimingOptions;

/** Coordination defaults (a Resizer's missing coordination values). */
export const defaultCoordination = {
  gateTtlMs: 600_000,
  cooldownMs: 600_000,
} satisfies Required<CoordinationOptions>;

export default defaultResizeConfig;
