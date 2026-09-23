import type { DeepPartial, ResizeConfig } from '../types.d.ts';

const baseResizeConfig: ResizeConfig = {
  mediaModelName: 'File',
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

function merge(base: unknown, override: unknown): unknown {
  if (Array.isArray(override)) {
    return [...override];
  }
  if (
    override &&
    typeof override === 'object' &&
    !Array.isArray(override) &&
    base &&
    typeof base === 'object' &&
    !Array.isArray(base)
  ) {
    const result = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(override)) {
      result[key] = merge(result[key], value);
    }
    return result;
  }
  return override === undefined ? base : override;
}

export function makeResizeConfig(
  override: DeepPartial<ResizeConfig> = {},
): ResizeConfig {
  return merge(baseResizeConfig, override) as ResizeConfig;
}
