// FrameworkDatabase: MongoDatabase over the framework app's models, resolved by name on each use.
// - media: `modelName`, or `mediaModelName` from the config;
// - locks: the framework's own `Lock` model (no extra collection);
// - tasks: the app's one task queue over the scaffolded `ResizeTask` model (below).
// The config is the file `configName` (default 'resize'), or an explicit `config`. Nothing is read
// from the app until first use.
//
// One task queue per backend: every FrameworkDatabase in the process shares one MongoTaskQueue,
// and FrameworkResizers whose config selects the same SQS queue share one SqsTaskQueue, so the
// worker runs one consume loop per backend. Timing belongs to the backend: it comes from the config
// of every Resizer (or host-built FrameworkDatabase) that uses it, and those must agree.
import type { TaskQueue } from '../contracts/taskQueue.ts';
import { MongoDatabase } from '../drivers/mongo/database.ts';
import { MongoTaskQueue } from '../drivers/mongo/taskQueue.ts';
import { ResizeConfigError, ResizeSetupError } from '../errors.ts';
import { onResetResizerForTests } from '../resizer.ts';
import type {
  FrameworkQueueConfig,
  FrameworkResizeConfig,
  QueueTimingOptions,
} from '../types.d.ts';
import { appLogger, getApp } from './app.ts';
import {
  getResizeConfig,
  type ResolvedFrameworkConfig,
  resolveFrameworkConfig,
} from './config.ts';

export interface FrameworkDatabaseOptions {
  modelName?: string; // the host media model; default: mediaModelName from the config
  configName?: string; // the config file; default 'resize'
  config?: FrameworkResizeConfig; // an explicit config instead of reading `configName`
}

/** A config that may select a shared backend: a FrameworkResizer's, or a host-built database's. */
export interface QueueUser {
  source: string; // the config as messages name it, e.g. src/config/resize.ts
  read: () => ResolvedFrameworkConfig;
  // The shared backend this config's tasks wait on (see backendKey), or undefined for none.
  backend: (config: ResolvedFrameworkConfig) => string | undefined;
}

/** The backend key of the app's ResizeTask queue. */
export const DATABASE_BACKEND = 'database';

const queueUsers = new Set<QueueUser>();
const backendQueues = new Map<string, TaskQueue>();
let appQueue: MongoTaskQueue | undefined;
// Set while a FrameworkResizer builds its own database: the Resizer registers its use of the queue
// itself, because only it knows whether it uses the queue at all (`tasks: false`, explicit tasks).
let buildingForResizer = false;

onResetResizerForTests(() => {
  queueUsers.clear();
  backendQueues.clear();
  appQueue = undefined;
});

/** Register a config whose timing a shared backend must agree with. */
export function addQueueUser(user: QueueUser): void {
  queueUsers.add(user);
}

/** The shared backend a config's `queue` section selects: its key, or undefined for none. */
export function backendKey(
  queue: FrameworkQueueConfig | false,
): string | undefined {
  if (queue === false) {
    return undefined;
  }
  if (queue.driver !== 'sqs') {
    return DATABASE_BACKEND;
  }
  // One SQS backend per set of queue settings; the order of the named queues does not matter.
  const { queueUrl, queues, deadLetterQueueUrl, region, endpoint } = queue;
  const named = Object.entries(queues ?? {}).sort(([a], [b]) =>
    a < b ? -1 : 1,
  );
  return `sqs:${JSON.stringify([queueUrl, named, deadLetterQueueUrl ?? null, region ?? null, endpoint ?? null])}`;
}

// SqsTaskQueue's long poll when `waitTimeSeconds` is not set. Keep in step with the driver's own
// default (`this.#opts.waitTimeSeconds ?? 10` in SqsTaskQueue.claim, src/drivers/sqs.ts), which is
// not imported here: that module loads the optional AWS SDK.
const SQS_DEFAULT_WAIT_TIME_SECONDS = 10;

// What the configs sharing a backend must agree on: the timing, and the effective SQS long poll.
function queueSettings(
  config: ResolvedFrameworkConfig,
): Record<string, unknown> {
  const { queue, timing } = config;
  return queue !== false && queue.driver === 'sqs'
    ? {
        ...timing,
        waitTimeSeconds: queue.waitTimeSeconds ?? SQS_DEFAULT_WAIT_TIME_SECONDS,
      }
    : { ...timing };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (
    typeof a !== 'object' ||
    a === null ||
    typeof b !== 'object' ||
    b === null
  ) {
    return Object.is(a, b);
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) =>
    sameValue(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
    ),
  );
}

/**
 * The timing of the shared backend `key`: the timing of every config that uses it, which must
 * agree (ResizeConfigError RESIZE_CONFIG_QUEUE_TIMING_CONFLICT otherwise). A config that cannot be
 * read is skipped here: its own Resizer reports it. No config: the defaults.
 */
