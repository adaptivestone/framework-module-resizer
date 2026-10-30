// Test-only fakes for the driver contracts: a MediaStore built from parts; locks that honour owners
// (memoryLocks never expire, clockLocks expire on a clock the test controls); and in-memory task
// queues that share one row store (oldest-first claims, fenced leases, retry times and dead tasks).
// MemoryTaskQueue behaves like the database queue: it gates by task (one active task per Resizer,
// media, pipeline and queue, and a dead task holds the gate until its cooldown ends), filters
// claims by Resizer, gives tasks back with `release` and answers findActive. PlainTaskQueue has
// the SQS shape and stores every task; ReleasingTaskQueue adds `release` to it. observedQueue
// wraps one so a test can stop an idle worker once its work is handled. fakeQueueDriver is a queue
// driver factory over PlainTaskQueue; fakeDatabaseParts are database parts whose task queue is a
// MemoryTaskQueue.
import type { DatabaseParts, QueueDriver } from '../contracts/drivers.ts';
import type { LockStore } from '../contracts/locks.ts';
import type { MediaStore } from '../contracts/media.ts';
import {
  type ClaimedTask,
  type ClaimOptions,
  type FailOptions,
  type NewTask,
  type TaskAddResult,
  TaskQueue,
} from '../contracts/taskQueue.ts';
import type {
  EnqueueReceipt,
  MediaLike,
  Preview,
  QueueTimingOptions,
} from '../types.d.ts';

/** In-memory locks (no expiry). Owners are honoured: only the holder extends or releases a lock. */
export function memoryLocks(): LockStore {
  const held = new Map<string, string>(); // key → owner
  return {
    acquire: async (key, owner) => {
      if (held.has(key)) {
        return false;
      }
      held.set(key, owner);
      return true;
    },
    extend: async (key, owner) => held.get(key) === owner,
    release: async (key, owner) => {
      if (held.get(key) !== owner) {
        return false;
      }
      held.delete(key);
      return true;
    },
  };
}

/** A LockStore whose locks a test can inspect. */
export interface ClockLocks extends LockStore {
  /** The lock on `key`, expired or not; `undefined` when there is none. */
  entry(key: string): { owner: string; expiresAt: number } | undefined;
}

/**
 * In-memory locks that expire on `now` (default Date.now), as the lock contract says: a lock is
 * live until `expiresAt`, and then another owner can take it over. An expired lock is never
 * extended, but its owner can still release it until someone takes it over.
 */
export function clockLocks(now: () => number = () => Date.now()): ClockLocks {
  const held = new Map<string, { owner: string; expiresAt: number }>();
  const live = (key: string) => {
    const lock = held.get(key);
    return lock && lock.expiresAt > now() ? lock : undefined;
  };
  return {
    acquire: async (key, owner, ttlMs) => {
      if (live(key)) {
        return false;
      }
      held.set(key, { owner, expiresAt: now() + ttlMs });
      return true;
    },
    extend: async (key, owner, ttlMs) => {
      const lock = live(key);
      if (lock?.owner !== owner) {
        return false;
      }
      lock.expiresAt = now() + ttlMs;
      return true;
    },
    release: async (key, owner) => {
      if (held.get(key)?.owner !== owner) {
        return false;
      }
      held.delete(key);
      return true;
    },
    entry: (key) => {
      const lock = held.get(key);
      return lock ? { ...lock } : undefined;
    },
  };
}

/**
 * A MediaStore from optional parts; missing parts are harmless in-memory stand-ins. The default
 * appendPreviews and replacePreviews follow the media contract on `previews` (rows per media id;
 * pass a map to seed or inspect it; every media id counts as present). appendPreviews keeps one
 * row per preview identity and resolves with the previews it stored; a preview without an identity
 * is always stored. replacePreviews removes the rows whose identity is given or is one of the new
 * rows', stores the first new row per identity, and resolves with both lists.
 */
