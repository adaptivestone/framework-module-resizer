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
(`taskOpts` threads the per-task lease-loss signal — see `handleTask` above). The wiring is
the constructor option: `new Resizer({ transport: new MongoTransport(), … })` ([02 · §6](./02-types-and-api.md));
the mongo transport reaches the `ResizeTask` model through `getApp()`. `transport` is
optional — an eager-only host omits it ([11 · Modes](./11-modes.md)).

> **Delivery is at-least-once** (true of both transports — confirmed for the Mongo
> lease/visibility pattern and SQS). A task may be delivered more than once (lease expiry +
> crash, SQS redelivery). The worker MUST be idempotent — `processTask` re-runs are made safe
> by the existing-preview check ([07 · Worker](./07-worker.md) step 6). See
> [Appendix B](./appendix.md).

### 10.2 Mongo transport (`src/transports/mongo.ts`) — DEFAULT

**`class MongoTransport implements QueueTransport`** (house style — [02 · §6](./02-types-and-api.md)),
option-less: `new MongoTransport()`. Backed by a host-scaffolded `ResizeTask` model (see
[08 · Config & scaffold](./08-config-and-scaffold.md)). `lease/complete/fail/renew/sweep` are
transport-internal **methods** (public so unit tests can drive them; not part of the
`QueueTransport` interface). Like every driver it is a **subpath entry**
(`@adaptivestone/framework-module-resize/transports/mongo.js` — the uniform rule,
[02 · §6](./02-types-and-api.md)); it has no optional deps, so importing it is always safe.

- `enqueue` → `ResizeTask.create([{ fileId: mediaId, pipeline, previews, status:'pending', attempts:0 }], { writeConcern:{ w:'majority' } })`,
  returns `{ taskId }`.  *(maps generic `mediaId` → host-owned `fileId`; durable enqueue. The
  **array form is required on mongoose 9**: `create(doc, options)` mis-reads the options object
  as a second document — verified against mongoose source, 2026-07-04.)*
- `startWorker` → poll loop: **dead-letter sweep → lease → handleTask (+ heartbeat) → complete (fire `afterTaskComplete`) | fail**,
  sleeping `config.queue.idlePollMs` on an empty lease, until `opts.signal` aborts. `leasedBy =
  "resizer-" + process.pid`. While a task runs, a heartbeat timer calls `renew` every
  `config.queue.leaseMs/2` so a long resize doesn't lose its lease. The `leaseToken` and `attempts`
  needed by `complete`/`fail` are retained from the `lease` result in the loop's **own
  closure** — they are not part of `LeasedTask` and never reach `handleTask`/`processTask`.
  **Task timeout (2026-07-05 review fix):** `handleTask` is raced against
  `config.queue.taskTimeoutMs` (default 600000). On timeout: stop the heartbeat, abort the
  per-task `taskOpts.signal`, `fail(...)` the task, and continue the loop — the slot is freed
  and the lease lapses; a still-running detached handler is harmless (its `complete`/`fail`
  are token-fenced, its `$push` writes valid previews). Without this, one hung I/O call wedges
  the slot forever — the heartbeat keeps renewing, so even the sweep can't reclaim it.
  **Shutdown wiring:** `opts.signal` (worker-wide) also aborts the CURRENT task's
  `taskOpts.signal`, so an in-flight task finishes its current variant, skips the rest, and
  the loop exits promptly instead of hanging until SIGKILL.
  **Loop resilience (2026-07-05 review fix):** each poll iteration (sweep + lease) is guarded —
  a thrown DB error is logged and the loop sleeps `idlePollMs` and retries, forever. A worker
  daemon must survive transient Mongo outages (mongoose buffers short blips; hard rejections
  must not kill `startWorker`). Sustained outage = perpetual log-and-retry, by design.
  **Observer payload (2026-07-05 review fix):** ALL observers fired by ANY transport receive
  the transport-agnostic **`LeasedTask`** shape (`{ taskId, mediaId, pipeline, previews }`) —
  never a raw Mongo document — so host taps are portable across transports.
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
all filter on `{ _id, leaseToken, status:'processing' }` — a
0-matched update means this worker **lost the lease** (another worker re-claimed and minted a
new token, or the sweep dead-lettered it), so it drops the result instead of clobbering the
new owner. (Validated against mongodb-queue's `ack`-token guard and mongomq2 — see
[Appendix C1](./appendix.md).) **The fence deliberately does NOT require an unexpired
`leaseExpiresAt`** (2026-07-05 review fix): the token is the real fence — a worker whose lease
merely *lapsed* without being re-claimed still holds the winning token and MUST be able to
`complete` its finished work; requiring `$gt: now` turned a just-expired successful task into
a spurious re-process/dead-letter. **`attempts` is a DELIVERY count** (incremented on every
lease, including reclaims — the same semantics as SQS `maxReceiveCount`): lease churn counts
toward `maxAttempts`, which is why the default is 5 (see [08 · §13](./08-config-and-scaffold.md)).

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

