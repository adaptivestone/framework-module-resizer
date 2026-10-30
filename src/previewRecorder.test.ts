// The persist step of a render: one appendPreviews for the new rows, one replacePreviews for the
// rows that replace stored ones, then the reconciliation of what the media store kept against what
// was generated (rows another worker stored first, fresh or not, a media that is gone, rows a store
// left out, a failed write).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Catalog } from './catalog.ts';
import type { MediaStore } from './contracts/media.ts';
import { getPreviewIdentity } from './images.ts';
import { PreviewRecorder } from './previewRecorder.ts';
import { fakeMedia } from './testHelpers/fakes.ts';
import { stampFresh } from './testHelpers/fresh.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import type {
  MediaLike,
  Preview,
  PreviewScope,
  ResizeLogger,
} from './types.d.ts';

const scope: PreviewScope = { resizer: 'default', pipeline: 'default' };
const config = makeImageConfig();
// The original every reloaded media holds: the rows stamped fresh for it are another worker's
// fresh rows.
const original = { storageRef: { key: 'o' }, width: 64, height: 48 };

function preview(sizeKey: string, key: string): Preview {
  return {
    storageRef: { key },
    identity: getPreviewIdentity(scope, sizeKey, 'jpeg'),
    resizer: scope.resizer,
    pipeline: scope.pipeline,
    sizeKey,
    format: 'jpeg',
    contentType: 'image/jpeg',
  };
}

function recordingLogger() {
  const logs: Record<'info' | 'warn' | 'error', unknown[][]> = {
    info: [],
    warn: [],
    error: [],
  };
  const logger: ResizeLogger = {
    info: (...args) => void logs.info.push(args),
    warn: (...args) => void logs.warn.push(args),
    error: (...args) => void logs.error.push(args),
  };
  return { logger, logs };
}

test('a PreviewRecorder needs only a catalog, a media store and a logger, and returns the previews the store kept', async () => {
  const already = preview('20x20', 'theirs.jpg');
  const rows = new Map<string, Preview[]>([['m1', [already]]]);
  const base = fakeMedia({ previews: rows });
  const media = fakeMedia({
    previews: rows,
    // The other worker's row is fresh: it carries the signatures this original and config give.
    load: async (mediaId) =>
      stampFresh({ original, previews: rows.get(mediaId) ?? [] }, { config }),
    // The store resolves with its own copies of the rows it stored (a driver's documents).
    appendPreviews: async (mediaId, previews, dims) =>
      (await base.appendPreviews(mediaId, previews, dims)).map((row) => ({
        ...row,
      })),
  });
  const { logger, logs } = recordingLogger();
  const recorder = new PreviewRecorder({
    catalog: new Catalog({ config }),
    media,
    logger,
  });

  const mine = preview('40x40', 'mine.jpg');
  const duplicate = preview('20x20', 'dup.jpg');
  const result = await recorder.record('m1', scope, [mine, duplicate]);

  assert.equal(result.stored.length, 1);
  assert.equal(result.stored[0], mine, 'the generated object, not the copy');
  assert.deepEqual(result.alreadyStored, [duplicate.identity]);
  assert.equal(logs.warn.length, 1);
  assert.match(String(logs.warn[0][0]), /already stored by another worker/);
  assert.match(String(logs.warn[0][0]), /dup\.jpg/);
  assert.deepEqual(logs.error, []);
});

test('a store that resolves undefined is RESIZE_MEDIA_APPEND_RESULT_INVALID', async () => {
  const media = fakeMedia({
    appendPreviews: (async () => undefined) as never,
  });
  const { logger, logs } = recordingLogger();
  const recorder = new PreviewRecorder({
    catalog: new Catalog({ config: makeImageConfig() }),
    media,
    logger,
  });
  const result = await recorder.record('m1', scope, [
    preview('40x40', 'mine.jpg'),
  ]);
  assert.equal(
    (result.failure?.error as { code?: string } | undefined)?.code,
    'RESIZE_MEDIA_APPEND_RESULT_INVALID',
  );
  assert.deepEqual(result.stored, []);
  // The caller rethrows and reports it; the recorder itself logs nothing for it.
  assert.deepEqual(logs, { info: [], warn: [], error: [] });
});

/** A recorder over `media` with a recording logger, on the shared config. */
function recorderOver(media: MediaStore) {
  const { logger, logs } = recordingLogger();
  return {
    recorder: new PreviewRecorder({
      catalog: new Catalog({ config }),
      media,
      logger,
    }),
    logs,
  };
}

