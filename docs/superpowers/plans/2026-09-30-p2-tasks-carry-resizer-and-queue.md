# P2 — Tasks Carry Their Resizer and Queue: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every queued task records which Resizer created it and which named queue it waits in, so one worker can serve several Resizers, and a worker started for one queue consumes only that queue.

**Architecture:** The transport contract gains an explicit `EnqueueTask` (`resizer`, `queue`, `mediaId`, `pipeline`, `previews`), and `LeasedTask` carries `resizer` and `queue`. `startWorker` takes the queue to consume and an `onEvent` callback. Transports stop calling `getResizer()` and report `completed` / `failed` / `deadLettered` through that callback. The worker entry (`worker.ts`) looks up `task.resizer` in the registry, runs the task with that Resizer, and routes events to that Resizer's observers. A Resizer has a default queue (`queue` option, default `'default'`), and `resolve` / `prewarm` / `enqueueRequired` accept a per-call `queue`. P1's "only the default Resizer may have a transport" rule is removed.

**Tech Stack:** Node ≥ 24, TypeScript 7 (`erasableSyntaxOnly`, ESM, `.ts` specifiers), `node:test`, Biome, mongoose 9 (tests: `mongodb-memory-server`), `sqs-consumer`.

**Spec:** [`docs/design/2026-09-30-multi-resizer.md`](../../design/2026-09-30-multi-resizer.md): decisions D3, D4 and D6, and the P2 section of §6. Builds on P1 ([plan](2026-09-30-p1-resizer-owns-context.md)).

## Global Constraints

- The module is pre-release: breaking API changes are allowed and ship without data migrations. Rows or messages without `resizer` / `queue` are read as `'default'`; that is a default, not a migration.
- Every task ends with `npm run types:check`, `npm run check`, `npm run build`, `npm test`, `npm run smoke` all passing.
- No new runtime dependencies. No test-only code paths in shipped modules (`resetResizerForTests()` is the only test hook).
- Core files (`engine.ts`, `enqueue.ts`, `images.ts`, `original.ts`, `resizeTask.ts`, `formatPictureUrls.ts`) must keep passing `src/architecture.test.ts`: no `getApp`, `getResizeConfig`, or `getResizer` value imports.
- Transports (`src/transports/*`) must not import `getResizer` after this phase.
- New comments state reasons in plain words; no archived-spec section references.
- Public repository: never name private host projects. Commit messages: conventional prefix, no `Co-Authored-By`, no AI attribution.
- Out of scope: the preview identity and lock keys (P3), moving framework code to an adapter and transport timing options (P4).

## Review Focus

1. A task naming a Resizer that is not registered in the worker process (for example, the API has a `listings` Resizer and the worker forgot to construct it) → the task fails with `ResizeSetupError` `RESIZE_NO_RESIZER`, retries, and dead-letters. It is never processed by another Resizer. (Test: Task 5.)
2. A worker started with `--queue=bulk` must not take `default` tasks, and a worker with no flag must not take `bulk` tasks. (Test: Task 3.)
3. The same request queued on two different queues must create two tasks, not dedupe onto the other queue's task. Otherwise an interactive request would wait behind a bulk backfill. (Test: Task 2 request key, Task 3 enqueue.)
4. Resizers in one worker process with *different* transport instances → the worker refuses to start with a clear error instead of silently ignoring some of them. (Test: Task 5.)
5. An `onEvent` callback that throws (for example, a host observer bug) must not break task completion or the worker loop. (Test: Task 3.)

---

## File Structure

| File | Change | Responsibility after P2 |
|---|---|---|
| `src/transports/AbstractTransport.ts` | Modify | `EnqueueTask`, `LeasedTask` (+`resizer`, `queue`), `TaskEvent`, `StartWorkerOpts`, `QueueTransport`. |
| `src/resizer.ts` | Modify | `queue` option; `listResizers()`; the P1 transport restriction removed. |
| `src/enqueue.ts` | Modify | `buildRequestKey` covers resizer + queue; `enqueue` / `enqueueConfirmed` send `EnqueueTask`. |
| `src/engine.ts` | Modify | `queue?` on `ResolveOpts` / `PrewarmOpts` (and so `EnqueueRequiredOpts`). |
| `src/models/ResizeTask.ts`, `src/scaffold/templates/ResizeTask.model.full.ts.tpl` | Modify | `resizer` and `queue` fields; lease index includes `queue`. |
| `src/transports/mongo.ts` | Modify | Queue-filtered lease; `onEvent` instead of `getResizer()`; `findActive` by resizer. |
| `src/transports/sqs.ts` | Modify | `queues` map; body carries resizer + queue; `onEvent`. |
| `src/worker.ts` | Modify | `runResizeWorker({ queue })`: one transport, per-task Resizer routing, event routing. |
| `src/commands/ResizeWorker.ts` | Modify | `--queue` argument. |
| Tests | Modify/Create | `resizer.test.ts`, `enqueue.test.ts`, `transports/mongo.test.ts`, `transports/sqs.test.ts`, `resizeTask.test.ts`, `queueIndexes.mongo.integration.test.ts`, new `worker.mongo.integration.test.ts`. |
| `README.md`, `AGENTS.md`, `CHANGELOG.md` | Modify | Queues, multi-Resizer workers, transport contract. |

