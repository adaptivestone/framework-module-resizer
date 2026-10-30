// Compiled by `npm run types:check` (tsconfig.test-helpers.json), never run. It pins the config
// types: the core section types and their deprecated framework names, the sections a registered
// custom driver adds, the nested partial a file that overrides part of a config writes, and the
// shipped drivers as drivers of their own sections.
import type {
  DatabaseDriver,
  DriverContext,
  DriverRegistry,
  QueueDriver,
  StorageDriver,
} from '../contracts/drivers.ts';
import type { ResizeStorage } from '../contracts/storage.ts';
import { LocalFsStorage } from '../drivers/fs.ts';
import { MongoDatabase } from '../drivers/mongo/index.ts';
import { S3Storage } from '../drivers/s3.ts';
import { SqsTaskQueue } from '../drivers/sqs.ts';
import { databaseQueueDriver } from '../factory/databaseQueue.ts';
import type { ResizerConfig } from '../factory/types.ts';
import { defaultFrameworkResizeConfig } from '../framework/defaults.ts';
import { sqsBackendKey, validateSqsEntries } from '../helpers/queueSections.ts';
import type {
  DatabaseQueueConfig,
  FrameworkLocalStorageConfig,
  FrameworkResizeConfig,
  LocalStorageConfig,
  MongoDatabaseConfig,
  PartialFrameworkResizeConfig,
  S3StorageConfig,
  SqsQueueConfig,
} from '../types.d.ts';
import { storage } from './contractShapes.ts';

export const local: LocalStorageConfig = {
  driver: 'local',
  rootDir: 'r',
  publicBaseUrl: '/m',
};
// The framework names stay as aliases of the core ones.
export const legacy: FrameworkLocalStorageConfig = local;

export const file = {
  ...defaultFrameworkResizeConfig,
  mediaModelName: 'File',
  storage: local,
  queue: 'default',
  queues: { default: { driver: 'database' } },
} satisfies FrameworkResizeConfig;

// biome-ignore lint/complexity/noStaticOnlyClass: pins that a class with a static fromConfig is a driver, as LocalFsStorage is
export class MemoryStorageDriver {
  static fromConfig(
    _section: { driver: 'memory'; bucket: string },
    _ctx: DriverContext,
  ): ResizeStorage {
    return storage;
  }
}

// A registry value is a class with a static fromConfig, or a plain object.
export const registry: DriverRegistry = {
  storage: { memory: MemoryStorageDriver },
};

export const custom: ResizerConfig<{
  storage: { memory: typeof MemoryStorageDriver };
}> = { storage: { driver: 'memory', bucket: 'b' } };

// Each directive sits on the line TypeScript reports the error on.
export const unregistered: ResizerConfig = {
  // @ts-expect-error a custom section without its driver registered
  storage: { driver: 'memory', bucket: 'b' },
};

export const wrong: ResizerConfig = {
  // @ts-expect-error rootDir must be a string
  storage: { driver: 'local', rootDir: 1, publicBaseUrl: '/m' },
};

export const partial: ResizerConfig = {
  formats: ['webp'],
  limits: { sourcePixels: 1 },
};

export const withCustom = {
  ...file,
  storage: { driver: 'memory', bucket: 'b' },
} satisfies FrameworkResizeConfig<{
  storage: { memory: typeof MemoryStorageDriver };
}>;

// A nested partial: a file that overrides part of a config.
export const override = {
  limits: { sourcePixels: 1 },
  encode: { sharpen: false },
  upload: { maxBytes: 10 },
} satisfies PartialFrameworkResizeConfig;

// The rc.2 form of an environment file still compiles.
export const envFile = {
  storage: { driver: 's3', bucketPublic: 'b' },
} satisfies Partial<FrameworkResizeConfig>;

export const shallow = {
  // @ts-expect-error Partial<> leaves nested keys required
  limits: { sourcePixels: 1 },
} satisfies Partial<FrameworkResizeConfig>;

export const wrongNested = {
  // @ts-expect-error a nested key still has its type
  limits: { sourcePixels: 'x' },
} satisfies PartialFrameworkResizeConfig;

// A custom queue driver adds its section to `queues`; the built-in kinds stay.
export const redisQueue: QueueDriver<{ driver: 'redis'; url: string }> = {
  validate: (entries, ctx) => {
    for (const entry of entries) {
      entry.section.url.startsWith(ctx.where);
    }
  },
  fromConfig: () => {
    throw new Error('never run');
  },
};
export const withRedis = {
  queues: {
    default: { driver: 'database' },
    bulk: { driver: 'redis', url: 'redis://r' },
  },
} satisfies ResizerConfig<{ queue: { redis: typeof redisQueue } }>;
export const redisWithoutUrl: ResizerConfig<{
  queue: { redis: typeof redisQueue };
}> = {
  // @ts-expect-error a custom queue section keeps its own required keys
  queues: { bulk: { driver: 'redis' } },
};

// Every concrete driver fits the registry, and one validator signature serves them all.
export const sqsQueue: QueueDriver<SqsQueueConfig> = {
  backendOf: (section) => section.queueUrl,
  validate: validateSqsEntries,
  fromConfig: () => {
    throw new Error('never run');
  },
};
export const memoryStorage: StorageDriver<{ driver: 'memory' }> = {
  fromConfig: () => storage,
};
export const allDrivers: DriverRegistry = {
  storage: { memory: memoryStorage, memoryClass: MemoryStorageDriver },
  queue: { redis: redisQueue, sqs: sqsQueue },
};

// The shipped drivers are drivers of their own sections, so the built-in table can hold them.
export const shippedDrivers: {
  local: StorageDriver<LocalStorageConfig>;
  s3: StorageDriver<S3StorageConfig>;
  mongo: DatabaseDriver<MongoDatabaseConfig>;
  database: QueueDriver<DatabaseQueueConfig>;
  sqs: QueueDriver<SqsQueueConfig>;
} = {
  local: LocalFsStorage,
  s3: S3Storage,
  mongo: MongoDatabase,
  database: databaseQueueDriver,
  sqs: {
    backendOf: sqsBackendKey,
    validate: validateSqsEntries,
    fromConfig: SqsTaskQueue.fromConfig,
  },
};
export const shippedRegistry: DriverRegistry = {
  storage: { local: LocalFsStorage, s3: S3Storage },
  database: { mongo: MongoDatabase },
  queue: { database: databaseQueueDriver, sqs: SqsTaskQueue },
};
