// createResizer: a whole Resizer from one config object and the drivers registered by name. The
// config holds the image settings (merged over the package defaults) and the sections: `storage`,
// `database`, `queue`, `queues` and `coordination`; each section names its driver, a built-in one
// (src/factory/builtins.ts) or one the host registers in `drivers`. The Resizer is returned at
// once; its parts are built on first use, and options given in code win over the config.
// configuredOptions turns any config source into Resizer options; the framework adapter passes it
// a source over its config files.
import type {
  DatabaseDriver,
  DatabaseParts,
  DriverContext,
  DriverRegistry,
  QueueDriver,
  QueueEntry,
  StorageDriver,
} from '../contracts/drivers.ts';
import type { LockStore } from '../contracts/locks.ts';
import type { MediaStore } from '../contracts/media.ts';
import type { ResizeStorage } from '../contracts/storage.ts';
import type { TaskQueue } from '../contracts/taskQueue.ts';
import { ResizeConfigError, ResizeSetupError } from '../errors.ts';
import { Registry } from '../registry.ts';
import { Resizer, type ResizerOptions, sharedPart } from '../resizer.ts';
import { isRouter } from '../routing.ts';
import type {
  CoordinationOptions,
  ResizeConfig,
  ResizeLogger,
} from '../types.d.ts';
import { builtinDrivers, probeDriver } from './builtins.ts';
import { mergeImageConfig } from './image.ts';
import { chooseLane, type Lane } from './lane.ts';
import { planQueueSet, type ShareFn } from './queueSet.ts';
import {
  driverChoice,
  resolveQueueEntries,
  validateQueueDrivers,
} from './queues.ts';
import type { ResizerConfig } from './types.ts';

/** The options of createResizer: every Resizer option, the host's drivers, and parts in code. */
export interface CreateResizerOptions<
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
    | 'queueName'
  > {
  // The host's drivers by kind and name; each must have a fromConfig function. A host driver
  // under a built-in name ('local', 's3', 'mongo', 'database', 'sqs') replaces that one.
  drivers?: D;
  storage?: ResizeStorage; // default: built from the config's `storage`
  media?: MediaStore; // default: the media store of the config's `database`
  // default: the lock store of the config's `database`, beside a task queue that takes gate locks
  locks?: LockStore;
  // default: the task queue of the config's `queues`; false: eager only, whatever the config says
  tasks?: TaskQueue | false;
  coordination?: CoordinationOptions; // default: the config's `coordination`
  queueName?: string; // default: the config's `queue`
}

/** The sections that belong to one Resizer. */
export interface OwnSections {
  image: unknown; // the image settings, before the merge over the package defaults
  storage?: unknown;
  queue?: unknown;
}

/** The sections a config source may share between Resizers. */
export interface ProcessSections {
  queues: readonly QueueEntry[]; // resolved and checked by resolveQueueEntries
  coordination: CoordinationOptions | null | undefined; // as the config holds it
  // The `validate` functions of queue drivers the source already ran on these entries.
  validated: ReadonlySet<QueueDriver['validate']>;
}

/** Where configuredOptions reads a config from. */
export interface ConfigSource {
  own(): OwnSections;
  process(): ProcessSections; // read only when needed: the lane, or `coordination`
  database(): unknown; // the `database` section; read on first need
  // own() can be read at construction: the image settings are merged and validated then.
  eager?: true;
  // The database parts are built at construction when the driver's fromConfig is synchronous,
  // so `media` (and `locks` beside a task queue in code) are readable at once.
  eagerDatabase?: true;
  where: {
    own: string; // the Resizer's config, as messages name it
    process: string; // the config of `queues` and `coordination`, as messages name it
    queuesIn?: string; // how the queue-name messages name that config (default: `process`)
  };
  // The end of the RESIZE_CONFIG_STORAGE_MISSING message: how else to give the storage, e.g.
  // "or pass `storage` to createResizer()".
  storageAdvice: string;
}

/** What configuredOptions takes beyond the createResizer options. */
export interface ConfiguredOptions
  extends CreateResizerOptions<DriverRegistry> {
  // A key prefix: the queue set and each backend are kept in the process registry under it, so
  // every Resizer of the source shares them; default: kept by this Resizer alone.
  shareQueues?: string;
  queueLogger?: ResizeLogger; // the queue drivers' logger; default: `logger`
}

const WHERE = 'the config passed to createResizer()';

const KINDS = ['storage', 'database', 'queue'] as const;
type Kind = (typeof KINDS)[number];

/** Drivers by kind and name: the built-in ones, with the host's over them. */
interface Drivers {
  storage: Record<string, StorageDriver>;
  database: Record<string, DatabaseDriver>;
  queue: Record<string, QueueDriver>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === 'object' || typeof value === 'function') &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function';

