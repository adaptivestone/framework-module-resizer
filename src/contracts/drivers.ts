// Driver factories: how a config section becomes a part. A driver is registered by name per kind
// (`drivers.storage.local`, `drivers.queue.sqs`, …) and is anything with a `fromConfig` function: a
// class with a static method (LocalFsStorage) or a plain object. The factory checks that by duck
// typing, and checks the part each factory returns the same way.
import type { QueueTimingOptions, ResizeLogger } from '../types.d.ts';
import type { LockStore } from './locks.ts';
import type { MediaStore } from './media.ts';
import type { ResizeStorage } from './storage.ts';
import type { TaskQueue } from './taskQueue.ts';

/** What every driver factory is given beside its section. */
export interface DriverContext {
  logger: ResizeLogger;
  /** The config as messages name it, e.g. a config file, for the driver's own errors. */
  where: string;
}

// Each factory's type parameter is its section type, which always has the `driver` name. It
// defaults to just that, so a registry (whose values use the default) holds every concrete driver.

/** Builds the storage from the config's `storage` section. */
export interface StorageDriver<
  S extends { driver: string } = { driver: string },
> {
  fromConfig(
    section: S,
    ctx: DriverContext,
  ): ResizeStorage | Promise<ResizeStorage>;
}

/** What a database driver builds: the media store, and the parts that share its connection. */
export interface DatabaseParts {
  media: MediaStore;
  /** Used only beside a task queue without `gatesByTask`, for its gate locks. */
  locks?: LockStore;
  /** A task queue on this database, serving exactly `queues`, each with its own timing. */
  taskQueue?(opts: {
    queues: readonly string[];
    getTiming(queue: string): Partial<QueueTimingOptions> | undefined;
    logger: ResizeLogger;
  }): TaskQueue;
}

/** Builds the database parts from the config's `database` section. */
export interface DatabaseDriver<
  S extends { driver: string } = { driver: string },
> {
  fromConfig(
    section: S,
    ctx: DriverContext,
  ): DatabaseParts | Promise<DatabaseParts>;
}

/**
 * One entry of `queues` as every queue driver reads it: its `driver` name. A driver's own section
 * type adds its keys (an interface such as SqsQueueConfig fits, which an index signature would
 * refuse).
 */
export interface QueueSection {
  driver: string;
}

/** One `queues` entry, validated: its name, the section as the config holds it, its timing. */
export interface QueueEntry<S extends QueueSection = QueueSection> {
  name: string;
  section: S;
  /** Complete and validated: the entry's timing keys over the defaults. */
  timing: QueueTimingOptions;
}

/** What a queue driver's `fromConfig` is given beside its entries. */
export interface QueueDriverContext extends DriverContext {
  /** The database parts, when the config has a `database` section. */
  database: DatabaseParts | undefined;
}

/**
 * Builds task queues from `queues` entries. Grouping names into backends and comparing entries
 * (two SQS names with one URL) are the driver's knowledge, and both must work before the driver's
 * own module, and any optional package it needs, is loaded; hence `backendOf` and `validate` beside
 * `fromConfig`.
 */
export interface QueueDriver<S extends QueueSection = QueueSection> {
  /**
   * Optional, synchronous, loads nothing: the backend an entry's tasks wait in; the entries with
   * one answer share one task queue. Default: every entry of this driver is one backend.
   */
  backendOf?(section: S): string;
  /**
   * Optional, synchronous, loads nothing: checks every entry of this driver at once, so it can
   * compare them. Throws a ResizeConfigError naming `ctx.where`.
   */
  validate?(entries: readonly QueueEntry<S>[], ctx: { where: string }): void;
  /** The entries of ONE backend → that backend's task queue, serving exactly their names. */
  fromConfig(
    entries: readonly QueueEntry<S>[],
    ctx: QueueDriverContext,
  ): TaskQueue | Promise<TaskQueue>;
}

/** Drivers by kind and name. A host's drivers win over the built-in ones of the same name. */
export interface DriverRegistry {
  storage?: Record<string, StorageDriver>;
  database?: Record<string, DatabaseDriver>;
  queue?: Record<string, QueueDriver>;
}
