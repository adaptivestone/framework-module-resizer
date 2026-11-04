// resizer.invalidate: removing a Resizer's stored previews of a media, of one pipeline or of all,
// in one media store write, and resolving with their storage refs for the host to delete. Fakes
// for storage and media; no sharp work, no task queue.
import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import type { MediaStore } from './contracts/media.ts';
import type { ResizeStorage } from './contracts/storage.ts';
import { ResizeSetupError } from './errors.ts';
import { Resizer, resetResizerForTests } from './resizer.ts';
import { fakeMedia } from './testHelpers/fakes.ts';
import type { MediaLike, Preview } from './types.d.ts';

const silent = { info() {}, warn() {}, error() {} };

const storage: ResizeStorage = {
  download: async () => Buffer.alloc(0),
  upload: async () => ({ key: 'k' }),
  publicUrl: () => '',
};

/** A stored row of `resizer`/`pipeline` (omitted: a row that predates both fields). */
function row(
  ref: string,
  scope: { resizer?: string; pipeline?: string },
  identity?: string,
): Preview {
  return {
    storageRef: { key: ref },
    ...(identity === undefined ? {} : { identity }),
    ...scope,
    sizeKey: '16x16',
    format: 'webp',
    contentType: 'image/webp',
  };
}

// The rows of one media: d1 and d2 of default/default (d2 written without its resizer and
// pipeline, so it belongs to default/default), w1 of default/wm, l1 of another Resizer, and x0, a
// default/default row stored before rows carried an identity.
const d1 = () =>
  row(
    'd1',
    { resizer: 'default', pipeline: 'default' },
    'default:default:16x16:webp:',
  );
const d2 = () => row('d2', {}, 'default:default:32x32:webp:');
const w1 = () =>
  row('w1', { resizer: 'default', pipeline: 'wm' }, 'default:wm:16x16:webp:');
const l1 = () =>
  row(
    'l1',
    { resizer: 'listings', pipeline: 'default' },
    'listings:default:16x16:webp:',
  );
const x0 = () => row('x0', { resizer: 'default', pipeline: 'default' });

const refsOf = (rows: Preview[]) => rows.map((preview) => preview.storageRef);

/**
 * A media store holding the five rows of media m1, with its replacePreviews recorded, and the
 * caller's in-memory copy of the media.
 */
function seeded() {
  const previews = new Map<string, Preview[]>([
    ['m1', [d1(), d2(), w1(), l1(), x0()]],
  ]);
  const store = fakeMedia({
    previews,
    load: async (id) =>
      previews.has(id) ? { id, previews: [...(previews.get(id) ?? [])] } : null,
  });
  const replace = mock.method(store, 'replacePreviews');
  const media: MediaLike = {
    id: 'm1',
    original: { storageRef: { key: 'o' } } as MediaLike['original'],
    previews: [d1(), d2(), w1(), l1(), x0()],
  };
  return { store, replace, media, stored: () => previews.get('m1') ?? [] };
}

function resizer(media: MediaStore, name?: string): Resizer {
  return new Resizer({
    ...(name === undefined ? {} : { name }),
    logger: silent,
    storage,
    media,
    pipelines: { wm: {} },
  });
}

afterEach(() => {
  resetResizerForTests();
  mock.restoreAll();
});

