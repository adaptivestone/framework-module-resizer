// The constructor-wired public surface (02 · §6, design delta #12): every driver is
// injected in ONE visible options literal at construction and fixed for the process
// lifetime — no register-call sequence, no hidden global registries. The class also
// carries the named-pipeline set (04 · §8) and the cross-cutting hook bus (04 · §9).
// Each Resizer owns its config, logger and event bus, all passed in explicitly: the core never
// reads a framework app. Framework hosts get them filled by createFrameworkResizer
// (src/framework/resizer.ts).
import type { Metadata, Sharp } from 'sharp';
import {
  type EnqueueRequiredOpts,
  enqueueRequiredImpl,
  type PrewarmOpts,
  prewarmImpl,
  type ResolveOpts,
  resolveImpl,
} from './engine.ts';
import { ResizeSetupError } from './errors.ts';
import type { LockProvider } from './locks/AbstractLockProvider.ts';
import type { MediaStore } from './mediaStore/AbstractMediaStore.ts';
import { uploadOriginalImpl } from './original.ts';
import { validateResizeConfig } from './resizeConfig.ts';
import { generateImpl } from './resizeTask.ts';
// Transport + storage contracts (05 · §10.1, §10.4) now live in their own files —
// transports/AbstractTransport.ts + storage/AbstractStorage.ts — so the optional-peer drivers
// import them WITHOUT depending on this module. Imported here for the local annotations below
// and re-exported so every existing import site (engine.ts, mongo.ts, tests, …) keeps importing
// them from resizer.ts unchanged.
import type { ResizeStorage } from './storage/AbstractStorage.ts';
import type {
  EnqueueTask,
  LeasedTask,
  QueueTransport,
  StartWorkerOpts,
  TaskEvent,
  TaskEventHandler,
} from './transports/AbstractTransport.ts';
import type {
  EnqueueRequiredResult,
  MediaLike,
  MissingPreview,
  Original,
  Preview,
  PreviewFormat,
  ReadDecision,
  ResizeConfig,
  ResizeEventBus,
  ResizeLogger,
  SizeInput,
  UploadOriginalOpts,
} from './types.d.ts';

export type { LockProvider } from './locks/AbstractLockProvider.ts';
export type { MediaStore } from './mediaStore/AbstractMediaStore.ts';
export type {
  EnqueueTask,
  LeasedTask,
  QueueTransport,
  ResizeStorage,
  StartWorkerOpts,
  TaskEvent,
  TaskEventHandler,
};

// ---------------------------------------------------------------------------
// Named pipeline types (04 · §8) — the per-media-type pixel work. sharp is a hard dep;
// these reference its types (erased at runtime, so this module stays pure logic).
// ---------------------------------------------------------------------------

export type BeforeStep = (
  buffer: Buffer,
  meta: { media: MediaLike; metadata: Metadata; ctx: Record<string, unknown> },
) => Buffer | Promise<Buffer>;

export type VariantStep = (
  img: Sharp,
  meta: { variant: MissingPreview; ctx: Record<string, unknown> }, // variant carries `filters`, `fit`
) => Sharp | Promise<Sharp>;

export interface Pipeline {
  beforeSteps?: BeforeStep[]; // async; run ONCE on the original buffer, before any resize
  variantSteps?: VariantStep[]; // run PER variant, after resize, before encode
}

// ---------------------------------------------------------------------------
// Hook names (04 · §9). Waterfall hooks thread a value through their taps (default =
// identity); observer hooks are fire-and-forget side effects (return ignored; errors
// logged). NOT pipelines (those are per-media-type pixel work, above).
// ---------------------------------------------------------------------------

export type WaterfallName =
  | 'resolveSizes'
  | 'beforeEnqueue'
  | 'formatPublicUrls';
export type ObserverName =
  | 'onPreviewGenerated'
  | 'afterTaskComplete'
  | 'onTaskFailed'
  | 'onTaskDeadLettered';
export type HookName = WaterfallName | ObserverName;

