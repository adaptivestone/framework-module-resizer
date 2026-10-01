// Guard: the package's main entry runs without @adaptivestone/framework. Walk every runtime
// (value) import reachable from src/index.ts and fail if it reaches the framework, the framework
// adapter, the ResizeTask model or the CLI command.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url));

/** Runtime import specifiers of a module (type-only imports and specifiers are skipped). */
function valueImports(source: string): string[] {
  const specifiers: string[] = [];
  const re =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;'"]*?)\s+from\s+'([^']+)'/g;
  for (const match of source.matchAll(re)) {
    if (match[2]) {
      continue; // `import type …` / `export type …`
    }
    const clause = match[3].trim();
    const braced = clause.match(/^\{([\s\S]*)\}$/);
    if (braced) {
      const names = braced[1]
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      if (names.length > 0 && names.every((n) => n.startsWith('type '))) {
        continue; // every specifier is `type X`
      }
    }
    specifiers.push(match[4]);
  }
  // Side-effect imports: `import './x.ts';`
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+'([^']+)'/g)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

function walk(entry: string): {
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
    const source = readFileSync(resolve(SRC, file), 'utf8');
    for (const spec of valueImports(source)) {
      if (spec.startsWith('.')) {
        const next = resolve(dirname(resolve(SRC, file)), spec)
          .slice(SRC.length + 1)
          .replaceAll('\\', '/');
        queue.push({ file: next, chain: [...chain, next] });
      } else if (!bare.has(spec)) {
        bare.set(spec, [...chain, spec]);
      }
    }
  }
  return { files, bare };
}

test('the main entry reaches no framework code', () => {
  const { files, bare } = walk('index.ts');
  const isFramework = (spec: string) =>
    spec === '@adaptivestone/framework' ||
    spec.startsWith('@adaptivestone/framework/');
  const framework = [...bare.entries()].filter(([spec]) => isFramework(spec));
  assert.deepEqual(
    framework.map(([, chain]) => chain.join(' → ')),
    [],
    'main entry must not import @adaptivestone/framework',
  );
  const adapterFiles = [...files.entries()].filter(
    ([file]) =>
      file.startsWith('framework/') ||
      file === 'models/ResizeTask.ts' ||
      file.startsWith('commands/'),
  );
  assert.deepEqual(
    adapterFiles.map(([, chain]) => chain.join(' → ')),
    [],
    'main entry must not reach the framework adapter, ResizeTask model or CLI command',
  );
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
