// MongoMediaStore against a real MongoDB: one stored preview row per preview identity, however
// many workers render it, rows swapped by identity in one write, the preview metadata a row
// records, the startup check for a media model without those fields, and the `model` / `getModel`
// options.
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { types } from 'node:util';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import sharp from 'sharp';
import type { MediaStore } from '../../contracts/media.ts';
import { ResizeSetupError } from '../../errors.ts';
import { Resizer, resetResizerForTests } from '../../resizer.ts';
import { encodeSignature, previewOrigin } from '../../signatures.ts';
import {
  fakeMedia,
  MemoryTaskQueue,
  memoryStorage,
} from '../../testHelpers/fakes.ts';
import { makeImageConfig } from '../../testHelpers/resizeConfig.ts';
import { workUntil } from '../../testHelpers/work.ts';
import type { MediaLike, Preview, ResizeLogger } from '../../types.d.ts';
import { MongoMediaStore, type MongoMediaStoreOptions } from './index.ts';
import { resizeMediaSchemaFragment } from './mediaFragment.ts';

let server: MongoMemoryServer;
let connection: mongoose.Connection;

before(async () => {
  server = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  connection = await mongoose
    .createConnection(server.getUri(), {
      dbName: `resize_mongo_media_${process.pid}`,
    })
    .asPromise();
});

after(async () => {
  await connection.close();
  await server.stop();
});

afterEach(resetResizerForTests);

const Media = () =>
  connection.models.IdentityMedia ??
  connection.model(
    'IdentityMedia',
    new mongoose.Schema({ ...resizeMediaSchemaFragment }, { minimize: false }),
  );

// A media model whose schema predates `previews.identity` (a hand-written or outdated fragment).
const OutdatedMedia = () => {
  const { identity: _identity, ...previewFields } =
    resizeMediaSchemaFragment.previews[0];
  return (
    connection.models.OutdatedMedia ??
    connection.model(
      'OutdatedMedia',
      new mongoose.Schema(
        {
          original: resizeMediaSchemaFragment.original,
          previews: [previewFields],
        },
        { minimize: false },
      ),
    )
  );
};

// A media model whose `previews` path is declared as given (registered once per name).
const mediaModelWith = (name: string, previews: unknown) =>
  connection.models[name] ??
  connection.model(
    name,
    new mongoose.Schema(
      { original: resizeMediaSchemaFragment.original, previews } as never,
      { minimize: false },
    ),
  );

function mediaStore(): MongoMediaStore {
  return new MongoMediaStore({ model: Media() });
}

async function newMedia(previews: Preview[] = []): Promise<string> {
  const doc = await Media().create({
    original: { storageRef: { path: 'o.png' }, format: 'png' },
    previews,
  });
  return String(doc._id);
}

async function storedPreviews(mediaId: string): Promise<Preview[]> {
  const doc = (await Media().findById(mediaId).lean()) as {
    previews?: Preview[];
  } | null;
  return doc?.previews ?? [];
}

function preview(identity: string | undefined, path = identity): Preview {
  return {
    storageRef: { path: `${path ?? 'none'}.webp` },
    ...(identity === undefined ? {} : { identity }),
    sizeKey: '16x16',
    format: 'webp',
    contentType: 'image/webp',
  } as Preview;
}

// A worker's first render of a new media on `model`, over a MemoryTaskQueue.
async function firstRender(
  model: ReturnType<typeof mediaModelWith>,
  sizes: { width: number; height: number }[],
) {
  const png = await sharp({
    create: {
      width: 64,
      height: 48,
      channels: 3,
      background: { r: 0, g: 0, b: 200 },
    },
  })
    .png()
    .toBuffer();
  const logger: ResizeLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const { storage } = memoryStorage();
  const tasks = new MemoryTaskQueue({
    timing: { idlePollMs: 5, retryBackoffMs: { base: 5, max: 5 } },
  });
  const store = new MongoMediaStore({ model });
  const r = new Resizer({
    config: makeImageConfig({ formats: ['webp'] }),
    logger,
    storage,
    media: store,
    tasks,
  });
  const original = await r.uploadOriginal({
    body: png,
    visibility: 'private',
  });
  const id = String((await model.create({ original }))._id);
  await r.resolve({ media: (await store.loadMedia(id)) as MediaLike, sizes });
  await workUntil({ logger, resizers: [r] }, () =>
    tasks.rows.every(
      (row) => row.status === 'completed' || row.status === 'dead',
    ),
  );
  return { r, id, tasks };
}

const ID_A = 'default:default:16x16:webp:';
const ID_B = 'default:default:32x32:webp:';

describe('MongoMediaStore.appendPreviews: one row per preview identity', () => {
  test('a second append of a stored identity leaves one row and resolves with nothing stored', async () => {
    const store = mediaStore();
    const mediaId = await newMedia();
    const first = preview(ID_A, 'first');
    const second = preview(ID_A, 'second');

    assert.deepEqual(await store.appendPreviews(mediaId, [first]), [first]);
    assert.deepEqual(await store.appendPreviews(mediaId, [second]), []);

    const rows = await storedPreviews(mediaId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].identity, ID_A);
    assert.deepEqual(rows[0].storageRef, { path: 'first.webp' });
  });

  test('concurrent appends of one identity store exactly one row', async () => {
    const store = mediaStore();
    const mediaId = await newMedia();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.appendPreviews(mediaId, [preview(ID_A, `worker-${i}`)]),
      ),
    );

    const rows = await storedPreviews(mediaId);
    assert.equal(rows.length, 1);
    // The one append that stored the row reports it; every other append reports nothing.
    const stored = results.filter((r) => (r ?? []).length > 0);
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0]?.[0]?.storageRef, rows[0].storageRef);
  });

  test('different identities are all stored, and a repeat inside one call is stored once', async () => {
    const store = mediaStore();
    const mediaId = await newMedia();
    const a = preview(ID_A);
    const b = preview(ID_B);

    assert.deepEqual(
      await store.appendPreviews(mediaId, [a, b, preview(ID_A, 'repeat')]),
      [a, b],
    );
    const rows = await storedPreviews(mediaId);
    assert.deepEqual(
      rows.map((r) => r.identity),
      [ID_A, ID_B],
    );
  });

  test('a preview without an identity is always stored', async () => {
    const store = mediaStore();
    const mediaId = await newMedia();
    const legacy = preview(undefined, 'legacy');

    assert.deepEqual(await store.appendPreviews(mediaId, [legacy]), [legacy]);
    assert.deepEqual(await store.appendPreviews(mediaId, [legacy]), [legacy]);
    assert.equal((await storedPreviews(mediaId)).length, 2);
  });

  test('a row stored without an identity never matches a new one', async () => {
    const store = mediaStore();
    const mediaId = await newMedia([preview(undefined, 'old-row')]);
    const fresh = preview(ID_A, 'fresh');

    assert.deepEqual(await store.appendPreviews(mediaId, [fresh]), [fresh]);
    assert.equal((await storedPreviews(mediaId)).length, 2);
  });

  test('the dimension backfill is applied, also when every preview was skipped', async () => {
    const store = mediaStore();
    const mediaId = await newMedia();
    await store.appendPreviews(mediaId, [preview(ID_A)]);

    assert.deepEqual(
      await store.appendPreviews(mediaId, [preview(ID_A, 'late')], {
        width: 64,
        height: 48,
      }),
      [],
    );
    const loaded = await store.loadMedia(mediaId);
    assert.equal(loaded?.original?.width, 64);
    assert.equal(loaded?.original?.height, 48);
    assert.equal(loaded?.previews?.length, 1);

    const other = await newMedia();
    const stored = preview(ID_B);
    assert.deepEqual(
      await store.appendPreviews(other, [stored], { width: 10, height: 20 }),
      [stored],
    );
    const loadedOther = await store.loadMedia(other);
    assert.equal(loadedOther?.original?.width, 10);
    assert.equal(loadedOther?.original?.height, 20);
    assert.equal(loadedOther?.previews?.length, 1);
  });

  test('media that no longer exists is a silent no-op', async () => {
    const store = mediaStore();
    const gone = String(new mongoose.Types.ObjectId());
    assert.deepEqual(
      await store.appendPreviews(gone, [preview(ID_A), preview(undefined)], {
        width: 1,
        height: 1,
      }),
      [],
    );
    assert.equal(await store.loadMedia(gone), null);
  });

  test("every write runs the host's findOneAndUpdate middleware and returns only the id", async () => {
    const seen: Array<{ ops: string[]; fields: string[] | null }> = [];
    const schema = new mongoose.Schema(
      { ...resizeMediaSchemaFragment },
      { minimize: false },
    );
    // A host that refreshes a cache or a search index after each media update.
    schema.post(
      'findOneAndUpdate',
      function (this: mongoose.Query<unknown, unknown>, doc: unknown) {
        seen.push({
          ops: Object.keys(this.getUpdate() ?? {}),
          fields: doc
            ? Object.keys((doc as mongoose.Document).toObject())
            : null,
        });
      },
    );
    const Hooked =
      connection.models.HookedMedia ?? connection.model('HookedMedia', schema);
    const store = new MongoMediaStore({ model: Hooked });
    const doc = await Hooked.create({
      original: { storageRef: { path: 'o.png' }, format: 'png' },
      previews: [],
    });
    const stored = preview(ID_A);

    assert.deepEqual(
      await store.appendPreviews(
        String(doc._id),
        [stored, preview(ID_A, 'again')],
        { width: 64, height: 48 },
      ),
      [stored],
    );
    // The backfill, the stored preview, then the skipped one (no document matched).
    assert.deepEqual(seen, [
      { ops: ['$set'], fields: ['_id'] },
      { ops: ['$push'], fields: ['_id'] },
      { ops: ['$push'], fields: null },
    ]);
    const reloaded = await Hooked.findById(doc._id).lean();
    assert.equal(reloaded?.previews?.length, 1);
    assert.equal(reloaded?.original?.width, 64);
  });
});

