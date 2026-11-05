// A stored preview made with other image settings, another pipeline version or from another
// original is stale: a read serves it and queues its replacement, and generate() and the worker
// render it again and replace the stored row in one write, so the next read finds it fresh. The
// old file stays in storage (deleting it is the host's job). A media without stored dimensions
// takes one task that downloads and measures the original, records the dimensions and uploads
// nothing for rows that turn out fresh. Real Sharp, in-memory storage, media documents and task
// queue; resetResizerForTests() between two Resizers of one name stands in for a redeploy.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';
import mongoose from 'mongoose';
import sharp from 'sharp';
import type { MediaStore } from './contracts/media.ts';
import type { Pipeline } from './contracts/pipeline.ts';
import type { ResizeError } from './errors.ts';
import { getPreviewIdentity, previewScope } from './images.ts';
import {
  Resizer,
  type ResizerOptions,
  resetResizerForTests,
} from './resizer.ts';
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

test('a config whose image settings it inherits through its prototype: generate() renders, and the next read is fresh', async () => {
  const w = world();
  const config = Object.create(webpConfig(80)) as ResizeConfig;
  assert.equal(Object.hasOwn(config, 'encode'), false);
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
  const { decision } = await w.read(r, doc);
  assert.deepEqual(decision.missing, []);
  assert.equal(decision.ready[0].stale ?? false, false);
});

