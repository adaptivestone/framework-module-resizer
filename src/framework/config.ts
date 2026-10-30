// Loads the framework config files; the framework has already merged each file's
// <name>.<NODE_ENV>.ts over it. Every Resizer reads its own file (`configName`, default 'resize'),
// which holds what belongs to that Resizer: the image settings (passed to the Resizer),
// `mediaModelName`, `storage` and `queue` (the name of the queue its tasks go to). Its image
// settings are merged over the package defaults, so a file may set only what it changes. What
// belongs to the process is read only from src/config/resize.ts and rejected in any other file:
// `queues` (every queue, by name, with its timing), `worker` (the worker command's settings) and
// `coordination` (passed to every Resizer as it is: the core validates it). A driver name is
// checked here only for its shape: each Resizer checks it against its own drivers when it reads
// the section.
import type { QueueDriver, QueueEntry } from '../contracts/drivers.ts';
import { ResizeConfigError } from '../errors.ts';
import { mergeImageConfig } from '../factory/image.ts';
import { checkedQueue, queueObjectRemoved } from '../factory/lane.ts';
import { resolveQueueEntries } from '../factory/queues.ts';
import { validateSqsEntries } from '../helpers/queueSections.ts';
import { validateResizeConfig } from '../resizeConfig.ts';
import type {
  CoordinationOptions,
  FrameworkResizeConfig,
  FrameworkWorkerConfig,
  ResizeConfig,
} from '../types.d.ts';
import { getApp } from './app.ts';
import { defaultWorkerOptions } from './defaults.ts';

/** Where a Resizer's config comes from: a config file, or the `config` option. */
export interface ConfigSource {
  configName: string; // the config file, e.g. 'resize' for src/config/resize.ts
  explicit: boolean; // true: the FrameworkResizer / FrameworkMediaStore `config` option
}

/** A Resizer's validated config, split by who reads each part. */
export interface ResolvedFrameworkConfig {
  image: ResizeConfig; // the Resizer's config, merged over the package defaults
  mediaModelName: string;
  // The file's `storage`, if any: an object with a driver name, the rest unchecked (its driver
  // checks it).
  storage: { driver: string } | undefined;
  // The name of the queue the Resizer's tasks go to; false: eager only; undefined: not set.
  queue: string | false | undefined;
}

/** The process-wide sections of src/config/resize.ts, validated. */
export interface ResolvedProcessConfig {
  // Every `queues` entry by name, in the file's order (empty: no queues), each with its timing.
  queues: ReadonlyMap<string, QueueEntry>;
  // The queue drivers' checks already run on these entries: the built-in SQS ones.
  validated: ReadonlySet<QueueDriver['validate']>;
  worker: FrameworkWorkerConfig; // the file's `worker` over defaultWorkerOptions
  // Unvalidated: the core validates it when a Resizer sets up its task queue.
  coordination: CoordinationOptions | undefined;
}

// The file that defines `queues`, as the messages about a Resizer's `queue` name it.
const QUEUES_IN = 'src/config/resize.ts';
const PROCESS_WIDE = ['queues', 'worker', 'coordination'] as const;
const WORKER_KEYS = Object.keys(defaultWorkerOptions);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const invalid = (message: string): ResizeConfigError =>
  new ResizeConfigError(`resize config: ${message}`, {
    code: 'RESIZE_CONFIG_INVALID',
  });

const removed = (message: string): ResizeConfigError =>
  new ResizeConfigError(`resize config: ${message}`, {
    code: 'RESIZE_CONFIG_REMOVED_KEY',
  });

/**
 * The config file `configName` as messages name it. The framework merges the file's
 * <name>.<NODE_ENV>.ts over it before this module reads it, so a wrong value may come from either.
 */
export function configFile(configName: string): string {
  return `src/config/${configName}.ts (or its ${configName}.<NODE_ENV>.ts override)`;
}

/** A Resizer's config as messages name it: its file, or the `config` option. */
export function sourceName(source: ConfigSource): string {
  return source.explicit
    ? 'the config passed to new FrameworkResizer()'
    : configFile(source.configName);
}

// The framework returns the same cached object on every getConfig call, so each file is split and
// validated once. But `app.updateConfig()` assigns new values into that same object, so a cached
// result is reused only while every top-level value is still the same one.
interface Cached<T> {
  result: T;
  values: Map<string, unknown>;
}

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

// One object may be read as several sources (e.g. as a file and as an explicit config), and each
// reading checks other keys, so a result is kept per source.
const resolvedFiles = new WeakMap<
  object,
  Map<string, Cached<ResolvedFrameworkConfig>>
>();
const resolvedProcess = new WeakMap<object, Cached<ResolvedProcessConfig>>();

