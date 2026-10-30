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
import type { SourceDecoder } from './contracts/decoder.ts';
import type { HookName, HookSignatures, HookTaps } from './contracts/hooks.ts';
import type { LockStore } from './contracts/locks.ts';
import type { MediaStore } from './contracts/media.ts';
import type { ResizeMetrics } from './contracts/metrics.ts';
import type { Pipeline } from './contracts/pipeline.ts';
import type { ResizeStorage } from './contracts/storage.ts';
import type { TaskQueue } from './contracts/taskQueue.ts';
import {
  type Coordination,
  fillCoordination,
  type TaskCoordination,
} from './coordination.ts';
import { createDecoderSet, type DecoderSet } from './decoderSet.ts';
import { Dispatcher } from './dispatcher.ts';
import { ResizeSetupError } from './errors.ts';
import { logNeverThrow } from './helpers/log.ts';
import { HookBus } from './hooks.ts';
import { boundMetrics, isMetrics, LogMetrics } from './metrics.ts';
import { PipelineRegistry } from './pipelines.ts';
import { requireReplacePreviews } from './previewRecorder.ts';
import { Processor } from './processor.ts';
import { prewarmFailure, Reader } from './reader.ts';
import { Registry } from './registry.ts';
import { validateResizeConfig } from './resizeConfig.ts';
import { carrierOf, isRouter, unavailableReason } from './routing.ts';
import { timingOf } from './timing.ts';
import type {
  CoordinationOptions,
  GenerateOpts,
  GenerateResult,
  InvalidateOpts,
  LazyPart,
  Original,
  PrewarmOpts,
  PrewarmResult,
  ReadDecision,
  ResizeConfig,
  ResizeEventBus,
  ResizeLogger,
  ResolveOpts,
  StorageRef,
  UploadOriginalOpts,
} from './types.d.ts';
import { Uploader } from './uploader.ts';

// ---------------------------------------------------------------------------
// Constructor options. `storage` and `media` are required — both modes need them, so a missing
// driver is a boot-time type/throw error, not a runtime degradation. `tasks` is optional
// (eager-only hosts omit it), and `locks` is required beside a task queue without gatesByTask
// (e.g. SqsTaskQueue): such a queue cannot keep the gate of a media, pipeline and queue itself, so
// the gate is a lock in this store.
// ---------------------------------------------------------------------------

export interface ResizerOptions {
  name?: string; // registry key; default 'default'
  // The complete image config (default: the package defaults), or a function returning it, which
  // is called and validated on first use (the framework adapter reads its config file lazily).
  config?: ResizeConfig | (() => ResizeConfig);
  logger?: ResizeLogger; // default: console
  // Where reads, uploads, variants and task outcomes are reported; default: new LogMetrics(logger),
  // one summary line per window and one line per task outcome. new NoopMetrics() turns it off.
  metrics?: ResizeMetrics;
  events?: ResizeEventBus; // optional bus that also receives observers as `resize:<hook>`
  storage: ResizeStorage | LazyPart<ResizeStorage>; // REQUIRED: files (originals, previews)
  media: MediaStore | LazyPart<MediaStore>; // REQUIRED: media documents and their previews
  // Locks for queued work, e.g. mongoParts(…).locks. Required beside a task queue without
  // gatesByTask, which takes one gate lock per media, pipeline and queue it queues; with a router,
  // only for the queue names whose backend lacks gatesByTask. Eager-only hosts may omit it.
  locks?: LockStore | LazyPart<LockStore | undefined>;
  // Queued work (prewarm, lazy reads, the worker): where tasks wait, e.g. mongoParts(…).tasks or
  // an SqsTaskQueue. Omit (or resolve to undefined) for eager-only hosts.
  tasks?: TaskQueue | LazyPart<TaskQueue | undefined>;
  // How queued work is coordinated (`gateTtlMs`, `cooldownMs`; missing values default), or a
  // function returning it. Read only beside a task queue, when the Resizer sets it up (a function
  // is called then, and again only after a failed set-up), and validated then; an eager-only
  // Resizer never reads it.
  coordination?: CoordinationOptions | (() => CoordinationOptions);
  // The queue name of this Resizer's tasks (default 'default'), or a function returning it, which
  // is called once on first use, before the task queue is set up (the framework adapter reads it
  // from its config file).
  queueName?: string | (() => string);
  pipelines?: Record<string, Pipeline>; // the named pipelines, fixed at construction
  decoders?: SourceDecoder[]; // asked before the built-in Sharp and SVG decoders; FrameworkResizer passes it through
  // Initial taps — each name infers its typed signature (single fn or array); hook() adds more.
  hooks?: HookTaps;
}