---

### Task 1: Resizer default queue, registry listing, and lifting the P1 restriction

**Files:**
- Modify: `src/resizer.ts`
- Test: `src/resizer.test.ts`

**Interfaces:**
- Produces: `ResizerOptions.queue?: string` (default `'default'`); `Resizer.queue: string`; `listResizers(): Resizer[]` (registration order); error code `RESIZE_QUEUE_INVALID`. `RESIZE_NAMED_TRANSPORT_UNSUPPORTED` no longer exists.

- [ ] **Step 1: Write the failing tests** in `src/resizer.test.ts` (inside `describe('Resizer registry', …)`). Delete the P1 test `only the default Resizer may have a transport until tasks record their Resizer`, and add:

```ts
  test('a named Resizer may have a transport', () => {
    const transport = fakeTransport();
    const listings = new Resizer({ ...baseOpts(), name: 'listings', transport });
    assert.equal(listings.transport, transport);
  });

  test('queue defaults to "default" and can be set per Resizer', () => {
    const media = new Resizer(baseOpts());
    const bulk = new Resizer({ ...baseOpts(), name: 'bulk', queue: 'bulk' });
    assert.equal(media.queue, 'default');
    assert.equal(bulk.queue, 'bulk');
  });

  test('an empty queue name is rejected', () => {
    assert.throws(
      () => new Resizer({ ...baseOpts(), queue: '' }),
      (err: unknown) =>
        err instanceof ResizeSetupError && err.code === 'RESIZE_QUEUE_INVALID',
    );
  });

  test('listResizers() returns every registered Resizer in construction order', () => {
    const a = new Resizer(baseOpts());
    const b = new Resizer({ ...baseOpts(), name: 'b' });
    assert.deepEqual(listResizers(), [a, b]);
    resetResizerForTests();
    assert.deepEqual(listResizers(), []);
  });
```

Add `listResizers` to the `./resizer.ts` import.

- [ ] **Step 2: Run** `node --experimental-strip-types --test src/resizer.test.ts`. Expected: FAIL (the named-transport restriction throws, and `queue` / `listResizers` do not exist).

- [ ] **Step 3: Implement** in `src/resizer.ts`:
1. Delete the `RESIZE_NAMED_TRANSPORT_UNSUPPORTED` check and its comment.
2. Add `queue?: string; // default queue for this Resizer's tasks; default 'default'` to `ResizerOptions`, and a `readonly queue: string;` field.
3. In the constructor, after the name checks:

```ts
    const queue = opts.queue ?? 'default';
    if (typeof queue !== 'string' || queue.trim().length === 0) {
      throw new ResizeSetupError('resize: `queue` must be a non-empty string', {
        code: 'RESIZE_QUEUE_INVALID',
      });
    }
```

and `this.queue = queue;` next to `this.name = name;`.

4. After `getResizer`, add:

```ts
/** Every registered Resizer, in construction order (the worker serves all of them). */
export function listResizers(): Resizer[] {
  return [...resizers.values()];
}
```

- [ ] **Step 4: Run** the test file. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: named Resizers may queue work and set a default queue"`

---

### Task 2: Transport contract and request key carry the resizer and queue

**Files:**
- Modify: `src/transports/AbstractTransport.ts`, `src/enqueue.ts`, `src/engine.ts`, `src/types.d.ts` (only if `EnqueueReceipt` needs no change — it does not)
- Test: `src/enqueue.test.ts`, `src/enqueueRequired.test.ts`, `src/prewarm.test.ts`, `src/engine.test.ts`

**Interfaces:**
- Produces (in `src/transports/AbstractTransport.ts`, replacing the current contents below the header comment):

