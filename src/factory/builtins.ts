// The drivers a config can name without registering them: storage 'local' and 's3', database
// 'mongo', queues 'database' and 'sqs'. Each driver module is imported only inside its entry's
// fromConfig, with a literal dynamic import, so the main entry reaches no driver and an optional
// SDK loads only when a config selects its driver. The drivers that need an optional package
// declare it here, and probeDriver asks the resolver for it before anything is built (it loads
// nothing), so a backend whose SDK is missing can be left out without loading its driver.
import type {
  DatabaseDriver,
  QueueDriver,
  StorageDriver,
} from '../contracts/drivers.ts';
import type { ResizeSetupError } from '../errors.ts';
import { importDriver, probePeers } from '../helpers/peers.ts';
import { sqsBackendKey, validateSqsEntries } from '../helpers/queueSections.ts';
import type {
  LocalStorageConfig,
  MongoDatabaseConfig,
  S3StorageConfig,
  SqsQueueConfig,
} from '../types.d.ts';
import { databaseQueueDriver } from './databaseQueue.ts';

const S3_PEERS = ['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner'];
const SQS_PEERS = ['@aws-sdk/client-sqs'];

const local: StorageDriver<LocalStorageConfig> = {
  async fromConfig(section, ctx) {
    const { LocalFsStorage } = await importDriver(
      () => import('../drivers/fs.ts'),
      'local',
      [],
      ctx.where,
    );
    return LocalFsStorage.fromConfig(section, ctx);
  },
};

const s3: StorageDriver<S3StorageConfig> = {
  async fromConfig(section, ctx) {
    const { S3Storage } = await importDriver(
      () => import('../drivers/s3.ts'),
      's3',
      S3_PEERS,
      ctx.where,
    );
    return S3Storage.fromConfig(section, ctx);
  },
};

const mongo: DatabaseDriver<MongoDatabaseConfig> = {
  async fromConfig(section, ctx) {
    const { MongoDatabase } = await importDriver(
      () => import('../drivers/mongo/database.ts'),
      'mongo',
      [],
      ctx.where,
    );
    return MongoDatabase.fromConfig(section, ctx);
  },
};

// Grouping and checking the SQS entries need no SDK: both come from the peer-free helpers.
const sqs: QueueDriver<SqsQueueConfig> = {
  backendOf: sqsBackendKey,
  validate: validateSqsEntries,
  async fromConfig(entries, ctx) {
    const { SqsTaskQueue } = await importDriver(
      () => import('../drivers/sqs.ts'),
      'sqs',
      SQS_PEERS,
      `\`queues.${entries[0]?.name}\` in ${ctx.where}`,
    );
    return SqsTaskQueue.fromConfig(entries, ctx);
  },
};

/** The built-in drivers by kind and name; a host's drivers of the same name win over them. */
export const builtinDrivers: {
  storage: Record<string, StorageDriver>;
  database: Record<string, DatabaseDriver>;
  queue: Record<string, QueueDriver>;
} = {
  storage: { local, s3 },
  database: { mongo },
  queue: { database: databaseQueueDriver, sqs },
};

// The optional packages of each built-in driver that needs one, by driver object: a host driver
// registered under the same name is not the built-in one and is never probed.
const PEERS = new Map<object, readonly string[]>([
  [s3, S3_PEERS],
  [sqs, SQS_PEERS],
]);

/** The optional packages `driver` needs (none for a host driver or a peer-free built-in). */
export function peersOf(driver: object): readonly string[] {
  return PEERS.get(driver) ?? [];
}

/**
 * The RESIZE_PEER_MISSING error when an optional package of `driver` (registered as `name`,
 * selected in `where`) cannot be resolved from here; undefined when all of them resolve or it
 * needs none. Nothing is loaded.
 */
export function probeDriver(
  driver: object,
  name: string,
  where: string,
): ResizeSetupError | undefined {
  const peers = peersOf(driver);
  return peers.length === 0
    ? undefined
    : probePeers(peers, name, where, (specifier) =>
        import.meta.resolve(specifier),
      );
}
