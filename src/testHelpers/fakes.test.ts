// The in-memory stores follow the contracts tests rely on: the media store keeps one stored preview
// row per preview identity and resolves with the previews it stored; the locks honour owners.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Preview } from '../types.d.ts';
import { fakeMedia, memoryLocks } from './fakes.ts';

const preview = (identity: string | undefined, path: string): Preview =>
  ({
    storageRef: { path },
    ...(identity === undefined ? {} : { identity }),
    sizeKey: '16x16',
    format: 'webp',
  }) as Preview;

test('memoryLocks honours owners', async () => {
  const locks = memoryLocks();
  assert.equal(await locks.acquire('k', 'A', 1), true);
  assert.equal(await locks.acquire('k', 'B', 1), false);
  assert.equal(await locks.release('k', 'B'), false);
  assert.equal(await locks.extend('k', 'B', 1), false);
  assert.equal(await locks.extend('k', 'A', 1), true);
  assert.equal(await locks.release('k', 'A'), true);
  assert.equal(await locks.acquire('k', 'B', 1), true);
});

test('fakeMedia keeps one row per identity and resolves with the stored rows', async () => {
  const previews = new Map<string, Preview[]>();
  const media = fakeMedia({ previews });
  const a = preview('a', 'a1');
  const b = preview('b', 'b1');

  assert.deepEqual(
    await media.appendPreviews('m1', [a, b, preview('a', 'a2')]),
    [a, b],
  );
  assert.deepEqual(await media.appendPreviews('m1', [preview('a', 'a3')]), []);
  // Identities are per media.
  assert.deepEqual(await media.appendPreviews('m2', [a]), [a]);
  // A preview without an identity is always stored.
  const plain = preview(undefined, 'plain');
  assert.deepEqual(await media.appendPreviews('m1', [plain, plain]), [
    plain,
    plain,
  ]);
  assert.deepEqual(previews.get('m1'), [a, b, plain, plain]);
  assert.deepEqual(previews.get('m2'), [a]);
});

test('fakeMedia treats seeded previews as already stored', async () => {
  const seeded = preview('a', 'other-worker');
  const media = fakeMedia({ previews: new Map([['m1', [seeded]]]) });
  assert.deepEqual(
    await media.appendPreviews('m1', [preview('a', 'late')]),
    [],
  );
});