```ts
import type { EnqueueReceipt, MissingPreview } from '../types.d.ts';

/** What a Resizer hands to a transport. `resizer` and `queue` route the task later. */
export interface EnqueueTask {
  resizer: string;
  queue: string;
  mediaId: string;
  pipeline: string;
  previews: MissingPreview[];
}

/** A task a worker is processing. Rows/messages written without resizer/queue read as 'default'. */
export interface LeasedTask {
  taskId: string;
  resizer: string;
  queue: string;
  mediaId: string;
  pipeline: string;
  previews: MissingPreview[];
}

export type TaskEvent = 'completed' | 'failed' | 'deadLettered';

export type TaskEventHandler = (
  event: TaskEvent,
  task: LeasedTask,
  error?: unknown,
) => void | Promise<void>;

export interface StartWorkerOpts {
  signal: AbortSignal; // worker-wide graceful shutdown
  queue: string; // consume only this queue
  onEvent?: TaskEventHandler; // completion/failure/dead-letter reports; errors it throws are logged
}

export interface QueueTransport {
  enqueue(task: EnqueueTask): Promise<{ taskId: string | null }>;

  // Optional strict-enqueue capability: active tasks (any queue) of this resizer + media +
  // pipeline whose payload can prove coverage. Transports without queryable state omit it.
  findActive?(task: EnqueueTask): Promise<EnqueueReceipt[]>;

  // The transport drives consumption its own way (poll or push) for ONE queue. It calls
  // handleTask per task and owns completion/redelivery; taskOpts.signal aborts this task if its
  // lease is lost; opts.signal is worker-wide shutdown.
  startWorker(
    handleTask: (
      task: LeasedTask,
      taskOpts?: { signal: AbortSignal },
    ) => Promise<void>,
    opts: StartWorkerOpts,
  ): Promise<void>;
}
```

- `buildRequestKey(task: { mediaId; resizer; queue; pipeline; previews }): string` returns `v2:<sha256>` over `{ fileId, resizer, queue, pipeline, variants }`.
- `enqueue(resizer, mediaId, pipeline, missing, queue)` and `enqueueConfirmed(resizer, mediaId, pipeline, missing, queue)` gain a final `queue: string` parameter.
- `ResolveOpts.queue?`, `PrewarmOpts.queue?` (and therefore `EnqueueRequiredOpts.queue?`), defaulting to `resizer.queue`.
- Re-export the new types from `src/resizer.ts` next to `LeasedTask` / `QueueTransport` (`export type { EnqueueTask, LeasedTask, QueueTransport, StartWorkerOpts, TaskEvent, TaskEventHandler }`), so they reach the main entry.

- [ ] **Step 1: Write the failing tests.** In `src/enqueue.test.ts`, add:

```ts
describe('buildRequestKey', () => {
  const previews = [{ sizeKey: '300x300', format: 'webp' }];
  const base = { mediaId: 'm1', resizer: 'default', queue: 'default', pipeline: 'default', previews };

  test('is stable and versioned', () => {
    assert.match(buildRequestKey(base), /^v2:[0-9a-f]{64}$/);
    assert.equal(buildRequestKey(base), buildRequestKey({ ...base }));
  });

  test('differs by resizer and by queue', () => {
    const key = buildRequestKey(base);
    assert.notEqual(buildRequestKey({ ...base, resizer: 'listings' }), key);
    assert.notEqual(buildRequestKey({ ...base, queue: 'bulk' }), key);
  });
});
```

