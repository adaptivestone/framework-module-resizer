// End-to-end worker routing on a real Mongo queue: one worker process serves two Resizers that
// share a task queue, named queues are isolated from each other, a FrameworkResizer wired only
// by its config file runs through the framework worker entry, and queue names on two backends
// (the database and SQS, or a stand-in registered under 'sqs') route to their own backend.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import LockModel from '@adaptivestone/framework/models/Lock.js';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import sharp from 'sharp';
import type { MediaStore } from '../contracts/media.ts';
import type { ResizeStorage } from '../contracts/storage.ts';
import { resizeMediaSchemaFragment } from '../drivers/mongo/mediaFragment.ts';
import { MongoTaskQueue } from '../drivers/mongo/taskQueue.ts';
import { ResizeSetupError } from '../errors.ts';
import { gateKey } from '../lockKeys.ts';
import { resetResizerForTests } from '../resizer.ts';
import { RoutingTaskQueue } from '../routing.ts';
import { fakeMedia, fakeQueueDriver } from '../testHelpers/fakes.ts';
import { makeResizeConfig } from '../testHelpers/resizeConfig.ts';
import type { MediaLike, Preview } from '../types.d.ts';
import { runWorker } from '../worker.ts';
import { FrameworkMediaStore } from './media.ts';
import ResizeTaskModel from './ResizeTaskModel.ts';
import { FrameworkResizer } from './resizer.ts';
import { runResizeWorker } from './worker.ts';

const png = await sharp({
  create: {
    width: 32,
    height: 32,
    channels: 3,
    background: { r: 0, g: 128, b: 255 },
  },
})
  .png()
  .toBuffer();

let server: MongoMemoryServer;
let connection: mongoose.Connection;
let taskModel: mongoose.Model<Record<string, unknown>>;
let lockModel: mongoose.Model<Record<string, unknown>>;

before(async () => {
  server = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  connection = await mongoose
    .createConnection(server.getUri(), {
      dbName: `resize_worker_${process.pid}`,
    })
    .asPromise();
  const taskSchema = new mongoose.Schema(ResizeTaskModel.modelSchema, {
    timestamps: true,
    minimize: false,
  });
  ResizeTaskModel.initHooks(taskSchema);
  const lockSchema = new mongoose.Schema(LockModel.modelSchema, {
    timestamps: true,
    minimize: false,
    statics: LockModel.modelStatics,
  });
  LockModel.initHooks(lockSchema);
  taskModel = connection.model<Record<string, unknown>>(
    'ResizeTask',
    taskSchema,
  );
  lockModel = connection.model<Record<string, unknown>>('Lock', lockSchema);
  await Promise.all([taskModel.init(), lockModel.init()]);
});

after(async () => {
  await connection.close();
  await server.stop();
});

const testQueue = {
  leaseMs: 5000,
  idlePollMs: 20,
};

// src/config/resize.ts's one database queue, with the test timing.
const testQueues = { default: { driver: 'database' as const, ...testQueue } };

// A fake app over the real task and lock models. `configs` overrides config files by name;
// `models` adds models (e.g. the media model) to ResizeTask and Lock.
function installApp(
  opts: {
    configs?: Record<string, unknown>;
    models?: Record<string, unknown>;
  } = {},
) {
  resetResizerForTests();
  resetAppInstance();
  const models: Record<string, unknown> = {
    ResizeTask: taskModel,
    Lock: lockModel,
    ...opts.models,
  };
  setAppInstance({
    getConfig: (name: string) =>
      opts.configs?.[name] ??
      makeResizeConfig({
        formats: ['webp'],
        // Only src/config/resize.ts holds the process-wide sections.
        ...(name === 'resize'
          ? { worker: { enabled: true }, queues: testQueues }
          : {}),
      }),
    getModel: (name: string) => models[name] ?? false,
    logger: { info() {}, warn() {}, error() {} },
  } as never);
}

// The host media model, built from the current fragment.
const fileModel = () =>
  connection.models.File ??
  connection.model(
    'File',
    new mongoose.Schema({ ...resizeMediaSchemaFragment }, { minimize: false }),
  );

