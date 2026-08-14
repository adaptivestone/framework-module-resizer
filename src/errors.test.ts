import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ResizeGenerateError, ResizeNoOriginalError } from './errors.ts';

describe('ResizeNoOriginalError', () => {
  test('is instanceof Error with a stable name and the media id', () => {
    const err = new ResizeNoOriginalError('m1');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof ResizeNoOriginalError);
    assert.equal(err.name, 'ResizeNoOriginalError');
    assert.equal(err.mediaId, 'm1');
    assert.match(err.message, /m1/);
    assert.match(err.message, /no original/);
  });
});

describe('ResizeGenerateError', () => {
  test('is instanceof Error and carries failed/requested counts', () => {
    const err = new ResizeGenerateError({
      mediaId: 'm2',
      failed: 3,
      requested: 3,
    });
    assert.ok(err instanceof ResizeGenerateError);
    assert.equal(err.name, 'ResizeGenerateError');
    assert.equal(err.mediaId, 'm2');
    assert.equal(err.failed, 3);
    assert.equal(err.requested, 3);
    assert.match(err.message, /0 previews/);
    assert.match(err.message, /3/);
  });
});
