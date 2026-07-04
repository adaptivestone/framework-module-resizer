// src/models/ResizeTask.ts — EJECTED full model (scaffolded with `--eject`, 08 · §12).
//
// ⚠️  This is a VENDORED COPY of the module's ResizeTaskModel schema + indexes, for hosts that
//     need custom fields/indexes. Unlike the thin `extends ResizeTaskModel` shim, this copy will
//     NOT receive module updates — if the package changes the base schema/indexes, you must port
//     the change here by hand. Prefer the shim (drop `--eject`) unless you truly need to diverge.
//
// The worker reads/writes the module-owned fields (previews, status, leaseToken, …) by their
// defined shape — reshape only fields YOU add, never the module-owned ones.
import type {
  GetModelTypeFromClass,
  TsTypeOverride,
} from '@adaptivestone/framework/modules/BaseModel.js';
import { BaseModel } from '@adaptivestone/framework/modules/BaseModel.js';
import type { Filters } from '@adaptivestone/framework-module-resize';

export default class ResizeTask extends BaseModel {
  // Overridable populate-ref target: `modelSchema` reads `this.fileRef`, so re-pointing fileId at
  // a differently-named media model is just `static fileRef = 'Media'` (defaults to 'File').
  static fileRef = 'File';

  static get modelSchema() {
    return {
      fileId: {
        type: 'ObjectId',
        // biome-ignore lint/complexity/noThisInStatic: polymorphic `this` re-points the ref when a subclass overrides `static fileRef`.
        ref: this.fileRef,
        required: true,
      },
      // Which registered pipeline the worker runs for this task.
      pipeline: { type: String, default: 'default' },
      // The REQUESTED variants to generate (NOT the full stored Preview — the worker computes
      // key/dims/contentType and $pushes those to the media doc).
      previews: [
        {
          sizeKey: { type: String, required: true },
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
      // 👉 Add your custom fields here, e.g.  myField: { type: String },
    } as const;
  }

  static initHooks(schema: Parameters<typeof BaseModel.initHooks>[0]) {
    // Evict completed rows after 24h (TTL, scoped to status:'completed').
    schema.index(
      { completedAt: 1 },
      {
        expireAfterSeconds: 86400,
        partialFilterExpression: { status: 'completed' },
      },
    );
    // Keep dead-letter rows ~30d for inspection/replay (edit expireAfterSeconds to taste).
    schema.index(
      { deadAt: 1 },
      {
        expireAfterSeconds: 2592000,
        partialFilterExpression: { status: 'dead' },
      },
    );
    // Lease hot path (+ dead-letter sweep).
    schema.index({ status: 1, createdAt: 1 });
    // Sweep/reclaim stuck leases. NOT sparse: the partial filter on status:'processing' scopes it.
    schema.index(
      { leaseExpiresAt: 1 },
      { partialFilterExpression: { status: 'processing' } },
    );
    // Per-media task lookup, newest first.
    schema.index({ fileId: 1, createdAt: -1 });
    // 👉 Add your custom indexes here.
  }
}

export type TResizeTask = GetModelTypeFromClass<typeof ResizeTask>;
