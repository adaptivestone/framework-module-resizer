// Queue names on several backends. RoutingTaskQueue maps each queue name to the task queue that
// carries it: an object used as it is, or a builder called once, on the first need of one of its
// names, so a backend whose SDK is never needed is never imported. The core asks every per-queue
// question (the gate, `add`, `findActive`, the lock rule, the worker's loop) of the carrier that
// carrierOf() finds, so a router's own flags only describe what all its routes share. Beside a
// task queue, the names that no available backend carries can keep the reason (a missing optional
// peer), so a call, verify() or a worker on such a name says what to install.
import {
  type ClaimedTask,
  type ClaimOptions,
  type FailOptions,
  type NewTask,
  type TaskAddResult,
  TaskQueue,
} from './contracts/taskQueue.ts';
import { type ResizeError, ResizeSetupError } from './errors.ts';
import { timingOf } from './timing.ts';
import type { EnqueueReceipt, QueueTimingOptions } from './types.d.ts';

/** A route: the task queue that carries a name, or a function that builds it on first need. */
export type Route = TaskQueue | (() => Promise<TaskQueue>);

export interface RoutingTaskQueueOptions {
  /**
   * The timing of a name whose route is a builder: needed before the build, so it is the only
   * timing of such a name (the built task queue's own getTiming is not asked). An object route's
   * names take that route's own timing.
   */
  getTiming?(queue: string): Partial<QueueTimingOptions> | undefined;
}

type Builder = () => Promise<TaskQueue>;

const REQUIRED_METHODS = ['add', 'claim', 'renew', 'complete', 'fail'] as const;

/** True for an object with the five required TaskQueue methods (duck typing, never the class). */
function isTaskQueue(value: unknown): value is TaskQueue {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const methods = value as Record<string, unknown>;
  return REQUIRED_METHODS.every((m) => typeof methods[m] === 'function');
}

/** True for a task queue that routes names to backends: it has `routeOf`. */
export function isRouter(tasks: TaskQueue): boolean {
  return typeof tasks.routeOf === 'function';
}

const routesInvalid = (message: string) =>
  new ResizeSetupError(`resize: RoutingTaskQueue ${message}`, {
    code: 'RESIZE_QUEUE_ROUTES_INVALID',
    retryable: false,
  });

/** The routes, checked: a non-empty plain object of task queues and builders. */
function checkedRoutes(routes: unknown): Map<string, Route> {
  const proto =
    typeof routes === 'object' && routes !== null
      ? Object.getPrototypeOf(routes)
      : undefined;
  if (proto !== Object.prototype && proto !== null) {
    throw routesInvalid(
      'needs a plain object of routes, from queue name to task queue or builder',
    );
  }
  const entries = Object.entries(routes as Record<string, unknown>);
  if (entries.length === 0) {
    throw routesInvalid('needs at least one route');
  }
  const checked = new Map<string, Route>();
  for (const [name, route] of entries) {
    if (typeof route === 'function') {
      checked.set(name, route as Builder);
      continue;
    }
    if (!isTaskQueue(route)) {
      throw routesInvalid(
        `route '${name}' is neither a task queue (add, claim, renew, complete and fail) nor a function that builds one`,
      );
    }
    // Read as the rest of the core reads it: any answer but a truthy one is not served.
    if (route.servesQueue && !route.servesQueue(name)) {
      throw routesInvalid(
        `route '${name}' is a task queue that does not serve queue '${name}'`,
      );
    }
    checked.set(name, route);
  }
  return checked;
}

const notRouted = (queue: string) =>
  new ResizeSetupError(
    `resize: RoutingTaskQueue has no route for queue '${queue}'`,
    { code: 'RESIZE_QUEUE_NOT_SERVED' },
  );

/**
 * A task queue that routes each queue name to the task queue that carries it. Routes are task
 * queues, used as they are (one may carry several names, and one may itself be a router), or
 * builders: a builder is called once, on the first need of one of its names, its promise is kept,
 * and a rejected build is forgotten so the next need builds again. `servesQueue` answers from the
 * routes without building anything. Each method goes to the carrier of its queue name; there is no
 * `release`, since a router cannot promise it for every backend (the core asks the carrier).
 * `gatesByTask` and `claimFilters` are set only when every route is an object route with that flag.
 */
export class RoutingTaskQueue extends TaskQueue {
  readonly #routes: Map<string, Route>;
  readonly #getTiming: RoutingTaskQueueOptions['getTiming'];
  // The build of each builder in flight or done; one builder may carry several names.
  readonly #builds = new Map<Builder, Promise<TaskQueue>>();

  constructor(
    routes: Record<string, Route>,
    opts: RoutingTaskQueueOptions = {},
  ) {
    super();
    this.#routes = checkedRoutes(routes);
    this.#getTiming = opts.getTiming;
    const objects = [...this.#routes.values()].filter(
      (route): route is TaskQueue => typeof route !== 'function',
    );
    const all = objects.length === this.#routes.size;
    // Own data properties, not accessors: TaskQueue declares both flags as properties. A builder
    // route's flags are unknown until it is built, so it leaves both unset.
    for (const flag of ['gatesByTask', 'claimFilters'] as const) {
      if (all && objects.every((route) => route[flag])) {
        Object.defineProperty(this, flag, { value: true, enumerable: true });
      }
    }
  }

