// MongoTaskQueue: the task queue as documents of a ResizeTask model (see createResizeModels). Each
// method is one atomic findOneAndUpdate; the lease token fences every write after a claim, so a
// worker that lost its lease can never complete, fail or release a task another worker now holds.
import { hostname } from 'node:os';
import {
  type ClaimedTask,
  type NewTask,
  TaskQueue,
} from '../../contracts/taskQueue.ts';
import { ResizeSetupError } from '../../errors.ts';
import { randomHex } from '../../helpers/random.ts';
import type {
  EnqueueReceipt,
  MissingPreview,
  QueueTimingOptions,
  ResizeLogger,
} from '../../types.d.ts';

// biome-ignore lint/suspicious/noExplicitAny: a host-registered mongoose model
type TaskModel = any;

export interface MongoTaskQueueOptions {
  // The ResizeTask model, or a getter called on each use (for a model registered later).
  model?: TaskModel;
  getModel?: () => TaskModel;
  // Queue timing (lease, retries, lock TTLs); missing values use defaultQueueOptions.
  timing?: Partial<QueueTimingOptions>;
  // The same, read on first use (the framework adapter reads it from its config file).
  getTiming?: () => Partial<QueueTimingOptions>;
  logger?: ResizeLogger; // default: console
}

// The schema paths this queue writes. Mongoose strict mode silently drops a path its schema lacks:
// a model ejected before tasks carried a Resizer, queue and request key would file every task under
// Resizer 'default' on queue 'default'.
const WRITTEN_PATHS = [
  'fileId',
  'resizer',
  'queue',
  'pipeline',
  'requestKey',
  'previews',
  'status',
  'attempts',
  'leasedBy',
  'leaseToken',
  'leaseExpiresAt',
  'completedAt',
  'deadAt',
  'error',
] as const;

// Who holds a lease: the host name tells pods apart (every container's main process is pid 1).
const LEASE_HOLDER = `${hostname().slice(0, 64)}:${process.pid}`;

// The fields of a ResizeTask document this queue reads.
interface TaskDoc {
  _id: { toString(): string };
  fileId: { toString(): string };
  resizer?: string;
  queue?: string;
  pipeline: string;
  previews: MissingPreview[];
  attempts: number;
  leaseToken: string | null;
}

export class MongoTaskQueue extends TaskQueue {
  readonly #getModel: () => TaskModel;
  readonly #getTiming: () => Partial<QueueTimingOptions>;
  readonly #logger: ResizeLogger;

  constructor(opts: MongoTaskQueueOptions) {
    super();
    if (!opts || (opts.model === undefined) === (opts.getModel === undefined)) {
      throw new ResizeSetupError(
        'resize: MongoTaskQueue needs exactly one of `model` or `getModel`',
        { code: 'RESIZE_MONGO_MODEL_REQUIRED' },
      );
    }
    const { model, getModel, timing, getTiming } = opts;
    this.#getModel = getModel ?? (() => model);
    this.#getTiming = getTiming ?? (() => timing ?? {});
    this.#logger = opts.logger ?? console;
  }

  getTiming(): Partial<QueueTimingOptions> {
    return this.#getTiming();
  }

  /**
   * Startup check: the ResizeTask model must be registered, and its schema (when the model exposes
   * one) must have every field this queue writes.
   */
  verify(): void {
    const model = this.#getModel();
    if (!model) {
      throw new ResizeSetupError(
        'resize: the ResizeTask model is not registered — scaffold src/models/ResizeTask.ts (or pass `model`)',
        { code: 'RESIZE_MONGO_MODEL_MISSING' },
      );
    }
    const schema = model.schema;
    if (typeof schema?.path !== 'function') {
      return;
    }
    const missing = WRITTEN_PATHS.filter((path) => !schema.path(path));
    if (missing.length > 0) {
      throw new ResizeSetupError(
        `resize: the ResizeTask model has no ${missing.join(', ')} field(s), so Mongoose would drop them from every task — delete src/models/ResizeTask.ts and re-run resize-scaffold (add --eject for a full editable model); for a hand-written model, port the fields from resizeTaskFields()`,
        { code: 'RESIZE_MONGO_MODEL_OUTDATED' },
      );
    }
  }

