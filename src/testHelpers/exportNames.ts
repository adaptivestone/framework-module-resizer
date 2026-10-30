// The package's export surface and the package imports of a markdown file, for the guards that
// keep README.md and AGENTS.md in step with the exports. Value names come from the runtime module;
// type names and the default export's declared name come from the entry's source (its export
// lists, its own `export interface|type`, and every type of a `export type * from` file). The
// value names are parsed too, so a test can check the parser against the runtime.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_NAME = '@adaptivestone/framework-module-resize';
const PKG_JSON = './package.json';

export interface EntryExports {
  subpath: string; // a code key of package.json "exports": '.', './framework.js', './drivers/mongo.js', …
  source: string; // the source it is built from, relative to src/: 'index.ts', 'framework/index.ts', …
  values: ReadonlySet<string>; // runtime export names, without 'default'
  types: ReadonlySet<string>; // type-only export names
  hasDefault: boolean;
  defaultName: string | undefined; // `export default class|function X` → 'X'; undefined for an expression
}

const exportsMap = (): Record<string, string> =>
  JSON.parse(readFileSync(resolve(SRC, '../package.json'), 'utf8')).exports;

/** Every key of the exports map, in map order, './package.json' included. */
export function exportKeys(): string[] {
  return Object.keys(exportsMap());
}

// The source text with block comments and `//` comments removed (a `//` right after `:` stays, so
// a URL in a string survives).
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const readSource = (source: string): string =>
  stripComments(readFileSync(resolve(SRC, source), 'utf8'));

const IDENT = /^[A-Za-z_$][\w$]*$/;

// `{ a, type B, c as d }` → [{ name: 'a' }, { name: 'B', type: true }, { name: 'd' }]: the name
// an export list exports (its alias when renamed).
const exportListNames = (list: string): { name: string; type: boolean }[] =>
  list
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => {
      const type = /^type\s+/.test(item);
      const bare = item.replace(/^type\s+/, '');
      const alias = /\s+as\s+([A-Za-z_$][\w$]*)$/.exec(bare);
      return { name: alias ? alias[1] : bare, type };
    });

const EXPORT_LIST = /\bexport\s+(type\s+)?\{([^}]*)\}/g;
const OWN_VALUE =
  /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|const|let|var|enum|function\*?)\s+([A-Za-z_$][\w$]*)/g;
const OWN_TYPE =
  /\bexport\s+(?:declare\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/g;
const TYPE_STAR = /\bexport\s+type\s+\*\s+from\s+'([^']+)'/g;
const DEFAULT_NAME =
  /\bexport\s+default\s+(?:abstract\s+)?(?:async\s+)?(?:class|function\*?)\s+([A-Za-z_$][\w$]*)/;

/** The value names the entry's source declares (export lists without `type`, `export class|const|function`, `default as X`). */
export function parsedValueNames(source: string): Set<string> {
  const text = readSource(source);
  const names = new Set<string>();
  for (const match of text.matchAll(EXPORT_LIST)) {
    if (match[1]) {
      continue;
    }
    for (const { name, type } of exportListNames(match[2])) {
      if (!type && name !== 'default') {
        names.add(name);
      }
    }
  }
  for (const match of text.matchAll(OWN_VALUE)) {
    names.add(match[1]);
  }
  return names;
}

// The type names the entry's source declares: `type` specifiers and `export type {…}` lists, its
// own `export interface|type X`, and every `export interface|type X` of a `export type * from`
// file (resolved against the source's folder).
function parsedTypeNames(source: string): Set<string> {
  const text = readSource(source);
  const names = new Set<string>();
  for (const match of text.matchAll(EXPORT_LIST)) {
    for (const { name, type } of exportListNames(match[2])) {
      if (match[1] || type) {
        names.add(name);
      }
    }
  }
  for (const match of text.matchAll(OWN_TYPE)) {
    names.add(match[1]);
  }
  for (const match of text.matchAll(TYPE_STAR)) {
    const file = resolve(dirname(resolve(SRC, source)), match[1]);
    const starred = stripComments(readFileSync(file, 'utf8'));
    for (const own of starred.matchAll(OWN_TYPE)) {
      names.add(own[1]);
    }
  }
  return names;
}

let entriesPromise: Promise<EntryExports[]> | undefined;

