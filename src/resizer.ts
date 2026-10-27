// The constructor-wired public surface (02 · §6, design delta #12): every driver is
// injected in ONE visible options literal at construction and fixed for the process
// lifetime — no register-call sequence. The Resizer holds its named pipelines (src/pipelines.ts)
// and its hook bus (src/hooks.ts), and registers itself by name in the process registry below.
// Each Resizer owns its config, logger and event bus, all passed in explicitly: the core never
// reads a framework app. Framework hosts use FrameworkResizer (src/framework/resizer.ts), which
// builds every part from the app's config file.
import { Catalog } from './catalog.ts';
import defaultResizeConfig from './config/resize.ts';
import type {
  HookName,
  HookSignatures,
  HookTaps,
  ObserverName,
  WaterfallName,
} from './contracts/hooks.ts';
import type { LockStore } from './contracts/locks.ts';
import type { MediaStore } from './contracts/media.ts';
import type { Pipeline } from './contracts/pipeline.ts';
import type { ResizeStorage } from './contracts/storage.ts';
import type { TaskQueue } from './contracts/taskQueue.ts';
import { Dispatcher } from './dispatcher.ts';
import { ResizeSetupError } from './errors.ts';
import { logNeverThrow } from './helpers/log.ts';
import { HookBus } from './hooks.ts';
import { PipelineRegistry } from './pipelines.ts';
import { timingOf } from './queue.ts';
import { prewarmFailure, Reader } from './reader.ts';
import { Registry } from './registry.ts';
import { validateResizeConfig } from './resizeConfig.ts';
import { generateImpl } from './resizeTask.ts';
import type {
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
// Constructor options (02 · §6). `storage` and `media` are required — both modes need them
// (05 · §10.4), so a missing driver is a boot-time type/throw error, not a runtime
// degradation. `tasks` is optional (eager-only hosts omit it — 11 · Modes), and `locks` is
// required beside it: reads and the worker lock every variant they queue or render.
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
  // Locks for queued work, e.g. mongoParts(…).locks. Required when `tasks` is set; eager-only
  // hosts may omit it.
  locks?: LockStore | LazyPart<LockStore | undefined>;
  // Queued work (prewarm, lazy reads, the worker): where tasks wait, e.g. mongoParts(…).tasks or
  // an SqsTaskQueue. Omit (or resolve to undefined) for eager-only hosts.
  tasks?: TaskQueue | LazyPart<TaskQueue | undefined>;
  queue?: string; // default queue name for this Resizer's tasks; default 'default'
  pipelines?: Record<string, Pipeline>; // the named pipelines, fixed at construction
  // Initial taps — each name infers its typed signature (single fn or array); hook() adds more.
  hooks?: HookTaps;
}

// Constructed Resizers by name (see src/registry.ts).
const registry = new Registry<Resizer>();

const PART_NAMES = ['storage', 'media', 'locks', 'tasks'] as const;
type PartName = (typeof PART_NAMES)[number];

// What the Resizer's methods run on, built once by ready() from the loaded parts and the
// validated config. No service receives the Resizer.
interface Services {
  catalog: Catalog;
  uploader: Uploader;
  dispatcher: Dispatcher | undefined; // only with a task queue
  reader: Reader;
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
    `resize: Resizer '${name}' has a task queue but no \`locks\` — reads and the worker lock every variant they queue or render (e.g. the parts of mongoParts(connection, { mediaModel })); ${FRAMEWORK_HINT}`,
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
  // Each part loads once: the parts usable now (given as objects, or loaded) and the loads in
  // flight. A part whose function failed is retried alone; the parts that loaded are kept.
  readonly #loadedParts = new Set<PartName>();
  readonly #loadingParts = new Map<PartName, Promise<void>>();
  readonly #pipelines: PipelineRegistry;
  readonly #hooks: HookBus;
  #builtServices: Services | undefined;

