import {
  supportedOriginalFormats,
  supportedPreviewFormats,
} from '../formats.ts';
import type { ResizeConfig } from '../types.d.ts';

// Every TUNABLE is defaulted (and completeness-checked by the Omit type). Only the
// host-required `mediaModelName` is absent — the host sets it in src/config/resize.ts.
// Storage/transport options (buckets, URLs, queue URL) belong to the drivers
// passed to new Resizer({ storage, transport }) — see 05.
const defaultResizeConfig: Omit<ResizeConfig, 'mediaModelName'> = {
  formats: [...supportedPreviewFormats],
  upload: {
    maxBytes: 25 * 1024 * 1024,
    formats: [...supportedOriginalFormats],
  },
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