And a test that `enqueue` hands the transport the resizer name and queue (use the file's existing fake transport that records `enqueue` calls):

```ts
test('enqueue sends the resizer name and the given queue', async () => {
  // construct a Resizer named 'listings' with a recording transport, then:
  await enqueue(resizer, 'm1', 'default', [{ sizeKey: '300x300', format: 'webp' }], 'bulk');
  assert.deepEqual(
    { resizer: calls[0].resizer, queue: calls[0].queue },
    { resizer: 'listings', queue: 'bulk' },
  );
});
```

(Adapt the Resizer and recording-transport construction to the helpers already in `enqueue.test.ts`.) In `src/prewarm.test.ts`, add a test that `prewarm` without `queue` sends `resizer.queue`, and with `queue: 'bulk'` sends `'bulk'`.

- [ ] **Step 2: Run** those test files. Expected: FAIL (`buildRequestKey` takes positional arguments; no `queue`).

- [ ] **Step 3: Implement.**
1. Replace `src/transports/AbstractTransport.ts` below its header comment with the Interfaces block above.
2. `src/enqueue.ts`: change `buildRequestKey` to take one object and hash `JSON.stringify({ fileId: task.mediaId, resizer: task.resizer, queue: task.queue, pipeline: task.pipeline, variants: canonical })` with the `v2:` prefix. Update the doc comment: the key includes the resizer and queue, so the same request on another queue is a separate task.
3. `enqueue(...)` and `enqueueConfirmed(...)`: add the `queue: string` parameter and call `transport.enqueue({ resizer: resizer.name, queue, mediaId, pipeline, previews })`. `findActive` gets the same object.
4. `src/engine.ts`: add `queue?: string; // queue for missing variants; default resizer.queue` to `ResolveOpts` and `PrewarmOpts`, and pass `opts.queue ?? resizer.queue` at the three enqueue call sites (`resolveImpl`, `prewarmImpl`, `enqueueRequiredImpl`).
5. `src/resizer.ts`: extend the transport type re-exports as listed in Interfaces.
6. Update every other caller of `buildRequestKey` (the Mongo transport: Task 3 finishes it; for now pass `{ mediaId, resizer, queue, pipeline, previews }` from its `enqueue` argument).

- [ ] **Step 4: Run** `npm run types:check`, then the four test files. Expected: PASS. Existing tests that call `buildRequestKey(mediaId, pipeline, variants)` or construct `LeasedTask` objects without `resizer`/`queue` must be updated to the new shapes (add `resizer: 'default', queue: 'default'`).
- [ ] **Step 5: Commit** — `git commit -m "feat: queued tasks carry their resizer and queue"`

---

### Task 3: Mongo transport — queue-filtered lease and event callback

**Files:**
- Modify: `src/models/ResizeTask.ts`, `src/scaffold/templates/ResizeTask.model.full.ts.tpl`, `src/transports/mongo.ts`
- Test: `src/transports/mongo.test.ts`, `src/models/ResizeTask.test.ts`, `src/queueIndexes.mongo.integration.test.ts`

**Interfaces:**
- Consumes: `EnqueueTask`, `LeasedTask`, `StartWorkerOpts`, `TaskEventHandler`, `buildRequestKey(task)` (Task 2).
- Produces (public lifecycle methods used by tests):
  - `lease(queue = 'default'): Promise<TaskDoc | null>`
  - `complete(taskId, leaseToken, onEvent?: TaskEventHandler): Promise<boolean>`
  - `fail(taskId, leaseToken, error, attempts, onEvent?: TaskEventHandler): Promise<void>`
  - `sweepDeadLetters(onEvent?: TaskEventHandler): Promise<void>`
  - `startWorker(handleTask, { signal, queue, onEvent })`.

- [ ] **Step 1: Schema and indexes.** In `src/models/ResizeTask.ts` add, after `pipeline`:

```ts
      resizer: { type: String, default: 'default' },
      queue: { type: String, default: 'default' },
```

and replace the lease index `schema.index({ status: 1, createdAt: 1 });` with `schema.index({ queue: 1, status: 1, createdAt: 1 });`. Make the same two edits in `src/scaffold/templates/ResizeTask.model.full.ts.tpl`. Leave the partial unique index `{ fileId, pipeline, requestKey }` unchanged: `requestKey` now covers resizer and queue. Update `src/models/ResizeTask.test.ts` and the exact-index assertions in `src/queueIndexes.mongo.integration.test.ts` to the new lease index keys.

- [ ] **Step 2: Write the failing transport tests.** In `src/transports/mongo.test.ts`, replace the hook-recording `makeResizer()` harness with an event recorder, and keep a plain Resizer construction where a test needs one:

```ts
interface Rec {
  completed: unknown[][];
  failed: unknown[][];
  dead: unknown[][];
  onEvent: TaskEventHandler;
}
function makeEvents(): Rec {
  const rec = { completed: [], failed: [], dead: [] } as unknown as Rec;
  rec.onEvent = (event, task, error) => {
    const row = error === undefined ? [task] : [task, error];
    if (event === 'completed') rec.completed.push(row);
    if (event === 'failed') rec.failed.push(row);
    if (event === 'deadLettered') rec.dead.push(row);
  };
  return rec;
}
```

Update every existing `complete` / `fail` / `sweepDeadLetters` / `startWorker` test to pass `rec.onEvent` (and `queue: 'default'` for `startWorker`), and to assert on `rec.*` as before. Observer payloads are now `[task]` / `[task, error]` (no trailing `{}` context). Then add:

```ts
describe('MongoTransport queues', () => {
  test('lease takes only the requested queue; rows without a queue read as default', async () => {
    await insert({ queue: 'bulk' }, past());
    const legacy = await insert({}, past());
    await M.collection.updateOne({ _id: legacy._id }, { $unset: { queue: '', resizer: '' } });

    const fromDefault = await transport.lease('default');
    assert.equal(String(fromDefault?._id), String(legacy._id));
    const fromBulk = await transport.lease('bulk');
    assert.equal(fromBulk?.queue, 'bulk');
    assert.equal(await transport.lease('default'), null);
  });

  test('enqueue stores resizer and queue, and one request on two queues is two tasks', async () => {
    const task = {
      resizer: 'listings',
      mediaId: String(new mongoose.Types.ObjectId()),
      pipeline: 'default',
      previews: [{ sizeKey: '300x300', format: 'webp' }],
    };
    const a = await transport.enqueue({ ...task, queue: 'default' });
    const b = await transport.enqueue({ ...task, queue: 'bulk' });
    const again = await transport.enqueue({ ...task, queue: 'default' });
    assert.notEqual(a.taskId, b.taskId);
    assert.equal(again.taskId, a.taskId);
    const row = await M.findById(b.taskId).lean();
    assert.equal(row?.resizer, 'listings');
    assert.equal(row?.queue, 'bulk');
  });

  test('a leased task reports its resizer and queue', async () => {
    await insert({ resizer: 'listings', queue: 'bulk' }, past());
    const rec = makeEvents();
    const doc = await transport.lease('bulk');
    assert.ok(doc);
    await transport.complete(String(doc._id), String(doc.leaseToken), rec.onEvent);
    const [[task]] = rec.completed as [[LeasedTask]];
    assert.equal(task.resizer, 'listings');
    assert.equal(task.queue, 'bulk');
  });

  test('a throwing onEvent does not undo completion', async () => {
    await insert({}, past());
    const doc = await transport.lease('default');
    assert.ok(doc);
    const held = await transport.complete(String(doc._id), String(doc.leaseToken), () => {
      throw new Error('observer bug');
    });
    assert.equal(held, true);
    const row = await M.findById(doc._id).lean();
    assert.equal(row?.status, 'completed');
  });
});
```

Also add to the existing `findActive` coverage: a task for resizer `'listings'` is not returned for `findActive({ resizer: 'default', … })`.

- [ ] **Step 3: Run** `node --experimental-strip-types --test src/transports/mongo.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement** in `src/transports/mongo.ts`:
1. Remove the `getResizer` import. Add `resizer?: string; queue?: string;` to `TaskDoc`.
2. `toLeasedTask`: add `resizer: doc.resizer ?? 'default', queue: doc.queue ?? 'default'`.
3. Add a helper that matches a named value, where a missing field counts as `'default'`:

```ts
// Rows written before tasks carried a resizer/queue have neither field; they belong to
// 'default'. `$in` with null matches a missing field.
function named(value: string) {
  return value === 'default' ? { $in: ['default', null] } : value;
}
```

4. `lease(queue = 'default')`: add `queue: named(queue)` to the top level of the filter.
5. Add a private helper that runs the callback and logs its errors:

```ts
async function report(
  onEvent: TaskEventHandler | undefined,
  event: TaskEvent,
  task: LeasedTask,
  error?: unknown,
): Promise<void> {
  if (!onEvent) {
    return;
  }
  try {
    await onEvent(event, task, error);
  } catch (err) {
    getApp().logger.error(`resize mongo transport: ${event} event handler failed`, err);
  }
}
```

6. `complete(taskId, leaseToken, onEvent?)`: replace `getResizer().runObservers('afterTaskComplete', …)` with `await report(onEvent, 'completed', toLeasedTask(doc));`. `fail(…, attempts, onEvent?)`: `report(onEvent, 'failed', toLeasedTask(doc), error)` and `report(onEvent, 'deadLettered', toLeasedTask(doc), error)`. `sweepDeadLetters(onEvent?)`: `report(onEvent, 'deadLettered', toLeasedTask(dead), new Error(err))`.
7. `enqueue(task: EnqueueTask)`: set `resizer: task.resizer, queue: task.queue` in `$setOnInsert`, and compute `buildRequestKey({ mediaId: task.mediaId, resizer: task.resizer, queue: task.queue, pipeline: task.pipeline, previews })`.
8. `findActive(task: EnqueueTask)`: add `resizer: named(task.resizer)` to the query (any queue).
9. `startWorker(handleTask, opts: StartWorkerOpts)`: call `this.sweepDeadLetters(opts.onEvent)`, `this.lease(opts.queue)`, and pass `opts.onEvent` to every `complete` / `fail` call.

- [ ] **Step 5: Run** the transport tests, `src/models/ResizeTask.test.ts` and `src/queueIndexes.mongo.integration.test.ts`. Expected: PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat: Mongo transport leases by queue and reports task events"`

---

### Task 4: SQS transport — queue map and event callback

**Files:**
- Modify: `src/transports/sqs.ts`
- Test: `src/transports/sqs.test.ts`

**Interfaces:**
- Produces: `SqsTransportOptions.queues?: Record<string, string>` (queue name → queue URL; `queueUrl` stays required and serves `'default'`). An unknown queue name throws `ResizeSetupError` with code `RESIZE_SQS_QUEUE_UNKNOWN`, in both `enqueue` and `startWorker`. The message body is `{ resizer, queue, mediaId, pipeline, previews }`.

- [ ] **Step 1: Write the failing tests** in `src/transports/sqs.test.ts` (use its existing fake `client` that records `send` commands and its consumer harness):
  - `enqueue({ resizer: 'listings', queue: 'bulk', … })` with `queues: { bulk: BULK_URL }` sends to `BULK_URL`, and the body contains `resizer: 'listings'` and `queue: 'bulk'`.
  - `enqueue` with `queue: 'default'` sends to `queueUrl`.
  - `enqueue` with an unknown queue rejects with `ResizeSetupError` code `RESIZE_SQS_QUEUE_UNKNOWN`.
  - `startWorker(handle, { signal, queue: 'bulk', onEvent })` consumes `BULK_URL` (observe the `QueueUrl` of the receive command).
  - A message body without `resizer` / `queue` becomes a task with `resizer: 'default'` and the consumed queue name.
  - Handler success calls `onEvent('completed', task)`; a handler throw calls `onEvent('failed', task, err)` and rethrows; a throwing `onEvent` is logged and does not change the ack/redelivery outcome.
  Replace the existing observer assertions (via Resizer hooks) with `onEvent` recordings.

- [ ] **Step 2: Run** `node --experimental-strip-types --test src/transports/sqs.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** in `src/transports/sqs.ts`:
1. Remove the `getResizer` import; import `ResizeSetupError` from `../errors.ts` and the new contract types.
2. Add `queues?: Record<string, string>; // extra named queues → queue URLs; queueUrl serves 'default'` to the options.
3. Add:

```ts
  #queueUrl(queue: string): string {
    const url = queue === 'default' ? this.#opts.queueUrl : this.#opts.queues?.[queue];
    if (!url) {
      throw new ResizeSetupError(
        `resize sqs: no queue URL for queue '${queue}' — add it to the SqsTransport \`queues\` option`,
        { code: 'RESIZE_SQS_QUEUE_UNKNOWN' },
      );
    }
    return url;
  }
