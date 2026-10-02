// Mongo transport (05 · §10.2). Backed by a `ResizeTask` mongoose model passed in as `model`
// (or resolved lazily through `getModel`); the framework adapter's
// createFrameworkMongoTransport() wires the framework's model, logger and config timing. Owns
// the lease/complete/fail/renew/dead-letter-sweep lifecycle and drives the worker's poll loop.
// Delivery is at-least-once; correctness rests on the atomic findOneAndUpdate claim + the
// fencing `leaseToken` (a 0-matched guarded update = this worker lost the lease → drop it).
//
// `lease`/`complete`/`fail`/`renew`/`sweepDeadLetters`/`backoff` are transport-internal but
// PUBLIC methods (unit tests drive them; not part of the QueueTransport interface).
//
// Exported from `…/drivers/mongo.js`. It extends the QueueTransport contract
// (src/contracts/transport.ts) and imports no framework code and no mongoose.
import { defaultQueueOptions } from '../../config/resize.ts';
import type { LockStore } from '../../contracts/lockStore.ts';
import {
  type EnqueueTask,
  type LeasedTask,
  QueueTransport,
  type StartWorkerOpts,
  type TaskEvent,
  type TaskEventHandler,
} from '../../contracts/transport.ts';
import { buildRequestKey, canonicalizeVariants } from '../../enqueue.ts';
import { ResizeError, ResizeSetupError } from '../../errors.ts';
import { randomHex } from '../../helpers/random.ts';
import { sleep } from '../../helpers/sleep.ts';
import { validateQueueTiming } from '../../resizeConfig.ts';
import type {
  EnqueueReceipt,
  MissingPreview,
  QueueTimingOptions,
  ResizeLogger,
} from '../../types.d.ts';

// The mongoose model the transport calls (findOneAndUpdate / findOne / find). Typed loosely so
// the module stays free of mongoose types.
// biome-ignore lint/suspicious/noExplicitAny: a host-registered mongoose model
type TaskModel = any;

export interface MongoTransportOptions {
  // The ResizeTask model. Pass `model`, or `getModel` when the model is registered later
  // (resolved on every use). Exactly one of the two.
  model?: TaskModel;
  getModel?: () => TaskModel;
  // REQUIRED: the locks this queue's work is coordinated with (dispatch + worker locks), e.g.
  // new MongoLockStore({ model: ResizeLock }); framework hosts get FrameworkLockStore.
  locks: LockStore;
  lockTtlMs?: { dispatch: number; worker: number }; // default 60000 each; worker must be ≤ leaseMs
  logger?: ResizeLogger; // default: console
  leaseMs?: number; // default 60000 — heartbeat renews at leaseMs / 2
  retryBackoffMs?: { base: number; max: number }; // default { base: 5000, max: 300000 }
  maxAttempts?: number; // default 5 — deliveries before dead-letter
  idlePollMs?: number; // default 1000 — sleep after an empty lease
  // Timing read on first use instead of now (the framework adapter reads it from a config file
  // that may not be loaded yet). The plain timing options above override what it returns.
  getTiming?: () => Partial<QueueTimingOptions>;
  taskTimeoutMs?: number; // default 600000 — a task running longer is failed
}

// The subset of the ResizeTask document the transport reads. The model itself is dynamic
// (getModel returns `any` by design — the module stays mongoose-type-free), so the
// findOneAndUpdate results are cast to this shape.
interface TaskDoc {
  _id: { toString(): string };
  fileId: { toString(): string };
  resizer?: string;
  queue?: string;
  pipeline: string;
  requestKey?: string;
  previews: MissingPreview[];
  status: string;
  attempts: number;
  leasedBy?: string;
  leaseToken: string | null;
  leaseExpiresAt?: Date | null;
  completedAt?: Date | null;
  deadAt?: Date | null;
  error?: string | null;
}

// The fencing filter shared by complete/fail/renew: a 0-match means the lease was lost.
// The token+status ARE the fence (05 · §10.2 fix): it deliberately does NOT require an unexpired
// leaseExpiresAt. A worker whose lease merely LAPSED without being re-claimed still holds the
// winning token and MUST be able to complete its finished work; requiring `$gt: now` turned a
// just-expired successful task into a spurious re-process/dead-letter. A re-claim mints a NEW
// token, so the old token still 0-matches (correctness preserved).
function fence(taskId: string, leaseToken: string) {
  return {
    _id: taskId,
    leaseToken,
    status: 'processing',
  };
}