**Driver-owned options.** `SqsTransport` is a **class** (house style — [02 · §6](./02-types-and-api.md)):
the host passes `transport: new SqsTransport({ queueUrl, region?, endpoint? })` to the
`Resizer` constructor and the instance keeps those options in private fields — they are
**not** in `ResizeConfig`. `queueUrl`
is required; `region` / `endpoint` are optional. Credentials are **never** options — they
resolve via the standard AWS provider chain (env / instance role). The transport lazily
constructs (and memoizes) one `SQSClient` from its options on first use.

```ts
export class SqsTransport implements QueueTransport { constructor(opts: SqsTransportOptions) {…} }
export interface SqsTransportOptions {
  queueUrl: string;
  region?: string;
  endpoint?: string;
  visibilityTimeout?: number;   // seconds; passed to sqs-consumer (else the queue default applies)
  heartbeatInterval?: number;   // seconds; sqs-consumer extends visibility while processing —
                                // the SQS analog of the Mongo lease heartbeat (long resizes
                                // otherwise get redelivered mid-task; idempotency saves
                                // correctness but the work is done twice)
  client?: SQSClient;           // bring-your-own configured client (credentials provider,
                                // proxy, retry strategy, a shared instance). When absent the
                                // driver constructs one from region/endpoint on first use.
                                // Also the TEST injection point — drivers ship NO test-only seams.
}
```

- `enqueue` → `SendMessageCommand` to `opts.queueUrl`, body `{ mediaId, pipeline, previews }`; returns `{ taskId: MessageId ?? null }`.
- `startWorker` → `sqs-consumer` `Consumer.create({ queueUrl: opts.queueUrl, sqs: client,
  handleMessage, visibilityTimeout?, heartbeatInterval? })`;
  per message parse → `handleTask` → on resolve ack/delete + fire `afterTaskComplete`; on throw,
  fire `onTaskFailed` and let SQS redeliver after the queue's visibility timeout. Wire
  `opts.signal` → `consumer.stop()`. **Two 2026-07-05 review fixes:** (a) the consumer error
  listener MUST be `consumer.on('error', …)` — `once` leaves the SECOND recurring error
  unhandled, which crashes the process (heartbeat `ChangeMessageVisibility` failures emit
  exactly such recurring errors); (b) the message-body `JSON.parse` runs INSIDE the guarded
  region so a malformed body also fires `onTaskFailed` before SQS redelivery, consistent with
  handler throws.
