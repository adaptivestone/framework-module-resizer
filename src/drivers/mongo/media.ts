// MongoMediaStore: the host's media documents in MongoDB, through the host's media model (its
// schema spreads resizeMediaSchemaFragment). Each preview row is one conditional write, so of two
// workers that rendered the same preview identity only one stores its row.
import { MediaStore } from '../../contracts/media.ts';
import { ResizeSetupError } from '../../errors.ts';
import type { MediaLike, Preview } from '../../types.d.ts';
import { resolveModelOption } from './modelOption.ts';

/**
 * The media model methods the store calls (any Mongoose model has them). Writes go through
 * `findOneAndUpdate`, so the host's findOneAndUpdate middleware sees them; it resolves with the
 * matched document (only its `_id` is requested) or null. When the model also exposes its
 * `schema`, verify() checks it keeps the preview fields the store relies on.
 */
export interface MongoMediaModel {
  modelName?: string;
  findById(id: string): PromiseLike<unknown>;
  findOneAndUpdate(
    filter: object,
    update: object,
    options: { projection: { _id: 1 } },
  ): PromiseLike<unknown>;
}

export interface MongoMediaStoreOptions {
  // The host media model, or a getter called on each use (for a model registered later).
  model?: MongoMediaModel;
  getModel?: () => MongoMediaModel | null | undefined;
}

// Each write asks for the matched document's id only, not the whole media document.
const ID_ONLY = { projection: { _id: 1 as const } };

// The part of a Mongoose schema verify() reads (types only: no mongoose import).
interface SchemaLike {
  path(path: string): unknown;
  options: { strict?: unknown };
}

// The preview row paths verify() requires, each with what is lost when Mongoose strips it.
const REQUIRED_ROW_PATHS: ReadonlyArray<[path: string, lost: string]> = [
  ['identity', 'a preview rendered twice would be stored twice'],
  ['origin', 'a preview would not record the original it was made from'],
  [
    'encodeSig',
    'a preview would not record the encode settings it was made with',
  ],
];

export class MongoMediaStore extends MediaStore {
  readonly #model: () => MongoMediaModel;

  constructor(opts: MongoMediaStoreOptions) {
    super();
    // A model that does not resolve (e.g. a misspelled name) is a setup error, never "media
    // missing": the worker would otherwise retry every task until it is dead.
    this.#model = resolveModelOption(opts, {
      driver: 'MongoMediaStore',
      missing:
        'resize: the media model does not resolve — check the model name',
    });
  }

  protected mediaModel(): MongoMediaModel {
    return this.#model();
  }

  /**
   * Startup check: the media model must resolve, and its preview rows must keep `identity`,
   * `origin` and `encodeSig`. Only rows declared as sub-documents with a strict shape lose them
   * (Mongoose strict mode strips an undeclared field from every row: without `identity` every
   * worker that renders a variant would add its own row, and without the signatures no row could
   * say what it was made from); a mixed or plain array, or rows with `strict: false`, keep any
   * field. `bytes` and `createdAt` are informational and not checked.
   */
  verify(): void {
    const model = this.mediaModel();
    const schema = (model as { schema?: Partial<SchemaLike> }).schema;
    if (typeof schema?.path !== 'function') {
      return;
    }
    const previews = schema.path('previews') as
      | { instance?: string; schema?: Partial<SchemaLike> }
      | undefined;
    const rows = previews?.instance === 'Array' ? previews.schema : undefined;
    if (typeof rows?.path !== 'function' || rows.options?.strict === false) {
      return;
    }
    const missing = REQUIRED_ROW_PATHS.filter(([path]) => !rows.path?.(path));
    if (missing.length > 0) {
      const fields = missing.map(([path]) => `previews.${path}`);
      const named =
        fields.length > 1
          ? `${fields.slice(0, -1).join(', ')} and ${fields.at(-1)} fields`
          : `${fields[0]} field`;
      const lost = missing.map(([, why]) => why).join('; ');
      throw new ResizeSetupError(
        `resize: the media model ${model.modelName ? `'${model.modelName}' ` : ''}has no ${named}, so Mongoose would drop ${missing.length > 1 ? 'them' : 'it'} and ${lost} — spread the current resizeMediaSchemaFragment into the media model's schema`,
        { code: 'RESIZE_MONGO_MEDIA_MODEL_OUTDATED' },
      );
    }
  }

  async loadMedia(mediaId: string): Promise<MediaLike | null> {
    return (await this.mediaModel().findById(mediaId)) as MediaLike | null;
  }

  async appendPreviews(
    mediaId: string,
    previews: Preview[],
    backfillDims?: { width: number; height: number },
  ): Promise<Preview[]> {
    const model = this.mediaModel();
    // When the worker measured the original, set its dimensions first: a reader that sees the
    // previews then sees the dimensions too. Applied whether or not any preview is stored.
    if (backfillDims) {
      await model.findOneAndUpdate(
        { _id: mediaId },
        {
          $set: {
            'original.width': backfillDims.width,
            'original.height': backfillDims.height,
          },
        },
        ID_ONLY,
      );
    }
    // One conditional write per preview: the filter and the push are atomic on the document, so of
    // two workers that rendered the same identity only one stores its row (the other matches
    // nothing: null). A preview without an identity is always stored, and a row stored before rows
    // carried one never blocks a new row. Missing media matches nothing: a silent no-op.
    const stored: Preview[] = [];
    for (const preview of previews) {
      const filter =
        preview.identity === undefined
          ? { _id: mediaId }
          : { _id: mediaId, 'previews.identity': { $ne: preview.identity } };
      const matched = await model.findOneAndUpdate(
        filter,
        { $push: { previews: preview } },
        ID_ONLY,
      );
      if (matched) {
        stored.push(preview);
      }
    }
    return stored;
  }
}
