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
node --run types:check # tsc: the shipped code, then the tests (tsconfig.tests.json)
node --run types:check:src
                       # shipped code + type pins (CI also runs it on the minimum peers)
node --run check       # biome
node --run build       # preBuild → tsc → postBuild (emits dist/)
npm test               # the full node:test suite, with the noAws.ts preload (see package.json)
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

**Prereleases.** A breaking minor may ship as release candidates first: `X.Y.0-rc.N`, starting
at `rc.1` (`npm version X.Y.0-rc.1 --no-git-tag-version`, then tag by hand, §4). Each rc is
published with the npm tag `next` (§3), so `latest` stays on the last stable release until the
final `X.Y.0`. All of a version's rcs stay under its one `# X.Y.0` heading of `CHANGELOG.md`,
and the final `X.Y.0` is a bump from the last rc with no new heading; at that bump the heading's
rc note becomes an "Upgrading from a release candidate" note.

0.3.0 shipped this way: `0.3.0-rc.1` held every host-facing shape, `0.3.0-rc.2` the
`beforeSteps` signature and the decoder port, `0.3.0-rc.3` additions only (`createResizer`, drivers
by name, routing between backends, a worker queue list, partial config files; no required host
change), `0.3.0-rc.4` metrics and the freshness check (additions, and outdated previews regenerate
on read; no required host change), and `0.3.0-rc.5` a cache header on S3 public objects (no host
change). The final `0.3.0` followed `0.3.0-rc.5` with no host-facing change.

> **Check `version` first.** Compare `version` with
> `npm view @adaptivestone/framework-module-resize versions --json` (every version, rcs
> included; `npm view … version` shows only `latest`). If `package.json` is already ahead, do not
> run `npm version` on top of it (that would skip a version); tag the release commit by hand.

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

A **prerelease** (`X.Y.Z-rc.N`) is published with the `next` dist-tag, so `latest` stays on the
last stable release and a plain `npm i @adaptivestone/framework-module-resize` never picks it up
(hosts opt in with `@next`):

```bash
npm publish --tag next
npm dist-tag ls @adaptivestone/framework-module-resize   # latest = last stable, next = the rc
```

The final release is a plain `npm publish` (it moves `latest`). Leaving `next` on the last rc is
harmless; point it at the final release with `npm dist-tag add
@adaptivestone/framework-module-resize@X.Y.Z next` if you want `@next` to stay the newest.

`prepublishOnly` runs `npm run build` automatically, so `dist/` is always rebuilt from source at
publish time; `files: ["dist", "AGENTS.md"]` (plus the auto-included `README.md` + `LICENSE`) is
all that ships.

> If the org later decides to standardize access in-manifest, add `"publishConfig": { "access":
> "public" }` to `package.json` and drop the flag. As of this release the siblings rely on the
> flag, so this module mirrors that.

## 4. Git tag convention

Tag the release commit `vX.Y.Z`, and a release candidate `vX.Y.Z-rc.N` (e.g. `v0.3.0-rc.1`).

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

For a release candidate, mark the GitHub Release as a prerelease and take the body from the
`# X.Y.0` section it belongs to (rcs have no heading of their own):

```bash
gh release create vX.Y.0-rc.N --prerelease --title "X.Y.0-rc.N" \
  --notes-file <(sed -n '/^# X.Y.0$/,/^# /p' CHANGELOG.md | sed '1d;$d')
```

## 5. Manual post-publish verification — try in a real host backend

_Placeholder — the one check the automated smoke can't do: wire the published package into an
actual framework host and run it against real infra._

- [ ] In a real `@adaptivestone/framework` host: `npm i @adaptivestone/framework-module-resize`
      (`@next` for a release candidate), run `npx resize-scaffold`, and in `src/config/resize.ts`
      set `mediaModelName` and `storage` (S3), keep `queue: 'default'` and
      `queues: { default: { driver: 'database' } }`, and set `worker: { enabled: true }`.
      `src/resizer.ts` stays
      `new FrameworkResizer({ pipelines })`. Create the `ResizeTask` indexes through the host's
      migration, and call `await resizer.verify()` after `server.init()`.
