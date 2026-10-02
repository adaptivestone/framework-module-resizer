// Builds Resizers and the Mongo transport from the framework app. The core takes every part
// explicitly; these helpers fill the parts a framework host would otherwise repeat: the config
// file, the app logger and event bus, the framework media store and lock provider, and the
// ResizeTask model.

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
import { getResizeConfig } from './config.ts';
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
 * A Resizer wired from the framework app. Explicit options win; a `transport` without a
 * `lockProvider` gets the framework `Lock` model's FrameworkLockStore.
 */
export function createFrameworkResizer(opts: FrameworkResizerOptions): Resizer {
  const { configName, config: explicitConfig, ...rest } = opts;
  const config = explicitConfig ?? getResizeConfig(configName);
  const events = opts.events ?? getApp().events;
  return new Resizer({
    ...rest,
    config,
    logger: opts.logger ?? getApp().logger,
    ...(events === undefined ? {} : { events }),
    mediaStore:
      opts.mediaStore ??
      new FrameworkMediaStore({ modelName: config.mediaModelName }),
    ...(opts.transport && !opts.lockProvider
      ? { lockProvider: new FrameworkLockStore() }
      : {}),
  });
}

/**
 * A MongoTransport on the framework's `ResizeTask` model (resolved on each use, so it works
 * before models load), logging through the app, with lease and retry timing from the config
 * file's `queue` section. Explicit options win.
 */
export function createFrameworkMongoTransport(
  opts: Partial<Omit<MongoTransportOptions, 'model' | 'getModel'>> & {
    configName?: string;
  } = {},
): MongoTransport {
  const { configName, ...overrides } = opts;
  const { queue } = getResizeConfig(configName);
  return new MongoTransport({
    getModel: () => getApp().getModel('ResizeTask'),
    logger: appLogger,
    leaseMs: queue.leaseMs,
    retryBackoffMs: queue.retryBackoffMs,
    maxAttempts: queue.maxAttempts,
    idlePollMs: queue.idlePollMs,
    taskTimeoutMs: queue.taskTimeoutMs,
    ...overrides,
  });
}
