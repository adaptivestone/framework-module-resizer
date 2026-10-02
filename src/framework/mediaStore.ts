// FrameworkMediaStore: MongoMediaStore with the model taken from the framework app by name, on
// each use. The name comes from `modelName`, or from `mediaModelName` in the config file
// `configName`. The read path never calls load(); resolve() receives `media` from the caller.
import { MongoMediaStore } from '../drivers/mongo/mediaStore.ts';
import { ResizeConfigError } from '../errors.ts';
import { getApp } from './app.ts';
import { getResizeConfig } from './config.ts';

export interface FrameworkMediaStoreOptions {
  // The host media model. Default: `mediaModelName` from the config file `configName`.
  modelName?: string;
  configName?: string; // default 'resize'
}

export class FrameworkMediaStore extends MongoMediaStore {
  constructor(opts: FrameworkMediaStoreOptions = {}) {
    super({
      // An unregistered name is a config error, never "media missing": the worker completes tasks
      // for deleted media as no-ops, so a null model would silently drop every task.
      getModel: () => {
        const name =
          opts.modelName ?? getResizeConfig(opts.configName).mediaModelName;
        const model = getApp().getModel(name);
        if (!model) {
          throw new ResizeConfigError(
            `resize config: mediaModelName '${name}' is not a registered model — set it in the host src/config/resize.ts`,
            { code: 'RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN' },
          );
        }
        return model;
      },
    });
  }
}
