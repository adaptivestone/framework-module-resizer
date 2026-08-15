// Mongo transport (05 · §10.2) — DEFAULT, option-less class (`new MongoTransport()`). Backed by
// the host-scaffolded `ResizeTask` model, reached through getApp().getModel('ResizeTask'). Owns
// the lease/complete/fail/renew/dead-letter-sweep lifecycle and drives the worker's poll loop.
// Delivery is at-least-once; correctness rests on the atomic findOneAndUpdate claim + the
// fencing `leaseToken` (a 0-matched guarded update = this worker lost the lease → drop it).
//
// `lease`/`complete`/`fail`/`renew`/`sweepDeadLetters`/`backoff` are transport-internal but
// PUBLIC methods (unit tests drive them; not part of the QueueTransport interface).
//
// Subpath entry `…/transports/mongo.js` (uniform rule 02 · §6): the QueueTransport/LeasedTask
// contract comes from ./AbstractTransport.ts (not resizer.ts); no optional deps, so importing
// this driver is always safe (05 · §10.2).
import { getApp } from '../app.ts';
import { getResizeConfig } from '../config/resize.ts';
import { ResizeError } from '../errors.ts';
import { randomHex } from '../helpers/random.ts';
import { sleep } from '../helpers/sleep.ts';
import { getResizer } from '../resizer.ts';
import type { MissingPreview } from '../types.d.ts';
import type { LeasedTask, QueueTransport } from './AbstractTransport.ts';

// The subset of the ResizeTask document the transport reads. The model itself is dynamic
// (getModel returns `any` by design — the module stays mongoose-type-free), so the
// findOneAndUpdate results are cast to this shape.
interface TaskDoc {
  _id: { toString(): string };
  fileId: { toString(): string };
  pipeline: string;
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

// Resolve the model, tolerating a falsy getModel (mis-scaffolded host) with a logged
// soft-fail rather than a TypeError.
function taskModel(): ReturnType<ReturnType<typeof getApp>['getModel']> | null {
  const model = getApp().getModel('ResizeTask');
  if (!model) {
    getApp().logger.error(
      'resize mongo transport: getModel("ResizeTask") returned falsy — scaffold the ResizeTask model (08 · §12)',
    );
    return null;
  }
  return model;
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
    mediaId: doc.fileId.toString(),
    pipeline: doc.pipeline,
    previews: doc.previews ?? [],
  };
}

/** The default transport — an option-less class (`new MongoTransport()`) (05 · §10.2). */
export class MongoTransport implements QueueTransport {
  /** `min(max, base * 2 ** (n - 1))` from config.queue.retryBackoffMs (05 · §10.2). */
  backoff(attempts: number): number {
    const { base, max } = getResizeConfig().queue.retryBackoffMs;
    return Math.min(max, base * 2 ** (attempts - 1));
  }

  // -------------------------------------------------------------------------
  // Transport-internal lifecycle (public methods, driven by unit tests).
  // -------------------------------------------------------------------------

