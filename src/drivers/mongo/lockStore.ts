// MongoLockStore: locks as documents of a ResizeLock model (see createResizeModels). A lock is a
// document whose id is the key; a TTL index removes expired ones, and an expired lock that is still
// present can be taken over atomically.
import { LockStore } from '../../contracts/lockStore.ts';
import { ResizeSetupError } from '../../errors.ts';

/** The model methods the lock store calls (any Mongoose model has them). */
export interface MongoLockModel {
  create(doc: { _id: string; expiredAt: Date }): PromiseLike<unknown>;
  updateOne(
    filter: object,
    update: object,
  ): PromiseLike<{ modifiedCount: number }>;
  deleteOne(filter: object): PromiseLike<unknown>;
}

export interface MongoLockStoreOptions {
  model?: MongoLockModel;
  getModel?: () => MongoLockModel;
}

const DUPLICATE_KEY = 11000;

export class MongoLockStore extends LockStore {
  readonly #getModel: () => MongoLockModel;

  constructor(opts: MongoLockStoreOptions) {
    super();
    if (!opts || (opts.model === undefined) === (opts.getModel === undefined)) {
      throw new ResizeSetupError(
        'resize: MongoLockStore needs exactly one of `model` or `getModel`',
        { code: 'RESIZE_MONGO_MODEL_REQUIRED' },
      );
    }
    const { model, getModel } = opts;
    this.#getModel = getModel ?? (() => model as MongoLockModel);
  }

  async acquire(key: string, ttlMs: number): Promise<boolean> {
    const model = this.#getModel();
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
    // The key exists: take it over only if it already expired (the TTL monitor runs ~once a
    // minute). The filter is evaluated atomically, so only one caller wins.
    const result = await model.updateOne(
      { _id: key, expiredAt: { $lte: now } },
      { $set: { expiredAt } },
    );
    return result.modifiedCount === 1;
  }

  async release(key: string): Promise<void> {
    await this.#getModel().deleteOne({ _id: key });
  }
}