  constructor(opts: ResizerOptions) {
    // Runtime storage validation (02 · §6 review fix): `storage` is the ONE required option —
    // both modes need it (05 · §10.4). The type system enforces it for TS hosts, but a JS host or
    // a half-filled scaffold would otherwise fail with a downstream TypeError at the first
    // publicUrl/download — throw a NAMED error at construction instead.
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
   * `media`, `locks` or `tasks` directly. The checks run in this order, and the first failure
   * rejects: the parts load; a task queue without a lock store is RESIZE_LOCKS_REQUIRED; the task
   * queue's timing is validated; the image config is read and validated; the services are built.
   * A part whose function fails is retried by the next call, and so is a timing or config that
   * fails to load or validate; the parts that loaded are kept.
   */
  async ready(): Promise<void> {
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
        this.#loadPart('tasks', this.#sources.tasks, (tasks) => {
          this.#tasks = tasks ?? undefined;
        }),
      ]);
    }
    this.#ensureServices();
  }

  /**
   * The services: built on the first call that succeeds, then the same object. A failed build
   * leaves nothing behind. Called only after the parts are loaded.
   */
  #ensureServices(): Services {
    if (!this.#builtServices) {
      // The locks and the queue timing are checked before the config (the order ready() states).
      const dispatcher = this.#buildDispatcher();
      const { config, storage } = this;
      const catalog = new Catalog({ config });
      this.#builtServices = {
        catalog,
        uploader: new Uploader({ storage, config }),
        dispatcher,
        reader: new Reader({
          catalog,
          dispatcher,
          hooks: this.#hooks,
          pipelines: this.#pipelines,
          storage,
          logger: this.logger,
          name: this.name,
          queue: this.queue,
        }),
      };
    }
    return this.#builtServices;
  }

  /**
   * The Dispatcher of a Resizer with a task queue, on the queue's validated timing (undefined: eager
   * only). Queued work locks every variant, so a task queue without a lock store rejects every call
   * (resolve() and prewarm() turn that into their safe result).
   */
  #buildDispatcher(): Dispatcher | undefined {
    const tasks = this.#tasks;
    if (!tasks) {
      return undefined;
    }
    const locks = this.#locks;
    if (!locks) {
      throw locksRequired(this.name);
    }
    return new Dispatcher({
      tasks,
      locks,
      timing: timingOf(tasks),
      name: this.name,
      logger: this.logger,
    });
  }

  /** The services, once ready() has loaded the parts and built them. */
  async #services(): Promise<Services> {
    await this.ready();
    return this.#ensureServices();
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
   * Optional startup check: load the drivers; resolve and validate the config and the task queue's
   * timing; run the media store's and the lock store's verify(); check the task queue (its own
   * verify(), and that it serves this Resizer's queue).
   * Framework hosts call it after `Server.init()` to fail at boot instead of at the first upload or
   * read. The worker runs it for every Resizer before leasing.
   */
  async verify(): Promise<void> {
    await this.ready();
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

  /** Look up a pipeline; an unknown name → the shared frozen empty pipeline (no steps). */
  getPipeline(name: string): Pipeline {
    return this.#pipelines.get(name);
  }

  /** True when `name` is registered. `default` always exists: unregistered, it has no steps. */
  hasPipeline(name: string): boolean {
    return this.#pipelines.has(name);
  }

  /** Thread `value` through the name's guarded taps (see HookBus.runWaterfall). */
  runWaterfall(
    name: WaterfallName,
    value: unknown,
    ctx: Record<string, unknown>,
    mode?: 'identity' | 'optional',
  ): Promise<unknown> {
    return this.#hooks.runWaterfall(name, value, ctx, mode);
  }

  /** Fire an observer: the event bus first, then every tap (see HookBus.runObservers). */
  runObservers(name: ObserverName, ...args: unknown[]): Promise<void> {
    return this.#hooks.runObservers(name, ...args);
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
   * not required / unconfirmed, with task receipts and issues); a held dispatch lock never counts as
   * queued. NEVER throws (same guarantee as `resolve`): an internal error is `status: 'incomplete'`.
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
   * Eager mode (11 · Modes §11.1) — synchronous generate at upload; no queue/worker/locks.
   * Delegates to the SHARED resize core (src/resizeTask.ts): resolveSizes waterfall with the
   * caller's REAL ctx → expand sizes × formats, skipping identities already in media.previews
   * (idempotent) → download once → beforeSteps once → per-variant resize/encode/upload
   * (bounded by config.concurrency, NO locks). `persist !== false` → one
   * media.appendPreviews (+ display-dim backfill); else the previews are returned unstored.
   */
  async generate(opts: GenerateOpts): Promise<GenerateResult> {
    await this.ready();
    return generateImpl(this, opts);
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
