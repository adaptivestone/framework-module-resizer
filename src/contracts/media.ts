// Media contract: the host's media documents. The worker loads one per task and records the
// previews it rendered on it; the store closes over its own client and receives no `app`. Extend
// this class (or pass any object of the same shape — the core never checks `instanceof`, so
// duplicate package copies still work).
import type { MediaLike, Preview } from '../types.d.ts';

export abstract class MediaStore {
  /** Load a media document; `null` (deleted media) makes its task a logged no-op. */
  abstract loadMedia(mediaId: string): Promise<MediaLike | null>;

  /**
   * Append generated previews, and optionally backfill the original's dimensions. The store keeps
   * one row per `identity`: a preview whose identity is already stored on the media is skipped, so
   * two workers that rendered the same variant leave one row. Resolve with the previews that were
   * stored (`[]` when none were, e.g. the media is gone): the core treats every preview left out as
   * not recorded, so resolving with nothing is never a way to say "all of them".
   */
  abstract appendPreviews(
    mediaId: string,
    previews: Preview[],
    backfillDims?: { width: number; height: number },
  ): Promise<Preview[]>;

  /** Optional startup check: throw when the store cannot work (e.g. an unknown media model). */
  verify?(): void | Promise<void>;
}
