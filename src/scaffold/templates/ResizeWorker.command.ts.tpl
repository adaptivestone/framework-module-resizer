// src/commands/ResizeWorker.ts — scaffolded (08 · §12). The MODULE owns the worker command
// (AbstractCommand shape, isShouldInitModels=true, --queue); this subclass only builds the host's
// Resizers in the CLI process before the worker starts. The framework's filename-keyed CLI loader
// registers it as `npm run cli ResizeWorker`.
import { ResizeWorker as ModuleResizeWorker } from '@adaptivestone/framework-module-resize/framework.js';

export default class ResizeWorker extends ModuleResizeWorker {
  async run(): Promise<boolean> {
    // The worker routes each task to the Resizer named in it, so every Resizer must exist in this
    // process. The CLI has loaded config and models by now, so the construction site can run.
    await import('../resizer.ts');
    return super.run();
  }
}
