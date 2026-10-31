import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  type DocImport,
  docImports,
  exportKeys,
  fenceProblems,
  importProblems,
  packageEntries,
  parsedValueNames,
} from './exportNames.ts';

const entryOf = async (subpath: string) => {
  const entry = (await packageEntries()).find((e) => e.subpath === subpath);
  assert.ok(entry, `no entry for ${subpath}`);
  return entry;
};

test('the parsed value exports of every entry equal its runtime exports', async () => {
  for (const entry of await packageEntries()) {
    assert.deepEqual(
      [...parsedValueNames(entry.source)].sort(),
      [...entry.values].sort(),
      entry.subpath,
    );
  }
});

test('type exports come from export lists, own declarations and types.d.ts', async () => {
  const main = await entryOf('.');
  for (const name of [
    'MediaLike',
    'ResolveOpts',
    'TaskAddResult',
    'DecodeBox',
    'ResizerOptions',
    'MetricLabels',
    'RunWorkerOptions',
  ]) {
    assert.ok(main.types.has(name), name);
  }
  assert.deepEqual(
    [...(await entryOf('./drivers/s3.js')).types],
    ['S3StorageOptions'],
  );
  const taskModel = await entryOf('./framework/ResizeTaskModel.js');
  assert.equal(taskModel.hasDefault, true);
  assert.equal(taskModel.defaultName, 'ResizeTaskModel');
  assert.deepEqual([...taskModel.types], ['TResizeTask']);
  const config = await entryOf('./config/resize.js');
  assert.equal(config.hasDefault, true);
  assert.equal(config.defaultName, undefined);
  assert.deepEqual([...config.values].sort(), [
    'defaultCoordination',
    'defaultQueueOptions',
  ]);
  assert.equal((await packageEntries()).length, 8);
  assert.equal(exportKeys().length, 9);
  assert.ok(exportKeys().includes('./package.json'));
});

const PKG = '@adaptivestone/framework-module-resize';

// Each valid form on its own, in a ```ts fence, then the same Resizer import in plain prose.
const validLines = [
  `import { Resizer, type MediaLike } from '${PKG}';`,
  `import type { ResolveOpts } from "${PKG}";`,
  `import ResizeTaskModel from '${PKG}/framework/ResizeTaskModel.js';`,
  `import * as fs from '${PKG}/drivers/fs.js';`,
  `import '${PKG}/drivers/sqs.js';`,
  `import Def, { defaultCoordination } from '${PKG}/config/resize.js';`,
  `import {\n  FrameworkResizer,\n  defaultWorkerOptions as dwo,\n} from '${PKG}/framework.js';`,
  `import pkg from '${PKG}/package.json' with { type: 'json' };`,
  `import sharp from 'sharp';`,
];
const fixture = [
  '# Fixture',
  '',
  '```ts',
  ...validLines,
  '```',
  '',
  `Prose: import { Resizer } from '${PKG}'; is not in a fence.`,
  '',
].join('\n');

const shape = ({ text: _text, ...rest }: DocImport) => rest;

test('docImports reads every import form inside code fences', () => {
  assert.deepEqual(docImports(fixture).map(shape), [
    {
      subpath: '.',
      typeOnly: false,
      named: [
        { name: 'Resizer', type: false },
        { name: 'MediaLike', type: true },
      ],
      sideEffect: false,
    },
    {
      subpath: '.',
      typeOnly: true,
      named: [{ name: 'ResolveOpts', type: false }],
      sideEffect: false,
    },
    {
      subpath: './framework/ResizeTaskModel.js',
      typeOnly: false,
      defaultName: 'ResizeTaskModel',
      named: [],
      sideEffect: false,
    },
    {
      subpath: './drivers/fs.js',
      typeOnly: false,
      namespace: 'fs',
      named: [],
      sideEffect: false,
    },
    {
      subpath: './drivers/sqs.js',
      typeOnly: false,
      named: [],
      sideEffect: true,
    },
    {
      subpath: './config/resize.js',
      typeOnly: false,
      defaultName: 'Def',
      named: [{ name: 'defaultCoordination', type: false }],
      sideEffect: false,
    },
    {
      subpath: './framework.js',
      typeOnly: false,
      named: [
        { name: 'FrameworkResizer', type: false },
        { name: 'defaultWorkerOptions', type: false },
      ],
      sideEffect: false,
    },
    {
      subpath: './package.json',
      typeOnly: false,
      defaultName: 'pkg',
      named: [],
      sideEffect: false,
    },
  ]);
});

