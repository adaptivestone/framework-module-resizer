// Loads a Resizer's config file from the framework app. Each Resizer may read its own file
// (`configName`, default 'resize'); the framework has already merged resize.<NODE_ENV>.ts over it.
// The file holds the image settings (passed to the Resizer) plus what only this adapter reads:
// `mediaModelName`, `queue` (the task queue's timing) and `worker` (the worker command).
import { defaultQueueOptions, defaultWorkerOptions } from '../config/resize.ts';
import { ResizeConfigError } from '../errors.ts';
import { validateQueueTiming, validateResizeConfig } from '../resizeConfig.ts';
import type {
  FrameworkResizeConfig,
  FrameworkWorkerConfig,
  QueueTimingOptions,
  ResizeConfig,
} from '../types.d.ts';
import { getApp } from './app.ts';

/** A validated framework config file, split by who reads each part. */
export interface ResolvedFrameworkConfig {
  image: ResizeConfig; // the Resizer's config
  mediaModelName: string;
  queue: QueueTimingOptions; // the file's `queue`, or the defaults
  worker: FrameworkWorkerConfig; // the file's `worker`, or the defaults
}

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
  const { mediaModelName, queue, worker, ...image } = raw;
  if (
    typeof mediaModelName !== 'string' ||
    mediaModelName.trim().length === 0
  ) {
    throw new ResizeConfigError(
      `resize config: \`mediaModelName\` is required — set it in the host src/config/${configName}.ts`,
      { code: 'RESIZE_CONFIG_MEDIA_MODEL_MISSING' },
    );
  }
  const queueOptions = queue ?? defaultQueueOptions;
  validateQueueTiming(queueOptions);
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
      `resize config: \`worker\` in src/config/${configName}.ts needs enabled (boolean), sharpConcurrency (positive integer) and sharpCache (boolean)`,
      { code: 'RESIZE_CONFIG_INVALID' },
    );
  }
  const result: ResolvedFrameworkConfig = {
    image: validateResizeConfig(image),
    mediaModelName,
    queue: queueOptions,
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
