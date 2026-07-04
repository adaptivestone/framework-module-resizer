# 05 · Transport & storage

> Part of the [`@adaptivestone/framework-module-resize` build spec](../BUILD-SPEC.md).
> Prev: [04 · Pipelines & hooks](./04-pipelines-and-hooks.md) · Next: [06 · Read & enqueue](./06-read-and-enqueue.md)

The infrastructure strategies: the queue transport (which also drives the worker), storage,
and the defaulted media-store/lock seams (§10.6). Each has exactly one active implementation.
Driver methods take **no `app` parameter** — the shipped drivers read the framework's ambient
`appInstance` through the module's `getApp()` gateway ([02 · §4](./02-types-and-api.md)) when
they need framework primitives; custom drivers simply close over their own clients.

---

## §10. Queue transport & storage (strategy interfaces)

### 10.1 Transport interface — `enqueue` + `startWorker`

```ts
export interface LeasedTask { taskId: string; mediaId: string; pipeline: string; previews: MissingPreview[]; }

export interface QueueTransport {
  enqueue(task: { mediaId: string; pipeline: string; previews: MissingPreview[] }):
    Promise<{ taskId: string | null }>;

  // The transport drives consumption its own way (poll OR push). It calls handleTask
  // per task and is responsible for completion/redelivery.
  startWorker(
    // taskOpts.signal aborts THIS task if its lease is lost (best-effort; see `renew`).
    handleTask: (task: LeasedTask, taskOpts?: { signal: AbortSignal }) => Promise<void>,
    opts: { signal: AbortSignal },   // worker-wide shutdown
  ): Promise<void>;
}
```

Exactly **one** transport is active. The worker ([07](./07-worker.md)) just calls
`transport.startWorker((task, taskOpts) => processTask(task, taskOpts), { signal })`
(`taskOpts` threads the per-task lease-loss signal — see `handleTask` above). The bootstrap
line stays `registerQueueTransport(mongoTransport)`; the mongo transport reaches the
`ResizeTask` model through `getApp()`.

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
  runObservers('onTaskDeadLettered', dead, new Error(err), {});   // ctx = {} in the worker
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
not `ResizeConfig`. Storage mirrors the queue seam: this abstract interface plus **shipped
drivers** (v1 ships `s3Storage` — §10.5; filesystem/GCS/R2 drivers can be added later without
touching the core). A host on anything not shipped implements the interface itself — a small
object closing over its own client + buckets (no `app` parameter — see the file intro).

```ts
// StorageRef is the opaque locator the driver round-trips onto the document (02 · §5).
// `key` is always present; `bucket` is S3-specific and may be absent for other drivers.
export interface ResizeStorage {
  // Download an existing object by its stored locator (the worker's original; rarely a re-read).
  download(ref: StorageRef): Promise<Buffer | Uint8Array>;

  // Upload a NEW object. The module supplies the logical `key` + `visibility`; the DRIVER
  // decides physical placement (which bucket / base dir) and returns the locator to persist.
  upload(
    args: { key: string; body: Buffer | Uint8Array; contentType: string; visibility: 'public' | 'private' },
  ): Promise<StorageRef>;

  // PURE, synchronous, NO I/O — the public URL for a stored object. Called on the read path,
  // so it must not touch the network. Required: the driver is the single source for object URLs.
  publicUrl(ref: StorageRef): string;

  // Optional: a time-limited signed URL for owner/admin reads of a private original.
  signedUrl?(ref: StorageRef, ttlSeconds: number): Promise<string>;
}
```

Exactly one active. **Both the read path and the worker require it:** the worker for
`download` + `upload`, the read path for the pure, I/O-free `publicUrl` (and the optional,
owner/admin-gated `signedUrl`). So `registerStorage(...)` must run at bootstrap in **every**
process that calls `resolve` or the worker; a missing storage throws a clear error in the
worker ([07 · Worker](./07-worker.md) step 2) and makes `resolve` log + return the safe empty
decision ([06 · Read & enqueue](./06-read-and-enqueue.md) never-throw guarantee).

A custom driver is just a small object (host-implemented — e.g. GCS or a filesystem; for
plain S3 use the shipped `s3Storage`, §10.5):

