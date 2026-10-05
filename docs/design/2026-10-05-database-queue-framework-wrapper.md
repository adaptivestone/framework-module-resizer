# Database, queue and framework wrapper

Status: **proposal**, 2026-10-05. Follows
[drivers and framework independence](./2026-10-02-drivers-and-framework-independence.md) (Q1–Q4,
merged). Pre-release: breaking changes are fine; hosts migrate their own data.

## Goal

Three layers:

1. **Core.** `Resizer` plus small abstract contracts. It works with any database and queue, and
   owns all the logic that is the same everywhere.
2. **Adapters.** Mongo, SQS, fs and S3 implement the contracts. Each one contains only the
   backend's operations.
3. **Framework wrapper.** The main path. `new FrameworkResizer()` reads the config file, builds
   the adapters from the app's models and config, and passes them to the core `Resizer`. A
   framework app writes no driver code.

## What is wrong today

1. **Mongo needs three drivers.** A Mongo app wires `MongoMediaStore`, `MongoTransport` and
   `MongoLockStore`. `MongoTransport` (681 lines) mixes the queue logic with Mongo queries: the
   poll loop, leases and heartbeat, timeouts, retry with backoff, dead-lettering, de-duplication
   and events. A new database would have to rewrite all of that logic.
2. **SQS behaves differently.** `SqsTransport` hands its loop to `sqs-consumer`, so its retries,
   timeouts and events differ from Mongo's, and it never reports a dead-lettered task.
3. **Framework apps still assemble drivers in code.**
   - They call `createFrameworkResizer` and `createFrameworkMongoTransport`, and pass storage
     instances themselves.
   - Storage differs per environment (local files in development and tests, S3 in production).
     One host built its own `resizeStorage` config files plus a helper that picks the driver.
     That is config work the module should do.

## Decisions

**E1. Three contracts, each holding only the backend-specific operations.**

```ts
abstract class ResizeStorage {          // files — unchanged
  upload, download, publicUrl, signedUrl?, canServeOriginalPublicly?
}

abstract class ResizeDatabase {         // records
  abstract loadMedia(id): Promise<MediaLike | null>;
  abstract appendPreviews(id, previews, dims?): Promise<void>;
  abstract acquireLock(key, ttlMs): Promise<boolean>;
  abstract releaseLock(key): Promise<void>;
  tasks?: TaskQueue;                    // a database that can also hold the queue
  verify?(): void | Promise<void>;
}

abstract class TaskQueue {              // queued tasks; every method is one atomic operation
  abstract add(task, requestKey): Promise<{ taskId: string; existing: boolean }>;
  abstract claim(queue, leaseMs): Promise<ClaimedTask | null>; // next due task, with a lease token
  abstract renew(task, leaseMs): Promise<boolean>;
  abstract complete(task): Promise<boolean>;
  abstract fail(task, next: { retryAt: Date } | 'dead', error): Promise<boolean>;
  findActive?(resizer, mediaId, pipeline): Promise<ActiveTask[]>;
  servesQueue?(queue): boolean;
  verify?(): void | Promise<void>;
}
```

`MediaStore`, `LockStore` and `QueueTransport` are removed. Their operations live in
`ResizeDatabase` and `TaskQueue`.

**E2. The core owns the queue logic.** One worker loop in the core runs over any `TaskQueue`. It
handles:
- claiming tasks and heartbeat renewal (every `leaseMs / 2`);
- the task timeout;
- retry with backoff;
- dead-lettering once `maxAttempts` is reached;
- de-duplication (`requestKey`, computed in the core);
- the events `completed`, `failed` and `deadLettered`.

Mongo and SQS therefore behave the same. The timing is the Resizer's queue policy (see E4).

**E3. The adapters.**

| Adapter | Implements | How |
|---|---|---|
| `mongoDatabase(connection, { mediaModel })` | `ResizeDatabase` + `tasks` | `findOneAndUpdate` claims; documents hold the locks; `ResizeTask` / `ResizeLock` models from the package schemas |
| `sqsQueue({ queueUrl, queues?, deadLetterQueueUrl? })` | `TaskQueue` | claim = ReceiveMessage (visibility = lease); renew = ChangeMessageVisibility; complete = DeleteMessage; retry = ChangeMessageVisibility(delay); dead = send to `deadLetterQueueUrl` if set, then delete. `sqs-consumer` is no longer needed. |
| `LocalFsStorage`, `S3Storage` | `ResizeStorage` | unchanged |

