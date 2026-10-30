// README.md is the reference for the export surface, so its "Package exports" section is checked
// both ways against the exports. In README.md and AGENTS.md, every package import in a code fence
// and every subpath the text names (quoted or in backticks) must exist, and every fence must
// close. The README's list of the codes that dead-letter a task at once is checked against the
// code.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  docImports,
  docName,
  type EntryExports,
  exportKeys,
  fenceProblems,
  importProblems,
  packageEntries,
} from './testHelpers/exportNames.ts';

const read = (file: string): string =>
  readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

const DOCS = ['README.md', 'AGENTS.md'];

// The README text from `## Package exports` to the next `## ` heading.
const exportsSection = (): string => {
  const readme = read('README.md');
  const start = readme.indexOf('## Package exports');
  assert.ok(start >= 0, 'README.md has no "## Package exports" section');
  const end = readme.indexOf('\n## ', start);
  return readme.slice(start, end < 0 ? undefined : end);
};

const isRow = (line: string): boolean => line.startsWith('| `');

// The first cell of a table row, without its backticks: '…/drivers/fs.js'.
const firstCell = (row: string): string =>
  row.split('|')[1].trim().replace(/^`|`$/g, '');

const backticked = (text: string): Set<string> =>
  new Set([...text.matchAll(/`([A-Za-z_$][\w$]*)`/g)].map((m) => m[1]));

// The text that names an entry's exports: its row, and for the main entry every line of the
// section that is not a table row (the grouped list under the table).
const entryText = (section: string, subpath: string): string => {
  const lines = section.split('\n');
  const row = lines.find(
    (line) => isRow(line) && firstCell(line) === docName(subpath),
  );
  assert.ok(row, `no Package exports row for ${docName(subpath)}`);
  if (subpath !== '.') {
    return row;
  }
  return [row, ...lines.filter((line) => !isRow(line))].join('\n');
};

test('the Package exports table has one row per key of the exports map', () => {
  const cells = exportsSection().split('\n').filter(isRow).map(firstCell);
  assert.deepEqual(cells.sort(), exportKeys().map(docName).sort());
});

test('the README names every export of every entry in its Package exports row', async () => {
  const section = exportsSection();
  const missing: Record<string, string[]> = {};
  for (const entry of await packageEntries()) {
    const text = entryText(section, entry.subpath);
    const names = backticked(text);
    const absent = [...entry.values, ...entry.types].filter(
      (name) => !names.has(name),
    );
    if (
      entry.hasDefault &&
      !text.includes('default export') &&
      !(entry.defaultName && names.has(entry.defaultName))
    ) {
      absent.push('default export');
    }
    if (absent.length > 0) {
      missing[docName(entry.subpath)] = absent;
    }
  }
  assert.deepEqual(missing, {});
});

test('every name in a Package exports row is an export of that entry', async () => {
  const section = exportsSection();
  const known = (entry: EntryExports): Set<string> =>
    new Set([
      ...entry.values,
      ...entry.types,
      ...(entry.defaultName ? [entry.defaultName] : []),
    ]);
  const extra: Record<string, string[]> = {};
  for (const entry of await packageEntries()) {
    const exported = known(entry);
    const stray = [...backticked(entryText(section, entry.subpath))].filter(
      (name) => !exported.has(name),
    );
    if (stray.length > 0) {
      extra[docName(entry.subpath)] = stray;
    }
  }
  // The manifest row names no export (that the row exists is the table test's check).
  const manifestRow = section
    .split('\n')
    .find(
      (line) => isRow(line) && firstCell(line) === docName('./package.json'),
    );
  const manifest = [...backticked(manifestRow ?? '')];
  if (manifest.length > 0) {
    extra[docName('./package.json')] = manifest;
  }
  assert.deepEqual(extra, {});
});

