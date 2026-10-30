// FrameworkResizer: a Resizer wired from the framework app. The core takes every part explicitly;
// this subclass builds them from the config files, so a framework host's src/resizer.ts holds only
// behaviour (pipelines, hooks):
// - config: the image settings of the Resizer's file (`configName`, default 'resize');
// - media: FrameworkMediaStore (the app's media model, `mediaModelName` in that file);
// - storage: that file's `storage` section ('local' or 's3');
// - queueName and tasks: that file's `queue` names one of the `queues` in src/config/resize.ts (no
//   `queue`: 'default' when there are queues, else eager only; false: eager only); the task queue
//   is the one of that queue's backend, shared by every Resizer on it (see ./queue.ts);
// - locks: FrameworkLockStore (the framework's own Lock model) beside a task queue without
//   gatesByTask (SQS), for its gate locks; none beside the database queue, which keeps the gate in
//   its task rows, and none for an eager-only Resizer;
// - coordination: `coordination` in src/config/resize.ts, which the core validates;
// - logger and events: the app's.
// Options win over the config files. Nothing is read from the app until first use, and the AWS
// drivers (optional peers) are imported only when the config selects them.
import type { LockStore } from '../contracts/locks.ts';
import type { MediaStore } from '../contracts/media.ts';
import type { ResizeStorage } from '../contracts/storage.ts';
import type { TaskQueue } from '../contracts/taskQueue.ts';
import { LocalFsStorage } from '../drivers/fs.ts';
import { ResizeConfigError } from '../errors.ts';
import { type Lane as ChosenLane, chooseLane } from '../factory/lane.ts';
import { importDriver } from '../helpers/peers.ts';
import { Resizer, type ResizerOptions } from '../resizer.ts';
import type {
  CoordinationOptions,
  FrameworkResizeConfig,
  ResizeEventBus,
  ResizeLogger,
} from '../types.d.ts';
import { appEvents, appLogger } from './app.ts';
import {
  type ConfigSource,
  getProcessConfig,
  getResizeConfig,
  type ResolvedFrameworkConfig,
  type ResolvedProcessConfig,
  type ResolvedQueue,
  resolveFrameworkConfig,
  sourceName,
} from './config.ts';
import { FrameworkLockStore } from './locks.ts';
import { FrameworkMediaStore } from './media.ts';
import { taskQueueOf } from './queue.ts';

export interface FrameworkResizerOptions
  extends Omit<
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
  config?: FrameworkResizeConfig; // an explicit config instead of reading `configName`
  storage?: ResizeStorage; // default: built from the config's `storage`
  media?: MediaStore; // default: FrameworkMediaStore over the config's `mediaModelName`
  // default: FrameworkLockStore (the framework's Lock model) beside a task queue without
  // gatesByTask (SQS); none beside the database queue or without a task queue
  locks?: LockStore;
  // default: the task queue of the Resizer's queue in `queues` of src/config/resize.ts; `false` =
  // eager only, whatever the config says. Given here, the queue is not chosen from `queues`, but a
  // src/config/resize.ts that exists is still validated whole when `coordination` is read from it.
  tasks?: TaskQueue | false;
  coordination?: CoordinationOptions; // default: `coordination` in src/config/resize.ts
  logger?: ResizeLogger; // default: the app logger
  events?: ResizeEventBus; // default: the app event bus
}

/**
 * A Resizer wired from the framework app and its config files. Import `src/resizer.ts` anywhere,
 * even before the framework is initialized: the config, models and drivers are read on first use.
 * Call `await resizer.verify()` after `Server.init()` to check everything at boot.
 */
