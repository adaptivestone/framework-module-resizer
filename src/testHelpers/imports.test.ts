import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importSpecifiers, localImports } from './imports.ts';

const source = [
  "import type { A } from './a.ts';",
  "import { type B } from './b.ts';",
  "import { c } from 'pkg';",
  "export type { D } from './d.ts';",
  "export { type E } from './e.ts';",
  "import './f.ts';",
].join('\n');

test('without types, only whole `import type` / `export type` statements are skipped', () => {
  // `import { type B }` stays as `import {} from './b.ts'` under verbatimModuleSyntax: b.ts loads.
  assert.deepEqual(importSpecifiers(source, { types: false }), [
    './b.ts',
    'pkg',
    './e.ts',
    './f.ts',
  ]);
});

test('with types, every statement counts', () => {
  assert.deepEqual(importSpecifiers(source, { types: true }), [
    './a.ts',
    './b.ts',
    'pkg',
    './d.ts',
    './e.ts',
    './f.ts',
  ]);
});

test('localImports resolves relative specifiers against src/ and leaves packages out', () => {
  // This file imports node builtins and ./imports.ts; the fixture lines above are strings.
  assert.deepEqual(
    localImports('testHelpers/imports.test.ts', { types: true }),
    ['testHelpers/imports.ts'],
  );
});
