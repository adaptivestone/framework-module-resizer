// Database contract: the records the module reads and writes — media documents (load, append
// previews) and short-lived locks — plus, optionally, the task queue when the same database holds
// it. Extend this class, or pass any object of the same shape (the core never checks `instanceof`).
import type { MediaLike, Preview } from '../types.d.ts';
import type { TaskQueue } from './taskQueue.ts';

export abstract class ResizeDatabase {
  /** Load a media document; `null` (deleted media) makes its task a logged no-op. */
  abstract loadMedia(mediaId: string): Promise<MediaLike | null>;

  /** Append generated previews, and optionally backfill the original's dimensions, atomically. */
  abstract appendPreviews(
    mediaId: string,
    previews: Preview[],
    backfillDims?: { width: number; height: number },
  ): Promise<void>;

  /**
   * Take the lock `key` for `ttlMs`: `true` if taken, `false` if someone holds it. Locks only
   * prevent duplicate work (two requests or workers generating the same variant at once).
   */
  abstract acquireLock(key: string, ttlMs: number): Promise<boolean>;

  /** Release `key`. Releasing an expired or missing lock is not an error. */
  abstract releaseLock(key: string): Promise<void>;

  /** Optional: the task queue kept in this same database (pass it as the Resizer's `tasks`). */
  declare readonly tasks?: TaskQueue;

  /** Optional startup check: throw when the database cannot work (e.g. an unknown media model). */
  verify?(): void | Promise<void>;
}