test('an encode setting holding a function, changed in place while a render runs: the preview is made with the settings it is signed with', async () => {
  const w = world();
  // jpeg is flattened on white by default; the extra function key cannot be cloned.
  const config = makeImageConfig({ formats: ['jpeg'] });
  Object.assign(config.encode, { hostHelper: () => 'not image data' });
  const pipeline: Pipeline = {
    beforeSteps: [
      async (raster) => {
        // Another deploy's settings land while the render is under way.
        config.encode.flatten.background = '#000000';
        return raster;
      },
    ],
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
  const { decision } = await r.resolve({
    media: doc,
    sizes: cell,
    formats: ['jpeg'],
  });
  assert.equal(decision.ready[0].stale, undefined);
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

test('a locator with an own __proto__ key (parsed from JSON): the driver gets it as an own key, with a plain prototype', async () => {
  const w = world();
  const r = w.resizer(webpConfig(80));
  const red = await r.uploadOriginal({ body: png, visibility: 'private' });
  const { key } = red.storageRef as { key: string };
  const json = `{"key":${JSON.stringify(key)},"__proto__":{"region":"x"}}`;
  const locator = JSON.parse(json) as Record<string, unknown>;
  assert.equal(Object.hasOwn(locator, '__proto__'), true);
  const doc: MediaLike = {
    id: 'm1',
    original: { ...red, storageRef: locator },
    previews: [],
  };
  w.docs.set('m1', doc);
  const check = (seen: unknown, where: string) => {
    assert.notEqual(seen, locator, `${where}: a copy`);
    assert.equal(
      Object.hasOwn(seen as object, '__proto__'),
      true,
      `${where}: an own __proto__ key`,
    );
    assert.equal(
      Object.getPrototypeOf(seen),
      Object.prototype,
      `${where}: a plain prototype`,
    );
    assert.equal((seen as { region?: unknown }).region, undefined, where);
    assert.equal(JSON.stringify(seen), json, where);
  };
  const seen: unknown[] = [];
  const download = w.storage.download;
  w.storage.download = async (ref) => {
    seen.push(ref);
    return download(ref);
  };
  const parents: unknown[] = [];
  const upload = w.storage.upload;
  w.storage.upload = async (args) => {
    parents.push(args.parentRef);
    return upload(args);
  };

  await r.generate({ media: doc, sizes: cell, formats: ['webp'] });
  assert.equal(seen.length, 1);
  check(seen[0], 'download');
  assert.equal(parents.length, 1);
  check(parents[0], 'parentRef');
});

test('a Mongoose sub-document locator with a Buffer path: the driver gets a Buffer with the same bytes, not a bson Binary', async () => {
  const w = world();
  const r = w.resizer(webpConfig(80));
  const red = await r.uploadOriginal({ body: png, visibility: 'private' });
  const { key } = red.storageRef as { key: string };
  const owner = new mongoose.Types.ObjectId();
  // A connection that never connects: the documents are only hydrated, never saved.
  const connection = mongoose.createConnection();
  const sub = new mongoose.Schema(
    { key: String, etag: Buffer, owner: mongoose.Schema.Types.ObjectId },
    { _id: false },
  );
  const models = [
    connection.model(
      'LocatorSubSchemaMedia',
      new mongoose.Schema({ original: { storageRef: sub } }),
    ),
    connection.model(
      'LocatorNestedMedia',
      new mongoose.Schema({
        original: {
          storageRef: {
            key: String,
            etag: Buffer,
            owner: mongoose.Schema.Types.ObjectId,
          },
        },
      }),
    ),
  ];
  for (const Model of models) {
    const hydrated = new Model({
      original: { storageRef: { key, etag: Buffer.from('etag'), owner } },
    }) as unknown as { original: { storageRef: unknown } };
    const { storageRef } = hydrated.original;
    assert.equal(
      typeof (storageRef as { toObject?: unknown }).toObject,
      'function',
      `${Model.modelName}: a Mongoose sub-document`,
    );
    const doc: MediaLike = {
      id: 'm1',
      original: { ...red, storageRef },
      previews: [],
    };
    w.docs.set('m1', doc);
    type Seen = { key: string; etag: unknown; owner: unknown };
    const check = (ref: unknown, where: string) => {
      const seen = ref as Seen;
      assert.equal(seen.key, key, where);
      assert.equal(Buffer.isBuffer(seen.etag), true, `${where}: a Buffer`);
      assert.equal((seen.etag as Buffer).toString(), 'etag', where);
      assert.ok(seen.owner instanceof mongoose.Types.ObjectId, where);
      assert.equal(String(seen.owner), String(owner), where);
    };
    const download = w.storage.download;
    const downloads: unknown[] = [];
    w.storage.download = async (ref) => {
      downloads.push(ref);
      return download(ref);
    };
    const parents: unknown[] = [];
    const upload = w.storage.upload;
    w.storage.upload = async (args) => {
      parents.push(args.parentRef);
      return upload(args);
    };

    await r.generate({ media: doc, sizes: cell, formats: ['webp'] });
    w.storage.download = download;
    w.storage.upload = upload;
    assert.equal(downloads.length, 1, Model.modelName);
    check(downloads[0], `${Model.modelName} download`);
    assert.equal(parents.length, 1, Model.modelName);
    check(parents[0], `${Model.modelName} parentRef`);
  }
});

test('a Mongoose sub-document locator with a UUID path: the driver gets the UUID, not a Buffer', async () => {
  const w = world();
  const r = w.resizer(webpConfig(80));
  const red = await r.uploadOriginal({ body: png, visibility: 'private' });
  const { key } = red.storageRef as { key: string };
  const uuid = new mongoose.mongo.UUID();
  // A connection that never connects: the document is only hydrated, never saved.
  const connection = mongoose.createConnection();
  const Model = connection.model(
    'LocatorUuidMedia',
    new mongoose.Schema({
      original: {
        storageRef: new mongoose.Schema(
          { key: String, uuid: mongoose.Schema.Types.UUID },
          { _id: false },
        ),
      },
    }),
  );
  const hydrated = new Model({
    original: { storageRef: { key, uuid } },
  }) as unknown as { original: { storageRef: unknown } };
  const doc: MediaLike = {
    id: 'm1',
    original: { ...red, storageRef: hydrated.original.storageRef },
    previews: [],
  };
  w.docs.set('m1', doc);
  const seen: unknown[] = [];
  const download = w.storage.download;
  w.storage.download = async (ref) => {
    seen.push((ref as { uuid: unknown }).uuid);
    return download(ref);
  };

  await r.generate({ media: doc, sizes: cell, formats: ['webp'] });
  assert.equal(seen.length, 1);
  assert.equal(Buffer.isBuffer(seen[0]), false);
  assert.equal(
    (seen[0] as { toHexString(): string }).toHexString(),
    uuid.toHexString(),
  );
});

test('a bson Binary the host put into a plain locator reaches the driver as it is', async () => {
  const w = world();
  const r = w.resizer(webpConfig(80));
  const red = await r.uploadOriginal({ body: png, visibility: 'private' });
  const { key } = red.storageRef as { key: string };
  const binary = new mongoose.mongo.Binary(Buffer.from('etag'));
  const doc: MediaLike = {
    id: 'm1',
    original: { ...red, storageRef: { key, etag: binary } },
    previews: [],
  };
  w.docs.set('m1', doc);
  const seen: unknown[] = [];
  const download = w.storage.download;
  w.storage.download = async (ref) => {
    seen.push((ref as { etag: unknown }).etag);
    return download(ref);
  };

  await r.generate({ media: doc, sizes: cell, formats: ['webp'] });
  assert.deepEqual(seen.length, 1);
  assert.equal(seen[0], binary);
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

// ---- The media store must keep what the worker writes.

/** A store that loses `field` from the rows it stores, and answers with the rows it was given. */
const losing =
  (field: keyof Preview, only: (row: Preview) => boolean = () => true) =>
  (inner: ReturnType<typeof docMedia>): MediaStore => {
    const strip = (rows: Preview[]): Preview[] =>
      rows.map((row) => {
        if (!only(row)) {
          return row;
        }
        const { [field]: _lost, ...rest } = row;
        return rest as Preview;
      });
    return fakeMedia({
      load: (id) => inner.loadMedia(id),
      appendPreviews: async (id, previews, dims) => {
        await inner.appendPreviews(id, strip(previews), dims);
        return previews;
      },
      replacePreviews: async (id, identities, rows) => {
        const { removed } = await inner.replacePreviews(
          id,
          identities,
          strip(rows),
        );
        return { stored: rows, removed };
      },
    });
  };

/** Upload the png as the original of media m1, with no previews stored yet. */
async function bareMedia(
  w: ReturnType<typeof world>,
  r: Resizer,
): Promise<MediaLike> {
  const original = await r.uploadOriginal({ body: png, visibility: 'private' });
  const doc: MediaLike = { id: 'm1', original, previews: [] };
  w.docs.set('m1', doc);
  return doc;
}

/** The errors of the tasks `r` dead-letters from now on. */
function deadErrors(r: Resizer): ResizeError[] {
  const errors: ResizeError[] = [];
  r.hook('onTaskDeadLettered', (_task, err) => {
    errors.push(err as ResizeError);
  });
  return errors;
}

const statuses = (w: ReturnType<typeof world>) =>
  w.tasks.rows.map((row) => [row.status, row.attempts]);

/** Storage that names a preview by its bytes: equal bytes give one ref. */
function contentAddressed(w: ReturnType<typeof world>): void {
  const upload = w.storage.upload.bind(w.storage);
  w.storage.upload = (args) =>
    upload({
      ...args,
      key: `previews/${createHash('sha256').update(args.body).digest('hex')}`,
    });
}

// Both boxes are larger than the 64×64 source, so both previews are the source at its own size:
// equal bytes, two size keys.
const twoBoxes: SizeInput[] = [
  { width: 100, height: 100 },
  { width: 200, height: 200 },
];

for (const field of [
  'origin',
  'encodeSig',
  'sizeKey',
  'format',
  'contentType',
  'storageRef',
] as const) {
  test(`a store that loses ${field}: the first task is dead with RESIZE_MEDIA_ROW_NOT_KEPT naming it, after one upload`, async () => {
    const w = world({ wrap: losing(field) });
    const { logger, lines } = recordingLogger();
    const r = w.resizer(webpConfig(80), logger);
    const doc = await bareMedia(w, r);
    const files = w.files.size;
    const errors = deadErrors(r);

    await w.read(r, doc);
    await w.work(r, logger);

    assert.deepEqual(statuses(w), [['dead', 1]]);
    assert.equal(w.files.size, files + 1);
    assert.equal(errors[0].code, 'RESIZE_MEDIA_ROW_NOT_KEPT');
    assert.equal(errors[0].retryable, false);
    assert.equal(
      errors[0].message,
      `resize worker: the media store did not keep ${field} of 1 preview row(s) of media m1, so reads may render them again and again — a MediaStore must store and return storageRef, origin, encodeSig, sizeKey, format, contentType, resizer, pipeline and filters as given: default:default:20x20:webp:none (${field})`,
    );
    if (field === 'encodeSig') {
      // An operator finds it in the dead line (src/consumer.ts).
      assert.equal(lines('error', /RESIZE_MEDIA_ROW_NOT_KEPT/).length, 1);
    }
  });
}

// `losing` answers with the rows it was given. This store answers with what it really stored, so
// the recorder leaves the row out, and the check must still see it.
for (const field of [
  'sizeKey',
  'format',
  'contentType',
  'storageRef',
] as const) {
  test(`a store that answers with the rows as it stored them, without ${field}: dead at once too, after one upload`, async () => {
    const w = world({
      wrap: (inner) =>
        fakeMedia({
          load: (id) => inner.loadMedia(id),
          appendPreviews: async (id, previews, dims) => {
            const rows = previews.map((row) => {
              const { [field]: _lost, ...rest } = row;
              return rest as Preview;
            });
            await inner.appendPreviews(id, rows, dims);
            return rows;
          },
          replacePreviews: (id, identities, rows) =>
            inner.replacePreviews(id, identities, rows),
        }),
    });
    const r = w.resizer(webpConfig(80));
    const doc = await bareMedia(w, r);
    const files = w.files.size;
    const errors = deadErrors(r);

    await w.read(r, doc);
    await w.work(r);

    assert.deepEqual(statuses(w), [['dead', 1]]);
    assert.equal(w.files.size, files + 1);
    assert.equal(errors[0].code, 'RESIZE_MEDIA_ROW_NOT_KEPT');
  });
}

for (const [field, pipeline, filters] of [
  ['pipeline', 'x', undefined],
  ['filters', 'default', { blur: 2 }],
] as const) {
  test(`a store that loses ${field}: reads would miss the row, so the task is dead too`, async () => {
    const w = world({ wrap: losing(field) });
    const r = w.resizer(webpConfig(80), undefined, { default: {}, x: {} });
    const doc = await bareMedia(w, r);
    const errors = deadErrors(r);

    await r.resolve({
      media: doc,
      sizes: [{ width: 20, height: 20, ...(filters ? { filters } : {}) }],
      formats: ['webp'],
      pipeline,
    });
    await w.work(r);

    assert.deepEqual(statuses(w), [['dead', 1]]);
    assert.equal(errors[0].code, 'RESIZE_MEDIA_ROW_NOT_KEPT');
    assert.match(errors[0].message, new RegExp(`did not keep ${field} of 1`));
  });
}

test('a store that loses resizer: reads of a named Resizer would miss the row, so the task is dead too', async () => {
  const w = world();
  const r = new Resizer({
    name: 'listings',
    config: webpConfig(80),
    logger: recordingLogger().logger,
    storage: w.storage,
    media: losing('resizer')(w.store),
    tasks: w.tasks,
  });
  const doc = await bareMedia(w, r);
  const errors = deadErrors(r);

  await w.read(r, doc);
  await w.work(r);

  assert.deepEqual(statuses(w), [['dead', 1]]);
  assert.equal(errors[0].code, 'RESIZE_MEDIA_ROW_NOT_KEPT');
  assert.match(
    errors[0].message,
    /did not keep resizer of 1 preview row\(s\).*listings:default:20x20:webp:none \(resizer\)$/,
  );
});

// Its answer says nothing was stored, so attempt 1 finds the row it just wrote, sees other
// signatures on it, and takes it for another worker's: blocked, not judged, and retried. Attempt 2
// replaces that row, and a row a replace left out is judged.
test("a store that answers [] and loses encodeSig: attempt 1 cannot tell its row from another worker's, so attempt 2 is dead, after two uploads", async () => {
  const strip = (rows: Preview[]): Preview[] =>
    rows.map(({ encodeSig: _lost, ...row }) => row);
  const w = world({
    wrap: (inner) =>
      fakeMedia({
        load: (id) => inner.loadMedia(id),
        appendPreviews: async (id, previews, dims) => {
          await inner.appendPreviews(id, strip(previews), dims);
          return [];
        },
        replacePreviews: async (id, identities, rows) => {
          const { removed } = await inner.replacePreviews(
            id,
            identities,
            strip(rows),
          );
          return { stored: [], removed };
        },
      }),
  });
  const r = w.resizer(webpConfig(80));
  const doc = await bareMedia(w, r);
  const files = w.files.size;
  const errors = deadErrors(r);

  await w.read(r, doc);
  await w.work(r);

  assert.deepEqual(statuses(w), [['dead', 2]]);
  assert.equal(w.files.size, files + 2);
  assert.equal(errors[0].code, 'RESIZE_MEDIA_ROW_NOT_KEPT');
});

/**
 * A store keyed by the identity it computes from each row's fields, as a table with its own key can
 * be. Its `identity` column holds what `column` makes of the identity it was given.
 */
const tableStore =
  (column: (identity: string) => string | null | undefined) =>
  (inner: ReturnType<typeof docMedia>): MediaStore => {
    const keyOf = (row: Preview): string =>
      getPreviewIdentity(
        previewScope(row),
        row.sizeKey,
        row.format,
        row.filters,
      );
    const asStored = ({ identity, ...row }: Preview): Preview => {
      const value = column(String(identity));
      return (
        value === undefined ? row : { ...row, identity: value }
      ) as Preview;
    };
    return fakeMedia({
      load: (id) => inner.loadMedia(id),
      appendPreviews: async (id, previews, dims) => {
        await inner.appendPreviews(id, [], dims);
        const doc = (await inner.loadMedia(id)) as MediaLike;
        const rows = doc.previews ?? [];
        const held = new Set(rows.map(keyOf));
        const added = previews.filter((row) => !held.has(keyOf(row)));
        doc.previews = [...rows, ...added.map(asStored)];
        return added;
      },
      replacePreviews: async (id, identities, written) => {
        const doc = (await inner.loadMedia(id)) as MediaLike;
        const rows = doc.previews ?? [];
        const gone = new Set([...identities, ...written.map(keyOf)]);
        doc.previews = [
          ...rows.filter((row) => !gone.has(keyOf(row))),
          ...written.map(asStored),
        ];
        return {
          stored: written,
          removed: rows.filter((row) => gone.has(keyOf(row))),
        };
      },
    });
  };

for (const [form, column] of [
  ['absent', () => undefined],
  ['null', () => null],
  ['in its own form', (identity: string) => `own/${identity}`],
] as const) {
  test(`a store keyed by the computed identity, its identity column ${form}: tasks complete, reads are fresh, and one warning says what stays behind`, async () => {
    const w = world({ wrap: tableStore(column) });
    const { logger, logs, lines } = recordingLogger();
    const r = w.resizer(webpConfig(80), logger);
    const doc = await bareMedia(w, r);

    await w.read(r, doc);
    await w.work(r, logger);
    assert.deepEqual(statuses(w), [['completed', 1]]);
    const { decision } = await w.read(r, doc);
    assert.deepEqual(decision.missing, []);
    assert.equal(decision.ready[0].stale ?? false, false);
    assert.equal(w.tasks.rows.length, 1);

    // A second task, and no second line: one warning per Resizer.
    await w.read(r, doc, [{ width: 30, height: 30 }]);
    await w.work(r, logger);
    assert.deepEqual(statuses(w), [
      ['completed', 1],
      ['completed', 1],
    ]);
    assert.deepEqual(logs.error, []);
    const warned = lines('warn', /did not keep the identity/);
    assert.equal(warned.length, 1);
    assert.equal(
      warned[0][0],
      'resize worker: the media store did not keep the identity of 1 preview row(s) of media m1: invalidate() finds such rows only by identity, so it leaves them, and a replacePreviews that removes by stored identity leaves them too — store and return identity as given: default:default:20x20:webp:none',
    );
  });
}

test('a store keyed by the computed identity: a replacement is not blocked, and the new row is served', async () => {
  const w = world({ wrap: tableStore(() => undefined) });
  const first = w.resizer(webpConfig(80));
  const doc = await bareMedia(w, first);
  await w.read(first, doc);
  await w.work(first);
  const [before] = doc.previews ?? [];
  resetResizerForTests();

  const r = w.resizer(webpConfig(70));
  const stale = await w.read(r, doc);
  assert.equal(stale.decision.ready[0].stale, true);
  await w.work(r);

  assert.deepEqual(statuses(w), [
    ['completed', 1],
    ['completed', 1],
  ]);
  const { decision } = await w.read(r, doc);
  assert.deepEqual(decision.missing, []);
  assert.equal(decision.ready[0].stale ?? false, false);
  assert.notDeepEqual(doc.previews?.[0].storageRef, before.storageRef);
});

test('a store keyed by the computed identity, with no identity column: invalidate() leaves its rows, as the warning says', async () => {
  const w = world({ wrap: tableStore(() => undefined) });
  const r = w.resizer(webpConfig(80));
  const doc = await bareMedia(w, r);
  await w.read(r, doc);
  await w.work(r);

  assert.deepEqual(await r.invalidate({ media: doc }), []);

  assert.equal(doc.previews?.length, 1);
});

test('a store that keeps contentType in its own form: the row is served, so the task completes and the next read is fresh', async () => {
  const w = world({
    wrap: (inner) =>
      fakeMedia({
        load: (id) => inner.loadMedia(id),
        appendPreviews: async (id, previews, dims) => {
          await inner.appendPreviews(
            id,
            previews.map((row) => ({
              ...row,
              contentType: row.contentType.toUpperCase(),
            })),
            dims,
          );
          return previews;
        },
        replacePreviews: (id, identities, rows) =>
          inner.replacePreviews(id, identities, rows),
      }),
  });
  const r = w.resizer(webpConfig(80));
  const doc = await bareMedia(w, r);

  await w.read(r, doc);
  await w.work(r);

  assert.deepEqual(statuses(w), [['completed', 1]]);
  const { decision } = await w.read(r, doc);
  assert.deepEqual(decision.missing, []);
  assert.equal(decision.ready[0].stale ?? false, false);
  assert.equal(w.tasks.rows.length, 1);
});

test('a store whose rows keep their identity: no identity warning', async () => {
  const w = world();
  const { logger, lines } = recordingLogger();
  const r = w.resizer(webpConfig(80), logger);
  const doc = await bareMedia(w, r);

  await w.read(r, doc);
  await w.work(r, logger);

  assert.deepEqual(statuses(w), [['completed', 1]]);
  assert.deepEqual(lines('warn', /did not keep the identity/), []);
});

// ---- An old row without a ref is not the row a task wrote.

/** A flat row from before rows had a storageRef, which 0.3.0 left unmigrated. */
const flatRow = (): Preview =>
  ({
    key: 'old.webp',
    bucket: 'b',
    sizeKey: '20x20',
    format: 'webp',
    contentType: 'image/webp',
  }) as unknown as Preview;

/** The docMedia() store, with `after` run between each append and the reload that follows it. */
const appending =
  (
    after: (
      inner: ReturnType<typeof docMedia>,
      id: string,
      rows: Preview[],
    ) => Promise<unknown>,
  ) =>
  (inner: ReturnType<typeof docMedia>): MediaStore =>
    fakeMedia({
      load: (id) => inner.loadMedia(id),
      appendPreviews: async (id, previews, dims) => {
        const stored = await inner.appendPreviews(id, previews, dims);
        await after(inner, id, stored);
        return stored;
      },
      replacePreviews: (id, identities, rows) =>
        inner.replacePreviews(id, identities, rows),
    });

const identitiesOf = (rows: Preview[]): string[] =>
  rows.map((row) => row.identity as string);

for (const [name, wrap] of [
  [
    'invalidate() landing between the write and the reload',
    appending((inner, id, rows) =>
      inner.replacePreviews(id, identitiesOf(rows), []),
    ),
  ],
  [
    'another worker replacing the row under its own ref',
    appending((inner, id, rows) =>
      inner.replacePreviews(
        id,
        identitiesOf(rows),
        rows.map((row) => ({ ...row, storageRef: { key: 'theirs.webp' } })),
      ),
    ),
  ],
  [
    'a custom store reshaping its refs',
    (inner: ReturnType<typeof docMedia>): MediaStore =>
      fakeMedia({
        load: (id) => inner.loadMedia(id),
        appendPreviews: async (id, previews, dims) => {
          await inner.appendPreviews(
            id,
            previews.map((row) => ({
              ...row,
              storageRef: { path: keyOf(row) },
            })),
            dims,
          );
          return previews;
        },
        replacePreviews: (id, identities, rows) =>
          inner.replacePreviews(id, identities, rows),
      }),
  ],
] as const) {
  test(`an old row without a ref, of the same size and format, and ${name}: the task completes`, async () => {
    const w = world({ wrap });
    const { logger, logs } = recordingLogger();
    const r = w.resizer(webpConfig(80), logger);
    const doc = await bareMedia(w, r);
    doc.previews = [flatRow()];

    await w.read(r, doc);
    await w.work(r, logger);

    assert.deepEqual(statuses(w), [['completed', 1]]);
    assert.deepEqual(logs.error, []);
  });
}

// ---- The check must never fail a task whose work is done.

const hostileRef = (): Preview['storageRef'] => ({
  toJSON() {
    throw new TypeError('no JSON');
  },
  toString() {
    throw new TypeError('no string');
  },
});

const throwingIdentity = (row: Preview): Preview =>
  Object.defineProperty({ ...row }, 'identity', {
    enumerable: true,
    get() {
      throw new TypeError('no identity');
    },
  });

/** A row of nothing this file requests. */
const unrelatedRow = (storageRef: Preview['storageRef']): Preview => ({
  storageRef,
  sizeKey: '999x999',
  format: 'webp',
  contentType: 'image/webp',
  identity: 'default:default:999x999:webp:none',
});

/** The docMedia() store, but `rows` decides what each load shows of the rows it holds. */
const showing =
  (rows: (held: Preview[]) => Preview[]) =>
  (inner: ReturnType<typeof docMedia>): MediaStore =>
    fakeMedia({
      load: async (id) => {
        const doc = await inner.loadMedia(id);
        return doc && { ...doc, previews: rows(doc.previews ?? []) };
      },
      appendPreviews: (id, previews, dims) =>
        inner.appendPreviews(id, previews, dims),
      replacePreviews: (id, identities, written) =>
        inner.replacePreviews(id, identities, written),
    });

for (const [name, wrap] of [
  [
    'a ref whose JSON and String() both throw, on an unrelated row',
    showing((held) => [unrelatedRow(hostileRef()), ...held]),
  ],
  [
    'a throwing identity getter, on an unrelated row',
    showing((held) => [
      throwingIdentity(unrelatedRow({ key: 'unrelated' })),
      ...held,
    ]),
  ],
  [
    'a throwing identity getter, on the row under the written ref',
    showing((held) => held.map(throwingIdentity)),
  ],
] as const) {
  test(`${name}: the task completes at its first attempt`, async () => {
    const w = world({ wrap });
    const { logger, logs } = recordingLogger();
    const r = w.resizer(webpConfig(80), logger);
    const doc = await bareMedia(w, r);

    await w.read(r, doc);
    await w.work(r, logger);

    assert.deepEqual(statuses(w), [['completed', 1]]);
    assert.deepEqual(logs.error, []);
    assert.equal(rowsOf(doc).length, 1);
  });
}

test('a ref whose JSON and String() both throw, on the row under the written ref: the task completes at its first attempt', async () => {
  const w = world();
  const { logger, logs } = recordingLogger();
  const r = w.resizer(webpConfig(80), logger);
  const doc = await bareMedia(w, r);
  // Only the preview's locator: the original's was stored above.
  w.storage.upload = async () => hostileRef();

  await w.read(r, doc);
  await w.work(r, logger);

  assert.deepEqual(statuses(w), [['completed', 1]]);
  assert.deepEqual(logs.error, []);
  assert.equal(rowsOf(doc).length, 1);
});

test('a check that throws logs one line, and each task keeps its result', async () => {
  // Each reload holds rows that cannot be read the first time, which nothing in the check guards
  // row by row: the worker's own guard is what is left. Every task loads twice.
  let loads = 0;
  const w = world({
    wrap: (inner) =>
      fakeMedia({
        load: async (id) => {
          const doc = await inner.loadMedia(id);
          loads += 1;
          if (!doc || loads % 2 === 1) {
            return doc;
          }
          let thrown = false;
          return Object.defineProperty({ ...doc }, 'previews', {
            get() {
              if (!thrown) {
                thrown = true;
                throw new TypeError('no rows');
              }
              return doc.previews;
            },
          });
        },
        appendPreviews: (id, previews, dims) =>
          inner.appendPreviews(id, previews, dims),
        replacePreviews: (id, identities, rows) =>
          inner.replacePreviews(id, identities, rows),
      }),
  });
  const { logger, logs, lines } = recordingLogger();
  const r = w.resizer(webpConfig(80), logger);
  const doc = await bareMedia(w, r);

  await w.read(r, doc);
  await w.work(r, logger);
  await w.read(r, doc, [{ width: 30, height: 30 }]);
  await w.work(r, logger);

  assert.deepEqual(statuses(w), [
    ['completed', 1],
    ['completed', 1],
  ]);
  assert.deepEqual(logs.error, []);
  const warned = lines('warn', /could not check what the media store kept/);
  assert.equal(warned.length, 1);
  assert.match(String(warned[0][0]), /media m1.*keeps its result/);
  assert.match(String(warned[0][1]), /no rows/);
});

// The case the group rule exists for.
test('a content-addressed store gives two size keys one ref: the task completes and the next read queues nothing', async () => {
  const w = world();
  contentAddressed(w);
  const r = w.resizer(webpConfig(80));
  const doc = await bareMedia(w, r);

  await w.read(r, doc, twoBoxes);
  await w.work(r);

  assert.deepEqual(statuses(w), [['completed', 1]]);
  const rows = doc.previews ?? [];
  assert.deepEqual(
    rows.map((row) => row.sizeKey),
    ['100x100', '200x200'],
  );
  // The case itself: one written row's first row under the ref is another size key's.
  assert.deepEqual(rows[0].storageRef, rows[1].storageRef);
  const again = await w.read(r, doc, twoBoxes);
  assert.equal(again.decision.missing.length, 0);
  assert.equal(w.tasks.rows.length, 1);
});

test('one ref for two rows, and the store lost encodeSig of one: only that row is named', async () => {
  const w = world({
    wrap: losing('encodeSig', (row) => row.sizeKey === '200x200'),
  });
  contentAddressed(w);
  const r = w.resizer(webpConfig(80));
  const doc = await bareMedia(w, r);
  const errors = deadErrors(r);

  await w.read(r, doc, twoBoxes);
  await w.work(r);

  assert.deepEqual(statuses(w), [['dead', 1]]);
  assert.match(
    errors[0].message,
    /did not keep encodeSig of 1 preview row\(s\)/,
  );
  assert.match(
    errors[0].message,
    /default:default:200x200:webp:none \(encodeSig\)$/,
  );
});

for (const field of ['format', 'filters', 'pipeline'] as const) {
  test(`one ref for two rows, and the store lost ${field} of one: that field is named, not the other size key's`, async () => {
    const w = world({
      wrap: losing(field, (row) => row.sizeKey === '200x200'),
    });
    contentAddressed(w);
    const r = w.resizer(webpConfig(80), undefined, { default: {}, x: {} });
    const doc = await bareMedia(w, r);
    const errors = deadErrors(r);

    await r.resolve({
      media: doc,
      sizes: twoBoxes.map((size) => ({ ...size, filters: { blur: 2 } })),
      formats: ['webp'],
      pipeline: 'x',
    });
    await w.work(r);

    assert.deepEqual(statuses(w), [['dead', 1]]);
    assert.match(
      errors[0].message,
      new RegExp(
        `did not keep ${field} of 1 preview row.*:200x200:.* \\(${field}\\)$`,
      ),
    );
  });
}

/** The docMedia() store. While `lag.on`, each second load shows the rows the first one showed. */
const lagging =
  (lag: { on: boolean }) =>
  (inner: ReturnType<typeof docMedia>): MediaStore => {
    let held: Preview[] | undefined;
    return fakeMedia({
      load: async (id) => {
        const doc = await inner.loadMedia(id);
        if (!doc || !lag.on) {
          return doc;
        }
        if (!held) {
          held = [...(doc.previews ?? [])];
          return doc;
        }
        const previews = held;
        held = undefined;
        return { ...doc, previews };
      },
      appendPreviews: (id, previews, dims) =>
        inner.appendPreviews(id, previews, dims),
      replacePreviews: (id, identities, rows) =>
        inner.replacePreviews(id, identities, rows),
    });
  };

// The two forms of one accepted corner, on a driver that names files by their bytes: the row under
// the written ref is another one, because this task's row is not back yet.
test('a lagging reload on a byte-named driver, another size key already under the ref: a first render is dead naming sizeKey, its rows are stored, and the next read is fresh', async () => {
  const lag = { on: false };
  const w = world({ wrap: lagging(lag) });
  contentAddressed(w);
  const r = w.resizer(webpConfig(80));
  const doc = await bareMedia(w, r);
  const errors = deadErrors(r);
  await w.read(r, doc, [twoBoxes[0]]);
  await w.work(r);

  lag.on = true;
  await w.read(r, doc, [twoBoxes[1]]);
  await w.work(r);
  lag.on = false;

  assert.deepEqual(statuses(w), [
    ['completed', 1],
    ['dead', 1],
  ]);
  assert.match(errors[0].message, /did not keep sizeKey of 1 preview row/);
  assert.equal(doc.previews?.length, 2);
  const { decision } = await w.read(r, doc, twoBoxes);
  assert.deepEqual(decision.missing, []);
  assert.equal(
    decision.ready.some((entry) => entry.stale),
    false,
  );
});

test('a lagging reload on a byte-named driver after a replacement: the task is dead naming encodeSig, its row is stored, and the next read is fresh', async () => {
  const lag = { on: false };
  const w = world({ wrap: lagging(lag) });
  contentAddressed(w);
  const first = w.resizer(webpConfig(80), undefined, { default: {} });
  const doc = await bareMedia(w, first);
  await w.read(first, doc);
  await w.work(first);
  resetResizerForTests();

  // Another pipeline version over equal bytes: another signature under the same ref.
  const r = w.resizer(webpConfig(80), undefined, {
    default: { version: '2' },
  });
  const errors = deadErrors(r);
  lag.on = true;
  await w.read(r, doc);
  await w.work(r);
  lag.on = false;

  assert.deepEqual(statuses(w), [
    ['completed', 1],
    ['dead', 1],
  ]);
  assert.match(errors[0].message, /did not keep encodeSig of 1 preview row/);
  const { decision } = await w.read(r, doc);
  assert.deepEqual(decision.missing, []);
  assert.equal(decision.ready[0].stale ?? false, false);
});

test('a store that loses encodeSig from a replaced row: the task is dead too', async () => {
  const w = world();
  const doc = await w.seed(w.resizer(webpConfig(80)));
  resetResizerForTests();
  const r = new Resizer({
    config: webpConfig(70),
    logger: recordingLogger().logger,
    storage: w.storage,
    media: losing('encodeSig')(w.store),
    tasks: w.tasks,
  });
  const errors = deadErrors(r);

  await w.read(r, doc);
  await w.work(r);

  assert.deepEqual(statuses(w), [['dead', 1]]);
  assert.equal(errors[0].code, 'RESIZE_MEDIA_ROW_NOT_KEPT');
});

test('a reload that lags behind the write raises nothing: the task completes as before', async () => {
  let loads = 0;
  const w = world({
    wrap: (inner) =>
      fakeMedia({
        load: async (id) => {
          const doc = await inner.loadMedia(id);
          loads += 1;
          return loads > 1 && doc ? { ...doc, previews: [] } : doc;
        },
        appendPreviews: (id, previews, dims) =>
          inner.appendPreviews(id, previews, dims),
        replacePreviews: (id, identities, rows) =>
          inner.replacePreviews(id, identities, rows),
      }),
  });
  const r = w.resizer(webpConfig(80));
  const doc = await bareMedia(w, r);

  await w.read(r, doc);
  await w.work(r);

  assert.ok(loads > 1);
  assert.deepEqual(statuses(w), [['completed', 1]]);
});

test("an original swapped during the worker's download stays the retryable RESIZE_WORKER_INCOMPLETE, and its retry completes", async () => {
  const w = world();
  const r = w.resizer(webpConfig(80));
  const doc = await bareMedia(w, r);
  const other = await r.uploadOriginal({ body: png, visibility: 'private' });
  const download = w.storage.download;
  let swapped = false;
  w.storage.download = async (ref) => {
    const bytes = await download(ref);
    if (!swapped) {
      swapped = true;
      doc.original = other;
    }
    return bytes;
  };
  const failed: string[] = [];
  r.hook('onTaskFailed', (_task, err) => {
    failed.push((err as ResizeError).code);
  });

  await w.read(r, doc);
  await w.work(r);

  assert.deepEqual(failed, ['RESIZE_WORKER_INCOMPLETE']);
  assert.deepEqual(statuses(w), [['completed', 2]]);
});

test('generate() reads nothing back: a store that loses encodeSig does not fail the call', async () => {
  const w = world({ wrap: losing('encodeSig') });
  const r = w.resizer(webpConfig(80));
  const doc = await bareMedia(w, r);

  const { created } = await r.generate({
    media: structuredClone(doc),
    sizes: cell,
    formats: ['webp'],
  });

  assert.equal(created.length, 1);
});

/** Media m1 with its row stored under quality 80, and a redeploy with other settings to come. */
async function storedThenChanged() {
  const w = world();
  const doc = await w.seed(w.resizer(webpConfig(80)));
  const [old] = rowsOf(doc);
  resetResizerForTests();
  return { w, doc, old };
}

/** A Resizer with the new settings over the world's store, with its own replacePreviews. */
function replacingWith(
  w: ReturnType<typeof world>,
  replacePreviews: MediaStore['replacePreviews'],
  opts: Partial<ResizerOptions> = {},
): Resizer {
  return new Resizer({
    config: webpConfig(70),
    logger: recordingLogger().logger,
    storage: w.storage,
    tasks: w.tasks,
    media: fakeMedia({
      load: (id) => w.store.loadMedia(id),
      appendPreviews: (id, rows, dims) =>
        w.store.appendPreviews(id, rows, dims),
      replacePreviews,
    }),
    ...opts,
  });
}

test('the worker replacing a stale row fires onPreviewReplaced once, with the removed row and ctx {}, after onPreviewGenerated', async () => {
  const { w, doc, old } = await storedThenChanged();
  const r = w.resizer(webpConfig(70));
  const order: string[] = [];
  const calls: { row: Preview; ctx: Record<string, unknown> }[] = [];
  r.hook('onPreviewGenerated', () => {
    order.push('generated');
  });
  r.hook('onPreviewReplaced', (row, ctx) => {
    order.push('replaced');
    calls.push({ row, ctx });
  });

  await w.read(r, doc);
  await w.work(r);

  assert.deepEqual(order, ['generated', 'replaced']);
  assert.deepEqual(calls[0].row.storageRef, old.storageRef);
  assert.equal(calls[0].row.identity, old.identity);
  assert.deepEqual(calls[0].ctx, {});
  assert.notDeepEqual(rowsOf(doc)[0].storageRef, old.storageRef);
});

test('generate() fires onPreviewReplaced too, for the refs its result names as replaced', async () => {
  const { w, doc } = await storedThenChanged();
  const r = w.resizer(webpConfig(70));
  const fired: Preview[] = [];
  r.hook('onPreviewReplaced', (row) => {
    fired.push(row);
  });

  const { replaced } = await r.generate({
    media: structuredClone(doc),
    sizes: cell,
    formats: ['webp'],
  });

  assert.equal(fired.length, 1);
  assert.deepEqual(replaced, [fired[0].storageRef]);
});

test('onPreviewReplaced stays silent when no write removed a row: a first render, persist: false, invalidate()', async () => {
  const w = world();
  const fired: Preview[] = [];
  const first = w.resizer(webpConfig(80));
  first.hook('onPreviewReplaced', (row) => {
    fired.push(row);
  });
  const doc = await w.seed(first);
  resetResizerForTests();
  const later = w.resizer(webpConfig(70));
  later.hook('onPreviewReplaced', (row) => {
    fired.push(row);
  });

  await later.generate({
    media: structuredClone(doc),
    sizes: cell,
    formats: ['webp'],
    persist: false,
  });
  const refs = await later.invalidate({ media: structuredClone(doc) });

  assert.equal(refs.length, 1);
  assert.deepEqual(fired, []);
});

test('a tap that throws costs nothing: the next tap runs, the task completes, and the failure is logged', async () => {
  const { w, doc } = await storedThenChanged();
  const { logger, lines } = recordingLogger();
  const r = w.resizer(webpConfig(70), logger);
  const fired: Preview[] = [];
  r.hook('onPreviewReplaced', () => {
    throw new Error('the host could not delete it');
  });
  r.hook('onPreviewReplaced', (row) => {
    fired.push(row);
  });

  await w.read(r, doc);
  await w.work(r);

  assert.equal(fired.length, 1);
  assert.deepEqual(statuses(w).at(-1), ['completed', 1]);
  assert.equal(
    lines('error', /resize hook onPreviewReplaced failed/).length,
    1,
  );
});

test('every row the write removed is reported, also a copy another worker stored meanwhile', async () => {
  const { w, doc, old } = await storedThenChanged();
  const copy: Preview = { ...old, storageRef: { key: 'their-copy' } };
  const r = replacingWith(w, async (id, identities, rows) => {
    const result = await w.store.replacePreviews(id, identities, rows);
    return { ...result, removed: [...result.removed, copy] };
  });
  const fired: Preview[] = [];
  r.hook('onPreviewReplaced', (row) => {
    fired.push(row);
  });

  await w.read(r, doc);
  await w.work(r);

  assert.deepEqual(
    fired.map((row) => row.storageRef),
    [old.storageRef, copy.storageRef],
  );
});

test('a rejected replace fires nothing: no row was removed', async () => {
  const { w, doc } = await storedThenChanged();
  const r = replacingWith(w, async () => {
    throw new Error('the database is down');
  });
  const fired: Preview[] = [];
  r.hook('onPreviewReplaced', (row) => {
    fired.push(row);
  });

  await assert.rejects(
    r.generate({
      media: structuredClone(doc),
      sizes: cell,
      formats: ['webp'],
    }),
    /the database is down/,
  );
  assert.deepEqual(fired, []);
});

test('the event bus receives resize:onPreviewReplaced with the removed row', async () => {
  const { w, doc, old } = await storedThenChanged();
  const emitted: unknown[][] = [];
  const r = replacingWith(
    w,
    (id, identities, rows) => w.store.replacePreviews(id, identities, rows),
    {
      events: {
        emit: (...args: unknown[]) => {
          emitted.push(args);
        },
      },
    },
  );

  await r.generate({
    media: structuredClone(doc),
    sizes: cell,
    formats: ['webp'],
  });

  const event = emitted.find(([name]) => name === 'resize:onPreviewReplaced');
  assert.ok(event);
  assert.deepEqual((event[1] as Preview).storageRef, old.storageRef);
});

test('a replacement that keeps the ref of the row it replaced is not reported: that file is in use', async () => {
  const w = world();
  contentAddressed(w);
  const pipeline: Pipeline = {};
  const r = w.resizer(webpConfig(80), undefined, { default: pipeline });
  const fired: Preview[] = [];
  r.hook('onPreviewReplaced', (row) => {
    fired.push(row);
  });
  const doc = await w.seed(r);
  pipeline.version = 'v2';

  const media = structuredClone(doc);
  const { created, replaced } = await r.generate({
    media,
    sizes: cell,
    formats: ['webp'],
  });

  assert.equal(created.length, 1);
  assert.deepEqual(fired, []);
  assert.equal(replaced, undefined);
  assert.equal(rowsOf(doc).length, 1);
  // The swap in the caller's media goes by identity, so it still happens.
  assert.deepEqual(
    rowsOf(media).map((row) => row.encodeSig),
    [created[0].encodeSig],
  );
});

test('a ref another size key still holds, outside the write, is reported: seeing it needs a read, so such a driver uses the sweep', async () => {
  const w = world();
  contentAddressed(w);
  const first = w.resizer(webpConfig(80));
  const doc = await bareMedia(w, first);
  await first.generate({
    media: structuredClone(doc),
    sizes: twoBoxes,
    formats: ['webp'],
  });
  const [kept, other] = doc.previews ?? [];
  assert.deepEqual(kept.storageRef, other.storageRef);
  resetResizerForTests();
  const r = w.resizer(webpConfig(70));
  const fired: Preview[] = [];
  r.hook('onPreviewReplaced', (row) => {
    fired.push(row);
  });

  await r.generate({
    media: structuredClone(doc),
    sizes: [twoBoxes[0]],
    formats: ['webp'],
  });

  assert.deepEqual(
    fired.map((row) => row.storageRef),
    [kept.storageRef],
  );
  assert.ok(
    doc.previews?.some(
      (row) => keyOf(row) === (kept.storageRef as { key: string }).key,
    ),
  );
});

test('a store that holds the new row but leaves it out of its answer: a ref that row keeps is not reported', async () => {
  const w = world();
  contentAddressed(w);
  const pipeline: Pipeline = {};
  const r = new Resizer({
    config: webpConfig(80),
    logger: recordingLogger().logger,
    storage: w.storage,
    tasks: w.tasks,
    pipelines: { default: pipeline },
    media: fakeMedia({
      load: (id) => w.store.loadMedia(id),
      appendPreviews: (id, rows, dims) =>
        w.store.appendPreviews(id, rows, dims),
      replacePreviews: async (id, identities, rows) => ({
        ...(await w.store.replacePreviews(id, identities, rows)),
        stored: [],
      }),
    }),
  });
  const fired: Preview[] = [];
  r.hook('onPreviewReplaced', (row) => {
    fired.push(row);
  });
  const doc = await w.seed(r);
  const [old] = rowsOf(doc);
  pipeline.version = 'v2';

  const { created, replaced } = await r.generate({
    media: structuredClone(doc),
    sizes: cell,
    formats: ['webp'],
  });

  assert.deepEqual(created, []);
  assert.deepEqual(rowsOf(doc)[0].storageRef, old.storageRef);
  assert.notEqual(rowsOf(doc)[0].encodeSig, old.encodeSig);
  assert.deepEqual(fired, []);
  assert.equal(replaced, undefined);
});

test('generate() that goes on to throw has still reported what its write removed', async () => {
  const { w, doc, old } = await storedThenChanged();
  const r = replacingWith(
    w,
    async (id, identities, rows) => ({
      ...(await w.store.replacePreviews(id, identities, rows)),
      stored: [],
    }),
    {
      pipelines: {
        default: {
          variantSteps: [
            async (img) => {
              const { width } = await img.metadata();
              if (width === 30) {
                throw new Error('this size cannot be made');
              }
              return img;
            },
          ],
        },
      },
    },
  );
  const fired: Preview[] = [];
  r.hook('onPreviewReplaced', (row) => {
    fired.push(row);
  });

  await assert.rejects(
    r.generate({
      media: structuredClone(doc),
      sizes: [...cell, { width: 30, height: 30 }],
      formats: ['webp'],
    }),
    { name: 'ResizeGenerateError' },
  );

  assert.deepEqual(
    fired.map((row) => row.storageRef),
    [old.storageRef],
  );
});

for (const [name, row] of Object.entries({
  'a ref that cannot be read': {
    get storageRef(): never {
      throw new Error('a ref that cannot be read');
    },
  },
  'no row at all': null,
})) {
  test(`a removed row that is ${name}: the observer gets it, and the task keeps its result`, async () => {
    const { w, doc } = await storedThenChanged();
    const { logger, logs } = recordingLogger();
    const r = replacingWith(
      w,
      async (id, identities, rows) => {
        const result = await w.store.replacePreviews(id, identities, rows);
        return {
          ...result,
          removed: [...result.removed, row as unknown as Preview],
        };
      },
      { logger },
    );
    let calls = 0;
    r.hook('onPreviewReplaced', () => {
      calls += 1;
    });

    await w.read(r, doc);
    await w.work(r);

    assert.equal(calls, 2);
    assert.deepEqual(statuses(w), [['completed', 1]]);
    assert.deepEqual(logs.error, []);
  });
}

// No observer is protected against a tap that never settles: the worker's task timeout is the
// bound, the work is already stored, and the next delivery finds it fresh and fires nothing.
for (const hook of ['onPreviewGenerated', 'onPreviewReplaced'] as const) {
  test(`a ${hook} tap that never settles costs one task timeout, and the next delivery completes`, async () => {
    const w = world({ timing: { taskTimeoutMs: 500 } });
    const doc = await w.seed(w.resizer(webpConfig(80)));
    const [old] = rowsOf(doc);
    resetResizerForTests();
    const r = w.resizer(webpConfig(70));
    let calls = 0;
    r.hook(hook, () => {
      calls += 1;
      return new Promise<never>(() => {});
    });
    const failed: unknown[] = [];
    r.hook('onTaskFailed', (_task, err) => {
      failed.push((err as ResizeError).code);
    });

    await w.read(r, doc);
    await w.work(r);

    assert.equal(calls, 1);
    assert.deepEqual(failed, ['RESIZE_TASK_TIMEOUT']);
    assert.deepEqual(statuses(w), [['completed', 2]]);
    assert.notDeepEqual(rowsOf(doc)[0].storageRef, old.storageRef);
  });
}
