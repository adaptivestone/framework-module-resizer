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
  sleeping `config.queue.idlePollMs` on an empty lease, until `opts.signal` aborts. `leasedBy =
  "resizer-" + process.pid`. While a task runs, a heartbeat timer calls `renew` every
  `config.queue.leaseMs/2` so a long resize doesn't lose its lease. The `leaseToken` and `attempts`
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

**Driver-owned options.** `sqsTransport` is a **factory** (not a singleton): the host calls
`registerQueueTransport(sqsTransport({ queueUrl, region?, endpoint? }))` at bootstrap and the
returned transport closes over those options — they are **not** in `ResizeConfig`. `queueUrl`
is required; `region` / `endpoint` are optional. Credentials are **never** options — they
resolve via the standard AWS provider chain (env / instance role). The transport lazily
constructs (and memoizes) one `SQSClient` from its options on first use.

```ts
export function sqsTransport(opts: { queueUrl: string; region?: string; endpoint?: string }): QueueTransport;
```

- `enqueue` → `SendMessageCommand` to `opts.queueUrl`, body `{ mediaId, pipeline, previews }`; returns `{ taskId: MessageId ?? null }`.
- `startWorker` → `sqs-consumer` `Consumer.create({ queueUrl: opts.queueUrl, sqs: client, handleMessage })`;
  per message parse → `handleTask` → on resolve ack/delete + fire `afterTaskComplete`; on throw,
  fire `onTaskFailed` and let SQS redeliver after the queue's visibility timeout. Wire
  `opts.signal` → `consumer.stop()`.
- **Dead-letter is native** — no module code. The host configures the queue's redrive
  policy (`maxReceiveCount = config.queue.maxAttempts`) with a DLQ; the transport just throws on
  failure, SQS redelivers up to the cap, then moves the message to the DLQ. There is no
  Mongo-style `dead` status or sweep here, so `onTaskDeadLettered` does **not** fire for SQS
  (the host may attach a small consumer to the DLQ to surface it; the module doesn't require it).
- Lazy-load `@aws-sdk/client-sqs` / `sqs-consumer` (dynamic `import()`), so the module
  works without them installed.

> The Mongo transport (`mongoTransport`) needs **no options** — it uses the host-scaffolded
> `ResizeTask` model and the lease/retry knobs under `config.queue` — so it stays a plain
> singleton: `registerQueueTransport(mongoTransport)`.

### 10.4 Storage interface — `registerStorage`

The one seam that lets the worker (and the read path's URL building) reach storage without
the module importing host helpers or knowing what a "bucket" is. **The driver owns all
storage-specific options** (buckets, base URL, region, credentials) — they live in the driver,
not `ResizeConfig`. Storage is **host-implemented** (the host writes a small object closing
over its own S3/GCS/filesystem client + buckets); the module ships only this interface. `app`
is threaded for parity with the transport.

```ts
// StorageRef is the opaque locator the driver round-trips onto the document (02 · §5).
// `key` is always present; `bucket` is S3-specific and may be absent for other drivers.
export interface ResizeStorage {
  // Download an existing object by its stored locator (the worker's original; rarely a re-read).
  download(app: TMinimalResizeApp, ref: StorageRef): Promise<Buffer | Uint8Array>;

  // Upload a NEW object. The module supplies the logical `key` + `visibility`; the DRIVER
  // decides physical placement (which bucket / base dir) and returns the locator to persist.
  upload(
    app: TMinimalResizeApp,
    args: { key: string; body: Buffer | Uint8Array; contentType: string; visibility: 'public' | 'private' },
  ): Promise<StorageRef>;

  // PURE, synchronous, NO I/O — the public URL for a stored object. Called on the read path,
  // so it must not touch the network. Required: the driver is the single source for object URLs.
  publicUrl(app: TMinimalResizeApp, ref: StorageRef): string;

  // Optional: a time-limited signed URL for owner/admin reads of a private original.
  signedUrl?(app: TMinimalResizeApp, ref: StorageRef, ttlSeconds: number): Promise<string>;
}
```

Exactly one active. **Both the read path and the worker require it:** the worker for
`download` + `upload`, the read path for the pure, I/O-free `publicUrl` (and the optional,
owner/admin-gated `signedUrl`). So `registerStorage(...)` must run at bootstrap in **every**
process that calls `resolve` or the worker; a missing storage throws a clear error in the
worker ([07 · Worker](./07-worker.md) step 2) and makes `resolve` log + return the safe empty
decision ([06 · Read & enqueue](./06-read-and-enqueue.md) never-throw guarantee).

Example host driver (S3, closing over its own buckets + CDN base):

```ts
ResizeEngine.registerStorage({
  download: (app, ref) => s3.getObject(ref.bucket!, ref.key),
  upload: async (app, { key, body, contentType, visibility }) => {
    const bucket = visibility === 'public' ? 'my-cdn' : 'my-originals';
    await s3.putObject(bucket, key, body, contentType);
    return { bucket, key };               // ← persisted onto the preview/original
  },
  publicUrl: (app, ref) => `https://cdn.example.com/${ref.key}`,   // pure; no I/O
  signedUrl: (app, ref, ttl) => s3.getSignedUrl(ref.bucket!, ref.key, ttl),
});
```
