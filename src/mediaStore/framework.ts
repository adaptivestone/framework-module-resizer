// FrameworkMediaStore — the framework-backed DEFAULT media store (05 · §10.6). A DEFAULTED
// strategy: active out of the box (the core constructs it internally for the ResizerOptions
// default), swappable via the `mediaStore` constructor option for a host on another DB/ORM or a
// remote media service — so the module core stays DB-free. Subpath entry
// `…/mediaStore/framework.js`: a host wrapping this default imports it from there (uniform rule
// 02 · §6); no optional deps, so importing is always safe. No `app` parameter: reads the host
// media model through getApp() + getResizeConfig() (02 · §4). The read path never calls load();
// resolve() receives `media` from the caller.
import { getApp } from '../app.ts';
import { ResizeConfigError } from '../errors.ts';
import { getResizeConfig } from '../resizeConfig.ts';
import type { MediaLike, Preview } from '../types.d.ts';
import type { MediaStore } from './AbstractMediaStore.ts';

export class FrameworkMediaStore implements MediaStore {
  /**
   * The host media model named by config.mediaModelName. An unregistered name is a config
   * error, never "media missing": the worker completes tasks for deleted media as no-ops, so
   * returning null here would silently drop every task.
   */
  getMediaModel() {
    const { mediaModelName } = getResizeConfig();
    const model = getApp().getModel(mediaModelName);
    if (!model) {
      throw new ResizeConfigError(
        `resize config: mediaModelName '${mediaModelName}' is not a registered model — set it in the host src/config/resize.ts`,
        { code: 'RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN' },
      );
    }
    return model;
  }

  /** Worker startup check: BaseCli has loaded the models by now (ResizeWorker.isShouldInitModels). */
  verify(): void {
    this.getMediaModel();
  }

  async load(mediaId: string): Promise<MediaLike | null> {
    return this.getMediaModel().findById(mediaId);
  }

  async appendPreviews(
    mediaId: string,
    previews: Preview[],
    backfillDims?: { width: number; height: number },
  ): Promise<void> {
    const model = this.getMediaModel();
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
    await model.findByIdAndUpdate(mediaId, update);
  }
}
