// MongoMediaStore against a real MongoDB: one stored preview row per preview identity, however
// many workers render it, rows swapped by identity in one write, the preview metadata a row
// records, the startup check for a media model without those fields, and the `model` / `getModel`
// options.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { types } from 'node:util';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { ResizeSetupError } from '../../errors.ts';
import { encodeSignature, previewOrigin } from '../../signatures.ts';
import { makeImageConfig } from '../../testHelpers/resizeConfig.ts';
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
