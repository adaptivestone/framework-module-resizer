// The constructor-wired public surface (02 · §6, design delta #12): every driver is
// injected in ONE visible options literal at construction and fixed for the process
// lifetime — no register-call sequence, no hidden global registries. The class also
// carries the named-pipeline set (04 · §8) and the cross-cutting hook bus (04 · §9).
// logger/events are read through getApp() at CALL time (never at module top) so tests
// can install a fake per run.
import type { Metadata, Sharp } from 'sharp';
import { getApp } from './app.ts';
import { resolveImpl } from './engine.ts';
import { frameworkLockProvider, type LockProvider } from './locks.ts';
import { frameworkMediaStore, type MediaStore } from './mediaStore.ts';
import type {
  MediaLike,
  MissingPreview,
  Preview,
  PreviewFormat,
  ReadDecision,
  SizeInput,
  StorageRef,
} from './types.d.ts';

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
// Transport + storage interfaces (05 · §10.1, §10.4) — NO `app` parameter anywhere;
// shipped drivers reach the framework through getApp(), custom ones close over their own.
// ---------------------------------------------------------------------------

export interface LeasedTask {
  taskId: string;
  mediaId: string;
  pipeline: string;
  previews: MissingPreview[];
}

export interface QueueTransport {
  enqueue(task: {
    mediaId: string;
    pipeline: string;
    previews: MissingPreview[];
  }): Promise<{ taskId: string | null }>;

  // The transport drives consumption its own way (poll OR push): it calls handleTask per
  // task and owns completion/redelivery. taskOpts.signal aborts THIS task if its lease is
  // lost (best-effort); opts.signal is worker-wide shutdown (05 · §10.1).
  startWorker(
    handleTask: (
      task: LeasedTask,
      taskOpts?: { signal: AbortSignal },
    ) => Promise<void>,
    opts: { signal: AbortSignal },
  ): Promise<void>;
}

export interface ResizeStorage {
  // Download an existing object by its stored locator (the worker's original).
  download(ref: StorageRef): Promise<Buffer | Uint8Array>;
  // Upload a NEW object; the DRIVER picks physical placement + returns the locator to persist.
  upload(args: {
    key: string;
    body: Buffer | Uint8Array;
    contentType: string;
    visibility: 'public' | 'private';
  }): Promise<StorageRef>;
  // PURE, synchronous, NO I/O — the read path calls this to build public URLs (05 · §10.4).
  publicUrl(ref: StorageRef): string;
  // Optional: a time-limited signed URL for owner/admin reads of a private original.
  signedUrl?(ref: StorageRef, ttlSeconds: number): Promise<string>;
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

// Deliberately loose: waterfall taps `(value, ctx) => value` and observer taps
// `(...args) => void` have different shapes and are typed precisely at the public
// Resizer.hook call site (10 · index). The bus stores them uniformly.
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
  mediaStore?: MediaStore; // default: frameworkMediaStore (05 · §10.6)
  lockProvider?: LockProvider; // default: frameworkLockProvider (05 · §10.6)
  pipelines?: Record<string, Pipeline>; // initial named pipelines (04 · §8)
  hooks?: Partial<Record<HookName, HookFn | HookFn[]>>; // initial taps (04 · §9)
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
  private readonly pipelines: Map<string, Pipeline>;
  // Hook bus: taps run in REGISTRATION order, awaited sequentially (04 · §9).
  private readonly hooks: Map<HookName, HookFn[]>;

  constructor(opts: ResizerOptions) {
    // One-per-process ENFORCED, mirroring the framework's setAppInstance: a second
    // construction is a bootstrap bug (two competing driver sets), so throw loudly.
    if (activeResizer) {
      throw new Error(
        'resize: only one Resizer per process — use resetResizerForTests() in tests',
      );
    }
    // erasableSyntaxOnly: no parameter properties — assign fields explicitly.
    this.storage = opts.storage;
    this.transport = opts.transport;
    this.mediaStore = opts.mediaStore ?? frameworkMediaStore;
    this.lockProvider = opts.lockProvider ?? frameworkLockProvider;
    this.pipelines = new Map(Object.entries(opts.pipelines ?? {}));
    // A seeded hooks value may be a single fn or an array — normalize to arrays and
    // COPY them, so a caller mutating its own array later cannot bypass hook().
    this.hooks = new Map();
    for (const [name, fns] of Object.entries(opts.hooks ?? {})) {
      this.hooks.set(name as HookName, Array.isArray(fns) ? [...fns] : [fns]);
    }
    activeResizer = this;
  }

  /** Register a tap. Multiple taps per name are allowed; registration order is preserved. */
  hook(name: HookName, fn: HookFn): void {
    const taps = this.hooks.get(name);
    if (taps) {
      taps.push(fn);
    } else {
      this.hooks.set(name, [fn]);
    }
  }

  /** Register a named pipeline — last-wins per name (04 · §8). */
  registerPipeline(name: string, p: Pipeline): void {
    this.pipelines.set(name, p);
  }

  /** Look up a pipeline; an unknown name → the shared frozen empty pipeline (no steps). */
  getPipeline(name: string): Pipeline {
    return this.pipelines.get(name) ?? EMPTY_PIPELINE;
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
  ): Promise<unknown> {
    const app = getApp();
    for (const fn of this.hooks.get(name) ?? []) {
      try {
        value = await fn(value, ctx);
      } catch (e) {
        app.logger.error(`resize waterfall ${name} tap failed (skipped)`, e);
      }
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
    for (const fn of this.hooks.get(name) ?? []) {
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
    enqueueMissing?: boolean; // default true
  }): Promise<{ decision: ReadDecision; output: unknown }> {
    return resolveImpl(this, opts);
  }

  /**
   * Eager mode (11 · Modes) — synchronous generate at upload; no queue/worker.
   * STUB: shares the worker core, lands in build step 5+8.
   */
  async generate(_opts: {
    media: MediaLike;
    sizes: SizeInput[];
    pipeline?: string;
    formats?: PreviewFormat[];
    ctx?: Record<string, unknown>;
    persist?: boolean; // default true → $push previews + backfill dims
  }): Promise<{ previews: Preview[] }> {
    throw new Error('not implemented yet (build step 5)');
  }
}

/** The active instance (worker command, module internals, late taps from other modules). */
export function getResizer(): Resizer {
  if (!activeResizer) {
    throw new Error(
      'resize: no Resizer constructed yet — `new Resizer({ storage, … })` in bootstrap code that runs in both the API and worker processes (02 · §6)',
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
