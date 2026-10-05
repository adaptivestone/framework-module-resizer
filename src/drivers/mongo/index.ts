// @adaptivestone/framework-module-resize/drivers/mongo.js — MongoDB for the module's records:
// MongoDatabase (media, locks) with its MongoTaskQueue, and the models they use. Framework-free;
// mongoose is used only through the models and connection you pass in.
export {
  MongoDatabase,
  type MongoDatabaseFactoryOptions,
  type MongoDatabaseOptions,
  type MongoLockModel,
  type MongoMediaModel,
  mongoDatabase,
} from './database.ts';
export {
  type CreateResizeModelsOptions,
  createResizeModels,
} from './models.ts';
export {
  resizeLockFields,
  resizeLockIndexes,
  resizeSchemaOptions,
  resizeTaskFields,
  resizeTaskIndexes,
} from './schemas.ts';
export { MongoTaskQueue, type MongoTaskQueueOptions } from './taskQueue.ts';
