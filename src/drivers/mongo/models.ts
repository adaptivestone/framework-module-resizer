// createResizeModels(): registers the queue's ResizeTask and ResizeLock models on a Mongoose
// connection, with the package's schemas and indexes. It builds the schemas with the connection's
// own Mongoose instance, so this driver never imports mongoose (an optional peer).
import type { Connection, Model } from 'mongoose';
import {
  resizeLockFields,
  resizeLockIndexes,
  resizeSchemaOptions,
  resizeTaskFields,
  resizeTaskIndexes,
} from './schemas.ts';

export interface CreateResizeModelsOptions {
  mediaModelName?: string; // populate ref of ResizeTask.fileId; default 'File'
  taskModelName?: string; // default 'ResizeTask'
  lockModelName?: string; // default 'ResizeLock'
}

export function createResizeModels(
  connection: Connection,
  opts: CreateResizeModelsOptions = {},
  // biome-ignore lint/suspicious/noExplicitAny: the documents are module-internal
): { ResizeTask: Model<any>; ResizeLock: Model<any> } {
  const { Schema } = connection.base;
  const taskName = opts.taskModelName ?? 'ResizeTask';
  const lockName = opts.lockModelName ?? 'ResizeLock';
  const define = (
    name: string,
    fields: object,
    indexes: typeof resizeTaskIndexes,
  ) => {
    const existing = connection.models[name];
    if (existing) {
      return existing;
    }
    // autoIndex off: the module never builds indexes at runtime; the host's migration does
    // (e.g. ResizeTask.createIndexes()).
    const schema = new Schema(fields, {
      ...resizeSchemaOptions,
      autoIndex: false,
    });
    for (const [keys, options] of indexes) {
      schema.index(keys, options);
    }
    return connection.model(name, schema);
  };
  return {
    ResizeTask: define(
      taskName,
      resizeTaskFields(opts.mediaModelName ?? 'File'),
      resizeTaskIndexes,
    ),
    ResizeLock: define(lockName, resizeLockFields, resizeLockIndexes),
  };
}