```ts
ResizeEngine.registerStorage({
  download: (ref) => s3.getObject(ref.bucket!, ref.key),
  upload: async ({ key, body, contentType, visibility }) => {
    const bucket = visibility === 'public' ? 'my-cdn' : 'my-originals';
    await s3.putObject(bucket, key, body, contentType);
    return { bucket, key };               // ← persisted onto the preview/original
  },
  publicUrl: (ref) => `https://cdn.example.com/${ref.key}`,   // pure; no I/O
  signedUrl: (ref, ttl) => s3.getSignedUrl(ref.bucket!, ref.key, ttl),
});
```

### 10.5 S3 storage driver (`src/storage/s3.ts`) — SHIPPED (optional deps)

**Driver-owned options, factory-shaped** (exactly like `sqsTransport`): the host calls
`registerStorage(s3Storage({ … }))` and the returned driver closes over its options — nothing
storage-specific enters `ResizeConfig`. Credentials are **never** options (standard AWS
provider chain). The factory lazily constructs (and memoizes) one `S3Client` on first I/O use.

```ts
export function s3Storage(opts: {
  bucketPublic: string;    // previews land here (upload visibility 'public')
  bucketPrivate?: string;  // originals ('private'); defaults to bucketPublic
  publicUrl?: string;      // CDN/base URL for public objects, e.g. 'https://cdn.example.com'
  region?: string;
  endpoint?: string;       // S3-compatible: MinIO / localstack / R2
  forcePathStyle?: boolean;
}): ResizeStorage;
```

- `upload` → `PutObjectCommand` to `bucketPublic`/`bucketPrivate` by `visibility`; returns
  `{ bucket, key }`. **No per-object ACL** — public access is bucket policy (every prior
  implementation works this way).
- `download` → `GetObjectCommand(ref.bucket ?? opts.bucketPrivate ?? opts.bucketPublic, ref.key)` → `Buffer`.
- `publicUrl` → **pure string building, no SDK, no I/O**: `${opts.publicUrl}/${ref.key}` when
  set; else path-style `${endpoint}/${bucket}/${key}` when `endpoint`/`forcePathStyle`, else
  virtual-hosted `https://${bucket}.s3.${region}.amazonaws.com/${key}`.
- `signedUrl` → `@aws-sdk/s3-request-presigner` `getSignedUrl` with `expiresIn: ttlSeconds`.
- Lazy-load `@aws-sdk/client-s3` / `@aws-sdk/s3-request-presigner` via dynamic `import()` —
  they are optional **peer** deps ([09 · Packaging](./09-packaging-and-tests.md)), so the
  module installs and runs without them unless this driver is used.

### 10.6 Media store & lock provider (`src/mediaStore.ts`, `src/locks.ts`) — DEFAULTED seams

The last two DB touchpoints, behind the same single-active-strategy pattern — so the **core
is fully DB-free**: with a non-Mongo transport plus custom drivers here, nothing in the module
touches Mongo. Unlike transport/storage, each has a **framework-backed default active out of
the box** (a standard host registers nothing); `registerMediaStore`/`registerLockProvider`
replace it (last wins).

```ts
export interface MediaStore {
  // Load the media doc for the WORKER (the read path never calls this — resolve() receives
  // `media` from the caller). Resolving to null/undefined makes the task a logged no-op (07 step 1).
  load(mediaId: string): Promise<MediaLike | null>;

  // The worker's single write: append generated previews (+ optionally backfill the
  // original's display dims) atomically.
  appendPreviews(
    mediaId: string,
    previews: Preview[],
    backfillDims?: { width: number; height: number },
  ): Promise<void>;
}

export interface LockProvider {
  acquire(key: string, ttlMs: number): Promise<boolean>; // true if acquired
  release(key: string): Promise<void>;
}
```

- **`frameworkMediaStore` (default):** `load` →
  `getApp().getModel(config.mediaModelName).findById(mediaId)`;
  `appendPreviews` → **one** `findByIdAndUpdate` combining `$push: { previews: { $each } }`
  with the optional `$set: { 'original.width', 'original.height' }`.
- **`frameworkLockProvider` (default):** `acquire` →
  `getApp().getModel('Lock').acquireLock(key, Math.ceil(ttlMs / 1000))` — the framework Lock
  TTL is **seconds**, so the ms→s conversion lives *here*, never at call sites; `release` →
  `Lock.releaseLock(key)`.
- **Used by:** `enqueue` (dispatch locks — [06 · §18](./06-read-and-enqueue.md)), `processTask`
  (media load, worker locks, the single preview write — [07](./07-worker.md)), `generate`
  (persist — [11](./11-modes.md)). Lock **keys** stay module-owned and identity-derived
  ([03](./03-identity.md)) regardless of provider.
- **Swap examples:** a Redis/redlock `LockProvider`; a `MediaStore` over another DB/ORM or a
  remote media service.
