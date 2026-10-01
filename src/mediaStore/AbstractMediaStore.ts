// MediaStore contract (05 · §10.6) — NO `app` parameter: the framework driver reaches the host
// media model through the framework adapter, custom ones close over their own DB/ORM
// or a remote media service (so the module core stays DB-free). This is an INTERFACE, not an
// abstract class: drivers are plain object literals by design. It lives in its own file so a host
// wrapping the framework driver imports it WITHOUT depending on resizer.ts; it is re-exported from
// resizer.ts so every existing import site keeps working unchanged.
import type { MediaLike, Preview } from '../types.d.ts';

export interface MediaStore {
  // Optional startup check. The worker awaits it once before leasing any task; throw when the
  // store cannot work (e.g. an unknown media model) so a misconfiguration never drops tasks.
  verify?(): void | Promise<void>;

  // Load the media doc for the WORKER. null/undefined → the task is a logged no-op (07 step 1).
  load(mediaId: string): Promise<MediaLike | null>;

  // The worker's single write: append generated previews (+ optionally backfill the
  // original's display dims) atomically.
  appendPreviews(
    mediaId: string,
    previews: Preview[],
    backfillDims?: { width: number; height: number },
  ): Promise<void>;
}
