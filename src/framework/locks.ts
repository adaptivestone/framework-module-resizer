// FrameworkLockStore: MongoLockStore over the framework's own `Lock` model (no extra collection),
// resolved on each use. The framework's Lock schema is strict and its statics take no owner, so
// this store writes the same documents (`_id`, `expiredAt`, plus `owner`) through the model's
// native collection, which strict mode does not filter. The owner then lives in the database: the
// worker releases locks the API process took, the framework's TTL index still removes
// expired locks, and the framework's own `acquireLock` still sees them. Its takeover of an expired
// lock (`$set: { expiredAt }`) leaves the stale `owner` field in place, so module locks and locks
// taken through the framework's statics must not share keys. Nothing is read from the app until
// first use; verify() (inherited) checks that the `Lock` model is registered.
import { type MongoLockModel, MongoLockStore } from '../drivers/mongo/locks.ts';
import { ResizeSetupError } from '../errors.ts';
import { getApp } from './app.ts';

// The native collection methods the store calls (the MongoDB driver's Collection has them).
interface LockCollection {
  findOneAndUpdate(
    filter: object,
    update: object,
    options: { upsert: true },
  ): PromiseLike<unknown>;
  updateOne(
    filter: object,
    update: object,
  ): PromiseLike<{ matchedCount: number }>;
  deleteOne(filter: object): PromiseLike<{ deletedCount?: number }>;
}

// The framework Lock model's native collection, as the MongoLockModel the store writes through.
function frameworkLockModel(): MongoLockModel {
  const Lock = getApp().getModel('Lock');
  if (!Lock) {
    throw new ResizeSetupError(
      "resize: the framework's Lock model is not registered — FrameworkLockStore keeps its locks there",
      { code: 'RESIZE_MONGO_MODEL_MISSING' },
    );
  }
  const collection: LockCollection = Lock.collection;
  // The store's strictQuery option is for Mongoose; the native collection filters nothing.
  return {
    findOneAndUpdate: (filter, update, { upsert }) =>
      collection.findOneAndUpdate(filter, update, { upsert }),
    updateOne: (filter, update) => collection.updateOne(filter, update),
    deleteOne: (filter) => collection.deleteOne(filter),
  };
}

export class FrameworkLockStore extends MongoLockStore {
  constructor() {
    super({ getModel: frameworkLockModel });
  }
}
