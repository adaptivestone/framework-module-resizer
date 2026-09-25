# Host adoption required for nested storage refs

This package changes the persisted resize fields from flat `key`/`bucket` fields to
`original.storageRef` and `previews[].storageRef`. It has no reader or migration for
old resize records. Updating this package alone does not make an existing host ready
for rollout: the API and worker must use the same package version and media schema.

Known `insailing-backend` work (outside this package patch):

- `src/helpers/uploadImageOriginal.ts` reads `original.key`/`original.bucket` and
  constructs a flat `original`; adapt the upload result and host metadata mapping.
  Supply a stable optional namespace here if this host wants auditable S3 prefixes.
- `src/helpers/toMediaLike.ts` constructs flat refs from `original` and legacy
  `originalMetadata`; define how that host handles its legacy data under the
  no-old-resize-record assumption, and pass nested refs to the module.
- `src/models/File.ts` checks and writes `original.key` in
  `prepareResizeOriginal`; update its schema expectations, presence checks and
  conditional update. It already spreads `resizeMediaSchemaFragment`.
- `src/helpers/mediaPublicUrls.ts` gates reads on `original.key`; update that
  persisted-original check. `src/helpers/generateAvatarPreviews.ts` checks the
  same field after preparation.
- The related upload, avatar and local-media tests assert flat keys or
  `bucket: 'local-private'`; update them when adapting the host.

Before deployment, verify the target data policy, update all host consumers, run
host tests and coordinate API/worker release. The module patch does not establish
that the host's existing data satisfies the no-legacy-record assumption.

Retain `minimize: false` on the media schema so empty objects inside opaque refs
survive persistence. Framework `BaseModel` already supplies this default; direct
Mongoose schemas must set it explicitly. The field fragment alone cannot configure
the enclosing schema's options.
