// MongoLockStore: locks as documents of a ResizeLock model (see createResizeModels). The lock key
// is the document id and the owner is stored with it; every write is atomic and conditional, so of
// several callers racing for a key only one matches. A TTL index removes expired locks, and one
// that is still present is taken over by the next acquire.
import { LockStore } from '../../contracts/locks.ts';
import { resolveModelOption } from './modelOption.ts';

/** The lock model methods the store calls (any Mongoose model has them). */
export interface MongoLockModel {
  create(doc: {
    _id: string;
    owner: string;
    expiredAt: Date;
  }): PromiseLike<unknown>;
  updateOne(
    filter: object,
    update: object,
  ): PromiseLike<{ matchedCount: number }>;
  deleteOne(filter: object): PromiseLike<{ deletedCount?: number }>;
}

export interface MongoLockStoreOptions {
  // The ResizeLock model, or a getter called on each use (for a model registered later).
  model?: MongoLockModel;
  getModel?: () => MongoLockModel | null | undefined;
}

const DUPLICATE_KEY = 11000;

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

  /** Startup check: the lock model must resolve, or every variant would fail at run time. */
  verify(): void {
    this.lockModel();
  }

  // A free key is created; a taken key is taken over only once its lock has expired (of racing
  // callers, one matches `$lte: now`: its write moves the expiry past now).
  async acquire(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const model = this.lockModel();
    const now = new Date();
    const expiredAt = new Date(now.getTime() + ttlMs);
    try {
      await model.create({ _id: key, owner, expiredAt });
      return true;
    } catch (err) {
      if ((err as { code?: number }).code !== DUPLICATE_KEY) {
        throw err;
      }
    }
    const result = await model.updateOne(
      { _id: key, expiredAt: { $lte: now } },
      { $set: { owner, expiredAt } },
    );
    return result.matchedCount === 1;
  }

  // Only the owner's live lock: an expired one may already belong to the next acquire.
  async extend(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const now = new Date();
    const result = await this.lockModel().updateOne(
      { _id: key, owner, expiredAt: { $gt: now } },
      { $set: { expiredAt: new Date(now.getTime() + ttlMs) } },
    );
    return result.matchedCount === 1;
  }

  // Compare-and-delete: deletes the owner's lock, expired or not, never another owner's.
  async release(key: string, owner: string): Promise<boolean> {
    const result = await this.lockModel().deleteOne({ _id: key, owner });
    return result.deletedCount === 1;
  }
}
