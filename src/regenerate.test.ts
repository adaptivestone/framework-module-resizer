// A stored preview made with other image settings, another pipeline version or from another
// original is stale: a read serves it and queues its replacement, and generate() and the worker
// render it again and replace the stored row in one write, so the next read finds it fresh. The
// old file stays in storage (deleting it is the host's job). A media without stored dimensions
// takes one task that downloads and measures the original, records the dimensions and uploads
// nothing for rows that turn out fresh. Real Sharp, in-memory storage, media documents and task
// queue; resetResizerForTests() between two Resizers of one name stands in for a redeploy.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import sharp from 'sharp';
import type { MediaStore } from './contracts/media.ts';
import type { Pipeline } from './contracts/pipeline.ts';
import { Resizer, resetResizerForTests } from './resizer.ts';
import { encodeSignature, previewOrigin } from './signatures.ts';
import {
  docMedia,
  fakeMedia,
  MemoryTaskQueue,
  memoryStorage,
} from './testHelpers/fakes.ts';
import { stampFresh } from './testHelpers/fresh.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import { workUntil } from './testHelpers/work.ts';
import type {
  MediaLike,
  Preview,
  QueueTimingOptions,
  ResizeConfig,
  ResizeLogger,
  SizeInput,
} from './types.d.ts';

const png = await sharp({
  create: {
    width: 64,
    height: 64,
    channels: 3,
    background: { r: 255, g: 0, b: 0 },
  },
})
  .png()
  .toBuffer();

afterEach(resetResizerForTests);

const cell: SizeInput[] = [{ width: 20, height: 20 }];
const identity = 'default:default:20x20:webp:none';
const keyOf = (row: Preview): string => (row.storageRef as { key: string }).key;
const rowsOf = (doc: MediaLike, id = identity): Preview[] =>
  (doc.previews ?? []).filter((row) => row.identity === id);

/** A webp-only image config with the given webp quality, built for this test alone. */
function webpConfig(quality: number): ResizeConfig {
  return makeImageConfig({
    formats: ['webp'],
    encode: { formats: { webp: { quality } } },
  });
}

/** A logger that records every call. */
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
  const lines = (level: 'info' | 'warn' | 'error', re: RegExp) =>
    logs[level].filter((args) => re.test(String(args[0])));
  return { logger, logs, lines };
}

/**
 * The parts every Resizer of one test shares: media documents, in-memory storage and one task
 * queue. `wrap` turns the docMedia() store into the store the Resizers use.
 */
function world(
  opts: {
    wrap?: (inner: ReturnType<typeof docMedia>) => MediaStore;
    timing?: Partial<QueueTimingOptions>;
  } = {},
) {
  const docs = new Map<string, MediaLike>();
  const store = docMedia(docs);
  const media = opts.wrap ? opts.wrap(store) : store;
  const { storage, files } = memoryStorage();
  const tasks = new MemoryTaskQueue({
    timing: {
      idlePollMs: 5,
      retryBackoffMs: { base: 5, max: 5 },
      ...opts.timing,
    },
  });
  const resizer = (
    config: ResizeConfig,
    logger: ResizeLogger = recordingLogger().logger,
    pipelines?: Record<string, Pipeline>,
  ) =>
    new Resizer({
      config,
      logger,
      storage,
      media,
      tasks,
      ...(pipelines ? { pipelines } : {}),
    });
  /** Store the original as media m1 and generate its 20×20 webp row; the stored document. */
  const seed = async (r: Resizer): Promise<MediaLike> => {
    const original = await r.uploadOriginal({
      body: png,
      visibility: 'private',
    });
    const doc: MediaLike = { id: 'm1', original, previews: [] };
    docs.set('m1', doc);
    await r.generate({
      media: structuredClone(doc),
      sizes: cell,
      formats: ['webp'],
    });
    assert.equal(rowsOf(doc).length, 1);
    return doc;
  };
  /** Run the worker for `r` until every task has ended (completed or dead). */
  const work = (r: Resizer, logger: ResizeLogger = r.logger) =>
    workUntil({ logger, resizers: [r] }, () =>
      tasks.rows.every(
        (row) => row.status === 'completed' || row.status === 'dead',
      ),
    );
  const read = (r: Resizer, media: MediaLike, sizes: SizeInput[] = cell) =>
    r.resolve({ media, sizes, formats: ['webp'] });
  return { docs, store, storage, files, tasks, resizer, seed, work, read };
}