/** A media store over `rows` that records the order of its writes. */
function recordingStore(rows: Map<string, Preview[]>) {
  const base = fakeMedia({ previews: rows });
  const calls: Array<
    | {
        write: 'append';
        previews: Preview[];
        dims?: { width: number; height: number };
      }
    | { write: 'replace'; identities: string[]; rows: Preview[] }
  > = [];
  const media = fakeMedia({
    previews: rows,
    load: async (mediaId) => ({ original, previews: rows.get(mediaId) ?? [] }),
    appendPreviews: async (mediaId, previews, dims) => {
      calls.push({ write: 'append', previews, ...(dims ? { dims } : {}) });
      return base.appendPreviews(mediaId, previews, dims);
    },
    replacePreviews: async (mediaId, identities, previews) => {
      calls.push({ write: 'replace', identities, rows: previews });
      return base.replacePreviews(mediaId, identities, previews);
    },
  });
  return { media, calls };
}

test('record() appends new rows, then replaces the rows in replacing, and returns the removed rows', async () => {
  const old = preview('20x20', 'old.jpg');
  const rows = new Map<string, Preview[]>([['m1', [old]]]);
  const { media, calls } = recordingStore(rows);
  const { recorder, logs } = recorderOver(media);
  const replacement = preview('20x20', 'new.jpg');
  const added = preview('40x40', 'added.jpg');
  const result = await recorder.record('m1', scope, [replacement, added], {
    replacing: new Set([replacement.identity as string]),
  });
  // The replaced identities are named too, so a store that removes only by that argument (one
  // written when the core called it from invalidate() alone) removes the old rows.
  assert.deepEqual(calls, [
    { write: 'append', previews: [added] },
    {
      write: 'replace',
      identities: [replacement.identity],
      rows: [replacement],
    },
  ]);
  // The generated objects, in the order given.
  assert.deepEqual(result.stored, [replacement, added]);
  assert.equal(result.stored[0], replacement);
  assert.deepEqual(result.removed, [old]);
  assert.deepEqual(result.alreadyStored, []);
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(rows.get('m1'), [added, replacement]);
  assert.equal(logs.info.length, 1);
  assert.equal(
    logs.info[0][0],
    'resize: replaced 1 outdated preview(s) of media m1; their files are not deleted: storage refs {"key":"old.jpg"}',
  );
  assert.deepEqual(logs.warn, []);
  assert.deepEqual(logs.error, []);
});

test('an all-replacement batch with backfillDims calls appendPreviews(id, [], dims) before the replace', async () => {
  const old = preview('20x20', 'old.jpg');
  const rows = new Map<string, Preview[]>([['m1', [old]]]);
  const { media, calls } = recordingStore(rows);
  const { recorder } = recorderOver(media);
  const replacement = preview('20x20', 'new.jpg');
  const dims = { width: 64, height: 48 };
  const result = await recorder.record('m1', scope, [replacement], {
    backfillDims: dims,
    replacing: new Set([replacement.identity as string]),
  });
  assert.deepEqual(calls, [
    { write: 'append', previews: [], dims },
    {
      write: 'replace',
      identities: [replacement.identity],
      rows: [replacement],
    },
  ]);
  assert.deepEqual(result.stored, [replacement]);
  assert.deepEqual(result.removed, [old]);
});

test('a replace on a store without replacePreviews is RESIZE_MEDIA_REPLACE_MISSING', async () => {
  let appended = false;
  const media = {
    loadMedia: async () => null,
    appendPreviews: async (_id: string, previews: Preview[]) => {
      appended = true;
      return previews;
    },
  } as unknown as MediaStore;
  const { recorder } = recorderOver(media);
  const replacement = preview('20x20', 'new.jpg');
  const result = await recorder.record(
    'm1',
    scope,
    [replacement, preview('40x40', 'added.jpg')],
    { replacing: new Set([replacement.identity as string]) },
  );
  assert.equal(
    (result.failure?.error as { code?: string } | undefined)?.code,
    'RESIZE_MEDIA_REPLACE_MISSING',
  );
  // It fails before any write.
  assert.equal(appended, false);
});

test('a replace result that is not { stored, removed } is RESIZE_MEDIA_REPLACE_RESULT_INVALID', async () => {
  const media = fakeMedia({
    replacePreviews: (async () => ({ stored: [] })) as never,
  });
  const { recorder } = recorderOver(media);
  const replacement = preview('20x20', 'new.jpg');
  const result = await recorder.record('m1', scope, [replacement], {
    replacing: new Set([replacement.identity as string]),
  });
  const error = result.failure?.error as { code?: string; message?: string };
  assert.equal(error.code, 'RESIZE_MEDIA_REPLACE_RESULT_INVALID');
  assert.equal(
    error.message,
    "resize: the media store's replacePreviews resolved with something other than { stored, removed } — resolve with the rows it stored and removed ([] when none)",
  );
});

