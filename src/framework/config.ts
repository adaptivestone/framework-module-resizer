// Loads a Resizer's config file from the framework app. Each Resizer may read its own file
// (`configName`, default 'resize'); the framework has already merged resize.<NODE_ENV>.ts over it.
// The file holds the image settings (passed to the Resizer) plus what only this adapter reads:
// `mediaModelName`, `storage`, `queue` (the task queue and its timing) and `worker` (the worker
// command).
import { defaultWorkerOptions } from '../config/resize.ts';
import { ResizeConfigError } from '../errors.ts';
import { fillTiming } from '../queue.ts';
import { validateResizeConfig } from '../resizeConfig.ts';
import type {
  FrameworkQueueConfig,
  FrameworkResizeConfig,
  FrameworkStorageConfig,
  FrameworkWorkerConfig,
  QueueTimingOptions,
  ResizeConfig,
} from '../types.d.ts';
import { getApp } from './app.ts';

/** A validated framework config file, split by who reads each part. */
export interface ResolvedFrameworkConfig {
  image: ResizeConfig; // the Resizer's config
  mediaModelName: string;
  storage: FrameworkStorageConfig | undefined; // the file's `storage`, if any
  queue: FrameworkQueueConfig | false; // the file's `queue`; false when missing (eager only)
  timing: QueueTimingOptions; // the queue's timing, with the defaults filled in
  worker: FrameworkWorkerConfig; // the file's `worker`, or the defaults
}

const STORAGE_DRIVERS = ['local', 's3'];
const QUEUE_DRIVERS = [undefined, 'database', 'sqs'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The framework returns the same cached object on every getConfig call, so each file is split and
// validated once. But `app.updateConfig()` assigns new values into that same object, so a cached
// result is reused only while every top-level value is still the same one.
const resolved = new WeakMap<
  object,
  { result: ResolvedFrameworkConfig; values: Map<string, unknown> }
>();

const sameValues = (raw: object, values: Map<string, unknown>): boolean => {
  const keys = Object.keys(raw);
  return (
    keys.length === values.size &&
    keys.every(
      (key) =>
        values.has(key) &&
        values.get(key) === (raw as Record<string, unknown>)[key],
    )
  );
};

/** Split and validate a framework config object (a config file's value). */
export function resolveFrameworkConfig(
  raw: unknown,
  configName = 'resize',
): ResolvedFrameworkConfig {
  if (isRecord(raw)) {
    const cached = resolved.get(raw);
    if (cached && sameValues(raw, cached.values)) {
      return cached.result;
    }
  }
  if (!isRecord(raw)) {
    throw new ResizeConfigError(
      `resize config: src/config/${configName}.ts must export an object`,
      { code: 'RESIZE_CONFIG_INVALID' },
    );
  }
  const { mediaModelName, storage, queue, worker, ...image } = raw;
  if (
    typeof mediaModelName !== 'string' ||
    mediaModelName.trim().length === 0
  ) {
    throw new ResizeConfigError(
      `resize config: \`mediaModelName\` is required — set it in the host src/config/${configName}.ts`,
      { code: 'RESIZE_CONFIG_MEDIA_MODEL_MISSING' },
    );
  }
  const file = `src/config/${configName}.ts`;
  if (
    storage !== undefined &&
    !(isRecord(storage) && STORAGE_DRIVERS.includes(storage.driver as string))
  ) {
    throw new ResizeConfigError(
      `resize config: \`storage\` in ${file} needs driver 'local' or 's3'`,
      { code: 'RESIZE_CONFIG_INVALID' },
    );
  }
  if (
    queue !== undefined &&
    queue !== false &&
    !(isRecord(queue) && QUEUE_DRIVERS.includes(queue.driver as string))
  ) {
    throw new ResizeConfigError(
      `resize config: \`queue\` in ${file} must be false or have driver 'database' or 'sqs'`,
      { code: 'RESIZE_CONFIG_INVALID' },
    );
  }
  if (
    isRecord(queue) &&
    queue.driver === 'sqs' &&
    (typeof queue.queueUrl !== 'string' || queue.queueUrl.length === 0)
  ) {
    throw new ResizeConfigError(
      `resize config: \`queue.queueUrl\` in ${file} is required for the 'sqs' driver`,
      { code: 'RESIZE_CONFIG_INVALID' },
    );
  }
  const timing = fillTiming(isRecord(queue) ? queue : {});
  const workerOptions = worker ?? defaultWorkerOptions;
  if (
    !isRecord(workerOptions) ||
    typeof workerOptions.enabled !== 'boolean' ||
    typeof workerOptions.sharpCache !== 'boolean' ||
    typeof workerOptions.sharpConcurrency !== 'number' ||
    !Number.isSafeInteger(workerOptions.sharpConcurrency) ||
    workerOptions.sharpConcurrency <= 0
  ) {
    throw new ResizeConfigError(
      `resize config: \`worker\` in ${file} needs enabled (boolean), sharpConcurrency (positive integer) and sharpCache (boolean)`,
      { code: 'RESIZE_CONFIG_INVALID' },
    );
  }
  const result: ResolvedFrameworkConfig = {
    image: validateResizeConfig(image),
    mediaModelName,
    storage: storage as FrameworkStorageConfig | undefined,
    queue: isRecord(queue) ? (queue as unknown as FrameworkQueueConfig) : false,
    timing,
    worker: workerOptions as unknown as FrameworkWorkerConfig,
  };
  resolved.set(raw, { result, values: new Map(Object.entries(raw)) });
  return result;
}

/** The app's config file `configName`, validated and split. */
export function getResizeConfig(
  configName = 'resize',
): ResolvedFrameworkConfig {
  return resolveFrameworkConfig(getApp().getConfig(configName), configName);
}

export type { FrameworkResizeConfig };