const hasMethods = (value: unknown, methods: readonly string[]): boolean =>
  isRecord(value) && methods.every((m) => typeof value[m] === 'function');

const invalidConfig = (message: string): ResizeConfigError =>
  new ResizeConfigError(`resize config: ${message}`, {
    code: 'RESIZE_CONFIG_INVALID',
  });

const driverInvalid = (message: string): ResizeSetupError =>
  new ResizeSetupError(`resize: ${message}`, {
    code: 'RESIZE_DRIVER_INVALID',
    retryable: false,
  });

const mediaRequired = (where: string): ResizeSetupError =>
  new ResizeSetupError(
    `resize: \`media\` is required — set database: { driver: 'mongo', connection, mediaModel } (or a registered database driver) in ${where}, or pass \`media\` in the options`,
    { code: 'RESIZE_MEDIA_REQUIRED' },
  );

/**
 * Build a Resizer from one config: an object, checked now (its image settings merged over the
 * package defaults and validated, its `queues` entries resolved), or a function, called on first
 * use. Every part is built on first use through the driver its section names, a built-in one or
 * one in `opts.drivers`; options given in code win over the config.
 */
// biome-ignore lint/complexity/noBannedTypes: `{}` is the empty registry, the default when a host registers no driver
export function createResizer<D extends DriverRegistry = {}>(
  config: ResizerConfig<D> | (() => ResizerConfig<D>),
  opts: CreateResizerOptions<D> = {},
): Resizer {
  return new Resizer(configuredOptions(sourceOf(config), opts));
}

/** The config split into its sections. */
interface Split {
  own: OwnSections;
  process: ProcessSections;
  database: unknown;
}

/** The config source of createResizer: one config, read once (a function on first use). */
function sourceOf(config: unknown): ConfigSource {
  let split: Split | undefined;
  const read = (): Split => {
    split ??= splitConfig(typeof config === 'function' ? config() : config);
    return split;
  };
  const lazy = typeof config === 'function';
  if (!lazy) {
    read();
  }
  return {
    own: () => read().own,
    process: () => read().process,
    database: () => read().database,
    ...(lazy ? {} : { eager: true as const }),
    where: { own: WHERE, process: WHERE },
    storageAdvice: 'or pass `storage` to createResizer()',
  };
}

function splitConfig(value: unknown): Split {
  if (!isRecord(value)) {
    throw invalidConfig(`${WHERE} must be an object`);
  }
  const { storage, database, queue, queues, coordination, ...image } = value;
  return {
    own: { image, storage, queue },
    process: {
      queues: resolveQueueEntries(queues, WHERE),
      coordination: coordination as CoordinationOptions | null | undefined,
      validated: new Set(),
    },
    database,
  };
}

/**
 * The Resizer options of `source`, with `opts` winning over it. The host's drivers are checked
 * now (RESIZE_DRIVER_INVALID), before the Resizer claims its name. Each part is a function the
 * Resizer calls on first use: the storage and the database parts through the drivers their
 * sections name, the task queue through the queue set of `queues`.
 */
