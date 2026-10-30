// Media contract: the host's media documents. The worker loads one per task and records the
// previews it rendered on it; the store closes over its own client and receives no `app`. Extend
// this class (or pass any object of the same shape — the core never checks `instanceof`, so
// duplicate package copies still work).
import type { MediaLike, Preview } from '../types.d.ts';

/** What replacePreviews resolves with: the rows it stored and the rows it removed. */
export interface ReplacedPreviews {
  stored: Preview[];
  removed: Preview[];
}

/**
 * The host's media documents and their preview rows. Both writes, appendPreviews and
 * replacePreviews, keep one stored row per preview identity.
 */
export abstract class MediaStore {
  /** Load a media document; `null` (deleted media) makes its task a logged no-op. */
  abstract loadMedia(mediaId: string): Promise<MediaLike | null>;

  /**
   * Append generated previews, and save `backfillDims` on the original when it is given, whether or
   * not a preview is stored (also for `previews: []`): the freshness check needs the original's
   * dimensions, and a store that drops them makes every read of such a media queue a task that
   * downloads the original. The store keeps
   * one row per `identity`: a preview whose identity is already stored on the media is skipped, so
   * two workers that rendered the same variant leave one row. The core identifies a stored row by
   * its scope (`resizer` and `pipeline`, `default` when unset), size key, format and filters,
   * derived from the row's own fields; it never reads a stored `identity` string. So "a preview
   * whose identity is already stored" means a usable row with the same four. Resolve with the
   * previews that were stored (`[]` when none were, e.g. the media is gone). Of the previews left
   * out, the core counts one whose identity is already stored as covered, and any other as not
   * recorded. Resolving with nothing is never a way to say "all of them": the core rejects it with
   * RESIZE_MEDIA_APPEND_RESULT_INVALID.
   */
  abstract appendPreviews(
    mediaId: string,
    previews: Preview[],
    backfillDims?: { width: number; height: number },
  ): Promise<Preview[]>;

  /**
   * In one atomic step per media: remove every stored row whose `identity` is in `identities` or
   * is the identity of one of `rows`, then store `rows`. A row without a stored `identity` is never
   * removed. Of rows that share an identity only the first is stored; a row without an identity is
   * always stored. Resolves with the rows it stored and the rows it removed, as plain objects; a
   * media that is gone gives { stored: [], removed: [] }. A row the store cannot store rejects the
   * call before anything is written (MongoMediaStore: a value its schema cannot cast, with
   * Mongoose's ValidationError, which is not a ResizeError; `storageRef` and `filters` are stored
   * as given, cast or not). It takes no dimensions: a caller that must backfill them uses
   * appendPreviews(mediaId, [], dims), which writes them whether or not it stores a row. The rows
   * MongoMediaStore writes here carry no sub-document `_id` (appended rows do); the module reads
   * none.
   */
  abstract replacePreviews(
    mediaId: string,
    identities: string[],
    rows: Preview[],
  ): Promise<ReplacedPreviews>;

  /** Optional startup check: throw when the store cannot work (e.g. an unknown media model). */
  verify?(): void | Promise<void>;
}
