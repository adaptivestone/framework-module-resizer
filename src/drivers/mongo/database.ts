// MongoDatabase: the 'mongo' database driver. From a config's `database` section (a Mongoose
// connection and the host's media model on it) it builds the parts that share that connection, as
// mongoParts() does: the media store, the locks and the task queue on the package's ResizeLock and
// ResizeTask models. Mongoose is used only through the connection and model it is given.
import type { DatabaseParts, DriverContext } from '../../contracts/drivers.ts';
import { invalidConfigValue } from '../../helpers/configSection.ts';
import type { MongoDatabaseConfig } from '../../types.d.ts';
import { MongoLockStore } from './locks.ts';
import { type MongoMediaModel, MongoMediaStore } from './media.ts';
import { createResizeModels } from './models.ts';
import { MongoTaskQueue } from './taskQueue.ts';

// biome-ignore lint/complexity/noStaticOnlyClass: a driver is registered as a class with a static fromConfig, like the storage and queue drivers
export class MongoDatabase {
  /**
   * The parts on `section.connection`. The package's models are registered on that connection
   * (with autoIndex off: create their indexes through your migration process). It does not wait
   * on the server: checks that need it belong to verify().
   */
  static fromConfig(
    section: MongoDatabaseConfig,
    ctx: DriverContext,
  ): DatabaseParts {
    const { connection, mediaModel } = section;
    // What createResizeModels uses: the default `mongoose` instance has model() and models but no
    // `base`, so it is refused here rather than failing inside with a TypeError.
    const shape = connection as {
      model?: unknown;
      models?: unknown;
      base?: { Schema?: unknown };
    } | null;
    if (
      typeof shape !== 'object' ||
      shape === null ||
      typeof shape.model !== 'function' ||
      typeof shape.models !== 'object' ||
      shape.models === null ||
      typeof shape.base?.Schema !== 'function'
    ) {
      throw invalidConfigValue(
        'database.connection',
        ctx.where,
        'a Mongoose connection (with a model() function)',
      );
    }
    // What the media store calls: anything else would fail on first use with a TypeError.
    const model = mediaModel as {
      findById?: unknown;
      findOneAndUpdate?: unknown;
    } | null;
    if (
      model === null ||
      (typeof model !== 'object' && typeof model !== 'function') ||
      typeof model.findById !== 'function' ||
      typeof model.findOneAndUpdate !== 'function'
    ) {
      throw invalidConfigValue(
        'database.mediaModel',
        ctx.where,
        'the host media model (with findById() and findOneAndUpdate() functions)',
      );
    }
    const media = mediaModel as MongoMediaModel;
    const { ResizeTask, ResizeLock } = createResizeModels(
      connection as Parameters<typeof createResizeModels>[0],
      media.modelName ? { mediaModelName: media.modelName } : {},
    );
    return {
      media: new MongoMediaStore({ model: media, logger: ctx.logger }),
      locks: new MongoLockStore({ model: ResizeLock }),
      taskQueue: ({ queues, getTiming, logger }) =>
        new MongoTaskQueue({ model: ResizeTask, queues, getTiming, logger }),
    };
  }
}