- [ ] `npx resize-scaffold --check` passes, and `npm run gen` (the framework's AST codegen) types
      `getModel('ResizeTask')` through the scaffolded shim.
- [ ] Boot the server, upload an image, confirm a `resolve()` read queues the missing variants and
      `npm run cli ResizeWorker` generates and persists the previews (database queue + S3
      storage). If the host uses SQS, repeat with
      `queues: { default: { driver: 'sqs', queueUrl, … } }`.
- [ ] Stop the worker during a task (SIGTERM): the task goes back to `pending` and the next
      worker finishes it.
- [ ] Confirm eager mode (`generate()`, no `queue` or `queues` in the config) on a host scaffolded with
      `--eager`; `npx resize-scaffold --check --eager` passes.

### Push delivery (needs an AWS account)

Nothing in `Push delivery (preview)` has run on real AWS: the handler was measured with stand-ins and
a model on one machine. Use a throwaway account or prefix, and delete everything afterwards. The
script below has not been run either, so check its flags as you go. Run C2 and C5 first, since they
are the two that can change the design. Until C1, C2, C5 and C8 have passed once, the docs keep the
mark.

To remove the mark, run `grep -rn "Push delivery (preview)" README.md AGENTS.md CHANGELOG.md src/lambda.ts`
here and the same `grep` on `docs/12-resize.md` in the guide's repository, change each hit and the
`createSqsHandler` JSDoc, update the README's opening sentence of that section, and fix the guide's
link to the README's `#push-delivery-preview` anchor, which the new heading changes.

```bash
# Deployed: a function with the guide's handler, nodejs24.x, arm64, 1769 MB, timeout 120 s, and
# pipeline steps 'block' (blocks the event loop past the timeout) and 'hang' (awaits past it,
# ignoring the abort), each on demand.
aws sqs create-queue --queue-name resize-check-dead
aws sqs create-queue --queue-name resize-check --attributes '{
  "VisibilityTimeout":"720",
  "RedrivePolicy":"{\"deadLetterTargetArn\":\"<DEAD_ARN>\",\"maxReceiveCount\":\"7\"}"}'
aws lambda create-event-source-mapping --function-name resize-check \
  --event-source-arn <QUEUE_ARN> --batch-size 1 \
  --function-response-types ReportBatchItemFailures \
  --scaling-config MaximumConcurrency=2
# Feed it with resizer.prewarm(), or send a task's JSON body with `aws sqs send-message`.
# Read attempts and timing from the "resize: task ..." log lines and the REPORT lines.
```

| # | Do | Expect | If not |
|---|---|---|---|
| C1 | One good task | Previews stored. Message gone, and stays gone after 720 s. No error from Lambda's own delete | Stop deleting in the handler: leave the record out and let Lambda delete it, releasing the gate afterwards |
| **C2** | A task that fails with a retryable error (a missing storage object) | **Attempts about 5 s, 10 s, 20 s apart, not 720 s** | Safe but slow: document it, and set a shorter visibility or use `DelaySeconds` |
| C3 | Keep C2 failing. Then set `maxReceiveCount` to 3 and repeat | Dead at attempt 5: in the dead-letter queue with the module's body, `onTaskDeadLettered` fired, cooldown on. At 3: SQS moves it, with no `is dead` line, no hook and no cooldown, as the docs warn | Check `sqs:SendMessage`. Whatever you see, decide here whether the first invocation should check `maxReceiveCount` with one `GetQueueAttributes` call |
| C4 | Function timeout 30 s, `stopBeforeTimeoutMs: 10000`, a catalog that takes longer than that at this memory | `RESIZE_TASK_TIMEOUT` in the log, no `Status: timeout` in REPORT, some rows stored, retried with backoff, and the retry renders only the rest | Raise the default reserve |
| **C5** | The `block` step, so REPORT says `Status: timeout` | Redelivered about one lease (60 s) later, not 720 s. Gate still held | Adoption failed: check IAM |
| C6 | Batch of 3 (mixed), batch size 3 and a 1 s window | Only the failed record comes back | Check `itemIdentifier` |
| C7 | Remove `ReportBatchItemFailures`, repeat C2 | Message gone after the first failure, confirming the trap in the docs | Update the docs with what you see |
| C8 | One 12 MP JPEG, one SVG | Both render. Note `Init Duration` and `Max Memory Used` | SVG: capture the error; document rasterising elsewhere, or drop SVG on Lambda |
| C9 | Reserved concurrency below the burst, 50 messages | Watch whether attempts rise without runs | Raise `maxAttempts`, or document `MaximumConcurrency` only |
| C10 | Invoke, wait 20 minutes, invoke again | The frozen Mongo connection recovers without a failed task | Tune `maxIdleTimeMS`; document it |
| C11 | The `hang` step | REPORT ends about 2 s before the timeout with no `Status: timeout`, a `had not settled` line, the record back after its backoff, and no harm when the frozen step resumes | Check that an async handler's return ends the invocation |
| C12 | Function timeout 3 s, Lambda's default, with the queue's visibility timeout at 18 s for this run | An `error` line naming the first record on each delivery, nothing rendered, deliveries about 18 s apart (a record not started gets no visibility call), then dead with `RESIZE_TASK_MAX_ATTEMPTS` at the sixth delivery | Check the receive count reaches the handler |
| C13 | A function in a VPC with no NAT and no endpoint | An `error` naming the route to SQS on each delivery, and no task run. Note how long one delivery takes | Set a shorter request timeout on the SDK client, and document it |
| C14 | In C10's second invocation, watch the first SQS and S3 calls after the thaw | No failed task from a stale socket: the SDK retries | Document it |
| C15 | In C6, read Lambda's logs and the queue's metrics for the records the function already deleted itself, beside the one it listed | No error from Lambda's own delete of those, and the listed record comes back after the visibility the function set, not 720 s | Stop deleting in the handler, as in C1 |
| C16 | The `hang` step with a real Sharp chain in flight and an upload after it: let the function return, invoke again within a minute, and once more with `limits.processingTimeoutSeconds` shorter than the gap | Whether a late S3 PUT and a late Mongo write land after the thaw, as a row a read judges as any other. Whether frozen time counts toward Sharp's limit: it did under `SIGSTOP` on one machine, so the chain failed just after the thaw and its retry rendered it | Document what you see in the README's `Stopping in time` |
| C17 | A package without `@aws-sdk/*`: log `import.meta.resolve('@aws-sdk/client-sqs')` from `/var/task` at init, then deliver one task | Either it resolves to the runtime's copy, and the docs can say a host need not ship the SDK once its version is checked against the peer range, or the task is refused with `RESIZE_PEER_MISSING`, as the docs assume | Document which, and the runtime's SDK version |

## Notes

- **No publish workflow on purpose.** Both sibling repos release manually; a tagged-release
  Action can be added later if the team wants it, but it is not part of the house convention today.
- CI caches the `mongod` binary (`~/.cache/mongodb-binaries`) so the mongodb-memory-server
  download doesn't repeat every run; `sharp` needs no handling (prebuilt `@img/sharp-linux-*`
  via `npm ci`).
