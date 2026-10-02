# Drivers and framework independence

Status: **proposal**, 2026-10-02. Follows [the multi-resizer redesign](./2026-09-30-multi-resizer.md)
(P1–P4, merged). Pre-release: breaking changes are fine; hosts migrate their own data.

## Goal

The module is a core plus drivers. Every kind of driver has a published abstract contract (the
methods the core calls). The package ships ready drivers built on those contracts, and anyone can
write their own. The framework integration is one more layer that wraps the shipped drivers
with framework models and config. Nothing in the core or the drivers needs the framework.

## What is wrong today

1. **The framework is still required in practice.** `package.json` lists
   `@adaptivestone/framework` and `mongoose` as required peers, so npm installs them into any
   app. The only Mongo media store, lock provider and task model are framework classes
   (`FrameworkMediaStore` = `getApp().getModel(name)` + `findById` + `$push`), so a plain Node app
   must write two drivers and copy the task schema by hand.
2. **Config has three owners.** Image settings are read by the Resizer, `queue.*` by the
   transport (and again as transport options), and `worker.*` only by the framework command. The
   README needs a "who reads what" table to explain it.
3. **Too many parts to wire.** `new Resizer` needs config, storage, media store, transport and a
   separate lock provider, none with a default. Two enqueue methods (`prewarm`,
   `enqueueRequired`) overlap.

## Decisions

**D1. Contracts are exported abstract classes.** `ResizeStorage`, `MediaStore`, `QueueTransport`
and `LockStore` become abstract classes in the main entry. A custom driver `extends` one and gets
typed abstract methods, default implementations of the optional ones, and the doc comments.
Plain objects of the same shape keep working (structural typing); the core never uses
`instanceof` on drivers, so duplicate package copies stay safe.

| Contract | Required methods | Optional, with default |
|---|---|---|
| `ResizeStorage` | `upload`, `download`, `publicUrl` | `signedUrl` (none), `canServeOriginalPublicly` (`false`) |
| `MediaStore` | `load`, `appendPreviews` | `verify` (no-op) |
| `QueueTransport` | `enqueue`, `startWorker` | `findActive` (unsupported) |
| `LockStore` | `acquire(key, ttlMs)`, `release(key)` | — |

**D2. Locks belong to the transport.** Locks exist only for queued work, so the transport owns
them: `new MongoTransport({ model, locks })`, `new SqsTransport({ queueUrl, locks })`. The
`lockProvider` Resizer option is removed. Lock TTLs and lease timing are transport options,
validated in the transport's constructor (worker lock ≤ lease). The dedupe mechanisms themselves
(dispatch locks, worker locks, `requestKey`, `findActive`) are unchanged.

**D3. Shipped drivers, grouped by backend, framework-free.**

| Subpath | Exports |
|---|---|
| `…/drivers/fs.js` | `LocalFsStorage` |
| `…/drivers/s3.js` | `S3Storage` |
| `…/drivers/mongo.js` | `MongoMediaStore({ model \| getModel })`, `MongoTransport({ model \| getModel, locks, …timing })`, `MongoLockStore({ model \| getModel })`, `createResizeModels(connection)` |
| `…/drivers/sqs.js` | `SqsTransport({ queueUrl, queues?, locks, … })` |

`createResizeModels(connection)` registers `ResizeTask` and `ResizeLock` on a Mongoose
connection, with the package's schemas and indexes. The schema definitions are the single source
of truth; the framework's `ResizeTask` model uses the same definitions. Mongoose is imported
only by `…/drivers/mongo.js`.

**D4. The framework adapter only wraps.** Everything framework-specific lives behind
`…/framework.js`:

| Export | What it is |
|---|---|
| `createFrameworkResizer({ storage, transport?, configName? })` | `new Resizer` with config from the config file, the app logger and events, and `FrameworkMediaStore` |
| `createFrameworkMongoTransport()` | `MongoTransport` over the framework `ResizeTask` model, `FrameworkLockStore`, and timing from the config file |
| `FrameworkMediaStore({ modelName })` | `MongoMediaStore` whose model comes from `app.getModel(modelName)` |
| `FrameworkLockStore` | `LockStore` over the framework's existing `Lock` model |
| `ResizeTaskModel`, `ResizeWorker`, `FrameworkResizeConfig`, `appLogger` | the model, CLI command, config type and logger that the scaffold uses |

The old subpaths `transports/*`, `storage/*`, `mediaStore/framework.js`, `locks/framework.js`,
`models/ResizeTask.js` and `commands/ResizeWorker.js` are removed.

**D5. Peers become optional.** `@adaptivestone/framework` and `mongoose` join the AWS SDKs as
optional peers. The core needs only `sharp`. Import-graph tests enforce the following:
- the main entry imports neither the framework nor mongoose;
- `drivers/*` import no framework code;
- only `framework.js` imports the framework.

**D6. Core config is image settings only.** `ResizeConfig` keeps `formats`, `upload`,
`maxSize`, `animated`, `encode`, `limits` and `concurrency` (formerly `worker.concurrency`).
- Queue timing and lock TTLs move to transport options.
- Sharp process tuning moves to `runWorker({ sharp })`.
- `config` becomes optional on `new Resizer` (the defaults apply).
- The framework config file keeps `mediaModelName`, `queue` and `worker` sections. Only the
  adapter reads them, passing `queue` to the transport and `worker` to the worker command.

