# Releasing `@adaptivestone/framework-module-resize`

Releases are **manual** (same as the sibling repos — `@adaptivestone/framework` and
`@adaptivestone/framework-module-email` ship without a publish workflow). CI (`.github/workflows/ci.yml`)
and the packaging smoke (`.github/workflows/packaging.yml`) gate every push/PR; publishing is a
human step run from a clean `main`.

## 1. Pre-flight gates (all must be green)

Run from a clean working tree on `main`:

```bash
npm ci                 # reproducible install from the lockfile
node --run types:check # tsc --noEmit
node --run check       # biome
node --run build       # preBuild → tsc → postBuild (emits dist/)
npm test               # node --experimental-strip-types --test  (232 tests)
npm run smoke          # builds, packs, installs into a throwaway consumer, verifies the
                       # published surface + the resize-scaffold bin end-to-end
```

`npm run smoke` is the release-critical one: it exercises the **published** artifact (the
`dist` the tarball ships), not the TS source the test suite runs against — the exports map, the
rewritten relative import paths, the optional-subpath loud-fail contract, and the bin.

## 2. Version bump policy

Semver. Pre-1.0 (`0.x`), the minor is the breaking channel:

- `0.x.y` → `0.x.(y+1)` — fixes / additive, backward-compatible.
- `0.x.y` → `0.(x+1).0` — any breaking change to the public surface (the 17 core exports, the
  driver subpaths, the config shape, the `ResizeTask` schema, or the scaffold output).
- Cut `1.0.0` once the public API is committed-to.

Bump with `npm version <patch|minor|major>` (updates `package.json` + creates the git tag — see
§4), or edit `version` by hand and tag manually.

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
publish time; `files: ["dist"]` (plus the auto-included `README.md` + `LICENSE`) is all that ships.

> If the org later decides to standardize access in-manifest, add `"publishConfig": { "access":
> "public" }` to `package.json` and drop the flag. As of this release the siblings rely on the
> flag, so this module mirrors that.

## 4. Git tag convention

Tag the release commit `vX.Y.Z` (matches the framework/email repos):

```bash
git tag v0.1.0
git push origin main --tags
```

`npm version <…>` creates this tag for you (prefix `v` is npm's default).

## 5. Manual post-publish verification — try in a real host backend

_Placeholder — the one check the automated smoke can't do: wire the published package into an
actual framework host and run it against real infra._

- [ ] In a real `@adaptivestone/framework` host: `npm i @adaptivestone/framework-module-resize`,
      run `npx resize-scaffold`, fill the `storage` TODO in `src/resizer.ts` + `mediaModelName`
      in `src/config/resize.ts`, `import ./resizer.ts` from `src/server.ts`.
- [ ] Confirm `npm run gen` (the framework's AST codegen) types the scaffolded
      `class ResizeTask extends ResizeTaskModel {}`.
- [ ] Boot the server, upload an image, confirm a `resolve()` read enqueues and the
      `ResizeWorker` command generates + persists previews (mongo transport + S3 storage).
- [ ] Confirm eager mode (`generate()`, no transport) on a host wired without a queue.

## Notes

- **No publish workflow on purpose.** Both sibling repos release manually; a tagged-release
  Action can be added later if the team wants it, but it is not part of the house convention today.
- CI caches the `mongod` binary (`~/.cache/mongodb-binaries`) so the mongodb-memory-server
  download doesn't repeat every run; `sharp` needs no handling (prebuilt `@img/sharp-linux-*`
  via `npm ci`).