describe('MongoMediaStore: the dimension backfill writes only while the pair is absent', () => {
  for (const [name, dims, width, height] of [
    ['both stored', { width: 80, height: 60 }, 80, 60],
    ['none stored', {}, 4000, 3000],
    ['a null width', { width: null, height: 60 }, 4000, 3000],
    ['a width alone', { width: 80 }, 4000, 3000],
  ] as const) {
    test(`${name}: the original then holds ${width}×${height}`, async () => {
      const doc = await Media().create({
        original: { storageRef: { path: 'o.png' }, ...dims },
      });
      const id = String(doc._id);
      await mediaStore().appendPreviews(id, [], { width: 4000, height: 3000 });
      const loaded = await mediaStore().loadMedia(id);
      assert.equal(loaded?.original?.width, width);
      assert.equal(loaded?.original?.height, height);
    });
  }

  // A media model with the given `original` and schema options (registered once per name).
  const modelOf = (
    name: string,
    original: unknown,
    options: Record<string, unknown> = {},
  ) =>
    connection.models[name] ??
    connection.model(
      name,
      new mongoose.Schema(
        { original, previews: resizeMediaSchemaFragment.previews } as never,
        { minimize: false, ...options },
      ),
    );
  const dims = { width: 1, height: 2 };
  // `original.width` is undeclared here.
  const undeclaredWidth = {
    storageRef: { type: 'Mixed' },
    height: { type: Number },
  };

  test('a Decimal128 dimension in a Mixed original does not count as stored: the backfill replaces it', async () => {
    const model = modelOf('BackfillDecimalMedia', {
      type: mongoose.Schema.Types.Mixed,
    });
    const store = new MongoMediaStore({ model });
    const doc = await model.create({
      original: {
        width: mongoose.Types.Decimal128.fromString('80'),
        height: 60,
      },
    });
    await store.appendPreviews(String(doc._id), [], dims);
    const loaded = await store.loadMedia(String(doc._id));
    assert.equal(loaded?.original?.width, 1);
    assert.equal(loaded?.original?.height, 2);
  });

  test('a Mixed original is filtered the same', async () => {
    const model = modelOf('BackfillMixedMedia', {
      type: mongoose.Schema.Types.Mixed,
    });
    const store = new MongoMediaStore({ model });
    const held = await model.create({ original: { width: 80, height: 60 } });
    const bare = await model.create({
      original: { storageRef: { path: 'o' } },
    });
    await store.appendPreviews(String(held._id), [], dims);
    await store.appendPreviews(String(bare._id), [], dims);
    assert.equal(
      (await store.loadMedia(String(held._id)))?.original?.width,
      80,
    );
    assert.equal((await store.loadMedia(String(bare._id)))?.original?.width, 1);
  });

  test('strictQuery: true: a stored pair stays', async () => {
    const model = modelOf('BackfillStrictQueryMedia', undeclaredWidth, {
      strictQuery: true,
    });
    const held = await model.create({ original: { height: 6 } });
    // Written around the schema.
    await model.collection.updateOne(
      { _id: held._id },
      { $set: { 'original.width': 5 } },
    );
    const store = new MongoMediaStore({ model });
    await store.appendPreviews(String(held._id), [], dims);
    assert.equal(
      (await store.loadMedia(String(held._id)))?.original?.height,
      6,
    );
  });

  test("strictQuery: 'throw' does not reject the filter of an undeclared dimension", async () => {
    const model = modelOf('BackfillStrictQueryThrowMedia', undeclaredWidth, {
      strictQuery: 'throw',
    });
    const bare = await model.create({ original: { height: 6 } });
    const store = new MongoMediaStore({ model });
    await assert.doesNotReject(
      store.appendPreviews(String(bare._id), [], dims),
    );
  });

  test('an original swapped in with its own dimensions during the render keeps them, with no warning', async () => {
    const png = (width: number, height: number) =>
      sharp({
        create: {
          width,
          height,
          channels: 3,
          background: { r: 200, g: 0, b: 0 },
        },
      })
        .png()
        .toBuffer();
    const warnings: string[] = [];
    const logger: ResizeLogger = {
      info: () => {},
      warn: (message) => void warnings.push(String(message)),
      error: () => {},
    };
    const { storage } = memoryStorage();
    const tasks = new MemoryTaskQueue({
      timing: { idlePollMs: 5, retryBackoffMs: { base: 5, max: 5 } },
    });
    const store = mediaStore();
    const r = new Resizer({
      config: makeImageConfig({ formats: ['webp'] }),
      logger,
      storage,
      media: store,
      tasks,
    });
    const a = await r.uploadOriginal({
      body: await png(400, 300),
      visibility: 'private',
    });
    const b = await r.uploadOriginal({
      body: await png(80, 60),
      visibility: 'private',
    });
    const { width: _width, height: _height, ...bare } = a;
    const id = String((await Media().create({ original: bare }))._id);
    const download = storage.download.bind(storage);
    let swapped = false;
    storage.download = async (ref) => {
      const bytes = await download(ref);
      if (!swapped) {
        swapped = true;
        await Media().updateOne({ _id: id }, { $set: { original: b } });
      }
      return bytes;
    };
    const sizes = [{ width: 20, height: 20 }];

    await r.resolve({
      media: (await store.loadMedia(id)) as MediaLike,
      sizes,
    });
    await workUntil({ logger, resizers: [r] }, () =>
      tasks.rows.every(
        (row) => row.status === 'completed' || row.status === 'dead',
      ),
    );

    assert.deepEqual(
      tasks.rows.map((row) => [row.status, row.attempts]),
      [['completed', 2]],
    );
    const loaded = (await store.loadMedia(id)) as MediaLike;
    assert.equal(loaded.original?.width, 80);
    assert.equal(loaded.original?.height, 60);
    assert.deepEqual(
      warnings.filter((m) =>
        m.includes("did not record the original's dimensions"),
      ),
      [],
    );
    const { decision } = await r.resolve({
      media: loaded,
      sizes,
      enqueueMissing: false,
    });
    assert.equal(decision.missing.length, 0);
    assert.equal(decision.ready[0].stale, undefined);
  });
});

