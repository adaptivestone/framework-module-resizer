// The `ResizeWorker` CLI command (07 · Worker §11). AbstractCommand-SHAPED but DUCK-TYPED — it
// does NOT import the framework (the module's framework-import surface stays at exactly two
// files: src/app.ts + src/models/ResizeTask.ts — 01 · §2.3). The framework's BaseCli constructs
// every command as `new Command(app, commands, args)` and reads the statics below before/after;
// matching that shape (constructor args + `static description` + `static isShouldInitModels`) is
// all it needs. Hosts register it via the scaffold re-export and launch `npm run cli ResizeWorker`.
import { runResizeWorker } from '../worker.ts';

export default class ResizeWorker {
  static description =
    'Run the resize worker: lease resize tasks, generate + upload previews, complete/retry.';

  // Load + init models (the media model, ResizeTask, Lock) before run() — the worker needs them.
  static isShouldInitModels = true;

  // What BaseCli passes: `new Command(this.app, this.commands, parsedArgs.values)`. Stored to
  // mirror AbstractCommand's shape; the resize worker itself reaches the app via getApp().
  app: unknown;
  commands: unknown;
  args: unknown;

  constructor(app: unknown, commands: unknown, args: unknown) {
    this.app = app;
    this.commands = commands;
    this.args = args;
  }

  async run(): Promise<boolean> {
    await runResizeWorker();
    return true;
  }
}
