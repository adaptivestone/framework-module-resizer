// The `ResizeWorker` CLI command, part of the framework adapter (exported from `…/framework.js` as
// `ResizeWorker`). AbstractCommand-SHAPED but DUCK-TYPED, so
// it imports no framework class. The framework's BaseCli constructs
// every command as `new Command(app, commands, args)` and reads the statics below before/after;
// matching that shape (constructor args + `static description` + `static isShouldInitModels`) is
// all it needs. Hosts register it through the scaffolded src/commands/ResizeWorker.ts and launch `npm run cli ResizeWorker`.
import { ResizeConfigError } from '../errors.ts';
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
        multiple: true,
        description:
          "Queue to consume (default 'default'); repeat it to consume several queues in one worker. Tasks on other queues are left for their own workers.",
      },
      // Still declared, so that the parser accepts it and run() names the fix.
      config: {
        type: 'string',
        description:
          'Removed: the worker reads `worker` and `queues` from src/config/resize.ts.',
      },
    } as const;
  }

  async run(): Promise<boolean> {
    const { queue, config } =
      (this.args as
        | { queue?: string | readonly string[]; config?: string }
        | undefined) ?? {};
    if (config !== undefined) {
      throw new ResizeConfigError(
        'resize worker: `--config` is removed — the worker reads `worker` and `queues` from src/config/resize.ts',
        { code: 'RESIZE_CONFIG_REMOVED_KEY' },
      );
    }
    // The parser gives a list (`--queue` may be repeated); a caller may still pass one name. One
    // name is passed as itself, as before; runWorker checks the names.
    const names = Array.isArray(queue) && queue.length === 1 ? queue[0] : queue;
    await runResizeWorker(names === undefined ? {} : { queue: names });
    return true;
  }
}