// Per-hook tap signatures (04 · §9 review fix). The public `hook(name, fn)` + the `hooks:`
// constructor option infer `fn`'s exact shape from `name`, so a typo'd tap body or a wrong
// return shape is a COMPILE error instead of silent `any`. Waterfalls thread + return their
// value; observers are fire-and-forget (return ignored). `task` is always the transport-agnostic
// LeasedTask, and the worker/transport observers receive `ctx === {}`.
export interface HookSignatures {
  resolveSizes: (
    sizes: SizeInput[],
    ctx: Record<string, unknown>,
  ) => SizeInput[] | Promise<SizeInput[]>;
  beforeEnqueue: (
    missing: MissingPreview[],
    ctx: Record<string, unknown>,
  ) => MissingPreview[] | Promise<MissingPreview[]>;
  formatPublicUrls: (
    decision: ReadDecision,
    ctx: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
  onPreviewGenerated: (
    preview: Preview,
    ctx: Record<string, unknown>,
  ) => unknown;
  afterTaskComplete: (
    task: LeasedTask,
    ctx: Record<string, unknown>,
  ) => unknown;
  onTaskFailed: (
    task: LeasedTask,
    error: unknown,
    ctx: Record<string, unknown>,
  ) => unknown;
  onTaskDeadLettered: (
    task: LeasedTask,
    error: unknown,
    ctx: Record<string, unknown>,
  ) => unknown;
}

// Deliberately loose: the bus stores heterogeneous taps uniformly. The PUBLIC surface
// (`hook<N>`, `ResizerOptions.hooks`) is typed via HookSignatures above; internal storage +
// runWaterfall/runObservers keep this loose type with contained casts.
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tap signatures; typed at Resizer.hook
export type HookFn = (...args: any[]) => unknown;

// ---------------------------------------------------------------------------
// Constructor options (02 · §6). `storage` is the ONE required option — both modes need
// it (05 · §10.4), so a missing driver is a boot-time type/throw error, not a runtime
// degradation. `transport` is optional (eager-only hosts omit it — 11 · Modes).
// ---------------------------------------------------------------------------

export interface ResizerOptions {
  name?: string; // registry key; default 'default'
  config: ResizeConfig; // REQUIRED: the complete, validated resize config
  logger?: ResizeLogger; // default: console
  events?: ResizeEventBus; // optional bus that also receives observers as `resize:<hook>`
  storage: ResizeStorage; // REQUIRED (05 · §10.4)
  mediaStore: MediaStore; // REQUIRED: loads media, saves preview metadata (05 · §10.6)
  transport?: QueueTransport; // lazy mode only (05 · §10.1)
  queue?: string; // default queue for this Resizer's tasks; default 'default'
  lockProvider?: LockProvider; // REQUIRED with a transport: dispatch and worker locks (05 · §10.6)
  pipelines?: Record<string, Pipeline>; // initial named pipelines (04 · §8)
  // Initial taps (04 · §9) — each name infers its typed signature (single fn or array).
  hooks?: { [N in HookName]?: HookSignatures[N] | HookSignatures[N][] };
}

// Options for eager `generate` (11 · Modes §11.1) — a NAMED type so hosts can annotate their
// call sites and the method signature stays DRY (ResolveOpts / PrewarmOpts live in engine.ts).
export interface GenerateOpts {
  media: MediaLike;
  sizes: SizeInput[];
  pipeline?: string; // selects a registered pipeline; default 'default'
  formats?: PreviewFormat[]; // default = config.formats
  ctx?: Record<string, unknown>; // real ctx reaches pipeline steps (eager mode, 04 · §8)
  persist?: boolean; // default true → $push previews + backfill dims
}

// `created` is only the rows THIS call produced. Empty + `failed === 0` is success
// (already stored or an empty catalog). Total failure throws.
export interface GenerateResult {
  created: Preview[];
  failed: number;
}

// Unknown pipeline name → the shared, frozen empty pipeline (no steps). One frozen
// constant avoids per-call allocation + accidental mutation of a "default" (04 · §8).
const EMPTY_PIPELINE: Pipeline = Object.freeze({});

// Constructed Resizers by name. Entry points (the worker, host code) look them up here;
// core code always receives its Resizer as an argument.
const resizers = new Map<string, Resizer>();

// Eager-only Resizers (no transport) never take locks. This placeholder keeps the field typed
// and turns an unexpected use into a named setup error instead of a TypeError.
const NO_LOCK_PROVIDER: LockProvider = Object.freeze({
  acquire: async (): Promise<boolean> => {
    throw new ResizeSetupError(
      'resize: this Resizer has no lockProvider — pass one together with a transport',
      { code: 'RESIZE_LOCK_PROVIDER_REQUIRED' },
    );
  },
  release: async (): Promise<void> => {},
});

// How framework hosts get the parts below filled in from their app.
const FRAMEWORK_HINT =
  "framework hosts: use createFrameworkResizer() from '@adaptivestone/framework-module-resize/framework.js'";

/**
 * A named resize engine: config, drivers, pipelines and hooks. Most hosts construct one
 * (named 'default'); a host that needs different storage, media models or formats constructs
 * more, each under its own name. Drivers are fixed at construction.
 */
export class Resizer {
  readonly name: string;
  readonly queue: string;
  readonly config: ResizeConfig;
  readonly logger: ResizeLogger;
  readonly #events: ResizeEventBus | undefined;
  readonly storage: ResizeStorage;
  readonly transport: QueueTransport | undefined;
  readonly mediaStore: MediaStore;
  readonly lockProvider: LockProvider;
  // Named pipelines: last-wins per name (04 · §8).
  readonly #pipelines: Map<string, Pipeline>;
  // Hook bus: taps run in REGISTRATION order, awaited sequentially (04 · §9).
  readonly #hooks: Map<HookName, HookFn[]>;

