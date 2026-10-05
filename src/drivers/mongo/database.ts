// MongoDatabase: the module's records in MongoDB — media documents (a host model whose schema
// spreads resizeMediaSchemaFragment), locks (a ResizeLock model) and, as `tasks`, the queue (a
// ResizeTask model). `mongoDatabase(connection, …)` builds it with the package's models.
import { ResizeDatabase } from '../../contracts/database.ts';
import { ResizeSetupError } from '../../errors.ts';
import type {
  MediaLike,
  Preview,
  QueueTimingOptions,
  ResizeLogger,
} from '../../types.d.ts';
import { createResizeModels } from './models.ts';
import { MongoTaskQueue } from './taskQueue.ts';

/** The media model methods the database calls (any Mongoose model has them). */
export interface MongoMediaModel {
  modelName?: string;
  findById(id: string): PromiseLike<unknown>;
  findByIdAndUpdate(id: string, update: object): PromiseLike<unknown>;
}

/** The lock model methods the database calls (any Mongoose model has them). */
export interface MongoLockModel {
  create(doc: { _id: string; expiredAt: Date }): PromiseLike<unknown>;
  updateOne(
    filter: object,
    update: object,
  ): PromiseLike<{ modifiedCount: number }>;
  deleteOne(filter: object): PromiseLike<unknown>;
}

export interface MongoDatabaseOptions {
  // The host media model, or a getter called on each use (for a model registered later).
  mediaModel?: MongoMediaModel;
  getMediaModel?: () => MongoMediaModel | null | undefined;
  // The ResizeLock model, or a getter. Optional when a subclass overrides the lock methods.
  lockModel?: MongoLockModel;
  getLockModel?: () => MongoLockModel | null | undefined;
  tasks?: MongoTaskQueue; // the queue kept in this database
}

const DUPLICATE_KEY = 11000;

export class MongoDatabase extends ResizeDatabase {
  readonly tasks: MongoTaskQueue | undefined = undefined;
  readonly #getMediaModel: () => MongoMediaModel | null | undefined;
  readonly #getLockModel: () => MongoLockModel | null | undefined;

  constructor(opts: MongoDatabaseOptions) {
    super();
    const { mediaModel, getMediaModel, lockModel, getLockModel } = opts ?? {};
    if ((mediaModel === undefined) === (getMediaModel === undefined)) {
      throw new ResizeSetupError(
        'resize: MongoDatabase needs exactly one of `mediaModel` or `getMediaModel`',
        { code: 'RESIZE_MONGO_MODEL_REQUIRED' },
      );
    }
    this.#getMediaModel = getMediaModel ?? (() => mediaModel);
    this.#getLockModel = getLockModel ?? (() => lockModel);
    this.tasks = opts.tasks;
  }

  /**
   * The media model. One that does not resolve (e.g. a misspelled name) is a setup error, never
   * "media missing": the worker would otherwise retry every task until it is dead.
   */
  protected mediaModel(): MongoMediaModel {
    const model = this.#getMediaModel();
    if (!model) {
      throw new ResizeSetupError(
        'resize: the media model does not resolve — check the model name',
        { code: 'RESIZE_MONGO_MODEL_MISSING' },
      );
    }
    return model;
  }

  protected lockModel(): MongoLockModel {
    const model = this.#getLockModel();
    if (!model) {
      throw new ResizeSetupError(
        'resize: MongoDatabase has no lock model — pass `lockModel` (createResizeModels gives ResizeLock)',
        { code: 'RESIZE_MONGO_MODEL_MISSING' },
      );
    }
    return model;
  }

  /**
   * Startup check: the media and lock models must resolve (the queue checks its own model). A
   * missing lock model would otherwise fail every variant at run time and dead-letter its tasks.
   */
  verify(): void {
    this.mediaModel();
    this.lockModel();
  }

  async loadMedia(mediaId: string): Promise<MediaLike | null> {
    return (await this.mediaModel().findById(mediaId)) as MediaLike | null;
  }

  async appendPreviews(
    mediaId: string,
    previews: Preview[],
    backfillDims?: { width: number; height: number },
  ): Promise<void> {
    // One atomic write: push the previews and, when the worker measured the original, set its
    // dimensions in the same update.
    const update: {
      $push: { previews: { $each: Preview[] } };
      $set?: { 'original.width': number; 'original.height': number };
    } = { $push: { previews: { $each: previews } } };
    if (backfillDims) {
      update.$set = {
        'original.width': backfillDims.width,
        'original.height': backfillDims.height,
      };
    }
    await this.mediaModel().findByIdAndUpdate(mediaId, update);
  }

  // A lock is a document whose id is the key; a TTL index removes expired ones, and an expired
  // lock that is still present is taken over atomically (only one caller matches `$lte: now`).
  async acquireLock(key: string, ttlMs: number): Promise<boolean> {
    const model = this.lockModel();
    const now = new Date();
    const expiredAt = new Date(now.getTime() + ttlMs);
    try {
      await model.create({ _id: key, expiredAt });
      return true;
    } catch (err) {
      if ((err as { code?: number }).code !== DUPLICATE_KEY) {
        throw err;
      }
    }
    const result = await model.updateOne(
      { _id: key, expiredAt: { $lte: now } },
      { $set: { expiredAt } },
    );
    return result.modifiedCount === 1;
  }

  async releaseLock(key: string): Promise<void> {
    await this.lockModel().deleteOne({ _id: key });
  }
}

export interface MongoDatabaseFactoryOptions {
  mediaModel: MongoMediaModel; // the host media model (its schema spreads resizeMediaSchemaFragment)
  timing?: Partial<QueueTimingOptions>; // queue timing; missing values use the defaults
  logger?: ResizeLogger;
}

/**
 * A MongoDatabase on `connection` with the package's ResizeTask and ResizeLock models (registered
 * with autoIndex off: create their indexes through your migration process).
 */
export function mongoDatabase(
  // biome-ignore lint/suspicious/noExplicitAny: a Mongoose connection (types only, no import)
  connection: any,
  opts: MongoDatabaseFactoryOptions,
): MongoDatabase {
  const { ResizeTask, ResizeLock } = createResizeModels(connection, {
    ...(opts.mediaModel.modelName
      ? { mediaModelName: opts.mediaModel.modelName }
      : {}),
  });
  return new MongoDatabase({
    mediaModel: opts.mediaModel,
    lockModel: ResizeLock,
    tasks: new MongoTaskQueue({
      model: ResizeTask,
      ...(opts.timing ? { timing: opts.timing } : {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
    }),
  });
}
