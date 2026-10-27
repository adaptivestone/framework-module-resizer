// @adaptivestone/framework-module-resize/drivers/mongo.js — MongoDB for the module's records:
// MongoMediaStore (the host's media), MongoLockStore (locks), MongoTaskQueue (the task queue),
// mongoParts() that builds all three on one connection, the models they use, and MongoDatabase
// (media, locks and its queue in one object). Framework-free; mongoose is used only through the
// models and connection you pass in.
export {
  MongoDatabase,
  type MongoDatabaseFactoryOptions,
  type MongoDatabaseOptions,
  mongoDatabase,
} from './database.ts';
export {
  type MongoLockModel,
  MongoLockStore,
  type MongoLockStoreOptions,
} from './locks.ts';
export {
  type MongoMediaModel,
  MongoMediaStore,
  type MongoMediaStoreOptions,
} from './media.ts';
export {
  type CreateResizeModelsOptions,
  createResizeModels,
} from './models.ts';
export {
  type MongoParts,
  type MongoPartsOptions,
  mongoParts,
} from './parts.ts';
export {
  resizeLockFields,
  resizeLockIndexes,
  resizeSchemaOptions,
  resizeTaskFields,
  resizeTaskIndexes,
} from './schemas.ts';
export { MongoTaskQueue, type MongoTaskQueueOptions } from './taskQueue.ts';