  constructor(opts: ResizerOptions) {
    // Runtime storage validation (02 · §6 review fix): `storage` is the ONE required option —
    // both modes need it (05 · §10.4). The type system enforces it for TS hosts, but a JS host or
    // a half-filled scaffold would otherwise fail with a downstream TypeError at the first
    // publicUrl/download — throw a NAMED error at construction instead.
    if (!opts?.storage) {
      throw new ResizeSetupError(
        'resize: `storage` is required — construct `new Resizer({ storage: … })` with a ResizeStorage driver (e.g. new S3Storage({ … })); both the read path (publicUrl) and the worker (download/upload) need it (05 · §10.4)',
        { code: 'RESIZE_STORAGE_REQUIRED' },
      );
    }
    const name = opts.name ?? 'default';
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new ResizeSetupError('resize: `name` must be a non-empty string', {
        code: 'RESIZE_NAME_INVALID',
      });
    }
    if (resizers.has(name)) {
      throw new ResizeSetupError(
        `resize: a Resizer named '${name}' already exists in this process — construct each name once and use getResizer('${name}') elsewhere`,
        { code: 'RESIZE_DUPLICATE_RESIZER' },
      );
    }
    const queue = opts.queue ?? 'default';
    if (typeof queue !== 'string' || queue.trim().length === 0) {
      throw new ResizeSetupError('resize: `queue` must be a non-empty string', {
        code: 'RESIZE_QUEUE_INVALID',
      });
    }
    // The core takes every part explicitly; it never reads a framework app.
    if (opts.config === undefined) {
      throw new ResizeSetupError(
        `resize: \`config\` is required — pass a complete ResizeConfig (e.g. spread defaultResizeConfig from '@adaptivestone/framework-module-resize/config/resize.js'); ${FRAMEWORK_HINT}`,
        { code: 'RESIZE_CONFIG_REQUIRED' },
      );
    }
    if (!opts.mediaStore) {
      throw new ResizeSetupError(
        `resize: \`mediaStore\` is required — it loads media and saves preview metadata; ${FRAMEWORK_HINT}`,
        { code: 'RESIZE_MEDIA_STORE_REQUIRED' },
      );
    }
    if (opts.transport && !opts.lockProvider) {
      throw new ResizeSetupError(
        `resize: a Resizer with a \`transport\` needs a \`lockProvider\` (dispatch and worker locks); ${FRAMEWORK_HINT}`,
        { code: 'RESIZE_LOCK_PROVIDER_REQUIRED' },
      );
    }
    // Validate before registering, so a bad config never claims the name and a corrected
    // retry succeeds.
    this.config = validateResizeConfig(opts.config);
    this.logger = opts.logger ?? console;
    this.#events = opts.events;
    this.name = name;
    this.queue = queue;
    // erasableSyntaxOnly: no parameter properties — assign fields explicitly.
    this.storage = opts.storage;
    this.transport = opts.transport;
    this.mediaStore = opts.mediaStore;
    this.lockProvider = opts.lockProvider ?? NO_LOCK_PROVIDER;
    this.#pipelines = new Map(Object.entries(opts.pipelines ?? {}));
    // A seeded hooks value may be a single fn or an array — normalize to arrays and
    // COPY them, so a caller mutating its own array later cannot bypass hook().
    this.#hooks = new Map();
    for (const [hookName, fns] of Object.entries(opts.hooks ?? {})) {
      const arr = (Array.isArray(fns) ? [...fns] : [fns]) as HookFn[];
      this.#hooks.set(hookName as HookName, arr);
    }
    resizers.set(name, this);
  }

  /**
   * Register a tap — `fn` is inferred from `name` via HookSignatures (04 · §9). Multiple taps per
   * name are allowed; registration order is preserved. (Internal storage stays loosely typed.)
   */
  hook<N extends HookName>(name: N, fn: HookSignatures[N]): void {
    const taps = this.#hooks.get(name);
    if (taps) {
      taps.push(fn as HookFn);
    } else {
      this.#hooks.set(name, [fn as HookFn]);
    }
  }

  /** Register a named pipeline — last-wins per name (04 · §8). */
  registerPipeline(name: string, p: Pipeline): void {
    this.#pipelines.set(name, p);
  }

  /** Look up a pipeline; an unknown name → the shared frozen empty pipeline (no steps). */
  getPipeline(name: string): Pipeline {
    return this.#pipelines.get(name) ?? EMPTY_PIPELINE;
  }

