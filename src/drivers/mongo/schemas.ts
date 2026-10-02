// The Mongo queue's schemas as plain data: field definitions and indexes for ResizeTask (the queue)
// and ResizeLock (its locks). The single source of truth for createResizeModels() and the
// framework's ResizeTaskModel. No imports: 'ObjectId' and 'Mixed' are mongoose's string aliases.

/** Schema options both models use (the framework BaseModel defaults). */
export const resizeSchemaOptions = {
  timestamps: true,
  minimize: false,
} as const;

/** ResizeTask fields. `mediaModelName` is the populate ref of `fileId`. */
export function resizeTaskFields(mediaModelName: string) {
  return {
    fileId: { type: 'ObjectId', ref: mediaModelName, required: true },
    // The registered pipeline the worker runs for this task.
    pipeline: { type: String, default: 'default' },
    // The Resizer that queued the task and the named queue it waits in.
    resizer: { type: String, default: 'default' },
    queue: { type: String, default: 'default' },
    // SHA-256 identity of the whole request (media + resizer + queue + pipeline + variants).
    // Optional, so rows written before deduplication stay valid.
    requestKey: { type: String },
    // The requested variants (MissingPreview shape); the worker computes the stored Preview rows.
    previews: [
      {
        sizeKey: { type: String, required: true },
        filters: { type: 'Mixed' },
        requestedWidth: { type: Number },
        requestedHeight: { type: Number },
        format: { type: String, required: true },
        fit: { type: Boolean },
      },
    ],
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'dead'],
      default: 'pending',
    },
    attempts: { type: Number, default: 0 },
    leasedBy: { type: String },
    leaseToken: { type: String }, // fencing token of the current lease
    leaseExpiresAt: { type: Date },
    completedAt: { type: Date },
    deadAt: { type: Date },
    error: { type: String },
  } as const;
}

type IndexSpec = readonly [Record<string, 1 | -1>, Record<string, unknown>?];

/** ResizeTask indexes. Create them through your migration process; the module never does. */
export const resizeTaskIndexes: readonly IndexSpec[] = [
  // Completed rows expire after 24 h.
  [
    { completedAt: 1 },
    {
      expireAfterSeconds: 86400,
      partialFilterExpression: { status: 'completed' },
    },
  ],
  // Dead rows are kept ~30 days for inspection and replay.
  [
    { deadAt: 1 },
    {
      expireAfterSeconds: 2592000,
      partialFilterExpression: { status: 'dead' },
    },
  ],
  // Lease hot path: a worker consumes one queue, oldest task first.
  [{ queue: 1, status: 1, createdAt: 1 }],
  // Reclaiming expired leases. The partial filter, not sparseness, scopes it.
  [
    { leaseExpiresAt: 1 },
    { partialFilterExpression: { status: 'processing' } },
  ],
  // Per-media task lookup, newest first.
  [{ fileId: 1, createdAt: -1 }],
  // Durable dedupe of identical active requests. Rows without requestKey are excluded, and
  // completed/dead rows never block a fresh request.
  [
    { fileId: 1, pipeline: 1, requestKey: 1 },
    {
      unique: true,
      partialFilterExpression: {
        status: { $in: ['pending', 'processing'] },
        requestKey: { $exists: true },
      },
    },
  ],
];

/** ResizeLock fields: the lock key is the document id. */
export const resizeLockFields = {
  _id: { type: String, required: true },
  expiredAt: { type: Date, required: true },
} as const;

/** ResizeLock indexes: MongoDB removes a lock once it expires. */
export const resizeLockIndexes: readonly IndexSpec[] = [
  [{ expiredAt: 1 }, { expireAfterSeconds: 0 }],
];
