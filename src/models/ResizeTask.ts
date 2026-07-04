// The package-owned `ResizeTask` model class (spec/08 §12). The host's scaffolded
// `src/models/ResizeTask.ts` is a one-line `class ResizeTask extends ResizeTaskModel {}`
// shim — the MODULE owns the schema + indexes; the shim only names the file so the
// framework's filename-keyed loader registers `getModel('ResizeTask')` (08 · §12).
//
// This is ONE of exactly TWO files allowed to import `@adaptivestone/framework` (the
// other is src/app.ts) — 01 · §2.3/§16. `mongoose` is imported NOWHERE in src/: schema
// field types use mongoose's STRING aliases ('ObjectId','Mixed') or global constructors
// (String/Number/Boolean/Date), and the `initHooks` schema param is typed via
// `Parameters<typeof BaseModel.initHooks>[0]` — reusing the framework's own already-
// imported mongoose `Schema` type instead of importing mongoose here.
//
// MUST stay a LITERAL `export default class … extends BaseModel` (no mixin/factory):
// the runtime loader checks `prototype instanceof BaseModel` and `npm run gen`'s AST
// codegen walks the literal `extends` chain to type `getModel('ResizeTask')` (01 · §14;
// verified 2026-07-04 against framework v5 source).

import type {
  GetModelTypeFromClass,
  TsTypeOverride,
} from '@adaptivestone/framework/modules/BaseModel.js';
import { BaseModel } from '@adaptivestone/framework/modules/BaseModel.js';
import type { Filters } from '../types.d.ts';

export default class ResizeTaskModel extends BaseModel {
  // Overridable populate-ref target (deep-review punch-list #7). `modelSchema` reads
  // `this.fileRef`, so a host shim `class ResizeTask extends ResizeTaskModel { static
  // fileRef = 'Media' }` actually re-points `fileId`'s ref. Defaults to the framework
  // `File` model name; overriding it never changes the document TYPE (a runtime hint).
  static fileRef = 'File';

  static get modelSchema() {
    return {
      // ref is built from `this.fileRef` so the thin-shim override applies. The 'ObjectId'
      // STRING alias avoids a mongoose import; GetModelTypeFromClass still infers this as
      // `Types.ObjectId` (mongoose's ObjectIdSchemaDefinition includes the string form).
      fileId: {
        type: 'ObjectId',
        // biome-ignore lint/complexity/noThisInStatic: polymorphic `this` is REQUIRED here — a host shim's `static fileRef = 'Media'` override must re-point the ref, which a hardcoded class name would defeat (deep-review #7).
        ref: this.fileRef,
        required: true,
      },
      // Which registered pipeline the worker runs for this task.
      pipeline: { type: String, default: 'default' },
      // The REQUESTED variants to generate (the MissingPreview shape — NOT the full stored
      // Preview; the worker computes key/dims/contentType and $pushes those to the media doc).
      previews: [
        {
          sizeKey: { type: String, required: true },
          // Mixed via the 'Mixed' string alias (no mongoose import). Bare 'Mixed' infers as
          // `unknown`, so it is tightened to the module's `Filters` with the framework's
          // TsTypeOverride marker — a compile-time-only `as` (erasable); the RUNTIME field
          // is exactly `{ type: 'Mixed' }`.
          filters: { type: 'Mixed' } as {
            type: 'Mixed';
          } & TsTypeOverride<Filters>,
          requestedWidth: { type: Number },
          requestedHeight: { type: Number },
          format: { type: String, enum: ['jpeg', 'webp', 'avif'] },
          fit: { type: Boolean },
        },
      ],
      status: {
        type: String,
        enum: ['pending', 'processing', 'completed', 'dead'],
        default: 'pending',
      },
      // Capped by config.queue.maxAttempts, then dead-lettered (05 · §10.2).
      attempts: { type: Number, default: 0 },
      leasedBy: { type: String },
      leaseToken: { type: String }, // fencing token (05 · §10.2)
      leaseExpiresAt: { type: Date },
      completedAt: { type: Date },
      deadAt: { type: Date },
      error: { type: String },
    } as const;
  }

  // Exactly the five indexes from spec/08 §12. The schema param reuses the framework's
  // mongoose `Schema` type (via Parameters<…>) so no mongoose import is needed here.
  static initHooks(schema: Parameters<typeof BaseModel.initHooks>[0]) {
    // Evict completed rows after 24h (TTL, scoped to status:'completed').
    schema.index(
      { completedAt: 1 },
      {
        expireAfterSeconds: 86400,
        partialFilterExpression: { status: 'completed' },
      },
    );
    // Keep dead-letter rows ~30d for inspection/replay (the host owns the retention —
    // edit expireAfterSeconds to taste).
    schema.index(
      { deadAt: 1 },
      {
        expireAfterSeconds: 2592000,
        partialFilterExpression: { status: 'dead' },
      },
    );
    // Lease hot path (+ dead-letter sweep).
    schema.index({ status: 1, createdAt: 1 });
    // Sweep/reclaim stuck leases. NOT sparse: a sparse index would not exclude a null
    // leaseExpiresAt — the partial filter on status:'processing' is what scopes it.
    schema.index(
      { leaseExpiresAt: 1 },
      { partialFilterExpression: { status: 'processing' } },
    );
    // Per-media task lookup, newest first.
    schema.index({ fileId: 1, createdAt: -1 });
  }
}

// = GetModelTypeFromClass<typeof ResizeTaskModel> (02 · §6): the fully-typed model
// (inherited modelSchema statics included; `filters` typed as Filters via TsTypeOverride).
export type TResizeTask = GetModelTypeFromClass<typeof ResizeTaskModel>;
