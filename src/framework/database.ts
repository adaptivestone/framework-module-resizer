// FrameworkDatabase: the database parts of a FrameworkResizer, over the framework app's models.
// It is the database driver the adapter registers as 'framework' (an internal name: a host's
// `drivers.database.framework` is replaced by it), and its section is the constant one the
// adapter passes, never a section of a config file:
// - media: FrameworkMediaStore, the app's media model (`mediaModelName` of the Resizer's config);
// - locks: FrameworkLockStore, the framework's own Lock model, used only beside a queue that
//   takes gate locks;
// - taskQueue: MongoTaskQueue over the app's ResizeTask model, for the database queues.
// Every model is looked up on use, so building the parts reads nothing from the app.
import type {
  DatabaseParts,
  DriverContext,
  DriverRegistry,
} from '../contracts/drivers.ts';
import { MongoTaskQueue } from '../drivers/mongo/taskQueue.ts';
import type { FrameworkResizeConfig } from '../types.d.ts';
import { getApp } from './app.ts';
import { FrameworkLockStore } from './locks.ts';
import { FrameworkMediaStore } from './media.ts';

/** The database section a FrameworkResizer passes for itself. */
export interface FrameworkDatabaseConfig {
  driver: 'framework';
  configName: string; // the Resizer's config file, which names its media model
  config?: FrameworkResizeConfig<DriverRegistry>; // the `config` option, read instead of the file
}

// biome-ignore lint/complexity/noStaticOnlyClass: a driver is a class with a static fromConfig, like the shipped ones
export class FrameworkDatabase {
  /** The parts over the app's models; synchronous, and nothing is read from the app yet. */
  static fromConfig(
    section: FrameworkDatabaseConfig,
    _ctx: DriverContext,
  ): DatabaseParts {
    const { configName, config } = section;
    return {
      media: new FrameworkMediaStore(
        config ? { config, configName } : { configName },
      ),
      locks: new FrameworkLockStore(),
      taskQueue: ({ queues, getTiming, logger }) =>
        new MongoTaskQueue({
          getModel: () => getApp().getModel('ResizeTask'),
          queues,
          getTiming,
          logger,
        }),
    };
  }
}
