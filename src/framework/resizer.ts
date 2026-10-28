// FrameworkResizer: a Resizer wired from the framework app. The core takes every part explicitly;
// this subclass builds them from the Resizer's config file, so a framework host's src/resizer.ts
// holds only behaviour (pipelines, hooks):
// - config: the file's image settings;
// - media: FrameworkMediaStore (the app's media model, `mediaModelName` in the file);
// - locks: FrameworkLockStore (the framework's own Lock model) beside a task queue without
//   gatesByTask (the 'sqs' driver), for its gate locks; none beside the database queue, which
//   keeps the gate in its task rows, and none for an eager-only Resizer;
// - storage: the file's `storage` section ('local' or 's3');
// - tasks: the file's `queue` section ('database', 'sqs', or false / missing for eager only);
// - coordination: the file's `coordination` section, which the core validates;
// - logger and events: the app's.
// Options win over the config file. Nothing is read from the app until first use, and the AWS
// drivers (optional peers) are imported only when the config selects them. The task queues this
// builds are shared per backend (see ./queue.ts): Resizers whose config selects the same backend
// get the same queue object, so the worker runs one loop for it, and their timing must agree.
import type { LockStore } from '../contracts/locks.ts';
import type { MediaStore } from '../contracts/media.ts';
import type { ResizeStorage } from '../contracts/storage.ts';
import type { TaskQueue } from '../contracts/taskQueue.ts';
import { LocalFsStorage } from '../drivers/fs.ts';
import { ResizeConfigError, ResizeSetupError } from '../errors.ts';
import { Resizer, type ResizerOptions } from '../resizer.ts';
import type {
  CoordinationOptions,
  FrameworkResizeConfig,
  ResizeEventBus,
  ResizeLogger,
} from '../types.d.ts';
import { appEvents, appLogger } from './app.ts';
import {
  getResizeConfig,
  type ResolvedFrameworkConfig,
  resolveFrameworkConfig,
} from './config.ts';
import { FrameworkLockStore } from './locks.ts';
import { FrameworkMediaStore } from './media.ts';
import {
  addQueueUser,
  appTaskQueue,
  backendKey,
  backendTiming,
  checkQueueUser,
  DATABASE_BACKEND,
  type QueueUser,
  sharedQueue,
} from './queue.ts';

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
  queueName?: string; // the queue name of this Resizer's tasks; default 'default'
  config?: FrameworkResizeConfig; // an explicit config instead of reading `configName`
  storage?: ResizeStorage; // default: built from the config's `storage`
  media?: MediaStore; // default: FrameworkMediaStore over the config's `mediaModelName`
  // default: FrameworkLockStore (the framework's Lock model) beside a task queue without
  // gatesByTask (SQS); none beside the database queue or without a task queue
  locks?: LockStore;
  // default: built from the config's `queue`; `false` = eager only, whatever the config says
  tasks?: TaskQueue | false;
  coordination?: CoordinationOptions; // default: the config's `coordination`
  logger?: ResizeLogger; // default: the app logger
  events?: ResizeEventBus; // default: the app event bus
}

/**
 * A Resizer wired from the framework app and its config file. Import `src/resizer.ts` anywhere,
 * even before the framework is initialized: the config, models and drivers are read on first use.
 * Call `await resizer.verify()` after `Server.init()` to check everything at boot.
 */
export class FrameworkResizer extends Resizer {
  // This Resizer's config as a user of a shared task queue; unset with an explicit `tasks` or
  // `tasks: false`.
  readonly #queueUser: QueueUser | undefined;

