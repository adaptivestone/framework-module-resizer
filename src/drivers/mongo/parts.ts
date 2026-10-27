// mongoParts(): the Resizer's MongoDB parts on one connection — the host's media, and locks and the
// task queue on the package's ResizeLock and ResizeTask models.
import type { QueueTimingOptions, ResizeLogger } from '../../types.d.ts';
import { MongoLockStore } from './locks.ts';
import { type MongoMediaModel, MongoMediaStore } from './media.ts';
import { createResizeModels } from './models.ts';
import { MongoTaskQueue } from './taskQueue.ts';

export interface MongoPartsOptions {
  mediaModel: MongoMediaModel; // the host media model (its schema spreads resizeMediaSchemaFragment)
  timing?: Partial<QueueTimingOptions>; // queue timing; missing values use the defaults
  logger?: ResizeLogger;
}

export interface MongoParts {
  media: MongoMediaStore;
  locks: MongoLockStore;
  tasks: MongoTaskQueue;
}

/**
 * The `media`, `locks` and `tasks` options of a Resizer on `connection`. The package's ResizeTask
 * and ResizeLock models are registered with autoIndex off: create their indexes through your
 * migration process. Each call makes its own task queue, so call it once per process and pass the
 * same `tasks` to every Resizer.
 */
export function mongoParts(
  // biome-ignore lint/suspicious/noExplicitAny: a Mongoose connection (types only, no import)
  connection: any,
  opts: MongoPartsOptions,
): MongoParts {
  const { ResizeTask, ResizeLock } = createResizeModels(connection, {
    ...(opts.mediaModel.modelName
      ? { mediaModelName: opts.mediaModel.modelName }
      : {}),
  });
  return {
    media: new MongoMediaStore({ model: opts.mediaModel }),
    locks: new MongoLockStore({ model: ResizeLock }),
    tasks: new MongoTaskQueue({
      model: ResizeTask,
      ...(opts.timing ? { timing: opts.timing } : {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
    }),
  };
}
