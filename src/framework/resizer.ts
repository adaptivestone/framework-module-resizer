// FrameworkResizer: a Resizer wired from the framework app. The core takes every part explicitly;
// this subclass reads them from the config files through the same factory as createResizer, so a
// framework host's src/resizer.ts holds only behaviour (pipelines, hooks):
// - config: the image settings of the Resizer's file (`configName`, default 'resize'), merged
//   over the package defaults;
// - media: FrameworkMediaStore (the app's media model, `mediaModelName` in that file);
// - storage: that file's `storage` section, through its driver ('local', 's3', or one the host
//   registers in `drivers`);
// - queueName and tasks: that file's `queue` names one of the `queues` in src/config/resize.ts (no
//   `queue`: 'default' when there are queues, else eager only; false: eager only). The task queue
//   holds every queue of the file, each on its backend: one backend's task queue itself, or a
//   router over several, whose backends are built when a queue on them is first used. Every
//   FrameworkResizer shares it;
// - locks: FrameworkLockStore (the framework's own Lock model) beside a task queue that takes gate
//   locks (SQS, or a router, which needs it only for a queue on SQS); none beside the database
//   queue, which keeps the gate in its task rows, and none for an eager-only Resizer;
// - coordination: `coordination` in src/config/resize.ts, which the core validates;
// - logger and events: the app's;
// - metrics: a LogMetrics on that logger, with its debug lines on.
// Options win over the config files. Nothing is read from the app until first use, and the AWS
// drivers (optional peers) are imported only when a queue or storage on them is used.
import type { DriverRegistry } from '../contracts/drivers.ts';
import type { LockStore } from '../contracts/locks.ts';
import type { MediaStore } from '../contracts/media.ts';
import type { ResizeStorage } from '../contracts/storage.ts';
import type { TaskQueue } from '../contracts/taskQueue.ts';
import { ResizeSetupError } from '../errors.ts';
import {
  configuredOptions,
  type ConfigSource as FactorySource,
  type ProcessSections,
} from '../factory/createResizer.ts';
import { LogMetrics } from '../metrics.ts';
import {
  Resizer,
  type ResizerOptions,
  recordedValue,
  sharedValue,
} from '../resizer.ts';
import type {
  CoordinationOptions,
  FrameworkResizeConfig,
  ResizeEventBus,
  ResizeLogger,
} from '../types.d.ts';
import { appEvents, appLogger } from './app.ts';
import {
  type ConfigSource,
  configFile,
  getProcessConfig,
  getResizeConfig,
  type ResolvedProcessConfig,
  resolveFrameworkConfig,
  sourceName,
} from './config.ts';
import { FrameworkDatabase, type FrameworkDatabaseConfig } from './database.ts';

export interface FrameworkResizerOptions<
  // biome-ignore lint/complexity/noBannedTypes: `{}` is the empty registry, the default when a host registers no driver
  D extends DriverRegistry = {},
> extends Omit<
    ResizerOptions,
    | 'config'
    | 'storage'
    | 'media'
    | 'locks'
    | 'tasks'
    | 'coordination'
    | 'logger'
    | 'events'
    | 'queueName'
  > {
  configName?: string; // the config file this Resizer reads; default 'resize'
  // The queue name of this Resizer's tasks, readable at once; default: the config file's `queue`
  // ('default' when it has none).
  queueName?: string;
  // The host's drivers by kind and name, which the config files can then name: storage drivers
  // for `storage`, queue drivers for the `queues` entries ('local', 's3', 'database' and 'sqs' are
  // built in; a host driver of the same name replaces one). Every FrameworkResizer shares one
  // task queue, so each must pass the same `drivers.queue` (RESIZE_DRIVER_CONFLICT otherwise).
  drivers?: D;
  config?: FrameworkResizeConfig<D>; // an explicit config instead of reading `configName`
  storage?: ResizeStorage; // default: built from the config's `storage`
  media?: MediaStore; // default: FrameworkMediaStore over the config's `mediaModelName`
  // default: FrameworkLockStore (the framework's Lock model) beside a task queue that takes gate
  // locks (SQS, or several backends); none beside the database queue or without a task queue
  locks?: LockStore;
  // default: the task queue of the `queues` in src/config/resize.ts; `false` = eager only,
  // whatever the config says. Given here, the queue is not chosen from `queues`, but a
  // src/config/resize.ts that exists is still validated whole when `coordination` is read from it.
  tasks?: TaskQueue | false;
  coordination?: CoordinationOptions; // default: `coordination` in src/config/resize.ts
  logger?: ResizeLogger; // default: the app logger
  events?: ResizeEventBus; // default: the app event bus
}

// The registry keys of what every FrameworkResizer in the process shares.
const SHARED_QUEUES = 'framework';
const QUEUE_DRIVERS_KEY = 'framework:queue-drivers';

/**
 * A Resizer wired from the framework app and its config files. Import `src/resizer.ts` anywhere,
 * even before the framework is initialized: the config, models and drivers are read on first use.
 * Call `await resizer.verify()` after `Server.init()` to check everything at boot.
 */