describe('MongoMediaStore: new preview rows store no _id', () => {
  test('neither an appended nor a replaced row stores one, and two loads read the same rows', async () => {
    const store = mediaStore();
    const id = await newMedia();
    await store.appendPreviews(id, [preview(ID_A)]);
    await store.replacePreviews(id, [ID_B], [preview(ID_B)]);

    assert.deepEqual(
      (await storedPreviews(id)).map((row) => '_id' in row),
      [false, false],
    );
    const one = await Media().findById(id);
    const two = await Media().findById(id);
    assert.deepEqual(one?.toObject().previews, two?.toObject().previews);
  });

  test('an older row with a stored _id keeps it when loaded, and is replaced by its identity', async () => {
    const id = await newMedia();
    const stored = new mongoose.Types.ObjectId();
    await Media().collection.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $push: { previews: { ...preview(ID_A), _id: stored } } } as never,
    );

    const loaded = await Media().findById(id);
    const row = loaded?.toObject().previews[0] as { _id?: unknown };
    assert.equal(String(row._id), String(stored));

    const { removed } = await mediaStore().replacePreviews(
      id,
      [ID_A],
      [preview(ID_A, 'new')],
    );
    assert.equal(removed.length, 1);
    assert.deepEqual(
      (await storedPreviews(id)).map((r) => '_id' in r),
      [false],
    );
  });

  test('the upgrade renders nothing: a row stored with an _id reads fresh through the current fragment, and queues no task', async () => {
    // One collection, written through rows that keep their `_id`, as 0.3.0's fragment did.
    const { _id: _rowId, ...rowFields } = resizeMediaSchemaFragment.previews[0];
    const named = (name: string, definition: object) =>
      connection.models[name] ??
      connection.model(
        name,
        new mongoose.Schema(definition as never, { minimize: false }),
        'upgraded_media',
      );
    const before = named('UpgradeBeforeMedia', {
      original: resizeMediaSchemaFragment.original,
      previews: [rowFields],
    });
    const current = named('UpgradeCurrentMedia', {
      ...resizeMediaSchemaFragment,
    });
    const sizes = [{ width: 20, height: 20 }];
    const { r, id, tasks } = await firstRender(before, sizes);
    const [stored] = (
      (await current.findById(id).lean()) as { previews: Preview[] }
    ).previews;
    assert.ok('_id' in stored);

    const { decision } = await r.resolve({
      media: (await new MongoMediaStore({ model: current }).loadMedia(
        id,
      )) as MediaLike,
      sizes,
    });

    assert.equal(decision.missing.length, 0);
    assert.equal(decision.ready.length, 1);
    assert.equal(decision.ready[0].stale, undefined);
    assert.equal(tasks.rows.length, 1);
  });

  // A loaded media, as far as a host's code that removes a row reaches into it.
  interface LoadedRow {
    _id?: unknown;
    id?: unknown;
    identity?: string;
    deleteOne(): unknown;
  }
  type LoadedRows = LoadedRow[] & {
    id(id: unknown): LoadedRow | null;
    pull(...values: unknown[]): unknown;
    remove(...values: unknown[]): unknown;
  };
  interface LoadedMedia {
    previews: LoadedRows;
    markModified(path: string): void;
    save(): Promise<unknown>;
  }

  const OLD_1 = new mongoose.Types.ObjectId();
  const OLD_2 = new mongoose.Types.ObjectId();
  const identityOf = (name: string) => `default:default:${name}:webp:`;
  const namedRow = (name: string, _id?: mongoose.Types.ObjectId) => ({
    ...preview(identityOf(name), name),
    sizeKey: name,
    ...(_id ? { _id } : {}),
  });
  // Written past the schema: two rows as 0.3.0 appended them, and two with no `_id`.
  const mixedMedia = async (
    model: ReturnType<typeof mediaModelWith> = Media(),
  ) => {
    const { insertedId } = await model.collection.insertOne({
      previews: [
        namedRow('old1', OLD_1),
        namedRow('old2', OLD_2),
        namedRow('new1'),
        namedRow('new2'),
      ],
    } as never);
    return {
      id: insertedId,
      doc: (await model.findById(insertedId)) as unknown as LoadedMedia,
    };
  };
  const storedRows = async (
    id: unknown,
    model: ReturnType<typeof mediaModelWith> = Media(),
  ) =>
    (
      (await model.collection.findOne({ _id: id } as never)) as unknown as {
        previews: Array<{ sizeKey: string; _id?: unknown }>;
      }
    ).previews;
  const storedKeys = async (
    id: unknown,
    model?: ReturnType<typeof mediaModelWith>,
  ) => (await storedRows(id, model)).map((row) => row.sizeKey);
  const OLD_REMOVED = ['old2', 'new1', 'new2'];
  const NEW_REMOVED = ['old1', 'old2', 'new2'];
  const ALL = ['old1', 'old2', 'new1', 'new2'];

  test('row._id: an older row reads its stored id, a new row reads undefined, hydrated and lean', async () => {
    const { id, doc } = await mixedMedia();
    const stored = [String(OLD_1), String(OLD_2), undefined, undefined];
    const text = (rows: Array<{ _id?: unknown }>) =>
      rows.map((row) => (row._id === undefined ? undefined : String(row._id)));

    assert.deepEqual(text(doc.previews), stored);
    assert.deepEqual(
      doc.previews.map((row) => row.id),
      [String(OLD_1), String(OLD_2), null, null],
    );
    const lean = (await Media().findById(id).lean()) as unknown as {
      previews: Array<{ _id?: unknown }>;
    };
    assert.deepEqual(text(lean.previews), stored);
  });

  test('markModified and a push invent no id when saved, and an older row keeps its own', async () => {
    const { id, doc } = await mixedMedia();
    doc.previews.push(namedRow('pushed') as unknown as LoadedRow);
    doc.markModified('previews');
    await doc.save();

    const rows = await storedRows(id);
    assert.deepEqual(
      rows.map((row) => [row.sizeKey, '_id' in row]),
      [
        ['old1', true],
        ['old2', true],
        ['new1', false],
        ['new2', false],
        ['pushed', false],
      ],
    );
    assert.equal(String(rows[0]._id), String(OLD_1));
  });

  // What removing one row by hand does on a mixed array, saved. Measured the same on mongoose 9.0.0
  // and 9.11.4. The README and the changelog name the two forms that lose rows, so a change here
  // changes what they tell a host.
  for (const [name, remove, left] of [
    [
      'an older row, row.deleteOne(): that row',
      (doc) => doc.previews[0].deleteOne(),
      OLD_REMOVED,
    ],
    [
      'an older row, previews.id(oid).deleteOne(): that row',
      (doc) => doc.previews.id(OLD_1)?.deleteOne(),
      OLD_REMOVED,
    ],
    [
      'an older row, previews.pull(oid): that row',
      (doc) => doc.previews.pull(OLD_1),
      OLD_REMOVED,
    ],
    [
      'an older row, previews.pull({ _id }): that row',
      (doc) => doc.previews.pull({ _id: OLD_1 }),
      OLD_REMOVED,
    ],
    [
      'an older row, previews.remove(oid): that row',
      (doc) => doc.previews.remove(OLD_1),
      OLD_REMOVED,
    ],
    [
      'an older row, a filter on String(_id): that row',
      (doc) => {
        const first = doc.previews[0];
        doc.previews = doc.previews.filter(
          (row) => String(row._id) !== String(first._id),
        ) as LoadedRows;
      },
      OLD_REMOVED,
    ],
    [
      'a new row, previews.pull(row._id): nothing',
      (doc) => doc.previews.pull(doc.previews[2]._id),
      ALL,
    ],
    [
      'a new row, previews.remove(row._id): nothing',
      (doc) => doc.previews.remove(doc.previews[2]._id),
      ALL,
    ],
    [
      'a new row, previews.pull({ _id: row._id }): EVERY row, the older ones too',
      (doc) => doc.previews.pull({ _id: doc.previews[2]._id }),
      [],
    ],
    [
      'a new row, a filter on String(_id): every row without an _id',
      (doc) => {
        const first = doc.previews[2];
        doc.previews = doc.previews.filter(
          (row) => String(row._id) !== String(first._id),
        ) as LoadedRows;
      },
      ['old1', 'old2'],
    ],
    [
      'a new row, previews.pull(row): that row',
      (doc) => doc.previews.pull(doc.previews[2]),
      NEW_REMOVED,
    ],
    [
      'a new row, previews.pull({ identity }): that row',
      (doc) => doc.previews.pull({ identity: identityOf('new1') }),
      NEW_REMOVED,
    ],
    [
      'an older row, previews.pull({ identity }): that row',
      (doc) => doc.previews.pull({ identity: identityOf('old1') }),
      OLD_REMOVED,
    ],
    [
      'a new row, a filter on identity: that row',
      (doc) => {
        doc.previews = doc.previews.filter(
          (row) => row.identity !== identityOf('new1'),
        ) as LoadedRows;
      },
      NEW_REMOVED,
    ],
  ] as [string, (doc: LoadedMedia) => unknown, string[]][]) {
    test(`removing by hand on a mixed array: ${name}`, async () => {
      const { id, doc } = await mixedMedia();
      await remove(doc);
      await doc.save();
      assert.deepEqual(await storedKeys(id), left);
    });
  }

  test('a new row: row.deleteOne() and previews.id(row._id).deleteOne() fail loudly, and remove nothing', async () => {
    const { id, doc } = await mixedMedia();
    const row = doc.previews[2];

    await assert.rejects(async () => row.deleteOne());
    assert.equal(doc.previews.id(row._id), null);

    await doc.save();
    assert.deepEqual(await storedKeys(id), ALL);
  });

  test('invalidate() removes a mixed array by identity and returns every ref', async () => {
    const { storage } = memoryStorage();
    const r = new Resizer({
      config: makeImageConfig({ formats: ['webp'] }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      storage,
      media: mediaStore(),
    });
    const { id, doc } = await mixedMedia();

    const refs = await r.invalidate({ media: doc as unknown as MediaLike });

    assert.equal(refs.length, 4);
    assert.deepEqual(await storedKeys(id), []);
  });

  test('a hand-written row schema with the documented _id acts as the fragment does', async () => {
    const model = mediaModelWith('HandWrittenIdMedia', [
      new mongoose.Schema({
        _id: { type: 'ObjectId', auto: false },
        storageRef: { type: 'Mixed' },
        identity: { type: String },
        origin: { type: String },
        encodeSig: { type: String },
        sizeKey: { type: String },
        format: { type: String },
        contentType: { type: String },
        fit: { type: Boolean },
      }),
    ]);
    const store = new MongoMediaStore({ model });
    assert.doesNotThrow(() => store.verify());

    const { id, doc } = await mixedMedia(model);
    assert.deepEqual(
      doc.previews.map((row) => row.id),
      [String(OLD_1), String(OLD_2), null, null],
    );
    doc.previews.pull(OLD_1);
    await doc.save();
    assert.deepEqual(await storedKeys(id, model), OLD_REMOVED);

    await store.appendPreviews(String(id), [namedRow('appended')]);
    const rows = await storedRows(id, model);
    assert.deepEqual(
      rows.map((row) => [row.sizeKey, '_id' in row]),
      [
        ['old2', true],
        ['new1', false],
        ['new2', false],
        ['appended', false],
      ],
    );
  });

  test('rows declared with _id: false: a removal by the id of an older row removes every row, which is why the fragment does not', async () => {
    const { _id: _rowId, ...rowFields } = resizeMediaSchemaFragment.previews[0];
    const model = mediaModelWith('IdFalseMedia', [
      new mongoose.Schema(rowFields as never, { _id: false }),
    ]);
    const { id, doc } = await mixedMedia(model);

    doc.previews.pull(OLD_1);
    await doc.save();

    assert.deepEqual(await storedKeys(id, model), []);
  });
});

