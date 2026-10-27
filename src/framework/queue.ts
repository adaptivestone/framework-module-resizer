// The framework adapter's task queues: one per backend in the process. FrameworkResizers whose
// config selects the 'database' driver share the app's one MongoTaskQueue over its ResizeTask
// model, and those that select the same SQS queue share one SqsTaskQueue, so the worker runs one
// consume loop per backend. Timing belongs to the backend: it comes from the config of every
// Resizer that uses it, and those must agree.
import type { TaskQueue } from '../contracts/taskQueue.ts';
import { MongoTaskQueue } from '../drivers/mongo/taskQueue.ts';
import { ResizeConfigError } from '../errors.ts';
import { onResetResizerForTests } from '../resizer.ts';
import type { FrameworkQueueConfig, QueueTimingOptions } from '../types.d.ts';
import { appLogger, getApp } from './app.ts';
import type { ResolvedFrameworkConfig } from './config.ts';

/** A config that may select a shared backend: a FrameworkResizer's. */
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
export function appTaskQueue(): MongoTaskQueue {
  appQueue ??= new MongoTaskQueue({
    getModel: () => getApp().getModel('ResizeTask'),
    getTiming: () => backendTiming(DATABASE_BACKEND),
    logger: appLogger,
  });
  return appQueue;
}