// In-memory storage: every download returns the test PNG; uploads are recorded.
function memoryStorage(): { storage: ResizeStorage; uploads: string[] } {
  const uploads: string[] = [];
  const storage: ResizeStorage = {
    download: async () => png,
    upload: async ({ key }) => {
      uploads.push(key);
      return { key };
    },
    publicUrl: (ref) => `/m/${(ref as { key: string }).key}`,
  };
  return { storage, uploads };
}

// In-memory media; the Resizers beside it queue their tasks on the real ResizeTask model.
function memoryMedia(media: MediaLike): MediaStore {
  return fakeMedia({
    load: async (id) => (id === media.id ? media : null),
    appendPreviews: async (_id, previews: Preview[]) => {
      media.previews = [...(media.previews ?? []), ...previews];
      return previews;
    },
  });
}

// One task queue over the real ResizeTask model, with the test timing.
const realTaskQueue = () =>
  new MongoTaskQueue({ model: taskModel, timing: testQueue });

function newMedia(): MediaLike {
  return {
    id: String(new mongoose.Types.ObjectId()),
    original: { storageRef: { key: 'originals/a.png' }, format: 'png' },
    previews: [],
  };
}

async function waitFor(pred: () => boolean, ms = 20000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) {
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sizes = [{ width: 16, height: 16 }];

test('one worker serves two Resizers that share a task queue', async () => {
  installApp();
  await taskModel.deleteMany({});
  const tasks = realTaskQueue();
  const stop = new AbortController();
  const mediaA = newMedia();
  const mediaB = newMedia();
  const a = memoryStorage();
  const b = memoryStorage();
  const media = new FrameworkResizer({
    storage: a.storage,
    tasks,
    media: memoryMedia(mediaA),
  });
  const listings = new FrameworkResizer({
    name: 'listings',
    storage: b.storage,
    tasks,
    media: memoryMedia(mediaB),
  });
  // The database queue gates by task: no lock store, and the worker renders without one.
  assert.equal(media.locks, undefined);

  assert.equal(
    (await media.prewarm({ media: mediaA, sizes })).accepted.length,
    1,
  );
  assert.equal(
    (await listings.prewarm({ media: mediaB, sizes })).accepted.length,
    1,
  );

  const done = runWorker({ signal: stop.signal });
  try {
    await waitFor(
      () =>
        (mediaA.previews?.length ?? 0) > 0 &&
        (mediaB.previews?.length ?? 0) > 0,
    );
  } finally {
    stop.abort();
    await done;
  }

  // Each media was generated through its own Resizer's storage.
  assert.equal(a.uploads.length, 1);
  assert.equal(b.uploads.length, 1);
  const rows = await taskModel.find({}).lean();
  assert.deepEqual(rows.map((r) => r.resizer).sort(), ['default', 'listings']);
  assert.ok(rows.every((r) => r.status === 'completed'));
});

test('a bulk-queue task waits for a bulk worker', async () => {
  installApp();
  await taskModel.deleteMany({});
  const media = newMedia();
  const memory = memoryStorage();
  const tasks = realTaskQueue();

  const first = new AbortController();
  const resizer = new FrameworkResizer({
    storage: memory.storage,
    tasks,
    media: memoryMedia(media),
  });
  assert.equal(
    (await resizer.prewarm({ media, sizes, queue: 'bulk' })).accepted.length,
    1,
  );

  // The default-queue worker leaves the bulk task alone.
  const defaultWorker = runWorker({ signal: first.signal });
  try {
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    first.abort();
    await defaultWorker;
  }
  assert.equal(media.previews?.length ?? 0, 0);
  const pending = await taskModel.findOne({}).lean();
  assert.equal(pending?.status, 'pending');
  assert.equal(pending?.queue, 'bulk');

  // A bulk worker for the same Resizer and task queue processes it.
  const second = new AbortController();
  const bulkWorker = runWorker({ queue: 'bulk', signal: second.signal });
  try {
    await waitFor(() => (media.previews?.length ?? 0) > 0);
  } finally {
    second.abort();
    await bulkWorker;
  }
  const done = await taskModel.findOne({}).lean();
  assert.equal(done?.status, 'completed');
});

test('a FrameworkResizer wired only by its config file runs through runResizeWorker', async () => {
  await taskModel.deleteMany({});
  const root = await mkdtemp(join(tmpdir(), 'resize-e2e-'));
  const File = fileModel();
  installApp({
    configs: {
      resize: makeResizeConfig({
        formats: ['webp'],
        worker: { enabled: true },
        storage: {
          driver: 'local',
          rootDir: join(root, 'public'),
          publicBaseUrl: '/media',
        },
        queue: 'default',
        queues: testQueues,
      }),
    },
    models: { File },
  });
  try {
    const resizer = new FrameworkResizer(); // everything from the config file
    await resizer.verify();
    const original = await resizer.uploadOriginal({
      body: png,
      visibility: 'private',
    });
    const doc = await File.create({ original, previews: [] });
    const media = { id: String(doc._id), original, previews: [] };
    const result = await resizer.prewarm({ media, sizes });
    assert.equal(result.status, 'accepted');

    const worker = runResizeWorker();
    try {
      const until = Date.now() + 20000;
      while (
        ((await File.findById(doc._id).lean())?.previews as unknown[])
          ?.length !== 1
      ) {
        assert.ok(Date.now() < until, 'the worker did not store the preview');
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      process.emit('SIGTERM');
      await worker;
    }
    const stored = await File.findById(doc._id).lean();
    const [preview] = (stored?.previews ?? []) as Preview[];
    assert.equal(preview.format, 'webp');
    assert.equal(
      resizer.storage.publicUrl(preview.storageRef),
      `/media/${(preview.storageRef as { path: string }).path}`,
    );
    assert.equal(
      (await readdir(join(root, 'public'), { recursive: true })).length > 0,
      true,
    );
    const task = await taskModel.findOne({}).lean();
    assert.equal(task?.status, 'completed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('two Resizers wired by their config files share one task queue: one task at a time, each with its own Resizer', async () => {
  await taskModel.deleteMany({});
  const File = fileModel();
  installApp({
    configs: {
      resize: makeResizeConfig({ formats: ['webp'], queues: testQueues }),
      // No `queue`: the default queue, which resize.ts defines.
      resizeListings: makeResizeConfig({ formats: ['webp'] }),
    },
    models: { File },
  });
  // Storage that records what it downloads and how many downloads overlap across both Resizers.
  let running = 0;
  let peak = 0;
  const tracked = () => {
    const downloads: string[] = [];
    const storage: ResizeStorage = {
      download: async (ref) => {
        downloads.push((ref as { key: string }).key);
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 150));
        running -= 1;
        return png;
      },
      upload: async ({ key }) => ({ key }),
      publicUrl: (ref) => `/m/${(ref as { key: string }).key}`,
    };
    return { downloads, storage };
  };
  const a = tracked();
  const b = tracked();
  const media = new FrameworkResizer({ storage: a.storage });
  const listings = new FrameworkResizer({
    name: 'listings',
    configName: 'resizeListings',
    storage: b.storage,
  });
  assert.equal(media.media === listings.media, false);

  const ids: string[] = [];
  for (const [resizer, prefix] of [
    [media, 'media'],
    [listings, 'listings'],
  ] as const) {
    for (const n of [1, 2]) {
      const original = {
        storageRef: { key: `${prefix}/${n}.png` },
        format: 'png',
      };
      const doc = await File.create({ original, previews: [] });
      ids.push(String(doc._id));
      const result = await resizer.prewarm({
        media: { id: String(doc._id), original, previews: [] },
        sizes,
      });
      assert.equal(result.status, 'accepted');
    }
  }
  await media.ready();
  await listings.ready();
  assert.equal(media.tasks, listings.tasks);

  const stop = new AbortController();
  const done = runWorker({ signal: stop.signal });
  try {
    const until = Date.now() + 20000;
    while (
      (await File.countDocuments({
        _id: { $in: ids },
        'previews.0': { $exists: true },
      })) !== ids.length
    ) {
      assert.ok(Date.now() < until, 'the worker did not store every preview');
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    stop.abort();
    await done;
  }

  assert.equal(peak, 1, 'one consume loop: tasks never overlap');
  assert.deepEqual(a.downloads.sort(), ['media/1.png', 'media/2.png']);
  assert.deepEqual(b.downloads.sort(), ['listings/1.png', 'listings/2.png']);
  const rows = await taskModel.find({}).lean();
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.status === 'completed'));
});

test("FrameworkMediaStore keeps one preview row per identity in the app's media model", async () => {
  const File = fileModel();
  installApp({ models: { File } });
  const store = new FrameworkMediaStore();
  store.verify();
  const doc = await File.create({
    original: { storageRef: { key: 'o.png' }, format: 'png' },
    previews: [],
  });
  const preview = (key: string) =>
    ({
      storageRef: { key },
      identity: 'default:default:16x16:webp:',
      sizeKey: '16x16',
      format: 'webp',
      contentType: 'image/webp',
    }) as Preview;
  const results = await Promise.all([
    store.appendPreviews(String(doc._id), [preview('one.webp')]),
    store.appendPreviews(String(doc._id), [preview('two.webp')]),
  ]);
  assert.equal(results.flat().length, 1);
  const stored = await File.findById(doc._id).lean();
  assert.equal(stored?.previews?.length, 1);
  assert.equal(
    (stored?.previews?.[0] as Preview | undefined)?.identity,
    'default:default:16x16:webp:',
  );
});

test('verify() rejects a media model registered without previews.identity', async () => {
  const { identity: _identity, ...previewFields } =
    resizeMediaSchemaFragment.previews[0];
  const OldFile =
    connection.models.OldFile ??
    connection.model(
      'OldFile',
      new mongoose.Schema(
        {
          original: resizeMediaSchemaFragment.original,
          previews: [previewFields],
        },
        { minimize: false },
      ),
    );
  installApp({
    configs: {
      resize: makeResizeConfig({
        mediaModelName: 'OldFile',
        storage: {
          driver: 'local',
          rootDir: './var/media',
          publicBaseUrl: '/m',
        },
      }),
    },
    models: { OldFile },
  });
  await assert.rejects(
    () => new FrameworkResizer().verify(),
    (err: unknown) =>
      err instanceof ResizeSetupError &&
      err.code === 'RESIZE_MONGO_MEDIA_MODEL_OUTDATED' &&
      err.message.includes("'OldFile'"),
  );
});

// --- queue names on two backends ------------------------------------------------------------

const runNode = promisify(execFile);
const href = (path: string) =>
  JSON.stringify(new URL(path, import.meta.url).href);

/**
 * Run `body` in a child process where the SQS SDK is missing (resolving it fails, so importing
 * the SQS driver would show), over a FrameworkResizer wired from a resize.ts with `queues`, on
 * this file's MongoDB server. The app has the ResizeTask and File models and no Lock model. The
 * body has `resizer`, `media` (an uploaded original on a stored File), `File`, `ResizeTask`,
 * `models` (every model name asked for), `outcome(promise)`, `untilPreviews(count, worker)` and
 * `sqsDriver` (every resolved drivers/sqs.ts), and prints its JSON result.
 */
async function runWithoutSqsSdk(
  name: string,
  queues: Record<string, unknown>,
  body: string,
): Promise<Record<string, unknown>> {
  const root = await mkdtemp(join(tmpdir(), 'resize-routes-'));
  try {
    const { stdout } = await runNode(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `
        import { registerHooks } from 'node:module';
        import mongoose from 'mongoose';
        import sharp from 'sharp';
        import { setAppInstance } from '@adaptivestone/framework/helpers/appInstance.js';
        import { FrameworkResizer } from ${href('./resizer.ts')};
        import { runResizeWorker } from ${href('./worker.ts')};
        import ResizeTaskModel from ${href('./ResizeTaskModel.ts')};
        import { resizeMediaSchemaFragment } from ${href('../drivers/mongo/mediaFragment.ts')};
        import { makeResizeConfig } from ${href('../testHelpers/resizeConfig.ts')};
        const sqsDriver = [];
        registerHooks({
          resolve(specifier, context, nextResolve) {
            if (specifier === '@aws-sdk/client-sqs') {
              throw Object.assign(new Error("Cannot find package '@aws-sdk/client-sqs' imported from driver"), { code: 'ERR_MODULE_NOT_FOUND' });
            }
            const resolved = nextResolve(specifier, context);
            if (resolved.url.endsWith('/drivers/sqs.ts')) {
              sqsDriver.push(resolved.url);
            }
            return resolved;
          },
        });
        const connection = await mongoose
          .createConnection(process.env.MONGO_URI, { dbName: process.env.MONGO_DB })
          .asPromise();
        const taskSchema = new mongoose.Schema(ResizeTaskModel.modelSchema, { timestamps: true, minimize: false });
        ResizeTaskModel.initHooks(taskSchema);
        const ResizeTask = connection.model('ResizeTask', taskSchema);
        const File = connection.model('File', new mongoose.Schema({ ...resizeMediaSchemaFragment }, { minimize: false }));
        await ResizeTask.init();
        const configs = {
          resize: makeResizeConfig({
            formats: ['webp'],
            worker: { enabled: true },
            storage: { driver: 'local', rootDir: process.env.MEDIA_ROOT, publicBaseUrl: '/media' },
            queues: ${JSON.stringify(queues)},
          }),
        };
        const models = [];
        const registered = { ResizeTask, File };
        setAppInstance({
          getConfig: (name) => configs[name] ?? {},
          getModel: (name) => {
            models.push(name);
            return registered[name];
          },
          logger: { info() {}, warn() {}, error() {} },
        });
        const outcome = (promise) =>
          promise.then(() => 'ok', (err) => ({ code: err.code, message: err.message }));
        let failed;
        const untilPreviews = async (count, worker) => {
          worker.catch((err) => {
            failed = err;
          });
          const until = Date.now() + 20000;
          while ((await File.findById(media.id).lean())?.previews?.length !== count) {
            if (failed) throw failed;
            if (Date.now() > until) throw new Error('the worker stored no preview');
            await new Promise((r) => setTimeout(r, 20));
          }
        };
        const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#08f' } }).png().toBuffer();
        const resizer = new FrameworkResizer();
        const original = await resizer.uploadOriginal({ body: png, visibility: 'private' });
        const doc = await File.create({ original, previews: [] });
        const media = { id: String(doc._id), original, previews: [] };
        ${body}
        await connection.dropDatabase();
        await connection.close();
      `,
      ],
      {
        env: {
          ...process.env,
          MONGO_URI: server.getUri(),
          MONGO_DB: `resize_routes_${name}_${process.pid}`,
          MEDIA_ROOT: join(root, 'public'),
        },
        timeout: 60_000,
      },
    );
    return JSON.parse(stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a database Resizer beside an SQS entry without its SDK: stored previews are served, database prewarm is accepted, a database worker starts, verify() needs no Lock model', async () => {
  const seen = await runWithoutSqsSdk(
    'database',
    {
      default: { driver: 'database', idlePollMs: 20 },
      bulk: { driver: 'sqs', queueUrl: 'https://sqs.example/bulk' },
    },
    `
      const verified = await outcome(resizer.verify());
      await resizer.generate({ media, sizes: [{ width: 8, height: 8 }] });
      const stored = await File.findById(media.id).lean();
      const read = await resizer.resolve({
        media: { id: media.id, original, previews: stored.previews },
        sizes: [{ width: 8, height: 8 }],
      });
      const warmed = await resizer.prewarm({ media, sizes: [{ width: 16, height: 16 }] });
      const bulk = await resizer.prewarm({ media, sizes: [{ width: 16, height: 16 }], queue: 'bulk' });
      const bulkWorker = await outcome(runResizeWorker({ queue: 'bulk' }));
      const worker = runResizeWorker({ queue: 'default' });
      try {
        await untilPreviews(2, worker);
      } finally {
        process.emit('SIGTERM');
        await worker;
      }
      const task = await ResizeTask.findOne({}).lean();
      console.log(JSON.stringify({
        verified,
        ready: read.decision.ready.length,
        missing: read.decision.missing.length,
        warmed: warmed.status,
        bulk: bulk.issues.map(({ code, retryable, message }) => ({ code, retryable, message })),
        bulkWorker,
        task: [task?.queue, task?.status],
        tasks: resizer.tasks.constructor.name,
        locks: resizer.locks === undefined,
        models: [...new Set(models)],
        sqsDriver,
      }));
    `,
  );
  assert.equal(seen.verified, 'ok');
  assert.equal(seen.ready, 1);
  assert.equal(seen.missing, 0);
  assert.equal(seen.warmed, 'accepted');
  const [bulk] = seen.bulk as Array<{
    code: string;
    retryable: boolean;
    message: string;
  }>;
  assert.equal(bulk.code, 'RESIZE_QUEUE_NOT_SERVED');
  assert.equal(bulk.retryable, false);
  assert.match(bulk.message, /@aws-sdk\/client-sqs/);
  const bulkWorker = seen.bulkWorker as { code: string; message: string };
  assert.equal(bulkWorker.code, 'RESIZE_QUEUE_NOT_SERVED');
  assert.match(bulkWorker.message, /@aws-sdk\/client-sqs/);
  assert.deepEqual(seen.task, ['default', 'completed']);
  assert.equal(seen.tasks, 'MongoTaskQueue');
  assert.equal(seen.locks, true);
  assert.equal((seen.models as string[]).includes('Lock'), false);
  assert.deepEqual(seen.sqsDriver, []);
});

test('the own queue on SQS without its SDK, bulk on the database: a worker for bulk starts and needs no Lock model; verify() is RESIZE_PEER_MISSING', async () => {
  const seen = await runWithoutSqsSdk(
    'own-sqs',
    {
      default: { driver: 'sqs', queueUrl: 'https://sqs.example/resize' },
      bulk: { driver: 'database', idlePollMs: 20 },
    },
    `
      const verified = await outcome(resizer.verify());
      const own = await resizer.prewarm({ media, sizes: [{ width: 16, height: 16 }] });
      const bulk = await resizer.prewarm({ media, sizes: [{ width: 16, height: 16 }], queue: 'bulk' });
      const worker = runResizeWorker({ queue: 'bulk' });
      try {
        await untilPreviews(1, worker);
      } finally {
        process.emit('SIGTERM');
        await worker;
      }
      const task = await ResizeTask.findOne({}).lean();
      console.log(JSON.stringify({
        verified,
        own: own.issues.map(({ code, retryable, message }) => ({ code, retryable, message })),
        bulk: bulk.status,
        task: [task?.queue, task?.status],
        models: [...new Set(models)],
        sqsDriver,
      }));
    `,
  );
  const verified = seen.verified as { code: string; message: string };
  assert.equal(verified.code, 'RESIZE_PEER_MISSING');
  assert.match(verified.message, /@aws-sdk\/client-sqs/);
  const [own] = seen.own as Array<{
    code: string;
    retryable: boolean;
    message: string;
  }>;
  assert.equal(own.code, 'RESIZE_QUEUE_NOT_SERVED');
  assert.equal(own.retryable, false);
  assert.match(own.message, /@aws-sdk\/client-sqs/);
  assert.equal(seen.bulk, 'accepted');
  assert.deepEqual(seen.task, ['bulk', 'completed']);
  assert.equal((seen.models as string[]).includes('Lock'), false);
  assert.deepEqual(seen.sqsDriver, []);
});

test('an environment override that moves only queues.default to SQS routes both names', async () => {
  await taskModel.deleteMany({});
  await lockModel.deleteMany({});
  const File = fileModel();
  const configs = {
    resize: makeResizeConfig({
      formats: ['webp'],
      storage: { driver: 'local', rootDir: './var/media', publicBaseUrl: '/m' },
      queues: {
        default: {
          driver: 'sqs',
          queueUrl: 'https://sqs.example/resize',
          ...testQueue,
        },
        bulk: { driver: 'database', ...testQueue },
      },
    }),
  };
  installApp({ configs, models: { File } });
  // A stand-in for SQS, registered under its name: it replaces the built-in driver.
  const sqs = fakeQueueDriver();
  const resizer = new FrameworkResizer({ drivers: { queue: { sqs } } });
  await resizer.ready();
  assert.ok(resizer.tasks instanceof RoutingTaskQueue);
  const media = newMedia();
  // The database queue's task row is its gate: no lock.
  const bulk = await resizer.prewarm({ media, sizes, queue: 'bulk' });
  assert.equal(bulk.status, 'accepted');
  assert.equal(await lockModel.countDocuments({}), 0);
  assert.deepEqual(
    (await taskModel.find({}).lean()).map((row) => row.queue),
    ['bulk'],
  );
  // The queue on SQS takes the gate lock in the framework Lock model.
  const own = await resizer.prewarm({ media, sizes });
  assert.equal(own.status, 'accepted');
  assert.equal(sqs.built.length, 1);
  assert.equal(sqs.built[0].added.length, 1);
  assert.deepEqual(
    (await lockModel.find({}).lean()).map((lock) => lock._id),
    [gateKey('default', 'default', String(media.id), 'default')],
  );
  await resizer.verify();
  // So verify() requires that model.
  installApp({ configs, models: { File, Lock: undefined } });
  const noLock = new FrameworkResizer({
    drivers: { queue: { sqs: fakeQueueDriver() } },
  });
  await assert.rejects(
    noLock.verify(),
    (err: unknown) =>
      err instanceof ResizeSetupError &&
      err.code === 'RESIZE_MONGO_MODEL_MISSING',
  );
});

test('two Resizers on different named queues run under one worker', async () => {
  await taskModel.deleteMany({});
  await lockModel.deleteMany({});
  installApp({
    configs: {
      resize: makeResizeConfig({
        formats: ['webp'],
        worker: { enabled: true },
        queues: {
          default: { driver: 'database', ...testQueue },
          bulk: {
            driver: 'sqs',
            queueUrl: 'https://sqs.example/bulk',
            ...testQueue,
          },
        },
      }),
      resizeListings: makeResizeConfig({ formats: ['webp'], queue: 'bulk' }),
    },
  });
  const sqs = fakeQueueDriver();
  const drivers = { queue: { sqs } };
  const mediaA = newMedia();
  const mediaB = newMedia();
  const a = new FrameworkResizer({
    drivers,
    storage: memoryStorage().storage,
    media: memoryMedia(mediaA),
  });
  const listings = new FrameworkResizer({
    name: 'listings',
    configName: 'resizeListings',
    drivers,
    storage: memoryStorage().storage,
    media: memoryMedia(mediaB),
  });
  assert.equal((await a.prewarm({ media: mediaA, sizes })).status, 'accepted');
  assert.equal(
    (await listings.prewarm({ media: mediaB, sizes })).status,
    'accepted',
  );
  const worker = runResizeWorker({ queue: ['default', 'bulk'] });
  try {
    await waitFor(
      () =>
        (mediaA.previews?.length ?? 0) > 0 &&
        (mediaB.previews?.length ?? 0) > 0,
    );
  } finally {
    process.emit('SIGTERM');
    await worker;
  }
  assert.deepEqual(
    sqs.built[0].rows.map((row) => [row.task.resizer, row.status]),
    [['listings', 'completed']],
  );
  assert.deepEqual(
    (await taskModel.find({}).lean()).map((row) => [
      row.resizer,
      row.queue,
      row.status,
    ]),
    [['default', 'default', 'completed']],
  );
});
