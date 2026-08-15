# Archive — as-built record for 0.1 / 0.2

**These documents are not maintained.** They describe how this module was designed and built,
not necessarily how it behaves today. Where they disagree with the code, **the code wins**.

The living documentation is:

| Where | What |
|---|---|
| [`README.md`](../../README.md) | install, wiring, drivers, modes, config — the user-facing docs |
| [`AGENTS.md`](../../AGENTS.md) | the guide for coding agents working in a host app (ships with the package) |
| <https://framework.adaptivestone.com/docs/resize> | the published docs site |

## Why this is archived

`BUILD-SPEC.md` names its own audience: *"an engineering agent building this module from
scratch."* That module is built. The spec set did its job, and keeping ~190KB of build
specification synchronized with shipped code is a cost with no remaining reader — a cost that
was measurably not being paid (three separate drift instances were found in the 2026-08-15
review, including a passage of `BUILD-SPEC.md` that contradicted another passage of the same
file).

Kept rather than deleted because the *reasoning* is still worth reading: why the queue is
custom, why storage/transport/mediaStore/lockProvider are all driver seams, why `fit` is a size
token, why preview keys are random. That rationale does not expire even when the API drifts.

## Contents

| File | What it was for |
|---|---|
| [`BUILD-SPEC.md`](./BUILD-SPEC.md) | index + the settled design decisions and definition of done |
| [`spec/`](./spec/) | the 11-part detailed specification (architecture → host integration) + appendix |
| [`BUILD-PLAN.md`](./BUILD-PLAN.md) | implementation status and build order, phase by phase |
| [`ADOPTION-PLAN.md`](./ADOPTION-PLAN.md) | the 0.2 rationale, written after the first production probe |

Nothing here ships to npm — `package.json` uses `files: ["dist", "AGENTS.md"]`, an allowlist, so
the published tarball contains only `dist/`, `AGENTS.md`, `README.md`, `LICENSE`, and
`package.json`.
