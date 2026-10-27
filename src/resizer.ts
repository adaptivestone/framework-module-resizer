// The constructor-wired public surface: every driver is injected in ONE visible options literal
// at construction and fixed for the process lifetime — no register-call sequence. The Resizer
// holds its named pipelines (src/pipelines.ts) and its hook bus (src/hooks.ts), and registers
// itself by name in the process registry below. It is the composition root: ready() builds the
// services from the parts, and no service receives the Resizer.
// Each Resizer owns its config, logger and event bus, all passed in explicitly: the core never
// reads a framework app. Framework hosts use FrameworkResizer (src/framework/resizer.ts), which
// builds every part from the app's config file.
import { Catalog } from './catalog.ts';
import defaultResizeConfig, { defaultCoordination } from './config/resize.ts';
import type { HookName, HookSignatures, HookTaps } from './contracts/hooks.ts';
import type { LockStore } from './contracts/locks.ts';
import type { MediaStore } from './contracts/media.ts';
import type { Pipeline } from './contracts/pipeline.ts';
import type { ResizeStorage } from './contracts/storage.ts';
import type { TaskQueue } from './contracts/taskQueue.ts';
import {
  type Coordination,
  fillCoordination,
  type TaskCoordination,
} from './coordination.ts';
import { Dispatcher } from './dispatcher.ts';
import { ResizeSetupError } from './errors.ts';
import { logNeverThrow } from './helpers/log.ts';
import { HookBus } from './hooks.ts';
import { PipelineRegistry } from './pipelines.ts';
import { Processor } from './processor.ts';
import { prewarmFailure, Reader } from './reader.ts';
import { Registry } from './registry.ts';
import { validateResizeConfig } from './resizeConfig.ts';
import { timingOf } from './timing.ts';
import type {
  CoordinationOptions,
  GenerateOpts,
  GenerateResult,
  LazyPart,
  Original,
  PrewarmOpts,
  PrewarmResult,
  ReadDecision,
  ResizeConfig,
  ResizeEventBus,
  ResizeLogger,
  ResolveOpts,
  UploadOriginalOpts,
} from './types.d.ts';
import { Uploader } from './uploader.ts';

// ---------------------------------------------------------------------------
// Constructor options. `storage` and `media` are required — both modes need them, so a missing
// driver is a boot-time type/throw error, not a runtime degradation. `tasks` is optional
// (eager-only hosts omit it), and `locks` is required beside a task queue without gatesByTask
// (e.g. SqsTaskQueue): such a queue cannot keep the gate of a media and pipeline itself, so the
// gate is a lock in this store.
// ---------------------------------------------------------------------------

export interface ResizerOptions {
  name?: string; // registry key; default 'default'
  // The complete image config (default: the package defaults), or a function returning it, which
  // is called and validated on first use (the framework adapter reads its config file lazily).
  config?: ResizeConfig | (() => ResizeConfig);
  logger?: ResizeLogger; // default: console
  events?: ResizeEventBus; // optional bus that also receives observers as `resize:<hook>`
  storage: ResizeStorage | LazyPart<ResizeStorage>; // REQUIRED: files (originals, previews)
  media: MediaStore | LazyPart<MediaStore>; // REQUIRED: media documents and their previews
  // Locks for queued work, e.g. mongoParts(…).locks. Required beside a task queue without
  // gatesByTask, which takes one gate lock per media and pipeline it queues; eager-only hosts may
  // omit it.
  locks?: LockStore | LazyPart<LockStore | undefined>;
  // Queued work (prewarm, lazy reads, the worker): where tasks wait, e.g. mongoParts(…).tasks or
  // an SqsTaskQueue. Omit (or resolve to undefined) for eager-only hosts.
  tasks?: TaskQueue | LazyPart<TaskQueue | undefined>;
  // How queued work is coordinated (`gateTtlMs`, `cooldownMs`; missing values default), or a
  // function returning it. Read only beside a task queue, when the Resizer sets it up (a function
  // is called then, and again only after a failed set-up), and validated against the queue's
  // timing; an eager-only Resizer never reads it.
  coordination?: CoordinationOptions | (() => CoordinationOptions);
  queue?: string; // default queue name for this Resizer's tasks; default 'default'
  pipelines?: Record<string, Pipeline>; // the named pipelines, fixed at construction
  // Initial taps — each name infers its typed signature (single fn or array); hook() adds more.
  hooks?: HookTaps;
}

