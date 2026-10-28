// Queue timing, the same for every TaskQueue backend: a queue name's own timing keys over the
// defaults, validated once per task queue and name. The worker loop (src/consumer.ts) and the
// dispatch path read it.
import { defaultQueueOptions } from './config/resize.ts';
import type { TaskQueue } from './contracts/taskQueue.ts';
import { ResizeConfigError, ResizeError } from './errors.ts';
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

// The valid timing of each name a task queue was asked for.
const timings = new WeakMap<TaskQueue, Map<string, QueueTiming>>();

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
 * The timing of the queue name `queue` on `tasks`: its getTiming(queue) over the defaults,
 * validated once per task queue and name (a lazy getTiming is read on the name's first use).
 * Throws ResizeConfigError for invalid timing, naming the queue; an invalid timing is not kept, so
 * the next call reads it again.
 */
export function timingOf(tasks: TaskQueue, queue: string): QueueTiming {
  let byName = timings.get(tasks);
  const cached = byName?.get(queue);
  if (cached) {
    return cached;
  }
  const timing = fillNamedTiming(tasks.getTiming?.(queue) ?? {}, queue);
  if (!byName) {
    byName = new Map();
    timings.set(tasks, byName);
  }
  byName.set(queue, timing);
  return timing;
}

/** fillTiming, with the queue name added to the message of a timing it rejects. */
function fillNamedTiming(
  own: Partial<QueueTimingOptions>,
  queue: string,
): QueueTiming {
  try {
    return fillTiming(own);
  } catch (err) {
    if (ResizeError.isResizeError(err)) {
      throw new ResizeConfigError(`${err.message} (queue '${queue}')`, {
        code: err.code,
        retryable: err.retryable,
        cause: err,
      });
    }
    throw err;
  }
}
