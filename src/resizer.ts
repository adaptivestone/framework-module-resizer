// The constructor-wired public surface (02 · §6, design delta #12): every driver is
// injected in ONE visible options literal at construction and fixed for the process
// lifetime — no register-call sequence, no hidden global registries. The class also
// carries the named-pipeline set (04 · §8) and the cross-cutting hook bus (04 · §9).
// logger/events are read through getApp() at CALL time (never at module top) so tests
// can install a fake per run.
import type { Metadata, Sharp } from 'sharp';
import { getApp } from './app.ts';
import { prewarmImpl, resolveImpl } from './engine.ts';
import { ResizeSetupError } from './errors.ts';
import type { LockProvider } from './locks/AbstractLockProvider.ts';
import { FrameworkLockProvider } from './locks/framework.ts';
import type { MediaStore } from './mediaStore/AbstractMediaStore.ts';
import { FrameworkMediaStore } from './mediaStore/framework.ts';
import { generateImpl } from './resizeTask.ts';
// Transport + storage contracts (05 · §10.1, §10.4) now live in their own files —
// transports/AbstractTransport.ts + storage/AbstractStorage.ts — so the optional-peer drivers
// import them WITHOUT depending on this module. Imported here for the local annotations below
// and re-exported so every existing import site (engine.ts, mongo.ts, tests, …) keeps importing
// them from resizer.ts unchanged.
import type { ResizeStorage } from './storage/AbstractStorage.ts';
import type {
  LeasedTask,
  QueueTransport,
} from './transports/AbstractTransport.ts';
import type {
  MediaLike,
  MissingPreview,
  Preview,
  PreviewFormat,
  ReadDecision,
  SizeInput,
} from './types.d.ts';

export type { LockProvider } from './locks/AbstractLockProvider.ts';
export type { MediaStore } from './mediaStore/AbstractMediaStore.ts';
export type { LeasedTask, QueueTransport, ResizeStorage };

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
  storage: ResizeStorage; // REQUIRED (05 · §10.4)
  transport?: QueueTransport; // lazy mode only (05 · §10.1)
  mediaStore?: MediaStore; // default: new FrameworkMediaStore() (05 · §10.6)
  lockProvider?: LockProvider; // default: new FrameworkLockProvider() (05 · §10.6)
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
  formats?: PreviewFormat[]; // default = requiredFormats(config)
  ctx?: Record<string, unknown>; // real ctx reaches pipeline steps (eager mode, 04 · §8)
  persist?: boolean; // default true → $push previews + backfill dims
}

// `created` is only the rows THIS call produced. Empty + `failed === 0` is success
// (already stored, SVG pass-through, or an empty catalog). Total failure throws.
export interface GenerateResult {
  created: Preview[];
  failed: number;
}

// Unknown pipeline name → the shared, frozen empty pipeline (no steps). One frozen
// constant avoids per-call allocation + accidental mutation of a "default" (04 · §8).
const EMPTY_PIPELINE: Pipeline = Object.freeze({});

// The process-wide active instance, set by the constructor (mirrors the framework's
// one-server-per-process appInstance slot). Module-scope `let`, never exported directly.
let activeResizer: Resizer | undefined;

/**
 * One Resizer per process. The host constructs it in bootstrap code that runs in BOTH
 * the API and worker processes; the worker command and late taps reach the instance via
 * getResizer(). Drivers are fixed at construction — swapping one means constructing the
 * Resizer differently (tests build fresh instances after resetResizerForTests()).
 */