// Constructed Resizers by name (see src/registry.ts).
const registry = new Registry<Resizer>();

// Set by the Resizer class, which alone can read its private services and parts (see
// processorOf(), tasksPartOf() and taskCoordinationOf()).
let readProcessor: (resizer: Resizer) => Processor;
let loadTasksPart: (resizer: Resizer) => Promise<TaskQueue | undefined>;
let readTaskCoordination: (resizer: Resizer) => TaskCoordination;

const PART_NAMES = ['storage', 'media', 'locks', 'tasks'] as const;
type PartName = (typeof PART_NAMES)[number];

// What the Resizer's methods run on, built once by ready() from the loaded parts and the
// validated config. No service receives the Resizer. The Reader alone uses the Dispatcher, so it
// is built again when the Dispatcher's state changes.
interface Services {
  catalog: Catalog;
  uploader: Uploader;
  reader: Reader;
  processor: Processor;
}

// Why a Resizer with a task queue has no Dispatcher; `message` tells a new failure from the last.
interface QueueFailure {
  error: unknown;
  message: string;
}

// How framework hosts get the parts below filled in from their app.
const FRAMEWORK_HINT =
  "framework hosts: use new FrameworkResizer() from '@adaptivestone/framework-module-resize/framework.js'";

const storageRequired = () =>
  new ResizeSetupError(
    'resize: `storage` is required — construct `new Resizer({ storage: … })` with a ResizeStorage driver (e.g. new S3Storage({ … })); both the read path (publicUrl) and the worker (download/upload) need it',
    { code: 'RESIZE_STORAGE_REQUIRED' },
  );

const mediaRequired = () =>
  new ResizeSetupError(
    `resize: \`media\` is required — it loads media documents and records their previews (e.g. the parts of mongoParts(connection, { mediaModel })); ${FRAMEWORK_HINT}`,
    { code: 'RESIZE_MEDIA_REQUIRED' },
  );

const locksRequired = (name: string) =>
  new ResizeSetupError(
    `resize: Resizer '${name}' has a task queue without gatesByTask (e.g. SqsTaskQueue) but no \`locks\` — it takes one gate lock per media and pipeline it queues (e.g. the locks of mongoParts(connection, { mediaModel })); ${FRAMEWORK_HINT}`,
    { code: 'RESIZE_LOCKS_REQUIRED' },
  );

/**
 * A named resize engine: config, drivers, pipelines and hooks. Most hosts construct one
 * (named 'default'); a host that needs different storage, media models or formats constructs
 * more, each under its own name. Drivers are fixed at construction: objects, or functions called
 * once on first use (see `ready()`).
 */
export class Resizer {
  readonly name: string;
  readonly queue: string;
  readonly #config: () => ResizeConfig;
  #resolvedConfig: ResizeConfig | undefined;
  readonly logger: ResizeLogger;
  // The drivers. A part given as a function stays unset until ready() has loaded it.
  readonly #sources: Pick<ResizerOptions, PartName>;
  #storage: ResizeStorage | undefined;
  #media: MediaStore | undefined;
  #locks: LockStore | undefined;
  #tasks: TaskQueue | undefined;
  readonly #coordinationSource: ResizerOptions['coordination'];
  // Each part loads once: the parts usable now (given as objects, or loaded) and the loads in
  // flight. A part whose function failed is retried alone; the parts that loaded are kept.
  readonly #loadedParts = new Set<PartName>();
  readonly #loadingParts = new Map<PartName, Promise<void>>();
  readonly #pipelines: PipelineRegistry;
  readonly #hooks: HookBus;
  #builtServices: Services | undefined;
  // A Resizer with a task queue: its Dispatcher, or why it could not be built (each call retries).
  #dispatcher: Dispatcher | undefined;
  #queueFailure: QueueFailure | undefined;
  // The validated coordination, kept with the Dispatcher it was built for.
  #coordination: Coordination | undefined;
  // The Dispatcher was built or its failure changed after the Reader was built.
  #readerStale = false;

