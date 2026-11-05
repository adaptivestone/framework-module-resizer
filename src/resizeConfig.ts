// Pure validation of a complete resize config. It reads no framework state; the framework
// adapter (src/framework/config.ts) loads the config from the app and checks mediaModelName.
import { ResizeConfigError } from './errors.ts';
import { MAX_TIMER_MS } from './helpers/sleep.ts';
import type {
  QueueTimingOptions,
  ResizeConfig,
  ResizeFailOn,
} from './types.d.ts';

const invalid = (message: string, code: string): never => {
  throw new ResizeConfigError(message, { code });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const overTimerLimit = (value: unknown): boolean =>
  typeof value === 'number' && value > MAX_TIMER_MS;

// The longest timeout Sharp accepts: above it every Sharp call throws, so every upload and render
// fails. It also keeps the timer of an SVG render, this many seconds in ms, within a timer's limit.
const MAX_PROCESSING_TIMEOUT_SECONDS = 3600;

const FAIL_ON_LEVELS: ReadonlySet<unknown> = new Set([
  'none',
  'truncated',
  'error',
  'warning',
] satisfies ResizeFailOn[]);

// Keys read by 0.2.x and ignored since. Framework merging keeps unknown keys, so an upgraded
// host would otherwise lose these settings silently (e.g. webpAvifOnly: jpeg output returns).
const REMOVED_KEYS: Record<string, string> = {
  webpAvifOnly: 'formats',
  'encode.quality': 'encode.formats.<format>.quality',
  'encode.effort': 'encode.formats.<format>.effort',
  'encode.mozjpeg': 'encode.formats.jpeg.mozjpeg',
  'encode.chromaSubsampling': 'encode.formats.jpeg.chromaSubsampling',
  'encode.flattenBackground': 'encode.flatten.background',
  // Moved out of the image config: queue timing is a task-queue option, and `worker.concurrency`
  // is the top-level `concurrency`.
  queue:
    'the task queue timing (e.g. new MongoTaskQueue({ model, timing: { leaseMs } }) or mongoParts(connection, { mediaModel, timing })); framework hosts define each queue in `queues` of src/config/resize.ts',
  worker:
    '`concurrency`, and runWorker({ sharp }) for Sharp tuning; framework hosts keep `worker` in src/config/resize.ts',
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
  // Framework merging keeps unknown keys, so an engine here would never run, and nothing would say so.
  if (root.engine !== undefined) {
    invalid(
      'resize config: `engine` is not a config key — pass it in code, as the `engine` option: new Resizer({ engine }), createResizer(config, { engine }) or new FrameworkResizer({ engine })',
      'RESIZE_CONFIG_INVALID',
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
      'resize config: upload.formats must contain non-empty format ids',
      'RESIZE_CONFIG_UPLOAD_FORMATS_INVALID',
    );
  }
  if (upload.verify !== 'none' && upload.verify !== 'decode') {
    invalid(
      "resize config: `upload.verify` must be 'none' or 'decode'",
      'RESIZE_CONFIG_INVALID',
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
      'resize config: formats must contain non-empty output format ids',
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
      'resize config: encode.formats must be an object keyed by format id',
      'RESIZE_CONFIG_INVALID',
    );
  }
  if (Object.values(encode.formats).some((options) => !isRecord(options))) {
    invalid(
      'resize config: every encode.formats value must be an options object',
      'RESIZE_CONFIG_INVALID',
    );
  }
  // Every generated format needs its own encoder entry ({} keeps the engine's defaults). Sharp
  // accepts aliases such as 'jpg', which would encode JPEG while skipping the 'jpeg' options and the
  // flatten list, so transparent pixels would turn black.
  const encoders = encode.formats;
  const unconfigured = (root.formats as string[]).filter(
    (format) => !Object.hasOwn(encoders, format),
  );
  if (unconfigured.length > 0) {
    invalid(
      `resize config: formats [${unconfigured.join(', ')}] have no encode.formats entry — use an id it already has, such as 'jpeg', or add one ({} keeps the engine's defaults); a 'jpg' entry also needs encode.flatten.formats to name it, or transparent pixels turn black`,
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
    !isPositiveSafeInteger(limits.sourceBytes) ||
    !isPositiveSafeInteger(limits.resultDimension) ||
    !isPositiveSafeInteger(limits.animationFrames) ||
    !isPositiveSafeInteger(limits.processingTimeoutSeconds)
  ) {
    invalid(
      'resize config: all limits must be positive safe integers',
      'RESIZE_CONFIG_INVALID',
    );
  }
  if (
    (limits as { processingTimeoutSeconds: number }).processingTimeoutSeconds >
    MAX_PROCESSING_TIMEOUT_SECONDS
  ) {
    invalid(
      `resize config: \`limits.processingTimeoutSeconds\` must be at most ${MAX_PROCESSING_TIMEOUT_SECONDS}, the longest Sharp accepts`,
      'RESIZE_CONFIG_INVALID',
    );
  }
  // A missing level is refused too: `undefined` would silently be Sharp's own default, 'warning'.
  if (!FAIL_ON_LEVELS.has((limits as Record<string, unknown>).failOn)) {
    invalid(
      "resize config: `limits.failOn` must be 'none', 'truncated', 'error' or 'warning'",
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

/**
 * Validate queue timing (a task queue's timing, and each `queues` entry of a framework host).
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
  if (!isPositiveSafeInteger(queue.leaseMs)) {
    invalid(
      'resize queue options: leaseMs must be a positive safe integer',
      'RESIZE_CONFIG_QUEUE_LEASE_INVALID',
    );
  }
  // What reaches a timer: the heartbeat runs at leaseMs / 2, and a stricter lease limit than that
  // costs nobody anything. retryBackoffMs, gateTtlMs and cooldownMs only become dates and lock
  // expiries, so they have no such limit.
  if (overTimerLimit(queue.leaseMs)) {
    invalid(
      `resize queue options: leaseMs must be at most ${MAX_TIMER_MS}, the longest a timer can wait`,
      'RESIZE_CONFIG_QUEUE_LEASE_INVALID',
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
  for (const key of ['idlePollMs', 'taskTimeoutMs'] as const) {
    if (overTimerLimit(queue[key])) {
      invalid(
        `resize queue options: ${key} must be at most ${MAX_TIMER_MS}, the longest a timer can wait`,
        'RESIZE_CONFIG_QUEUE_INVALID',
      );
    }
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