  constructor(opts: FrameworkResizerOptions = {}) {
    const {
      configName,
      config: explicitConfig,
      storage,
      media,
      locks,
      tasks,
      coordination,
      logger,
      events,
      ...rest
    } = opts;
    // An explicit config is validated now; a config file is read on first use.
    const explicit = explicitConfig
      ? resolveFrameworkConfig(explicitConfig, configName)
      : undefined;
    const read = (): ResolvedFrameworkConfig =>
      explicit ?? getResizeConfig(configName);
    const file = `src/config/${configName ?? 'resize'}.ts`;
    // The task queue from the config, built once for the `tasks` part and the default `locks`
    // part: the parts load in parallel, so the lock store waits for the same build. A failed
    // build is forgotten, so the next call retries it.
    let building: Promise<TaskQueue | undefined> | undefined;
    const configQueue = (): Promise<TaskQueue | undefined> => {
      building ??= buildQueue(read(), file).catch((err: unknown) => {
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
      storage: storage ?? (() => buildStorage(read(), file)),
      media:
        media ??
        new FrameworkMediaStore(
          explicitConfig
            ? { config: explicitConfig, configName }
            : { configName },
        ),
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
        (explicit
          ? explicit.coordination
          : () => {
              const own = read().coordination;
              return own === undefined ? {} : own;
            }),
    });
    // Registered once constructed (a rejected name or config registers nothing).
    if (tasks === undefined) {
      this.#queueUser = {
        source: explicit
          ? `the config passed to new FrameworkResizer({ name: '${this.name}' })`
          : file,
        read,
        backend: (config) => backendKey(config.queue),
      };
      addQueueUser(this.#queueUser);
    }
  }

  /**
   * The core checks, then the timing of the shared task queue again: a Resizer constructed after
   * this one loaded its queue is compared here too.
   */
  async verify(): Promise<void> {
    await super.verify();
    if (this.#queueUser) {
      checkQueueUser(this.#queueUser);
    }
  }
}

/** The lock store for the gate locks of `tasks`: needed only beside a queue without gatesByTask. */
function gateLockStore(tasks: TaskQueue | undefined): LockStore | undefined {
  return tasks && !tasks.gatesByTask ? new FrameworkLockStore() : undefined;
}

async function importDriver<T>(
  load: () => Promise<T>,
  driver: string,
  peers: string[],
  file: string,
): Promise<T> {
  try {
    return await load();
  } catch (err) {
    if (
      err instanceof Error &&
      'code' in err &&
      (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND')
    ) {
      const missing = /^Cannot find (?:package|module) ['"]([^'"]+)['"]/.exec(
        err.message,
      )?.[1];
      if (missing && peers.includes(missing)) {
        throw new ResizeSetupError(
          `resize config: the '${driver}' driver selected in ${file} requires missing optional peer \`${missing}\` — install ${peers.join(' ')}`,
          { code: 'RESIZE_PEER_MISSING', cause: err },
        );
      }
    }
    throw err;
  }
}

async function buildStorage(
  config: ResolvedFrameworkConfig,
  file: string,
): Promise<ResizeStorage> {
  const { storage } = config;
  if (!storage) {
    throw new ResizeConfigError(
      `resize config: \`storage\` is missing — set storage: { driver: 'local', rootDir, publicBaseUrl } (or driver 's3') in ${file}, or pass \`storage\` to new FrameworkResizer()`,
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
    file,
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

async function buildQueue(
  config: ResolvedFrameworkConfig,
  file: string,
): Promise<TaskQueue | undefined> {
  const { queue } = config;
  if (queue === false) {
    return undefined;
  }
  if (queue.driver === 'sqs') {
    const { SqsTaskQueue } = await importDriver(
      () => import('../drivers/sqs.ts'),
      'sqs',
      ['@aws-sdk/client-sqs'],
      file,
    );
    // One SqsTaskQueue per SQS queue in the process, with the timing its configs agree on.
    return sharedQueue(
      backendKey(queue) as string,
      (timing) =>
        new SqsTaskQueue({
          queueUrl: queue.queueUrl,
          ...(queue.queues ? { queues: queue.queues } : {}),
          ...(queue.deadLetterQueueUrl
            ? { deadLetterQueueUrl: queue.deadLetterQueueUrl }
            : {}),
          ...(queue.waitTimeSeconds === undefined
            ? {}
            : { waitTimeSeconds: queue.waitTimeSeconds }),
          ...(queue.region ? { region: queue.region } : {}),
          ...(queue.endpoint ? { endpoint: queue.endpoint } : {}),
          timing,
          logger: appLogger,
        }),
    );
  }
  // 'database': the app's one task queue over its ResizeTask model. The core reads a queue's
  // timing once; check it here so every Resizer sees a conflict on its own first use.
  backendTiming(DATABASE_BACKEND);
  return appTaskQueue();
}
