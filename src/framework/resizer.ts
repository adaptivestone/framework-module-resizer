// Builds Resizers from the framework app. The core takes every part explicitly; this helper fills
// what a framework host would otherwise repeat: the config file, the app logger and event bus, and
// FrameworkDatabase (the app's media, ResizeTask and Lock models). Nothing is read until first use.
import type { ResizeDatabase } from '../contracts/database.ts';
import type { TaskQueue } from '../contracts/taskQueue.ts';
import { Resizer, type ResizerOptions } from '../resizer.ts';
import type {
  FrameworkResizeConfig,
  ResizeEventBus,
  ResizeLogger,
} from '../types.d.ts';
import { appEvents, appLogger } from './app.ts';
import { getResizeConfig, resolveFrameworkConfig } from './config.ts';
import { FrameworkDatabase } from './database.ts';

export interface FrameworkResizerOptions
  extends Omit<
    ResizerOptions,
    'config' | 'db' | 'tasks' | 'logger' | 'events'
  > {
  configName?: string; // framework config file this Resizer reads; default 'resize'
  config?: FrameworkResizeConfig; // explicit config instead of reading `configName`
  db?: ResizeDatabase; // default: FrameworkDatabase for the config's mediaModelName
  // Queued work: `true` uses the database's own queue (the ResizeTask model); or pass any
  // TaskQueue (e.g. an SqsTaskQueue). Omit for eager-only hosts.
  tasks?: TaskQueue | true;
  logger?: ResizeLogger; // default: the app logger
  events?: ResizeEventBus; // default: the app event bus
}

/**
 * A Resizer wired from the framework app: the config file's image settings, the app logger and
 * events, and FrameworkDatabase. Nothing is read from the app until first use, so `src/resizer.ts`
 * can be imported statically anywhere, even before the framework is initialized. Call
 * `resizer.verify()` after `Server.init()` to check everything at boot. Explicit options win; an
 * explicit `config` is validated now.
 */
export function createFrameworkResizer(opts: FrameworkResizerOptions): Resizer {
  const { configName, config: explicitConfig, db, tasks, ...rest } = opts;
  const explicit = explicitConfig
    ? resolveFrameworkConfig(explicitConfig, configName)
    : undefined;
  const database =
    db ??
    new FrameworkDatabase(
      explicit ? { modelName: explicit.mediaModelName } : { configName },
    );
  const taskQueue = tasks === true ? database.tasks : tasks;
  return new Resizer({
    ...rest,
    config: explicit?.image ?? (() => getResizeConfig(configName).image),
    logger: opts.logger ?? appLogger,
    events: opts.events ?? appEvents,
    db: database,
    ...(taskQueue ? { tasks: taskQueue } : {}),
  });
}
