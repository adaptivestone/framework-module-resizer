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
heading, with `**Breaking changes**` / `**Changed behaviour**` / `**Features**` / `**Fixes**` /
`**Documentation**` / `**Internal**` groups — the format the sibling `framework-module-email`
uses. It is NOT in `files`, so it stays on GitHub and never ships in the tarball (same as the
sibling). Write it for a host developer deciding whether to upgrade: what breaks, what is new, and
what they must change.

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
publish time; `files: ["dist", "AGENTS.md", "UPGRADING.md"]` (plus the auto-included `README.md` +
`LICENSE`) is all that ships.

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
# `1d;$d` drops the `# X.Y.Z` heading and the next version's heading — the body starts at the
# pointer to UPGRADING.md when the section has one, then **Breaking changes**, matching how the
# sibling repos' release bodies read.
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
      (`@next` for a release candidate), run `npx --no -- resize-scaffold`, and in
      `src/config/resize.ts` set `mediaModelName` and `storage` (S3), keep `queue: 'default'` and
      `queues: { default: { driver: 'database' } }`, and set `worker: { enabled: true }`.
      `src/resizer.ts` stays
      `new FrameworkResizer({ pipelines })`. Create the `ResizeTask` indexes through the host's
      migration, and call `await resizer.verify()` after `server.init()`.
- [ ] `npx --no -- resize-scaffold --check` passes, and `npm run gen` (the framework's AST
      codegen) types `getModel('ResizeTask')` through the scaffolded shim.
- [ ] Boot the server, upload an image, confirm a `resolve()` read queues the missing variants and
      `npm run cli ResizeWorker` generates and persists the previews (database queue + S3
      storage). If the host uses SQS, repeat with
      `queues: { default: { driver: 'sqs', queueUrl, … } }`.
- [ ] Stop the worker during a task (SIGTERM): the task goes back to `pending` and the next
      worker finishes it.
- [ ] Confirm eager mode (`generate()`, no `queue` or `queues` in the config) on a host scaffolded with
      `--eager`; `npx --no -- resize-scaffold --check --eager` passes.

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

The handler is the guide's, with two steps and a hook for this list. Each step runs past the 120 s
timeout, and only for a task that names its pipeline:

```js
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

createResizer(config, {
  pipelines: {
    default: {},
    // Blocks the event loop, so no timer fires and REPORT says `Status: timeout`.
    block: {
      beforeSteps: [
        async (raster) => {
          const end = Date.now() + 150_000;
          while (Date.now() < end);
          return raster;
        },
      ],
    },
    // Awaits, ignoring the abort.
    hang: {
      beforeSteps: [
        async (raster) => {
          await wait(150_000);
          return raster;
        },
      ],
    },
  },
  hooks: {
    onTaskDeadLettered: (task) => console.log('onTaskDeadLettered', task.mediaId),
  },
});
```