test('changing webp.quality regenerates on the next read', async () => {
  const w = world();
  const a = w.resizer(webpConfig(80));
  const doc = await w.seed(a);
  const [r1] = rowsOf(doc);
  resetResizerForTests();

  const { logger, lines } = recordingLogger();
  const b = w.resizer(webpConfig(70), logger);
  const { decision } = await w.read(b, doc);
  assert.equal(decision.ready.length, 1);
  assert.equal(decision.ready[0].stale, true);
  assert.equal(decision.ready[0].url, `/m/${keyOf(r1)}`);
  assert.equal(w.tasks.rows.length, 1);

  await w.work(b);
  assert.equal(w.tasks.rows[0].status, 'completed');
  const rows = rowsOf(doc);
  assert.equal(rows.length, 1);
  assert.equal(
    rows[0].encodeSig,
    encodeSignature(b.config, { format: 'webp', fit: false }),
  );
  assert.notDeepEqual(rows[0].storageRef, r1.storageRef);
  // The outdated file is not deleted: that is the host's job.
  assert.ok(w.files.has(keyOf(r1)));
  assert.equal(
    lines(
      'info',
      /replaced 1 outdated preview\(s\) of media m1; their files are not deleted/,
    ).length,
    1,
  );

  const again = await w.read(b, doc);
  assert.equal(again.decision.ready.length, 1);
  assert.equal(again.decision.ready[0].stale, undefined);
  assert.equal('stale' in again.decision, false);
  assert.equal(again.decision.ready[0].url, `/m/${keyOf(rows[0])}`);
  assert.equal(w.tasks.rows.length, 1);
});

test('a pipeline version or encode option changed at run time regenerates, and the new row is fresh', async () => {
  const w = world();
  const pipeline: Pipeline = {};
  const config = webpConfig(80);
  const r = w.resizer(config, undefined, { default: pipeline });
  const doc = await w.seed(r);

  pipeline.version = 'v2';
  const stale = await w.read(r, doc);
  assert.equal(stale.decision.ready[0].stale, true);
  assert.equal(w.tasks.rows.length, 1);
  await w.work(r);
  assert.equal(w.tasks.rows[0].status, 'completed');
  const fresh = await w.read(r, doc);
  assert.equal('stale' in fresh.decision, false);
  assert.equal(fresh.decision.ready[0].stale, undefined);
  assert.equal(
    rowsOf(doc)[0].encodeSig,
    encodeSignature(config, { format: 'webp', fit: false, version: 'v2' }),
  );

  (config.encode.formats.webp as { quality: number }).quality = 60;
  const staleAgain = await w.read(r, doc);
  assert.equal(staleAgain.decision.ready[0].stale, true);
  assert.equal(w.tasks.rows.length, 2);
  await w.work(r);
  assert.equal(w.tasks.rows[1].status, 'completed');
  const freshAgain = await w.read(r, doc);
  assert.equal('stale' in freshAgain.decision, false);
  assert.equal(rowsOf(doc).length, 1);
  assert.equal(w.tasks.rows.length, 2);
});

test('generate() regenerates a stale row in one replace and returns the old ref in replaced', async () => {
  const w = world();
  const doc = await w.seed(w.resizer(webpConfig(80)));
  const [r1] = rowsOf(doc);
  resetResizerForTests();

  const b = w.resizer(webpConfig(70));
  const media = structuredClone(doc);
  const appends = w.store.appendCalls.length;
  const replaces = w.store.replaceCalls.length;
  const result = await b.generate({ media, sizes: cell, formats: ['webp'] });
  assert.equal(result.created.length, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.replaced, [r1.storageRef]);
  // The caller's in-memory media swapped the row too.
  assert.deepEqual(rowsOf(media), result.created);
  assert.equal(w.store.replaceCalls.length - replaces, 1);
  assert.deepEqual(w.store.replaceCalls.at(-1)?.rows, result.created);
  assert.equal(w.store.appendCalls.length, appends);
  assert.deepEqual(rowsOf(doc), result.created);
});

test('generate() leaves fresh rows alone', async () => {
  const w = world();
  const r = w.resizer(webpConfig(80));
  const doc = await w.seed(r);
  let downloads = 0;
  const download = w.storage.download;
  w.storage.download = async (ref) => {
    downloads += 1;
    return download(ref);
  };
  const result = await r.generate({
    media: structuredClone(doc),
    sizes: cell,
    formats: ['webp'],
  });
  assert.deepEqual(result.created, []);
  assert.equal(result.failed, 0);
  assert.equal('replaced' in result, false);
  assert.equal(downloads, 0);
});

