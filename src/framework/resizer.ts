// Builds Resizers and the Mongo transport from the framework app. The core takes every part
// explicitly; these helpers fill the parts a framework host would otherwise repeat: the config
// file, the app logger and event bus, the framework media store, and for the transport the
// ResizeTask model and the framework Lock model.

import type { MediaStore } from '../contracts/mediaStore.ts';
import {
  MongoTransport,
  type MongoTransportOptions,
} from '../drivers/mongo/transport.ts';
import { Resizer, type ResizerOptions } from '../resizer.ts';
import type {
  FrameworkResizeConfig,
  ResizeEventBus,
  ResizeLogger,
} from '../types.d.ts';
import { appLogger, getApp } from './app.ts';
import { getResizeConfig, resolveFrameworkConfig } from './config.ts';
import { FrameworkLockStore } from './lockStore.ts';
import { FrameworkMediaStore } from './mediaStore.ts';

export interface FrameworkResizerOptions
  extends Omit<ResizerOptions, 'config' | 'mediaStore' | 'logger' | 'events'> {
  configName?: string; // framework config file this Resizer reads; default 'resize'
  config?: FrameworkResizeConfig; // explicit config instead of reading `configName`
  mediaStore?: MediaStore; // default: FrameworkMediaStore for config.mediaModelName
  logger?: ResizeLogger; // default: the app logger
  events?: ResizeEventBus; // default: the app event bus
}

/**
 * A Resizer wired from the framework app: the config file's image settings, the app logger and
 * events, and FrameworkMediaStore for the file's `mediaModelName`. Explicit options win.
 */
export function createFrameworkResizer(opts: FrameworkResizerOptions): Resizer {
  const { configName, config: explicitConfig, ...rest } = opts;
  const config = explicitConfig
    ? resolveFrameworkConfig(explicitConfig, configName)
    : getResizeConfig(configName);
  const events = opts.events ?? getApp().events;
  return new Resizer({
    ...rest,
    config: config.image,
    logger: opts.logger ?? getApp().logger,
    ...(events === undefined ? {} : { events }),
    mediaStore:
      opts.mediaStore ??
      new FrameworkMediaStore({ modelName: config.mediaModelName }),
  });
}

/**
 * A MongoTransport on the framework's `ResizeTask` model (resolved on each use, so it works
 * before models load) and the framework's `Lock` model, logging through the app, with timing
 * from the config file's `queue` section. Explicit options win.
 */
export function createFrameworkMongoTransport(
  opts: Partial<Omit<MongoTransportOptions, 'model' | 'getModel'>> & {
    configName?: string;
  } = {},
): MongoTransport {
  const { configName, locks, ...overrides } = opts;
  const { queue } = getResizeConfig(configName);
  return new MongoTransport({
    getModel: () => getApp().getModel('ResizeTask'),
    logger: appLogger,
    ...queue,
    ...overrides,
    locks: locks ?? new FrameworkLockStore(),
  });
}