export function fakeMedia(
  parts: {
    load?: (mediaId: string) => Promise<MediaLike | null>;
    appendPreviews?: MediaStore['appendPreviews'];
    replacePreviews?: MediaStore['replacePreviews'];
    previews?: Map<string, Preview[]>;
    verify?: () => void | Promise<void>;
  } = {},
): MediaStore {
  const rows = parts.previews ?? new Map<string, Preview[]>();
  const appendPreviews = async (mediaId: string, previews: Preview[]) => {
    const media = rows.get(mediaId) ?? [];
    rows.set(mediaId, media);
    const stored: Preview[] = [];
    for (const preview of previews) {
      if (
        preview.identity !== undefined &&
        media.some((row) => row.identity === preview.identity)
      ) {
        continue;
      }
      media.push(preview);
      stored.push(preview);
    }
    return stored;
  };
  const replacePreviews = async (
    mediaId: string,
    identities: string[],
    previews: Preview[],
  ) => {
    const stored: Preview[] = [];
    const seen = new Set<string>();
    for (const preview of previews) {
      if (preview.identity !== undefined) {
        if (seen.has(preview.identity)) {
          continue;
        }
        seen.add(preview.identity);
      }
      stored.push(preview);
    }
    const media = rows.get(mediaId) ?? [];
    rows.set(mediaId, media);
    const remove = new Set([...identities, ...seen]);
    const kept: Preview[] = [];
    const removed: Preview[] = [];
    for (const row of media) {
      (row.identity !== undefined && remove.has(row.identity)
        ? removed
        : kept
      ).push(row);
    }
    // In place, like appendPreviews: a test that holds the seeded array sees the swap.
    media.splice(0, media.length, ...kept, ...stored);
    return { stored, removed };
  };
  return {
    loadMedia: parts.load ?? (async () => null),
    appendPreviews: parts.appendPreviews ?? appendPreviews,
    replacePreviews: parts.replacePreviews ?? replacePreviews,
    ...(parts.verify ? { verify: parts.verify } : {}),
  };
}

interface Row {
  id: string;
  task: NewTask;
  status: 'pending' | 'processing' | 'completed' | 'dead';
  attempts: number;
  token: string | null;
  leaseUntil: number;
  availableAt: number;
  /** True from `add` until `complete`, or until a later `add` takes over the dead row. */
  active: boolean;
  /** MemoryTaskQueue only: a dead row holds the gate until this time. */
  cooldownUntil?: number;
  error?: string;
}

export interface RowQueueOptions {
  /** The timing of every queue name. */
  timing?: Partial<QueueTimingOptions>;
  /** Per queue name; when it gives none, `timing` applies. */
  queueTiming?: Record<string, Partial<QueueTimingOptions>>;
  /** The queue names served; default: every name. */
  queues?: readonly string[];
}

/**
 * The rows and the lease logic of the in-memory task queues: oldest-first claims, fenced leases,
 * retry times and dead tasks. A claimed task carries the `gateOwner` it was added with, when it has
 * one. `rows`, `added`, `claims` and `leases` are open for assertions.
 */
abstract class RowQueue extends TaskQueue {
  readonly rows: Row[] = [];
  /** Every `add` call, also those that stored nothing. */
  readonly added: NewTask[] = [];
  /** Every `claim` call, with the lease it asked for, also those that claimed nothing. */
  readonly claims: Array<{ queue: string; leaseMs: number }> = [];
  /** Every task a `claim` call handed out (`claims` also records the empty ones). */
  readonly leases: ClaimedTask[] = [];
  readonly #timing: Partial<QueueTimingOptions>;
  readonly #queueTiming: Record<string, Partial<QueueTimingOptions>>;
  readonly #queues: readonly string[] | undefined;
  #seq = 0;

  constructor(opts: RowQueueOptions = {}) {
    super();
    this.#timing = opts.timing ?? {};
    this.#queueTiming = opts.queueTiming ?? {};
    this.#queues = opts.queues;
  }

  servesQueue(queue: string): boolean {
    return this.#queues?.includes(queue) ?? true;
  }