  static {
    // processorOf(), tasksPartOf() and taskCoordinationOf() (below) read through these; the
    // services stay private.
    readProcessor = (resizer) =>
      resizer.#builtServices?.processor ?? resizer.#notReady('processor');
    loadTasksPart = async (resizer) => {
      await resizer.#loadTasks();
      return resizer.#tasks;
    };
    readTaskCoordination = (resizer) => {
      if (!resizer.#builtServices) {
        resizer.#notReady('coordination');
      }
      return {
        cooldownMs:
          resizer.#coordination?.cooldownMs ?? defaultCoordination.cooldownMs,
        locks: resizer.#locks,
      };
    };
  }

  constructor(opts: ResizerOptions) {
    // Runtime validation of the required parts (`storage` here, `media` below): the type system
    // enforces them for TS hosts, but a JS host or a half-filled scaffold would otherwise fail with
    // a downstream TypeError at the first publicUrl/download — throw a NAMED error at construction.
    if (!opts?.storage) {
      throw storageRequired();
    }
    const name = opts.name ?? 'default';
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new ResizeSetupError('resize: `name` must be a non-empty string', {
        code: 'RESIZE_NAME_INVALID',
      });
    }
    const queue = opts.queue ?? 'default';
    if (typeof queue !== 'string' || queue.trim().length === 0) {
      throw new ResizeSetupError('resize: `queue` must be a non-empty string', {
        code: 'RESIZE_QUEUE_INVALID',
      });
    }
    // The core takes every part explicitly; it never reads a framework app.
    if (!opts.media) {
      throw mediaRequired();
    }
    // Validate before registering, so a bad config never claims the name and a corrected
    // retry succeeds.
    const config = opts.config ?? defaultResizeConfig;
    if (typeof config === 'function') {
      this.#config = config;
    } else {
      this.#resolvedConfig = validateResizeConfig(config);
      this.#config = () => config;
    }
    this.logger = opts.logger ?? console;
    this.name = name;
    this.queue = queue;
    // erasableSyntaxOnly: no parameter properties — assign fields explicitly.
    this.#sources = {
      storage: opts.storage,
      media: opts.media,
      locks: opts.locks,
      tasks: opts.tasks,
    };
    this.#coordinationSource = opts.coordination;
    // Parts given as objects are usable at once; functions wait for ready().
    if (typeof opts.storage !== 'function') {
      this.#storage = opts.storage;
      this.#loadedParts.add('storage');
    }
    if (typeof opts.media !== 'function') {
      this.#media = opts.media;
      this.#loadedParts.add('media');
    }
    if (typeof opts.locks !== 'function') {
      this.#locks = opts.locks;
      this.#loadedParts.add('locks');
    }
    if (typeof opts.tasks !== 'function') {
      this.#tasks = opts.tasks;
      this.#loadedParts.add('tasks');
    }
    this.#pipelines = new PipelineRegistry(opts.pipelines);
    this.#hooks = new HookBus({
      logger: this.logger,
      events: opts.events,
      taps: opts.hooks,
    });
    // Last, so a rejected construction never claims the name; a taken name throws
    // RESIZE_DUPLICATE_RESIZER.
    registry.register(this);
  }

  /**
   * Register a tap — `fn` is inferred from `name` via HookSignatures. Multiple taps per name are
   * allowed; registration order is preserved.
   */
  hook<N extends HookName>(name: N, fn: HookSignatures[N]): void {
    this.#hooks.add(name, fn);
  }

  /** Files: originals and previews. Available once the parts are loaded (see `ready()`). */
  get storage(): ResizeStorage {
    return this.#storage ?? this.#notReady('storage');
  }

  /** Media documents and their previews. Available once the parts are loaded (see `ready()`). */
  get media(): MediaStore {
    return this.#media ?? this.#notReady('media');
  }

  /** Locks for queued work (undefined: eager only). Available once the parts are loaded. */
  get locks(): LockStore | undefined {
    if (!this.#loadedParts.has('locks')) {
      this.#notReady('locks');
    }
    return this.#locks;
  }

  /** Where tasks wait (undefined: eager only). Available once the parts are loaded. */
  get tasks(): TaskQueue | undefined {
    if (!this.#loadedParts.has('tasks')) {
      this.#notReady('tasks');
    }
    return this.#tasks;
  }

  #notReady(part: string): never {
    throw new ResizeSetupError(
      `resize: Resizer '${this.name}' has not loaded \`${part}\` yet — await resizer.ready() before reading it (the Resizer's own methods do this)`,
      { code: 'RESIZE_NOT_READY' },
    );
  }

  /**
   * Load the parts given as functions, each once, then build the services. Every method of the
   * Resizer (and the worker) awaits it first, so hosts only need it before reading `storage`,
   * `media`, `locks` or `tasks` directly. In this order: the parts load; the image config is read
   * and validated; a Resizer with a task queue builds its Dispatcher; the services are built.
   * A part or config failure rejects. A Dispatcher failure (a task queue without gatesByTask and
   * no lock store, RESIZE_LOCKS_REQUIRED, invalid queue timing, or an invalid coordination) does
   * not: it is logged once, reads serve stored previews and queue nothing, uploads and generate()
   * work, prewarm() reports it and verify() rejects with it. The next call retries what failed: a
   * part that did not load, a config that did not validate, a Dispatcher that could not be built.
   * The parts that loaded are kept.
   */
  async ready(): Promise<void> {
    await this.#services();
  }

  /** The services, once the parts are loaded (see ready()). */
  async #services(): Promise<Services> {
    await this.#loadParts();
    return this.#ensureServices();
  }

  /** Load the parts given as functions, each once; a failure rejects. */
  async #loadParts(): Promise<void> {
    if (this.#loadedParts.size < PART_NAMES.length) {
      await Promise.all([
        this.#loadPart('storage', this.#sources.storage, (storage) => {
          if (!storage) {
            throw storageRequired();
          }
          this.#storage = storage;
        }),
        this.#loadPart('media', this.#sources.media, (media) => {
          if (!media) {
            throw mediaRequired();
          }
          this.#media = media;
        }),
        this.#loadPart('locks', this.#sources.locks, (locks) => {
          this.#locks = locks ?? undefined;
        }),
        this.#loadTasks(),
      ]);
    }
  }

  /** Load the task queue part alone, once (ready() loads it with the others). */
  #loadTasks(): Promise<void> {
    return this.#loadPart('tasks', this.#sources.tasks, (tasks) => {
      this.#tasks = tasks ?? undefined;
    });
  }

  /**
   * The services: built on the first call that succeeds, then the same object (a failed build
   * leaves nothing behind). The image config comes first: a broken config file, which a lazy
   * coordination reads too, fails as itself and is never logged as a queue failure. The Dispatcher
   * comes next, in its own step, so its failure leaves the others usable. Called only after the
   * parts are loaded.
   */
  #ensureServices(): Services {
    const config = this.config;
    this.#ensureDispatcher();
    if (!this.#builtServices) {
      const { storage, media } = this;
      const catalog = new Catalog({ config });
      this.#builtServices = {
        catalog,
        uploader: new Uploader({ storage, config }),
        reader: this.#buildReader(catalog),
        processor: new Processor({
          catalog,
          media,
          storage,
          locks: this.#locks,
          pipelines: this.#pipelines,
          hooks: this.#hooks,
          config,
          logger: this.logger,
          name: this.name,
        }),
      };
    } else if (this.#readerStale) {
      this.#builtServices.reader = this.#buildReader(
        this.#builtServices.catalog,
      );
    }
    this.#readerStale = false;
    return this.#builtServices;
  }

  /** The Reader, on the Dispatcher as it is now, or on the reason there is none. */
  #buildReader(catalog: Catalog): Reader {
    return new Reader({
      catalog,
      dispatcher: this.#dispatcher,
      queueFailure: this.#queueFailure,
      hooks: this.#hooks,
      pipelines: this.#pipelines,
      storage: this.storage,
      logger: this.logger,
      name: this.name,
      queue: this.queue,
    });
  }

  /**
   * Build the Dispatcher of a Resizer with a task queue, unless it exists. A failure is kept for
   * verify() and prewarm() and logged when it first happens or its message changes, never on every
   * call; a later call that succeeds (e.g. a lazy getTiming() that is valid now) clears it.
   */
  #ensureDispatcher(): void {
    const tasks = this.#tasks;
    if (this.#dispatcher || !tasks) {
      return;
    }
    try {
      this.#dispatcher = this.#buildDispatcher(tasks);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.#queueFailure?.message !== message) {
        this.#queueFailure = { error, message };
        this.#readerStale = true;
        logNeverThrow(
          this.logger,
          `resize: Resizer '${this.name}' cannot use its task queue — reads serve stored previews only and queue nothing, prewarm() reports it, verify() rejects`,
          error,
        );
      }
      return;
    }
    this.#queueFailure = undefined;
    this.#readerStale = true;
  }

  /**
   * The Dispatcher with the validated coordination. A task queue without gatesByTask needs the
   * lock store for its gate locks, so without one it is RESIZE_LOCKS_REQUIRED; a queue that gates
   * by task needs none. The coordination is read here (a function is called) and validated
   * against the queue's timing; it is kept only when the Dispatcher is built, so a failed set-up
   * reads it again on the next call.
   */
  #buildDispatcher(tasks: TaskQueue): Dispatcher {
    if (!this.#locks && !tasks.gatesByTask) {
      throw locksRequired(this.name);
    }
    const source = this.#coordinationSource;
    const coordination = fillCoordination(
      typeof source === 'function' ? source() : source,
      timingOf(tasks),
    );
    this.#coordination = coordination;
    return new Dispatcher({
      tasks,
      locks: this.#locks,
      coordination,
      name: this.name,
      logger: this.logger,
    });
  }

  /** Load one part given as a function; concurrent callers share its load while it runs. */
  #loadPart<T>(
    part: PartName,
    source: T | LazyPart<T>,
    keep: (value: T) => void,
  ): Promise<void> {
    if (this.#loadedParts.has(part)) {
      return Promise.resolve();
    }
    let loading = this.#loadingParts.get(part);
    if (!loading) {
      loading = (async () => {
        keep(await (source as LazyPart<T>)());
        this.#loadedParts.add(part);
      })().finally(() => {
        this.#loadingParts.delete(part);
      });
      this.#loadingParts.set(part, loading);
    }
    return loading;
  }

  /** The validated image config; a lazy config (a function) is read and validated on first use. */
  get config(): ResizeConfig {
    this.#resolvedConfig ??= validateResizeConfig(this.#config());
    return this.#resolvedConfig;
  }

  /**
   * Optional startup check: load the drivers and resolve and validate the config (see ready());
   * check that a task queue can be used (a lock store beside one without gatesByTask, its timing
   * and the coordination); run the media store's and the lock store's verify(); check the task
   * queue (its own verify(), and that it serves this Resizer's queue). Framework hosts call it
   * after `Server.init()` to fail at boot instead of at the first upload or read; it is the one
   * call that rejects for a task queue that cannot be used (the read path degrades instead). The
   * worker runs it for every Resizer before leasing.
   */
  async verify(): Promise<void> {
    // ready() resolves while the task queue cannot be used; verify() rejects with the reason.
    await this.ready();
    if (this.#queueFailure) {
      throw this.#queueFailure.error;
    }
    await this.media.verify?.();
    await this.locks?.verify?.();
    if (this.tasks) {
      await this.tasks.verify?.();
      if (this.tasks.servesQueue && !this.tasks.servesQueue(this.queue)) {
        throw new ResizeSetupError(
          `resize: Resizer '${this.name}' queues to '${this.queue}', which its task queue does not serve`,
          { code: 'RESIZE_QUEUE_NOT_SERVED' },
        );
      }
    }
  }

  /** True when `name` is registered. `default` always exists: unregistered, it has no steps. */
  hasPipeline(name: string): boolean {
    return this.#pipelines.has(name);
  }

  /**
   * Read path — the host calls this from its DTO builders. Delegates to the Reader
   * (src/reader.ts), which partitions ready vs missing, enqueues the missing set, and never
   * throws into the caller's read.
   */
  async resolve(
    opts: ResolveOpts,
  ): Promise<{ decision: ReadDecision; output: unknown }> {
    let services: Services;
    try {
      // The Reader guards the rest, but it does not exist until ready() succeeds.
      services = await this.#services();
    } catch (err) {
      logNeverThrow(
        this.logger,
        'resize resolve: the Resizer could not start — returning the safe empty decision',
        err,
      );
      return { decision: { ready: [], missing: [] }, output: undefined };
    }
    return services.reader.resolve(opts);
  }

  /**
   * Pre-warm at upload: queue every missing variant of the catalog without waiting for image work,
   * so the previews are usually ready by the first read. Reports each variant (ready / accepted /
   * not required / unconfirmed, with task receipts and issues). A task already in flight for the
   * media and pipeline is reported, not counted as queued: only the variants it holds are
   * accepted, and the rest are RESIZE_TASK_IN_FLIGHT; a held gate lock never counts as queued.
   * NEVER throws (same guarantee as `resolve`): an internal error is `status: 'incomplete'`.
   */
  async prewarm(opts: PrewarmOpts): Promise<PrewarmResult> {
    let services: Services;
    try {
      // The Reader guards the rest, but it does not exist until ready() succeeds.
      services = await this.#services();
    } catch (err) {
      logNeverThrow(
        this.logger,
        'resize prewarm: the Resizer could not start — nothing confirmed',
        err,
      );
      return prewarmFailure(err, []);
    }
    return services.reader.prewarm(opts);
  }

  /**
   * Eager mode — generate at upload, within this call. It uses no task queue, worker or locks, so
   * it also works on a Resizer whose task queue cannot be used. Delegates to the
   * Processor (src/processor.ts): resolveSizes waterfall with the caller's REAL ctx → expand
   * sizes × formats, skipping identities already in media.previews (idempotent) → download once →
   * beforeSteps once → per-variant resize/encode/upload (bounded by config.concurrency, NO locks).
   * `persist !== false` → one media.appendPreviews (+ display-dim backfill); else the previews are
   * returned unstored.
   */
  async generate(opts: GenerateOpts): Promise<GenerateResult> {
    return (await this.#services()).processor.generate(opts);
  }

  /** Store an untouched, byte-sniffed original. Does not create media or queue work. */
  async uploadOriginal(opts: UploadOriginalOpts): Promise<Original> {
    return (await this.#services()).uploader.upload(opts);
  }
}

/** The Resizer registered under `name`, default 'default' (worker entry, host code, late taps). */
export function getResizer(name?: string): Resizer {
  return registry.get(name);
}

/** Every registered Resizer, in construction order (the worker serves all of them). */
export function listResizers(): Resizer[] {
  return registry.list();
}

/**
 * The Processor of `resizer`, which renders previews: the worker's entry for one queued task, the
 * dead-letter cooldown and the task observers. Throws RESIZE_NOT_READY until ready() has built
 * the services. Internal: the main entry does not export it, and it may change in any release.
 * @internal
 */
export function processorOf(resizer: Resizer): Processor {
  return readProcessor(resizer);
}

/**
 * The task queue of `resizer` (undefined: eager only), loading only that part when it is a
 * function that has not run, so a failure of another part cannot hide it. Rejects when the task
 * queue itself cannot be loaded. The worker uses it to see which task queue a Resizer it does not
 * serve uses. Internal: the main entry does not export it, and it may change in any release.
 * @internal
 */
export function tasksPartOf(resizer: Resizer): Promise<TaskQueue | undefined> {
  return loadTasksPart(resizer);
}

/**
 * What the worker needs for each task of `resizer`: the `cooldownMs` of its validated
 * coordination (the default when it has no task queue it can use) and its lock store. Throws
 * RESIZE_NOT_READY until ready() has built the services. Internal: the main entry does not export
 * it, and it may change in any release.
 * @internal
 */
export function taskCoordinationOf(resizer: Resizer): TaskCoordination {
  return readTaskCoordination(resizer);
}

/**
 * Run `reset` on every resetResizerForTests(): for per-process state an adapter keeps beside the
 * registry (the framework adapter's shared task queues).
 */
export function onResetResizerForTests(reset: () => void): void {
  registry.onReset(reset);
}

/** TEST-ONLY: forget every constructed Resizer so a test can construct fresh ones. */
export function resetResizerForTests(): void {
  registry.reset();
}