test('a task over one stale and one missing variant appends one row and replaces one', async () => {
  const w = world();
  const doc = await w.seed(w.resizer(webpConfig(80)));
  resetResizerForTests();

  const b = w.resizer(webpConfig(70));
  const sizes = [...cell, { width: 40, height: 40 }];
  const { decision } = await w.read(b, doc, sizes);
  assert.equal(decision.ready[0].stale, true);
  assert.deepEqual(
    decision.stale?.map((v) => v.sizeKey),
    ['20x20'],
  );
  assert.deepEqual(
    decision.missing.map((v) => v.sizeKey),
    ['40x40'],
  );
  assert.equal(w.tasks.rows.length, 1);

  const appends = w.store.appendCalls.length;
  const replaces = w.store.replaceCalls.length;
  await w.work(b);
  assert.equal(w.tasks.rows[0].status, 'completed');
  const appended = w.store.appendCalls.slice(appends);
  assert.equal(appended.length, 1);
  assert.deepEqual(
    appended[0].previews.map((row) => row.sizeKey),
    ['40x40'],
  );
  const replaced = w.store.replaceCalls.slice(replaces);
  assert.equal(replaced.length, 1);
  assert.deepEqual(
    replaced[0].rows.map((row) => row.sizeKey),
    ['20x20'],
  );
  assert.equal(doc.previews?.length, 2);

  const again = await w.read(b, doc, sizes);
  assert.equal('stale' in again.decision, false);
  assert.deepEqual(again.decision.missing, []);
  assert.equal(again.decision.ready.length, 2);
  assert.equal(w.tasks.rows.length, 1);
});