// The paths under `value` that hold null (an undefined written through an update pipeline would).
function nullPaths(value: unknown, path = ''): string[] {
  if (value === null) {
    return [path];
  }
  if (
    typeof value !== 'object' ||
    value instanceof Date ||
    value instanceof mongoose.Types.ObjectId
  ) {
    return [];
  }
  return Object.entries(value).flatMap(([key, inner]) =>
    nullPaths(inner, path ? `${path}.${key}` : key),
  );
}

describe('MongoMediaStore.replacePreviews: swap rows by identity in one write', () => {
  test('replacePreviews swaps rows by identity in one write and returns what it removed, as plain objects', async () => {
    const seen: Array<{ pipeline: boolean; result: unknown }> = [];
    const schema = new mongoose.Schema(
      { ...resizeMediaSchemaFragment },
      { minimize: false },
    );
    schema.post(
      'findOneAndUpdate',
      function (this: mongoose.Query<unknown, unknown>, result: unknown) {
        seen.push({ pipeline: Array.isArray(this.getUpdate()), result });
      },
    );
    const Hooked =
      connection.models.ReplaceHookedMedia ??
      connection.model('ReplaceHookedMedia', schema);
    const store = new MongoMediaStore({ model: Hooked });
    const doc = await Hooked.create({
      original: { storageRef: { path: 'o.png' }, format: 'png' },
      previews: [
        preview(undefined, 'x0'),
        preview(ID_A, 'a1'),
        preview(ID_B, 'b1'),
      ],
    });
    const mediaId = String(doc._id);
    const createdAt = new Date('2026-10-28T12:00:00.000Z');
    const next: Preview = { ...preview(ID_A, 'a9'), createdAt };

    const result = await store.replacePreviews(mediaId, ['zzz'], [next]);

    assert.deepEqual(
      result.removed.map((row) => [row.identity, row.storageRef]),
      [[ID_A, { path: 'a1.webp' }]],
    );
    assert.equal(Object.getPrototypeOf(result.removed[0]), Object.prototype);
    assert.deepEqual(result.stored, [next]);
    assert.equal(types.isProxy(result.stored), false);
    assert.equal(Object.getPrototypeOf(result.stored[0]), Object.prototype);
    // One write, an update pipeline, whose result is the pre-image projected on `previews`.
    assert.equal(seen.length, 1);
    assert.equal(seen[0].pipeline, true);
    assert.deepEqual(Object.keys(seen[0].result as object).sort(), [
      '_id',
      'previews',
    ]);
    assert.equal(
      (seen[0].result as { previews: unknown[] }).previews.length,
      3,
    );

    const rows = (
      (await Hooked.findById(mediaId).lean()) as { previews: Preview[] }
    ).previews;
    assert.deepEqual(
      rows.map((row) => row.storageRef),
      [{ path: 'x0.webp' }, { path: 'b1.webp' }, { path: 'a9.webp' }],
    );
    assert.ok(rows[2].createdAt instanceof Date);
    assert.equal(rows[2].createdAt.getTime(), createdAt.getTime());
    assert.deepEqual(nullPaths(rows), []);
  });

  test('replacePreviews stores what appendPreviews would on a strict schema', async () => {
    const { origin: _origin, ...rowFields } =
      resizeMediaSchemaFragment.previews[0];
    const model = mediaModelWith('NoOriginReplaceMedia', [rowFields]);
    const store = new MongoMediaStore({ model });
    const create = async () =>
      String(
        (
          await model.create({
            original: { storageRef: { path: 'o.png' }, format: 'png' },
            previews: [],
          })
        )._id,
      );
    const rowsOf = async (id: string) =>
      (
        (await model.findById(id).lean()) as { previews: Preview[] }
      ).previews.map(({ _id, ...row }: Preview & { _id?: unknown }) => row);
    const row = {
      ...preview(ID_A, 'strict'),
      origin: '8c64760b02a9f12a',
      bytes: '12',
    } as unknown as Preview;
    const appended = await create();
    const replaced = await create();

    await store.appendPreviews(appended, [row]);
    const result = await store.replacePreviews(replaced, [], [row]);

    const [stored] = await rowsOf(replaced);
    assert.deepEqual(await rowsOf(replaced), await rowsOf(appended));
    assert.equal(Object.hasOwn(stored, 'origin'), false);
    assert.equal(stored.bytes, 12);
    assert.deepEqual(result, { stored: [stored], removed: [] });
  });

  test('replacePreviews on loose rows (strict: false) keeps every key the row carries', async () => {
    const model = mediaModelWith('LooseReplaceMedia', [
      new mongoose.Schema(
        { identity: String, sizeKey: String },
        { strict: false },
      ),
    ]);
    const store = new MongoMediaStore({ model });
    assert.doesNotThrow(() => store.verify());
    const id = String(
      (
        await model.create({
          original: { storageRef: { path: 'o.png' }, format: 'png' },
          previews: [],
        })
      )._id,
    );
    const rowsOf = async () =>
      (
        (await model.findById(id).lean()) as { previews: Preview[] }
      ).previews.map(({ _id, ...row }: Preview & { _id?: unknown }) => row);
    const row: Preview = {
      ...preview(ID_A, 'loose'),
      origin: '8c64760b02a9f12a',
      encodeSig: '5bff549d897f4636',
      bytes: 1234,
      createdAt: new Date('2026-10-28T12:34:56.789Z'),
    };

    await store.appendPreviews(id, [row]);
    const [appended] = await rowsOf();
    assert.ok(appended.createdAt instanceof Date);
    const replacement: Preview = { ...row, storageRef: { path: 'a9.webp' } };
    const result = await store.replacePreviews(id, [ID_A], [replacement]);

    const rows = await rowsOf();
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { ...appended, storageRef: { path: 'a9.webp' } });
    assert.ok(rows[0].createdAt instanceof Date);
    assert.equal(result.removed.length, 1);
    assert.equal(result.stored.length, 1);
    assert.equal(result.stored[0].encodeSig, '5bff549d897f4636');
  });

  test('replacePreviews stores storageRef and filters as given when the rows declare them as strict-free sub-schemas', async () => {
    // castObject returns only the declared paths at every depth, so a nested sub-schema would lose
    // the undeclared keys of a storage ref (the driver's locator) and of the filters.
    const model = mediaModelWith('NestedLooseReplaceMedia', [
      new mongoose.Schema(
        {
          sizeKey: String,
          identity: String,
          origin: String,
          encodeSig: String,
          format: String,
          contentType: String,
          // `_id: false`: an appended single-nested sub-document would otherwise gain an `_id`.
          storageRef: new mongoose.Schema(
            { driver: String },
            { strict: false, _id: false },
          ),
          filters: new mongoose.Schema(
            { q: Number },
            { strict: false, _id: false },
          ),
        },
        { strict: false },
      ),
    ]);
    const store = new MongoMediaStore({ model });
    const id = String(
      (
        await model.create({
          original: { storageRef: { path: 'o.png' }, format: 'png' },
          previews: [],
        })
      )._id,
    );
    const shaped = (identity: string): Preview =>
      ({
        ...preview(identity),
        storageRef: { driver: 'custom', key: 'preserve-me' },
        filters: { q: 1, extra: 'x' },
      }) as unknown as Preview;

    await store.appendPreviews(id, [shaped(ID_A)]);
    await store.replacePreviews(id, [], [shaped(ID_B)]);

    const rows = ((await model.findById(id).lean()) as { previews: Preview[] })
      .previews;
    const appended = rows.find((row) => row.identity === ID_A);
    const replaced = rows.find((row) => row.identity === ID_B);
    assert.ok(appended && replaced);
    assert.deepEqual(appended.storageRef, {
      driver: 'custom',
      key: 'preserve-me',
    });
    assert.deepEqual(replaced.storageRef, appended.storageRef);
    assert.deepEqual(appended.filters, { q: 1, extra: 'x' });
    assert.deepEqual(replaced.filters, appended.filters);
  });

  test('replacePreviews on strict rows stores a Mixed storageRef as given', async () => {
    const model = mediaModelWith('StrictMixedReplaceMedia', [
      new mongoose.Schema({
        sizeKey: String,
        identity: String,
        origin: String,
        encodeSig: String,
        format: String,
        contentType: String,
        storageRef: { type: mongoose.Schema.Types.Mixed },
      }),
    ]);
    const store = new MongoMediaStore({ model });
    const id = String(
      (
        await model.create({
          original: { storageRef: { path: 'o.png' }, format: 'png' },
          previews: [],
        })
      )._id,
    );
    const storageRef = {
      driver: 'custom',
      key: 'preserve-me',
      grouping: { namespace: 'users/42', empty: {} },
    };

    await store.replacePreviews(
      id,
      [],
      [{ ...preview(ID_A), storageRef } as unknown as Preview],
    );

    const [stored] = (
      (await model.findById(id).lean()) as { previews: Preview[] }
    ).previews;
    assert.deepEqual(stored.storageRef, storageRef);
  });

  test('a row the strict schema cannot cast rejects with a ValidationError and leaves the document unchanged', async () => {
    const store = mediaStore();
    const mediaId = await newMedia([preview(ID_A, 'a1'), preview(ID_B, 'b1')]);
    const before = await storedPreviews(mediaId);
    const uncastable = {
      ...preview('default:default:8x8:webp:', 'bad'),
      bytes: 'abc',
    } as unknown as Preview;

    await assert.rejects(
      () => store.replacePreviews(mediaId, [ID_A], [uncastable]),
      (err: unknown) => err instanceof Error && err.name === 'ValidationError',
    );
    assert.deepEqual(await storedPreviews(mediaId), before);
  });

  test('replacePreviews with empty rows only removes', async () => {
    const store = mediaStore();
    const mediaId = await newMedia([
      preview(undefined, 'x0'),
      preview(ID_A, 'a1'),
      preview(ID_B, 'b1'),
    ]);

    const result = await store.replacePreviews(mediaId, [ID_A, ID_B], []);

    assert.deepEqual(result.stored, []);
    assert.deepEqual(
      result.removed.map((row) => row.storageRef),
      [{ path: 'a1.webp' }, { path: 'b1.webp' }],
    );
    assert.deepEqual(
      (await storedPreviews(mediaId)).map((row) => row.storageRef),
      [{ path: 'x0.webp' }],
    );
  });

  test('replacePreviews on a media that is gone resolves with two empty lists', async () => {
    const gone = String(new mongoose.Types.ObjectId());
    assert.deepEqual(
      await mediaStore().replacePreviews(gone, [ID_A], [preview(ID_B)]),
      { stored: [], removed: [] },
    );
    assert.equal(await Media().findById(gone), null);
  });

  test('concurrent replacePreviews of one identity leave one row', async () => {
    const store = mediaStore();
    const mediaId = await newMedia([preview(ID_A, 'a1'), preview(ID_B, 'b1')]);
    const [first, second] = await Promise.all([
      store.replacePreviews(mediaId, [], [preview(ID_A, 'first')]),
      store.replacePreviews(mediaId, [], [preview(ID_A, 'second')]),
    ]);

    const rows = await storedPreviews(mediaId);
    const aRows = rows.filter((row) => row.identity === ID_A);
    assert.equal(aRows.length, 1);
    assert.equal(rows.length, 2);
    // Either order is valid: the write that ran last removed the other one's row, and the write
    // that ran first removed the original.
    const lastIsFirst =
      (aRows[0].storageRef as { path: string }).path === 'first.webp';
    const [last, earlier] = lastIsFirst ? [first, second] : [second, first];
    assert.deepEqual(
      last.stored.map((row) => row.storageRef),
      [aRows[0].storageRef],
    );
    assert.deepEqual(
      last.removed.map((row) => row.storageRef),
      earlier.stored.map((row) => row.storageRef),
    );
    assert.deepEqual(
      earlier.removed.map((row) => row.storageRef),
      [{ path: 'a1.webp' }],
    );
  });

  test('an identity that starts with $ is matched as a string, never read as a field path', async () => {
    const store = mediaStore();
    const odd = '$resizer:default:16x16:webp:';
    const mediaId = await newMedia([preview(odd, 'odd'), preview(ID_A, 'a1')]);

    const result = await store.replacePreviews(mediaId, [odd], []);

    assert.deepEqual(
      result.removed.map((row) => row.identity),
      [odd],
    );
    assert.deepEqual(
      (await storedPreviews(mediaId)).map((row) => row.identity),
      [ID_A],
    );
  });
});

