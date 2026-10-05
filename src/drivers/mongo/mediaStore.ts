// MongoMediaStore: the media store over a Mongoose model whose schema spreads
// resizeMediaSchemaFragment. Pass the model, or `getModel` when it is registered later (called on
// every use). The framework's FrameworkMediaStore is this class with the model taken from the app.
import { MediaStore } from '../../contracts/mediaStore.ts';
import { ResizeSetupError } from '../../errors.ts';
import type { MediaLike, Preview } from '../../types.d.ts';

/** The two model methods the store calls (any Mongoose model has them). */
export interface MongoMediaModel {
  findById(id: string): PromiseLike<unknown>;
  findByIdAndUpdate(id: string, update: object): PromiseLike<unknown>;
}

export interface MongoMediaStoreOptions {
  model?: MongoMediaModel;
  getModel?: () => MongoMediaModel;
}

export class MongoMediaStore extends MediaStore {
  readonly #getModel: () => MongoMediaModel;

  constructor(opts: MongoMediaStoreOptions) {
    super();
    if (!opts || (opts.model === undefined) === (opts.getModel === undefined)) {
      throw new ResizeSetupError(
        'resize: MongoMediaStore needs exactly one of `model` or `getModel`',
        { code: 'RESIZE_MONGO_MODEL_REQUIRED' },
      );
    }
    const { model, getModel } = opts;
    this.#getModel = getModel ?? (() => model as MongoMediaModel);
  }

  /**
   * The media model. A getter that resolves to nothing (e.g. a misspelled model name) is a setup
   * error, never "media missing": the worker would otherwise retry every task until it is dead.
   */
  protected getModel(): MongoMediaModel {
    const model = this.#getModel();
    if (!model) {
      throw new ResizeSetupError(
        'resize: MongoMediaStore getModel() returned no model — check the model name',
        { code: 'RESIZE_MONGO_MODEL_MISSING' },
      );
    }
    return model;
  }

  /** Worker startup check: the model must resolve. */
  verify(): void {
    this.getModel();
  }

  async load(mediaId: string): Promise<MediaLike | null> {
    return (await this.getModel().findById(mediaId)) as MediaLike | null;
  }

  async appendPreviews(
    mediaId: string,
    previews: Preview[],
    backfillDims?: { width: number; height: number },
  ): Promise<void> {
    // One atomic write: push the previews and, when the worker measured the original, set its
    // dimensions in the same update.
    const update: {
      $push: { previews: { $each: Preview[] } };
      $set?: { 'original.width': number; 'original.height': number };
    } = { $push: { previews: { $each: previews } } };
    if (backfillDims) {
      update.$set = {
        'original.width': backfillDims.width,
        'original.height': backfillDims.height,
      };
    }
    await this.getModel().findByIdAndUpdate(mediaId, update);
  }
}