export function configuredOptions(
  source: ConfigSource,
  opts: ConfiguredOptions,
): ResizerOptions {
  const {
    drivers: hostDrivers,
    storage,
    media,
    locks,
    tasks,
    coordination,
    queueName,
    shareQueues,
    queueLogger,
    ...rest
  } = opts;
  const drivers = driversOf(hostDrivers);
  const logger = rest.logger ?? console;
  const { where } = source;
  const ownCtx: DriverContext = { logger, where: where.own };

  // The own sections, with the storage section's driver checked once per object read.
  let checkedOwn: OwnSections | undefined;
  const readOwn = (): OwnSections => {
    const own = source.own();
    if (own !== checkedOwn) {
      if (own.storage !== undefined) {
        selected(own.storage, drivers.storage, 'storage', where.own);
      }
      checkedOwn = own;
    }
    return own;
  };
  // The process sections, with every queue entry's driver checked once per object read.
  const checkedProcess = new WeakSet<ProcessSections>();
  const readProcess = (): ProcessSections => {
    const process = source.process();
    if (!checkedProcess.has(process)) {
      validateQueueDrivers(
        process.queues,
        drivers.queue,
        where.process,
        process.validated,
      );
      checkedProcess.add(process);
    }
    return process;
  };

  // The queue of this Resizer's tasks, chosen once; a choice that fails is made again next time.
  let lane: Lane<QueueEntry> | undefined;
  const readLane = (): Lane<QueueEntry> => {
    lane ??= chooseLane({
      resizer: rest.name ?? 'default',
      where: where.own,
      queuesIn: where.queuesIn ?? where.process,
      option: queueName,
      file: readOwn().queue,
      fromCode: tasks !== undefined,
      queues: () =>
        new Map(readProcess().queues.map((entry) => [entry.name, entry])),
    });
    return lane;
  };

  // The database parts, built once; a failed build is built again on the next need.
  let eager: { parts: DatabaseParts | undefined } | undefined;
  let building: Promise<DatabaseParts | undefined> | undefined;
  const keep = (parts: Promise<DatabaseParts | undefined>) => {
    building = parts.catch((err: unknown) => {
      building = undefined;
      throw err;
    });
    return building;
  };
  const startParts = () =>
    databasePartsOf(source.database(), drivers.database, ownCtx);
  if (source.eagerDatabase) {
    try {
      const started = startParts();
      if (isThenable(started)) {
        // Nothing awaits it before first use: a rejection is forgotten here (the build runs
        // again then and rejects there), never left unhandled.
        keep(Promise.resolve(started)).catch(() => {});
      } else {
        eager = { parts: started };
      }
    } catch {
      // Reported on first use, where the build runs again.
    }
  }
  const databaseParts = (): Promise<DatabaseParts | undefined> =>
    eager
      ? Promise.resolve(eager.parts)
      : (building ?? keep((async () => startParts())()));
  const mediaOfParts = async (): Promise<MediaStore> => {
    const parts = await databaseParts();
    if (!parts) {
      throw mediaRequired(where.own);
    }
    return parts.media;
  };

  // The queue set of `queues`, built once (in the process registry with `shareQueues`).
  const share: ShareFn = shareQueues
    ? (key, build) => sharedPart(`${shareQueues}:${key}`, build)
    : localShare();
  const queueSet = (): Promise<TaskQueue> =>
    share('queues', () =>
      planQueueSet(readProcess().queues, drivers.queue, {
        where: where.process,
        logger: queueLogger ?? logger,
        database: databaseParts,
        share,
      }).taskQueue(),
    );
  const tasksPart = async (): Promise<TaskQueue | undefined> =>
    readLane().entry ? queueSet() : undefined;
  const locksOf = async (
    queue: TaskQueue | undefined,
  ): Promise<LockStore | undefined> =>
    takesGateLocks(queue) ? (await databaseParts())?.locks : undefined;

  const imageOf = (own: OwnSections): ResizeConfig =>
    mergeImageConfig(own.image) as ResizeConfig;
  return {
    ...rest,
    // A config read at construction has its storage driver checked then too, even when the
    // storage is given in code.
    config: source.eager ? imageOf(readOwn()) : () => imageOf(readOwn()),
    storage:
      storage ??
      (() =>
        storageOf(
          readOwn().storage,
          drivers.storage,
          ownCtx,
          source.storageAdvice,
        )),
    media: media ?? eager?.parts?.media ?? mediaOfParts,
    locks:
      locks ??
      (tasks === false
        ? undefined
        : tasks
          ? eager
            ? takesGateLocks(tasks)
              ? eager.parts?.locks
              : undefined
            : () => locksOf(tasks)
          : async () => locksOf(await tasksPart())),
    ...(tasks === false ? {} : { tasks: tasks ?? tasksPart }),
    // Only `undefined` takes the defaults: null and any other value go to the core, which
    // validates them.
    coordination:
      coordination ??
      (() => {
        const value = readProcess().coordination;
        return (value === undefined ? {} : value) as CoordinationOptions;
      }),
    // A name given in code is readable at once; one from the config once the Resizer is used.
    queueName: queueName ?? (() => readLane().queueName),
  };
}

/**
 * Whether `tasks` takes gate locks, so it needs the database parts' lock store: a router (a name
 * whose backend lacks gatesByTask needs it), or a task queue without gatesByTask.
 */
function takesGateLocks(tasks: TaskQueue | undefined): boolean {
  return tasks !== undefined && (isRouter(tasks) || !tasks.gatesByTask);
}

/** A cache of builds kept by one Resizer alone. */
function localShare(): ShareFn {
  const builds = new Registry<{ name: string }>();
  return (key, build) => builds.shared(key, build);
}

