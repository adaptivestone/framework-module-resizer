// The coordination policy of a Resizer with a task queue: how long the gate lock of a queued task
// lasts (`gateTtlMs`) and how long a dead-lettered task blocks new ones (`cooldownMs`). The Resizer
// owns it, and only the core validates it: the Resizer fills it in here when it sets up its task
// queue, against that queue's timing. Neither the framework adapter nor a driver checks it.
import { defaultCoordination } from './config/resize.ts';
import type { LockStore } from './contracts/locks.ts';
import { ResizeConfigError } from './errors.ts';
import type { QueueTiming } from './timing.ts';
import type { CoordinationOptions } from './types.d.ts';

/** The coordination policy with every value set. */
export type Coordination = Required<CoordinationOptions>;

/** What the worker needs for each task of a Resizer: its dead-letter cooldown and its lock store. */
export interface TaskCoordination {
  cooldownMs: number;
  locks?: LockStore;
}

const KEYS = ['gateTtlMs', 'cooldownMs'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

// A value as a message shows it: strings quoted, so '600000' is told apart from 600000.
const shown = (value: unknown): string =>
  typeof value === 'string' ? JSON.stringify(value) : String(value);

const invalid = (message: string): never => {
  throw new ResizeConfigError(message, {
    code: 'RESIZE_CONFIG_COORDINATION_INVALID',
  });
};

/**
 * Complete coordination: the values set in `own` over the defaults (undefined: all defaults),
 * validated against the task queue's timing. Throws ResizeConfigError: a section that is not an
 * object, or a value that is not a positive safe integer (ms), names the key and the value; a
 * gateTtlMs below the lease names both values.
 */
export function fillCoordination(
  own: unknown,
  timing: QueueTiming,
): Coordination {
  const section = own === undefined ? {} : own;
  if (!isRecord(section)) {
    return invalid(
      `resize coordination must be an object with gateTtlMs and cooldownMs (ms), got ${shown(section)}`,
    );
  }
  const coordination: Coordination = { ...defaultCoordination };
  for (const key of KEYS) {
    const value = section[key];
    if (value === undefined) {
      continue;
    }
    if (!isPositiveSafeInteger(value)) {
      return invalid(
        `resize coordination: ${key} must be a positive safe integer (ms), got ${shown(value)}`,
      );
    }
    coordination[key] = value;
  }
  // A gate lock must outlive the lease it guards: a shorter one could expire while a worker still
  // holds the task, and the next read would queue a second task for the same media and pipeline.
  if (coordination.gateTtlMs < timing.leaseMs) {
    throw new ResizeConfigError(
      `resize coordination: gateTtlMs (${coordination.gateTtlMs}) must be ≥ the task queue's leaseMs (${timing.leaseMs}) — a gate lock must outlive the lease it guards`,
      { code: 'RESIZE_CONFIG_GATE_TTL_BELOW_LEASE' },
    );
  }
  return coordination;
}
