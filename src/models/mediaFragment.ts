// Optional `as const` schema fragment the host SPREADS into its media (`File`/`Media`)
// model's `modelSchema` (spec/08 §12 closing note). It is the single source of truth for
// the `original` + full `previews[]` shapes (src/types.d.ts Original/Preview), so a
// hand-written host schema can't silently DROP a field the worker `$push`es
// (fit / actualWidth / filters / …) on write.
//
// PLAIN POJO — NO imports at all (especially NO `mongoose` and NO
// `@adaptivestone/framework`, keeping 01 · §15/§16): only global constructors
// (String/Number/Boolean) and the 'Mixed' string alias. Where Mongoose infers loosely
// (Mixed / subdoc arrays) the HOST layers the framework's TsTypeOverride<Original> /
// TsTypeOverride<Preview[]> for exact field types — see the usage note below.
//
// Opt-in, scaffolded as a commented example: many hosts have a pre-existing media model
// with a legacy preview shape + migration that a forced fragment would collide with.
//
// Usage (exactly as spec/08 §12):
//   import { resizeMediaSchemaFragment } from '@adaptivestone/framework-module-resize';
//   class File extends BaseModel {
//     static get modelSchema() {
//       return { ...existingFields, ...resizeMediaSchemaFragment } as const;
//     }
//   }
export const resizeMediaSchemaFragment = {
  // The stored original (Original): `key` (+ optional S3-only `bucket`, StorageRef) plus
  // metadata. width/height are captured at upload and backfilled by the worker if missing.
  original: {
    key: { type: String },
    bucket: { type: String }, // omitted by non-S3 drivers; present for S3
    format: { type: String },
    size: { type: Number },
    contentType: { type: String },
    width: { type: Number },
    height: { type: Number },
  },
  // A generated variant (the full Preview): the worker `$push`es one of these per
  // (sizeKey, format, filters) identity.
  previews: [
    {
      key: { type: String },
      bucket: { type: String }, // omitted by non-S3 drivers; present for S3
      sizeKey: { type: String },
      // Filters bag (Mixed). 'Mixed' string alias keeps this import-free; the host
      // tightens the whole array with TsTypeOverride<Preview[]> for exact field types.
      filters: { type: 'Mixed' },
      requestedWidth: { type: Number },
      requestedHeight: { type: Number },
      actualWidth: { type: Number },
      actualHeight: { type: Number },
      format: { type: String, enum: ['jpeg', 'webp', 'avif'] },
      contentType: { type: String },
      fit: { type: Boolean },
    },
  ],
} as const;