  /** The task queue that carries `queue` (undefined: no route); a failed build rejects. */
  async routeOf(queue: string): Promise<TaskQueue | undefined> {
    const route = this.#routes.get(queue);
    if (route === undefined) {
      return undefined;
    }
    const target =
      typeof route === 'function' ? await this.#build(route) : route;
    return carrierOf(target, queue);
  }

  /** Build `builder` once; a rejected or invalid build is forgotten. */
  #build(builder: Builder): Promise<TaskQueue> {
    let building = this.#builds.get(builder);
    if (!building) {
      building = builder().then((built) => {
        if (!isTaskQueue(built)) {
          throw new ResizeSetupError(
            'resize: a RoutingTaskQueue builder resolved something that is not a task queue (add, claim, renew, complete and fail)',
            { code: 'RESIZE_DRIVER_INVALID', retryable: false },
          );
        }
        return built;
      });
      this.#builds.set(builder, building);
      building.catch(() => {
        if (this.#builds.get(builder) === building) {
          this.#builds.delete(builder);
        }
      });
    }
    return building;
  }

  /** The carrier of `queue`, or RESIZE_QUEUE_NOT_SERVED when no route has it. */
  async #carrier(queue: string): Promise<TaskQueue> {
    const carrier = await this.routeOf(queue);
    if (!carrier) {
      throw notRouted(queue);
    }
    return carrier;
  }

  async add(task: NewTask): Promise<TaskAddResult> {
    return (await this.#carrier(task.queue)).add(task);
  }

  async claim(
    queue: string,
    leaseMs: number,
    signal?: AbortSignal,
    opts?: ClaimOptions,
  ): Promise<ClaimedTask | null> {
    return (await this.#carrier(queue)).claim(queue, leaseMs, signal, opts);
  }

  async renew(task: ClaimedTask, leaseMs: number): Promise<boolean> {
    return (await this.#carrier(task.queue)).renew(task, leaseMs);
  }

  async complete(task: ClaimedTask): Promise<boolean> {
    return (await this.#carrier(task.queue)).complete(task);
  }

  async fail(
    task: ClaimedTask,
    next: { retryAt: Date } | 'dead',
    error: string,
    opts?: FailOptions,
  ): Promise<boolean> {
    return (await this.#carrier(task.queue)).fail(task, next, error, opts);
  }

  /** The carrier's active tasks, or none when the carrier cannot be queried. */
  async findActive(query: {
    resizer: string;
    mediaId: string;
    pipeline: string;
    queue: string;
  }): Promise<EnqueueReceipt[]> {
    const carrier = await this.#carrier(query.queue);
    return carrier.findActive ? carrier.findActive(query) : [];
  }

  /** Whether a route has `queue`; nothing is built. */
  servesQueue(queue: string): boolean {
    return this.#routes.has(queue);
  }

  /**
   * The timing of `queue`, one answer before and after any build: an object route's own (read
   * once per name through timingOf), a builder route's from the router's option.
   */
  getTiming(queue: string): Partial<QueueTimingOptions> | undefined {
    const route = this.#routes.get(queue);
    if (route === undefined) {
      return undefined;
    }
    return typeof route === 'function'
      ? this.#getTiming?.(queue)
      : timingOf(route, queue);
  }

  /** Verify the object routes, each once; a builder route is verified when it carries a name. */
  async verify(): Promise<void> {
    const objects = new Set(
      [...this.#routes.values()].filter(
        (route): route is TaskQueue => typeof route !== 'function',
      ),
    );
    for (const route of objects) {
      await route.verify?.();
    }
  }
}

/**
 * The task queue that carries `queue` on `tasks`: a router's route for it (a build that fails
 * rejects), or, for any other task queue, the task queue itself when it serves that name.
 * Undefined when nothing carries it.
 */
export async function carrierOf(
  tasks: TaskQueue,
  queue: string,
): Promise<TaskQueue | undefined> {
  if (typeof tasks.routeOf === 'function') {
    return tasks.routeOf(queue);
  }
  return tasks.servesQueue && !tasks.servesQueue(queue) ? undefined : tasks;
}

/** Why no backend carries a queue name: its driver needs packages that are not installed. */
export interface UnavailableReason {
  driver: string;
  packages: readonly string[];
  error: ResizeError; // the RESIZE_PEER_MISSING error that names the driver, packages and config
}

// The reasons of the names no backend carries, beside the task queue they were planned with.
const unavailable = new WeakMap<TaskQueue, Map<string, UnavailableReason>>();

/**
 * Record `reason` for each of `names` beside `tasks`: none of them is carried. Internal: the main
 * entry does not export it.
 * @internal
 */
export function markUnavailable(
  tasks: TaskQueue,
  names: Iterable<string>,
  reason: UnavailableReason,
): void {
  let reasons = unavailable.get(tasks);
  if (!reasons) {
    reasons = new Map();
    unavailable.set(tasks, reasons);
  }
  for (const name of names) {
    reasons.set(name, reason);
  }
}

/**
 * The reason recorded for `queue` beside `tasks`, if any. Internal: the main entry does not export
 * it.
 * @internal
 */
export function unavailableReason(
  tasks: TaskQueue,
  queue: string,
): UnavailableReason | undefined {
  return unavailable.get(tasks)?.get(queue);
}

/** The reason in words: "its driver 'sqs' needs @aws-sdk/client-sqs, which is not installed". */
export function unavailableText(reason: UnavailableReason): string {
  const { driver, packages } = reason;
  return `its driver '${driver}' needs ${packages.join(' and ')}, which ${packages.length === 1 ? 'is' : 'are'} not installed`;
}
