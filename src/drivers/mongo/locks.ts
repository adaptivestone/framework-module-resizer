// MongoLockStore: locks as documents of a ResizeLock model (see createResizeModels). The lock key
// is the document id and the owner is stored with it; every write is atomic and conditional, so of
// several callers racing for a key only one matches. A TTL index removes expired locks, and one
// that is still present is taken over by the next acquire.
import { LockStore } from '../../contracts/locks.ts';
import { ResizeSetupError } from '../../errors.ts';
import { resolveModelOption } from './modelOption.ts';

/**
 * The lock model methods the store calls (any Mongoose model has them). When the model also
 * exposes its `schema`, verify() checks it keeps the `owner` field. Every call passes
 * `strictQuery: false`, a Mongoose query option that other implementations may ignore: a
 * schema that does not declare `owner` with `strictQuery: true` would otherwise drop `owner` from
 * the filter, so a release or extend would match another owner's lock.
 */
export interface MongoLockModel {
  modelName?: string;
  findOneAndUpdate(
    filter: object,
    update: object,
    options: { upsert: true; strictQuery: false },
  ): PromiseLike<unknown>;
  updateOne(
    filter: object,
    update: object,
    options?: { strictQuery: false },
  ): PromiseLike<{ matchedCount: number }>;
  deleteOne(
    filter: object,
    options?: { strictQuery: false },
  ): PromiseLike<{ deletedCount?: number }>;
}

export interface MongoLockStoreOptions {
  // The ResizeLock model, or a getter called on each use (for a model registered later).
  model?: MongoLockModel;
  getModel?: () => MongoLockModel | null | undefined;
}

// The part of a Mongoose schema verify() reads (types only: no mongoose import).
interface SchemaLike {
  path(path: string): unknown;
  options: { strict?: unknown };
}

const DUPLICATE_KEY = 11000;

// The filters always keep `owner` and `expiredAt`, whatever the schema's strictQuery says.
const KEEP_FILTER = { strictQuery: false } as const;

export class MongoLockStore extends LockStore {
  readonly #model: () => MongoLockModel;

  constructor(opts: MongoLockStoreOptions) {
    super();
    this.#model = resolveModelOption(opts, {
      driver: 'MongoLockStore',
      missing:
        'resize: MongoLockStore has no lock model — pass `model` (createResizeModels gives ResizeLock)',
    });
  }

  protected lockModel(): MongoLockModel {
    return this.#model();
  }

  /**
   * Startup check: the lock model must resolve, or every variant would fail at run time, and a
   * strict schema must declare `owner`. Mongoose strict mode drops an undeclared field, so no
   * release or extend would ever match its lock (e.g. a ResizeLock model registered on the
   * connection before this package version, which createResizeModels returns as it is).
   */
  verify(): void {
    const model = this.lockModel();
    const schema = (model as { schema?: Partial<SchemaLike> }).schema;
    if (
      typeof schema?.path === 'function' &&
      schema.options?.strict !== false &&
      !schema.path('owner')
    ) {
      throw new ResizeSetupError(
        `resize: the lock model ${model.modelName ? `'${model.modelName}' ` : ''}has no owner field, so Mongoose would drop it and no lock could be released before it expires — add owner: { type: String } to its schema (see resizeLockFields)`,
        { code: 'RESIZE_MONGO_LOCK_MODEL_OUTDATED' },
      );
    }
  }

  // One write: a free key is inserted, and a taken key matches only once its lock has expired (or
  // has no expiry), so of racing callers one wins. A live lock does not match, so the upsert tries
  // to insert the same _id, which fails with a duplicate key: not acquired.
  async acquire(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const now = new Date();
    try {
      await this.lockModel().findOneAndUpdate(
        {
          _id: key,
          $or: [{ expiredAt: { $lte: now } }, { expiredAt: null }],
        },
        { $set: { owner, expiredAt: new Date(now.getTime() + ttlMs) } },
        { upsert: true, ...KEEP_FILTER },
      );
    } catch (err) {
      if ((err as { code?: number }).code === DUPLICATE_KEY) {
        return false;
      }
      throw err;
    }
    return true;
  }

  // Only the owner's live lock: an expired one may already belong to the next acquire.
  async extend(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const now = new Date();
    const result = await this.lockModel().updateOne(
      { _id: key, owner, expiredAt: { $gt: now } },
      { $set: { expiredAt: new Date(now.getTime() + ttlMs) } },
      KEEP_FILTER,
    );
    return result.matchedCount === 1;
  }

  // Compare-and-delete: deletes the owner's lock, expired or not, never another owner's.
  async release(key: string, owner: string): Promise<boolean> {
    const result = await this.lockModel().deleteOne(
      { _id: key, owner },
      KEEP_FILTER,
    );
    return result.deletedCount === 1;
  }
}
