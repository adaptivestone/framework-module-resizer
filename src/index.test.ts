import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as api from './index.ts';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

// Every VALUE export the main entry is contractually required to expose (02 · §6, reconciled
// with the real file layout). Kept as an explicit, sorted list so an ACCIDENTAL new value export
// (or a dropped one) fails THIS test rather than silently growing the public surface. Type-only
// re-exports (contract interfaces, TResizeTask, types.d.ts) are erased and never appear here.
const EXPECTED_VALUE_EXPORTS = [
  'Resizer',
  'ResizeGenerateError',
  'ResizeNoOriginalError',
  'ResizeTaskModel',
  'ResizeWorker',
  'calculateResizedDimensions',
  'defaultResizeConfig',
  'formatPictureUrls',
  'getFilterSig',
  'getImageContentType',
  'getPreviewIdentity',
  'getResizeConfig',
  'getResizer',
  'getSizeKey',
  'isCatalogCovered',
  'parseSizeKey',
  'processTask',
  'requiredFormats',
  'resetResizerForTests',
  'resizeMediaPaths',
  'resizeMediaSchemaFragment',
  'runResizeWorker',
];

// Drivers are SUBPATH-ONLY (the uniform rule 02 · §6) — they must NEVER appear on the main entry.
const DRIVER_NAMES = [
  'MongoTransport',
  'SqsTransport',
  'S3Storage',
  'LocalFsStorage',
  'FrameworkMediaStore',
  'FrameworkLockProvider',
];

const asRecord = api as unknown as Record<string, unknown>;

describe('public API surface (src/index.ts)', () => {
  test('exposes EXACTLY the expected value exports — no accidental growth/shrink', () => {
    assert.deepEqual(
      Object.keys(api).sort(),
      [...EXPECTED_VALUE_EXPORTS].sort(),
    );
  });

  test('the classes are constructors (function with a prototype)', () => {
    for (const name of ['Resizer', 'ResizeWorker', 'ResizeTaskModel']) {
      const v = asRecord[name];
      assert.equal(typeof v, 'function', `${name} should be a class/function`);
      assert.ok(
        (v as { prototype?: unknown }).prototype,
        `${name} should have a prototype`,
      );
    }
  });

  test('the helper + config accessors are functions', () => {
    for (const name of [
      'getResizer',
      'resetResizerForTests',
      'runResizeWorker',
      'processTask',
      'getSizeKey',
      'parseSizeKey',
      'getFilterSig',
      'getPreviewIdentity',
      'calculateResizedDimensions',
      'getImageContentType',
      'getResizeConfig',
      'requiredFormats',
      'formatPictureUrls',
      'isCatalogCovered',
    ]) {
      assert.equal(
        typeof asRecord[name],
        'function',
        `${name} should be a function`,
      );
    }
  });

  test('the config default + schema fragment are plain objects (real values)', () => {
    assert.equal(typeof api.defaultResizeConfig, 'object');
    assert.equal(api.defaultResizeConfig.formats[0], 'jpeg'); // it's the actual default, not a stub
    assert.equal(typeof api.resizeMediaSchemaFragment, 'object');
    assert.deepEqual(api.resizeMediaPaths, ['original', 'previews']);
  });

  test('a pure helper actually works through the re-export', () => {
    assert.equal(api.getSizeKey({ width: 320, height: 200 }), '320x200');
    assert.equal(api.getSizeKey({ fit: true }), 'fit');
    assert.equal(api.getPreviewIdentity('fit', 'webp'), 'fit:webp:none');
  });

  test('NO driver value exports leak onto the main entry (subpath-only rule)', () => {
    for (const name of DRIVER_NAMES) {
      assert.equal(
        name in api,
        false,
        `${name} must NOT be exported from the main entry`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Import-time isolation. The `import * as api` + Object.keys above already proved the main
// entry loads with NO app installed and does not throw or construct a Resizer. Here we prove
// the resolved module graph never REACHES the optional-peer AWS drivers — a source-level walk
// of index.ts's relative import/export graph (test-local, ~25 lines).
// ---------------------------------------------------------------------------

// Collect every source file reachable from `entry` via static relative `from '…'` specifiers
// (import AND export re-exports; type-only ones included — harmless). Specifiers already carry
// the .ts extension in this codebase, so resolution is a plain path.resolve (no ext guessing).
function reachableGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    if (!file || seen.has(file)) {
      continue;
    }
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/from\s*['"](\.[^'"]+)['"]/g)) {
      stack.push(resolve(dirname(file), m[1]));
    }
  }
  return seen;
}

describe('import-time isolation (no optional AWS SDK in the main-entry graph)', () => {
  const graph = reachableGraph(resolve(SRC_DIR, 'index.ts'));

  test('the graph excludes the AWS-SDK driver modules (transports/sqs, storage/s3)', () => {
    const rels = [...graph].map((f) => relative(SRC_DIR, f));
    assert.ok(
      !rels.includes('transports/sqs.ts'),
      'transports/sqs.ts must not be reachable from the main entry',
    );
    assert.ok(
      !rels.includes('storage/s3.ts'),
      'storage/s3.ts must not be reachable from the main entry',
    );
  });

  test('no file in the graph imports @aws-sdk/* or sqs-consumer', () => {
    for (const file of graph) {
      const src = readFileSync(file, 'utf8');
      const m = /from\s*['"](@aws-sdk\/[^'"]+|sqs-consumer)['"]/.exec(src);
      assert.equal(
        m,
        null,
        `${relative(SRC_DIR, file)} statically imports ${m?.[1]} — must stay driver-subpath-only`,
      );
    }
  });
});