test('docImports reads ~~~ and indented fences, and the statement text', () => {
  const md = [
    '1. Step:',
    '',
    '   ~~~ts',
    `   import { runWorker } from '${PKG}';`,
    '   ~~~',
  ].join('\n');
  const found = docImports(md);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].named, [{ name: 'runWorker', type: false }]);
  assert.equal(found[0].text, `import { runWorker } from '${PKG}'`);
});

const fenced = (line: string) => ['```ts', line, '```'].join('\n');

test('importProblems accepts the valid fixture imports and flags each bad one', async () => {
  const entries = await packageEntries();
  const keys = exportKeys();
  assert.deepEqual(importProblems(docImports(fixture), entries, keys), []);
  const bad: [string, string][] = [
    [`import { NoSuchExport } from '${PKG}';`, 'NoSuchExport'],
    [`import LocalFsStorage from "${PKG}/drivers/fs.js";`, 'LocalFsStorage'],
    [`import * as gone from '${PKG}/drivers/gone.js';`, './drivers/gone.js'],
    [`import '${PKG}/missing.js';`, './missing.js'],
    [`import type { NotAType } from '${PKG}/framework.js';`, 'NotAType'],
    [`import { type MediaLike } from '${PKG}/drivers/s3.js';`, 'MediaLike'],
    [`import { name } from '${PKG}/package.json';`, 'name'],
    [
      `import {\n  FrameworkResizer,\n  NotThere,\n} from '${PKG}/framework.js';`,
      'NotThere',
    ],
  ];
  for (const [line, named] of bad) {
    const imports = docImports(fenced(line));
    assert.equal(imports.length, 1, line);
    const problems = importProblems(imports, entries, keys);
    assert.equal(problems.length, 1, `${line}\n${problems.join('\n')}`);
    assert.ok(problems[0].includes(`'${named}'`), problems[0]);
  }
});

test('a comment inside an import clause is skipped, quotes in it included', async () => {
  const md = fenced(
    [
      'import {',
      "  Resizer, // the host's resizer",
      '  runWorker, /* the worker */',
      '  NotThere,',
      `} from '${PKG}';`,
    ].join('\n'),
  );
  const imports = docImports(md);
  assert.equal(imports.length, 1);
  assert.deepEqual(imports[0].named, [
    { name: 'Resizer', type: false },
    { name: 'runWorker', type: false },
    { name: 'NotThere', type: false },
  ]);
  const problems = importProblems(
    imports,
    await packageEntries(),
    exportKeys(),
  );
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.ok(problems[0].includes("'NotThere'"), problems[0]);
});

test('every import statement on a line is read', () => {
  const md = fenced(
    `import { Resizer } from '${PKG}'; import { NotThere } from '${PKG}/framework.js';`,
  );
  assert.deepEqual(
    docImports(md).map((imp) => [imp.subpath, imp.named[0]?.name]),
    [
      ['.', 'Resizer'],
      ['./framework.js', 'NotThere'],
    ],
  );
});

test('`{ default as X }` names the default export', async () => {
  const entries = await packageEntries();
  const keys = exportKeys();
  const valid = docImports(
    fenced(`import { default as Defaults } from '${PKG}/config/resize.js';`),
  );
  assert.deepEqual(valid[0]?.named, [{ name: 'default', type: false }]);
  assert.deepEqual(importProblems(valid, entries, keys), []);
  const bad = importProblems(
    docImports(fenced(`import { default as Fs } from '${PKG}/drivers/fs.js';`)),
    entries,
    keys,
  );
  assert.equal(bad.length, 1, bad.join('\n'));
  assert.ok(bad[0].includes("'default'"), bad[0]);
});

test('an unclosed fence at the end of a file is read and reported, not dropped', () => {
  const md = [
    '# Doc',
    '',
    '```ts',
    `import { Resizer } from '${PKG}';`,
    '',
  ].join('\n');
  assert.equal(docImports(md).length, 1);
  assert.deepEqual(fenceProblems(md), [
    'the code fence opened on line 3 is never closed',
  ]);
  assert.deepEqual(fenceProblems(fixture), []);
});