**E4. Core wiring.**

```ts
new Resizer({
  storage,                                // ResizeStorage
  db,                                     // ResizeDatabase
  queue: { tasks: db.tasks, name: 'default', ...timing }, // omit → eager only
});
```

- `queue.tasks` may be any `TaskQueue`, for example `sqsQueue(…)` with a Mongo `db`. The
  timing is `lockTtlMs`, `leaseMs`, `retryBackoffMs`, `maxAttempts`, `idlePollMs` and
  `taskTimeoutMs`, with today's defaults.
- `storage`, `db` and `queue` may also be functions, sync or async, resolved once before the
  first call. That lets the framework wrapper read the app lazily and import the S3 adapter
  (an optional peer) only when the config asks for it.

**E5. Framework wrapper: config-driven, with code overrides.**

```ts
// src/resizer.ts — the whole wiring
export const resizer = new FrameworkResizer({ pipelines, hooks });
export const avatars = new FrameworkResizer({ name: 'avatars', configName: 'resizeAvatars' });
```

```ts
// src/config/resize.ts — infrastructure per environment (resize.production.ts overrides it)
export default {
  ...defaultFrameworkResizeConfig,
  mediaModelName: 'File',
  storage: { driver: 'local', rootDir: './var/media', publicBaseUrl: '/media' },
  queue: { driver: 'mongo' },             // or { driver: 'sqs', queueUrl, … } or false (eager only)
  worker: { enabled: false },
} satisfies FrameworkResizeConfig;

// src/config/resize.production.ts
export default {
  storage: { driver: 's3', bucketPublic: 'cdn', bucketPrivate: 'originals', publicBaseUrl: '…' },
};
```

On first use, `FrameworkResizer` (a subclass of `Resizer`) builds:
- **db:** `mongoDatabase` over the app's models — `getModel(mediaModelName)`, the scaffolded
  `ResizeTask`, and the framework's own `Lock` model.
- **storage:** built from `config.storage`. The S3 driver is imported only when it is selected.
- **queue:** built from `config.queue`, timing included. `false` or a missing section means eager
  only, so reads never create tasks that no worker consumes.
- **logger and events:** from the app.

Options win over config. For example, `new FrameworkResizer({ storage: myS3Storage })` reuses a
host's own S3 client. `createFrameworkResizer` and `createFrameworkMongoTransport` are removed.

**Why config-driven.**
- Infrastructure differs per environment, and the framework already merges
  `resize.<NODE_ENV>.ts` over `resize.ts`. Driver choice and bucket names belong there, not in
  `if (env)` code.
- Credentials stay out of the config: the AWS SDK reads them from its default chain.
- Code keeps only behavior: pipelines and hooks.

## Unchanged

- Preview identity, the read path and `prewarm()` results.
- The SVG and private-original policy, pipelines and hooks.
- Named queues and the scaffolded worker command.
- Locks still prevent duplicate work only, as before.

## Host migration

1. **Framework apps:**
   - Move storage and queue choices into `src/config/resize.ts` (`storage`, `queue.driver`).
   - Replace `src/resizer.ts` with `new FrameworkResizer({ pipelines, hooks })`.
   - Keep the `ResizeTask` shim.
2. **Plain Node apps:** replace the three Mongo drivers with
   `mongoDatabase(connection, { mediaModel })`, and `SqsTransport` with `sqsQueue(…)`.
3. **Custom drivers:** implement `ResizeDatabase` / `TaskQueue` instead of `MediaStore` /
   `LockStore` / `QueueTransport`.

## Phases

Each phase is one PR with tests, plus README, AGENTS.md, CHANGELOG and docs-site updates.

| Phase | Scope | Done when |
|---|---|---|
| **R1** Database + core queue | E1, E2, E4; `mongoDatabase`; the worker loop moves from `MongoTransport` into the core; Mongo tests ported | No queue logic lives in an adapter; an in-memory `TaskQueue` test runs the whole lifecycle |
| **R2** SQS as a `TaskQueue` | E3 SQS row; `sqs-consumer` removed | SQS and Mongo pass the same lifecycle tests, including `deadLettered` events |
| **R3** `FrameworkResizer` | E5; lazy async parts; scaffold; config-driven storage and queue | A framework host's `src/resizer.ts` is one line; switching to S3 in production is a config change |