  getTiming(queue: string): Partial<QueueTimingOptions> {
    return Object.hasOwn(this.#queueTiming, queue)
      ? this.#queueTiming[queue]
      : this.#timing;
  }

  async add(task: NewTask): Promise<TaskAddResult> {
    this.added.push(task);
    this.#seq += 1;
    const row: Row = {
      id: `task-${this.#seq}`,
      task,
      status: 'pending',
      attempts: 0,
      token: null,
      leaseUntil: 0,
      availableAt: 0,
      active: true,
    };
    this.rows.push(row);
    return { status: 'added', taskId: row.id };
  }

  /** Claims any Resizer's task: `opts.resizers` is ignored. */
  async claim(
    queue: string,
    leaseMs: number,
    _signal?: AbortSignal,
    _opts?: ClaimOptions,
  ): Promise<ClaimedTask | null> {
    return this.claimFirst(queue, leaseMs, () => true);
  }

  /** Lease the oldest due row of `queue` that `takes` accepts; every `claim` comes here. */
  protected claimFirst(
    queue: string,
    leaseMs: number,
    takes: (row: Row) => boolean,
  ): ClaimedTask | null {
    this.claims.push({ queue, leaseMs });
    const now = Date.now();
    const row = this.rows.find(
      (r) =>
        r.task.queue === queue &&
        takes(r) &&
        ((r.status === 'pending' && r.availableAt <= now) ||
          (r.status === 'processing' && r.leaseUntil < now)),
    );
    if (!row) {
      return null;
    }
    this.#seq += 1;
    row.status = 'processing';
    row.attempts += 1;
    row.token = `lease-${this.#seq}`;
    row.leaseUntil = now + leaseMs;
    const leased: ClaimedTask = {
      taskId: row.id,
      resizer: row.task.resizer,
      queue: row.task.queue,
      mediaId: row.task.mediaId,
      pipeline: row.task.pipeline,
      previews: row.task.previews,
      token: row.token,
      attempts: row.attempts,
      ...(row.task.gateOwner === undefined
        ? {}
        : { gateOwner: row.task.gateOwner }),
    };
    this.leases.push(leased);
    return leased;
  }

  /** The row `task` still holds under its lease token. */
  protected held(task: ClaimedTask): Row | undefined {
    return this.rows.find(
      (r) =>
        r.id === task.taskId &&
        r.status === 'processing' &&
        r.token === task.token,
    );
  }

  /**
   * The body of `release` for the queues that have it: a held task is due again at once, behind
   * the tasks already due (like the database queue, which claims the task that became due first),
   * and the delivery is not counted. `active` is unchanged. `false` when the task is not held.
   */
  protected giveBack(task: ClaimedTask): boolean {
    const row = this.held(task);
    if (!row) {
      return false;
    }
    this.rows.splice(this.rows.indexOf(row), 1);
    row.status = 'pending';
    row.token = null;
    row.availableAt = 0;
    row.attempts -= 1;
    this.rows.push(row);
    return true;
  }

  async renew(task: ClaimedTask, leaseMs: number): Promise<boolean> {
    const row = this.held(task);
    if (!row) {
      return false;
    }
    row.leaseUntil = Date.now() + leaseMs;
    return true;
  }

  async complete(task: ClaimedTask): Promise<boolean> {
    const row = this.held(task);
    if (!row) {
      return false;
    }
    row.status = 'completed';
    row.active = false;
    return true;
  }

  /** Without a gate there is no cooldown to keep: `opts.cooldownMs` is ignored. */
  async fail(
    task: ClaimedTask,
    next: { retryAt: Date } | 'dead',
    error: string,
    _opts?: FailOptions,
  ): Promise<boolean> {
    const row = this.held(task);
    if (!row) {
      return false;
    }
    row.error = error;
    if (next === 'dead') {
      row.status = 'dead';
    } else {
      row.status = 'pending';
      row.token = null;
      row.availableAt = next.retryAt.getTime();
    }
    return true;
  }
}

export interface MemoryTaskQueueOptions extends RowQueueOptions {
  /** The cooldown clock (default Date.now). Leases and retry times stay on Date.now. */
  now?: () => number;
}

/**
 * The in-memory database queue. It keeps one active task per Resizer, media, pipeline and queue:
 * `add` reports any other active task as `in-flight`, through its retries and a `release`, until
 * `complete`. A dead task holds the gate for the `cooldownMs` given to `fail`; after that the next
 * `add` takes it over. `claim` honours `resizers`.
 */
export class MemoryTaskQueue extends RowQueue {
  readonly gatesByTask = true;
  readonly claimFilters = true;
  readonly #now: () => number;

  constructor(opts: MemoryTaskQueueOptions = {}) {
    super(opts);
    this.#now = opts.now ?? (() => Date.now());
  }

  /** The active row of this Resizer, media, pipeline and queue: the gate. */
  #gate(key: {
    resizer: string;
    mediaId: string;
    pipeline: string;
    queue: string;
  }): Row | undefined {
    return this.rows.find(
      (row) =>
        row.active &&
        row.task.resizer === key.resizer &&
        row.task.mediaId === key.mediaId &&
        row.task.pipeline === key.pipeline &&
        row.task.queue === key.queue,
    );
  }

  async add(task: NewTask): Promise<TaskAddResult> {
    const gate = this.#gate(task);
    if (gate) {
      const cooledDown =
        gate.status === 'dead' &&
        (gate.cooldownUntil === undefined || gate.cooldownUntil <= this.#now());
      if (!cooledDown) {
        this.added.push(task);
        return { status: 'in-flight', taskId: gate.id };
      }
      // The dead task's cooldown is over: it stops being the gate, and this task takes its place.
      gate.active = false;
    }
    return super.add(task);
  }

  async claim(
    queue: string,
    leaseMs: number,
    _signal?: AbortSignal,
    opts?: ClaimOptions,
  ): Promise<ClaimedTask | null> {
    const served = opts?.resizers;
    return this.claimFirst(
      queue,
      leaseMs,
      (row) => served === undefined || served.includes(row.task.resizer),
    );
  }

  async fail(
    task: ClaimedTask,
    next: { retryAt: Date } | 'dead',
    error: string,
    opts?: FailOptions,
  ): Promise<boolean> {
    const row = this.held(task);
    if (!row || !(await super.fail(task, next, error))) {
      return false;
    }
    if (next === 'dead') {
      row.cooldownUntil = this.#now() + (opts?.cooldownMs ?? 0);
    }
    return true;
  }

  /** Give a held task back; it keeps the gate. */
  async release(task: ClaimedTask): Promise<boolean> {
    return this.giveBack(task);
  }

  /** The gate, while it is pending or processing; a dead task is never reported. */
  async findActive(query: {
    resizer: string;
    mediaId: string;
    pipeline: string;
    queue: string;
  }): Promise<EnqueueReceipt[]> {
    const gate = this.#gate(query);
    if (!gate || (gate.status !== 'pending' && gate.status !== 'processing')) {
      return [];
    }
    return [{ taskId: gate.id, previews: gate.task.previews }];
  }
}