- **Dead-letter is native** — no module code. The host configures the queue's redrive
  policy (`maxReceiveCount = config.queue.maxAttempts`) with a DLQ; the transport just throws on
  failure, SQS redelivers up to the cap, then moves the message to the DLQ. There is no
  Mongo-style `dead` status or sweep here, so `onTaskDeadLettered` does **not** fire for SQS
  (the host may attach a small consumer to the DLQ to surface it; the module doesn't require it).
- **Subpath-only entry, plain static imports.** The driver imports `@aws-sdk/client-sqs` /
  `sqs-consumer` normally at the top of its module and is **not** re-exported from the main
  entry — hosts import `@adaptivestone/framework-module-resize/transports/sqs.js` directly
  ([02 · §6](./02-types-and-api.md)). The optional peers are only resolved when that subpath
  is imported; a missing SDK fails loudly at the host's own import line at bootstrap.

> The Mongo transport needs **no options** — it uses the host-scaffolded
> `ResizeTask` model and the lease/retry knobs under `config.queue`:
> `new Resizer({ transport: new MongoTransport(), … })`.

### 10.4 Storage interface — the required `storage` option

The one seam that lets the worker (and the read path's URL building) reach storage without
the module importing host helpers or knowing what a "bucket" is. **The driver owns all
storage-specific options** (buckets, base URL, region, credentials) — they live in the driver,
not `ResizeConfig`. Storage mirrors the queue seam: this abstract interface plus **shipped
drivers** (v1 ships `S3Storage` — §10.5; filesystem/GCS/R2 drivers can be added later without
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
owner/admin-gated `signedUrl`). `storage` is therefore the one **required** constructor
option ([02 · §6](./02-types-and-api.md)) — the type system and the constructor enforce it at
boot, in **every** process that constructs the Resizer (the "no storage registered" runtime
degradation class from the registry design no longer exists).

A custom driver is just a small object (host-implemented — e.g. GCS or a filesystem; for
plain S3 use the shipped `S3Storage`, §10.5):

```ts
new Resizer({ …, storage: {
  download: (ref) => s3.getObject(ref.bucket!, ref.key),
  upload: async ({ key, body, contentType, visibility }) => {
    const bucket = visibility === 'public' ? 'my-cdn' : 'my-originals';
    await s3.putObject(bucket, key, body, contentType);
    return { bucket, key };               // ← persisted onto the preview/original
  },
  publicUrl: (ref) => `https://cdn.example.com/${ref.key}`,   // pure; no I/O
  signedUrl: (ref, ttl) => s3.getSignedUrl(ref.bucket!, ref.key, ttl),
}});
```

### 10.5 S3 storage driver (`src/storage/s3.ts`) — SHIPPED (optional deps)

**Driver-owned options, class-shaped** (exactly like `SqsTransport`): the host passes
`storage: new S3Storage({ … })` to the `Resizer` constructor and the instance keeps its
options in private fields — nothing storage-specific enters `ResizeConfig`. Credentials are
**never** options (standard AWS provider chain). The instance constructs (and memoizes) one
`S3Client` on first I/O use — unless `opts.client` was provided. (House-style note: driver
constructors are cheap + synchronous; a driver that ever needs ASYNC setup adds a
`static async init(opts)` helper instead — none of the shipped drivers do.)

```ts
export class S3Storage implements ResizeStorage { constructor(opts: S3StorageOptions) {…} }
export interface S3StorageOptions {
  bucketPublic: string;    // previews land here (upload visibility 'public')
  bucketPrivate?: string;  // originals ('private'); defaults to bucketPublic
  publicUrl?: string;      // CDN/base URL for public objects, e.g. 'https://cdn.example.com'
  region?: string;
  endpoint?: string;       // S3-compatible: MinIO / localstack / R2
  forcePathStyle?: boolean;
  client?: S3Client;       // bring-your-own configured client (credentials provider, proxy,
                           // retry strategy, a shared instance). When absent the driver
                           // constructs one from region/endpoint/forcePathStyle on first use.
                           // Also the TEST injection point — drivers ship NO test-only seams.
}
```

- `upload` → `PutObjectCommand` to `bucketPublic`/`bucketPrivate` by `visibility`; returns
  `{ bucket, key }`. **No per-object ACL** — public access is bucket policy (every prior
  implementation works this way).
- **Bucket allowlist (2026-07-05 review fix):** every method that consumes a stored
  `ref.bucket` (download / publicUrl / signedUrl) MUST verify it is one of the driver's
  configured buckets (`bucketPublic`/`bucketPrivate`) and THROW a named error otherwise — a
  tampered media-doc `bucket` string must not become a cross-bucket read or an
  attacker-controlled hostname in a public URL (the virtual-hosted form interpolates the
  bucket into the host). `resolve`'s never-throw wrapper absorbs the read-path throw.
- `download` → `GetObjectCommand(ref.bucket ?? opts.bucketPrivate ?? opts.bucketPublic, ref.key)` → `Buffer` (ref.bucket allowlisted first).
- `publicUrl` → **pure string building, no SDK, no I/O**: `${opts.publicUrl}/${ref.key}` when
  set; else path-style `${endpoint}/${bucket}/${key}` when `endpoint`/`forcePathStyle`, else
  virtual-hosted `https://${bucket}.s3.${region}.amazonaws.com/${key}`.
