// MongoMediaStore against a real MongoDB: one stored preview row per preview identity, however
// many workers render it, the startup check for a media model without that field, and the
// `model` / `getModel` options.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { ResizeSetupError } from '../../errors.ts';
import type { Preview } from '../../types.d.ts';
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
