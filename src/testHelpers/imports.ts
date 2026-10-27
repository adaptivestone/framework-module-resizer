// Source-file and import listings for the guard tests that check who may import what. Paths are
// relative to src/ and '/'-separated on every platform. The parser sees static, single-quoted
// `import … from` / `export … from` statements and side-effect imports. `import('…')` specifiers
// (type positions such as `import('./x.ts').X`, and dynamic imports) are collected only in
// `types: true` mode; `types: false` leaves them out, so the runtime walks follow static imports
// only. That pattern is matched anywhere in the text, comments and strings included.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const toSrcPath = (path: string): string => path.split(sep).join('/');

/** Every non-test .ts file under src/ (test helpers excluded), sorted. */
export function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .map(toSrcPath)
    .filter(
      (file) =>
        file.endsWith('.ts') &&
        !file.endsWith('.test.ts') &&
        !file.startsWith('testHelpers/'),
    )
    .sort();
}

/**
 * The import/export specifiers of `source`, packages included. `types: false` skips whole
 * `import type` / `export type` statements, the only ones erased at runtime: under
 * verbatimModuleSyntax `import { type X } from './x.ts'` stays as `import {} from './x.ts'`, so
 * x.ts still loads. Side-effect imports always count. `types: true` also collects `import('…')`
 * specifiers, after the statements.
 */
export function importSpecifiers(
  source: string,
  opts: { types: boolean },
): string[] {
  const specifiers: string[] = [];
  const re =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?[^;'"]*?\s+from\s+'([^']+)'/g;
  for (const match of source.matchAll(re)) {
    if (!opts.types && match[2]) {
      continue;
    }
    specifiers.push(match[3]);
  }
  // Side-effect imports: `import './x.ts';`
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+'([^']+)'/g)) {
    specifiers.push(match[1]);
  }
  // `import('./x.ts')`: a type position such as `import('./x.ts').X`, or a dynamic import.
  if (opts.types) {
    for (const match of source.matchAll(/import\(\s*'([^']+)'\s*\)/g)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/** The src/ files that `file`'s relative specifiers point at (see importSpecifiers). */
export function localImports(file: string, opts: { types: boolean }): string[] {
  const source = readFileSync(resolve(SRC, file), 'utf8');
  return importSpecifiers(source, opts)
    .filter((spec) => spec.startsWith('.'))
    .map((spec) =>
      toSrcPath(relative(SRC, resolve(dirname(resolve(SRC, file)), spec))),
    );
}