```

4. `enqueue(task: EnqueueTask)`: `QueueUrl: this.#queueUrl(task.queue)` and body `JSON.stringify({ resizer: task.resizer, queue: task.queue, mediaId: task.mediaId, pipeline: task.pipeline, previews: task.previews })`.
5. `startWorker(handleTask, opts: StartWorkerOpts)`: `queueUrl: this.#queueUrl(opts.queue)`. Parse `resizer` and `queue` from the body with `?? 'default'` and `?? opts.queue`. Replace both `getResizer().runObservers(…)` calls with a local `report(event, task, error?)` that awaits `opts.onEvent` inside a try/catch that logs `resize sqs: ${event} event handler failed`.

- [ ] **Step 4: Run** the test file. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: SQS transport routes named queues and reports task events"`

---

### Task 5: The worker serves every Resizer, for one queue

**Files:**
- Modify: `src/worker.ts`, `src/commands/ResizeWorker.ts`, `src/scaffold/command.ts` only if it documents worker flags (check with `grep -n "ResizeWorker" src/scaffold/command.ts`)
- Test: `src/resizeTask.test.ts` (`runResizeWorker` describe), new `src/worker.mongo.integration.test.ts`

**Interfaces:**
- Consumes: `listResizers()`, `getResizer(name)`, `processTaskWith(resizer, task, opts)`, `QueueTransport.startWorker(handle, { signal, queue, onEvent })`.
- Produces:
  - `runResizeWorker(opts?: { queue?: string }): Promise<void>` (queue default `'default'`).
  - `processTask(task, taskOpts?)` runs `task.resizer`'s Resizer (unknown name → `RESIZE_NO_RESIZER`).
  - `ResizeWorker.commandArguments` = `{ queue: { type: 'string', description: … } }`.
  - Error code `RESIZE_WORKER_TRANSPORTS_DIFFER`.

