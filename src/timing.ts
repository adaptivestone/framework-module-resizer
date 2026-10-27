// Queue timing, the same for every TaskQueue backend: a queue's own timing keys over the defaults,
// validated once per queue instance. The worker loop (src/consumer.ts) and the dispatch path read
// it.
import { defaultQueueOptions } from './config/resize.ts';
import type { TaskQueue } from './contracts/taskQueue.ts';
import { ResizeConfigError } from './errors.ts';
import { validateQueueTiming } from './resizeConfig.ts';
import type { QueueTimingOptions } from './types.d.ts';

const TIMING_KEYS = [
  'leaseMs',
  'retryBackoffMs',
  'maxAttempts',
  'idlePollMs',
  'taskTimeoutMs',
] as const;

/**
 * Where each old lock TTL went: the Resizer's coordination. The framework adapter repeats it in its
 * own message for a config file.
 */
export const LOCK_TTL_MOVES =
  'lockTtlMs.failed → cooldownMs, lockTtlMs.dispatch → gateTtlMs; drop lockTtlMs.worker';

/** Complete queue timing: every key set. */
export type QueueTiming = QueueTimingOptions;

const timings = new WeakMap<object, QueueTiming>();

/**
 * Complete queue timing: the timing keys set in `own` over the defaults (other keys are ignored),
 * validated. Throws ResizeConfigError for invalid timing, and for `lockTtlMs`, which moved to the
 * Resizer's coordination: ignoring it would drop a host's cooldown without a word.
 */
export function fillTiming(
  own: Partial<QueueTimingOptions> | Record<string, unknown>,
): QueueTiming {
  if (Object.hasOwn(own, 'lockTtlMs')) {
    throw new ResizeConfigError(
      `resize queue options: \`lockTtlMs\` is no longer supported — pass coordination: { gateTtlMs, cooldownMs } to the Resizer (${LOCK_TTL_MOVES})`,
      { code: 'RESIZE_CONFIG_REMOVED_KEY' },
    );
  }
  const timing: Record<string, unknown> = { ...defaultQueueOptions };
  for (const key of TIMING_KEYS) {
    const value = (own as Record<string, unknown>)[key];
    if (value !== undefined) {
      timing[key] = value;
    }
  }
  validateQueueTiming(timing);
  return timing;
}

/**
 * A queue's timing: its getTiming() over the defaults, validated once per queue instance (a lazy
 * getTiming is read on first use). Throws ResizeConfigError for invalid timing.
 */
export function timingOf(tasks: TaskQueue): QueueTiming {
  const cached = timings.get(tasks);
  if (cached) {
    return cached;
  }
  const timing = fillTiming(tasks.getTiming?.() ?? {});
  timings.set(tasks, timing);
  return timing;
}