test('a media without stored dimensions: one download-and-inspect task records them, uploads nothing, and the next read is fresh', async () => {
  const w = world();
  const { logger, lines } = recordingLogger();
  const r = w.resizer(webpConfig(80), logger);
  const doc = await w.seed(r);
  const original = doc.original as { width?: number; height?: number };
  delete original.width;
  delete original.height;

  const { decision } = await w.read(r, doc);
  assert.equal(decision.ready[0].stale, true);
  assert.equal(w.tasks.rows.length, 1);

  const files = w.files.size;
  const appends = w.store.appendCalls.length;
  await w.work(r);
  assert.equal(w.tasks.rows[0].status, 'completed');
  assert.equal(w.files.size, files);
  assert.deepEqual(w.store.appendCalls.slice(appends), [
    { mediaId: 'm1', previews: [], backfillDims: { width: 64, height: 64 } },
  ]);
  assert.equal(w.store.replaceCalls.length, 0);
  assert.equal(original.width, 64);
  assert.equal(original.height, 64);

  const again = await w.read(r, doc);
  assert.equal('stale' in again.decision, false);
  assert.equal(again.decision.ready[0].stale, undefined);
  assert.equal(w.tasks.rows.length, 1);
  assert.deepEqual(lines('warn', /already fresh/), []);
  assert.deepEqual(
    lines('warn', /did not record the original's dimensions/),
    [],
  );
});

test('a stored null width is treated as missing: backfilled once, regenerated once, then fresh', async () => {
  const w = world();
  const r = w.resizer(webpConfig(80));
  const doc = await w.seed(r);
  const original = doc.original as unknown as {
    storageRef: unknown;
    width: number | null;
    height: number | null;
  };
  // Rows an older writer signed for the stored nulls.
  for (const row of doc.previews ?? []) {
    row.origin = previewOrigin(original.storageRef, {
      width: null,
      height: null,
    } as never);
  }
  original.width = null;
  original.height = null;

  const { decision } = await w.read(r, doc);
  assert.equal(decision.ready[0].stale, true);
  assert.equal(w.tasks.rows.length, 1);

  const files = w.files.size;
  const appends = w.store.appendCalls.length;
  const replaces = w.store.replaceCalls.length;
  await w.work(r);
  assert.equal(w.tasks.rows[0].status, 'completed');
  assert.equal(w.store.replaceCalls.length - replaces, 1);
  assert.equal(w.files.size, files + 1);
  assert.deepEqual(w.store.appendCalls.slice(appends), [
    { mediaId: 'm1', previews: [], backfillDims: { width: 64, height: 64 } },
  ]);
  assert.equal(original.width, 64);
  assert.equal(original.height, 64);

  const again = await w.read(r, doc);
  assert.equal('stale' in again.decision, false);
  assert.equal(w.tasks.rows.length, 1);
});

test('a store that drops the backfill gets one warning, and still uploads nothing', async () => {
  const w = world({
    // The backfill never reaches the document.
    wrap: (inner) =>
      fakeMedia({
        load: (id) => inner.loadMedia(id),
        appendPreviews: (id, previews) => inner.appendPreviews(id, previews),
        replacePreviews: (id, identities, rows) =>
          inner.replacePreviews(id, identities, rows),
      }),
  });
  const { logger, lines } = recordingLogger();
  const r = w.resizer(webpConfig(80), logger);
  const doc = await w.seed(r);
  const original = doc.original as { width?: number; height?: number };
  delete original.width;
  delete original.height;
  const files = w.files.size;

  for (const cycle of [1, 2]) {
    const { decision } = await w.read(r, doc);
    assert.equal(decision.ready[0].stale, true);
    assert.equal(w.tasks.rows.length, cycle);
    await w.work(r);
    assert.equal(w.tasks.rows[cycle - 1].status, 'completed');
    assert.equal(w.files.size, files);
  }
  assert.equal(original.width, undefined);
  assert.equal(
    lines(
      'warn',
      /the media store did not record the original's dimensions of media m1/,
    ).length,
    1,
  );
});

test("generate() sets the backfilled dimensions on the caller's media, even when the store keeps its own copy", async () => {
  const w = world({
    // The store loads a copy of its document and writes only its document.
    wrap: (inner) =>
      fakeMedia({
        load: async (id) => structuredClone(await inner.loadMedia(id)),
        appendPreviews: (id, previews, dims) =>
          inner.appendPreviews(id, previews, dims),
        replacePreviews: (id, identities, rows) =>
          inner.replacePreviews(id, identities, rows),
      }),
  });
  const r = w.resizer(webpConfig(80));
  const uploaded = await r.uploadOriginal({ body: png, visibility: 'private' });
  const doc: MediaLike = {
    id: 'm1',
    original: { storageRef: uploaded.storageRef, format: uploaded.format },
    previews: [],
  };
  w.docs.set('m1', doc);
  const media = structuredClone(doc);

  const { created } = await r.generate({
    media,
    sizes: cell,
    formats: ['webp'],
  });
  assert.equal(created.length, 1);
  assert.equal(media.original?.width, 64);
  assert.equal(media.original?.height, 64);
  assert.equal(doc.original?.width, 64);

  const { decision } = await w.read(r, media);
  assert.equal('stale' in decision, false);
  assert.equal(decision.ready.length, 1);
  assert.equal(decision.ready[0].stale, undefined);
  assert.equal(w.tasks.rows.length, 0);
});

/** Media m1 with a stored original and one 20×20 webp row from before rows carried an identity. */
async function seedIdentityLess(w: ReturnType<typeof world>, r: Resizer) {
  const original = await r.uploadOriginal({
    body: png,
    visibility: 'private',
  });
  const old: Preview = {
    storageRef: { key: 'previews/old.webp' },
    sizeKey: '20x20',
    requestedWidth: 20,
    requestedHeight: 20,
    format: 'webp',
    contentType: 'image/webp',
  };
  const doc: MediaLike = { id: 'm1', original, previews: [old] };
  w.docs.set('m1', doc);
  return { doc, old };
}

test('a stale row from before 0.3.0 (no identity) gets a new row beside it, which the next read serves', async () => {
  const w = world();
  const r = w.resizer(webpConfig(80));
  const { doc, old } = await seedIdentityLess(w, r);
  const { decision } = await w.read(r, doc);
  assert.equal(decision.ready[0].stale, true);
  assert.equal(decision.ready[0].url, '/m/previews/old.webp');
  assert.equal(w.tasks.rows.length, 1);

  await w.work(r);
  assert.equal(w.tasks.rows[0].status, 'completed');
  assert.equal(doc.previews?.length, 2);
  assert.equal(doc.previews?.[0], old);
  const [added] = rowsOf(doc);

  const again = await w.read(r, doc);
  assert.equal('stale' in again.decision, false);
  assert.equal(again.decision.ready.length, 1);
  assert.equal(again.decision.ready[0].url, `/m/${keyOf(added)}`);
  assert.equal(w.tasks.rows.length, 1);
});

test('a store that returns the replacement before the old row still serves the new row', async () => {
  const w = world({
    // The store puts the rows it stores first.
    wrap: (inner) =>
      fakeMedia({
        load: (id) => inner.loadMedia(id),
        appendPreviews: (id, previews, dims) =>
          inner.appendPreviews(id, previews, dims),
        replacePreviews: async (id, identities, rows) => {
          const result = await inner.replacePreviews(id, identities, rows);
          const doc = w.docs.get(id);
          if (doc) {
            doc.previews = [
              ...result.stored,
              ...(doc.previews ?? []).filter(
                (row) => !result.stored.includes(row),
              ),
            ];
          }
          return result;
        },
      }),
  });
  const r = w.resizer(webpConfig(80));
  const { doc, old } = await seedIdentityLess(w, r);
  await w.read(r, doc);
  assert.equal(w.tasks.rows.length, 1);
  await w.work(r);
  assert.equal(w.tasks.rows[0].status, 'completed');
  assert.equal(doc.previews?.length, 2);
  assert.equal(doc.previews?.[1], old);
  const [added] = rowsOf(doc);
  assert.equal(doc.previews?.[0], added);

  const again = await w.read(r, doc);
  assert.equal('stale' in again.decision, false);
  assert.equal(again.decision.ready[0].url, `/m/${keyOf(added)}`);
  assert.equal(w.tasks.rows.length, 1);
});

test('API and worker with different settings: the worker completes a no-op task, uploads nothing, and warns once', async () => {
  const w = world();
  const workerConfig = webpConfig(80);
  const readerConfig = webpConfig(70);
  const reader = w.resizer(readerConfig);
  const original = await reader.uploadOriginal({
    body: png,
    visibility: 'private',
  });
  // Rows the worker's settings made.
  const doc = stampFresh(
    {
      id: 'm1',
      original,
      previews: [
        {
          storageRef: { key: 'previews/w.webp' },
          identity,
          resizer: 'default',
          pipeline: 'default',
          sizeKey: '20x20',
          requestedWidth: 20,
          requestedHeight: 20,
          format: 'webp',
          contentType: 'image/webp',
        },
      ],
    } as MediaLike,
    { config: workerConfig },
  );
  w.docs.set('m1', doc);
  const { decision } = await w.read(reader, doc);
  assert.equal(decision.ready[0].stale, true);
  assert.equal(w.tasks.rows.length, 1);
  resetResizerForTests();

  const { logger, lines } = recordingLogger();
  const worker = w.resizer(workerConfig, logger);
  const files = w.files.size;
  await w.work(worker);
  assert.equal(w.tasks.rows[0].status, 'completed');
  assert.equal(w.files.size, files);
  assert.equal(
    lines(
      'warn',
      /already fresh — if this repeats, the API and the worker may run different image settings or pipeline versions/,
    ).length,
    1,
  );
  resetResizerForTests();

  const readerAgain = w.resizer(readerConfig);
  await w.read(readerAgain, doc);
  assert.equal(w.tasks.rows.length, 2);
});

test('a stale row whose regeneration keeps failing stays served', async () => {
  const w = world({ timing: { maxAttempts: 1 } });
  const doc = await w.seed(w.resizer(webpConfig(80)));
  const [r1] = rowsOf(doc);
  resetResizerForTests();

  const b = w.resizer(webpConfig(70));
  w.files.delete(
    (doc.original as { storageRef: { key: string } }).storageRef.key,
  );
  const { decision } = await w.read(b, doc);
  assert.equal(decision.ready[0].stale, true);
  assert.equal(w.tasks.rows.length, 1);
  await w.work(b);
  assert.equal(w.tasks.rows[0].status, 'dead');

  const again = await w.read(b, doc);
  assert.equal(again.decision.ready.length, 1);
  assert.equal(again.decision.ready[0].stale, true);
  assert.equal(again.decision.ready[0].url, `/m/${keyOf(r1)}`);
  // The dead task holds the gate for its cooldown: nothing more is queued.
  assert.equal(w.tasks.rows.length, 1);
});

test("a beforeEnqueue tap's `fit: 1` is a cover variant: queued, rendered, stored and signed as one", async () => {
  const w = world();
  const config = webpConfig(80);
  const r = new Resizer({
    config,
    logger: recordingLogger().logger,
    storage: w.storage,
    media: w.store,
    tasks: w.tasks,
    hooks: {
      // A tap written in plain JavaScript can hand back any truthy value.
      beforeEnqueue: (missing) =>
        missing.map((v) => ({ ...v, fit: 1 as unknown as boolean })),
    },
  });
  const original = await r.uploadOriginal({ body: png, visibility: 'private' });
  const doc: MediaLike = { id: 'm1', original, previews: [] };
  w.docs.set('m1', doc);

  const { decision } = await w.read(r, structuredClone(doc));
  assert.equal(decision.missing.length, 1);
  assert.equal(w.tasks.added.length, 1);
  assert.deepEqual(
    w.tasks.added[0].previews.map((v) => v.fit),
    [false],
  );

  await w.work(r);
  const [row] = rowsOf(doc);
  assert.equal(row.fit, undefined);
  assert.equal(
    row.encodeSig,
    encodeSignature(config, { format: 'webp', fit: false }),
  );
  // The cover size, not the whole 64×64 source a fit variant would keep.
  assert.deepEqual([row.actualWidth, row.actualHeight], [20, 20]);
  const again = await w.read(r, structuredClone(doc));
  assert.equal(again.decision.ready.length, 1);
  assert.equal(again.decision.ready[0].stale, undefined);
});

test('settings changed while a preview uploads: the row keeps the signature it was rendered with, so the next read regenerates it', async () => {
  const w = world();
  const pipeline: Pipeline = { version: 'v1' };
  const config = webpConfig(80);
  const r = w.resizer(config, undefined, { default: pipeline });
  const original = await r.uploadOriginal({ body: png, visibility: 'private' });
  const doc: MediaLike = { id: 'm1', original, previews: [] };
  w.docs.set('m1', doc);
  const upload = w.storage.upload;
  w.storage.upload = async (args) => {
    // A redeploy's settings land while the old rendering is on its way to storage.
    pipeline.version = 'v2';
    (config.encode.formats.webp as { quality: number }).quality = 60;
    return upload(args);
  };

  await r.generate({
    media: structuredClone(doc),
    sizes: cell,
    formats: ['webp'],
  });
  const [row] = rowsOf(doc);
  assert.equal(
    row.encodeSig,
    encodeSignature(webpConfig(80), {
      format: 'webp',
      fit: false,
      version: 'v1',
    }),
  );
  const { decision } = await w.read(r, doc);
  assert.equal(decision.ready[0].stale, true);
});

test('the original replaced while it downloads: the row records the original it was made from, so the next read regenerates it', async () => {
  const w = world();
  const r = w.resizer(webpConfig(80));
  const blue = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: 0, g: 0, b: 255 },
    },
  })
    .png()
    .toBuffer();
  const red = await r.uploadOriginal({ body: png, visibility: 'private' });
  const replacement = await r.uploadOriginal({
    body: blue,
    visibility: 'private',
  });
  const doc: MediaLike = { id: 'm1', original: { ...red }, previews: [] };
  w.docs.set('m1', doc);
  const media = structuredClone(doc);
  const download = w.storage.download;
  w.storage.download = async (ref) => {
    const bytes = await download(ref);
    // The host swaps the original while its old bytes are being read.
    for (const m of [media, doc]) {
      if (m.original) {
        m.original.storageRef = replacement.storageRef;
      }
    }
    return bytes;
  };
  const parents: unknown[] = [];
  const upload = w.storage.upload;
  w.storage.upload = async (args) => {
    parents.push(args.parentRef);
    return upload(args);
  };

  await r.generate({ media, sizes: cell, formats: ['webp'] });
  const [row] = rowsOf(doc);
  assert.equal(
    row.origin,
    previewOrigin(red.storageRef, { width: 64, height: 64 }),
  );
  assert.deepEqual(parents, [red.storageRef]);
  w.storage.download = download;
  const { decision } = await w.read(r, doc);
  assert.equal(decision.ready[0].stale, true);
});

