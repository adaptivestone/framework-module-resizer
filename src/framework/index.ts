// @adaptivestone/framework-module-resize/framework.js — the framework adapter. Everything that
// needs @adaptivestone/framework lives here; the main entry imports none of it.
//
//   import { createFrameworkMongoTransport, createFrameworkResizer } from '@adaptivestone/framework-module-resize/framework.js';
//   export const resizer = createFrameworkResizer({ transport: createFrameworkMongoTransport(), storage });

export type { FrameworkResizeConfig } from '../types.d.ts';
export { appLogger, getApp, type TMinimalResizeApp } from './app.ts';
export { getResizeConfig } from './config.ts';
export { FrameworkLockStore } from './lockStore.ts';
export {
  FrameworkMediaStore,
  type FrameworkMediaStoreOptions,
} from './mediaStore.ts';
export type { TResizeTask } from './ResizeTaskModel.ts';
export { default as ResizeTaskModel } from './ResizeTaskModel.ts';
export { default as ResizeWorker } from './ResizeWorkerCommand.ts';
export {
  createFrameworkMongoTransport,
  createFrameworkResizer,
  type FrameworkResizerOptions,
} from './resizer.ts';
export { runResizeWorker } from './worker.ts';