```bash
# MONGO_DSN, PUBLIC_BUCKET and PRIVATE_BUCKET are yours. In a clean copy of the handler:
npm install --omit=dev --os=linux --cpu=arm64 --libc=glibc
zip -qr function.zip handler.mjs package.json node_modules

# The queues first: the function's environment needs their URLs.
DEAD_URL=$(aws sqs create-queue --queue-name resize-check-dead --query QueueUrl --output text)
DEAD_ARN=$(aws sqs get-queue-attributes --queue-url "$DEAD_URL" --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)
QUEUE_URL=$(aws sqs create-queue --queue-name resize-check --query QueueUrl --output text \
  --attributes "{\"VisibilityTimeout\":\"720\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DEAD_ARN\\\",\\\"maxReceiveCount\\\":\\\"7\\\"}\"}")
QUEUE_ARN=$(aws sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

# The role: the managed policy, and what the docs say it lacks. No s3:ListBucket, as the docs say.
ROLE_ARN=$(aws iam create-role --role-name resize-check --query Role.Arn --output text \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}')
aws iam attach-role-policy --role-name resize-check \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole
aws iam put-role-policy --role-name resize-check --policy-name resize-check --policy-document "{
  \"Version\":\"2012-10-17\",\"Statement\":[
  {\"Effect\":\"Allow\",\"Action\":\"sqs:ChangeMessageVisibility\",\"Resource\":\"$QUEUE_ARN\"},
  {\"Effect\":\"Allow\",\"Action\":\"sqs:SendMessage\",\"Resource\":\"$DEAD_ARN\"},
  {\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:PutObject\"],
   \"Resource\":[\"arn:aws:s3:::$PUBLIC_BUCKET/*\",\"arn:aws:s3:::$PRIVATE_BUCKET/*\"]}]}"

# The function, with the queues' URLs. A new role can take a few seconds: repeat if it is refused.
cat > env.json <<EOF
{"Variables":{"MONGO_DSN":"$MONGO_DSN","PUBLIC_BUCKET":"$PUBLIC_BUCKET","PRIVATE_BUCKET":"$PRIVATE_BUCKET",
 "QUEUE_URL":"$QUEUE_URL","DEAD_LETTER_QUEUE_URL":"$DEAD_URL"}}
EOF
aws lambda create-function --function-name resize-check --runtime nodejs24.x --architectures arm64 \
  --memory-size 1769 --timeout 120 --role "$ROLE_ARN" --handler handler.handler \
  --zip-file fileb://function.zip --environment file://env.json

# The trigger, and the metrics C1 and C15 read: Lambda does not log its poller's deletes.
UUID=$(aws lambda create-event-source-mapping --function-name resize-check \
  --event-source-arn "$QUEUE_ARN" --batch-size 1 \
  --function-response-types ReportBatchItemFailures \
  --scaling-config MaximumConcurrency=2 --metrics-config Metrics=EventCount \
  --query UUID --output text)

# Feed it with resizer.prewarm() from a process with the same config. To name a step, or to send a
# body of your own, use a task's JSON. Its gateOwner takes the gate when the delivery starts.
aws sqs send-message --queue-url "$QUEUE_URL" --message-body '{
  "resizer":"default","queue":"default","mediaId":"<MEDIA_ID>","pipeline":"block",
  "previews":[{"sizeKey":"620w","format":"jpeg","requestedWidth":620}],"gateOwner":"check-1"}'

# What the rows read. The mapping first: after a create or an update, wait for Enabled, as AWS refuses
# an update to one in Creating (ResourceInUseException). The metric can lag by the function's timeout
# and more.
aws lambda get-event-source-mapping --uuid "$UUID" --query State --output text
aws sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names \
  ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
aws cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name DeletedEventCount \
  --dimensions Name=EventSourceMappingUUID,Value="$UUID" --statistics Sum --period 60 \
  --start-time <START> --end-time <END>
aws logs tail /aws/lambda/resize-check --since 15m
```

Each row says what to run, what passing looks like, and where to read it. "The log" is the function's
log, with its `START` and `REPORT` lines; "the queue" and "the metric" are the last commands above.
The per-task line reads `resize: task … of media … in … ms (… attempt n, …)`, and a retry reads
`failed (attempt n of 5, code …) — retrying in … ms`.

