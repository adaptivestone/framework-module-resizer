// Hook names and tap signatures. Waterfall hooks thread a value through their taps (default =
// identity); observer hooks are fire-and-forget side effects (return ignored; errors logged).
// NOT pipelines (those are per-media-type pixel work, see pipeline.ts).
import type {
  MissingPreview,
  Preview,
  ReadDecision,
  SizeInput,
} from '../types.d.ts';
import type { LeasedTask } from './taskQueue.ts';

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

// Per-hook tap signatures. The public `hook(name, fn)` + the `hooks:` constructor option infer
// `fn`'s exact shape from `name`, so a typo'd tap body or a wrong return shape is a COMPILE error
// instead of silent `any`. Waterfalls thread + return their value; observers are fire-and-forget
// (return ignored). `task` is always the backend-agnostic LeasedTask, and the worker observers
// receive `ctx === {}`.
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

// Initial taps, per hook name: one function or an array of them, each typed by its name.
export type HookTaps = {
  [N in HookName]?: HookSignatures[N] | HookSignatures[N][];
};

// Deliberately loose: the bus stores heterogeneous taps uniformly. The PUBLIC surface
// (`hook<N>`, `HookTaps`) is typed via HookSignatures above; the bus keeps this loose type
// internally with contained casts.
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tap signatures; typed at Resizer.hook, HookBus.add and HookTaps
export type HookFn = (...args: any[]) => unknown;
