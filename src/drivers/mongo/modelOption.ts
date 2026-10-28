// The `{ model | getModel }` option of the Mongo drivers: a model, or a getter called on each use
// (for a model registered later). Exactly one of the two is required.
import { ResizeSetupError } from '../../errors.ts';

export interface ModelOption<T> {
  model?: T;
  getModel?: () => T | null | undefined;
}

/**
 * The getter for the model in `opts`, which may yield nothing. Throws RESIZE_MONGO_MODEL_REQUIRED
 * unless `opts` holds exactly one of `model` or `getModel`; `driver` names the class in that
 * message.
 */
export function modelGetter<T>(
  opts: ModelOption<T> | undefined,
  driver: string,
): () => T | null | undefined {
  if (!opts || (opts.model === undefined) === (opts.getModel === undefined)) {
    throw new ResizeSetupError(
      `resize: ${driver} needs exactly one of \`model\` or \`getModel\``,
      { code: 'RESIZE_MONGO_MODEL_REQUIRED' },
    );
  }
  const { model, getModel } = opts;
  return getModel ?? (() => model);
}

/**
 * Like modelGetter, but the getter returns a model or throws RESIZE_MONGO_MODEL_MISSING with the
 * message `missing` (a model that does not resolve is a setup error, never missing data).
 */
export function resolveModelOption<T>(
  opts: ModelOption<T> | undefined,
  { driver, missing }: { driver: string; missing: string },
): () => T {
  const get = modelGetter(opts, driver);
  return () => {
    const model = get();
    if (!model) {
      throw new ResizeSetupError(missing, {
        code: 'RESIZE_MONGO_MODEL_MISSING',
      });
    }
    return model;
  };
}
