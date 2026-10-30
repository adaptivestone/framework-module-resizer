// The framework adapter's task queues: one per backend in the process. Every `queues` entry of
// src/config/resize.ts is a queue name. The entries on one backend (every 'database' entry, or the
// 'sqs' entries with the same connection settings) share one task queue object, so the worker runs
// one consume loop for it, and each name keeps its own timing. A task queue serves only the names
// of its own backend: a call that names a queue on another backend is refused by the core.
import type { TaskQueue } from '../contracts/taskQueue.ts';
import { MongoTaskQueue } from '../drivers/mongo/taskQueue.ts';
import { importDriver } from '../helpers/peers.ts';
import { sqsBackendKey } from '../helpers/queueSections.ts';
import { sharedPart } from '../resizer.ts';
import type {
  QueueConfig,
  QueueTimingOptions,
  SqsQueueConfig,
} from '../types.d.ts';
import { appLogger, getApp } from './app.ts';
import type { ResolvedProcessConfig, ResolvedQueue } from './config.ts';

// The file the queues are defined in, as configFile('resize') in ./config.ts names it (that module
// imports this one, so it is not imported back).
const QUEUES_FILE =
  'src/config/resize.ts (or its resize.<NODE_ENV>.ts override)';

/**
 * The backend a `queues` entry's tasks wait in: 'database' for every database entry (the app's
 * ResizeTask model); for SQS, one per region, endpoint, dead-letter queue and effective long poll,
 * the settings one SqsTaskQueue holds for all its names.
 */
export function backendKey(section: QueueConfig): string {
  return section.driver === 'sqs' ? sqsBackendKey(section) : 'database';
}

/**
 * The task queue of `queue`'s backend, built once per process for every name on that backend, each
 * with its own timing from `processConfig`. It is kept in the process registry, so
 * resetResizerForTests() forgets it with the Resizers, and a build that failed is built again on
 * the next call. The SQS driver is imported only when an SQS backend is built (RESIZE_PEER_MISSING
 * when @aws-sdk/client-sqs is not installed).
 */
export function taskQueueOf(
  queue: ResolvedQueue,
  processConfig: ResolvedProcessConfig,
): Promise<TaskQueue> {
  return sharedPart(`framework:queue:${queue.backend}`, () =>
    buildTaskQueue(queue, processConfig),
  );
}

async function buildTaskQueue(
  queue: ResolvedQueue,
  processConfig: ResolvedProcessConfig,
): Promise<TaskQueue> {
  const { backend, section } = queue;
  const names = [...processConfig.queues.values()].filter(
    (entry) => entry.backend === backend,
  );
  // Each name's own timing; the core reads it on that name's first use.
  const getTiming = (name: string): Partial<QueueTimingOptions> | undefined => {
    const entry = processConfig.queues.get(name);
    return entry?.backend === backend ? entry.timing : undefined;
  };
  if (section.driver !== 'sqs') {
    return new MongoTaskQueue({
      getModel: () => getApp().getModel('ResizeTask'),
      queues: names.map((entry) => entry.name),
      getTiming,
      logger: appLogger,
    });
  }
  const { SqsTaskQueue } = await importDriver(
    () => import('../drivers/sqs.ts'),
    'sqs',
    ['@aws-sdk/client-sqs'],
    `\`queues.${queue.name}\` in ${QUEUES_FILE}`,
  );
  // The connection settings are the same for every name on this backend (they make its key).
  const { deadLetterQueueUrl, waitTimeSeconds, region, endpoint } = section;
  return new SqsTaskQueue({
    queues: Object.fromEntries(
      names.map((entry) => [
        entry.name,
        (entry.section as SqsQueueConfig).queueUrl,
      ]),
    ),
    ...(deadLetterQueueUrl ? { deadLetterQueueUrl } : {}),
    ...(waitTimeSeconds === undefined ? {} : { waitTimeSeconds }),
    ...(region ? { region } : {}),
    ...(endpoint ? { endpoint } : {}),
    getTiming,
    logger: appLogger,
  });
}
