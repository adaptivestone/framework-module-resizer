// Queue timing, the same for every TaskQueue backend: a queue's own timing keys over the defaults,
// validated once per queue instance. The worker loop (src/consumer.ts) and the dispatch path read
// it.
import { defaultQueueOptions } from './config/resize.ts';
import type { TaskQueue } from './contracts/taskQueue.ts';
import { ResizeConfigError } from './errors.ts';
import { validateQueueTiming } from './resizeConfig.ts';
import type { QueueTimingOptions } from './types.d.ts';

const TIMING_KEYS = [
  'lockTtlMs',
  'leaseMs',
  'retryBackoffMs',
  'maxAttempts',
  'idlePollMs',
  'taskTimeoutMs',
] as const;

/** Complete queue timing: every key set, the optional lock TTLs included. */
export type QueueTiming = QueueTimingOptions & {
  lockTtlMs: Required<QueueTimingOptions['lockTtlMs']>;
};

const timings = new WeakMap<object, QueueTiming>();

/**
 * Check the optional dead-letter cooldown `lockTtlMs.failed` (ms) when it is set. Throws
 * ResizeConfigError.
 */
function validateFailedLockTtl(failed: unknown): void {
  if (
    failed !== undefined &&
    !(typeof failed === 'number' && Number.isSafeInteger(failed) && failed > 0)
  ) {
    throw new ResizeConfigError(
      'resize queue options: lockTtlMs.failed must be a positive safe integer (ms)',
      { code: 'RESIZE_CONFIG_QUEUE_LOCK_TTL_INVALID' },
    );
  }
}

/**
 * Complete queue timing: the timing keys set in `own` over the defaults (other keys are ignored),
 * validated. A `lockTtlMs` without `failed` gets the default cooldown. Throws ResizeConfigError for
 * invalid timing.
 */
export function fillTiming(
  own: Partial<QueueTimingOptions> | Record<string, unknown>,
): QueueTiming {
  const timing: Record<string, unknown> = { ...defaultQueueOptions };
  for (const key of TIMING_KEYS) {
    const value = (own as Record<string, unknown>)[key];
    if (value !== undefined) {
      timing[key] = value;
    }
  }
  const lockTtlMs = timing.lockTtlMs;
  if (typeof lockTtlMs === 'object' && lockTtlMs !== null) {
    const failed = (lockTtlMs as { failed?: unknown }).failed;
    validateFailedLockTtl(failed);
    timing.lockTtlMs = {
      ...lockTtlMs,
      failed: failed ?? defaultQueueOptions.lockTtlMs.failed,
    };
  }
  validateQueueTiming(timing);
  return timing as unknown as QueueTiming;
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