/** Every code entry (every key but './package.json'), in map order; `./dist/X.js` maps to `src/X.ts`. */
export function packageEntries(): Promise<EntryExports[]> {
  entriesPromise ??= Promise.all(
    Object.entries(exportsMap())
      .filter(([subpath]) => subpath !== PKG_JSON)
      .map(async ([subpath, target]): Promise<EntryExports> => {
        const source = target
          .replace(/^\.\/dist\//, '')
          .replace(/\.js$/, '.ts');
        const mod: Record<string, unknown> = await import(
          pathToFileURL(resolve(SRC, source)).href
        );
        const keys = Object.keys(mod);
        return {
          subpath,
          source,
          values: new Set(keys.filter((key) => key !== 'default')),
          types: parsedTypeNames(source),
          hasDefault: keys.includes('default'),
          defaultName: DEFAULT_NAME.exec(readSource(source))?.[1],
        };
      }),
  );
  return entriesPromise;
}

/** How the docs name a subpath: '.' → '@adaptivestone/framework-module-resize'; './drivers/fs.js' → '…/drivers/fs.js'. */
export function docName(subpath: string): string {
  return subpath === '.' ? PKG_NAME : `…${subpath.slice(1)}`;
}

export interface DocImport {
  subpath: string; // '.' or './…' after the package name
  typeOnly: boolean; // `import type …`
  defaultName?: string;
  namespace?: string; // `* as X`
  named: { name: string; type: boolean }[]; // `{ a, type B, c as d }` → a, B (type), c
  sideEffect: boolean; // `import '…'`
  text: string; // the statement, for messages
}

// The contents of every code fence (``` or ~~~, of three or more, indented too), one string each.
function fenceBodies(markdown: string): string[] {
  const bodies: string[] = [];
  let open: { marker: string; lines: string[] } | undefined;
  for (const line of markdown.split('\n')) {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (!open) {
      if (fence) {
        open = { marker: fence[1], lines: [] };
      }
    } else if (
      fence &&
      fence[1][0] === open.marker[0] &&
      fence[1].length >= open.marker.length &&
      line.trim() === fence[1]
    ) {
      bodies.push(open.lines.join('\n'));
      open = undefined;
    } else {
      open.lines.push(line);
    }
  }
  return bodies;
}

// One statement from `import` to the specifier's closing quote, at the start of a line; what
// follows the quote (`with { type: 'json' }`, `;`) is not read. The clause holds no quote and no
// semicolon, so a match cannot run from one statement into the next.
const IMPORT_STATEMENT =
  /(?:^|\n)[ \t]*import\s+(?:([^'";]*?)\s*\bfrom\s*)?(['"])([^'"\n]+)\2/g;

function parseClause(
  clause: string,
): Pick<DocImport, 'typeOnly' | 'defaultName' | 'namespace' | 'named'> {
  let rest = clause.trim();
  const typeOnly = /^type\s/.test(rest);
  if (typeOnly) {
    rest = rest.replace(/^type\s+/, '');
  }
  const named: DocImport['named'] = [];
  const braces = /\{([^}]*)\}/.exec(rest);
  if (braces) {
    for (const item of braces[1].split(',')) {
      const spec = item.trim();
      if (spec.length === 0) {
        continue;
      }
      const m =
        /^(type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+[A-Za-z_$][\w$]*)?$/.exec(
          spec,
        );
      named.push(
        m ? { name: m[2], type: !!m[1] } : { name: spec, type: false },
      );
    }
    rest = rest.replace(braces[0], '');
  }
  const result: ReturnType<typeof parseClause> = { typeOnly, named };
  for (const part of rest.split(',')) {
    const head = part.trim();
    const star = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(head);
    if (star) {
      result.namespace = star[1];
    } else if (IDENT.test(head)) {
      result.defaultName = head;
    }
  }
  return result;
}

/**
 * Every import of the package in the markdown's code fences (``` or ~~~, indented fences too):
 * single or double quotes; default, named, namespace and side-effect imports and their combinations;
 * `import type` and inline `type` specifiers; statements over several lines. Imports of other
 * packages and imports outside fences are ignored.
 */
export function docImports(markdown: string): DocImport[] {
  const imports: DocImport[] = [];
  for (const body of fenceBodies(markdown)) {
    for (const match of body.matchAll(IMPORT_STATEMENT)) {
      const [statement, clause, , specifier] = match;
      if (specifier !== PKG_NAME && !specifier.startsWith(`${PKG_NAME}/`)) {
        continue;
      }
      const subpath = `.${specifier.slice(PKG_NAME.length)}`;
      const text = statement.trim();
      if (clause === undefined) {
        imports.push({
          subpath,
          typeOnly: false,
          named: [],
          sideEffect: true,
          text,
        });
        continue;
      }
      const parsed = parseClause(clause);
      imports.push({
        subpath,
        typeOnly: parsed.typeOnly,
        ...(parsed.defaultName === undefined
          ? {}
          : { defaultName: parsed.defaultName }),
        ...(parsed.namespace === undefined
          ? {}
          : { namespace: parsed.namespace }),
        named: parsed.named,
        sideEffect: false,
        text,
      });
    }
  }
  return imports;
}

/** What is wrong with each import against the exports: an unknown subpath, a missing default, a name the entry does not export. */
export function importProblems(
  imports: DocImport[],
  entries: EntryExports[],
  keys: string[],
): string[] {
  const problems: string[] = [];
  for (const imp of imports) {
    const where = `${imp.text} (${docName(imp.subpath)})`;
    if (!keys.includes(imp.subpath)) {
      problems.push(
        `${where}: '${imp.subpath}' is not a key of the exports map`,
      );
      continue;
    }
    if (imp.subpath === PKG_JSON) {
      for (const { name } of imp.named) {
        problems.push(
          `${where}: '${name}' is a named import, and a JSON module has only a default export`,
        );
      }
      continue;
    }
    const entry = entries.find((e) => e.subpath === imp.subpath);
    if (!entry) {
      problems.push(`${where}: '${imp.subpath}' has no code entry`);
      continue;
    }
    if (imp.defaultName !== undefined && !entry.hasDefault) {
      problems.push(
        `${where}: '${imp.defaultName}' is a default import, and the entry has no default export`,
      );
    }
    for (const { name, type } of imp.named) {
      const isType = imp.typeOnly || type;
      const known = isType
        ? entry.values.has(name) || entry.types.has(name)
        : entry.values.has(name);
      if (!known) {
        problems.push(
          `${where}: '${name}' is not ${isType ? 'an' : 'a value'} export of the entry`,
        );
      }
    }
  }
  return problems;
}
