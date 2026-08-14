import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import {
  resizeMediaPaths,
  resizeMediaSchemaFragment,
} from './mediaFragment.ts';

// mongoose is a devDep here (the no-mongoose rule is for runtime module code — 01 · §16);
// building a real Schema from the spread fragment is the point of the smoke test.

describe('resizeMediaPaths', () => {
  test('lists the module fields resolve/generate read', () => {
    assert.deepEqual(resizeMediaPaths, ['original', 'previews']);
  });
});

describe('resizeMediaSchemaFragment — shape', () => {
  test('exposes `original` + `previews` keys', () => {
    assert.ok('original' in resizeMediaSchemaFragment);
    assert.ok('previews' in resizeMediaSchemaFragment);
  });

  test('original carries the documented Original leaf fields', () => {
    const o = resizeMediaSchemaFragment.original;
    for (const k of [
      'key',
      'bucket',
      'format',
      'size',
      'contentType',
      'width',
      'height',
    ]) {
      assert.ok(k in o, `missing original.${k}`);
    }
  });

  test('previews[0] carries the full Preview leaf fields', () => {
    const p = resizeMediaSchemaFragment.previews[0];
    for (const k of [
      'key',
      'bucket',
      'sizeKey',
      'filters',
      'requestedWidth',
      'requestedHeight',
      'actualWidth',
      'actualHeight',
      'format',
      'contentType',
      'fit',
    ]) {
      assert.ok(k in p, `missing previews.${k}`);
    }
  });

  test('leaf types are the expected global constructors / string alias', () => {
    assert.equal(resizeMediaSchemaFragment.original.key.type, String);
    assert.equal(resizeMediaSchemaFragment.original.width.type, Number);
    assert.equal(resizeMediaSchemaFragment.previews[0].fit.type, Boolean);
    // Mixed via the string alias (no mongoose import in the fragment source).
    assert.equal(resizeMediaSchemaFragment.previews[0].filters.type, 'Mixed');
  });
});

describe('resizeMediaSchemaFragment — host usage', () => {
  test('spreads into a plain object without error', () => {
    const merged = { existing: { type: String }, ...resizeMediaSchemaFragment };
    assert.ok(merged.original);
    assert.ok(merged.previews);
    assert.ok(merged.existing);
  });

  test('compiles as a mongoose.Schema when spread into modelSchema', () => {
    const schema = new mongoose.Schema({ ...resizeMediaSchemaFragment });
    // `previews` is a real subdocument-array path; nested `original` is addressed by leaf.
    assert.ok(schema.path('previews'));
    assert.ok(schema.path('original.width'));
    assert.ok(schema.path('original.key'));
  });
});

describe('resizeMediaSchemaFragment — §15/§16 no-import invariant', () => {
  test('the fragment source is import-free (no mongoose, no framework)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./mediaFragment.ts', import.meta.url)),
      'utf8',
    );
    assert.doesNotMatch(src, /\bfrom ['"]mongoose['"]/);
    // A plain POJO with zero real import statements (the `import …` in the usage note
    // is a `//`-prefixed comment line, so it never begins a line).
    assert.doesNotMatch(src, /^import\b/m);
  });
});