/** Split and validate a Resizer's config (a config file's value, or the `config` option). */
export function resolveFrameworkConfig(
  raw: unknown,
  source: ConfigSource,
): ResolvedFrameworkConfig {
  const key = `${source.explicit ? 'option' : 'file'}:${source.configName}`;
  if (isRecord(raw)) {
    const cached = resolvedFiles.get(raw)?.get(key);
    if (cached && sameValues(raw, cached.values)) {
      return cached.result;
    }
  }
  if (!isRecord(raw)) {
    throw invalid(
      source.explicit
        ? 'the config passed to new FrameworkResizer() must be an object'
        : `src/config/${source.configName}.ts must export an object`,
    );
  }
  // The process-wide sections are never image settings: they are taken out before the image
  // config is validated (which would reject `worker`), and checked below.
  const {
    mediaModelName,
    storage,
    queue,
    queues: _queues,
    worker: _worker,
    coordination: _coordination,
    ...image
  } = raw;
  if (
    typeof mediaModelName !== 'string' ||
    mediaModelName.trim().length === 0
  ) {
    throw new ResizeConfigError(
      `resize config: \`mediaModelName\` is required — set it in the host src/config/${source.configName}.ts`,
      { code: 'RESIZE_CONFIG_MEDIA_MODEL_MISSING' },
    );
  }
  const where = sourceName(source);
  // The name itself is checked against the Resizer's drivers when it reads the section.
  if (
    storage !== undefined &&
    !(
      isRecord(storage) &&
      typeof storage.driver === 'string' &&
      storage.driver.trim().length > 0
    )
  ) {
    throw invalid(`\`storage\` in ${where} needs driver 'local' or 's3'`);
  }
  checkedQueue(queue, where, QUEUES_IN);
  // src/config/resize.ts holds them as a file; anywhere else they would be ignored silently.
  if (source.explicit || source.configName !== 'resize') {
    for (const section of PROCESS_WIDE) {
      if (raw[section] !== undefined) {
        throw invalid(
          `\`${section}\` in ${where} is process-wide: it is read only from src/config/resize.ts`,
        );
      }
    }
  }
  const result: ResolvedFrameworkConfig = {
    image: validateResizeConfig(mergeImageConfig(image)),
    mediaModelName,
    storage: storage as { driver: string } | undefined,
    queue: queue as string | false | undefined,
  };
  let bySource = resolvedFiles.get(raw);
  if (!bySource) {
    bySource = new Map();
    resolvedFiles.set(raw, bySource);
  }
  bySource.set(key, { result, values: new Map(Object.entries(raw)) });
  return result;
}

/**
 * Validate the process-wide sections of src/config/resize.ts (its value): `queues`, `worker` and
 * `coordination`. Every other key is ignored, `mediaModelName` too: a resize.ts may hold only these.
 */
export function resolveProcessConfig(raw: unknown): ResolvedProcessConfig {
  if (isRecord(raw)) {
    const cached = resolvedProcess.get(raw);
    if (cached && sameValues(raw, cached.values)) {
      return cached.result;
    }
  }
  if (!isRecord(raw)) {
    throw invalid('src/config/resize.ts must export an object');
  }
  const where = configFile('resize');
  // Caught here too, so that worker start, which reads only this, reports the old shape.
  if (isRecord(raw.queue)) {
    throw queueObjectRemoved(where, QUEUES_IN);
  }
  const entries = resolveQueueEntries(raw.queues, where);
  // The built-in SQS driver's checks, run on the file whatever drivers a Resizer registers.
  validateSqsEntries(
    entries.filter((entry) => entry.section.driver === 'sqs'),
    { where },
  );
  const result: ResolvedProcessConfig = {
    queues: new Map(entries.map((entry) => [entry.name, entry])),
    validated: new Set([validateSqsEntries]),
    worker: resolveWorker(raw.worker, where),
    coordination: raw.coordination as CoordinationOptions | undefined,
  };
  resolvedProcess.set(raw, { result, values: new Map(Object.entries(raw)) });
  return result;
}

/** The `worker` section over defaultWorkerOptions: a missing key takes its default. */
function resolveWorker(value: unknown, where: string): FrameworkWorkerConfig {
  if (value === undefined) {
    return { ...defaultWorkerOptions };
  }
  if (!isRecord(value)) {
    throw invalid(
      `\`worker\` in ${where} must be an object: { enabled, sharpConcurrency, sharpCache }`,
    );
  }
  if (Object.hasOwn(value, 'concurrency')) {
    throw removed(
      `\`worker.concurrency\` in ${where} is no longer supported — move the value to the top-level \`concurrency\``,
    );
  }
  // A misspelled key would otherwise leave its setting at the default without a word.
  const unknown = Object.keys(value).find(
    (key) => !WORKER_KEYS.includes(key) && value[key] !== undefined,
  );
  if (unknown !== undefined) {
    throw invalid(
      `\`worker.${unknown}\` in ${where} is not a worker setting — the worker section takes ${WORKER_KEYS.join(', ')}`,
    );
  }
  const worker: Record<string, unknown> = { ...defaultWorkerOptions };
  for (const key of WORKER_KEYS) {
    if (value[key] !== undefined) {
      worker[key] = value[key];
    }
  }
  if (typeof worker.enabled !== 'boolean') {
    throw invalid(`\`worker.enabled\` in ${where} must be a boolean`);
  }
  if (!isPositiveSafeInteger(worker.sharpConcurrency)) {
    throw invalid(
      `\`worker.sharpConcurrency\` in ${where} must be a positive integer`,
    );
  }
  if (typeof worker.sharpCache !== 'boolean') {
    throw invalid(`\`worker.sharpCache\` in ${where} must be a boolean`);
  }
  return worker as unknown as FrameworkWorkerConfig;
}

/** The app's config file `configName` (default 'resize'), validated and split. */
export function getResizeConfig(
  configName = 'resize',
): ResolvedFrameworkConfig {
  return resolveFrameworkConfig(getApp().getConfig(configName), {
    configName,
    explicit: false,
  });
}

// For a missing file the framework returns a new {} and logs a warning on every call, so the empty
// result is kept per app, which is then not asked again. A resize.ts that exports {} and is filled
// later through app.updateConfig keeps that empty result too: an accepted edge case.
const missingProcessFile = new WeakMap<object, ResolvedProcessConfig>();

/** The process-wide sections of the app's src/config/resize.ts, validated. */
export function getProcessConfig(): ResolvedProcessConfig {
  const app = getApp();
  const kept = missingProcessFile.get(app);
  if (kept) {
    return kept;
  }
  const raw = app.getConfig('resize');
  const result = resolveProcessConfig(raw);
  if (isRecord(raw) && Object.keys(raw).length === 0) {
    missingProcessFile.set(app, result);
  }
  return result;
}

export type { FrameworkResizeConfig };