describe('MongoMediaStore.verify(): the media model must store preview identities', () => {
  test('a media model without previews.identity is a setup error', () => {
    const store = new MongoMediaStore({ model: OutdatedMedia() });
    assert.throws(
      () => store.verify(),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_MONGO_MEDIA_MODEL_OUTDATED' &&
        err.message.includes('OutdatedMedia') &&
        err.message.includes('resizeMediaSchemaFragment'),
    );
  });

  test('rows declared through an explicit row schema without identity are rejected too', () => {
    const { identity: _identity, ...rowFields } =
      resizeMediaSchemaFragment.previews[0];
    const store = new MongoMediaStore({
      model: mediaModelWith('RowSchemaMedia', [new mongoose.Schema(rowFields)]),
    });
    assert.throws(
      () => store.verify(),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_MONGO_MEDIA_MODEL_OUTDATED',
    );
  });

  test('previews kept as a mixed or plain array, another type, or loose rows pass', () => {
    for (const [name, previews] of [
      ['MixedArrayMedia', [mongoose.Schema.Types.Mixed]],
      ['EmptyArrayMedia', []],
      ['ArrayCtorMedia', Array],
      ['TypeArrayMedia', { type: Array }],
      ['StringArrayMedia', [String]],
      [
        'LooseRowsMedia',
        [new mongoose.Schema({ sizeKey: String }, { strict: false })],
      ],
    ] as const) {
      const store = new MongoMediaStore({
        model: mediaModelWith(name, previews),
      });
      assert.doesNotThrow(() => store.verify(), name);
    }
  });

  test('a mixed or plain previews array really stores and matches identity', async () => {
    for (const [name, previews] of [
      ['MixedArrayMedia', [mongoose.Schema.Types.Mixed]],
      ['ArrayCtorMedia', Array],
    ] as const) {
      const model = mediaModelWith(name, previews);
      const store = new MongoMediaStore({ model });
      const doc = await model.create({
        original: { storageRef: { path: 'o.png' }, format: 'png' },
        previews: [],
      });
      const id = String(doc._id);
      const first = preview(ID_A, 'first');
      assert.deepEqual(await store.appendPreviews(id, [first]), [first], name);
      assert.deepEqual(
        await store.appendPreviews(id, [preview(ID_A, 'second')]),
        [],
        name,
      );
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          store.appendPreviews(id, [preview(ID_B, `worker-${i}`)]),
        ),
      );
      assert.equal(results.flat().length, 1, name);
      const rows = (
        (await model.findById(id).lean()) as { previews: Preview[] }
      ).previews;
      assert.deepEqual(
        rows.map((row) => row.identity),
        [ID_A, ID_B],
        name,
      );
    }
  });

  test('the current fragment and a model-shaped object without a schema pass', () => {
    assert.doesNotThrow(() => new MongoMediaStore({ model: Media() }).verify());
    const shaped = {
      findById: async () => null,
      findOneAndUpdate: async () => null,
    };
    assert.doesNotThrow(() => new MongoMediaStore({ model: shaped }).verify());
  });
});