test('every package import in README and AGENTS.md code fences names a real export of its subpath', async () => {
  const entries = await packageEntries();
  const keys = exportKeys();
  let total = 0;
  for (const file of DOCS) {
    const text = read(file);
    const imports = docImports(text);
    total += imports.length;
    assert.deepEqual(
      [...fenceProblems(text), ...importProblems(imports, entries, keys)],
      [],
      file,
    );
  }
  assert.ok(total >= 20, `only ${total} package imports found in fences`);
});

test('every package specifier and …/x.js path README and AGENTS.md name is a key of the exports map', () => {
  const keys = new Set(exportKeys());
  const unknown: string[] = [];
  let specifiers = 0;
  let shortPaths = 0;
  for (const file of DOCS) {
    const text = read(file);
    for (const m of text.matchAll(
      /[`'"](@adaptivestone\/framework-module-resize(?:\/[^`'"\s]*)?)[`'"]/g,
    )) {
      specifiers += 1;
      const key = `.${m[1].slice('@adaptivestone/framework-module-resize'.length)}`;
      if (!keys.has(key)) {
        unknown.push(`${file}: ${m[1]}`);
      }
    }
    for (const m of text.matchAll(
      /…(\/[A-Za-z0-9._/-]+\.js(?:on)?)(?![A-Za-z0-9_])/g,
    )) {
      shortPaths += 1;
      if (!keys.has(`.${m[1]}`)) {
        unknown.push(`${file}: …${m[1]}`);
      }
    }
  }
  assert.deepEqual(unknown, []);
  assert.ok(specifiers >= 20, `only ${specifiers} package specifiers found`);
  assert.ok(shortPaths >= 30, `only ${shortPaths} …/x.js paths found`);
});

// The files outside src/decoders/ and src/drivers/ that a task runs through, where a code can be
// marked terminal (`retryable: false`). Every decoder and driver file is read from its folder, so
// a new one is scanned without an edit here.
const TASK_PATH = [
  'errors.ts',
  'decoderSet.ts',
  'helpers/svgRaster.ts',
  'processor.ts',
  'render.ts',
  'raster.ts',
  'plan.ts',
  'previewRecorder.ts',
  'catalog.ts',
  'freshness.ts',
  'images.ts',
  'pipelines.ts',
  'consumer.ts',
  'worker.ts',
];

// Every non-test `.ts` file under src/<folder>/, subfolders included: 'drivers/mongo/…'.
const sourceFiles = (folder: string): string[] =>
  readdirSync(new URL(`./${folder}/`, import.meta.url), {
    recursive: true,
    encoding: 'utf8',
  })
    .map((file) => file.split('\\').join('/'))
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => `${folder}/${file}`);

const taskPathFiles = (): string[] => [
  ...TASK_PATH,
  ...sourceFiles('decoders'),
  ...sourceFiles('drivers'),
];

// A comment as spaces, its line breaks kept, so every index of the text stays on its line.
const blank = (comment: string): string => comment.replace(/[^\n]/g, ' ');

