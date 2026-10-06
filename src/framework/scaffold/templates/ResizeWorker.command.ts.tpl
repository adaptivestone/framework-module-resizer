// src/commands/ResizeWorker.ts — scaffolded. The MODULE owns the worker command
// (AbstractCommand shape, isShouldInitModels=true, --queue); the framework's filename-keyed CLI
// loader registers this file as `npm run cli ResizeWorker`. Importing src/resizer.ts builds the
// host's Resizers in the CLI process, so the worker serves the same Resizers as the API (they read
// the framework only on first use, so a static import is safe).
import '../resizer.ts';

export { ResizeWorker as default } from '@adaptivestone/framework-module-resize/framework.js';