describe('MongoMediaStore: the preview metadata', () => {
  test('the fragment stores the four fields; createdAt comes back as a Date', async () => {
    const store = mediaStore();
    const mediaId = await newMedia();
    const createdAt = new Date('2026-10-28T12:34:56.789Z');
    const row: Preview = {
      ...preview(ID_A, 'with-metadata'),
      bytes: 1234,
      createdAt,
      origin: '8c64760b02a9f12a',
      encodeSig: '5bff549d897f4636',
    };
    assert.deepEqual(await store.appendPreviews(mediaId, [row]), [row]);

    const loaded = await store.loadMedia(mediaId);
    const stored = loaded?.previews?.[0];
    assert.equal(stored?.bytes, 1234);
    assert.ok(stored?.createdAt instanceof Date);
    assert.equal(stored.createdAt.getTime(), createdAt.getTime());
    assert.equal(stored.origin, '8c64760b02a9f12a');
    assert.equal(stored.encodeSig, '5bff549d897f4636');
    const lean = await storedPreviews(mediaId);
    assert.ok(lean[0].createdAt instanceof Date);
  });

  test("origin recomputed from a loaded media equals the stored row's", async () => {
    const store = mediaStore();
    const storageRef = { key: 'originals/x.jpg', meta: {} };
    const doc = await Media().create({
      original: { storageRef, format: 'jpeg', width: 4000, height: 3000 },
      previews: [],
    });
    const mediaId = String(doc._id);
    const origin = previewOrigin(storageRef, { width: 4000, height: 3000 });
    const row: Preview = {
      ...preview(ID_A, 'recomputed'),
      origin,
      encodeSig: encodeSignature(makeImageConfig(), {
        format: 'webp',
        fit: false,
      }),
    };
    await store.appendPreviews(mediaId, [row]);

    const loaded = await store.loadMedia(mediaId);
    const original = loaded?.original;
    assert.ok(original);
    // minimize: false keeps the empty object, so the ref signs the same after a round trip.
    assert.deepEqual(
      JSON.parse(JSON.stringify(original.storageRef)),
      storageRef,
    );
    assert.equal(
      previewOrigin(original.storageRef, {
        width: original.width as number,
        height: original.height as number,
      }),
      loaded?.previews?.[0]?.origin,
    );
  });

  test('strict preview rows without origin or encodeSig are RESIZE_MONGO_MEDIA_MODEL_OUTDATED naming them', () => {
    const {
      origin: _origin,
      encodeSig: _encodeSig,
      ...rowFields
    } = resizeMediaSchemaFragment.previews[0];
    const store = new MongoMediaStore({
      model: mediaModelWith('NoSignatureMedia', [rowFields]),
    });
    assert.throws(
      () => store.verify(),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_MONGO_MEDIA_MODEL_OUTDATED' &&
        err.message.includes("'NoSignatureMedia'") &&
        err.message.includes('previews.origin') &&
        err.message.includes('previews.encodeSig') &&
        !err.message.includes('previews.identity') &&
        err.message.includes('resizeMediaSchemaFragment'),
    );

    const { encodeSig: _sig, ...withoutSig } =
      resizeMediaSchemaFragment.previews[0];
    assert.throws(
      () =>
        new MongoMediaStore({
          model: mediaModelWith('NoEncodeSigMedia', [withoutSig]),
        }).verify(),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_MONGO_MEDIA_MODEL_OUTDATED' &&
        err.message.includes('previews.encodeSig') &&
        !err.message.includes('previews.origin'),
    );

    // Every missing path is named in one message.
    assert.throws(
      () =>
        new MongoMediaStore({
          model: mediaModelWith('BareRowsMedia', [
            new mongoose.Schema({ sizeKey: String }),
          ]),
        }).verify(),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_MONGO_MEDIA_MODEL_OUTDATED' &&
        err.message.includes('previews.identity') &&
        err.message.includes('previews.origin') &&
        err.message.includes('previews.encodeSig'),
    );

    // bytes and createdAt are not checked.
    const {
      bytes: _bytes,
      createdAt: _createdAt,
      ...withoutSizeAndTime
    } = resizeMediaSchemaFragment.previews[0];
    assert.doesNotThrow(() =>
      new MongoMediaStore({
        model: mediaModelWith('NoBytesMedia', [withoutSizeAndTime]),
      }).verify(),
    );
  });

  test('strict preview rows without storageRef are RESIZE_MONGO_MEDIA_MODEL_OUTDATED naming it', () => {
    const { storageRef: _storageRef, ...rowFields } =
      resizeMediaSchemaFragment.previews[0];
    const store = new MongoMediaStore({
      model: mediaModelWith('NoStorageRefMedia', [rowFields]),
    });
    assert.throws(
      () => store.verify(),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_MONGO_MEDIA_MODEL_OUTDATED' &&
        err.message.includes('previews.storageRef') &&
        err.message.includes('no file to serve') &&
        !err.message.includes('previews.identity'),
    );
  });

  test('a nested shape counts as declared for storageRef only', () => {
    for (const field of [
      'identity',
      'origin',
      'encodeSig',
      'sizeKey',
      'format',
      'contentType',
    ]) {
      const store = new MongoMediaStore({
        model: mediaModelWith(`Nested${field}Media`, [
          {
            ...resizeMediaSchemaFragment.previews[0],
            [field]: { value: { type: String } },
          },
        ]),
      });
      assert.throws(
        () => store.verify(),
        (err: unknown) =>
          err instanceof ResizeSetupError &&
          err.code === 'RESIZE_MONGO_MEDIA_MODEL_OUTDATED' &&
          err.message.includes(`previews.${field}`),
        field,
      );
    }
  });

  test('a storageRef declared as Mixed, as a sub-schema or as nested paths passes verify()', () => {
    const { storageRef: _storageRef, ...rowFields } =
      resizeMediaSchemaFragment.previews[0];
    for (const [name, storageRef] of [
      ['MixedRefMedia', { type: mongoose.Schema.Types.Mixed }],
      ['SubSchemaRefMedia', new mongoose.Schema({ key: String })],
      ['NestedRefMedia', { key: { type: String } }],
    ] as const) {
      const store = new MongoMediaStore({
        model: mediaModelWith(name, [{ ...rowFields, storageRef }]),
      });
      assert.doesNotThrow(() => store.verify(), name);
    }
  });

  test('a storageRef of nested paths really serves: a worker stores the row, and a read finds it fresh', async () => {
    const { storageRef: _storageRef, ...rowFields } =
      resizeMediaSchemaFragment.previews[0];
    const model = mediaModelWith('NestedRefMedia', [
      { ...rowFields, storageRef: { key: { type: String } } },
    ]);
    const sizes = [{ width: 20, height: 20 }];
    const { r, id, tasks } = await firstRender(model, sizes);

    assert.deepEqual(
      tasks.rows.map((row) => [row.status, row.attempts]),
      [['completed', 1]],
    );
    const { decision } = await r.resolve({
      media: (await new MongoMediaStore({ model }).loadMedia(id)) as MediaLike,
      sizes,
      enqueueMissing: false,
    });
    assert.equal(decision.missing.length, 0);
    assert.equal(decision.ready[0].stale, undefined);
  });

  test('strict preview rows without fit pass verify() with one warning; the fragment gets none', () => {
    const warnings: unknown[][] = [];
    const logger = {
      info() {},
      warn: (...args: unknown[]) => void warnings.push(args),
      error() {},
    };
    const { fit: _fit, ...rowFields } = resizeMediaSchemaFragment.previews[0];
    const store = new MongoMediaStore({
      model: mediaModelWith('NoFitMedia', [rowFields]),
      logger,
    });
    assert.doesNotThrow(() => store.verify());
    assert.doesNotThrow(() => store.verify());
    assert.equal(warnings.length, 1);
    assert.match(
      String(warnings[0][0]),
      /media model 'NoFitMedia' has no previews\.fit field/,
    );
    assert.match(String(warnings[0][0]), /resizeMediaSchemaFragment/);

    new MongoMediaStore({ model: Media(), logger }).verify();
    assert.equal(warnings.length, 1);
  });
});