// Constructed Resizers by name (see src/registry.ts).
const registry = new Registry<Resizer>();

// Set by the Resizer class, which alone can read its private services and parts (see
// processorOf(), tasksPartOf(), taskCoordinationOf(), verifyServicesOf(), verifyRouteOf() and
// metricsOf()).
let readProcessor: (resizer: Resizer) => Processor;
let readBoundMetrics: (resizer: Resizer) => ReturnType<typeof boundMetrics>;
let loadTasksPart: (resizer: Resizer) => Promise<TaskQueue | undefined>;
let readTaskCoordination: (resizer: Resizer) => TaskCoordination;
let runVerifyServices: (
  resizer: Resizer,
  verified: Set<object> | undefined,
) => Promise<void>;
let runVerifyRoute: (
  resizer: Resizer,
  queue: string,
  verified: Set<object> | undefined,
) => Promise<void>;

/**
 * Run `part.verify()` unless `verified` already holds `part`, and record it once it passes. The
 * worker passes one set for its whole start, so a backend or a lock store that several Resizers
 * share is checked once; verify() passes none and checks every part of its own.
 */
async function verifyPart(
  part: { verify?(): void | Promise<void> } | undefined,
  verified: Set<object> | undefined,
): Promise<void> {
  if (!part || verified?.has(part)) {
    return;
  }
  await part.verify?.();
  verified?.add(part);
}

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

/** `name` when it is a non-empty string; else RESIZE_QUEUE_INVALID. */
function validQueueName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new ResizeSetupError(
      'resize: `queueName` must be a non-empty string',
      { code: 'RESIZE_QUEUE_INVALID' },
    );
  }
  return name;
}

