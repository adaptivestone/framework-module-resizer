// Guards on the import graph:
// - the package's main entry runs without @adaptivestone/framework: walk every runtime import
//   reachable from src/index.ts and fail if it reaches the framework, the framework adapter, the
//   ResizeTask model or the CLI command;
// - drivers import only contracts, errors, helpers, types and other drivers, never core code;
// - resizer.ts is the composition root: only the entry points (index.ts, worker.ts) and the
//   framework adapter import it, and nothing it reaches imports it back, not even as a type.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  importSpecifiers,
  localImports,
  sourceFiles,
} from './testHelpers/imports.ts';

const SRC = dirname(fileURLToPath(import.meta.url));

/**
 * Every src/ file and package that `entry` reaches, each with the chain of files that first
 * reached it. By default only runtime imports are followed (whole `import type` / `export type`
 * statements are skipped); `types: true` follows those too.
 */
function walk(
  entry: string,
  opts: { types: boolean } = { types: false },
): {
  files: Map<string, string[]>;
  bare: Map<string, string[]>;
} {
  const files = new Map<string, string[]>(); // file → chain that reached it
  const bare = new Map<string, string[]>(); // package specifier → chain
  const queue: { file: string; chain: string[] }[] = [
    { file: entry, chain: [entry] },
  ];
  while (queue.length > 0) {
    const { file, chain } = queue.shift() as { file: string; chain: string[] };
    if (files.has(file)) {
      continue;
    }
    files.set(file, chain);
    for (const next of localImports(file, opts)) {
      queue.push({ file: next, chain: [...chain, next] });
    }
    const source = readFileSync(resolve(SRC, file), 'utf8');
    for (const spec of importSpecifiers(source, opts)) {
      if (!spec.startsWith('.') && !bare.has(spec)) {
        bare.set(spec, [...chain, spec]);
      }
    }
  }
  return { files, bare };
}

test('the main entry reaches no framework code', () => {
  const { files, bare } = walk('index.ts');
  const isFramework = (spec: string) =>
    spec === 'mongoose' ||
    spec === '@adaptivestone/framework' ||
    spec.startsWith('@adaptivestone/framework/');
  const framework = [...bare.entries()].filter(([spec]) => isFramework(spec));
  assert.deepEqual(
    framework.map(([, chain]) => chain.join(' → ')),
    [],
    'main entry must not import @adaptivestone/framework or mongoose',
  );
  const adapterFiles = [...files.entries()].filter(([file]) =>
    file.startsWith('framework/'),
  );
  assert.deepEqual(
    adapterFiles.map(([, chain]) => chain.join(' → ')),
    [],
    'main entry must not reach the framework adapter',
  );
});

for (const entry of [
  'drivers/fs.ts',
  'drivers/s3.ts',
  'drivers/sqs.ts',
  'drivers/mongo/index.ts',
]) {
  test(`${entry} reaches no framework code and no mongoose at runtime`, () => {
    const { files, bare } = walk(entry);
    const banned = [...bare.entries()].filter(
      ([spec]) =>
        spec === 'mongoose' ||
        spec === '@adaptivestone/framework' ||
        spec.startsWith('@adaptivestone/framework/'),
    );
    assert.deepEqual(
      banned.map(([, chain]) => chain.join(' → ')),
      [],
      'drivers must run without the framework and import mongoose only as types',
    );
    const adapter = [...files.keys()].filter((file) =>
      file.startsWith('framework/'),
    );
    assert.deepEqual(
      adapter,
      [],
      'drivers must not reach the framework adapter',
    );
  });
}

test('drivers import only contracts, errors, helpers, types and other drivers', () => {
  const allowed = (t: string) =>
    t.startsWith('contracts/') ||
    t === 'errors.ts' ||
    t.startsWith('helpers/') ||
    t === 'types.d.ts' ||
    t.startsWith('drivers/');
  const drivers = sourceFiles().filter((f) => f.startsWith('drivers/'));
  assert.ok(
    drivers.includes('drivers/sqs.ts'),
    'sanity check: the listing does see the drivers',
  );
  const offending = drivers.flatMap((f) =>
    localImports(f, { types: true })
      .filter((t) => !allowed(t))
      .map((t) => `${f} → ${t}`),
  );
  assert.deepEqual(offending, []);
});

test('the framework adapter is reachable from its own entry', () => {
  const { bare } = walk('framework/index.ts');
  assert.ok(
    [...bare.keys()].some((spec) =>
      spec.startsWith('@adaptivestone/framework/'),
    ),
    'sanity check: the walker does see framework imports',
  );
});

test('only index.ts, worker.ts and the framework adapter import resizer.ts', () => {
  const allowed = (f: string) =>
    ['index.ts', 'worker.ts'].includes(f) || f.startsWith('framework/');
  assert.deepEqual(
    sourceFiles().filter(
      (f) =>
        !allowed(f) && localImports(f, { types: true }).includes('resizer.ts'),
    ),
    [],
  );
});

test('nothing resizer.ts reaches imports it back, not even as a type', () => {
  const back = [...walk('resizer.ts', { types: true }).files.keys()].filter(
    (f) =>
      f !== 'resizer.ts' &&
      localImports(f, { types: true }).includes('resizer.ts'),
  );
  assert.deepEqual(back, []);
});

test('the Dispatcher and its test need no Resizer, framework, storage or media port', () => {
  assert.deepEqual(
    [...walk('dispatcher.test.ts', { types: true }).files.keys()].filter(
      (f) => f === 'resizer.ts' || f.startsWith('framework/'),
    ),
    [],
  );
  assert.deepEqual(
    localImports('dispatcher.ts', { types: true }).filter(
      (t) => t === 'contracts/storage.ts' || t === 'contracts/media.ts',
    ),
    [],
  );
});