  /**
   * Thread `value` through the name's taps in order, awaiting each. Taps are HOST code
   * on the read path, so each is GUARDED: on throw, log and keep the prior value (treat
   * the tap as identity). No taps → returns the input unchanged. (04 · §9)
   */
  async runWaterfall(
    name: WaterfallName,
    value: unknown,
    ctx: Record<string, unknown>,
    // `optional` (0.2 formatPublicUrls): no taps / every tap throws → `undefined`
    // instead of leaking the raw decision as a DTO. Other waterfalls stay `identity`.
    mode: 'identity' | 'optional' = 'identity',
  ): Promise<unknown> {
    const taps = this.#hooks.get(name) ?? [];
    if (mode === 'optional' && taps.length === 0) {
      return undefined;
    }
    let succeeded = false;
    for (const fn of taps) {
      try {
        value = await fn(value, ctx);
        succeeded = true;
      } catch (e) {
        this.logger.error(`resize waterfall ${name} tap failed (skipped)`, e);
      }
    }
    if (mode === 'optional' && !succeeded) {
      return undefined;
    }
    return value;
  }

  /**
   * Fire an observer. First a fire-and-forget mirror onto the framework event bus as
   * `resize:<name>` (its own try/catch) so ecosystem subscribers see it BEFORE the taps;
   * then await each registered tap sequentially, error-isolated (log + continue). Return
   * values are ignored. (04 · §9)
   */
  async runObservers(name: ObserverName, ...args: unknown[]): Promise<void> {
    try {
      this.#events?.emit(`resize:${name}`, ...args);
    } catch (e) {
      this.logger.error(`resize event ${name} listener failed`, e);
    }
    for (const fn of this.#hooks.get(name) ?? []) {
      try {
        await fn(...args);
      } catch (e) {
        this.logger.error(`resize hook ${name} failed`, e);
      }
    }
  }

  /**
   * Read path (06 · §17) — the host calls this from its DTO builders. Delegates to the
   * engine (src/engine.ts), which partitions ready vs missing, enqueues the missing set,
   * and never throws into the caller's read.
   */
  async resolve(
    opts: ResolveOpts,
  ): Promise<{ decision: ReadDecision; output: unknown }> {
    return resolveImpl(this, opts);
  }

  /**
   * Pre-warm mode (11 · Modes §11.1b) — queue the catalog's variants at UPLOAD without blocking
   * on image work, so the previews are (usually) already there by the first real read. Delegates
   * to the engine (src/engine.ts): the `resolveSizes` waterfall (real ctx reaches the taps) →
   * expand sizes × formats, skipping identities already in `media.previews` and SVG originals
   * that storage proves are already public → `beforeEnqueue` waterfall → hand survivors to the SAME
   * dispatch-lock `enqueue()` as the read path. NEVER throws (same guarantee as `resolve`); with
   * no transport it logs once and returns `{ enqueued: 0 }`. `enqueued` = variants handed to the
   * transport (dispatch-lock survivors).
   */
  async prewarm(opts: PrewarmOpts): Promise<{ enqueued: number }> {
    return prewarmImpl(this, opts);
  }

  /** Strict queueing API: never equates a held lock with a durable task receipt. */
  async enqueueRequired(
    opts: EnqueueRequiredOpts,
  ): Promise<EnqueueRequiredResult> {
    return enqueueRequiredImpl(this, opts);
  }

  /**
   * Eager mode (11 · Modes §11.1) — synchronous generate at upload; no queue/worker/locks.
   * Delegates to the SHARED resize core (src/resizeTask.ts): resolveSizes waterfall with the
   * caller's REAL ctx → expand sizes × formats, skipping identities already in media.previews
   * (idempotent) → download once → beforeSteps once → per-variant resize/encode/upload
   * (bounded by config.worker.concurrency, NO locks). `persist !== false` → one
   * mediaStore.appendPreviews (+ display-dim backfill); else the previews are returned unstored.
   */
  async generate(opts: GenerateOpts): Promise<GenerateResult> {
    return generateImpl(this, opts);
  }

  /** Store an untouched, byte-sniffed original. Does not create media or queue work. */
  async uploadOriginal(opts: UploadOriginalOpts): Promise<Original> {
    return uploadOriginalImpl(this, opts);
  }
}

/** The Resizer registered under `name` (worker entry, host code, late taps). */
export function getResizer(name = 'default'): Resizer {
  const resizer = resizers.get(name);
  if (!resizer) {
    throw new ResizeSetupError(
      `resize: no Resizer named '${name}' — construct it in bootstrap code that runs in every process that uses it`,
      { code: 'RESIZE_NO_RESIZER' },
    );
  }
  return resizer;
}

/** Every registered Resizer, in construction order (the worker serves all of them). */
export function listResizers(): Resizer[] {
  return [...resizers.values()];
}

/** TEST-ONLY: forget every constructed Resizer so a test can construct fresh ones. */
export function resetResizerForTests(): void {
  resizers.clear();
}