test('a store that drops `fit` from the rows it stores: the fit row is fresh after its task, and nothing more is queued', async () => {
  const strip = (rows: Preview[]): Preview[] =>
    rows.map(({ fit: _fit, ...row }) => row);
  const w = world({
    // A strict row schema without `fit`, or a table without a fit column.
    wrap: (inner) =>
      fakeMedia({
        load: (id) => inner.loadMedia(id),
        appendPreviews: (id, previews, dims) =>
          inner.appendPreviews(id, strip(previews), dims),
        replacePreviews: (id, identities, rows) =>
          inner.replacePreviews(id, identities, strip(rows)),
      }),
  });
  const r = w.resizer(webpConfig(80));
  const original = await r.uploadOriginal({ body: png, visibility: 'private' });
  const doc: MediaLike = { id: 'm1', original, previews: [] };
  w.docs.set('m1', doc);
  const fit: SizeInput[] = [{ fit: true }];

  const first = await w.read(r, doc, fit);
  assert.equal(first.decision.missing.length, 1);
  assert.equal(w.tasks.rows.length, 1);
  await w.work(r);
  assert.equal(w.tasks.rows[0].status, 'completed');
  const [row] = rowsOf(doc, 'default:default:fit:webp:none');
  assert.equal('fit' in row, false);

  const again = await w.read(r, doc, fit);
  assert.equal('stale' in again.decision, false);
  assert.equal(again.decision.ready.length, 1);
  assert.equal(again.decision.ready[0].stale, undefined);
  assert.equal(w.tasks.rows.length, 1);
});