Behavior of `runResizeWorker`, in order:
1. Read `worker` settings from the framework config (`getResizeConfig().worker`, unchanged). If `enabled === false`, log and return (unchanged).
2. `const resizers = listResizers()`. If empty → throw `ResizeSetupError` `RESIZE_NO_RESIZER` ("construct your Resizers before starting the worker").
3. Collect the distinct `transport` instances of the Resizers that have one. None → log the existing "constructed without a transport" error and return. More than one → throw `ResizeSetupError` `RESIZE_WORKER_TRANSPORTS_DIFFER` ("every Resizer served by one worker must share one transport instance; run one worker process per transport").
4. `await r.mediaStore.verify?.()` for every Resizer (a misconfigured store stops the worker before leasing).
5. Tune Sharp as today, wire SIGTERM/SIGINT as today.
6. `transport.startWorker(handler, { signal, queue, onEvent })`, where:

```ts
const handler = (task: LeasedTask, taskOpts?: { signal: AbortSignal }) =>
  processTaskWith(getResizer(task.resizer), task, taskOpts);

const OBSERVER: Record<TaskEvent, ObserverName> = {
  completed: 'afterTaskComplete',
  failed: 'onTaskFailed',
  deadLettered: 'onTaskDeadLettered',
};
const onEvent: TaskEventHandler = async (event, task, error) => {
  const resizer = listResizers().find((r) => r.name === task.resizer);
  if (!resizer) {
    app.logger.error(`resize worker: ${event} for task ${task.taskId} of unknown Resizer '${task.resizer}'`);
    return;
  }
  const args = event === 'completed' ? [task, {}] : [task, error, {}];
  await resizer.runObservers(OBSERVER[event], ...args);
};
```

