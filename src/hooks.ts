// The hook bus: host taps by hook name, run in registration order and awaited one by one. Taps are
// host code, so every tap is guarded: a throw is logged and never reaches the caller.
import type {
  HookFn,
  HookName,
  HookSignatures,
  HookTaps,
  ObserverName,
  WaterfallName,
} from './contracts/hooks.ts';
import type { ResizeEventBus, ResizeLogger } from './types.d.ts';

export interface HookBusDeps {
  logger: ResizeLogger;
  events?: ResizeEventBus; // optional bus that also receives observers as `resize:<hook>`
  taps?: HookTaps; // initial taps
}

export class HookBus {
  readonly #logger: ResizeLogger;
  readonly #events: ResizeEventBus | undefined;
  readonly #taps = new Map<HookName, HookFn[]>();

  constructor(deps: HookBusDeps) {
    this.#logger = deps.logger;
    this.#events = deps.events;
    // A seeded hooks value may be a single fn or an array — normalize to arrays and
    // COPY them, so a caller mutating its own array later cannot bypass add().
    for (const [name, fns] of Object.entries(deps.taps ?? {})) {
      const arr = (Array.isArray(fns) ? [...fns] : [fns]) as HookFn[];
      this.#taps.set(name as HookName, arr);
    }
  }

  /** Add a tap after the seeded ones; `fn` is inferred from `name` via HookSignatures. */
  add<N extends HookName>(name: N, fn: HookSignatures[N]): void {
    const taps = this.#taps.get(name);
    if (taps) {
      taps.push(fn as HookFn);
    } else {
      this.#taps.set(name, [fn as HookFn]);
    }
  }

  /**
   * Thread `value` through the name's taps in order, awaiting each. Taps are HOST code
   * on the read path, so each is GUARDED: on throw, log and keep the prior value (treat
   * the tap as identity). No taps → returns the input unchanged.
   */
  async runWaterfall(
    name: WaterfallName,
    value: unknown,
    ctx: Record<string, unknown>,
    // `optional` (formatPublicUrls): no taps / every tap throws → `undefined`
    // instead of leaking the raw decision as a DTO. Other waterfalls stay `identity`.
    mode: 'identity' | 'optional' = 'identity',
  ): Promise<unknown> {
    const taps = this.#taps.get(name) ?? [];
    if (mode === 'optional' && taps.length === 0) {
      return undefined;
    }
    let succeeded = false;
    for (const fn of taps) {
      try {
        value = await fn(value, ctx);
        succeeded = true;
      } catch (e) {
        this.#logger.error(`resize waterfall ${name} tap failed (skipped)`, e);
      }
    }
    if (mode === 'optional' && !succeeded) {
      return undefined;
    }
    return value;
  }

  /**
   * Fire an observer. First a fire-and-forget mirror onto the event bus as
   * `resize:<name>` (its own try/catch) so ecosystem subscribers see it BEFORE the taps;
   * then await each registered tap sequentially, error-isolated (log + continue). Return
   * values are ignored.
   */
  async runObservers(name: ObserverName, ...args: unknown[]): Promise<void> {
    try {
      this.#events?.emit(`resize:${name}`, ...args);
    } catch (e) {
      this.#logger.error(`resize event ${name} listener failed`, e);
    }
    for (const fn of this.#taps.get(name) ?? []) {
      try {
        await fn(...args);
      } catch (e) {
        this.#logger.error(`resize hook ${name} failed`, e);
      }
    }
  }
}
