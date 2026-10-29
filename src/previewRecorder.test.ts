// The persist step of a render: one appendPreviews, then the reconciliation of what the media
// store kept against what was generated (rows another worker stored first, a media that is gone,
// rows a store left out, a failed write).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Catalog } from './catalog.ts';
import { getPreviewIdentity } from './images.ts';
import { PreviewRecorder } from './previewRecorder.ts';
import { fakeMedia } from './testHelpers/fakes.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import type { Preview, PreviewScope, ResizeLogger } from './types.d.ts';

const scope: PreviewScope = { resizer: 'default', pipeline: 'default' };

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
    load: async (mediaId) => ({ previews: rows.get(mediaId) ?? [] }),
    // The store resolves with its own copies of the rows it stored (a driver's documents).
    appendPreviews: async (mediaId, previews, dims) =>
      (await base.appendPreviews(mediaId, previews, dims)).map((row) => ({
        ...row,
      })),
  });
  const { logger, logs } = recordingLogger();
  const recorder = new PreviewRecorder({
    catalog: new Catalog({ config: makeImageConfig() }),
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
  await assert.rejects(
    () => recorder.record('m1', scope, [preview('40x40', 'mine.jpg')]),
    (err: unknown) =>
      (err as { code?: string }).code === 'RESIZE_MEDIA_APPEND_RESULT_INVALID',
  );
  // The caller reports the rejection; the recorder itself logs nothing for it.
  assert.deepEqual(logs, { info: [], warn: [], error: [] });
});
