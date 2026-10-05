// The in-memory database follows the database contract tests rely on: one stored preview row per
// preview identity, resolving with the previews it stored.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Preview } from '../types.d.ts';
import { fakeDb } from './fakes.ts';

const preview = (identity: string | undefined, path: string): Preview =>
  ({
    storageRef: { path },
    ...(identity === undefined ? {} : { identity }),
    sizeKey: '16x16',
    format: 'webp',
  }) as Preview;

test('fakeDb keeps one preview per identity and resolves with the stored ones', async () => {
  const previews = new Map<string, Preview[]>();
  const db = fakeDb({ previews });
  const a = preview('a', 'a1');
  const b = preview('b', 'b1');

  assert.deepEqual(await db.appendPreviews('m1', [a, b, preview('a', 'a2')]), [
    a,
    b,
  ]);
  assert.deepEqual(await db.appendPreviews('m1', [preview('a', 'a3')]), []);
  // Identities are per media.
  assert.deepEqual(await db.appendPreviews('m2', [a]), [a]);
  // A preview without an identity is always stored.
  const plain = preview(undefined, 'plain');
  assert.deepEqual(await db.appendPreviews('m1', [plain, plain]), [
    plain,
    plain,
  ]);
  assert.deepEqual(previews.get('m1'), [a, b, plain, plain]);
  assert.deepEqual(previews.get('m2'), [a]);
});

test('fakeDb treats seeded previews as already stored', async () => {
  const seeded = preview('a', 'other-worker');
  const db = fakeDb({ previews: new Map([['m1', [seeded]]]) });
  assert.deepEqual(await db.appendPreviews('m1', [preview('a', 'late')]), []);
});
