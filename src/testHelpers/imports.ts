// Source-file and import listings for the guard tests that check who may import what. Paths are
// relative to src/ and '/'-separated on every platform.
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
 * The files that `file`'s relative import/export specifiers point at. `types: false` skips
 * `import type` / `export type` statements and braces that name only `type X` specifiers, since
 * those are erased at runtime; side-effect imports always count. Package specifiers are left out.
 */
export function localImports(file: string, opts: { types: boolean }): string[] {
  const source = readFileSync(resolve(SRC, file), 'utf8');
  const specifiers: string[] = [];
  const re =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;'"]*?)\s+from\s+'([^']+)'/g;
  for (const match of source.matchAll(re)) {
    if (!opts.types && (match[2] || onlyTypes(match[3]))) {
      continue;
    }
    specifiers.push(match[4]);
  }
  // Side-effect imports: `import './x.ts';`
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+'([^']+)'/g)) {
    specifiers.push(match[1]);
  }
  return specifiers
    .filter((spec) => spec.startsWith('.'))
    .map((spec) =>
      toSrcPath(relative(SRC, resolve(dirname(resolve(SRC, file)), spec))),
    );
}

// `{ type A, type B }`: every named specifier is a type.
function onlyTypes(clause: string): boolean {
  const braced = clause.trim().match(/^\{([\s\S]*)\}$/);
  if (!braced) {
    return false;
  }
  const names = braced[1]
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return names.length > 0 && names.every((name) => name.startsWith('type '));
}
