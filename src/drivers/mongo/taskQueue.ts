// MongoTaskQueue: the task queue as documents of a ResizeTask model (see createResizeModels).
//
// The task row is the gate: at most one row per Resizer, media, pipeline and queue is `active`,
// and a unique partial index enforces it. So add() is one insert that either stores the task or
// runs into the active one and reports it in flight. A row stays active from add() until complete(),
// through its retries and give-backs. A dead row stays active through its cooldown; the next
// add() then retires it (`active: false`, its error kept for inspection) and inserts a new row.
//
// Every other method is one atomic findOneAndUpdate. The lease token fences every write after a
// claim, so a worker that lost its lease can never complete, fail or release a task another worker
// now holds.
import { hostname } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import {
  type ClaimedTask,
  type ClaimOptions,
  type FailOptions,
  type NewTask,
  type TaskAddResult,
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
import { modelGetter } from './modelOption.ts';
import { gateIndexKeys, gateIndexOptions } from './schemas.ts';

// biome-ignore lint/suspicious/noExplicitAny: a host-registered mongoose model
type TaskModel = any;

export interface MongoTaskQueueOptions {
  // The ResizeTask model, or a getter called on each use (for a model registered later).
  model?: TaskModel;
  getModel?: () => TaskModel;
  // Queue timing (lease, retries, polling, task timeout); missing values use defaultQueueOptions.
  timing?: Partial<QueueTimingOptions>;
  // The same, read on first use (the framework adapter reads it from its config file).
  getTiming?: () => Partial<QueueTimingOptions>;
  logger?: ResizeLogger; // default: console
}

// The schema paths this queue writes. Mongoose strict mode silently drops a path its schema lacks:
// a model ejected before tasks carried a Resizer and queue would file every task under Resizer
// 'default' on queue 'default'; one without availableAt would lose every retry time; one without
// active would turn the gate off (every add would store a task); one without cooldownUntil would
// end every dead task's cooldown at once.
const WRITTEN_PATHS = [
  'fileId',
  'resizer',
  'queue',
  'pipeline',
  'previews',
  'status',
  'attempts',
  'availableAt',
  'active',
  'cooldownUntil',
  'leasedBy',
  'leaseToken',
  'leaseExpiresAt',
  'completedAt',
  'deadAt',
  'error',
] as const;

// The schema check of each model: its RESIZE_MONGO_MODEL_OUTDATED error, or null when the schema
// has every written path (or the model exposes none). A model is checked once.
const schemaErrors = new WeakMap<object, ResizeSetupError | null>();

/** The model's RESIZE_MONGO_MODEL_OUTDATED error, or undefined when its schema is complete. */
function schemaError(model: TaskModel): ResizeSetupError | undefined {
  const cached = schemaErrors.get(model);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  const schema = model.schema;
  const missing =
    typeof schema?.path === 'function'
      ? WRITTEN_PATHS.filter((path) => !schema.path(path))
      : [];
  const error =
    missing.length > 0
      ? new ResizeSetupError(
          `resize: the ResizeTask model has no ${missing.join(', ')} field(s), so Mongoose would drop them from every task — delete src/models/ResizeTask.ts and re-run resize-scaffold (add --eject for a full editable model); for a hand-written model, port the fields from resizeTaskFields()`,
          { code: 'RESIZE_MONGO_MODEL_OUTDATED' },
        )
      : null;
  if (typeof model === 'object' || typeof model === 'function') {
    schemaErrors.set(model, error);
  }
  return error ?? undefined;
}

// Who holds a lease: the host name tells pods apart (every container's main process is pid 1).
const LEASE_HOLDER = `${hostname().slice(0, 64)}:${process.pid}`;

// add() inserts at most twice. The second insert runs only when the gate opened between the first
// insert and the read: the active task had just completed, or this call retired a dead one.
const ADD_ROUNDS = 2;

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

// The fields of the active row that add() reads after a duplicate key.
interface GateDoc {
  _id: { toString(): string };
  status: string;
  cooldownUntil?: Date | null;
}

export class MongoTaskQueue extends TaskQueue {
  readonly gatesByTask = true;
  readonly claimFilters = true;
  readonly #getModel: () => TaskModel;
  readonly #getTiming: () => Partial<QueueTimingOptions>;
  readonly #logger: ResizeLogger;

  constructor(opts: MongoTaskQueueOptions) {
    super();
    // A model that does not resolve is reported by verify() at boot and logged at runtime.
    this.#getModel = modelGetter<TaskModel>(opts, 'MongoTaskQueue');
    const { timing, getTiming } = opts;
    this.#getTiming = getTiming ?? (() => timing ?? {});
    this.#logger = opts.logger ?? console;
  }

  getTiming(): Partial<QueueTimingOptions> {
    return this.#getTiming();
  }

  /**
   * Startup check: the ResizeTask model must be registered, its schema (when the model exposes
   * one) must have every field this queue writes, and its collection (when the model exposes one)
   * must have the gate index. The check reads the indexes; it never creates one.
   */
  async verify(): Promise<void> {
    const model = this.#getModel();
    if (!model) {
      throw new ResizeSetupError(
        'resize: the ResizeTask model is not registered — scaffold src/models/ResizeTask.ts (or pass `model`)',
        { code: 'RESIZE_MONGO_MODEL_MISSING' },
      );
    }
    const outdated = schemaError(model);
    if (outdated) {
      throw outdated;
    }
    await checkGateIndex(model);
  }

  // At runtime a missing model is logged, not thrown: reads and prewarm never throw (verify()
  // reports it at boot). A model whose schema lacks a field this queue writes throws
  // RESIZE_MONGO_MODEL_OUTDATED on first use, whether or not verify() ran: a strict schema would
  // drop the field silently (without `active` every add would store a task). add() logs it and
  // resolves unconfirmed; every other method rejects with it.
  #model(): TaskModel | null {
    const model = this.#getModel();
    if (!model) {
      this.#logger.error(
        'resize mongo queue: the ResizeTask model is not registered — scaffold src/models/ResizeTask.ts',
      );
      return null;
    }
    const outdated = schemaError(model);
    if (outdated) {
      throw outdated;
    }
    return model;
  }

  async add(task: NewTask): Promise<TaskAddResult> {
    const gate = {
      resizer: task.resizer,
      fileId: task.mediaId,
      pipeline: task.pipeline,
      queue: task.queue,
    };
    try {
      const model = this.#model();
      if (!model) {
        return { status: 'unconfirmed' };
      }
      for (let round = 0; round < ADD_ROUNDS; round++) {
        const taskId = await insertActive(model, task);
        if (taskId !== null) {
          return { status: 'added', taskId };
        }
        const active = (await model.findOne(
          { ...gate, active: true },
          { _id: 1, status: 1, cooldownUntil: 1 },
        )) as GateDoc | null;
        if (!active) {
          continue; // the active task has just completed
        }
        const now = new Date();
        if (!canTakeOver(active, now)) {
          return { status: 'in-flight', taskId: String(active._id) };
        }
        // `active: true` in the filter lets only one of several adds that read this row retire it;
        // the unique index still picks one of their inserts.
        await model.findOneAndUpdate(
          { _id: active._id, active: true, ...takeOverRule(now) },
          { $set: { active: false } },
        );
      }
      // The gate changed hands in both rounds, so other adds are winning it: report in-flight
      // without an id.
      return { status: 'in-flight' };
    } catch (err) {
      this.#logger.error(
        `resize mongo queue: adding a task failed for media ${task.mediaId}`,
        err,
      );
      return { status: 'unconfirmed' };
    }
  }

  // One findOneAndUpdate that returns at once (the core polls every idlePollMs), so it ignores the
  // abort signal. The earliest due task wins: a waiting task whose availableAt has passed, or a
  // leased one whose lease ended. A lease keeps availableAt at its end, so tasks in backoff and
  // live leases lie outside the { queue, status, availableAt } index bounds and a claim reads
  // about one document, with no in-memory sort. Rows written before availableAt existed have none:
  // they are due once their leaseExpiresAt (a retry time or a lease end) has passed.
  async claim(
    queue: string,
    leaseMs: number,
    _signal?: AbortSignal,
    opts?: ClaimOptions,
  ): Promise<ClaimedTask | null> {
    const model = this.#model();
    if (!model) {
      return null;
    }
    const now = new Date();
    const leaseEnd = new Date(now.getTime() + leaseMs);
    const served = opts?.resizers;
    const doc = (await model.findOneAndUpdate(
      {
        queue: named(queue),
        // Only the tasks of the Resizers this worker serves, when it says which.
        ...(served ? { resizer: { $in: namedAll(served) } } : {}),
        status: { $in: ['pending', 'processing'] },
        availableAt: { $not: { $gt: now } }, // due, or no availableAt yet
        // Rows written by a worker that keeps times in leaseExpiresAt (before availableAt existed,
        // or an older worker in a rolling deploy) still wait for it: a waiting row's retry time,
        // a leased row's lease. New waiting rows have leaseExpiresAt null.
        $or: [
          { status: 'pending', leaseExpiresAt: { $not: { $gt: now } } },
          { leaseExpiresAt: { $lt: now } },
        ],
      },
      {
        $set: {
          status: 'processing',
          leasedBy: LEASE_HOLDER,
          leaseToken: randomHex(),
          leaseExpiresAt: leaseEnd,
          availableAt: leaseEnd,
        },
        $inc: { attempts: 1 },
      },
      { sort: { availableAt: 1 }, returnDocument: 'after' },
    )) as TaskDoc | null;
    return doc ? toClaimedTask(doc) : null;
  }

  async renew(task: ClaimedTask, leaseMs: number): Promise<boolean> {
    const leaseEnd = new Date(Date.now() + leaseMs);
    return this.#fenced(task, {
      $set: { leaseExpiresAt: leaseEnd, availableAt: leaseEnd },
    });
  }

  // Done: the task stops being the gate, so the next add() stores a new task.
  async complete(task: ClaimedTask): Promise<boolean> {
    return this.#fenced(task, {
      $set: { status: 'completed', completedAt: new Date(), active: false },
    });
  }

  // A retry keeps the gate. A dead task keeps it for `opts.cooldownMs` (none by default): until
  // then add() reports it in flight, and after that the next add() takes it over.
  async fail(
    task: ClaimedTask,
    next: { retryAt: Date } | 'dead',
    error: string,
    opts?: FailOptions,
  ): Promise<boolean> {
    if (next === 'dead') {
      const deadAt = new Date();
      return this.#fenced(task, {
        $set: {
          status: 'dead',
          deadAt,
          error,
          cooldownUntil: new Date(deadAt.getTime() + (opts?.cooldownMs ?? 0)),
        },
      });
    }
    return this.#fenced(task, {
      $set: {
        status: 'pending',
        leaseToken: null,
        leaseExpiresAt: null,
        availableAt: next.retryAt,
        error,
      },
    });
  }

  // Due at once, and the claim's attempt taken back. The task keeps the gate.
  async release(task: ClaimedTask): Promise<boolean> {
    return this.#fenced(task, {
      $set: {
        status: 'pending',
        leaseToken: null,
        leaseExpiresAt: null,
        availableAt: new Date(),
      },
      $inc: { attempts: -1 },
    });
  }

  // The gate while it is pending or processing. A dead task still holding the gate is not
  // reported: nothing will run it.
  async findActive(query: {
    resizer: string;
    mediaId: string;
    pipeline: string;
    queue: string;
  }): Promise<EnqueueReceipt[]> {
    const model = this.#model();
    if (!model) {
      return [];
    }
    const doc = (await model.findOne({
      resizer: query.resizer,
      fileId: query.mediaId,
      pipeline: query.pipeline,
      queue: query.queue,
      active: true,
      status: { $in: ['pending', 'processing'] },
    })) as TaskDoc | null;
    return doc
      ? [{ taskId: String(doc._id), previews: doc.previews ?? [] }]
      : [];
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

// Insert the task as the active row of its gate. Resolves with its id, or null when another
// active row holds the gate; any other write error rejects, a duplicate key on another index too.
async function insertActive(
  model: TaskModel,
  task: NewTask,
): Promise<string | null> {
  try {
    const [doc] = await model.create(
      [
        {
          fileId: task.mediaId,
          resizer: task.resizer,
          queue: task.queue,
          pipeline: task.pipeline,
          previews: task.previews,
          status: 'pending',
          attempts: 0,
          availableAt: new Date(),
          active: true,
        },
      ],
      { writeConcern: { w: 'majority' } },
    );
    return String(doc._id);
  } catch (err) {
    if (isGateConflict(err)) {
      return null;
    }
    throw err;
  }
}

// A gate row that add() may take over: a completed row (a worker from before the gate leaves it
// active), or a dead row whose cooldown has passed (such a worker sets none). takeOverRule is the
// rule as a filter for the retiring update; canTakeOver applies it to the row add() has read.
function takeOverRule(now: Date) {
  return {
    $or: [
      { status: 'completed' },
      { status: 'dead', cooldownUntil: { $not: { $gt: now } } },
    ],
  };
}

function canTakeOver(row: GateDoc, now: Date): boolean {
  if (row.status === 'completed') {
    return true;
  }
  return (
    row.status === 'dead' &&
    !(row.cooldownUntil && row.cooldownUntil.getTime() > now.getTime())
  );
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

// The same for a list of names: `$in` with null also matches a missing field.
function namedAll(values: readonly string[]): (string | null)[] {
  return values.includes('default') ? [...values, null] : [...values];
}

const GATE_KEYS = Object.keys(gateIndexKeys).sort();

// True when `keys` (an index key or a duplicate key's keyPattern) names exactly the gate keys.
function isGateKey(keys: object): boolean {
  const names = Object.keys(keys).sort();
  return (
    names.length === GATE_KEYS.length &&
    names.every((name, i) => name === GATE_KEYS[i])
  );
}

// The gate index as a message names it: its keys, unique, partial on active rows.
const GATE_INDEX_SPEC = `{ ${Object.entries(gateIndexKeys)
  .map(([key, order]) => `${key}: ${order}`)
  .join(
    ', ',
  )} } with { unique: true, partialFilterExpression: { active: true } }`;

// An index as the server lists it (the fields this check reads).
interface IndexInfo {
  name?: string;
  key?: object;
  unique?: boolean;
  partialFilterExpression?: unknown;
}

// MongoDB's NamespaceNotFound: listing the indexes of a collection that does not exist.
const NAMESPACE_NOT_FOUND = 26;

// Mongoose's connection states (Connection#readyState) the check tells apart.
const CONNECTED = 1;
const CONNECTING = 2;

// The part of a Mongoose connection the index check reads.
interface ConnectionLike {
  readyState?: unknown;
  asPromise?: () => Promise<unknown>;
}

/**
 * Reject unless the model's collection has the gate index: without it every add stores a task
 * (no index), or every add after a completed task is in flight with no id (a unique index without
 * the partial filter). A model that exposes no collection is not checked.
 *
 * The connection must be open, or opening (the check waits for it); a closed one rejects at once
 * with RESIZE_MONGO_NOT_CONNECTED. The check then waits for the model's own `init()`: with
 * Mongoose's `autoIndex` on (an API server), Mongoose is still building the declared indexes when
 * the app boots, and listing them before that build ends would report the gate index missing on a
 * fresh database. `init()` runs once per model, so this builds nothing that Mongoose would not
 * build anyway, and with `autoIndex` off it builds nothing at all.
 */
async function checkGateIndex(model: TaskModel): Promise<void> {
  const collection = model.collection;
  if (typeof collection?.indexes !== 'function') {
    return;
  }
  const name = String(collection.collectionName ?? model.modelName ?? '');
  const missing = (why: string, cause?: unknown) =>
    new ResizeSetupError(
      `resize: the ResizeTask collection '${name}' ${why}: the gate needs the index ${GATE_INDEX_SPEC} — create it through your migration process; the module never creates indexes`,
      { code: 'RESIZE_MONGO_INDEX_MISSING', cause },
    );
  await waitForConnection(model.db as ConnectionLike | undefined, name);
  // Mongoose's own index build (autoIndex); a failed build (e.g. duplicate active rows) is the
  // cause of a missing index, not an error of this check.
  let buildError: unknown;
  if (typeof model.init === 'function') {
    try {
      await model.init();
    } catch (err) {
      buildError = err;
    }
  }
  let indexes: IndexInfo[];
  try {
    indexes = await collection.indexes();
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === NAMESPACE_NOT_FOUND) {
      throw missing('does not exist yet, so it has no gate index', buildError);
    }
    throw err;
  }
  const onGateKeys = indexes.filter(
    (index) =>
      typeof index.key === 'object' &&
      index.key !== null &&
      isGateKey(index.key),
  );
  if (
    onGateKeys.some(
      (index) =>
        index.unique === true &&
        isDeepStrictEqual(
          index.partialFilterExpression,
          gateIndexOptions.partialFilterExpression,
        ),
    )
  ) {
    return;
  }
  throw missing(
    onGateKeys.length > 0
      ? `has an index on the gate keys ('${onGateKeys[0].name}') that is not unique or not partial on { active: true }`
      : 'has no gate index',
    buildError,
  );
}

/**
 * Resolve once the model's connection is open: at once when it is, after the initial connection
 * when it is opening. A connection that is closed (never opened, or disconnected), or whose opening
 * fails, rejects with RESIZE_MONGO_NOT_CONNECTED instead of a database call that would wait for
 * Mongoose's buffer timeout. A model without a Mongoose connection is not checked.
 */
async function waitForConnection(
  connection: ConnectionLike | undefined,
  collection: string,
): Promise<void> {
  const state = connection?.readyState;
  if (typeof state !== 'number' || state === CONNECTED) {
    return;
  }
  const notConnected = (cause?: unknown) =>
    new ResizeSetupError(
      `resize: the connection of the ResizeTask collection '${collection}' is not open (Mongoose readyState ${state}); call verify() after the connection has opened (after Server.init() in a framework host)`,
      { code: 'RESIZE_MONGO_NOT_CONNECTED', cause },
    );
  if (state === CONNECTING && typeof connection?.asPromise === 'function') {
    try {
      await connection.asPromise();
    } catch (err) {
      throw notConnected(err);
    }
    if (connection.readyState === CONNECTED) {
      return;
    }
  }
  throw notConnected();
}

// A duplicate key on the gate index: another task is in flight. A duplicate key on any other
// unique index (one a host added to its model), or one that does not say which index, is a write
// error: treating it as the gate would report every add in flight while storing nothing.
function isGateConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { code, keyPattern } = error as {
    code?: unknown;
    keyPattern?: unknown;
  };
  if (code !== 11000 || typeof keyPattern !== 'object' || keyPattern === null) {
    return false;
  }
  return isGateKey(keyPattern);
}