  /**
   * Atomic claim of the oldest eligible task (also reclaims a crashed worker's expired lease,
   * but NEVER an exhausted one — `attempts < maxAttempts`). Mints a fresh fencing leaseToken.
   * Returns the leased doc or null when nothing is eligible. (05 · §10.2)
   */
  async lease(): Promise<TaskDoc | null> {
    const model = taskModel();
    if (!model) {
      return null;
    }
    const { leaseMs, maxAttempts } = getResizeConfig().queue;
    const now = new Date();
    const doc = await model.findOneAndUpdate(
      {
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
   * Guarded completion. On a matched update, fire `afterTaskComplete`; a 0-match (lease lost)
   * drops the result WITHOUT firing. Returns whether the lease was still held. (05 · §10.2)
   */
  async complete(taskId: string, leaseToken: string): Promise<boolean> {
    const model = taskModel();
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
    await getResizer().runObservers('afterTaskComplete', toLeasedTask(doc), {});
    return true;
  }

  /**
   * Guarded failure with backoff → dead-letter. `attempts` is the lease-incremented count
   * from the leased doc. If `attempts < maxAttempts` → back to `pending` with a future
   * leaseExpiresAt (so the pending branch only re-claims after the backoff elapses) + fire
   * `onTaskFailed`; else → `dead` + fire `onTaskDeadLettered`. A 0-match (lease lost) is a
   * no-op. (05 · §10.2)
   */
  async fail(
    taskId: string,
    leaseToken: string,
    error: unknown,
    attempts: number,
  ): Promise<void> {
    const model = taskModel();
    if (!model) {
      return;
    }
    const { maxAttempts } = getResizeConfig().queue;
    const now = new Date();
    if (attempts < maxAttempts) {
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
        await getResizer().runObservers(
          'onTaskFailed',
          toLeasedTask(doc),
          error,
          {},
        );
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
      await getResizer().runObservers(
        'onTaskDeadLettered',
        toLeasedTask(doc),
        error,
        {},
      );
    }
  }

  /**
   * Guarded lease extension (the worker heartbeat). A 0-match means the lease was lost.
   * Returns whether the lease was still held. (05 · §10.2)
   */
  async renew(taskId: string, leaseToken: string): Promise<boolean> {
    const model = taskModel();
    if (!model) {
      return false;
    }
    const { leaseMs } = getResizeConfig().queue;
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
   * worker fires the observer (updateMany returns only a count → can't enumerate). (05 · §10.2)
   */
  async sweepDeadLetters(): Promise<void> {
    const model = taskModel();
    if (!model) {
      return;
    }
    const { maxAttempts } = getResizeConfig().queue;
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
      await getResizer().runObservers(
        'onTaskDeadLettered',
        toLeasedTask(dead),
        new Error(err),
        {},
      );
    }
  }

  // -------------------------------------------------------------------------
  // enqueue + startWorker (the QueueTransport surface).
  // -------------------------------------------------------------------------

  async enqueue(task: {
    mediaId: string;
    pipeline: string;
    previews: MissingPreview[];
  }): Promise<{ taskId: string | null }> {
    const model = taskModel();
    if (!model) {
      return { taskId: null };
    }
    try {
      // Array form + options is the correct mongoose 9 shape for a durable single-doc create
      // with a write concern (a plain `create(doc, options)` mis-reads the options as a second
      // document). Maps the generic `mediaId` → host-owned `fileId`.
      const [doc] = await model.create(
        [
          {
            fileId: task.mediaId,
            pipeline: task.pipeline,
            previews: task.previews,
            status: 'pending',
            attempts: 0,
          },
        ],
        { writeConcern: { w: 'majority' } },
      );
      return { taskId: String(doc._id) };
    } catch (err) {
      getApp().logger.error(
        `resize mongo transport: enqueue failed for media ${task.mediaId}`,
        err,
      );
      return { taskId: null };
    }
  }

  async startWorker(
    handleTask: (
      task: LeasedTask,
      taskOpts?: { signal: AbortSignal },
    ) => Promise<void>,
    opts: { signal: AbortSignal },
  ): Promise<void> {
    const { leaseMs, idlePollMs, taskTimeoutMs } = getResizeConfig().queue;
    const heartbeatMs = Math.max(1, Math.floor(leaseMs / 2));

    while (!opts.signal.aborted) {
      // Loop resilience (F11 — 05 · §10.2): a transient DB error in the sweep+lease must NOT kill
      // the daemon — log, sleep idlePollMs, and retry forever (mongoose buffers short blips; a
      // sustained outage becomes perpetual log-and-retry, by design).
      let doc: TaskDoc | null;
      try {
        // Cheap, indexed dead-letter sweep, then claim.
        await this.sweepDeadLetters();
        doc = await this.lease();
      } catch (err) {
        getApp().logger.error(
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
            getApp().logger.error(
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

      // Completion + observer firing are the transport's job.
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
        );
      } else if (ok) {
        // Graceful: this in-flight task finished before we re-check opts.signal at the loop top.
        await this.complete(task.taskId, leaseToken);
      } else {
        await this.fail(task.taskId, leaseToken, handlerError, attempts);
      }
    }
  }
}
