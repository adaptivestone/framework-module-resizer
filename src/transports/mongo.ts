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
function fence(taskId: string, leaseToken: string, now: Date) {
  return {
    _id: taskId,
    leaseToken,
    status: 'processing',
    leaseExpiresAt: { $gt: now },
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
      fence(taskId, leaseToken, now),
      { $set: { status: 'completed', completedAt: now } },
      { returnDocument: 'after' },
    )) as TaskDoc | null;
    if (!doc) {
      return false;
    }
    await getResizer().runObservers('afterTaskComplete', doc, {});
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
        fence(taskId, leaseToken, now),
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
        await getResizer().runObservers('onTaskFailed', doc, error, {});
      }
      return;
    }
    const doc = (await model.findOneAndUpdate(
      fence(taskId, leaseToken, now),
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
      await getResizer().runObservers('onTaskDeadLettered', doc, error, {});
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
      fence(taskId, leaseToken, now),
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
        dead,
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
    const { leaseMs, idlePollMs } = getResizeConfig().queue;
    const heartbeatMs = Math.max(1, Math.floor(leaseMs / 2));

    while (!opts.signal.aborted) {
      // Cheap, indexed dead-letter sweep, then claim.
      await this.sweepDeadLetters();
      const doc = await this.lease();
      if (!doc) {
        await sleep(idlePollMs, opts.signal);
        continue;
      }

      // leaseToken + attempts stay in THIS loop's closure — never on LeasedTask (05 · §10.1).
      const leaseToken = doc.leaseToken as string;
      const { attempts } = doc;
      const task: LeasedTask = {
        taskId: doc._id.toString(),
        mediaId: doc.fileId.toString(),
        pipeline: doc.pipeline,
        previews: doc.previews ?? [],
      };

      // Per-task lease-loss signal + heartbeat: a 0-matched renew aborts the task (best-effort).
      // Arrow closure keeps `this` bound to the transport instance for the renew call.
      const taskController = new AbortController();
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

      let handlerError: unknown;
      let ok = false;
      try {
        await handleTask(task, { signal: taskController.signal });
        ok = true;
      } catch (err) {
        handlerError = err;
      } finally {
        clearInterval(heartbeat);
      }

      // Completion + observer firing are the transport's job. Graceful: this in-flight task
      // finished before we re-check opts.signal at the top of the loop.
      if (ok) {
        await this.complete(task.taskId, leaseToken);
      } else {
        await this.fail(task.taskId, leaseToken, handlerError, attempts);
      }
    }
  }
}