**D7. One enqueue method.** `prewarm()` returns today's detailed `enqueueRequired()` result:
`status`, `ready`, `accepted`, `notRequired`, `unconfirmed`, `tasks` and `issues`.
- It never throws: a failure becomes `status: 'incomplete'` with an issue.
- `enqueueRequired()` is removed.
- The old `enqueued` count is `accepted.length`.

**D8. One worker loop per transport.** `runWorker({ queue })` consumes that queue on every
distinct transport among the registered Resizers. This removes the
`RESIZE_WORKER_TRANSPORTS_DIFFER` rule.

**D9 (optional; drop it if unwanted). The framework adapter reads lazily.**
`createFrameworkResizer` and `createFrameworkMongoTransport` read config and models on first
use, not at construction.
- **What it removes:** a normal static `import` of `src/resizer.ts` works anywhere, so hosts no
  longer need the `await import()` after `init()`. The scaffolded worker command becomes
  `import '../resizer.ts'` plus a re-export.
- **What it costs:** a config error shows up at the first call instead of at boot. Calling
  `await getResizer().verify()` after `init()` restores the fail-at-boot behavior.

## Target usage

Plain Node with Mongo, with no hand-written drivers:

```ts
import mongoose from 'mongoose';
import { Resizer, runWorker } from '@adaptivestone/framework-module-resize';
import { LocalFsStorage } from '@adaptivestone/framework-module-resize/drivers/fs.js';
import {
  createResizeModels, MongoLockStore, MongoMediaStore, MongoTransport,
} from '@adaptivestone/framework-module-resize/drivers/mongo.js';

const { ResizeTask, ResizeLock } = createResizeModels(mongoose.connection);

export const resizer = new Resizer({
  storage: new LocalFsStorage({ rootDir: './var/media', publicBaseUrl: '/media' }),
  mediaStore: new MongoMediaStore({ model: File }), // File spreads resizeMediaSchemaFragment
  transport: new MongoTransport({ model: ResizeTask, locks: new MongoLockStore({ model: ResizeLock }) }),
});

// worker process
await runWorker({ signal });
```

Framework:

```ts
// src/resizer.ts
import { createFrameworkMongoTransport, createFrameworkResizer } from '@adaptivestone/framework-module-resize/framework.js';
import { S3Storage } from '@adaptivestone/framework-module-resize/drivers/s3.js';

export const resizer = createFrameworkResizer({
  storage: new S3Storage({ bucketPublic, bucketPrivate, publicBaseUrl, client }),
  transport: createFrameworkMongoTransport(),
});
```

A custom driver:

```ts
import { MediaStore } from '@adaptivestone/framework-module-resize';

class PostgresMediaStore extends MediaStore {
  async load(id) { /* … */ }
  async appendPreviews(id, previews, dims) { /* … */ }
}
```

## Unchanged

These stay as they are:
- preview identity (`resizer:pipeline:size:format:filters`) and random preview keys;
- the dispatch and worker locks themselves (D2 only moves them);
- `requestKey` deduplication, at-least-once delivery, and named queues;
- the Resizer registry, hooks, pipelines, and the SVG and private-original policy;
- the storage drivers' behavior.

## Host migration

1. Update imports to the new subpaths. Remove `lockProvider`, and pass `locks` to the transport
   instead.
2. In the config file, move `worker.concurrency` to `concurrency`. `queue` and `worker` stay in
   the framework config file. Plain-Node hosts pass them as transport and worker options instead.
3. Replace `enqueueRequired()` with `prewarm()`. Read `status` instead of `enqueued`.
4. Re-run `resize-scaffold` (delete the old shims first) to get the new worker command.
5. Plain-Node hosts: replace hand-written Mongo drivers with the shipped ones.

## Phases

Each phase is one PR with tests, plus README, AGENTS.md, CHANGELOG, and a docs-site PR in the
same phase.

| Phase | Scope | Done when |
|---|---|---|
| **Q1** Contracts and Mongo drivers | D1, D3, D4, D5: abstract classes, `drivers/*`, framework-free `MongoMediaStore` / `MongoLockStore` / `createResizeModels`, framework drivers as wrappers, optional peers | A plain-Node smoke consumer (no framework installed) wires Mongo and processes a task without writing a driver |
| **Q2** Locks and config | D2, D6: locks and timing on the transport, image-only core config, no `lockProvider`, optional `config` | No core file reads `config.queue` or `config.worker`; transports validate their own timing |
| **Q3** One enqueue method | D7 | `enqueueRequired` is gone; `prewarm` returns the detailed result and never throws |
| **Q4** Worker and framework bootstrap | D8, D9 | `runWorker` serves several transports; a framework host imports `src/resizer.ts` statically, and the scaffolded worker command is an import plus a re-export |

## Open questions

1. **Locks in framework apps.** Should they use the framework's existing `Lock` model
   (proposed: no new collection), or the module's own `ResizeLock` (the same code in both
   worlds)?
2. **D9.** Should lazy framework reads be in or out?
3. **Subpath names.** Is `…/drivers/{fs,s3,mongo,sqs}.js` acceptable?