// The codes of the object literals in `file` that also hold `retryable: false`: a `code:` whose
// whole value is a 'RESIZE_…' literal, or the bare name of a module constant of the same file
// bound to one. Comments are blanked first, so a commented-out literal does not count. Every
// `retryable: false` the scan cannot tie to a code (in an object with a nested object or a `${…}`,
// or beside an expression, a template literal, a helper call or a property read) is returned as
// `file:line` in `unread`, so a shape the scan does not know fails the guard instead of being
// skipped.
const terminalScan = (
  file: string,
): { codes: Set<string>; read: number; unread: string[] } => {
  const text = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(
      /(^|[^:])(\/\/.*)$/gm,
      (_, before: string, comment: string) => before + blank(comment),
    );
  // Module constants bound to a string literal and nothing more: `const X = 'RESIZE_…';`, the `;`
  // right after the closing quote (spaces allowed before it). A value continued on the next line
  // (`'RESIZE_…'` then `+ '_NEW';`) binds no code, so its uses stay unread.
  const constants = new Map(
    [
      ...text.matchAll(
        /const\s+([A-Z_][A-Z0-9_]*)\s*=\s*'(RESIZE_[A-Z0-9_]+)'[ \t]*;/g,
      ),
    ].map((m) => [m[1], m[2]]),
  );
  const codes = new Set<string>();
  const resolved = new Set<number>(); // the index of each `retryable: false` tied to a code
  for (const literal of text.matchAll(/\{[^{}]*\}/g)) {
    const flags = [...literal[0].matchAll(/retryable:\s*false/g)];
    if (flags.length === 0) {
      continue;
    }
    // The whole `code:` value, up to the next `,` or the literal's `}`, must be the string literal
    // or the constant's bare name: `UNSUPPORTED + '_NEW'`, a call, a template literal or a
    // property read leaves the flag unread.
    const raw = /code:([^,}]*)/.exec(literal[0])?.[1].trim() ?? '';
    const code = /^(?:'(RESIZE_[A-Z0-9_]+)'|([A-Z_][A-Z0-9_]*))$/.exec(raw);
    const value = code?.[1] ?? (code?.[2] && constants.get(code[2]));
    if (value) {
      codes.add(value);
      for (const flag of flags) {
        resolved.add(literal.index + flag.index);
      }
    }
  }
  const unread = [...text.matchAll(/retryable:\s*false/g)]
    .filter((flag) => !resolved.has(flag.index))
    .map((flag) => `${file}:${text.slice(0, flag.index).split('\n').length}`);
  return { codes, read: resolved.size, unread };
};

test('the terminal-code scan reads every decoder and driver file, and the consumer, worker and processor', () => {
  const scanned = new Set(taskPathFiles());
  const decoders = sourceFiles('decoders');
  const drivers = sourceFiles('drivers');
  assert.ok(decoders.length >= 2, `only ${decoders.length} decoder files`);
  assert.ok(drivers.length >= 5, `only ${drivers.length} driver files`);
  const required = [
    ...decoders,
    ...drivers,
    'consumer.ts',
    'worker.ts',
    'processor.ts',
  ];
  assert.deepEqual(
    required.filter((file) => !scanned.has(file)),
    [],
  );
});

test('the README lists exactly the codes a task is dead-lettered with at once', () => {
  const expected = [
    'RESIZE_NO_ORIGINAL',
    'RESIZE_SOURCE_FORMAT_UNSUPPORTED',
    'RESIZE_SOURCE_METADATA_MISSING',
    'RESIZE_SOURCE_TOO_LARGE',
    'RESIZE_SVG_DIMENSIONS_UNSUPPORTED',
    'RESIZE_SVG_RENDER_TIMEOUT',
  ];
  const files = taskPathFiles();
  assert.ok(files.length >= 25, `only ${files.length} task-path files`);
  const scans = files.map(terminalScan);
  assert.deepEqual(
    scans.flatMap((scan) => scan.unread),
    [],
    'a `retryable: false` the scan cannot tie to a code',
  );
  assert.deepEqual(
    [...terminalScan('decoderSet.ts').codes],
    ['RESIZE_SOURCE_FORMAT_UNSUPPORTED'],
  );
  const sites = scans.reduce((sum, scan) => sum + scan.read, 0);
  assert.ok(sites >= 12, `only ${sites} \`retryable: false\` sites read`);
  const inCode = new Set(scans.flatMap((scan) => [...scan.codes]));
  assert.deepEqual([...inCode].sort(), expected);

  const readme = read('README.md');
  const from = readme.indexOf(
    'The module sets it on every `ResizeSecurityError` and on',
  );
  const to = readme.indexOf('The worker reads', from);
  assert.ok(from >= 0 && to > from, 'README.md terminal-code list not found');
  const inReadme = new Set(
    readme.slice(from, to).match(/RESIZE_[A-Z0-9_]+/g) ?? [],
  );
  assert.deepEqual([...inReadme].sort(), expected);
});
