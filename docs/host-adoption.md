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

## Other changes a host must make for this version

`CHANGELOG.md` (`# Unreleased`) has the details.

- Construct the Resizer with `new FrameworkResizer({ pipelines, hooks })` in
  `src/resizer.ts`, and move `storage` and `queue` into `src/config/resize.ts`
  (`queue: { driver: 'database' }` for background generation). Move
  `worker.concurrency` to the top-level `concurrency`.
- Create the `ResizeTask` indexes through the host's migration before rollout: the
  lease index is now `{ queue, status, createdAt }` (it replaces
  `{ status, createdAt }`), and the partial unique index on
  `{ fileId, pipeline, requestKey }` is required for de-duplication.
- Regenerate the model shim, which now imports `…/framework/ResizeTaskModel.js`:
  delete `src/models/ResizeTask.ts` and re-run `npx resize-scaffold` (`--force`
  would also overwrite `src/resizer.ts` and `src/config/resize.ts`). An ejected or
  hand-written model must add the `resizer`, `queue` and `requestKey` fields;
  `resize-scaffold --check` and `resizer.verify()` report a model without them.
- A host whose Resizers read only named config files (no `resize.ts`) starts the
  worker with `npm run cli ResizeWorker -- --config=<name>`.
- Previews stored before preview identity included the Resizer and the pipeline
  have no `resizer` or `pipeline` field and count as the `default` Resizer's
  `default` pipeline. A named Resizer or pipeline generates its previews again, and a
  `default` read may serve an old preview that was rendered by another pipeline;
  remove such rows if that matters.
- Register every pipeline in `src/resizer.ts`, and deploy the worker before the API
  requests a new or renamed pipeline: an unregistered pipeline is never rendered.