export class Resizer {
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
    // One-per-process ENFORCED, mirroring the framework's setAppInstance: a second
    // construction is a bootstrap bug (two competing driver sets), so throw loudly.
    if (activeResizer) {
      throw new ResizeSetupError(
        'resize: only one Resizer per process — use resetResizerForTests() in tests',
        { code: 'RESIZE_DUPLICATE_RESIZER' },
      );
    }
    // erasableSyntaxOnly: no parameter properties — assign fields explicitly.
    this.storage = opts.storage;
    this.transport = opts.transport;
    this.mediaStore = opts.mediaStore ?? new FrameworkMediaStore();
    this.lockProvider = opts.lockProvider ?? new FrameworkLockProvider();
    this.#pipelines = new Map(Object.entries(opts.pipelines ?? {}));
    // A seeded hooks value may be a single fn or an array — normalize to arrays and
    // COPY them, so a caller mutating its own array later cannot bypass hook().
    this.#hooks = new Map();
    for (const [name, fns] of Object.entries(opts.hooks ?? {})) {
      const arr = (Array.isArray(fns) ? [...fns] : [fns]) as HookFn[];
      this.#hooks.set(name as HookName, arr);
    }
    activeResizer = this;
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
    const app = getApp();
    let succeeded = false;
    for (const fn of taps) {
      try {
        value = await fn(value, ctx);
        succeeded = true;
      } catch (e) {
        app.logger.error(`resize waterfall ${name} tap failed (skipped)`, e);
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
    const app = getApp();
    try {
      app.events?.emit(`resize:${name}`, ...args);
    } catch (e) {
      app.logger.error(`resize event ${name} listener failed`, e);
    }
    for (const fn of this.#hooks.get(name) ?? []) {
      try {
        await fn(...args);
      } catch (e) {
        app.logger.error(`resize hook ${name} failed`, e);
      }
    }
  }

  /**
   * Read path (06 · §17) — the host calls this from its DTO builders. Delegates to the
   * engine (src/engine.ts), which partitions ready vs missing, enqueues the missing set,
   * and never throws into the caller's read.
   */
  async resolve(opts: {
    media: MediaLike;
    sizes: SizeInput[];
    pipeline?: string; // selects a registered pipeline; default 'default'
    formats?: PreviewFormat[]; // default = requiredFormats(config)
    ctx?: Record<string, unknown>; // threaded to read-path hooks (04 · §8)
    enqueueMissing?: boolean; // default true when a transport is set, false otherwise
  }): Promise<{ decision: ReadDecision; output: unknown }> {
    return resolveImpl(this, opts);
  }

  /**
   * Pre-warm mode (11 · Modes §11.1b) — queue the catalog's variants at UPLOAD without blocking
   * on image work, so the previews are (usually) already there by the first real read. Delegates
   * to the engine (src/engine.ts): the `resolveSizes` waterfall (real ctx reaches the taps) →
   * expand sizes × formats, skipping identities already in `media.previews` and SVG originals
   * (pass-through → no-op) → `beforeEnqueue` waterfall → hand the survivors to the SAME
   * dispatch-lock `enqueue()` as the read path. NEVER throws (same guarantee as `resolve`); with
   * no transport it logs once and returns `{ enqueued: 0 }`. `enqueued` = variants handed to the
   * transport (dispatch-lock survivors).
   */
  async prewarm(opts: {
    media: MediaLike;
    sizes: SizeInput[];
    pipeline?: string; // selects a registered pipeline; default 'default'
    formats?: PreviewFormat[]; // default = requiredFormats(config)
    ctx?: Record<string, unknown>; // reaches the read-path waterfalls only (worker ctx stays {})
  }): Promise<{ enqueued: number }> {
    return prewarmImpl(this, opts);
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
}

/** The active instance (worker command, module internals, late taps from other modules). */
export function getResizer(): Resizer {
  if (!activeResizer) {
    throw new ResizeSetupError(
      'resize: no Resizer constructed yet — `new Resizer({ storage, … })` in bootstrap code that runs in both the API and worker processes (02 · §6)',
      { code: 'RESIZE_NO_RESIZER' },
    );
  }
  return activeResizer;
}

/**
 * TEST-ONLY: clear the active-instance slot so a test can construct a fresh Resizer.
 * NOT part of the public docs surface (not re-exported from index.ts docs — 02 · §6).
 */
export function resetResizerForTests(): void {
  activeResizer = undefined;
}
