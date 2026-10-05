// Pure validation of a complete resize config. It reads no framework state; the framework
// adapter (src/framework/config.ts) loads the config from the app and checks mediaModelName.
import { ResizeConfigError } from './errors.ts';
import type { QueueTimingOptions, ResizeConfig } from './types.d.ts';

const invalid = (message: string, code: string): never => {
  throw new ResizeConfigError(message, { code });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

// Keys read by 0.2.x and ignored since. Framework merging keeps unknown keys, so an upgraded
// host would otherwise lose these settings silently (e.g. webpAvifOnly: jpeg output returns).
const REMOVED_KEYS: Record<string, string> = {
  webpAvifOnly: 'formats',
  'encode.quality': 'encode.formats.<format>.quality',
  'encode.effort': 'encode.formats.<format>.effort',
  'encode.mozjpeg': 'encode.formats.jpeg.mozjpeg',
  'encode.chromaSubsampling': 'encode.formats.jpeg.chromaSubsampling',
  'encode.flattenBackground': 'encode.flatten.background',
  // Moved out of the image config: queue timing is a transport option, and `worker.concurrency`
  // is the top-level `concurrency`.
  queue:
    'the queue transport options (e.g. new MongoTransport({ leaseMs, lockTtlMs })); framework hosts keep `queue` in the config file',
  worker:
    '`concurrency`, and runWorker({ sharp }) for Sharp tuning; framework hosts keep `worker` in the config file',
};

/** Validate the complete framework-resolved config before it is consumed. */
function validateRequiredResizeConfigFields(
  config: unknown,
): asserts config is ResizeConfig {
  if (!isRecord(config)) {
    return invalid('resize config must be an object', 'RESIZE_CONFIG_INVALID');
  }
  const root = config;
  for (const [path, replacement] of Object.entries(REMOVED_KEYS)) {
    const [head, tail] = path.split('.');
    const owner = tail === undefined ? root : root[head];
    if (isRecord(owner) && Object.hasOwn(owner, tail ?? head)) {
      invalid(
        `resize config: \`${path}\` is no longer supported — use \`${replacement}\``,
        'RESIZE_CONFIG_REMOVED_KEY',
      );
    }
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
  // Every generated format needs its own encoder entry ({} keeps Sharp defaults). Sharp accepts
  // aliases such as 'jpg', which would encode JPEG while skipping the 'jpeg' options and the
  // flatten list, so transparent pixels would turn black.
  const encoders = encode.formats;
  const unconfigured = (root.formats as string[]).filter(
    (format) => !Object.hasOwn(encoders, format),
  );
  if (unconfigured.length > 0) {
    invalid(
      `resize config: formats [${unconfigured.join(', ')}] have no encode.formats entry — add one ({} keeps Sharp defaults) and use Sharp format ids such as 'jpeg', not aliases such as 'jpg'`,
      'RESIZE_CONFIG_FORMATS_INVALID',
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
    !isPositiveSafeInteger(limits.animationFrames) ||
    !isPositiveSafeInteger(limits.processingTimeoutSeconds)
  ) {
    invalid(
      'resize config: all limits must be positive safe integers',
      'RESIZE_CONFIG_INVALID',
    );
  }

  if (!isPositiveSafeInteger(root.concurrency)) {
    invalid(
      'resize config: concurrency must be a positive safe integer',
      'RESIZE_CONFIG_INVALID',
    );
  }
}

/** Validate lock TTLs: `{ dispatch, worker }` in positive safe-integer ms. */
export function validateLockTtlMs(
  lockTtlMs: unknown,
): asserts lockTtlMs is { dispatch: number; worker: number } {
  if (
    !isRecord(lockTtlMs) ||
    !isPositiveSafeInteger(lockTtlMs.dispatch) ||
    !isPositiveSafeInteger(lockTtlMs.worker)
  ) {
    invalid(
      'resize queue options: lockTtlMs needs dispatch and worker as positive safe integers (ms)',
      'RESIZE_CONFIG_QUEUE_LOCK_TTL_INVALID',
    );
  }
}

/**
 * Validate queue timing and lock TTLs (MongoTransport options, and the framework config file's
 * `queue` section). A worker lock must expire within the lease.
 */
export function validateQueueTiming(
  queue: unknown,
): asserts queue is QueueTimingOptions {
  if (!isRecord(queue)) {
    return invalid(
      'resize queue options must be an object',
      'RESIZE_CONFIG_QUEUE_INVALID',
    );
  }
  const leaseMs = queue.leaseMs;
  if (!isPositiveSafeInteger(leaseMs)) {
    invalid(
      'resize queue options: leaseMs must be a positive safe integer',
      'RESIZE_CONFIG_QUEUE_LEASE_INVALID',
    );
  }
  const lockTtlMs = queue.lockTtlMs;
  if (!isRecord(lockTtlMs)) {
    return invalid(
      'resize queue options: lockTtlMs must be an object',
      'RESIZE_CONFIG_QUEUE_LOCK_TTL_INVALID',
    );
  }
  const workerTtlMs = lockTtlMs.worker;
  if (
    !isPositiveSafeInteger(lockTtlMs.dispatch) ||
    !isPositiveSafeInteger(workerTtlMs)
  ) {
    invalid(
      'resize queue options: lockTtlMs.dispatch and lockTtlMs.worker must be positive safe integers',
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
      'resize queue options: retryBackoffMs, maxAttempts, idlePollMs and taskTimeoutMs must be positive safe integers',
      'RESIZE_CONFIG_QUEUE_INVALID',
    );
  }
  if ((workerTtlMs as number) > (leaseMs as number)) {
    invalid(
      `resize queue options: lockTtlMs.worker (${workerTtlMs}) must be ≤ leaseMs (${leaseMs}) — a worker lock must expire within the lease`,
      'RESIZE_CONFIG_LOCK_EXCEEDS_LEASE',
    );
  }
}

// The framework returns the same cached object on every getConfig call, and a Resizer keeps
// its config object, so each object is validated once.
const validatedConfigs = new WeakSet<object>();

/** Validate a complete resize config. Pure: reads no framework state. */
export function validateResizeConfig(config: unknown): ResizeConfig {
  if (isRecord(config) && validatedConfigs.has(config)) {
    return config as unknown as ResizeConfig;
  }
  validateRequiredResizeConfigFields(config);
  validatedConfigs.add(config);
  return config;
}
