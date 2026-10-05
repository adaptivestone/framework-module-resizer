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

/**
 * The media model methods the database calls (any Mongoose model has them). Writes go through
 * `findOneAndUpdate`, so the host's findOneAndUpdate middleware sees them; it resolves with the
 * matched document (only its `_id` is requested) or null. When the model also exposes its
 * `schema`, verify() checks it keeps the preview fields the database relies on.
 */
export interface MongoMediaModel {
  modelName?: string;
  findById(id: string): PromiseLike<unknown>;
  findOneAndUpdate(
    filter: object,
    update: object,
    options: { projection: { _id: 1 } },
  ): PromiseLike<unknown>;
}

// Each write asks for the matched document's id only, not the whole media document.
const ID_ONLY = { projection: { _id: 1 as const } };

// The part of a Mongoose schema verify() reads (types only: no mongoose import).
interface SchemaLike {
  path(path: string): unknown;
  options: { strict?: unknown };
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
    this.verifyMediaModel();
    this.lockModel();
  }

  /**
   * The media model must resolve, and its preview rows must keep `identity`. Only rows declared as
   * sub-documents with a strict shape lose it (Mongoose strict mode strips an undeclared field from
   * every row, and every worker that renders a variant would then add its own row); a mixed or
   * plain array, or rows with `strict: false`, keep any field.
   */
  protected verifyMediaModel(): void {
    const model = this.mediaModel();
    const schema = (model as { schema?: Partial<SchemaLike> }).schema;
    if (typeof schema?.path !== 'function') {
      return;
    }
    const previews = schema.path('previews') as
      | { instance?: string; schema?: Partial<SchemaLike> }
      | undefined;
    const rows = previews?.instance === 'Array' ? previews.schema : undefined;
    if (
      typeof rows?.path === 'function' &&
      rows.options?.strict !== false &&
      !rows.path('identity')
    ) {
      throw new ResizeSetupError(
        `resize: the media model ${model.modelName ? `'${model.modelName}' ` : ''}has no previews.identity field, so Mongoose would drop it and a preview rendered twice would be stored twice — spread the current resizeMediaSchemaFragment into the media model's schema`,
        { code: 'RESIZE_MONGO_MEDIA_MODEL_OUTDATED' },
      );
    }
  }

  async loadMedia(mediaId: string): Promise<MediaLike | null> {
    return (await this.mediaModel().findById(mediaId)) as MediaLike | null;
  }

  async appendPreviews(
    mediaId: string,
    previews: Preview[],
    backfillDims?: { width: number; height: number },
  ): Promise<Preview[]> {
    const model = this.mediaModel();
    // When the worker measured the original, set its dimensions first: a reader that sees the
    // previews then sees the dimensions too. Applied whether or not any preview is stored.
    if (backfillDims) {
      await model.findOneAndUpdate(
        { _id: mediaId },
        {
          $set: {
            'original.width': backfillDims.width,
            'original.height': backfillDims.height,
          },
        },
        ID_ONLY,
      );
    }
    // One conditional write per preview: the filter and the push are atomic on the document, so of
    // two workers that rendered the same identity only one stores its row (the other matches
    // nothing: null). A preview without an identity is always stored, and a row stored before rows
    // carried one never blocks a new row. Missing media matches nothing: a silent no-op.
    const stored: Preview[] = [];
    for (const preview of previews) {
      const filter =
        preview.identity === undefined
          ? { _id: mediaId }
          : { _id: mediaId, 'previews.identity': { $ne: preview.identity } };
      const matched = await model.findOneAndUpdate(
        filter,
        { $push: { previews: preview } },
        ID_ONLY,
      );
      if (matched) {
        stored.push(preview);
      }
    }
    return stored;
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
