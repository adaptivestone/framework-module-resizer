# 05 · Transport & storage

> Part of the [`@adaptivestone/framework-module-resize` build spec](../BUILD-SPEC.md).
> Prev: [04 · Pipelines & hooks](./04-pipelines-and-hooks.md) · Next: [06 · Read & enqueue](./06-read-and-enqueue.md)

The two infrastructure strategies: the queue transport (which also drives the worker) and
storage. Each has exactly one active implementation; `app` is threaded into every method
so the strategies stay stateless.

---

## §10. Queue transport & storage (strategy interfaces)

### 10.1 Transport interface — `enqueue` + `startWorker`

```ts
export interface LeasedTask { taskId: string; mediaId: string; pipeline: string; previews: MissingPreview[]; }

export interface QueueTransport {
  enqueue(app: TMinimalResizeApp, task: { mediaId: string; pipeline: string; previews: MissingPreview[] }):
    Promise<{ taskId: string | null }>;

  // The transport drives consumption its own way (poll OR push). It calls handleTask
  // per task and is responsible for completion/redelivery.
  startWorker(
    app: TMinimalResizeApp,
    // taskOpts.signal aborts THIS task if its lease is lost (best-effort; see `renew`).
    handleTask: (task: LeasedTask, taskOpts?: { signal: AbortSignal }) => Promise<void>,
    opts: { signal: AbortSignal },   // worker-wide shutdown
  ): Promise<void>;
}
```

Exactly **one** transport is active. The worker ([07](./07-worker.md)) just calls
`transport.startWorker(app, (task, taskOpts) => processTask(app, task, taskOpts), { signal })`
(`taskOpts` threads the per-task lease-loss signal — see `handleTask` above). `app` is threaded
so the transport stays stateless and the bootstrap line is
`registerQueueTransport(mongoTransport)`.

> **Delivery is at-least-once** (true of both transports — confirmed for the Mongo
> lease/visibility pattern and SQS). A task may be delivered more than once (lease expiry +
> crash, SQS redelivery). The worker MUST be idempotent — `processTask` re-runs are made safe
> by the existing-preview check ([07 · Worker](./07-worker.md) step 6). See
> [Appendix B](./appendix.md).

### 10.2 Mongo transport (`src/transports/mongo.ts`) — DEFAULT

Backed by a host-scaffolded `ResizeTask` model (see
[08 · Config & scaffold](./08-config-and-scaffold.md)). `lease/complete/fail` are
transport-internal (exported on the mongo object for unit tests; not part of the
interface).

- `enqueue` → `ResizeTask.create({ fileId: mediaId, pipeline, previews, status:'pending', attempts:0 }, { writeConcern:{ w:'majority' } })`,
  returns `{ taskId }`.  *(maps generic `mediaId` → host-owned `fileId`; durable enqueue.)*
- `startWorker` → poll loop: **dead-letter sweep → lease → handleTask (+ heartbeat) → complete (fire `afterTaskComplete`) | fail**,
  sleeping `config.idlePollMs` on an empty lease, until `opts.signal` aborts. `leasedBy =
  "resizer-" + process.pid`. While a task runs, a heartbeat timer calls `renew` every
  `config.leaseMs/2` so a long resize doesn't lose its lease. The `leaseToken` and `attempts`
  needed by `complete`/`fail` are retained from the `lease` result in the loop's **own
  closure** — they are not part of `LeasedTask` and never reach `handleTask`/`processTask`.
- **dead-letter sweep** (each poll, cheap + indexed) — moves crash-looped tasks out of
  rotation (a worker that died never called `fail`, so the task is stuck `processing`):

```ts
// Per-row claim-to-dead so EXACTLY ONE worker fires the observer (updateMany returns only a
// count → can't enumerate; many workers sweep concurrently → updateMany would double-fire).
// findOneAndUpdate is atomic: only the worker whose update matched gets the doc back.
const filter = { status: 'processing', leaseExpiresAt: { $lt: now }, attempts: { $gte: maxAttempts } };
const err = 'max attempts exceeded (crash loop)';
for (;;) {
  const dead = await ResizeTask.findOneAndUpdate(
    filter,
    { $set: { status: 'dead', deadAt: now, error: err } },
    { returnDocument: 'after' },
  );
  if (!dead) break;                                          // none left this poll
  runObservers(app, 'onTaskDeadLettered', dead, new Error(err), {});   // ctx = {} in the worker
}
```

- `lease` → atomic claim of the oldest eligible task (also reclaims a crashed worker's
  expired lease, but **never an exhausted one** — note `attempts: { $lt: maxAttempts }`):

```ts
ResizeTask.findOneAndUpdate(
  { attempts: { $lt: maxAttempts },
    $or: [
      { status: 'pending', $or: [
          { leaseExpiresAt: { $exists: false } },
          { leaseExpiresAt: null },
          { leaseExpiresAt: { $lt: now } } ] },
      { status: 'processing', leaseExpiresAt: { $lt: now } } ] },
  { $set: { status: 'processing', leasedBy, leaseToken: randomToken(),
            leaseExpiresAt: new Date(now + leaseMs) },
    $inc: { attempts: 1 } },
  { sort: { createdAt: 1 }, returnDocument: 'after' },
)
```