describe('invalidate', () => {
  test('invalidate with a pipeline removes only that pipeline of this Resizer and returns their refs', async () => {
    const { store, replace, media, stored } = seeded();

    const refs = await resizer(store).invalidate({ media, pipeline: 'wm' });

    assert.deepEqual(refs, [w1().storageRef]);
    assert.deepEqual(refsOf(stored()), refsOf([d1(), d2(), l1(), x0()]));
    assert.equal(replace.mock.callCount(), 1);
    assert.deepEqual(replace.mock.calls[0].arguments, [
      'm1',
      [w1().identity],
      [],
    ]);
    assert.deepEqual(
      refsOf(media.previews ?? []),
      refsOf([d1(), d2(), l1(), x0()]),
    );
  });

  test("invalidate without a pipeline removes every pipeline of this Resizer, never another Resizer's rows or rows without an identity", async () => {
    const { store, replace, media, stored } = seeded();
    const inMemory = media.previews;

    const refs = await resizer(store).invalidate({ media });

    assert.deepEqual(refs, refsOf([d1(), d2(), w1()]));
    assert.deepEqual(refsOf(stored()), refsOf([l1(), x0()]));
    assert.equal(replace.mock.callCount(), 1);
    assert.deepEqual(replace.mock.calls[0].arguments, [
      'm1',
      [d1().identity, d2().identity, w1().identity],
      [],
    ]);
    // The caller's own array, so a same-request resolve({ media }) no longer sees the rows.
    assert.equal(media.previews, inMemory);
    assert.deepEqual(refsOf(media.previews ?? []), refsOf([l1(), x0()]));

    // Another Resizer removes its own rows only.
    const listings = await resizer(store, 'listings').invalidate({
      media: { id: 'm1' },
    });
    assert.deepEqual(listings, [l1().storageRef]);
    assert.deepEqual(refsOf(stored()), refsOf([x0()]));
  });

  test('invalidate on a media that is gone, or with nothing in scope, resolves with [] and writes nothing', async () => {
    const { store, replace, media, stored } = seeded();
    const r = resizer(store);

    assert.deepEqual(await r.invalidate({ media: { id: 'gone' } }), []);
    assert.deepEqual(
      await r.invalidate({ media, pipeline: 'no-such-pipeline' }),
      [],
    );
    assert.deepEqual(await resizer(store, 'other').invalidate({ media }), []);
    assert.equal(replace.mock.callCount(), 0);
    assert.equal(stored().length, 5);
    assert.equal(media.previews?.length, 5);

    // Only rows without an identity, or another Resizer's, left: nothing to remove either.
    await r.invalidate({ media });
    assert.equal(replace.mock.callCount(), 1);
    assert.deepEqual(await r.invalidate({ media }), []);
    assert.equal(replace.mock.callCount(), 1);
  });

  test('a store without replacePreviews is RESIZE_MEDIA_REPLACE_MISSING; a wrong result is RESIZE_MEDIA_REPLACE_RESULT_INVALID', async () => {
    const { media } = seeded();
    const load = async (id: string) =>
      id === 'gone' ? null : { id, previews: [d1(), w1()] };
    // A custom store written before replacePreviews existed.
    const oldStore = {
      loadMedia: load,
      appendPreviews: async (_id: string, previews: Preview[]) => previews,
    } as unknown as MediaStore;
    const old = resizer(oldStore);
    // A gone media, or nothing in scope, resolves [] before the store is checked.
    assert.deepEqual(await old.invalidate({ media: { id: 'gone' } }), []);
    assert.deepEqual(
      await old.invalidate({ media, pipeline: 'no-such-pipeline' }),
      [],
    );
    await assert.rejects(
      () => old.invalidate({ media }),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_MEDIA_REPLACE_MISSING' &&
        err.message ===
          'resize: the media store has no replacePreviews(mediaId, identities, rows) — a custom MediaStore needs it since 0.3.0',
    );
    resetResizerForTests();

    for (const result of [
      undefined,
      null,
      [],
      { stored: [] },
      { removed: [] },
      { stored: [], removed: 'w1' },
      { stored: {}, removed: [] },
    ]) {
      const wrong = fakeMedia({
        load,
        replacePreviews: async () => result as never,
      });
      await assert.rejects(
        () => resizer(wrong).invalidate({ media }),
        (err: unknown) =>
          err instanceof ResizeSetupError &&
          err.code === 'RESIZE_MEDIA_REPLACE_RESULT_INVALID' &&
          err.message ===
            "resize: the media store's replacePreviews resolved with something other than { stored, removed } — resolve with the rows it stored and removed ([] when none)",
      );
      resetResizerForTests();
    }
    // Nothing is taken off the caller's media when the result cannot be read.
    assert.equal(media.previews?.length, 5);
  });

  test('a store failure rejects as it is', async () => {
    const { media } = seeded();
    const writeFailure = new Error('write failed');
    const failingWrite = fakeMedia({
      load: async (id) => ({ id, previews: [w1()] }),
      replacePreviews: async () => {
        throw writeFailure;
      },
    });
    await assert.rejects(
      () => resizer(failingWrite).invalidate({ media }),
      (err: unknown) => err === writeFailure,
    );
    resetResizerForTests();

    const loadFailure = new Error('load failed');
    const failingLoad = fakeMedia({
      load: async () => {
        throw loadFailure;
      },
    });
    await assert.rejects(
      () => resizer(failingLoad).invalidate({ media }),
      (err: unknown) => err === loadFailure,
    );
    assert.equal(media.previews?.length, 5);
  });

  test("a caller's previews that cannot be changed still resolve with the removed refs and log one warning", async () => {
    const { store, replace, media, stored } = seeded();
    Object.freeze(media.previews);
    const warnings: unknown[][] = [];
    const r = new Resizer({
      logger: {
        info() {},
        error() {},
        warn(...args: unknown[]) {
          warnings.push(args);
        },
      },
      storage,
      media: store,
      pipelines: { wm: {} },
    });

    // The rows are gone from the store, so the refs are the host's only record of the objects.
    const refs = await r.invalidate({ media, pipeline: 'wm' });

    assert.deepEqual(refs, [w1().storageRef]);
    assert.equal(replace.mock.callCount(), 1);
    assert.deepEqual(refsOf(stored()), refsOf([d1(), d2(), l1(), x0()]));
    assert.equal(media.previews?.length, 5);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /\bmedia m1\b/);
    assert.doesNotMatch(String(warnings[0][0]), /\n/);
    assert.ok(warnings[0][1] instanceof TypeError);
  });

  test('a logger that throws on that warning still lets invalidate resolve with the refs', async () => {
    const { store, replace, media, stored } = seeded();
    Object.freeze(media.previews);
    const consoleWarn = mock.method(console, 'warn', () => {});
    const r = new Resizer({
      logger: {
        info() {},
        error() {},
        warn() {
          throw new Error('logger down');
        },
      },
      storage,
      media: store,
      pipelines: { wm: {} },
    });

    const refs = await r.invalidate({ media, pipeline: 'wm' });

    assert.deepEqual(refs, [w1().storageRef]);
    assert.equal(replace.mock.callCount(), 1);
    assert.deepEqual(refsOf(stored()), refsOf([d1(), d2(), l1(), x0()]));
    // The warning falls back to the console.
    assert.equal(consoleWarn.mock.callCount(), 1);
    assert.match(
      String(consoleWarn.mock.calls[0].arguments[0]),
      /\bmedia m1\b/,
    );
    assert.ok(consoleWarn.mock.calls[0].arguments[1] instanceof TypeError);
  });

  test('invalidate works on an eager-only Resizer and for an unregistered pipeline', async () => {
    const { store, media, stored } = seeded();
    // No task queue, and no 'wm' pipeline: cleaning up after a rename removes the old rows.
    const eager = new Resizer({ logger: silent, storage, media: store });
    assert.equal(eager.hasPipeline('wm'), false);

    const refs = await eager.invalidate({ media, pipeline: 'wm' });

    assert.equal(eager.tasks, undefined);
    assert.deepEqual(refs, [w1().storageRef]);
    assert.deepEqual(refsOf(stored()), refsOf([d1(), d2(), l1(), x0()]));
  });
});
