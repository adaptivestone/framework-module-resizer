// @adaptivestone/framework-module-resize/framework.js — the framework adapter. Everything that
// needs @adaptivestone/framework lives here; the main entry imports none of it.
//
//   import { createFrameworkResizer } from '@adaptivestone/framework-module-resize/framework.js';
//   export const resizer = createFrameworkResizer({ storage, tasks: true });

export type { FrameworkResizeConfig } from '../types.d.ts';
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
export {
  createFrameworkResizer,
  type FrameworkResizerOptions,
} from './resizer.ts';
export { runResizeWorker } from './worker.ts';
