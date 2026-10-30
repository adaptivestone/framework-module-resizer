// @adaptivestone/framework-module-resize/framework.js — the framework adapter. Everything that
// needs @adaptivestone/framework lives here; the main entry imports none of it.
//
//   import { FrameworkResizer } from '@adaptivestone/framework-module-resize/framework.js';
//   export const resizer = new FrameworkResizer({ pipelines, hooks }); // the rest is config

export {
  resizeMediaPaths,
  resizeMediaSchemaFragment,
} from '../drivers/mongo/mediaFragment.ts';
export type {
  DatabaseQueueConfig,
  FrameworkLocalStorageConfig,
  FrameworkResizeConfig,
  FrameworkS3StorageConfig,
  FrameworkStorageConfig,
  LocalStorageConfig,
  PartialFrameworkResizeConfig,
  QueueConfig,
  S3StorageConfig,
  SqsQueueConfig,
  StorageConfig,
} from '../types.d.ts';
export {
  defaultFrameworkResizeConfig,
  defaultWorkerOptions,
} from './defaults.ts';
export { FrameworkLockStore } from './locks.ts';
export {
  FrameworkMediaStore,
  type FrameworkMediaStoreOptions,
} from './media.ts';
export type { TResizeTask } from './ResizeTaskModel.ts';
export { default as ResizeTaskModel } from './ResizeTaskModel.ts';
export { default as ResizeWorker } from './ResizeWorkerCommand.ts';
export { FrameworkResizer, type FrameworkResizerOptions } from './resizer.ts';
export { runResizeWorker } from './worker.ts';
