// Core modules receive their Resizer as an argument. Only entry points (the Resizer's
// constructor defaults, worker.ts) and framework drivers may import process-wide lookups.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const CORE_FILES = [
  'engine.ts',
  'enqueue.ts',
  'formatPictureUrls.ts',
  'images.ts',
  'original.ts',
  'resizeTask.ts',
];
const GLOBAL_LOOKUPS = new Set(['getApp', 'getResizeConfig', 'getResizer']);

/** Names imported as runtime values (`import type` and `type X` specifiers are erased). */
function valueImports(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(
    /import\s+(type\s+)?\{([^}]*)\}\s+from\s+'[^']+'/g,
  )) {
    if (match[1]) {
      continue;
    }
    for (const part of match[2].split(',')) {
      const specifier = part.trim();
      if (specifier && !specifier.startsWith('type ')) {
        names.push(specifier.split(/\s+as\s+/)[0]);
      }
    }
  }
  return names;
}

for (const file of CORE_FILES) {
  test(`${file} imports no process-wide lookup`, async () => {
    const source = await readFile(
      new URL(`./${file}`, import.meta.url),
      'utf8',
    );
    const found = valueImports(source).filter((name) =>
      GLOBAL_LOOKUPS.has(name),
    );
    assert.deepEqual(
      found,
      [],
      `${file} must read its context from the Resizer argument`,
    );
  });
}
