// The package-owned `ResizeTask` model for framework apps. The host's scaffolded
// `src/models/ResizeTask.ts` is a one-line `class ResizeTask extends ResizeTaskModel {}` shim, so the
// framework's filename-keyed loader registers `getModel('ResizeTask')`. The fields and indexes come
// from drivers/mongo/schemas.ts, the same source createResizeModels() uses.
//
// One of the two files that import `@adaptivestone/framework` (the other is src/framework/app.ts);
// exported only from `…/framework.js`. It must stay a literal `class … extends BaseModel`: the
// loader checks `prototype instanceof BaseModel`, and `npm run gen` walks the `extends` chain.

import type {
  GetModelTypeFromClass,
  TsTypeOverride,
} from '@adaptivestone/framework/modules/BaseModel.js';
import { BaseModel } from '@adaptivestone/framework/modules/BaseModel.js';
import {
  resizeTaskFields,
  resizeTaskIndexes,
} from '../drivers/mongo/schemas.ts';
import type { Filters } from '../types.d.ts';

export default class ResizeTaskModel extends BaseModel {
  // Populate ref of `fileId`. A host shim re-points it: `static fileRef = 'Media'`.
  static fileRef = 'File';

  static get modelSchema() {
    // biome-ignore lint/complexity/noThisInStatic: a host shim's `static fileRef` override must apply
    const fields = resizeTaskFields(this.fileRef);
    const [variant] = fields.previews;
    return {
      ...fields,
      // Same runtime field; TsTypeOverride only tightens the inferred type of 'Mixed' to Filters.
      previews: [
        {
          ...variant,
          filters: variant.filters as {
            type: 'Mixed';
          } & TsTypeOverride<Filters>,
        },
      ],
    } as const;
  }

  static initHooks(schema: Parameters<typeof BaseModel.initHooks>[0]) {
    for (const [keys, options] of resizeTaskIndexes) {
      schema.index(keys, options);
    }
  }
}

// = GetModelTypeFromClass<typeof ResizeTaskModel> (02 · §6): the fully-typed model
// (inherited modelSchema statics included; `filters` typed as Filters via TsTypeOverride).
export type TResizeTask = GetModelTypeFromClass<typeof ResizeTaskModel>;