(Observers keep their existing signatures: `afterTaskComplete(task, ctx)`, `onTaskFailed(task, error, ctx)`, `onTaskDeadLettered(task, error, ctx)`.)

`ResizeWorker` command:

```ts
  static get commandArguments() {
    return {
      queue: {
        type: 'string',
        description: "Queue to consume (default 'default'). Tasks on other queues are left for their own workers.",
      },
    };
  }

  async run(): Promise<boolean> {
    const queue = (this.args as { queue?: string } | undefined)?.queue;
    await runResizeWorker(queue === undefined ? {} : { queue });
    return true;
  }
```

- [ ] **Step 1: Write the failing unit tests** in `src/resizeTask.test.ts` (`describe('runResizeWorker', …)`):
  - Two Resizers (`'default'` and `'listings'`) sharing one fake transport. The transport captures `handle` and `opts`. Assert that `opts.queue === 'default'`, and that driving `handle(task({ resizer: 'listings', … }))` loads media through the `listings` Resizer's media store (give each Resizer its own recording media store).
  - `runResizeWorker({ queue: 'bulk' })` passes `queue: 'bulk'` to `startWorker`.
  - Two Resizers with *different* transport objects → rejects with `RESIZE_WORKER_TRANSPORTS_DIFFER`, and neither `startWorker` is called.
  - `opts.onEvent('completed', task({ resizer: 'listings' }))` fires the `listings` Resizer's `afterTaskComplete` hook, not the default Resizer's.
  - A handler run for `task({ resizer: 'ghost' })` rejects with `RESIZE_NO_RESIZER`.
  - `ResizeWorker.commandArguments.queue.type === 'string'`, and `new ResizeWorker({}, {}, { queue: 'bulk' }).run()` passes `'bulk'` (use a fake transport and assert the captured `opts.queue`).
  - Update the P1 test `a worker with no default Resizer fails before leasing`: a single named Resizer with a transport is now served normally. Replace it with `a worker with no Resizers fails before leasing` (`resetResizerForTests()`, then `runResizeWorker()` rejects with `RESIZE_NO_RESIZER`).
  - Update the `task(…)` helper to include `resizer: 'default', queue: 'default'` by default.

