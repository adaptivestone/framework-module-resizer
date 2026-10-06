// The `ResizeWorker` CLI command, part of the framework adapter (exported from `…/framework.js` as
// `ResizeWorker`). AbstractCommand-SHAPED but DUCK-TYPED, so
// it imports no framework class. The framework's BaseCli constructs
// every command as `new Command(app, commands, args)` and reads the statics below before/after;
// matching that shape (constructor args + `static description` + `static isShouldInitModels`) is
// all it needs. Hosts register it through the scaffolded src/commands/ResizeWorker.ts and launch `npm run cli ResizeWorker`.
import { runResizeWorker } from './worker.ts';

export default class ResizeWorker {
  static description =
    'Run the resize worker: lease resize tasks, generate + upload previews, complete/retry.';

  // Load + init models (the media model, ResizeTask, Lock) before run() — the worker needs them.
  static isShouldInitModels = true;

  // BaseCli calls this before initializing models. Keep the connection name short and stable;
  // the worker has no command-specific Mongo options that need to be part of the name.
  static getMongoConnectionName(
    _commandName: string,
    _args: Record<string, unknown>,
  ): string {
    return 'CLI: ResizeWorker';
  }

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

  // BaseCli parses these with node:util parseArgs and passes the values as `args`.
  static get commandArguments() {
    return {
      queue: {
        type: 'string',
        description:
          "Queue to consume (default 'default'). Tasks on other queues are left for their own workers.",
      },
      config: {
        type: 'string',
        description:
          "Config file name whose 'worker' section the process uses (default 'resize').",
      },
    } as const;
  }

  async run(): Promise<boolean> {
    const { queue, config } =
      (this.args as { queue?: string; config?: string } | undefined) ?? {};
    await runResizeWorker({
      ...(queue === undefined ? {} : { queue }),
      ...(config === undefined ? {} : { configName: config }),
    });
    return true;
  }
}
