// MediaStore seam + the framework-backed default (05 · §10.6). A DEFAULTED strategy:
// active out of the box (registry pre-fills the slot), swappable via registerMediaStore
// for a host on another DB/ORM or a remote media service — so the module core is DB-free.
// No `app` parameter: reads the host media model through getApp() + getResizeConfig()
// (02 · §4). The read path never calls load(); resolve() receives `media` from the caller.
import { getApp } from './app.ts';
import { getResizeConfig } from './config/resize.ts';
import type { MediaLike, Preview } from './types.d.ts';

export interface MediaStore {
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

export const frameworkMediaStore: MediaStore = {
  async load(mediaId) {
    const app = getApp();
    const { mediaModelName } = getResizeConfig();
    const model = app.getModel(mediaModelName);
    // getModel returns false/undefined for a name no host model was registered under.
    // Tolerate it: log + no-op (null) rather than throwing on `.findById` of a non-model.
    if (!model) {
      app.logger.error(
        `resize mediaStore: no model registered as '${mediaModelName}' — cannot load media ${mediaId}`,
      );
      return null;
    }
    return model.findById(mediaId);
  },

  async appendPreviews(mediaId, previews, backfillDims) {
    const { mediaModelName } = getResizeConfig();
    // ONE atomic write: $push the previews, and (only when the worker backfilled the
    // original's display dims) $set them via dotted paths in the same update.
    const update: {
      $push: { previews: { $each: Preview[] } };
      $set?: { 'original.width': number; 'original.height': number };
    } = {
      $push: { previews: { $each: previews } },
    };
    if (backfillDims) {
      update.$set = {
        'original.width': backfillDims.width,
        'original.height': backfillDims.height,
      };
    }
    await getApp().getModel(mediaModelName).findByIdAndUpdate(mediaId, update);
  },
};
