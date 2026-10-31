import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectedOrigin, isFreshRow, storedDims } from './freshness.ts';
import { previewOrigin } from './signatures.ts';
import type { Original, Preview } from './types.d.ts';

test('storedDims holds both stored dimensions only when both are numbers', () => {
  assert.deepEqual(
    storedDims({ storageRef: { key: 'o' }, width: 20, height: 10 }),
    { width: 20, height: 10 },
  );
  assert.equal(storedDims({ storageRef: { key: 'o' }, width: 20 }), undefined);
  assert.equal(storedDims({ storageRef: { key: 'o' }, height: 10 }), undefined);
  // A stored null counts as missing, as in the worker.
  assert.equal(
    storedDims({
      storageRef: { key: 'o' },
      width: null,
      height: null,
    } as unknown as Original),
    undefined,
  );
  assert.equal(storedDims(undefined), undefined);
});

test('expectedOrigin signs the original ref with its dimensions', () => {
  const signed = previewOrigin({ key: 'o' }, { width: 20, height: 10 });
  assert.equal(
    expectedOrigin({ storageRef: { key: 'o' }, width: 20, height: 10 }),
    signed,
  );
  assert.equal(
    expectedOrigin({ storageRef: { key: 'o' }, width: 20 }),
    undefined,
  );
  assert.equal(
    expectedOrigin({ storageRef: { key: 'o' }, height: 10 }),
    undefined,
  );
  assert.equal(
    expectedOrigin({
      storageRef: { key: 'o' },
      width: null,
      height: null,
    } as unknown as Original),
    undefined,
  );
  // The decoded size stands in for missing stored dimensions.
  assert.equal(
    expectedOrigin({ storageRef: { key: 'o' } }, { width: 20, height: 10 }),
    signed,
  );
  assert.equal(
    expectedOrigin({ storageRef: undefined, width: 20, height: 10 }),
    undefined,
  );
  assert.equal(
    expectedOrigin(
      { storageRef: undefined, width: 20, height: 10 },
      { width: 20, height: 10 },
    ),
    undefined,
  );
  assert.equal(expectedOrigin(undefined, { width: 20, height: 10 }), undefined);
});

test('isFreshRow', () => {
  const row = (fields: Partial<Preview>): Preview => ({
    storageRef: { key: 'p' },
    sizeKey: '10x10',
    format: 'jpeg',
    contentType: 'image/jpeg',
    ...fields,
  });
  const expect = { encodeSig: 'e', origin: 'o' };
  assert.equal(isFreshRow(row({ encodeSig: 'e', origin: 'o' }), expect), true);
  assert.equal(isFreshRow(row({ encodeSig: 'x', origin: 'o' }), expect), false);
  assert.equal(isFreshRow(row({ origin: 'o' }), expect), false);
  assert.equal(isFreshRow(row({ encodeSig: 'e' }), expect), false);
  assert.equal(isFreshRow(row({ encodeSig: 'e', origin: 'x' }), expect), false);
  // Without an expected origin no row is provably fresh, not even one without an origin.
  const unknownOrigin = { encodeSig: 'e', origin: undefined };
  for (const r of [
    row({ encodeSig: 'e', origin: 'o' }),
    row({ encodeSig: 'e' }),
    row({}),
  ]) {
    assert.equal(isFreshRow(r, unknownOrigin), false);
  }
});