// A doc edit must fail the guard, never hang `npm test`: the scan runs in linear time on an
// `import` followed by comment lines and no `from`.
test('`import` before many comment lines and a `;` is scanned quickly', {
  timeout: 2_000,
}, () => {
  const md = fenced(
    [
      'import',
      ...Array.from(
        { length: 10 },
        (_, i) => `// comment line ${i} without any quote character in it`,
      ),
      ';',
    ].join('\n'),
  );
  assert.deepEqual(docImports(md), []);
});

test('the word "import" in a comment does not swallow the next import', async () => {
  const md = fenced(
    [
      '// import the resizer first',
      `import Gone, { Resizer } from '${PKG}';`,
    ].join('\n'),
  );
  const imports = docImports(md);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].defaultName, 'Gone');
  const problems = importProblems(
    imports,
    await packageEntries(),
    exportKeys(),
  );
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.ok(problems[0].includes("'Gone'"), problems[0]);
});

// Each fenced line must yield one statement with one problem naming `named`.
const assertOneProblem = async (line: string, named: string) => {
  const imports = docImports(fenced(line));
  assert.equal(imports.length, 1, line);
  const problems = importProblems(
    imports,
    await packageEntries(),
    exportKeys(),
  );
  assert.equal(problems.length, 1, `${line}\n${problems.join('\n')}`);
  assert.ok(problems[0].includes(`'${named}'`), problems[0]);
};

test('an import with no space after the keyword is read, a comment there included', async () => {
  for (const line of [
    `import{ MissingExport }from '${PKG}/framework.js';`,
    `import/* API */{ MissingExport } from '${PKG}/framework.js';`,
    `import{MissingExport}from"${PKG}/framework.js";`,
    `import*as gone from'${PKG}/drivers/gone.js';`,
  ]) {
    await assertOneProblem(
      line,
      line.includes('gone') ? './drivers/gone.js' : 'MissingExport',
    );
  }
  assert.deepEqual(
    docImports(fenced(`import'${PKG}/drivers/sqs.js';`)).map(shape),
    [
      {
        subpath: './drivers/sqs.js',
        typeOnly: false,
        named: [],
        sideEffect: true,
      },
    ],
  );
});

test('`export … from` re-exports are read and checked like imports', async () => {
  const entries = await packageEntries();
  const keys = exportKeys();
  const valid = docImports(
    fenced(
      [
        `export { default } from '${PKG}/framework/ResizeTaskModel.js';`,
        `export { FrameworkResizer as Resizer } from '${PKG}/framework.js';`,
        `export type { MediaLike } from '${PKG}';`,
        `export * from '${PKG}/drivers/fs.js';`,
        `export * as s3 from '${PKG}/drivers/s3.js';`,
      ].join('\n'),
    ),
  );
  assert.deepEqual(valid.map(shape), [
    {
      subpath: './framework/ResizeTaskModel.js',
      typeOnly: false,
      named: [{ name: 'default', type: false }],
      sideEffect: false,
    },
    {
      subpath: './framework.js',
      typeOnly: false,
      named: [{ name: 'FrameworkResizer', type: false }],
      sideEffect: false,
    },
    {
      subpath: '.',
      typeOnly: true,
      named: [{ name: 'MediaLike', type: false }],
      sideEffect: false,
    },
    {
      subpath: './drivers/fs.js',
      typeOnly: false,
      named: [],
      sideEffect: false,
    },
    {
      subpath: './drivers/s3.js',
      typeOnly: false,
      namespace: 's3',
      named: [],
      sideEffect: false,
    },
  ]);
  assert.deepEqual(importProblems(valid, entries, keys), []);
  for (const [line, named] of [
    [`export { MissingExport } from '${PKG}/framework.js';`, 'MissingExport'],
    [`export{ MissingExport }from '${PKG}/framework.js';`, 'MissingExport'],
    [`export { default } from '${PKG}/drivers/fs.js';`, 'default'],
    [`export * from '${PKG}/drivers/gone.js';`, './drivers/gone.js'],
    [`export * as gone from '${PKG}/gone.js';`, './gone.js'],
  ]) {
    await assertOneProblem(line, named);
  }
});