| # | Run | Pass | Read it in | If not |
|---|---|---|---|---|
| C1 | `prewarm()` on a new media: one good task | Previews stored. No message in the queue now, or after 720 s. A nonzero `DeletedEventCount` for the records the function deleted: a failed delete emits 0, per AWS | The media's row, the queue, the metric | Stop deleting in the handler: leave the record out and let Lambda delete it, releasing the gate afterwards |
| **C2** | A task that fails with a retryable error: a new media whose original is gone from S3. With the docs' IAM (no `s3:ListBucket`) it reads as raw `AccessDenied`, `code none`, not `RESIZE_STORAGE_NOT_FOUND`, and is retried the same way | **Attempts about 5 s, 10 s, 20 s apart, not 720 s** | The log: `retrying in`, and the `START` times | Safe but slow: document it, and set a shorter visibility or use `DelaySeconds` |
| C3 | Keep C2 failing. Then set `maxReceiveCount` to 3 with `aws sqs set-queue-attributes` and repeat on a new media, since the cooldown blocks `prewarm()` for the first one for 600 s. Set it back to 7 | Dead at attempt 5: in the dead-letter queue with the module's body, which holds `attempts` and `error`, `onTaskDeadLettered` fired, and `prewarm()` on that media reports `RESIZE_ENQUEUE_LOCK_CONTENDED`. At 3: SQS moves it with its own body, no `is dead` line, no hook and no cooldown, as the docs warn | `aws sqs receive-message --queue-url "$DEAD_URL"`, the log, `prewarm()`'s `issues` | Check `sqs:SendMessage`. Whatever you see, decide here whether the first invocation should check `maxReceiveCount` with one `GetQueueAttributes` call |
| C4 | Function timeout 30 s, `stopBeforeTimeoutMs: 10000`, a catalog that takes longer than that at this memory | `RESIZE_TASK_TIMEOUT`, no `Status: timeout`, some rows stored, retried with backoff, and the retry renders only the rest | The log, the media's row | Raise the default reserve |
| **C5** | The task's JSON with pipeline `block`, on a new media | Measured from the first `START`: the second delivery starts about one lease (60 s) later, not 720 s. That is about 60 s before the first `Status: timeout`, in a second environment, so expect the overlap. While it runs, the gate is held: `prewarm()` on that media and pipeline reports `RESIZE_ENQUEUE_LOCK_CONTENDED` | The log: `START` and `REPORT` by request id. `prewarm()`'s `issues` | Adoption failed: check IAM |
| C6 | `aws lambda update-event-source-mapping --uuid "$UUID" --batch-size 3 --maximum-batching-window-in-seconds 1`, wait for `State` to read `Enabled`, then three tasks together with `aws sqs send-message-batch`: two good, one failing. Send three more if their lines do not fall in one `START`/`REPORT`. Set it back to batch size 1, window 0 | Only the failed record comes back: its task's line repeats, and the other two appear once. Count the row only when the three tasks' lines fall in one `START`/`REPORT`: the same result at batch size 1 tests nothing, and no AWS page says when a new batch size starts | The log: `resize: task …` by media, between one `START` and its `REPORT` | Check `itemIdentifier` |
| C7 | Remove the setting with `--function-response-types '[]'`, repeat C2, and put it back | Message gone after the first failure, with its line still saying `retrying in 5000 ms`, confirming the trap in the docs | The log: one `START` for it. The queue reads 0, and so does the dead-letter queue | Update the docs with what you see |
| C8 | One 12 MP JPEG, one SVG | Both render. Note `Init Duration` and `Max Memory Used` | The media's rows, `REPORT` | SVG: capture the error; document rasterising elsewhere, or drop SVG on Lambda |
| C9 | Drop the scaling config for this row, as `MaximumConcurrency` caps the burst and nothing would throttle: `--scaling-config '{}'`, then `aws lambda put-function-concurrency --function-name resize-check --reserved-concurrent-executions 2`. Lower the visibility to the function timeout, so a throttled receive costs 120 s, not 720 s: `aws sqs set-queue-attributes --queue-url "$QUEUE_URL" --attributes VisibilityTimeout=120`. Run `prewarm()` on 300 new media, as a repeated media renders nothing: tasks of about 5 s, 2 at a time, drain in about 750 s, past the 5 × 120 s a task needs to die unrun. Undo all three, with the visibility back at 720 | `Throttles` above 0 and a drain over 600 s, or the row tested nothing: send more. No `RESIZE_TASK_MAX_ATTEMPTS` on tasks that never ran, and no new message in the dead-letter queue, which SQS would move there with no line. Note the highest receive count: it is the margin left | `Throttles` in `AWS/Lambda` by `FunctionName`. The queue: the drain, and `$DEAD_URL`. The log: `is dead` lines, and the highest `attempt n` | Raise `maxAttempts`, or document `MaximumConcurrency` only |
| C10 | Invoke, wait 20 minutes, invoke again | The frozen Mongo connection recovers without a failed task. Count the row only when the second invocation's `REPORT` is in the first's log stream, the same execution environment: no `Init Duration` proves less, as AWS says an environment may be initialized ahead of its invocation. Otherwise shorten the gap and note the longest one that kept the environment | The log: the stream name `aws logs tail` prints beside each `REPORT`, and no `failed` line | Tune `maxIdleTimeMS`; document it |
| C11 | The task's JSON with pipeline `hang`, on a new media | `REPORT` ends about 2 s before the timeout with no `Status: timeout`, a `had not settled` line, the record back after its backoff, and no harm when the frozen step resumes | The log | Check that an async handler's return ends the invocation |
| C12 | Function timeout 3 s, Lambda's default, with the queue's visibility timeout at 18 s for this run | An `error` line naming the first record on each delivery, nothing rendered, deliveries about 18 s apart (a record not started gets no visibility call), then dead with `RESIZE_TASK_MAX_ATTEMPTS` at the sixth delivery | The log: `was not started`, `START` times, `is dead` | Check the receive count reaches the handler |
| C13 | A function in a VPC with no NAT and no endpoint, with Mongo reachable from the VPC: the guide's handler connects at import, so with Mongo unreachable the expected line never appears | An `error` naming the route to SQS on each delivery, and no task run. Note how long one delivery takes | The log: `had not answered`, and `REPORT`'s `Duration` | Set a shorter request timeout on the SDK client, and document it |
| C14 | In C10's second invocation, watch the first SQS and S3 calls after the thaw. Count it only as C10 counts | No failed task from a stale socket: the SDK retries | The log: the second `REPORT` in the first's log stream, and no `failed` line | Document it |
| C15 | C6 again, for the records the function already deleted itself beside the one it listed. Count it only as C6 counts | A nonzero `DeletedEventCount` for those: a failed delete emits 0, per AWS. The listed record comes back after the visibility the function set, not 720 s | The metric. The log: `START` times of the listed record | Stop deleting in the handler, as in C1 |
| C16 | The `hang` step with a real Sharp chain in flight and an upload after it: let the function return, invoke again within a minute, and once more with `limits.processingTimeoutSeconds` shorter than the gap | Whether a late S3 PUT and a late Mongo write land after the thaw, as a row a read judges as any other. Whether frozen time counts toward Sharp's limit: it did under `SIGSTOP` on one machine, so the chain failed just after the thaw and its retry rendered it | The bucket, the media's row, the log | Document what you see in the README's `Stopping in time` |
| C17 | A package without `@aws-sdk/*`: log `import.meta.resolve('@aws-sdk/client-sqs')` from `/var/task` at init, then deliver one task | Either it resolves to the runtime's copy, and the docs can say a host need not ship the SDK once its version is checked against the peer range, or the task is refused with `RESIZE_PEER_MISSING`, as the docs assume | The log | Document which, and the runtime's SDK version |
| C18 | SQS's 12 h limit, which counts from the receipt. With `leaseMs: 43200000` on the queue's entry, one good task. Then, with the trigger off (`--no-enabled`): `aws sqs send-message`, `aws sqs receive-message`, wait a minute, and `aws sqs change-message-visibility --visibility-timeout` with its receipt, 43200 and then 39600. AWS's page counts the 12 h from when the message is "first received", so if you can leave it 11 h, ask 39600, receive it again after they pass, and ask 39600 once more. Delete it, and turn the trigger on | The capped adoption is accepted: previews stored, no `lost its receipt` line. At the prompt, 39600 is accepted, and 43200 is refused, with the code `isLostReceipt` reads as a lost receipt (`InvalidParameterValue`), which AWS's page does not name. On the second receive 39600 is accepted too, so each receive starts its own 12 h, as the cap assumes | The log, the media's row, the CLI's answer | Lower the cap in `src/delivery.ts`. A different code, or 43200 accepted: note it in the README's settings table |
| C19 | What a redrive does to the receive count, which AWS's pages do not state. With the trigger off, `aws sqs start-message-move-task --source-arn "$DEAD_ARN" --destination-arn "$QUEUE_ARN"`, for one body SQS moved and one the module wrote (C3): with no destination, AWS fails a message written with `SendMessage` as `CouldNotDetermineMessageSource`. Wait for `aws sqs list-message-move-tasks --source-arn "$DEAD_ARN"` to read `COMPLETED`, then `aws sqs receive-message --queue-url "$QUEUE_URL" --attribute-names ApproximateReceiveCount`. AWS says each is a new message, with a new ID, enqueue time and retention period | The move task reads `COMPLETED`, with both moved. 1 on the first receive, so a redriven task gets all its attempts: the README can then offer a redrive beside `prewarm()`. Delete both, and turn the trigger on | The CLI's answers: `Results[0].Status`, `FailureReason` and `ApproximateNumberOfMessagesMoved`, then `Attributes.ApproximateReceiveCount` | Anything above 1: say in `How a record ends` that a redriven task starts that far along, and keep `prewarm()` as the way |

## Notes

- **No publish workflow on purpose.** Both sibling repos release manually; a tagged-release
  Action can be added later if the team wants it, but it is not part of the house convention today.
- CI caches the `mongod` binary (`~/.cache/mongodb-binaries`) so the mongodb-memory-server
  download doesn't repeat every run; `sharp` needs no handling (prebuilt `@img/sharp-linux-*`
  via `npm ci`).