test('settings flipped and restored while a render runs: the preview is made with the settings it is signed with', async () => {
  const w = world();
  // jpeg is flattened on white by default.
  const config = makeImageConfig({ formats: ['jpeg'] });
  const variantCalls: string[] = [];
  const pipeline: Pipeline = {
    beforeSteps: [
      async (raster) => {
        // Another deploy's settings land while the render is under way.
        config.encode.flatten.background = '#000000';
        pipeline.variantSteps?.push(async (img) => {
          variantCalls.push('added');
          return img;
        });
        return raster;
      },
    ],
    variantSteps: [],
  };
  const r = w.resizer(config, undefined, { default: pipeline });
  const transparent = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
  const original = await r.uploadOriginal({
    body: transparent,
    visibility: 'private',
  });
  const doc: MediaLike = { id: 'm1', original, previews: [] };
  w.docs.set('m1', doc);

  await r.generate({
    media: structuredClone(doc),
    sizes: cell,
    formats: ['jpeg'],
  });
  // ...and the old settings come back.
  config.encode.flatten.background = '#ffffff';
  const [row] = rowsOf(doc, 'default:default:20x20:jpeg:none');
  const file = w.files.get(keyOf(row));
  assert.ok(file);
  const { data } = await sharp(file)
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.ok(data[0] > 200, `flattened on white, got ${data[0]}`);
  // The step added mid-render did not run: the render keeps the step set it started with.
  assert.deepEqual(variantCalls, []);
  const { decision } = await r.resolve({
    media: doc,
    sizes: cell,
    formats: ['jpeg'],
  });
  assert.equal(decision.ready[0].stale, undefined);
});

