// FrameworkDatabase: MongoDatabase over the framework app's models, resolved by name on each use.
// - media: `modelName`, or `mediaModelName` from the config;
// - locks: the framework's own `Lock` model (no extra collection);
// - tasks: the scaffolded `ResizeTask` model, with timing from the config's `queue` section.
// The config is the file `configName` (default 'resize'), or an explicit `config`. Nothing is read
// from the app until first use.
import { MongoDatabase } from '../drivers/mongo/database.ts';
import { MongoTaskQueue } from '../drivers/mongo/taskQueue.ts';
import { ResizeConfigError, ResizeSetupError } from '../errors.ts';
import type { FrameworkResizeConfig } from '../types.d.ts';
import { appLogger, getApp } from './app.ts';
import { getResizeConfig, resolveFrameworkConfig } from './config.ts';

export interface FrameworkDatabaseOptions {
  modelName?: string; // the host media model; default: mediaModelName from the config
  configName?: string; // the config file; default 'resize'
  config?: FrameworkResizeConfig; // an explicit config instead of reading `configName`
}

export class FrameworkDatabase extends MongoDatabase {
  constructor(opts: FrameworkDatabaseOptions = {}) {
    const read = () =>
      opts.config
        ? resolveFrameworkConfig(opts.config, opts.configName)
        : getResizeConfig(opts.configName);
    super({
      // An unregistered name is a config error, never "media missing": the worker completes tasks
      // for deleted media as no-ops, so a missing model would silently drop every task.
      getMediaModel: () => {
        const name = opts.modelName ?? read().mediaModelName;
        const model = getApp().getModel(name);
        if (!model) {
          throw new ResizeConfigError(
            `resize config: mediaModelName '${name}' is not a registered model — set it in the host src/config/${opts.configName ?? 'resize'}.ts`,
            { code: 'RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN' },
          );
        }
        return model;
      },
      tasks: new MongoTaskQueue({
        getModel: () => getApp().getModel('ResizeTask'),
        getTiming: () => read().timing,
        logger: appLogger,
      }),
    });
  }

  /** Startup check: the media model and the framework's `Lock` model must resolve. */
  verify(): void {
    this.mediaModel();
    if (!getApp().getModel('Lock')) {
      throw new ResizeSetupError(
        "resize: the framework's Lock model is not registered — FrameworkDatabase keeps its locks there",
        { code: 'RESIZE_MONGO_MODEL_MISSING' },
      );
    }
  }

  // The framework Lock TTL is in seconds; round up so a sub-second TTL never becomes a 0-second
  // (immediately expired) lock.
  async acquireLock(key: string, ttlMs: number): Promise<boolean> {
    const acquired = await getApp()
      .getModel('Lock')
      .acquireLock(key, Math.ceil(ttlMs / 1000));
    return Boolean(acquired);
  }

  async releaseLock(key: string): Promise<void> {
    await getApp().getModel('Lock').releaseLock(key);
  }
}