The claim mints a fresh random **`leaseToken`** (the fencing token;
`randomToken() = randomBytes(16).toString('hex')`). `complete`/`fail`/`renew`
all filter on `{ _id, leaseToken, status:'processing', leaseExpiresAt:{ $gt: now } }` — a
0-matched update means this worker **lost the lease** (its lease expired and another worker
re-claimed), so it drops the result instead of clobbering the new owner. (Validated against
mongodb-queue's `ack`-token guard and mongomq2 — see [Appendix C1](./appendix.md).)

- `renew(taskId, leaseToken)` → extend the lease: guarded `$set: { leaseExpiresAt: now+leaseMs }`.
  Called by the worker heartbeat. If it **0-matches, the lease was lost** (another worker
  re-claimed). Correctness does **not** depend on stopping the in-flight work: this worker's
  later `complete`/`fail` are fencing-guarded no-ops, and any `$push` it still does writes
  *valid* previews that the new owner's existing-preview check simply reuses (idempotent). The
  transport SHOULD abort the in-flight task to save CPU — `startWorker` aborts the per-task
  `taskOpts.signal`, which `processTask` checks between variants (best-effort, §11) — but a task
  that runs to completion anyway corrupts nothing.
- `complete(taskId, leaseToken)` → guarded `{ status:'completed', completedAt: now }`; on a
  matched update, fire `afterTaskComplete` (skip if 0-matched — the lease was lost).
- `fail(taskId, leaseToken, error)` (retry-with-backoff, then dead-letter): if
  `task.attempts < maxAttempts` → guarded `{ status:'pending', leaseToken: null,
  leaseExpiresAt: new Date(now + backoff(attempts)) }` so the **pending branch only re-claims
  after the backoff elapses** (spaces out poison thrash); fire `onTaskFailed`. Else →
  `{ status:'dead', deadAt: now, error }`, fire `onTaskDeadLettered`. `error` = `String(error).slice(0,1000)`;
  `backoff(n)` = e.g. `min(maxBackoffMs, baseMs * 2**(n-1))`.
- **Retention:** `completed` rows TTL-evict in 24h (`completedAt`); `dead` rows are kept
  ~30 days (`deadAt`, separate TTL) for inspection/replay. Replay is a host op: reset the
  row to `status:'pending'` (see [08 · Config & scaffold](./08-config-and-scaffold.md)).

### 10.3 SQS transport (`src/transports/sqs.ts`) — OPTIONAL

**Config & client.** `sqsTransport` is a singleton object (parallel to `mongoTransport`);
`app` is threaded into every method, so it reads all settings from `config.sqs` (see
[08 · Config](./08-config-and-scaffold.md)): `queueUrl` (required), optional `region` /
`endpoint`. Credentials are **not** config — they resolve via the standard AWS provider chain
(env / instance role). The transport lazily constructs (and memoizes) one `SQSClient` from
`config.sqs` on first use.

- `enqueue` → `SendMessageCommand` to `config.sqs.queueUrl`, body `{ mediaId, pipeline, previews }`; returns `{ taskId: MessageId ?? null }`.
- `startWorker` → `sqs-consumer` `Consumer.create({ queueUrl: config.sqs.queueUrl, sqs: client, handleMessage })`;
  per message parse → `handleTask` → on resolve ack/delete + fire `afterTaskComplete`; on throw,
  fire `onTaskFailed` and let SQS redeliver after the queue's visibility timeout. Wire
  `opts.signal` → `consumer.stop()`.
- **Dead-letter is native** — no module code. The host configures the queue's redrive
  policy (`maxReceiveCount = config.maxAttempts`) with a DLQ; the transport just throws on
  failure, SQS redelivers up to the cap, then moves the message to the DLQ. There is no
  Mongo-style `dead` status or sweep here, so `onTaskDeadLettered` does **not** fire for SQS
  (the host may attach a small consumer to the DLQ to surface it; the module doesn't require it).
- Lazy-load `@aws-sdk/client-sqs` / `sqs-consumer` (dynamic `import()`), so the module
  works without them installed.

### 10.4 Storage interface — `registerStorage`

The one seam that lets the worker (and optional signed-original reads) touch S3 without
importing host helpers. `app` is threaded for parity with the transport.

```ts
export interface ResizeStorage {
  download(app: TMinimalResizeApp, ref: { bucket: string; key: string }): Promise<Buffer | Uint8Array>;
  upload(app: TMinimalResizeApp, args: { bucket: string; key: string; body: Buffer | Uint8Array; contentType: string }):
    Promise<{ bucket: string; key: string }>;
  publicUrl?(app: TMinimalResizeApp, ref: { bucket: string; key: string }): string;           // optional; engine falls back to `${publicURL}/${key}`
  signedUrl?(app: TMinimalResizeApp, ref: { bucket: string; key: string }, ttlSeconds: number): Promise<string>; // optional; owner/admin reads
}
```

Exactly one active. The **read path uses storage only optionally** (for `canUseOriginal`
signed URLs); the **worker requires it** (download + upload) and throws a clear error if
none is registered.