/** The built-in drivers with the host's over them; each host driver checked. */
function driversOf(host: unknown): Drivers {
  if (host === undefined) {
    return { ...builtinDrivers };
  }
  if (!isRecord(host)) {
    throw driverInvalid(
      '`drivers` must be an object of storage, database and queue drivers by name',
    );
  }
  for (const kind of Object.keys(host)) {
    if (!(KINDS as readonly string[]).includes(kind)) {
      throw driverInvalid(
        `\`drivers.${kind}\` is not a driver kind — \`drivers\` holds storage, database and queue`,
      );
    }
  }
  const merged = (kind: Kind) => {
    const own = host[kind];
    if (own === undefined) {
      return builtinDrivers[kind];
    }
    if (!isRecord(own)) {
      throw driverInvalid(
        `\`drivers.${kind}\` must be an object of ${kind} drivers by name`,
      );
    }
    for (const [name, driver] of Object.entries(own)) {
      checkDriver(driver, kind, name);
    }
    return { ...builtinDrivers[kind], ...own };
  };
  return {
    storage: merged('storage') as Drivers['storage'],
    database: merged('database') as Drivers['database'],
    queue: merged('queue') as Drivers['queue'],
  };
}

/** A driver is anything with a fromConfig function: a class with a static one, or an object. */
function checkDriver(driver: unknown, kind: Kind, name: string): void {
  const value = driver as Record<string, unknown> | null;
  const shaped =
    (typeof driver === 'object' || typeof driver === 'function') &&
    driver !== null;
  if (!shaped || typeof value?.fromConfig !== 'function') {
    throw driverInvalid(
      `\`drivers.${kind}.${name}\` needs a fromConfig function (a class with a static fromConfig, or an object with one)`,
    );
  }
  if (kind === 'queue') {
    for (const optional of ['backendOf', 'validate']) {
      if (
        value[optional] !== undefined &&
        typeof value[optional] !== 'function'
      ) {
        throw driverInvalid(
          `\`drivers.queue.${name}\`.${optional} must be a function when given`,
        );
      }
    }
  }
}

/** The driver `section` names among `drivers`, or RESIZE_CONFIG_INVALID listing the names. */
function selected<T>(
  section: unknown,
  drivers: Record<string, T>,
  path: 'storage' | 'database',
  where: string,
): [string, T] {
  const name = isRecord(section) ? section.driver : undefined;
  if (typeof name !== 'string' || !Object.hasOwn(drivers, name)) {
    throw invalidConfig(
      `\`${path}\` in ${where} needs driver ${driverChoice(Object.keys(drivers))}`,
    );
  }
  return [name, drivers[name]];
}

/** The storage of `section` through its driver; no section is RESIZE_CONFIG_STORAGE_MISSING. */
async function storageOf(
  section: unknown,
  drivers: Record<string, StorageDriver>,
  ctx: DriverContext,
  advice: string,
): Promise<ResizeStorage> {
  if (section === undefined) {
    throw new ResizeConfigError(
      `resize config: \`storage\` is missing — set storage: { driver: 'local', rootDir, publicBaseUrl } (or driver 's3') in ${ctx.where}, ${advice}`,
      { code: 'RESIZE_CONFIG_STORAGE_MISSING' },
    );
  }
  const [name, driver] = selected(section, drivers, 'storage', ctx.where);
  const missing = probeDriver(driver, name, ctx.where);
  if (missing) {
    throw missing.error;
  }
  const built: unknown = await driver.fromConfig(
    section as { driver: string },
    ctx,
  );
  if (!hasMethods(built, ['upload', 'download', 'publicUrl'])) {
    throw driverInvalid(
      `\`drivers.storage.${name}\` (\`storage\` in ${ctx.where}) built something that is not a storage (upload, download and publicUrl)`,
    );
  }
  return built as ResizeStorage;
}

/**
 * The database parts of `section` through its driver (undefined without a section): the parts
 * themselves when the driver's fromConfig is synchronous, else a promise of them.
 */
function databasePartsOf(
  section: unknown,
  drivers: Record<string, DatabaseDriver>,
  ctx: DriverContext,
): DatabaseParts | undefined | Promise<DatabaseParts> {
  if (section === undefined) {
    return undefined;
  }
  const [name, driver] = selected(section, drivers, 'database', ctx.where);
  const missing = probeDriver(driver, name, ctx.where);
  if (missing) {
    throw missing.error;
  }
  const check = (parts: unknown): DatabaseParts => {
    if (
      !isRecord(parts) ||
      !hasMethods(parts.media, [
        'loadMedia',
        'appendPreviews',
        'replacePreviews',
      ])
    ) {
      throw driverInvalid(
        `\`drivers.database.${name}\` (\`database\` in ${ctx.where}) built no media store (loadMedia, appendPreviews and replacePreviews)`,
      );
    }
    return parts as unknown as DatabaseParts;
  };
  const built: unknown = driver.fromConfig(section as { driver: string }, ctx);
  return isThenable(built) ? Promise.resolve(built).then(check) : check(built);
}