test('a config carrying an extra key that cannot be cloned (a function): generate() still renders', async () => {
  const w = world();
  const config = Object.assign(webpConfig(80), {
    hostHelper: () => 'not image data',
  });
  const r = w.resizer(config);
  const original = await r.uploadOriginal({ body: png, visibility: 'private' });
  const doc: MediaLike = { id: 'm1', original, previews: [] };
  w.docs.set('m1', doc);

  const result = await r.generate({
    media: structuredClone(doc),
    sizes: cell,
    formats: ['webp'],
  });
  assert.equal(result.created.length, 1);
  assert.equal(rowsOf(doc).length, 1);
});

test('the original locator changed in place while it downloads: the row records the old one, so the next read regenerates it', async () => {
  const w = world();
  const r = w.resizer(webpConfig(80));
  const red = await r.uploadOriginal({ body: png, visibility: 'private' });
  const oldRef = structuredClone(red.storageRef);
  const doc: MediaLike = { id: 'm1', original: red, previews: [] };
  w.docs.set('m1', doc);
  const media = structuredClone(doc);
  const download = w.storage.download;
  w.storage.download = async (ref) => {
    const bytes = await download(ref);
    // The host rewrites the locator's key in place while the old bytes are being read.
    for (const m of [media, doc]) {
      (m.original?.storageRef as { key: string }).key = 'originals/other.png';
    }
    return bytes;
  };
  const parents: unknown[] = [];
  const upload = w.storage.upload;
  w.storage.upload = async (args) => {
    parents.push(structuredClone(args.parentRef));
    return upload(args);
  };

  await r.generate({ media, sizes: cell, formats: ['webp'] });
  const [row] = rowsOf(doc);
  assert.equal(row.origin, previewOrigin(oldRef, { width: 64, height: 64 }));
  assert.deepEqual(parents, [oldRef]);
  w.storage.download = download;
  const { decision } = await w.read(r, doc);
  assert.equal(decision.ready[0].stale, true);
});

