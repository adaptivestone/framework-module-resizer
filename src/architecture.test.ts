// Core files read nothing process-wide (getApp, getResizeConfig, getResizer, listResizers): each
// gets what it needs from its caller. Only the entry points (index.ts, worker.ts) and the
// framework adapter import resizer.ts (pinned in importGraph.test.ts). Core is every top-level
// src/ file except worker.ts (an entry point that looks Resizers up by name), registry.ts (the
// generic registry class; the process-wide instance lives in resizer.ts), index.ts (the main
// entry) and types.d.ts (types only).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { sourceFiles } from './testHelpers/imports.ts';

const CORE_FILES = sourceFiles().filter(
  (f) =>
    !f.includes('/') &&
    !['worker.ts', 'registry.ts', 'index.ts', 'types.d.ts'].includes(f),
);
const GLOBAL_LOOKUPS = new Set([
  'getApp',
  'getResizeConfig',
  'getResizer',
  'listResizers',
]);

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

test('the core list sees the services', () => {
  assert.ok(
    CORE_FILES.includes('processor.ts') && CORE_FILES.includes('resizer.ts'),
    'sanity check: the listing does see the top-level files',
  );
});

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
      `${file} must take what it needs from its caller; only entry points look up process-wide state`,
    );
  });
}

// Which stored rows count is one rule, kept in images.ts: callers use storedPreviews /
// storedIdentities. isUsablePreview is not exported; this text check is a second net should the
// export come back.
test('only images.ts decides which stored rows count', () => {
  const users = sourceFiles().filter(
    (f) =>
      f !== 'images.ts' &&
      readFileSync(new URL(`./${f}`, import.meta.url), 'utf8').includes(
        'isUsablePreview(',
      ),
  );
  assert.deepEqual(users, []);
});
