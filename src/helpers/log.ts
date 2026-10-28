// Logging on a path that must never throw (resolve, prewarm, the worker loop). The host's logger is
// host code and may throw too, so its failure falls back to the console instead of breaking the
// guarantee.
import type { ResizeLogger } from '../types.d.ts';

/**
 * Log `message` and `err` (when given) at `level` (default 'error'); a throwing logger falls back
 * to the console method of the same level.
 */
export function logNeverThrow(
  logger: ResizeLogger,
  message: string,
  err?: unknown,
  level: 'error' | 'warn' | 'info' = 'error',
): void {
  const rest = err === undefined ? [] : [err];
  try {
    logger[level](message, ...rest);
  } catch {
    console[level](message, ...rest);
  }
}
