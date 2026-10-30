// The task queue of a config's `queues`: the entries grouped into backends (by driver, then by the
// driver's backendOf), each backend built by its driver on the first need of one of its names. A
// backend whose optional package is missing is left out, and its names keep the reason beside the
// task queue, so a call, verify() or a worker on such a name says what to install.
import type {
  DatabaseParts,
  QueueDriver,
  QueueEntry,
} from '../contracts/drivers.ts';
import type { TaskQueue } from '../contracts/taskQueue.ts';
import { ResizeConfigError, ResizeSetupError } from '../errors.ts';
import {
  isTaskQueue,
  markUnavailable,
  RoutingTaskQueue,
  type UnavailableReason,
} from '../routing.ts';
import type { ResizeLogger } from '../types.d.ts';
import { peersOf, probeDriver } from './builtins.ts';

/** Keeps one build per key: built once, its promise kept, a rejected build forgotten. */
export type ShareFn = <V>(key: string, build: () => Promise<V>) => Promise<V>;

export interface QueueSetContext {
  where: string; // the config that defines `queues`, as messages name it
  logger: ResizeLogger; // given to every queue driver
  database: () => Promise<DatabaseParts | undefined>; // the config's database parts, if any
  share: ShareFn; // the cache of each backend's build
}

export interface QueueSetPlan {
  /**
   * The task queue: the one available backend itself (built now), or a RoutingTaskQueue over the
   * available backends (built on first need). The names of an unavailable backend are marked with
   * their reason. With no backend available it rejects with the first reason.
   */
  taskQueue(): Promise<TaskQueue>;
}

/** One backend: its driver, the entries whose tasks wait in it, and its cache key. */
interface Backend {
  driverName: string;
  driver: QueueDriver;
  key: string;
  entries: QueueEntry[];
}

/**
 * Plan the task queue of `entries` (validated, each driver registered in `drivers`): group them
 * into backends and probe each backend's optional packages. Nothing is built or loaded here.
 */
export function planQueueSet(
  entries: readonly QueueEntry[],
  drivers: Record<string, QueueDriver>,
  ctx: QueueSetContext,
): QueueSetPlan {
  const backends = new Map<string, Backend>();
  for (const entry of entries) {
    const driverName = entry.section.driver;
    const driver = drivers[driverName];
    const backend =
      typeof driver.backendOf === 'function'
        ? driver.backendOf(entry.section)
        : '';
    const key = `${driverName}:${backend}`;
    const group = backends.get(key);
    if (group) {
      group.entries.push(entry);
    } else {
      backends.set(key, { driverName, driver, key, entries: [entry] });
    }
  }
  const available: Backend[] = [];
  const unavailable: Array<{ names: string[]; reason: UnavailableReason }> = [];
  for (const backend of backends.values()) {
    const { driver, driverName, entries: own } = backend;
    const error = probeDriver(
      driver,
      driverName,
      `\`queues.${own[0].name}\` in ${ctx.where}`,
    );
    if (error) {
      unavailable.push({
        names: own.map((entry) => entry.name),
        reason: { driver: driverName, packages: peersOf(driver), error },
      });
    } else {
      available.push(backend);
    }
  }
  return {
    async taskQueue() {
      if (available.length === 0) {
        throw (
          unavailable[0]?.reason.error ??
          new ResizeConfigError(
            `resize config: \`queues\` in ${ctx.where} defines no queue`,
            { code: 'RESIZE_CONFIG_INVALID' },
          )
        );
      }
      const tasks =
        available.length === 1
          ? await buildBackend(available[0], ctx)
          : routerOf(available, ctx);
      for (const { names, reason } of unavailable) {
        markUnavailable(tasks, names, reason);
      }
      return tasks;
    },
  };
}

/** A RoutingTaskQueue over the backends: each name to its backend's builder, with its timing. */
function routerOf(backends: Backend[], ctx: QueueSetContext): TaskQueue {
  const routes: Record<string, () => Promise<TaskQueue>> = {};
  const timing = new Map<string, QueueEntry['timing']>();
  for (const backend of backends) {
    const build = () => buildBackend(backend, ctx);
    for (const entry of backend.entries) {
      routes[entry.name] = build;
      timing.set(entry.name, entry.timing);
    }
  }
  return new RoutingTaskQueue(routes, {
    getTiming: (queue) => timing.get(queue),
  });
}

/**
 * The task queue of one backend, built by its driver once per key of `ctx.share`. What the driver
 * returns must be a task queue that serves every name of the backend (RESIZE_DRIVER_INVALID).
 */
function buildBackend(
  backend: Backend,
  ctx: QueueSetContext,
): Promise<TaskQueue> {
  const { driver, driverName, entries } = backend;
  return ctx.share(`backend:${backend.key}`, async () => {
    const database = await ctx.database();
    const built: unknown = await driver.fromConfig(entries, {
      logger: ctx.logger,
      where: ctx.where,
      database,
    });
    const named = `\`drivers.queue.${driverName}\` (\`queues.${entries[0].name}\` in ${ctx.where})`;
    if (!isTaskQueue(built)) {
      throw driverInvalid(
        `${named} built something that is not a task queue (add, claim, renew, complete and fail)`,
      );
    }
    const unserved = entries.find(
      (entry) => built.servesQueue && !built.servesQueue(entry.name),
    );
    if (unserved) {
      throw driverInvalid(
        `${named} built a task queue that does not serve queue '${unserved.name}'`,
      );
    }
    return built;
  });
}

const driverInvalid = (message: string): ResizeSetupError =>
  new ResizeSetupError(`resize: ${message}`, {
    code: 'RESIZE_DRIVER_INVALID',
    retryable: false,
  });