// The transport-agnostic LeasedTask built from a doc — the shape EVERY observer receives (04 · §9
// review fix). Maps host-owned `fileId` → generic `mediaId`; never leaks the raw Mongo document
// (which carries `fileId` and lease internals), so host taps stay portable across transports.
function toLeasedTask(doc: TaskDoc): LeasedTask {
  return {
    taskId: doc._id.toString(),
    resizer: doc.resizer ?? 'default',
    queue: doc.queue ?? 'default',
    mediaId: doc.fileId.toString(),
    pipeline: doc.pipeline,
    previews: doc.previews ?? [],
  };
}

// Rows written before tasks carried a resizer/queue have neither field; they belong to
// 'default'. `$in` with null matches a missing field.
function named(value: string) {
  return value === 'default' ? { $in: ['default', null] } : value;
}

function activeRequestFilter(
  mediaId: string,
  pipeline: string,
  requestKey: string,
) {
  return {
    fileId: mediaId,
    pipeline,
    requestKey,
    status: { $in: ['pending', 'processing'] },
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  return (
    (error as { code?: unknown }).code === 11000 ||
    /duplicate key/i.test(
      String((error as { message?: unknown }).message ?? error),
    )
  );
}

const TIMING_KEYS = [
  'lockTtlMs',
  'leaseMs',
  'retryBackoffMs',
  'maxAttempts',
  'idlePollMs',
  'taskTimeoutMs',
] as const;

/** The Mongo-backed queue transport (05 · §10.2). */
export class MongoTransport extends QueueTransport {
  readonly locks: LockStore;
  readonly #model: TaskModel;
  readonly #getModel: (() => TaskModel) | undefined;
  readonly #logger: ResizeLogger;
  readonly #explicitTiming: Partial<QueueTimingOptions>;
  readonly #getTiming: (() => Partial<QueueTimingOptions>) | undefined;
  #timing: QueueTimingOptions | undefined;

  constructor(opts: MongoTransportOptions) {
    super();
    if (!opts || (opts.model === undefined) === (opts.getModel === undefined)) {
      throw new ResizeSetupError(
        "resize mongo transport: pass exactly one of `model` (the ResizeTask model) or `getModel`; framework hosts: use createFrameworkMongoTransport() from '@adaptivestone/framework-module-resize/framework.js'",
        { code: 'RESIZE_MONGO_MODEL_REQUIRED' },
      );
    }
    if (!opts.locks) {
      throw new ResizeSetupError(
        'resize mongo transport: `locks` is required (e.g. new MongoLockStore({ model: ResizeLock }))',
        { code: 'RESIZE_LOCKS_REQUIRED' },
      );
    }
    this.#model = opts.model;
    this.#getModel = opts.getModel;
    this.#logger = opts.logger ?? console;
    this.locks = opts.locks;
    const explicit: Partial<QueueTimingOptions> = {};
    for (const key of TIMING_KEYS) {
      if (opts[key] !== undefined) {
        Object.assign(explicit, { [key]: opts[key] });
      }
    }
    this.#explicitTiming = explicit;
    this.#getTiming = opts.getTiming;
    if (!this.#getTiming) {
      this.#resolveTiming(); // validate now: fail at construction, not at the first task
    }
  }

  // Defaults, then the lazily read timing, then the explicit options; validated once.
  #resolveTiming(): QueueTimingOptions {
    if (!this.#timing) {
      const timing = {
        ...defaultQueueOptions,
        ...this.#getTiming?.(),
        ...this.#explicitTiming,
      };
      validateQueueTiming(timing);
      this.#timing = timing;
    }
    return this.#timing;
  }

  /** Lease length in ms; the heartbeat renews it at leaseMs / 2. */
  get leaseMs(): number {
    return this.#resolveTiming().leaseMs;
  }

  /** Dispatch and worker lock TTLs in ms (the worker lock is within the lease). */
  getLockTtlMs(): { dispatch: number; worker: number } {
    return this.#resolveTiming().lockTtlMs;
  }

  // Resolve the model, tolerating a falsy getter result (a mis-registered host model) with a
  // logged soft-fail rather than a TypeError.
  #taskModel(): TaskModel | null {
    const model = this.#getModel ? this.#getModel() : this.#model;
    if (!model) {
      this.#logger.error(
        'resize mongo transport: the ResizeTask model is missing — register (scaffold) the ResizeTask model (08 · §12)',
      );
      return null;
    }
    return model;
  }

  // Task events go to the worker's callback, which routes them to the owning Resizer. A
  // throwing callback (a host observer bug) is logged: the task's state is already written, and
  // the worker loop must keep running.
  async #report(
    onEvent: TaskEventHandler | undefined,
    event: TaskEvent,
    task: LeasedTask,
    error?: unknown,
  ): Promise<void> {
    if (!onEvent) {
      return;
    }
    try {
      await onEvent(event, task, error);
    } catch (err) {
      this.#logger.error(
        `resize mongo transport: ${event} event handler failed`,
        err,
      );
    }
  }

  /** `min(max, base * 2 ** (n - 1))` from the retryBackoffMs option (05 · §10.2). */
  backoff(attempts: number): number {
    const { base, max } = this.#resolveTiming().retryBackoffMs;
    return Math.min(max, base * 2 ** (attempts - 1));
  }

  // -------------------------------------------------------------------------
  // Transport-internal lifecycle (public methods, driven by unit tests).
  // -------------------------------------------------------------------------

  /**
   * Atomic claim of the oldest eligible task (also reclaims a crashed worker's expired lease,
   * but NEVER an exhausted one — `attempts < maxAttempts`). Mints a fresh fencing leaseToken.
   * Returns the leased doc or null when nothing is eligible. Only tasks of `queue` are
   * considered, so a worker never takes another queue's work. (05 · §10.2)
   */
  async lease(queue = 'default'): Promise<TaskDoc | null> {
    const model = this.#taskModel();
    if (!model) {
      return null;
    }
    const leaseMs = this.leaseMs;
    const maxAttempts = this.#resolveTiming().maxAttempts;
    const now = new Date();
    const doc = await model.findOneAndUpdate(
      {
        queue: named(queue),
        attempts: { $lt: maxAttempts },
        $or: [
          {
            status: 'pending',
            $or: [
              { leaseExpiresAt: { $exists: false } },
              { leaseExpiresAt: null },
              { leaseExpiresAt: { $lt: now } },
            ],
          },
          { status: 'processing', leaseExpiresAt: { $lt: now } },
        ],
      },
      {
        $set: {
          status: 'processing',
          leasedBy: `resizer-${process.pid}`,
          leaseToken: randomHex(),
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
        },
        $inc: { attempts: 1 },
      },
      { sort: { createdAt: 1 }, returnDocument: 'after' },
    );
    return doc as TaskDoc | null;
  }

  /**
   * Guarded completion. On a matched update, report `completed`; a 0-match (lease lost)
   * drops the result WITHOUT reporting. Returns whether the lease was still held. (05 · §10.2)
   */
  async complete(
    taskId: string,
    leaseToken: string,
    onEvent?: TaskEventHandler,
  ): Promise<boolean> {
    const model = this.#taskModel();
    if (!model) {
      return false;
    }
    const now = new Date();
    const doc = (await model.findOneAndUpdate(
      fence(taskId, leaseToken),
      { $set: { status: 'completed', completedAt: now } },
      { returnDocument: 'after' },
    )) as TaskDoc | null;
    if (!doc) {
      return false;
    }
    await this.#report(onEvent, 'completed', toLeasedTask(doc));
    return true;
  }

  /**
   * Guarded failure with backoff → dead-letter. `attempts` is the lease-incremented count
   * from the leased doc. If `attempts < maxAttempts` → back to `pending` with a future
   * leaseExpiresAt (so the pending branch only re-claims after the backoff elapses) + report
   * `failed`; else → `dead` + report `deadLettered`. A 0-match (lease lost) is a
   * no-op. (05 · §10.2)
   */
  async fail(
    taskId: string,
    leaseToken: string,
    error: unknown,
    attempts: number,
    onEvent?: TaskEventHandler,
  ): Promise<void> {
    const model = this.#taskModel();
    if (!model) {
      return;
    }
    const maxAttempts = this.#resolveTiming().maxAttempts;
    const now = new Date();
    // A persisted media row without an original is a deterministic terminal failure. Keep the
    // normal retry policy for every other error (including errors that merely happen to expose a
    // different `code` field). ResizeNoOriginalError crosses the transport boundary as an
    // ordinary error object, so discriminate by its stable machine-readable code rather than
    // by instanceof.
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    const terminalNoOriginal = code === 'RESIZE_NO_ORIGINAL' && attempts >= 1;
    if (!terminalNoOriginal && attempts < maxAttempts) {
      const doc = (await model.findOneAndUpdate(
        fence(taskId, leaseToken),
        {
          $set: {
            status: 'pending',
            leaseToken: null,
            leaseExpiresAt: new Date(now.getTime() + this.backoff(attempts)),
          },
        },
        { returnDocument: 'after' },
      )) as TaskDoc | null;
      if (doc) {
        await this.#report(onEvent, 'failed', toLeasedTask(doc), error);
      }
      return;
    }
    const doc = (await model.findOneAndUpdate(
      fence(taskId, leaseToken),
      {
        $set: {
          status: 'dead',
          deadAt: now,
          error: String(error).slice(0, 1000),
        },
      },
      { returnDocument: 'after' },
    )) as TaskDoc | null;
    if (doc) {
      await this.#report(onEvent, 'deadLettered', toLeasedTask(doc), error);
    }
  }

  /**
   * Guarded lease extension (the worker heartbeat). A 0-match means the lease was lost.
   * Returns whether the lease was still held. (05 · §10.2)
   */
  async renew(taskId: string, leaseToken: string): Promise<boolean> {
    const model = this.#taskModel();
    if (!model) {
      return false;
    }
    const leaseMs = this.leaseMs;
    const now = new Date();
    const doc = await model.findOneAndUpdate(
      fence(taskId, leaseToken),
      { $set: { leaseExpiresAt: new Date(now.getTime() + leaseMs) } },
      { returnDocument: 'after' },
    );
    return doc !== null;
  }

  /**
   * Per-row claim-to-dead sweep of crash-looped tasks (a worker that died never called
   * `fail`, so the task is stuck `processing`). findOneAndUpdate per row so EXACTLY ONE
   * worker reports it (updateMany returns only a count → can't enumerate). (05 · §10.2)
   */
  async sweepDeadLetters(onEvent?: TaskEventHandler): Promise<void> {
    const model = this.#taskModel();
    if (!model) {
      return;
    }
    const maxAttempts = this.#resolveTiming().maxAttempts;
    const now = new Date();
    const err = 'max attempts exceeded (crash loop)';
    const filter = {
      status: 'processing',
      leaseExpiresAt: { $lt: now },
      attempts: { $gte: maxAttempts },
    };
    for (;;) {
      const dead = (await model.findOneAndUpdate(
        filter,
        { $set: { status: 'dead', deadAt: now, error: err } },
        { returnDocument: 'after' },
      )) as TaskDoc | null;
      if (!dead) {
        break; // none left this poll
      }
      await this.#report(
        onEvent,
        'deadLettered',
        toLeasedTask(dead),
        new Error(err),
      );
    }
  }

  // -------------------------------------------------------------------------
  // enqueue + startWorker (the QueueTransport surface).
  // -------------------------------------------------------------------------

  async enqueue(task: EnqueueTask): Promise<{ taskId: string | null }> {
    const model = this.#taskModel();
    if (!model) {
      return { taskId: null };
    }
    const previews = canonicalizeVariants(task.previews);
    const requestKey = buildRequestKey({
      mediaId: task.mediaId,
      resizer: task.resizer,
      queue: task.queue,
      pipeline: task.pipeline,
      previews,
    });
    const filter = activeRequestFilter(task.mediaId, task.pipeline, requestKey);
    const upsert = () =>
      model.findOneAndUpdate(
        filter,
        {
          $setOnInsert: {
            fileId: task.mediaId,
            resizer: task.resizer,
            queue: task.queue,
            pipeline: task.pipeline,
            requestKey,
            previews,
            status: 'pending',
            attempts: 0,
          },
        },
        {
          upsert: true,
          returnDocument: 'after',
          setDefaultsOnInsert: true,
          runValidators: true,
          writeConcern: { w: 'majority' },
        },
      );

    // An E11000 winner can finish between our conflict and reread. In that
    // narrow window another caller may win the replacement active row before
    // our retry, producing another E11000. Reread after each duplicate race;
    // three attempts bound contention without turning enqueue into an unbounded
    // retry loop when the database is unhealthy.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const doc = await upsert();
        return { taskId: doc ? String(doc._id) : null };
      } catch (err) {
        if (!isDuplicateKeyError(err)) {
          this.#logger.error(
            `resize mongo transport: enqueue failed for media ${task.mediaId}`,
            err,
          );
          return { taskId: null };
        }
        try {
          const existing = await model.findOne(filter);
          if (existing) {
            return { taskId: String(existing._id) };
          }
        } catch (raceError) {
          this.#logger.error(
            `resize mongo transport: enqueue duplicate-key reread failed for media ${task.mediaId}`,
            raceError,
          );
          return { taskId: null };
        }
      }
    }

    this.#logger.error(
      `resize mongo transport: enqueue remained contended after duplicate-key retries for media ${task.mediaId}`,
    );
    return { taskId: null };
  }

  // Any queue: a task already waiting on another queue still covers the request.
  async findActive(task: EnqueueTask): Promise<EnqueueReceipt[]> {
    const model = this.#taskModel();
    if (!model) {
      return [];
    }
    const docs = (await model.find({
      fileId: task.mediaId,
      resizer: named(task.resizer),
      pipeline: task.pipeline,
      status: { $in: ['pending', 'processing'] },
    })) as TaskDoc[];
    return docs.map((doc) => ({
      taskId: String(doc._id),
      previews: canonicalizeVariants(doc.previews ?? []),
    }));
  }

  async startWorker(
    handleTask: (
      task: LeasedTask,
      taskOpts?: { signal: AbortSignal },
    ) => Promise<void>,
    opts: StartWorkerOpts,
  ): Promise<void> {
    const leaseMs = this.leaseMs;
    const idlePollMs = this.#resolveTiming().idlePollMs;
    const taskTimeoutMs = this.#resolveTiming().taskTimeoutMs;
    const heartbeatMs = Math.max(1, Math.floor(leaseMs / 2));

    while (!opts.signal.aborted) {
      // Loop resilience (F11 — 05 · §10.2): a transient DB error in the sweep+lease must NOT kill
      // the daemon — log, sleep idlePollMs, and retry forever (mongoose buffers short blips; a
      // sustained outage becomes perpetual log-and-retry, by design).
      let doc: TaskDoc | null;
      try {
        // Cheap, indexed dead-letter sweep, then claim.
        await this.sweepDeadLetters(opts.onEvent);
        doc = await this.lease(opts.queue);
      } catch (err) {
        this.#logger.error(
          'resize mongo transport: poll iteration failed (sweep/lease) — retrying after idlePollMs',
          err,
        );
        await sleep(idlePollMs, opts.signal);
        continue;
      }
      if (!doc) {
        await sleep(idlePollMs, opts.signal);
        continue;
      }

      // leaseToken + attempts stay in THIS loop's closure — never on LeasedTask (05 · §10.1).
      const leaseToken = doc.leaseToken as string;
      const { attempts } = doc;
      const task: LeasedTask = toLeasedTask(doc);

      // Per-task lease-loss signal + heartbeat: a 0-matched renew aborts the task (best-effort).
      const taskController = new AbortController();
      // Shutdown wiring (05 · §10.2): worker-wide opts.signal ALSO aborts the CURRENT task, so an
      // in-flight task finishes its current variant, skips the rest, and the loop exits promptly.
      const onShutdown = () => taskController.abort();
      opts.signal.addEventListener('abort', onShutdown, { once: true });
      if (opts.signal.aborted) {
        taskController.abort(); // aborted between the while-check and here — honor it
      }
      // Arrow closure keeps `this` bound to the transport instance for the renew call.
      const heartbeat = setInterval(() => {
        this.renew(task.taskId, leaseToken)
          .then((held) => {
            if (!held) {
              taskController.abort();
            }
          })
          .catch((e) => {
            this.#logger.error(
              'resize mongo transport: heartbeat renew failed',
              e,
            );
          });
      }, heartbeatMs);

      // Task timeout (05 · §10.2): race handleTask against taskTimeoutMs. Without it one hung I/O
      // call wedges the slot forever — the heartbeat keeps renewing, so even the sweep can't
      // reclaim it. The handler's rejection is always handled here (onReject sets handlerError),
      // so a detached handler that settles AFTER a timeout never becomes an unhandled rejection.
      let handlerError: unknown;
      let ok = false;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, taskTimeoutMs);
      });
      try {
        await Promise.race([
          handleTask(task, { signal: taskController.signal }).then(
            () => {
              ok = true;
            },
            (err) => {
              handlerError = err;
            },
          ),
          timeout,
        ]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
        clearInterval(heartbeat);
        opts.signal.removeEventListener('abort', onShutdown);
      }

      // Completion and event reporting are the transport's job.
      if (timedOut) {
        // Abort the (still-running, detached) handler and fail the task; the detached work is
        // harmless — a later complete/fail is token-fenced and any $push writes valid previews.
        taskController.abort();
        await this.fail(
          task.taskId,
          leaseToken,
          // Base ResizeError, not a subclass: this never reaches a host `catch` — it is stored
          // as the task's failure reason — so no `instanceof` will ever discriminate it.
          new ResizeError(
            `resize mongo transport: task ${task.taskId} exceeded taskTimeoutMs (${taskTimeoutMs}ms)`,
            { code: 'RESIZE_TASK_TIMEOUT' },
          ),
          attempts,
          opts.onEvent,
        );
      } else if (ok) {
        // Graceful: this in-flight task finished before we re-check opts.signal at the loop top.
        await this.complete(task.taskId, leaseToken, opts.onEvent);
      } else {
        await this.fail(
          task.taskId,
          leaseToken,
          handlerError,
          attempts,
          opts.onEvent,
        );
      }
    }
  }
}
