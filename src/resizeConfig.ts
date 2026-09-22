import merge from 'deepmerge';
import { getApp } from './app.ts';
import defaultResizeConfig from './config/resize.ts';
import { ResizeConfigError } from './errors.ts';
import type { PreviewFormat, ResizeConfig } from './types.d.ts';

const originalFormats = new Set(['jpeg', 'png', 'webp', 'avif', 'gif', 'svg']);
const previewFormats = new Set(['jpeg', 'webp', 'avif']);
const overwrite = (_dest: unknown[], src: unknown[]): unknown[] => src;

const invalid = (message: string, code: string): never => {
  throw new ResizeConfigError(message, { code });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

type ValidatedResizeConfigFields = Pick<
  ResizeConfig,
  'mediaModelName' | 'formats' | 'upload'
> & {
  queue: Pick<ResizeConfig['queue'], 'leaseMs' | 'lockTtlMs'>;
};

/** Checks the safety-critical subset resolved at module construction. */
function validateRequiredResizeConfigFields(
  config: unknown,
): asserts config is ValidatedResizeConfigFields {
  if (!isRecord(config)) {
    return invalid('resize config must be an object', 'RESIZE_CONFIG_INVALID');
  }
  const root = config;
  if (
    typeof root.mediaModelName !== 'string' ||
    root.mediaModelName.trim().length === 0
  ) {
    invalid(
      'resize config: `mediaModelName` is required — set it in the host src/config/resize.ts',
      'RESIZE_CONFIG_MEDIA_MODEL_MISSING',
    );
  }

  const upload = root.upload;
  if (!isRecord(upload)) {
    return invalid(
      'resize config: upload must be an object',
      'RESIZE_CONFIG_UPLOAD_INVALID',
    );
  }
  if (!isPositiveSafeInteger(upload.maxBytes)) {
    invalid(
      'resize config: upload.maxBytes must be a positive safe integer',
      'RESIZE_CONFIG_UPLOAD_MAX_BYTES_INVALID',
    );
  }
  if (
    !Array.isArray(upload.formats) ||
    upload.formats.length === 0 ||
    upload.formats.some(
      (format) => typeof format !== 'string' || !originalFormats.has(format),
    )
  ) {
    invalid(
      'resize config: upload.formats must contain supported original formats',
      'RESIZE_CONFIG_UPLOAD_FORMATS_INVALID',
    );
  }

  if (
    !Array.isArray(root.formats) ||
    root.formats.length === 0 ||
    root.formats.some(
      (format) => typeof format !== 'string' || !previewFormats.has(format),
    )
  ) {
    invalid(
      'resize config: formats must contain supported preview formats',
      'RESIZE_CONFIG_FORMATS_INVALID',
    );
  }

  const queue = root.queue;
  if (!isRecord(queue)) {
    return invalid(
      'resize config: queue must be an object',
      'RESIZE_CONFIG_QUEUE_INVALID',
    );
  }
  const leaseMs = queue.leaseMs;
  if (!isPositiveSafeInteger(leaseMs)) {
    invalid(
      'resize config: queue.leaseMs must be a positive safe integer',
      'RESIZE_CONFIG_QUEUE_LEASE_INVALID',
    );
  }
  const lockTtlMs = queue.lockTtlMs;
  if (!isRecord(lockTtlMs)) {
    return invalid(
      'resize config: queue.lockTtlMs must be an object',
      'RESIZE_CONFIG_QUEUE_LOCK_TTL_INVALID',
    );
  }
  const dispatchTtlMs = lockTtlMs.dispatch;
  const workerTtlMs = lockTtlMs.worker;
  if (
    !isPositiveSafeInteger(dispatchTtlMs) ||
    !isPositiveSafeInteger(workerTtlMs)
  ) {
    invalid(
      'resize config: queue.lockTtlMs.dispatch and queue.lockTtlMs.worker must be positive safe integers',
      'RESIZE_CONFIG_QUEUE_LOCK_TTL_INVALID',
    );
  }
  // The checks directly above establish both values as safe positive integers.
  if ((workerTtlMs as number) > (leaseMs as number)) {
    invalid(
      `resize config: queue.lockTtlMs.worker (${workerTtlMs}) must be ≤ queue.leaseMs (${leaseMs}) — a worker lock must expire within the lease window (07 · doneness invariant)`,
      'RESIZE_CONFIG_LOCK_EXCEEDS_LEASE',
    );
  }
}

/** Resolves the framework-loaded host config over immutable module defaults. */
export function getResizeConfig(): ResizeConfig {
  const host = getApp().getConfig('resize') ?? {};
  const merged: unknown = merge(defaultResizeConfig, host, {
    arrayMerge: overwrite,
  });
  validateRequiredResizeConfigFields(merged);
  // Defaults provide the complete shape; the validator above intentionally asserts only
  // the subset checked at runtime instead of presenting itself as a universal validator.
  return merged as ResizeConfig;
}

/** The SINGLE source for the active format list (read path + worker MUST agree). */
export function requiredFormats(config: ResizeConfig): PreviewFormat[] {
  return config.webpAvifOnly ? ['webp', 'avif'] : config.formats;
}