export class FrameworkResizer extends Resizer {
  constructor(opts: FrameworkResizerOptions = {}) {
    const {
      configName = 'resize',
      config: explicitConfig,
      queueName,
      storage,
      media,
      locks,
      tasks,
      coordination,
      logger,
      events,
      ...rest
    } = opts;
    const source: ConfigSource = {
      configName,
      explicit: explicitConfig !== undefined,
    };
    // An explicit config is validated now; a config file is read on first use.
    const explicit = explicitConfig
      ? resolveFrameworkConfig(explicitConfig, source)
      : undefined;
    const read = (): ResolvedFrameworkConfig =>
      explicit ?? getResizeConfig(configName);
    const where = sourceName(source);
    // The queue this Resizer's tasks go to, chosen on first use and kept once chosen; a choice
    // that fails (e.g. a name `queues` does not define) is made again on the next call.
    let lane: Lane | undefined;
    const readLane = (): Lane => {
      if (!lane) {
        const chosen = chooseLane<ResolvedQueue>({
          resizer: rest.name ?? 'default',
          where,
          queuesIn: 'src/config/resize.ts',
          option: queueName,
          file: read().queue,
          fromCode: tasks !== undefined,
          queues: () => getProcessConfig().queues,
        });
        lane = {
          ...chosen,
          processConfig: chosen.entry ? getProcessConfig() : undefined,
        };
      }
      return lane;
    };
    // The task queue of that queue, built once for the `tasks` part and the default `locks` part:
    // the parts load in parallel, so the lock store waits for the same build. A failed build is
    // forgotten, so the next call retries it.
    let building: Promise<TaskQueue | undefined> | undefined;
    const configQueue = (): Promise<TaskQueue | undefined> => {
      building ??= (async () => {
        const { entry, processConfig } = readLane();
        return entry && processConfig
          ? taskQueueOf(entry, processConfig)
          : undefined;
      })().catch((err: unknown) => {
        building = undefined;
        throw err;
      });
      return building;
    };
    super({
      ...rest,
      config: explicit ? explicit.image : () => read().image,
      logger: logger ?? appLogger,
      events: events ?? appEvents,
      storage: storage ?? (() => buildStorage(read(), where)),
      media:
        media ??
        new FrameworkMediaStore(
          explicitConfig
            ? { config: explicitConfig, configName }
            : { configName },
        ),
      // A name given in code is readable at once; one from the file once the Resizer is used.
      queueName: queueName ?? (() => readLane().queueName),
      // Only a task queue without gatesByTask takes gate locks, so only then does verify() need
      // the framework Lock model.
      locks:
        locks ??
        (tasks === false
          ? undefined
          : tasks
            ? gateLockStore(tasks)
            : async () => gateLockStore(await configQueue())),
      ...(tasks === false ? {} : { tasks: tasks ?? configQueue }),
      // Read only beside a task queue, when the core sets it up; the core validates it (a file
      // without the section gives {}: the defaults; any other value, null too, is validated as
      // it is).
      coordination:
        coordination ??
        (() => {
          const own = getProcessConfig().coordination;
          return own === undefined ? {} : own;
        }),
    });
  }
}

/** The queue a Resizer's tasks go to: its name, and the `queues` entry to build the task queue for. */
interface Lane extends ChosenLane<ResolvedQueue> {
  processConfig: ResolvedProcessConfig | undefined;
}

/** The lock store for the gate locks of `tasks`: needed only beside a queue without gatesByTask. */
function gateLockStore(tasks: TaskQueue | undefined): LockStore | undefined {
  return tasks && !tasks.gatesByTask ? new FrameworkLockStore() : undefined;
}

async function buildStorage(
  config: ResolvedFrameworkConfig,
  where: string,
): Promise<ResizeStorage> {
  const { storage } = config;
  if (!storage) {
    throw new ResizeConfigError(
      `resize config: \`storage\` is missing — set storage: { driver: 'local', rootDir, publicBaseUrl } (or driver 's3') in ${where}, or pass \`storage\` to new FrameworkResizer()`,
      { code: 'RESIZE_CONFIG_STORAGE_MISSING' },
    );
  }
  // Only each driver's own keys: resize.<NODE_ENV>.ts merges field by field, so switching the
  // driver there leaves the other driver's keys (e.g. rootDir) in the merged section.
  if (storage.driver === 'local') {
    const { rootDir, publicBaseUrl, privateRootDir } = storage;
    return new LocalFsStorage({
      rootDir,
      publicBaseUrl,
      ...(privateRootDir === undefined ? {} : { privateRootDir }),
    });
  }
  const {
    bucketPublic,
    bucketPrivate,
    publicBaseUrl,
    region,
    endpoint,
    forcePathStyle,
  } = storage;
  const { S3Storage } = await importDriver(
    () => import('../drivers/s3.ts'),
    's3',
    ['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner'],
    where,
  );
  return new S3Storage(
    Object.fromEntries(
      Object.entries({
        bucketPublic,
        bucketPrivate,
        publicBaseUrl,
        region,
        endpoint,
        forcePathStyle,
      }).filter(([, value]) => value !== undefined),
    ) as { bucketPublic: string },
  );
}
