import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importSpecifiers, localImports, resolveLocal } from './imports.ts';

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

// Built from pieces so this file's own text holds no `import('…')` for localImports below to see.
const importTypeSource = [
  ['export type G = import(', "'./g.ts'", ').G;'].join(''),
  "import type { A } from './a.ts';",
].join('\n');

test('an `import()` type counts only with types, after the statements', () => {
  assert.deepEqual(importSpecifiers(importTypeSource, { types: false }), []);
  assert.deepEqual(importSpecifiers(importTypeSource, { types: true }), [
    './a.ts',
    './g.ts',
  ]);
});

test('a `.js` specifier names its `.ts` source (or its `.d.ts`), so it cannot slip past a rule', () => {
  assert.deepEqual(
    importSpecifiers("import { Resizer } from './resizer.js';", {
      types: false,
    }),
    ['./resizer.js'],
  );
  assert.equal(resolveLocal('worker.ts', './resizer.js'), 'resizer.ts');
  assert.equal(resolveLocal('worker.ts', './resizer.ts'), 'resizer.ts');
  assert.equal(resolveLocal('framework/app.ts', '../index.js'), 'index.ts');
  assert.equal(resolveLocal('helpers/log.ts', '../types.js'), 'types.d.ts');
  assert.equal(resolveLocal('helpers/log.ts', '../types.d.ts'), 'types.d.ts');
});

test('localImports resolves relative specifiers against src/ and leaves packages out', () => {
  // This file imports node builtins and ./imports.ts; the fixture lines above are strings.
  assert.deepEqual(
    localImports('testHelpers/imports.test.ts', { types: true }),
    ['testHelpers/imports.ts'],
  );
});