test('a rejected replace logs the unrecorded refs and returns the error, with what the append stored', async () => {
  const old = preview('20x20', 'old.jpg');
  const db = new Error('db');
  const media = fakeMedia({
    // The old row of the identity is still there; the new row is not.
    load: async (): Promise<MediaLike> => ({ original, previews: [old] }),
    replacePreviews: async () => {
      throw db;
    },
  });
  const { recorder, logs } = recorderOver(media);
  const replacement = preview('20x20', 'new.jpg');
  const added = preview('40x40', 'added.jpg');
  const result = await recorder.record('m1', scope, [replacement, added], {
    replacing: new Set([replacement.identity as string]),
  });
  assert.equal(result.failure?.error, db);
  // The append before the failed replace stored its row.
  assert.deepEqual(result.stored, [added]);
  assert.equal(logs.error.length, 1);
  assert.equal(
    logs.error[0][0],
    'resize: replacing previews failed for media m1; 1 of 1 uploaded preview(s) are not recorded: storage refs {"key":"new.jpg"}',
  );
  assert.equal(logs.error[0][1], db);
});

test('a replace that stores and removes nothing means the media is gone: one warning with the refs', async () => {
  const media = fakeMedia({
    replacePreviews: async () => ({ stored: [], removed: [] }),
  });
  const { recorder, logs } = recorderOver(media);
  const replacement = preview('20x20', 'new.jpg');
  const result = await recorder.record('m1', scope, [replacement], {
    replacing: new Set([replacement.identity as string]),
  });
  assert.deepEqual(result, {
    stored: [],
    alreadyStored: [],
    blocked: [],
    removed: [],
  });
  assert.equal(logs.warn.length, 1);
  assert.equal(
    logs.warn[0][0],
    'resize: media m1 no longer exists; 1 uploaded preview(s) are not recorded: storage refs {"key":"new.jpg"}',
  );
  assert.deepEqual(logs.info, []);
});

test('no replaced line when nothing was removed', async () => {
  // A row from before rows carried an identity: never removed, so the new row lands beside it.
  const { identity: _none, ...identityLess } = preview('20x20', 'old.jpg');
  const rows = new Map<string, Preview[]>([['m1', [identityLess]]]);
  const { media } = recordingStore(rows);
  const { recorder, logs } = recorderOver(media);
  const replacement = preview('20x20', 'new.jpg');
  const result = await recorder.record('m1', scope, [replacement], {
    replacing: new Set([replacement.identity as string]),
  });
  assert.deepEqual(result.stored, [replacement]);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(rows.get('m1'), [identityLess, replacement]);
  assert.deepEqual(logs, { info: [], warn: [], error: [] });
});

test("a row left out for another worker's row with other signatures is blocked, not already stored", async () => {
  // The other worker's row has no signatures: stale for this original and config.
  const theirs = preview('20x20', 'theirs.jpg');
  const rows = new Map<string, Preview[]>([['m1', [theirs]]]);
  const { media } = recordingStore(rows);
  const { recorder, logs } = recorderOver(media);
  const mine = preview('20x20', 'mine.jpg');
  const result = await recorder.record('m1', scope, [mine]);
  assert.deepEqual(result.stored, []);
  assert.deepEqual(result.alreadyStored, []);
  assert.deepEqual(result.blocked, [mine.identity]);
  assert.equal(logs.warn.length, 1);
  assert.match(
    String(logs.warn[0][0]),
    /with other settings or from another original/,
  );
  assert.match(String(logs.warn[0][0]), /mine\.jpg/);
  assert.deepEqual(logs.error, []);
});

test('a failed append of the dimensions alone is logged as such, and returned', async () => {
  const db = new Error('db');
  const media = fakeMedia({
    appendPreviews: async () => {
      throw db;
    },
  });
  const { recorder, logs } = recorderOver(media);
  const result = await recorder.record('m1', scope, [], {
    backfillDims: { width: 64, height: 48 },
  });
  assert.equal(result.failure?.error, db);
  assert.equal(logs.error.length, 1);
  assert.equal(
    logs.error[0][0],
    "resize: recording the original's dimensions failed for media m1 (64×48); no uploaded preview is affected",
  );
  assert.equal(logs.error[0][1], db);
});
