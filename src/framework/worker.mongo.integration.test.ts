// End-to-end worker routing on a real Mongo queue: one worker process serves two Resizers that
// share a task queue, named queues are isolated from each other, and a FrameworkResizer wired only
// by its config file runs through the framework worker entry.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import LockModel from '@adaptivestone/framework/models/Lock.js';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import sharp from 'sharp';
import type { ResizeDatabase } from '../contracts/database.ts';
import type { ResizeStorage } from '../contracts/storage.ts';
import { ResizeSetupError } from '../errors.ts';
import { resizeMediaSchemaFragment } from '../mediaFragment.ts';
import { resetResizerForTests } from '../resizer.ts';
import { fakeDb } from '../testHelpers/fakes.ts';
import { makeResizeConfig } from '../testHelpers/resizeConfig.ts';
import type { MediaLike, Preview } from '../types.d.ts';
import { runWorker } from '../worker.ts';
import { FrameworkDatabase } from './database.ts';
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
  taskModel = connection.model('ResizeTask', taskSchema);
  lockModel = connection.model('Lock', lockSchema);
  await Promise.all([taskModel.init(), lockModel.init()]);
});

after(async () => {
  await connection.close();
  await server.stop();
});

const testQueue = {
  leaseMs: 5000,
  idlePollMs: 20,
  lockTtlMs: { dispatch: 60000, worker: 5000 },
};

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
        worker: { enabled: true },
        queue: testQueue,
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

// In-memory media with the shared database's real Mongo locks.
function memoryDatabase(
  media: MediaLike,
  shared: ResizeDatabase,
): ResizeDatabase {
  return fakeDb({
    load: async (id) => (id === media.id ? media : null),
    appendPreviews: async (_id, previews: Preview[]) => {
      media.previews = [...(media.previews ?? []), ...previews];
    },
    locks: {
      acquire: (key, ttlMs) => shared.acquireLock(key, ttlMs),
      release: (key) => shared.releaseLock(key),
    },
  });
}

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
  const shared = new FrameworkDatabase();
  assert.ok(shared.tasks);
  const tasks = shared.tasks;
  const stop = new AbortController();
  const mediaA = newMedia();
  const mediaB = newMedia();
  const a = memoryStorage();
  const b = memoryStorage();
  const media = new FrameworkResizer({
    storage: a.storage,
    tasks,
    db: memoryDatabase(mediaA, shared),
  });
  const listings = new FrameworkResizer({
    name: 'listings',
    storage: b.storage,
    tasks,
    db: memoryDatabase(mediaB, shared),
  });

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
  const shared = new FrameworkDatabase();
  assert.ok(shared.tasks);
  const tasks = shared.tasks;

  const first = new AbortController();
  const resizer = new FrameworkResizer({
    storage: memory.storage,
    tasks,
    db: memoryDatabase(media, shared),
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
        queue: { driver: 'database', ...testQueue },
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
  const queue = { driver: 'database', ...testQueue };
  installApp({
    configs: {
      resize: makeResizeConfig({ formats: ['webp'], queue }),
      resizeListings: makeResizeConfig({ formats: ['webp'], queue }),
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
  assert.equal(media.db === listings.db, false);

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

test("FrameworkDatabase keeps one preview row per identity in the app's media model", async () => {
  const File = fileModel();
  installApp({ models: { File } });
  const db = new FrameworkDatabase();
  db.verify();
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
    db.appendPreviews(String(doc._id), [preview('one.webp')]),
    db.appendPreviews(String(doc._id), [preview('two.webp')]),
  ]);
  assert.equal(results.flatMap((r) => r ?? []).length, 1);
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