describe('MongoMediaStore.verify(): a strict original without width and height', () => {
  // A media model whose `original` path is declared as given (registered once per name).
  const modelWithOriginal = (
    name: string,
    original: unknown,
    previews: unknown = resizeMediaSchemaFragment.previews,
  ) =>
    connection.models[name] ??
    connection.model(
      name,
      new mongoose.Schema({ original, previews } as never, {
        minimize: false,
      }),
    );
  const recording = () => {
    const warnings: unknown[][] = [];
    const logger = {
      info() {},
      warn: (...args: unknown[]) => void warnings.push(args),
      error() {},
    };
    return { warnings, logger };
  };
  const {
    width: _w,
    height: _h,
    ...noDims
  } = resizeMediaSchemaFragment.original;

  test('a nested original without them warns once, naming the fix, also when the preview rows are not checked', () => {
    for (const [name, previews] of [
      ['NoDimsMedia', resizeMediaSchemaFragment.previews],
      ['NoDimsMixedRowsMedia', [mongoose.Schema.Types.Mixed]],
    ] as const) {
      const { warnings, logger } = recording();
      const store = new MongoMediaStore({
        model: modelWithOriginal(name, noDims, previews),
        logger,
      });
      assert.doesNotThrow(() => store.verify());
      assert.doesNotThrow(() => store.verify());
      assert.equal(warnings.length, 1, name);
      const text = String(warnings[0][0]);
      assert.match(text, new RegExp(`media model '${name}'`));
      assert.match(text, /original\.width and original\.height/);
      assert.match(text, /resizeMediaSchemaFragment/);
      assert.match(text, /width: \{ type: Number \}/);
      assert.match(text, /downloads the original/);
    }
  });

  test('a strict single sub-schema original without height warns; a loose one does not', () => {
    const { height: _height, ...noHeight } = resizeMediaSchemaFragment.original;
    const strict = recording();
    new MongoMediaStore({
      model: modelWithOriginal(
        'NoHeightSubMedia',
        new mongoose.Schema(noHeight),
      ),
      logger: strict.logger,
    }).verify();
    assert.equal(strict.warnings.length, 1);
    assert.match(String(strict.warnings[0][0]), /original\.height field/);

    const loose = recording();
    new MongoMediaStore({
      model: modelWithOriginal(
        'LooseSubMedia',
        new mongoose.Schema(noDims, { strict: false }),
      ),
      logger: loose.logger,
    }).verify();
    assert.equal(loose.warnings.length, 0);
  });

  test('the fragment, a Mixed original and a sub-schema with the dimensions do not warn', () => {
    const { warnings, logger } = recording();
    for (const [name, original] of [
      ['DimsFragmentMedia', resizeMediaSchemaFragment.original],
      ['MixedOriginalMedia', mongoose.Schema.Types.Mixed],
      [
        'DimsSubMedia',
        new mongoose.Schema({ ...resizeMediaSchemaFragment.original }),
      ],
    ] as const) {
      new MongoMediaStore({
        model: modelWithOriginal(name, original),
        logger,
      }).verify();
    }
    new MongoMediaStore({ model: Media(), logger }).verify();
    assert.deepEqual(warnings, []);
  });

  test('a nested original without them really drops the backfilled dimensions', async () => {
    const model = modelWithOriginal('NoDimsBackfillMedia', noDims);
    const doc = await model.create({
      original: { storageRef: { path: 'o.png' }, format: 'png' },
      previews: [],
    });
    const store = new MongoMediaStore({ model, logger: recording().logger });
    await store.appendPreviews(String(doc._id), [], { width: 64, height: 32 });
    const stored = (await model.findById(doc._id).lean()) as {
      original: Record<string, unknown>;
    };
    assert.equal('width' in stored.original, false);
  });

  // A media model with the given `original` and schema options (registered once per name).
  const modelWithOptions = (
    name: string,
    original: unknown,
    options: Record<string, unknown>,
  ) =>
    connection.models[name] ??
    connection.model(
      name,
      new mongoose.Schema(
        { original, previews: resizeMediaSchemaFragment.previews } as never,
        { minimize: false, ...options },
      ),
    );

  test("under strict: 'throw' the warning says the update is rejected, and the backfill really rejects", async () => {
    for (const [name, model] of [
      [
        'NoDimsThrowMedia',
        modelWithOptions('NoDimsThrowMedia', noDims, { strict: 'throw' }),
      ],
      [
        'NoDimsThrowSubMedia',
        modelWithOriginal(
          'NoDimsThrowSubMedia',
          new mongoose.Schema(noDims, { strict: 'throw' }),
        ),
      ],
    ] as const) {
      const { warnings, logger } = recording();
      const store = new MongoMediaStore({ model, logger });
      store.verify();
      assert.equal(warnings.length, 1, name);
      const text = String(warnings[0][0]);
      assert.match(text, /original\.width and original\.height/, name);
      assert.match(text, /rejects/, name);
      assert.match(text, /strict: 'throw'/, name);
      assert.match(text, /resizeMediaSchemaFragment/, name);
      assert.match(text, /width: \{ type: Number \}/, name);

      const doc = await model.create({
        original: { storageRef: { path: 'o.png' }, format: 'png' },
        previews: [],
      });
      await assert.rejects(
        store.appendPreviews(String(doc._id), [], { width: 64, height: 32 }),
        { name: 'StrictModeError' },
        name,
      );
    }
  });

  test('dimensions declared with another type than Number warn, naming the type; Mixed dimensions do not', async () => {
    const asString = { ...noDims, width: String, height: String };
    for (const [name, original, named] of [
      ['StringDimsMedia', asString, /original\.width and original\.height/],
      [
        'StringWidthSubMedia',
        new mongoose.Schema({ ...noDims, width: String, height: Number }),
        /original\.width as String/,
      ],
    ] as const) {
      const { warnings, logger } = recording();
      const store = new MongoMediaStore({
        model: modelWithOriginal(name, original),
        logger,
      });
      store.verify();
      store.verify();
      assert.equal(warnings.length, 1, name);
      const text = String(warnings[0][0]);
      assert.match(text, named, name);
      assert.match(text, /String/, name);
      assert.match(text, /not Number/, name);
      assert.match(text, /downloads the original/, name);
      assert.match(text, /width: \{ type: Number \}/, name);
      if (name === 'StringWidthSubMedia') {
        assert.doesNotMatch(text, /height/, name);
      }
    }

    const model = modelWithOriginal('StringDimsBackfillMedia', asString);
    const doc = await model.create({
      original: { storageRef: { path: 'o.png' }, format: 'png' },
      previews: [],
    });
    await new MongoMediaStore({
      model,
      logger: recording().logger,
    }).appendPreviews(String(doc._id), [], { width: 64, height: 32 });
    const stored = (await model.findById(doc._id).lean()) as {
      original: Record<string, unknown>;
    };
    assert.equal(stored.original.width, '64');

    const mixed = recording();
    new MongoMediaStore({
      model: modelWithOriginal('MixedDimsMedia', {
        ...noDims,
        width: mongoose.Schema.Types.Mixed,
        height: {},
      }),
      logger: mixed.logger,
    }).verify();
    assert.deepEqual(mixed.warnings, []);
  });

  test('under strict: false a declared dimension is still type-checked; only a missing one is not', () => {
    for (const [name, model] of [
      [
        'LooseStringWidthMedia',
        modelWithOptions(
          'LooseStringWidthMedia',
          { ...noDims, width: String, height: Number },
          { strict: false },
        ),
      ],
      [
        'LooseStringWidthSubMedia',
        modelWithOriginal(
          'LooseStringWidthSubMedia',
          new mongoose.Schema(
            { ...noDims, width: String, height: Number },
            { strict: false },
          ),
        ),
      ],
    ] as const) {
      const { warnings, logger } = recording();
      new MongoMediaStore({ model, logger }).verify();
      assert.equal(warnings.length, 1, name);
      const text = String(warnings[0][0]);
      assert.match(text, /original\.width as String/, name);
      assert.doesNotMatch(text, /height/, name);
      assert.doesNotMatch(text, /field/, name);
    }

    const loose = recording();
    new MongoMediaStore({
      model: modelWithOptions('LooseNoHeightMedia', noDims, { strict: false }),
      logger: loose.logger,
    }).verify();
    assert.deepEqual(loose.warnings, []);
  });

  test('a dimension Mongoose cannot cast to its type: the warning names the rejection, and the backfill really rejects', async () => {
    const model = modelWithOriginal('BooleanWidthMedia', {
      ...noDims,
      width: Boolean,
      height: Number,
    });
    const { warnings, logger } = recording();
    const store = new MongoMediaStore({ model, logger });
    store.verify();
    assert.equal(warnings.length, 1);
    const text = String(warnings[0][0]);
    assert.match(text, /original\.width as Boolean/);
    assert.match(text, /rejects the update/);
    assert.match(text, /fails and is retried/);
    assert.match(text, /width: \{ type: Number \}/);

    const doc = await model.create({
      original: { storageRef: { path: 'o.png' }, format: 'png' },
      previews: [],
    });
    await assert.rejects(
      store.appendPreviews(String(doc._id), [], { width: 64, height: 32 }),
      { name: 'CastError' },
    );
  });

  test('Int32 dimensions read back as numbers and do not warn; Double and Decimal128 read back as bson objects and warn', () => {
    const int32 = recording();
    new MongoMediaStore({
      model: modelWithOriginal('Int32DimsMedia', {
        ...noDims,
        width: mongoose.Schema.Types.Int32,
        height: { type: mongoose.Schema.Types.Int32 },
      }),
      logger: int32.logger,
    }).verify();
    assert.deepEqual(int32.warnings, []);

    for (const type of ['Double', 'Decimal128'] as const) {
      const { warnings, logger } = recording();
      new MongoMediaStore({
        model: modelWithOriginal(`${type}DimsMedia`, {
          ...noDims,
          width: mongoose.Schema.Types[type],
          height: Number,
        }),
        logger,
      }).verify();
      assert.equal(warnings.length, 1, type);
      assert.match(
        String(warnings[0][0]),
        new RegExp(`original\\.width as ${type}`),
        type,
      );
    }
  });
});