// biome-ignore lint/complexity/noBannedTypes: `{}` is the empty registry, the default when a host registers no driver
export class FrameworkResizer<D extends DriverRegistry = {}> extends Resizer {
  constructor(opts: FrameworkResizerOptions<D> = {}) {
    const {
      configName = 'resize',
      config,
      drivers,
      logger,
      events,
      ...rest
    } = opts;
    const options = configuredOptions(frameworkSource(configName, config), {
      ...rest,
      drivers: withFrameworkDatabase(drivers),
      logger: logger ?? appLogger,
      // The app logger decides whether debug lines are kept, so the default writes them. Only an
      // option left out takes it: any other value, null included, goes to the core's check.
      metrics:
        rest.metrics === undefined
          ? new LogMetrics(logger ?? appLogger, { debug: true })
          : rest.metrics,
      events: events ?? appEvents,
      // One queue set per process, built with the app logger, never one Resizer's. It is built
      // with the database parts of the first Resizer that needs it; FrameworkDatabase builds the
      // same task queue (the app's ResizeTask model) whichever Resizer that is, while each
      // Resizer keeps its own media store and lock store.
      shareQueues: SHARED_QUEUES,
      queueLogger: appLogger,
    });
    // After the drivers are checked and before the name is taken: the shared queue set is built
    // with the first Resizer's queue drivers, so every Resizer must name the same ones. They are
    // recorded only once this construction succeeds, as they are now.
    const queueDrivers = queueDriversOf(drivers);
    checkQueueDrivers(rest.name ?? 'default', queueDrivers);
    super(options);
    sharedValue(QUEUE_DRIVERS_KEY, queueDrivers);
  }
}

/**
 * The config source of a FrameworkResizer: its own sections from its file (or the `config`
 * option, checked now), the process-wide ones from src/config/resize.ts, and the constant
 * database section of FrameworkDatabase.
 */
function frameworkSource(
  configName: string,
  config: object | undefined,
): FactorySource {
  const source: ConfigSource = { configName, explicit: config !== undefined };
  const explicit = config ? resolveFrameworkConfig(config, source) : undefined;
  // The same sections object while src/config/resize.ts is unchanged, so the factory checks the
  // queue drivers once per value of the file.
  let last:
    | { config: ResolvedProcessConfig; sections: ProcessSections }
    | undefined;
  const database: FrameworkDatabaseConfig = {
    driver: 'framework',
    configName,
    ...(config ? { config: config as FrameworkDatabaseConfig['config'] } : {}),
  };
  return {
    own: () => explicit ?? getResizeConfig(configName),
    process: () => {
      const processConfig = getProcessConfig();
      if (last?.config !== processConfig) {
        last = {
          config: processConfig,
          sections: {
            queues: [...processConfig.queues.values()],
            coordination: processConfig.coordination,
            validated: processConfig.validated,
          },
        };
      }
      return last.sections;
    },
    database: () => database,
    ...(explicit ? { eager: true as const } : {}),
    eagerDatabase: true,
    where: {
      own: sourceName(source),
      process: configFile('resize'),
      queuesIn: 'src/config/resize.ts',
    },
    storageAdvice: 'or pass `storage` to new FrameworkResizer()',
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The host's drivers with FrameworkDatabase as the 'framework' database driver. A value that is
 * not an object of kinds is passed on as it is, for the factory to report.
 */
function withFrameworkDatabase(drivers: unknown): DriverRegistry {
  if (drivers !== undefined && !isRecord(drivers)) {
    return drivers as DriverRegistry;
  }
  const database = drivers?.database;
  if (database !== undefined && !isRecord(database)) {
    return drivers as DriverRegistry;
  }
  return {
    ...drivers,
    database: { ...database, framework: FrameworkDatabase },
  } as DriverRegistry;
}

/**
 * The `drivers.queue` map as passed now: a shallow copy, so a host that changes its object later
 * changes nothing that is compared.
 */
function queueDriversOf(drivers: unknown): Record<string, unknown> {
  return isRecord(drivers) && isRecord(drivers.queue)
    ? { ...drivers.queue }
    : {};
}

/**
 * Compare a Resizer's queue drivers with those recorded by the first FrameworkResizer constructed
 * in the process (none yet: nothing to compare), name by name and by driver identity: a
 * difference is RESIZE_DRIVER_CONFLICT, whichever Resizer came first.
 */
function checkQueueDrivers(
  resizer: string,
  own: Record<string, unknown>,
): void {
  const first =
    recordedValue<Record<string, unknown>>(QUEUE_DRIVERS_KEY) ?? own;
  const names = new Set([...Object.keys(first), ...Object.keys(own)]);
  const differs = [...names].find((name) => first[name] !== own[name]);
  if (differs !== undefined) {
    throw new ResizeSetupError(
      `resize: FrameworkResizer '${resizer}' has another \`drivers.queue.${differs}\` than the FrameworkResizers constructed before it — every FrameworkResizer shares one task queue, so pass each the same \`drivers.queue\` drivers`,
      { code: 'RESIZE_DRIVER_CONFLICT', retryable: false },
    );
  }
}