export function backendTiming(key: string): Partial<QueueTimingOptions> {
  let first:
    | {
        source: string;
        settings: Record<string, unknown>;
        timing: QueueTimingOptions;
      }
    | undefined;
  for (const user of queueUsers) {
    let config: ResolvedFrameworkConfig;
    try {
      config = user.read();
    } catch {
      continue;
    }
    if (user.backend(config) !== key) {
      continue;
    }
    const settings = queueSettings(config);
    if (!first) {
      first = { source: user.source, settings, timing: config.timing };
      continue;
    }
    const reference = first.settings;
    const differ = [
      ...new Set([...Object.keys(reference), ...Object.keys(settings)]),
    ].filter((name) => !sameValue(reference[name], settings[name]));
    if (differ.length > 0) {
      throw new ResizeConfigError(
        `resize config: ${first.source} and ${user.source} use the same task queue but set different ${differ.join(', ')} — one task queue has one timing, so set the same values in both`,
        { code: 'RESIZE_CONFIG_QUEUE_TIMING_CONFLICT' },
      );
    }
  }
  return first?.timing ?? {};
}

/** Check the shared backend `user` selects, if any: throws on a timing conflict. */
export function checkQueueUser(user: QueueUser): void {
  const key = user.backend(user.read());
  if (key !== undefined) {
    backendTiming(key);
  }
}

/**
 * The task queue of the shared backend `key`, built once per process. The timing is checked on
 * every call, so each Resizer that loads the queue sees a conflict.
 */
export function sharedQueue(
  key: string,
  build: (timing: Partial<QueueTimingOptions>) => TaskQueue,
): TaskQueue {
  const timing = backendTiming(key);
  let tasks = backendQueues.get(key);
  if (!tasks) {
    tasks = build(timing);
    backendQueues.set(key, tasks);
  }
  return tasks;
}

/** The process's one MongoTaskQueue over the app's ResizeTask model. */
function appTaskQueue(): MongoTaskQueue {
  appQueue ??= new MongoTaskQueue({
    getModel: () => getApp().getModel('ResizeTask'),
    getTiming: () => backendTiming(DATABASE_BACKEND),
    logger: appLogger,
  });
  return appQueue;
}

/** True when `tasks` is the app's shared ResizeTask queue. */
export function isAppTaskQueue(tasks: TaskQueue | undefined): boolean {
  return tasks !== undefined && tasks === appQueue;
}

/** A FrameworkDatabase for a FrameworkResizer, which registers its own use of the queue. */
export function databaseForResizer(
  opts: FrameworkDatabaseOptions,
): FrameworkDatabase {
  buildingForResizer = true;
  try {
    return new FrameworkDatabase(opts);
  } finally {
    buildingForResizer = false;
  }
}

export class FrameworkDatabase extends MongoDatabase {
  readonly #queueUser: QueueUser | undefined;

  constructor(opts: FrameworkDatabaseOptions = {}) {
    const read = () =>
      opts.config
        ? resolveFrameworkConfig(opts.config, opts.configName)
        : getResizeConfig(opts.configName);
    super({
      // An unregistered name is a config error, never "media missing": the worker completes tasks
      // for deleted media as no-ops, so a missing model would silently drop every task.
      getMediaModel: () => {
        const name = opts.modelName ?? read().mediaModelName;
        const model = getApp().getModel(name);
        if (!model) {
          throw new ResizeConfigError(
            `resize config: mediaModelName '${name}' is not a registered model — set it in the host src/config/${opts.configName ?? 'resize'}.ts`,
            { code: 'RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN' },
          );
        }
        return model;
      },
      tasks: appTaskQueue(),
    });
    // A database the host builds uses the queue when its config selects the 'database' driver.
    if (!buildingForResizer) {
      this.#queueUser = {
        source: opts.config
          ? 'the config passed to new FrameworkDatabase()'
          : `src/config/${opts.configName ?? 'resize'}.ts`,
        read,
        backend: (config) =>
          backendKey(config.queue) === DATABASE_BACKEND
            ? DATABASE_BACKEND
            : undefined,
      };
      addQueueUser(this.#queueUser);
    }
  }

  /**
   * Startup check: the media model must resolve and store preview identities, the framework's
   * `Lock` model must resolve, and (for a database the host built) the queue timing must agree.
   */
  verify(): void {
    this.verifyMediaModel();
    if (!getApp().getModel('Lock')) {
      throw new ResizeSetupError(
        "resize: the framework's Lock model is not registered — FrameworkDatabase keeps its locks there",
        { code: 'RESIZE_MONGO_MODEL_MISSING' },
      );
    }
    if (this.#queueUser) {
      checkQueueUser(this.#queueUser);
    }
  }

  // The framework Lock TTL is in seconds; round up so a sub-second TTL never becomes a 0-second
  // (immediately expired) lock.
  async acquireLock(key: string, ttlMs: number): Promise<boolean> {
    const acquired = await getApp()
      .getModel('Lock')
      .acquireLock(key, Math.ceil(ttlMs / 1000));
    return Boolean(acquired);
  }

  async releaseLock(key: string): Promise<void> {
    await getApp().getModel('Lock').releaseLock(key);
  }
}