test('a locator holding a Buffer, a class instance, a Date and a nested array: the driver gets them with their types, and a change in place does not reach it', async () => {
  const w = world();
  const r = w.resizer(webpConfig(80));
  const red = await r.uploadOriginal({ body: png, visibility: 'private' });
  const { key } = red.storageRef as { key: string };
  /** Stands in for a bson ObjectId: a class instance a driver calls methods on. */
  class Handle {
    readonly id: string;
    constructor(id: string) {
      this.id = id;
    }
    toHexString(): string {
      return this.id;
    }
  }
  const handle = new Handle('abc123');
  const locator = {
    key,
    etag: Buffer.from('etag'),
    owner: handle,
    savedAt: new Date(1_000),
    parts: [{ name: 'a' }, ['b']],
  };
  const doc: MediaLike = {
    id: 'm1',
    original: { ...red, storageRef: locator },
    previews: [],
  };
  w.docs.set('m1', doc);
  type Seen = typeof locator;
  const check = (seen: Seen, where: string) => {
    assert.notEqual(seen, locator, `${where}: a copy`);
    assert.equal(Buffer.isBuffer(seen.etag), true, `${where}: a Buffer`);
    assert.equal(seen.etag.toString(), 'etag', where);
    assert.equal(seen.owner, handle, `${where}: the instance itself`);
    assert.equal(seen.owner.toHexString(), 'abc123', where);
    assert.ok(seen.savedAt instanceof Date, `${where}: a Date`);
    assert.equal(seen.savedAt.getTime(), 1_000, where);
    assert.deepEqual(seen.parts, [{ name: 'a' }, ['b']], where);
    assert.ok(Array.isArray(seen.parts[1]), where);
  };
  const download = w.storage.download;
  w.storage.download = async (ref) => {
    const seen = ref as Seen;
    check(seen, 'download');
    const bytes = await download(ref);
    // The host changes the live locator in place while the old bytes are being read.
    locator.etag.write('xxxx');
    locator.savedAt.setTime(2_000);
    (locator.parts[0] as { name: string }).name = 'changed';
    (locator.parts[1] as string[]).push('c');
    return bytes;
  };
  const parents: Seen[] = [];
  const upload = w.storage.upload;
  w.storage.upload = async (args) => {
    parents.push(args.parentRef as Seen);
    return upload(args);
  };

  await r.generate({ media: doc, sizes: cell, formats: ['webp'] });
  assert.equal(parents.length, 1);
  check(parents[0], 'parentRef');
});

test('a locator with its own toJSON (a Mongoose sub-document, say): the row is signed as the read path signs it, so the next read is fresh', async () => {
  const w = world();
  const r = w.resizer(webpConfig(80));
  const red = await r.uploadOriginal({ body: png, visibility: 'private' });
  const { key } = red.storageRef as { key: string };
  // A sub-document whose schema gives toObject() and toJSON() different options (virtuals in one,
  // say): the origin signature reads the JSON form, so the worker's copy must be that form too.
  const subdoc = {
    key,
    toObject: () => ({ key, region: 'virtual' }),
    toJSON: () => ({ key }),
  };
  const doc: MediaLike = {
    id: 'm1',
    original: { ...red, storageRef: subdoc },
    previews: [],
  };
  w.docs.set('m1', doc);

  await r.generate({ media: doc, sizes: cell, formats: ['webp'] });
  const [row] = rowsOf(doc);
  assert.equal(row.origin, previewOrigin({ key }, { width: 64, height: 64 }));
  const { decision } = await w.read(r, doc);
  assert.deepEqual(
    decision.ready.map((served) => served.stale ?? false),
    [false],
  );
  assert.deepEqual(decision.missing, []);
});

test('a locator whose toJSON reads its key, or returns nothing: the row is signed as the read path signs it', async () => {
  for (const toJSON of [
    // The signature recipe serializes the locator under the `storageRef` key.
    (keyName: string) =>
      keyName === 'storageRef' ? { key: 'k' } : { key: 'k', root: true },
    () => undefined,
  ]) {
    resetResizerForTests();
    const w = world();
    const r = w.resizer(webpConfig(80));
    const red = await r.uploadOriginal({ body: png, visibility: 'private' });
    const { key } = red.storageRef as { key: string };
    const doc: MediaLike = {
      id: 'm1',
      original: { ...red, storageRef: { key, toJSON } },
      previews: [],
    };
    w.docs.set('m1', doc);

    await r.generate({ media: doc, sizes: cell, formats: ['webp'] });
    const { decision } = await w.read(r, doc);
    assert.deepEqual(decision.missing, []);
    assert.equal(decision.ready[0].stale ?? false, false);
  }
});

test('a locator holding a Buffer: the row is signed as the read path signs it, so the next read is fresh', async () => {
  const w = world();
  const r = w.resizer(webpConfig(80));
  const red = await r.uploadOriginal({ body: png, visibility: 'private' });
  const { key } = red.storageRef as { key: string };
  // A deep copy turns a Buffer into a Uint8Array, whose JSON form differs from the Buffer's.
  const storageRef = { key, etag: Buffer.from('v1') };
  const doc: MediaLike = {
    id: 'm1',
    original: { ...red, storageRef },
    previews: [],
  };
  w.docs.set('m1', doc);

  await r.generate({ media: doc, sizes: cell, formats: ['webp'] });
  const [row] = rowsOf(doc);
  assert.equal(
    row.origin,
    previewOrigin(storageRef, { width: 64, height: 64 }),
  );
  const { decision } = await w.read(r, doc);
  assert.deepEqual(decision.missing, []);
  assert.equal(decision.ready[0].stale ?? false, false);
});
