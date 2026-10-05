// @adaptivestone/framework-module-resize/framework.js — the framework adapter. Everything that
// needs @adaptivestone/framework lives here; the main entry imports none of it.
//
//   import { FrameworkResizer } from '@adaptivestone/framework-module-resize/framework.js';
//   export const resizer = new FrameworkResizer({ pipelines, hooks }); // the rest is config

export type {
  FrameworkLocalStorageConfig,
  FrameworkMongoQueueConfig,
  FrameworkQueueConfig,
  FrameworkResizeConfig,
  FrameworkS3StorageConfig,
  FrameworkSqsQueueConfig,
  FrameworkStorageConfig,
} from '../types.d.ts';
export {
  appEvents,
  appLogger,
  getApp,
  type TMinimalResizeApp,
} from './app.ts';
export { getResizeConfig } from './config.ts';
export {
  FrameworkDatabase,
  type FrameworkDatabaseOptions,
} from './database.ts';
export type { TResizeTask } from './ResizeTaskModel.ts';
export { default as ResizeTaskModel } from './ResizeTaskModel.ts';
export { default as ResizeWorker } from './ResizeWorkerCommand.ts';
export { FrameworkResizer, type FrameworkResizerOptions } from './resizer.ts';
export { runResizeWorker } from './worker.ts';
