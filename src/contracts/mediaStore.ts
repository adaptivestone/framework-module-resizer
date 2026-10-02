// Media store contract. The worker loads media documents and appends generated previews through
// it; a driver closes over its own database and receives no `app`. Extend this class (or pass any
// object of the same shape).
import type { MediaLike, Preview } from '../types.d.ts';

export abstract class MediaStore {
  /**
   * Optional startup check, awaited once before the worker leases any task. Throw when the store
   * cannot work (e.g. an unknown media model), so a misconfiguration never drops tasks.
   */
  verify?(): void | Promise<void>;

  /** Load a media document. `null` (deleted media) makes the task a logged no-op. */
  abstract load(mediaId: string): Promise<MediaLike | null>;

  /** Append generated previews, and optionally backfill the original's dimensions, atomically. */
  abstract appendPreviews(
    mediaId: string,
    previews: Preview[],
    backfillDims?: { width: number; height: number },
  ): Promise<void>;
}