- `signedUrl` → `@aws-sdk/s3-request-presigner` `getSignedUrl` with `expiresIn: ttlSeconds`.
- **Subpath-only entry, plain static imports.** The driver imports `@aws-sdk/client-s3` /
  `@aws-sdk/s3-request-presigner` normally at the top of its module and is **not**
  re-exported from the main entry — hosts import
  `@adaptivestone/framework-module-resize/storage/s3.js` directly ([02 · §6](./02-types-and-api.md)).
  They stay optional **peer** deps ([09 · Packaging](./09-packaging-and-tests.md)): the main
  entry never resolves them, and a missing SDK fails loudly at the host's own import line.
- The `ResizeStorage` interface lives in `src/storage/AbstractStorage.ts` (interface, not an
  abstract class — drivers are plain object literals; re-exported from `resizer.ts` for
  convenience). Transports mirror this with `src/transports/AbstractTransport.ts`
  (`QueueTransport`/`LeasedTask`).

### 10.6 Media store & lock provider (`src/mediaStore/`, `src/locks/`) — DEFAULTED seams

Uniform driver layout ([02 · §6](./02-types-and-api.md)): each seam directory holds the
contract + the shipped driver(s) — `mediaStore/AbstractMediaStore.ts` (the `MediaStore`
interface) + `mediaStore/framework.ts` (`FrameworkMediaStore`), and
`locks/AbstractLockProvider.ts` (the `LockProvider` interface) + `locks/framework.ts`
(`FrameworkLockProvider`). Hosts wrapping a default import it from its subpath
(`…/mediaStore/framework.js`, `…/locks/framework.js`); contract types re-export from the
main entry.

The last two DB touchpoints, behind the same single-active-strategy pattern — so the **core
is fully DB-free**: with a non-Mongo transport plus custom drivers here, nothing in the module
touches Mongo. Both are **optional constructor options with framework-backed defaults**
([02 · §6](./02-types-and-api.md)): omit them and `FrameworkMediaStore`/`FrameworkLockProvider`
are used; pass your own to swap the DB layer. Fixed at construction, like every driver.

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

- **`FrameworkMediaStore` (default; `class … implements MediaStore`):** `load` →
  `getApp().getModel(config.mediaModelName).findById(mediaId)`;
  `appendPreviews` → **one** `findByIdAndUpdate` combining `$push: { previews: { $each } }`
  with the optional `$set: { 'original.width', 'original.height' }`.
- **`FrameworkLockProvider` (default; `class … implements LockProvider`):** `acquire` →
  `getApp().getModel('Lock').acquireLock(key, Math.ceil(ttlMs / 1000))` — the framework Lock
  TTL is **seconds**, so the ms→s conversion lives *here*, never at call sites; `release` →
  `Lock.releaseLock(key)`.
- The `Resizer` constructor builds the defaults when the options are omitted:
  `opts.mediaStore ?? new FrameworkMediaStore()`, `opts.lockProvider ?? new FrameworkLockProvider()`.
- **Used by:** `enqueue` (dispatch locks — [06 · §18](./06-read-and-enqueue.md)), `processTask`
  (media load, worker locks, the single preview write — [07](./07-worker.md)), `generate`
  (persist — [11](./11-modes.md)). Lock **keys** stay module-owned and identity-derived
  ([03](./03-identity.md)) regardless of provider.
- **Swap examples:** a Redis/redlock `LockProvider`; a `MediaStore` over another DB/ORM or a
  remote media service.
