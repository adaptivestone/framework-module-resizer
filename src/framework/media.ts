// FrameworkMediaStore: MongoMediaStore over the framework app's media model, resolved by name on
// each use: `modelName`, or `mediaModelName` from the config. The config is the file `configName`
// (default 'resize'), or an explicit `config`. Nothing is read from the app until first use.
import { MongoMediaStore } from '../drivers/mongo/media.ts';
import { ResizeConfigError } from '../errors.ts';
import type { FrameworkResizeConfig } from '../types.d.ts';
import { appLogger, getApp } from './app.ts';
import { getResizeConfig, resolveFrameworkConfig } from './config.ts';

export interface FrameworkMediaStoreOptions {
  modelName?: string; // the host media model; default: mediaModelName from the config
  configName?: string; // the config file; default 'resize'
  config?: FrameworkResizeConfig; // an explicit config instead of reading `configName`
}

export class FrameworkMediaStore extends MongoMediaStore {
  constructor(opts: FrameworkMediaStoreOptions = {}) {
    super({
      // An unregistered name is a config error, never "media missing": the worker completes tasks
      // for deleted media as no-ops, so a missing model would silently drop every task.
      getModel: () => {
        const name =
          opts.modelName ??
          (opts.config
            ? resolveFrameworkConfig(opts.config, {
                configName: opts.configName ?? 'resize',
                explicit: true,
              })
            : getResizeConfig(opts.configName)
          ).mediaModelName;
        const model = getApp().getModel(name);
        if (!model) {
          throw new ResizeConfigError(
            `resize config: mediaModelName '${name}' is not a registered model — set it in the host src/config/${opts.configName ?? 'resize'}.ts`,
            { code: 'RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN' },
          );
        }
        return model;
      },
      // verify() warns through the app logger, resolved when it logs.
      logger: appLogger,
    });
  }
}
