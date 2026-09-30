# Host adoption required for nested storage refs

This package changes the persisted resize fields from flat `key`/`bucket` fields to
`original.storageRef` and `previews[].storageRef`. It has no reader or migration for
old resize records. Updating this package alone does not make an existing host ready
for rollout: the API and worker must use the same package version and media schema.

Host adoption checklist (implementation belongs in the host repository):

- Upload handlers must persist the returned original with its nested `storageRef`.
  Supply a stable optional namespace if the host wants auditable storage prefixes.
- Media mapping helpers must pass nested refs to the module. Any handling of legacy
  host data is the host's responsibility; the module supplies no old-record reader
  or migration.
- Media models must use `resizeMediaSchemaFragment` and update presence checks and
  conditional writes that previously relied on flat `original.key` fields.
- Public URL builders and preview-generation helpers must check
  `original.storageRef` when deciding whether an original has been persisted.
- Upload, preview and storage tests must assert the nested ref shape.

Before deployment, verify the target data policy, update all host consumers, run
host tests and coordinate API/worker release. The module patch does not establish
that the host's existing data satisfies the no-legacy-record assumption.

Retain `minimize: false` on the media schema so empty objects inside opaque refs
survive persistence. Framework `BaseModel` already supplies this default; direct
Mongoose schemas must set it explicitly. The field fragment alone cannot configure
the enclosing schema's options.