test('a keyword that is part of a longer word, or names no module, is not a statement', () => {
  for (const line of [
    `imports from '${PKG}/gone.js';`,
    `importer { NotThere } from '${PKG}';`,
    `reimport { NotThere } from '${PKG}';`,
    `$import { NotThere } from '${PKG}';`,
    `loader.import { NotThere } from '${PKG}';`,
    `exports { NotThere } from '${PKG}';`,
    `export const name = '${PKG}/gone.js';`,
    `export default '${PKG}/gone.js';`,
    `export '${PKG}/gone.js';`,
    `const mod = await import('${PKG}/gone.js');`,
    `const url = import.meta.resolve('${PKG}/gone.js');`,
  ]) {
    assert.deepEqual(docImports(fenced(line)), [], line);
  }
});

test('a local `export` without a quote or `;` does not swallow the import after it', async () => {
  for (const head of [
    'export const x = {}',
    'export function f() {}',
    'export { X }',
    'export default {}',
  ]) {
    await assertOneProblem(
      `${head}\nimport { MissingExport } from '${PKG}';`,
      'MissingExport',
    );
  }
  const [imp] = docImports(
    fenced(`export { NotThere }\nimport { Resizer } from '${PKG}';`),
  );
  assert.deepEqual(imp?.named, [{ name: 'Resizer', type: false }]);
});

test('a keyword inside the braces of a clause does not start a statement', async () => {
  for (const line of [
    `import { import as I, MissingExport } from '${PKG}';`,
    `import { MissingExport, import as I } from '${PKG}';`,
  ]) {
    const imports = docImports(fenced(line));
    assert.equal(imports.length, 1, line);
    assert.deepEqual(
      imports[0].named.map((n) => n.name).sort(),
      ['MissingExport', 'import'],
      line,
    );
    const problems = importProblems(
      imports,
      await packageEntries(),
      exportKeys(),
    );
    assert.ok(
      problems.some((p) => p.includes("'MissingExport'")),
      problems.join('\n'),
    );
  }
});

test('a string import name (ES2022) is read and checked', async () => {
  await assertOneProblem(
    `import {"MissingExport" as X} from '${PKG}';`,
    'MissingExport',
  );
  await assertOneProblem(
    `import { Resizer, 'MissingExport' as X } from '${PKG}';`,
    'MissingExport',
  );
  const valid = docImports(
    fenced(`import { "Resizer" as R, 'import' as I } from '${PKG}';`),
  );
  assert.deepEqual(valid[0]?.named, [
    { name: 'Resizer', type: false },
    { name: 'import', type: false },
  ]);
});

// A doc edit must fail the guard, never hang `npm test`, and node:test cannot interrupt a
// synchronous scan: so the scan runs in a child process with a deadline. Each input is read in
// well under the budget only when the scan is linear in the fence length.
// The open braces never close, so that input is checked for its time only.
test('the scan is linear on a long statement without a specifier, a comment that never closes, or many open braces', () => {
  const url = new URL('./exportNames.ts', import.meta.url).href;
  const script = `import { docImports } from ${JSON.stringify(url)};
const spaces = ' '.repeat(100000);
const inputs = [
  ['semicolon', 'import' + spaces + ';', true],
  ['unterminated', 'import' + spaces, true],
  ['comments', '/* '.repeat(50000), true],
  ['braces', 'import ' + '{'.repeat(100000) + " from '${PKG}'", false],
];
const slow = [];
for (const [name, body, none] of inputs) {
  const start = performance.now();
  const found = docImports('\`\`\`ts\\n' + body + '\\n\`\`\`');
  const ms = performance.now() - start;
  if ((none && found.length !== 0) || ms > 200) slow.push(name + ': ' + found.length + ' imports in ' + ms.toFixed(0) + ' ms');
}
if (slow.length > 0) { console.error(slow.join('\\n')); process.exit(1); }`;
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    { timeout: 5_000, encoding: 'utf8' },
  );
  assert.equal(result.error, undefined, 'the scan was killed at its deadline');
  assert.equal(result.signal, null, 'the scan was killed at its deadline');
  assert.equal(result.status, 0, result.stderr);
});
