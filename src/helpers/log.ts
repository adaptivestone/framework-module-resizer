// Logging on a path that must never throw (resolve, prewarm). The host's logger is host code and
// may throw too, so its failure falls back to the console instead of breaking the guarantee.
import type { ResizeLogger } from '../types.d.ts';

/** Log `message` and `err` as an error; a throwing logger falls back to console.error. */
export function logNeverThrow(
  logger: ResizeLogger,
  message: string,
  err: unknown,
): void {
  try {
    logger.error(message, err);
  } catch {
    console.error(message, err);
  }
}