  // At runtime a missing model is logged, not thrown: reads and prewarm never throw (verify()
  // reports it at boot).
  #model(): TaskModel | null {
    const model = this.#getModel();
    if (!model) {
      this.#logger.error(
        'resize mongo queue: the ResizeTask model is not registered — scaffold src/models/ResizeTask.ts',
      );
      return null;
    }
    return model;
  }

  async add(task: NewTask): Promise<{ taskId: string | null }> {
    const model = this.#model();
    if (!model) {
      return { taskId: null };
    }
    const filter = activeRequestFilter(
      task.mediaId,
      task.pipeline,
      task.requestKey,
    );
    const upsert = () =>
      model.findOneAndUpdate(
        filter,
        {
          $setOnInsert: {
            fileId: task.mediaId,
            resizer: task.resizer,
            queue: task.queue,
            pipeline: task.pipeline,
            requestKey: task.requestKey,
            previews: task.previews,
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
    // The partial unique index lets one active copy of a request exist. A concurrent winner can
    // finish between our conflict and the reread, so retry a few times, then give up softly.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const doc = await upsert();
        return { taskId: doc ? String(doc._id) : null };
      } catch (err) {
        if (!isDuplicateKeyError(err)) {
          this.#logger.error(
            `resize mongo queue: adding a task failed for media ${task.mediaId}`,
            err,
          );
          return { taskId: null };
        }
        try {
          const existing = await model.findOne(filter);
          if (existing) {
            return { taskId: String(existing._id) };
          }
        } catch (rereadError) {
          this.#logger.error(
            `resize mongo queue: rereading a duplicate task failed for media ${task.mediaId}`,
            rereadError,
          );
          return { taskId: null };
        }
      }
    }
    this.#logger.error(
      `resize mongo queue: adding a task stayed contended for media ${task.mediaId}`,
    );
    return { taskId: null };
  }

  // One findOneAndUpdate that returns at once (the core polls every idlePollMs), so it takes no
  // abort signal.
  async claim(queue: string, leaseMs: number): Promise<ClaimedTask | null> {
    const model = this.#model();
    if (!model) {
      return null;
    }
    const now = new Date();
    const doc = (await model.findOneAndUpdate(
      {
        queue: named(queue),
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
          leasedBy: LEASE_HOLDER,
          leaseToken: randomHex(),
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
        },
        $inc: { attempts: 1 },
      },
      { sort: { createdAt: 1 }, returnDocument: 'after' },
    )) as TaskDoc | null;
    return doc ? toClaimedTask(doc) : null;
  }

  async renew(task: ClaimedTask, leaseMs: number): Promise<boolean> {
    return this.#fenced(task, {
      $set: { leaseExpiresAt: new Date(Date.now() + leaseMs) },
    });
  }

  async complete(task: ClaimedTask): Promise<boolean> {
    return this.#fenced(task, {
      $set: { status: 'completed', completedAt: new Date() },
    });
  }

  async fail(
    task: ClaimedTask,
    next: { retryAt: Date } | 'dead',
    error: string,
  ): Promise<boolean> {
    return this.#fenced(
      task,
      next === 'dead'
        ? { $set: { status: 'dead', deadAt: new Date(), error } }
        : {
            // A future leaseExpiresAt keeps a pending task unclaimable until the retry time.
            $set: {
              status: 'pending',
              leaseToken: null,
              leaseExpiresAt: next.retryAt,
              error,
            },
          },
    );
  }

  // Due at once (a null lease is claimable) and the claim's attempt taken back.
  async release(task: ClaimedTask): Promise<boolean> {
    return this.#fenced(task, {
      $set: { status: 'pending', leaseToken: null, leaseExpiresAt: null },
      $inc: { attempts: -1 },
    });
  }

  // Any queue: a task already waiting on another queue still covers the request.
  async findActive(query: {
    resizer: string;
    mediaId: string;
    pipeline: string;
  }): Promise<EnqueueReceipt[]> {
    const model = this.#model();
    if (!model) {
      return [];
    }
    const docs = (await model.find({
      fileId: query.mediaId,
      resizer: named(query.resizer),
      pipeline: query.pipeline,
      status: { $in: ['pending', 'processing'] },
    })) as TaskDoc[];
    return docs.map((doc) => ({
      taskId: String(doc._id),
      previews: doc.previews ?? [],
    }));
  }

  // The lease token and status are the fence: an expired-but-unclaimed lease may still finish
  // its work, while a re-claim mints a new token, so the old holder 0-matches.
  async #fenced(task: ClaimedTask, update: object): Promise<boolean> {
    const model = this.#model();
    if (!model) {
      return false;
    }
    const doc = await model.findOneAndUpdate(
      { _id: task.taskId, leaseToken: task.token, status: 'processing' },
      update,
      { returnDocument: 'after' },
    );
    return doc !== null;
  }
}

function toClaimedTask(doc: TaskDoc): ClaimedTask {
  return {
    taskId: doc._id.toString(),
    resizer: doc.resizer ?? 'default',
    queue: doc.queue ?? 'default',
    mediaId: doc.fileId.toString(),
    pipeline: doc.pipeline,
    previews: doc.previews ?? [],
    token: doc.leaseToken as string,
    attempts: doc.attempts,
  };
}

// Rows written before tasks carried a resizer/queue have neither field; they belong to 'default'.
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