- [ ] **Step 2: Write the integration test** `src/worker.mongo.integration.test.ts`, modeled on `queueIndexes.mongo.integration.test.ts`: a `MongoMemoryServer`, a real `ResizeTask` model, fake media models, and in-memory storage whose `download` returns a tiny PNG made with sharp. Cases:
  - Two Resizers (`default` → media model `File`, `listings` → media model `Photo`) share one `MongoTransport`. `prewarm` on each, then run the worker (`runResizeWorker()` with an AbortController signal stopped once both media docs have previews). Each media doc receives its previews, stored through its own Resizer's storage.
  - A task enqueued on `'bulk'` is untouched by `runResizeWorker()` (queue `default`), and `runResizeWorker({ queue: 'bulk' })` processes it.

  Stop the worker through the transport, not through process signals (the test runner may listen to them). Give both Resizers the same small wrapper object as their `transport`. It is plain host code implementing `QueueTransport`, so it needs no test-only option in the module:

```ts
const real = new MongoTransport();
const stop = new AbortController();
const transport: QueueTransport = {
  enqueue: (task) => real.enqueue(task),
  findActive: (task) => real.findActive(task),
  startWorker: (handle, opts) =>
    real.startWorker(handle, { ...opts, signal: AbortSignal.any([opts.signal, stop.signal]) }),
};
// … run `const done = runResizeWorker()`, wait until the media docs have previews, then:
stop.abort();
await done;
```

- [ ] **Step 3: Run** both test files. Expected: FAIL.
- [ ] **Step 4: Implement** `src/worker.ts` and `src/commands/ResizeWorker.ts` as specified. `processTask(task, opts)` becomes `processTaskWith(getResizer(task.resizer), task, opts)`.
- [ ] **Step 5: Run** the full suite: `npm run types:check && npm run check && npm run build && npm test && npm run smoke`. Expected: all green.
- [ ] **Step 6: Commit** — `git commit -m "feat: one worker serves every Resizer for one named queue"`

---

### Task 6: Documentation

**Files:**
- Modify: `README.md`, `AGENTS.md`, `CHANGELOG.md`, `docs/design/2026-09-30-multi-resizer.md` (mark P1 and P2 done in §6)
- Framework docs site: done by the supervisor in the docs repository; not part of this task.

- [ ] **Step 1: README.**
  - Remove P1's sentence "For now only the default Resizer can have a `transport`…".
  - Add a "Named queues" subsection under the lazy/queue section: each task records its Resizer and queue; a `queue` option on the Resizer (default `'default'`) and per call; `npm run cli ResizeWorker` consumes `default` only, and `-- --queue=bulk` consumes `bulk` only; one worker serves every Resizer in its process, and they must share one transport instance; SQS needs a `queues: { bulk: url }` map; the same request on two queues is two tasks.
  - In the custom-driver section, document the new `QueueTransport` contract (`EnqueueTask`, `startWorker(handle, { signal, queue, onEvent })`, and that transports report events instead of calling observers).
- [ ] **Step 2: AGENTS.md.** Replace the P1 "Only the default Resizer may have a `transport` for now." sentence with: "Every task records its Resizer and queue; a worker serves all Resizers in its process for one queue (`--queue`, default `default`)." Add a troubleshooting row: "`RESIZE_NO_RESIZER` in worker logs for a task | the worker process did not construct that Resizer; construct every Resizer in both API and worker processes".
- [ ] **Step 3: CHANGELOG** (`# Unreleased`):
  - **Breaking:** `QueueTransport` contract (`EnqueueTask`, `LeasedTask.resizer` / `queue`, `startWorker` options `{ signal, queue, onEvent }`, transports report events instead of firing observers); `buildRequestKey` is `v2` and covers resizer and queue; `ResizeTask` gains `resizer` / `queue` and the lease index becomes `{ queue, status, createdAt }` (recreate indexes).
  - **Features:** named queues; `ResizeWorker --queue`; SQS `queues` map; one worker serves every Resizer; named Resizers may have a transport.
- [ ] **Step 4: Design doc.** In §6, add "Status: done" lines under P1 and P2.
- [ ] **Step 5: Run** `npm run build && npm test && npm run check`. Expected: PASS.
- [ ] **Step 6: Commit** — `git commit -m "docs: named queues and multi-Resizer workers"`

---

## Definition of done (P2)

- A task records its Resizer and queue on Mongo and SQS; rows or messages without them read as `'default'`.
- One worker process serves every registered Resizer for one queue; `--queue` selects it; queues are isolated.
- Transports contain no `getResizer` import; events reach the owning Resizer's observers.
- The same request on two queues is two tasks; on one queue it dedupes.
- All checks pass; README, AGENTS.md, CHANGELOG and the design doc describe the new behavior.