describe('MongoMediaStore options', () => {
  test('getModel is resolved on use, not at construction', async () => {
    let calls = 0;
    const lazy = new MongoMediaStore({
      getModel: () => {
        calls++;
        return Media();
      },
    });
    assert.equal(calls, 0);
    const mediaId = await newMedia();
    assert.equal((await lazy.loadMedia(mediaId))?.id, mediaId);
    assert.deepEqual(await lazy.appendPreviews(mediaId, [preview(ID_A)]), [
      preview(ID_A),
    ]);
    assert.equal(calls, 2);
  });

  test('a getter that resolves to no model is a setup error, never missing media', async () => {
    const lazy = new MongoMediaStore({
      getModel: () => connection.models.MisspelledMedia,
    });
    const missing = (err: unknown) =>
      err instanceof ResizeSetupError &&
      err.code === 'RESIZE_MONGO_MODEL_MISSING' &&
      /media model does not resolve/.test(err.message);
    assert.throws(() => lazy.verify(), missing);
    await assert.rejects(() => lazy.loadMedia('m1'), missing);
    await assert.rejects(
      () => lazy.appendPreviews('m1', [preview(ID_A)]),
      missing,
    );
  });

  test('needs exactly one of model or getModel', () => {
    const required = (err: unknown) =>
      err instanceof ResizeSetupError &&
      err.code === 'RESIZE_MONGO_MODEL_REQUIRED' &&
      /MongoMediaStore needs exactly one of `model` or `getModel`/.test(
        err.message,
      );
    assert.throws(
      () => new MongoMediaStore(undefined as unknown as MongoMediaStoreOptions),
      required,
    );
    assert.throws(() => new MongoMediaStore({}), required);
    assert.throws(
      () => new MongoMediaStore({ model: Media(), getModel: Media }),
      required,
    );
  });
});

describe('a worker over real rows', () => {
  const identitiesOf = (rows: Preview[]): string[] =>
    rows.map((row) => row.identity as string);

  /** A first render and then a replacement, with a namespaced ref, a fit row and a filtered row. */
  const renderAndReplace = async (
    load?: MediaStore['loadMedia'],
    model = Media(),
  ) => {
    const png = await sharp({
      create: {
        width: 64,
        height: 48,
        channels: 3,
        background: { r: 200, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();
    const warnings: unknown[] = [];
    const errors: unknown[] = [];
    const logger: ResizeLogger = {
      info: () => {},
      warn: (line) => void warnings.push(line),
      error: (line) => void errors.push(line),
    };
    const { storage } = memoryStorage();
    const tasks = new MemoryTaskQueue({
      timing: { idlePollMs: 5, retryBackoffMs: { base: 5, max: 5 } },
    });
    const inner = new MongoMediaStore({ model });
    const store = load
      ? fakeMedia({
          load,
          appendPreviews: (id, previews, dims) =>
            inner.appendPreviews(id, previews, dims),
          replacePreviews: (id, identities, rows) =>
            inner.replacePreviews(id, identities, rows),
        })
      : inner;
    const resizerAt = (quality: number) =>
      new Resizer({
        config: makeImageConfig({
          formats: ['webp'],
          encode: { formats: { webp: { quality } } },
        }),
        logger,
        storage,
        media: store,
        tasks,
      });
    let r = resizerAt(80);
    const original = await r.uploadOriginal({
      body: png,
      visibility: 'private',
      namespace: 'avatars',
    });
    const id = String((await model.create({ original }))._id);
    const sizes = [
      { width: 20, height: 20 },
      { fit: true },
      { width: 30, filters: { blur: 2, mode: 'soft' } },
    ];
    const render = async () => {
      await r.resolve({
        media: (await store.loadMedia(id)) as MediaLike,
        sizes,
      });
      await workUntil({ logger, resizers: [r] }, () =>
        tasks.rows.every(
          (row) => row.status === 'completed' || row.status === 'dead',
        ),
      );
    };

    await render();
    resetResizerForTests();
    r = resizerAt(70);
    await render();

    assert.deepEqual(
      tasks.rows.map((row) => row.status),
      ['completed', 'completed'],
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(
      warnings.filter((line) => /the identity of/.test(String(line))),
      [],
    );
  };

  test('hydrated rows raise no RESIZE_MEDIA_ROW_NOT_KEPT: a namespaced ref, a fit row, a filtered row, first rendered and then replaced', async () => {
    await renderAndReplace();
  });

  for (const [name, race] of [
    ['no race', async () => {}],
    [
      'invalidate() landing between the write and the reload',
      async (store, id, rows) => {
        await store.replacePreviews(id, identitiesOf(rows), []);
      },
    ],
    [
      'another worker replacing the row under its own ref',
      async (store, id, rows) => {
        await store.replacePreviews(
          id,
          identitiesOf(rows),
          rows.map((row) => ({ ...row, storageRef: { key: 'theirs.webp' } })),
        );
      },
    ],
  ] as [
    string,
    (store: MongoMediaStore, id: string, rows: Preview[]) => Promise<void>,
  ][]) {
    test(`a 0.2.x row without a ref, of the same size and format, and ${name}: a healthy store's task completes`, async () => {
      const png = await sharp({
        create: {
          width: 64,
          height: 48,
          channels: 3,
          background: { r: 0, g: 200, b: 0 },
        },
      })
        .png()
        .toBuffer();
      const logger: ResizeLogger = {
        info: () => {},
        warn: () => {},
        error: () => {},
      };
      const { storage } = memoryStorage();
      const tasks = new MemoryTaskQueue({
        timing: { idlePollMs: 5, retryBackoffMs: { base: 5, max: 5 } },
      });
      const inner = mediaStore();
      const r = new Resizer({
        config: makeImageConfig({ formats: ['webp'] }),
        logger,
        storage,
        media: fakeMedia({
          load: (id) => inner.loadMedia(id),
          appendPreviews: async (id, previews, dims) => {
            const stored = await inner.appendPreviews(id, previews, dims);
            await race(inner, id, stored);
            return stored;
          },
          replacePreviews: (id, identities, rows) =>
            inner.replacePreviews(id, identities, rows),
        }),
        tasks,
      });
      const original = await r.uploadOriginal({
        body: png,
        visibility: 'private',
      });
      // Written past the schema, as a row of that version is in the collection.
      const { insertedId } = await Media().collection.insertOne({
        original,
        previews: [
          {
            key: 'old.webp',
            bucket: 'b',
            sizeKey: '20x20',
            format: 'webp',
            contentType: 'image/webp',
          },
        ],
      } as never);
      const id = String(insertedId);

      await r.resolve({
        media: (await inner.loadMedia(id)) as MediaLike,
        sizes: [{ width: 20, height: 20 }],
      });
      await workUntil({ logger, resizers: [r] }, () =>
        tasks.rows.every(
          (row) => row.status === 'completed' || row.status === 'dead',
        ),
      );

      assert.deepEqual(
        tasks.rows.map((row) => [row.status, row.attempts]),
        [['completed', 1]],
      );
    });
  }

  test('lean rows raise no RESIZE_MEDIA_ROW_NOT_KEPT: a store that loads with lean() reads back plain rows', async () => {
    await renderAndReplace(
      async (id) => (await Media().findById(id).lean()) as MediaLike | null,
    );
  });

  // A hand-written schema that declares rows as sub-documents stores an `_id` on an appended row.
  const rowsWithId = () => {
    const { _id: _rowId, ...rowFields } = resizeMediaSchemaFragment.previews[0];
    return mediaModelWith('RowsWithIdMedia', [rowFields]);
  };

  test('rows of a schema that keeps their _id raise no RESIZE_MEDIA_ROW_NOT_KEPT, hydrated', async () => {
    await renderAndReplace(undefined, rowsWithId());
  });

  test('rows of a schema that keeps their _id raise no RESIZE_MEDIA_ROW_NOT_KEPT, lean', async () => {
    await renderAndReplace(
      async (id) =>
        (await rowsWithId().findById(id).lean()) as MediaLike | null,
      rowsWithId(),
    );
  });
});
