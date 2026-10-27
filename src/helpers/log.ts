// Logging on a path that must never throw (resolve, prewarm, the worker's choice of which tasks it
// runs). The host's logger is host code and may throw too, so its failure falls back to the
// console instead of breaking the guarantee.
import type { ResizeLogger } from '../types.d.ts';

/**
 * Log `message` and `err` (when given) as an error; a throwing logger falls back to
 * console.error.
 */
export function logNeverThrow(
  logger: ResizeLogger,
  message: string,
  err?: unknown,
): void {
  const rest = err === undefined ? [] : [err];
  try {
    logger.error(message, ...rest);
  } catch {
    console.error(message, ...rest);
  }
}