/**
 * The SQS shape: no gate, no claim filter and no findActive. Every `add` stores a row, and any
 * worker may claim any Resizer's task.
 */
export class PlainTaskQueue extends RowQueue {}

/**
 * PlainTaskQueue with `release`, which gives a held task back as MemoryTaskQueue's does: due again
 * at once, behind the tasks already due, and the delivery is not counted. `releaseCalls` lists the
 * task ids passed to `release`.
 */
export class ReleasingTaskQueue extends PlainTaskQueue {
  readonly releaseCalls: string[] = [];

  async release(task: ClaimedTask): Promise<boolean> {
    this.releaseCalls.push(task.taskId);
    return this.giveBack(task);
  }
}

/**
 * An in-memory task queue (MemoryTaskQueue unless `Queue` says otherwise) that records the queue
 * name of every claim in `claimedQueues` and calls `onIdle` with them whenever a claim finds
 * nothing, so a test can stop an idle worker deterministically once its work is handled. The
 * default stops a framework worker the way the host does, with SIGTERM. Pass PlainTaskQueue when a
 * task of a Resizer the worker does not serve must fail rather than be given back. The claim
 * passes no filter on, so a test sees every Resizer's tasks.
 */
export function observedQueue(
  onIdle: (claimedQueues: readonly string[]) => void = () =>
    process.emit('SIGTERM'),
  Queue: typeof MemoryTaskQueue | typeof PlainTaskQueue = MemoryTaskQueue,
): { tasks: MemoryTaskQueue | PlainTaskQueue; claimedQueues: string[] } {
  const tasks = new Queue({ timing: { idlePollMs: 1 } });
  const claimedQueues: string[] = [];
  const claim = tasks.claim.bind(tasks);
  tasks.claim = async (queue: string, leaseMs: number) => {
    claimedQueues.push(queue);
    const next = await claim(queue, leaseMs);
    if (!next) {
      onIdle(claimedQueues);
    }
    return next;
  };
  return { tasks, claimedQueues };
}

/**
 * An `onIdle` for observedQueue that stops a framework worker with SIGTERM once every one of
 * `names` has been claimed, and only once: a worker on several queues has one claim loop per
 * queue, and each of them may find nothing.
 */
export function sigtermOnceClaimed(
  names: readonly string[],
): (claimedQueues: readonly string[]) => void {
  let sent = false;
  return (claimedQueues) => {
    if (!sent && names.every((name) => claimedQueues.includes(name))) {
      sent = true;
      process.emit('SIGTERM');
    }
  };
}

/**
 * A queue driver with the given `validate` (none by default): its `fromConfig` builds a
 * PlainTaskQueue serving exactly the names of the entries it is given.
 */
export function fakeQueueDriver(
  validate?: QueueDriver['validate'],
): QueueDriver {
  return {
    ...(validate ? { validate } : {}),
    fromConfig: (entries) =>
      new PlainTaskQueue({ queues: entries.map((entry) => entry.name) }),
  };
}

/** What DatabaseParts.taskQueue is given. */
export type DatabaseTaskQueueOptions = Parameters<
  NonNullable<DatabaseParts['taskQueue']>
>[0];

/**
 * Database parts over fakeMedia and memoryLocks. `taskQueue` builds a MemoryTaskQueue serving
 * exactly the names it is given and records each call's options in `taskQueueCalls`, with the
 * queue it built in `built`.
 */
export function fakeDatabaseParts(): DatabaseParts & {
  taskQueueCalls: DatabaseTaskQueueOptions[];
  built: MemoryTaskQueue[];
} {
  const taskQueueCalls: DatabaseTaskQueueOptions[] = [];
  const built: MemoryTaskQueue[] = [];
  return {
    media: fakeMedia(),
    locks: memoryLocks(),
    taskQueueCalls,
    built,
    taskQueue(opts) {
      taskQueueCalls.push(opts);
      const tasks = new MemoryTaskQueue({ queues: opts.queues });
      built.push(tasks);
      return tasks;
    },
  };
}
