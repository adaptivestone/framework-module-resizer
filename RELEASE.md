# Releasing `@adaptivestone/framework-module-resize`

Releases are **manual** (same as the sibling repos — `@adaptivestone/framework` and
`@adaptivestone/framework-module-email` ship without a publish workflow). CI
(`.github/workflows/ci.yml`: the latest Node with the locked dependencies, plus a `min-versions`
job on the oldest supported Node major, at its newest 24.x release, with every peer at its
declared minimum) and the packaging smoke
(`.github/workflows/packaging.yml`) gate every push/PR; publishing is a human step run from a
clean `main`.

## 1. Pre-flight gates (all must be green)

Run from a clean working tree on `main`:

```bash
npm ci                 # reproducible install from the lockfile
node --run types:check # tsc --noEmit
node --run check       # biome
node --run build       # preBuild → tsc → postBuild (emits dist/)
npm test               # node --experimental-strip-types --test  (the full node:test suite)
npm run smoke          # builds, packs, installs into a throwaway consumer, verifies the
                       # published surface + the resize-scaffold bin end-to-end
```

`npm run smoke` is the release-critical one: it exercises the **published** artifact (the
`dist` the tarball ships), not the TS source the test suite runs against — the exports map, the
rewritten relative import paths, the optional-subpath loud-fail contract, and the bin.

## 2. Version bump policy

Semver. Pre-1.0 (`0.x`), the minor is the breaking channel:

- `0.x.y` → `0.x.(y+1)` — fixes / additive, backward-compatible.
- `0.x.y` → `0.(x+1).0` — any breaking change to the public surface (the core exports, the
  driver subpaths, the config shape, the `ResizeTask` schema, or the scaffold output).
- Cut `1.0.0` once the public API is committed-to.

Bump with `npm version <patch|minor|major>` (updates `package.json` + creates the git tag — see
§4), or edit `version` by hand and tag manually.

> **Check `version` first.** For 0.3.0 no bump is needed: `package.json` already holds `0.3.0`
> and `CHANGELOG.md` has the `# 0.3.0` heading, so tag the release commit by hand. In general,
> compare `version` with `npm view @adaptivestone/framework-module-resize version`; if it is
> already ahead, do not run `npm version` on top of it (that would skip a version).

**Update `CHANGELOG.md` in the same commit as the bump.** Newest version first, `# X.Y.Z`
heading, with `**Breaking changes**` / `**Features**` / `**Fixes**` / `**Internal**` groups —
the format the sibling `framework-module-email` uses. It is NOT in `files`, so it stays on GitHub and never
ships in the tarball (same as the sibling). Write it for a host developer deciding whether to
upgrade: what breaks, what is new, and what they must change.

## 3. Publish

This is a **scoped** package (`@adaptivestone/…`). npm defaults scoped packages to **restricted**
(private) access, so the **first** publish must opt into public access explicitly. Neither this
repo nor the sibling repos set `publishConfig.access` in `package.json` — the house convention is
to pass the flag on the first publish:

```bash
npm publish --access public   # FIRST publish only — makes the scoped package public
```

Subsequent publishes need no flag (access is sticky once set on the registry):

```bash
npm publish
```

`prepublishOnly` runs `npm run build` automatically, so `dist/` is always rebuilt from source at
publish time; `files: ["dist", "AGENTS.md"]` (plus the auto-included `README.md` + `LICENSE`) is
all that ships.

> If the org later decides to standardize access in-manifest, add `"publishConfig": { "access":
> "public" }` to `package.json` and drop the flag. As of this release the siblings rely on the
> flag, so this module mirrors that.

## 4. Git tag convention

Tag the release commit `vX.Y.Z`.

> **Note:** the sibling repos tag **without** the `v` prefix (`framework` uses `5.3.1`,
> `framework-module-email` uses `2.0.0`). This repo's existing tags are mixed: `v0.1.0` has the
> prefix, `0.2.0` does not, and 0.2.1 has no tag at all (`git tag` lists them). This file keeps
> the `v` prefix, npm's default; pick one convention before the next release and use it from
> then on.

```bash
git tag v0.1.0
git push origin main --tags
```

`npm version <…>` creates this tag for you (prefix `v` is npm's default).

**If the tag already exists** (e.g. it was cut before the release commit landed), do NOT publish
against it — move it, so the tag and the published tarball describe the same code:

```bash
git tag -f vX.Y.Z            # repoint at the release commit
git push --force origin vX.Y.Z
```

Then **publish a GitHub Release** for the tag, as both sibling repos do for every version — paste
the matching `CHANGELOG.md` section as the body:

```bash
# `1d;$d` drops the `# X.Y.Z` heading and the next version's heading — the body starts at
# **Breaking changes**, matching how the sibling repos' release bodies read.
gh release create vX.Y.Z --title "X.Y.Z" \
  --notes-file <(sed -n '/^# X.Y.Z$/,/^# /p' CHANGELOG.md | sed '1d;$d')
```

## 5. Manual post-publish verification — try in a real host backend

_Placeholder — the one check the automated smoke can't do: wire the published package into an
actual framework host and run it against real infra._

- [ ] In a real `@adaptivestone/framework` host: `npm i @adaptivestone/framework-module-resize`,
      run `npx resize-scaffold`, and in `src/config/resize.ts` set `mediaModelName`, `storage`
      (S3), `queue: { driver: 'database' }` and `worker.enabled: true`. `src/resizer.ts` stays
      `new FrameworkResizer({ pipelines })`. Create the `ResizeTask` indexes through the host's
      migration, and call `await resizer.verify()` after `server.init()`.
- [ ] `npx resize-scaffold --check` passes, and `npm run gen` (the framework's AST codegen) types
      `getModel('ResizeTask')` through the scaffolded shim.
- [ ] Boot the server, upload an image, confirm a `resolve()` read queues the missing variants and
      `npm run cli ResizeWorker` generates and persists the previews (database queue + S3
      storage). If the host uses SQS, repeat with `queue: { driver: 'sqs', … }`.
- [ ] Stop the worker during a task (SIGTERM): the task goes back to `pending` and the next
      worker finishes it.
- [ ] Confirm eager mode (`generate()`, no `queue` in the config) on a host scaffolded with
      `--eager`; `npx resize-scaffold --check --eager` passes.

## Notes

- **No publish workflow on purpose.** Both sibling repos release manually; a tagged-release
  Action can be added later if the team wants it, but it is not part of the house convention today.
- CI caches the `mongod` binary (`~/.cache/mongodb-binaries`) so the mongodb-memory-server
  download doesn't repeat every run; `sharp` needs no handling (prebuilt `@img/sharp-linux-*`
  via `npm ci`).
