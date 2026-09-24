import { getApp } from './app.ts';
import { ResizeConfigError } from './errors.ts';
import type { ResizeConfig } from './types.d.ts';

const invalid = (message: string, code: string): never => {
  throw new ResizeConfigError(message, { code });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** Validate the complete framework-resolved config before it is consumed. */
function validateRequiredResizeConfigFields(
  config: unknown,
): asserts config is ResizeConfig {
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
      (format) => typeof format !== 'string' || format.trim().length === 0,
    )
  ) {
    invalid(
      'resize config: upload.formats must contain non-empty Sharp format ids',
      'RESIZE_CONFIG_UPLOAD_FORMATS_INVALID',
    );
  }

  if (
    !Array.isArray(root.formats) ||
    root.formats.length === 0 ||
    root.formats.some(
      (format) => typeof format !== 'string' || format.trim().length === 0,
    )
  ) {
    invalid(
      'resize config: formats must contain non-empty Sharp output format ids',
      'RESIZE_CONFIG_FORMATS_INVALID',
    );
  }

  const maxSize = root.maxSize;
  if (
    !isRecord(maxSize) ||
    !isPositiveSafeInteger(maxSize.width) ||
    !isPositiveSafeInteger(maxSize.height) ||
    typeof root.animated !== 'boolean'
  ) {
    invalid(
      'resize config: maxSize dimensions must be positive integers and animated must be boolean',
      'RESIZE_CONFIG_INVALID',
    );
  }

  const encode = root.encode;
  if (!isRecord(encode) || !isRecord(encode.formats)) {
    return invalid(
      'resize config: encode.formats must be an object keyed by Sharp format id',
      'RESIZE_CONFIG_INVALID',
    );
  }
  if (Object.values(encode.formats).some((options) => !isRecord(options))) {
    invalid(
      'resize config: every encode.formats value must be an options object',
      'RESIZE_CONFIG_INVALID',
    );
  }
  const flatten = encode.flatten;
  const sharpen = encode.sharpen;
  if (
    !isRecord(flatten) ||
    !Array.isArray(flatten.formats) ||
    flatten.formats.some(
      (format) => typeof format !== 'string' || format.trim().length === 0,
    ) ||
    typeof flatten.background !== 'string' ||
    flatten.background.length === 0 ||
    (sharpen !== false &&
      (!isRecord(sharpen) ||
        typeof sharpen.cover !== 'boolean' ||
        typeof sharpen.fit !== 'boolean'))
  ) {
    invalid(
      'resize config: encode.flatten and encode.sharpen are invalid',
      'RESIZE_CONFIG_INVALID',
    );
  }

  const limits = root.limits;
  if (
    !isRecord(limits) ||
    !isPositiveSafeInteger(limits.inputPixels) ||
    !isPositiveSafeInteger(limits.sourcePixels) ||
    !isPositiveSafeInteger(limits.resultDimension) ||
    !isPositiveSafeInteger(limits.animationFrames)
  ) {
    invalid(
      'resize config: all limits must be positive safe integers',
      'RESIZE_CONFIG_INVALID',
    );
  }

  const worker = root.worker;
  if (
    !isRecord(worker) ||
    typeof worker.enabled !== 'boolean' ||
    !isPositiveSafeInteger(worker.concurrency) ||
    !isPositiveSafeInteger(worker.sharpConcurrency) ||
    typeof worker.sharpCache !== 'boolean'
  ) {
    invalid(
      'resize config: worker settings are invalid',
      'RESIZE_CONFIG_INVALID',
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
  const retryBackoffMs = queue.retryBackoffMs;
  if (
    !isRecord(retryBackoffMs) ||
    !isPositiveSafeInteger(retryBackoffMs.base) ||
    !isPositiveSafeInteger(retryBackoffMs.max) ||
    !isPositiveSafeInteger(queue.maxAttempts) ||
    !isPositiveSafeInteger(queue.idlePollMs) ||
    !isPositiveSafeInteger(queue.taskTimeoutMs)
  ) {
    invalid(
      'resize config: queue retry/runtime settings are invalid',
      'RESIZE_CONFIG_QUEUE_INVALID',
    );
  }
  if ((workerTtlMs as number) > (leaseMs as number)) {
    invalid(
      `resize config: queue.lockTtlMs.worker (${workerTtlMs}) must be ≤ queue.leaseMs (${leaseMs}) — a worker lock must expire within the lease window (07 · doneness invariant)`,
      'RESIZE_CONFIG_LOCK_EXCEEDS_LEASE',
    );
  }
}

/** Read the final config already resolved and cached by the framework. */
export function getResizeConfig(): ResizeConfig {
  const config: unknown = getApp().getConfig('resize');
  validateRequiredResizeConfigFields(config);
  return config as ResizeConfig;
}