const locksRequired = (name: string) =>
  new ResizeSetupError(
    `resize: Resizer '${name}' has a task queue without gatesByTask (e.g. SqsTaskQueue) but no \`locks\` — it takes one gate lock per media, pipeline and queue it queues (e.g. the locks of mongoParts(connection, { mediaModel })); ${FRAMEWORK_HINT}`,
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
  // The queue name: given as a string, set at construction; given as a function, set on first use.
  readonly #queueNameSource: () => string;
  #queueName: string | undefined;
  readonly #config: () => ResizeConfig;
  #resolvedConfig: ResizeConfig | undefined;
  readonly logger: ResizeLogger;
  // The host's metrics sink (or the default LogMetrics), and the guarded view of it that labels
  // every call with this Resizer and never throws.
  readonly #metrics: ResizeMetrics;
  readonly #boundMetrics: ReturnType<typeof boundMetrics>;
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
  // The decoders that read originals, built once: the Processor renders every task through them.
  readonly #decoders: DecoderSet;
  #builtServices: Services | undefined;
  // A Resizer with a task queue: its Dispatcher, or why it could not be built (each call retries).
  #dispatcher: Dispatcher | undefined;
  #queueFailure: QueueFailure | undefined;
  // The validated coordination, kept with the Dispatcher it was built for.
  #coordination: Coordination | undefined;
  // The Dispatcher was built or its failure changed after the Reader was built.
  #readerStale = false;

  static {
    // processorOf(), tasksPartOf(), taskCoordinationOf(), verifyServicesOf(), verifyRouteOf() and
    // metricsOf() (below) read through these; the services stay private.
    readProcessor = (resizer) =>
      resizer.#builtServices?.processor ?? resizer.#notReady('processor');
    readBoundMetrics = (resizer) => resizer.#boundMetrics;
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
        gateTtlMs:
          resizer.#coordination?.gateTtlMs ?? defaultCoordination.gateTtlMs,
        locks: resizer.#locks,
      };
    };
    runVerifyServices = (resizer, verified) =>
      resizer.#verifyServices(verified);
    runVerifyRoute = (resizer, queue, verified) =>
      resizer.#verifyRoute(queue, verified);
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
    // The option was renamed: an old `queue` would otherwise be ignored and every task would go to
    // 'default' without a word.
    if (Object.hasOwn(opts, 'queue')) {
      throw new ResizeSetupError('resize: `queue` is now `queueName`', {
        code: 'RESIZE_QUEUE_INVALID',
      });
    }
    const queueName = opts.queueName ?? 'default';
    if (typeof queueName === 'function') {
      this.#queueNameSource = queueName;
    } else {
      this.#queueName = validQueueName(queueName);
      this.#queueNameSource = () => queueName;
    }
    // The core takes every part explicitly; it never reads a framework app.
    if (!opts.media) {
      throw mediaRequired();
    }
    // Checked by shape, not class: a sink from a duplicate package copy or a plain object works.
    if (opts.metrics !== undefined && !isMetrics(opts.metrics)) {
      throw new ResizeSetupError(
        'resize: `metrics` must have count() and timing() functions — e.g. new LogMetrics(logger) or new NoopMetrics()',
        { code: 'RESIZE_METRICS_INVALID', retryable: false },
      );
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
    this.#metrics = opts.metrics ?? new LogMetrics(this.logger);
    // A pipeline name the host never registered is unbounded: it is labelled 'unregistered'.
    this.#boundMetrics = boundMetrics(this.#metrics, {
      resizer: name,
      logger: this.logger,
      pipelineLabel: (pipeline) =>
        this.hasPipeline(pipeline) ? pipeline : 'unregistered',
    });
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
    // The host's decoders are checked here (RESIZE_DECODER_INVALID), before the name is registered.
    this.#decoders = createDecoderSet(opts.decoders);
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

  /**
   * The queue name of this Resizer's tasks: a call without its own `queue` queues there. Given as a
   * string, readable at once; given as a function, once the Resizer has been used (see `ready()`).
   */
  get queueName(): string {
    return this.#queueName ?? this.#notReady('queueName');
  }

  /** The metrics sink: the `metrics` option as given, or the default LogMetrics on `logger`. */
  get metrics(): ResizeMetrics {
    return this.#metrics;
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
   * `media`, `locks`, `tasks` or a `queueName` given as a function directly. In this order: the
   * parts load; the image config is read and validated; the queue name is read and validated; a
   * Resizer with a task queue builds its Dispatcher; the services are built. A part, config or
   * queue name failure rejects. A Dispatcher failure (a task queue without gatesByTask that is not
   * a router and no lock store, RESIZE_LOCKS_REQUIRED, or an invalid coordination) does not: it is
   * logged once, reads serve stored previews and queue nothing, uploads and generate() work,
   * prewarm() reports it and verify() rejects with it. A queue name's own problems (invalid
   * timing, a backend that cannot be built) are met per call instead. The next call retries what
   * failed: a part that did not load, a config or queue name that did not validate, a Dispatcher
   * that could not be built. The parts that loaded are kept.
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
    // A queue name given as a function is read once, after the config and before the Dispatcher;
    // an invalid one rejects like an invalid config and is read again on the next call.
    this.#queueName ??= validQueueName(this.#queueNameSource());
    this.#ensureDispatcher();
    if (!this.#builtServices) {
      const { storage, media } = this;
      // The pipeline's version is read on every call, as the worker reads it when it signs a row.
      const catalog = new Catalog({
        config,
        versionOf: (p) =>
          this.#pipelines.has(p) ? this.#pipelines.get(p).version : undefined,
      });
      this.#builtServices = {
        catalog,
        uploader: new Uploader({
          storage,
          decoders: this.#decoders,
          config,
          metrics: this.#boundMetrics,
        }),
        reader: this.#buildReader(catalog),
        processor: new Processor({
          catalog,
          media,
          storage,
          decoders: this.#decoders,
          pipelines: this.#pipelines,
          hooks: this.#hooks,
          config,
          logger: this.logger,
          name: this.name,
          metrics: this.#boundMetrics,
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
      queueName: this.queueName,
      metrics: this.#boundMetrics,
    });
  }

  /**
   * Build the Dispatcher of a Resizer with a task queue, unless it exists. A failure is kept for
   * verify() and prewarm() and logged when it first happens or its message changes, never on every
   * call; a later call that succeeds (e.g. a lazy getTiming(queue) that is valid now) clears it.
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
   * The Dispatcher with the validated coordination. A task queue without gatesByTask that is not
   * a router needs the lock store for its gate locks, so without one it is RESIZE_LOCKS_REQUIRED;
   * a queue that gates by task needs none, and a router's need is per call: a call whose carrier
   * lacks gatesByTask queues nothing without a lock store. No timing is read here: a queue name's
   * timing is checked by verify(), at worker start and on each call. The coordination is read (a
   * function is called) and validated; it is kept only when the Dispatcher is built, so a failed
   * set-up reads it again on the next call.
   */
  #buildDispatcher(tasks: TaskQueue): Dispatcher {
    if (!this.#locks && !tasks.gatesByTask && !isRouter(tasks)) {
      throw locksRequired(this.name);
    }
    const source = this.#coordinationSource;
    const coordination = fillCoordination(
      typeof source === 'function' ? source() : source,
    );
    this.#coordination = coordination;
    return new Dispatcher({
      tasks,
      locks: this.#locks,
      coordination,
      timingOf: (queue) => timingOf(tasks, queue),
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
   * check that the Resizer can set up its queued work (the coordination, and a lock store beside a
   * task queue without gatesByTask that is not a router); run the media store's verify() and check
   * it has replacePreviews; run the lock store's verify() (with a router, only when the carrier of
   * this Resizer's queue needs it), then each decoder's optional verify(); then check this
   * Resizer's queueName: a name whose backend is unavailable rejects with the reason, then its
   * carrier (a backend that fails to build rejects), its timing, the carrier's own verify(), and
   * that it is served (and, on a router, a lock store when the carrier lacks gatesByTask). Only the
   * carrier of this Resizer's own queue is built and checked. Framework hosts call it after
   * `Server.init()` to fail at boot instead of at the first upload or read; it is the one call
   * that rejects for a task queue that cannot be used (the read path degrades instead). The worker
   * runs the same checks for the queue names it consumes.
   */
  async verify(): Promise<void> {
    await this.#verifyServices(undefined);
    if (this.tasks) {
      await this.#verifyRoute(this.queueName, undefined);
    }
  }

  /**
   * The checks of verify() that need no queue name: the parts, the config, the Resizer-wide queue
   * set-up, the media store, the lock store (unless the task queue is a router: its lock store is
   * checked with a carrier that needs it) and the decoders. Builds no route and reads no timing.
   * A lock store already in `verified` is not checked again.
   */
  async #verifyServices(verified: Set<object> | undefined): Promise<void> {
    // ready() resolves while the task queue cannot be used; verify() rejects with the reason.
    await this.ready();
    if (this.#queueFailure) {
      throw this.#queueFailure.error;
    }
    await this.media.verify?.();
    requireReplacePreviews(this.media);
    // With a router, the lock store may serve no route at all (every route gates by task), so it
    // is verified only beside a carrier that needs it.
    if (!this.tasks || !isRouter(this.tasks)) {
      await verifyPart(this.locks, verified);
    }
    await this.#decoders.verify();
  }

  /**
   * The checks of verify() for one queue name: its unavailable reason, then, on a router, its
   * carrier (built now), its timing, the carrier's verify() and the lock store when the carrier
   * lacks gatesByTask; on any other task queue, its timing, the task queue's verify() and that it
   * serves the name. Only that name's route is built. A carrier or lock store already in `verified`
   * is not checked again.
   */
  async #verifyRoute(
    queue: string,
    verified: Set<object> | undefined,
  ): Promise<void> {
    await this.ready();
    const tasks = this.tasks;
    if (!tasks) {
      return;
    }
    const reason = unavailableReason(tasks, queue);
    if (reason) {
      throw reason.error;
    }
    const notServed = () =>
      new ResizeSetupError(
        queue === this.queueName
          ? `resize: Resizer '${this.name}' queues to '${queue}' (its \`queueName\`), which its task queue does not serve`
          : `resize: Resizer '${this.name}' cannot use queue '${queue}', which its task queue does not serve`,
        { code: 'RESIZE_QUEUE_NOT_SERVED' },
      );
    if (!isRouter(tasks)) {
      timingOf(tasks, queue);
      await verifyPart(tasks, verified);
      if (tasks.servesQueue && !tasks.servesQueue(queue)) {
        throw notServed();
      }
      return;
    }
    const carrier = await carrierOf(tasks, queue);
    if (!carrier) {
      throw notServed();
    }
    timingOf(tasks, queue);
    await verifyPart(carrier, verified);
    if (!carrier.gatesByTask) {
      if (!this.#locks) {
        throw locksRequired(this.name);
      }
      await verifyPart(this.#locks, verified);
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
      // Counted like a read that failed inside the Reader; `opts` may be missing (a JS host).
      this.#boundMetrics.count(
        'resize.read',
        1,
        { pipeline: opts?.pipeline ?? 'default', outcome: 'failed' },
        { ready: 0, missing: 0, stale: 0 },
      );
      return { decision: { ready: [], missing: [] }, output: undefined };
    }
    return services.reader.resolve(opts);
  }

  /**
   * Pre-warm at upload: queue every missing variant of the catalog without waiting for image work,
   * so the previews are usually ready by the first read. Reports each variant (ready / accepted /
   * not required / unconfirmed, with task receipts and issues). A task already in flight for the
   * media, pipeline and queue is reported, not counted as queued: only the variants it holds are
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
   * sizes × formats, skipping identities already in media.previews (idempotent) → download and
   * decode once → beforeSteps once → one resize per size, then encode/upload per variant (bounded
   * by config.concurrency, NO locks).
   * `persist !== false` → one media.appendPreviews (+ display-dim backfill); else the previews are
   * returned unstored.
   */
  async generate(opts: GenerateOpts): Promise<GenerateResult> {
    return (await this.#services()).processor.generate(opts);
  }

  /**
   * Remove this Resizer's stored previews of `media` (one pipeline, or all) and resolve with their
   * storage refs, for the host to delete. It takes no gate: a task running for this media can
   * still store rows after it returns, and a row stored between its read and its write with a new
   * identity stays; the refs are exactly the rows the write removed.
   */
  async invalidate(opts: InvalidateOpts): Promise<StorageRef[]> {
    return (await this.#services()).processor.invalidate(opts);
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
 * The Processor of `resizer`, which renders previews: the worker's entry for one queued task and
 * the task observers. Throws RESIZE_NOT_READY until ready() has built the services. Internal: the
 * main entry does not export it, and it may change in any release.
 * @internal
 */
export function processorOf(resizer: Resizer): Processor {
  return readProcessor(resizer);
}

/**
 * The metrics sink of `resizer` as its services and the worker call it: labelled with the Resizer,
 * with the pipeline and code labels bounded, never throwing. Internal: the main entry does not
 * export it, and it may change in any release.
 * @internal
 */
export function metricsOf(resizer: Resizer): ReturnType<typeof boundMetrics> {
  return readBoundMetrics(resizer);
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
 * What the worker needs for each task of `resizer`: the `cooldownMs` and `gateTtlMs` of its
 * validated coordination (the defaults when it has no task queue it can use) and its lock store. Throws
 * RESIZE_NOT_READY until ready() has built the services. Internal: the main entry does not export
 * it, and it may change in any release.
 * @internal
 */
export function taskCoordinationOf(resizer: Resizer): TaskCoordination {
  return readTaskCoordination(resizer);
}

/**
 * The checks of verify() that need no queue name (the parts, the config, the coordination, the
 * media store, the lock store unless the task queue is a router, the decoders): the worker runs
 * them for every Resizer it serves. Builds no route and reads no timing. A lock store already in
 * `verified` is skipped, and one that passes is added, so the worker checks a shared one once.
 * Internal: the main entry does not export it, and it may change in any release.
 * @internal
 */
export function verifyServicesOf(
  resizer: Resizer,
  verified?: Set<object>,
): Promise<void> {
  return runVerifyServices(resizer, verified);
}

/**
 * The checks of verify() for the queue name `queue` (its unavailable reason, its carrier, its
 * timing, the carrier's verify(), the lock store a router's carrier needs): the worker runs them
 * for each name it consumes, for every served Resizer whose task queue carries it. Builds only that
 * name's route. A carrier or lock store already in `verified` is skipped, and one that passes is
 * added, so the worker checks a shared one once. Internal: the main entry does not export it, and
 * it may change in any release.
 * @internal
 */
export function verifyRouteOf(
  resizer: Resizer,
  queue: string,
  verified?: Set<object>,
): Promise<void> {
  return runVerifyRoute(resizer, queue, verified);
}

/**
 * The part shared in this process under `key` (e.g. the framework adapter's task queue of one
 * backend): built once by `build`, forgotten with the Resizers by resetResizerForTests(). A build
 * that rejects is built again on the next call. Internal: the main entry does not export it, and
 * it may change in any release.
 * @internal
 */
export function sharedPart<V>(
  key: string,
  build: () => Promise<V>,
): Promise<V> {
  return registry.shared(key, build);
}

/**
 * The value shared in this process under `key` (e.g. the framework adapter's queue drivers): the
 * first call records `value`, and every call until resetResizerForTests() returns that recorded
 * value, so the caller can compare its own with it. Internal: the main entry does not export it,
 * and it may change in any release.
 * @internal
 */
export function sharedValue<V>(key: string, value: V): V {
  return registry.sharedValue(key, value);
}

/**
 * The value sharedValue() recorded in this process under `key`, if any; records nothing, so a
 * caller can compare its own value before it commits to recording it. Internal, like sharedValue.
 * @internal
 */
export function recordedValue<V>(key: string): V | undefined {
  return registry.recordedValue<V>(key);
}

/**
 * TEST-ONLY: forget every constructed Resizer, shared part and shared value so a test can construct
 * fresh ones. The framework adapter's task queues are such shared parts, kept per process: a test
 * that installs another fake app without calling this keeps the task queues built for the previous
 * app.
 */
export function resetResizerForTests(): void {
  registry.reset();
}
