import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type DocImport,
  docImports,
  exportKeys,
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
