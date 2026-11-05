// README.md is the reference for the export surface, so its "Package exports" section is checked
// both ways against the exports. In README.md and AGENTS.md, every package import in a code fence
// and every subpath the text names (quoted or in backticks) must exist, and every fence must
// close. The README's list of the codes that dead-letter a task at once is checked against the
// code.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { RESIZE_ERROR_CODES } from './errorCodes.ts';
import { errorTableRows } from './testHelpers/errorTable.ts';
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

// The files outside src/decoders/, src/drivers/ and src/engines/ that a task runs through, where a
// code can be marked terminal (`retryable: false`). Every decoder, driver and engine file is read
// from its folder, so a new one is scanned without an edit here.
const TASK_PATH = [
  'errors.ts',
  'decoderSet.ts',
  'helpers/sharpError.ts',
  'helpers/svgRaster.ts',
  'processor.ts',
  'render.ts',
  'helpers/raster.ts',
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
  ...sourceFiles('engines'),
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
    // An add result, not an error: prewarm reads its `retryable`, the worker never does.
    if (/status:\s*'unconfirmed'/.test(literal[0])) {
      for (const flag of flags) {
        resolved.add(literal.index + flag.index);
      }
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
    'RESIZE_MEDIA_NO_ID',
    'RESIZE_MEDIA_ROW_NOT_KEPT',
    'RESIZE_NO_ORIGINAL',
    'RESIZE_SIZE_INVALID',
    'RESIZE_SOURCE_DAMAGED',
    'RESIZE_SOURCE_FORMAT_UNSUPPORTED',
    'RESIZE_SOURCE_METADATA_MISSING',
    'RESIZE_SOURCE_TOO_LARGE',
    'RESIZE_SVG_DIMENSIONS_UNSUPPORTED',
    'RESIZE_SVG_RENDER_TIMEOUT',
    'RESIZE_TASK_MAX_ATTEMPTS',
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

// The eight lines both pages lead with, word for word: the guide's section repeats them, so a host
// who reads only one page still does not lose tasks. Change one here, in the README and in the guide.
const PUSH_LEAD = [
  "1. **`ReportBatchItemFailures` in the trigger's `FunctionResponseTypes`.** Without it Lambda deletes every message of a normal return, so a failing task is gone after its first failure, with no copy, while its line says `retrying in 5000 ms`. The handler cannot detect this.",
  '2. **Batch size 1, with no batch window.** Records of a batch run one after another. One that does not fit in the time left is not started, yet its delivery counts as an attempt, so healthy tasks die unrun.',
  "3. **A function timeout well above your slowest task.** Start at 300 s. Lambda's default 3 s runs no task at all.",
  '4. **Redrive `maxReceiveCount` = `maxAttempts` + 2** (7 for the default 5). Too low, and SQS moves the message itself, with no module line, hook or cooldown.',
  "5. **A visibility timeout at least 6 × the function timeout**, which is AWS's rule. Set `coordination.gateTtlMs` at or above it.",
  "6. **A `deadLetterQueueUrl` in the queue's entry.** Without one a dead task is deleted at its last delivery.",
  '7. **The IAM permissions `AWSLambdaSQSQueueExecutionRole` lacks:** `sqs:ChangeMessageVisibility` on the queue, `sqs:SendMessage` on the dead-letter queue, and S3 get and put.',
  '8. **`MaximumConcurrency` on the trigger, rather than low reserved concurrency.** Reserved concurrency throttles, and a throttled receive may count as an attempt.',
];

test('the push delivery section leads with the settings a host must get right, in the order that saves tasks', () => {
  const readme = read('README.md');
  const from = readme.indexOf('## Push delivery');
  assert.ok(from >= 0, 'README.md has no "## Push delivery" section');
  const to = readme.indexOf('\n## ', from + 1);
  const section = readme.slice(from, to < 0 ? undefined : to);
  // First mentions, so the section's opening cannot name one of them ahead of the list.
  const lead = [
    'ReportBatchItemFailures',
    'Batch size 1',
    'function timeout',
    'maxReceiveCount',
    'visibility timeout',
    'deadLetterQueueUrl',
    'sqs:ChangeMessageVisibility',
    'sqs:SendMessage',
    'MaximumConcurrency',
  ];
  let at = -1;
  for (const setting of lead) {
    const found = section.indexOf(setting);
    assert.ok(found > at, `${setting} must come after what leads it`);
    at = found;
  }
  for (const later of ['createSqsHandler(', 'Do not bundle']) {
    assert.ok(section.indexOf(later) > at, `${later} must come after the lead`);
  }
  let line = -1;
  for (const text of PUSH_LEAD) {
    const found = section.indexOf(`\n${text}\n`);
    assert.ok(found > line, `the lead must hold, in this order: ${text}`);
    line = found;
  }
  assert.ok(
    section.indexOf('Do not bundle') < section.indexOf('--external:@aws-sdk'),
    '"Do not bundle" must lead the esbuild table',
  );
  assert.ok(
    section.indexOf('{ concurrency: 1, cache: false }') >= 0,
    'the handler must lead with its Sharp options',
  );
  assert.ok(
    section.includes('FIFO'),
    'the section must say FIFO queues are not supported',
  );
  assert.ok(
    /not run on real AWS/.test(section.slice(0, 600)),
    'the section must open by saying it has not run on real AWS',
  );
});

test('UPGRADING.md: fences close, subpaths exist, and only the old shape it shows on purpose is stale', async () => {
  const text = read('UPGRADING.md');
  assert.deepEqual(fenceProblems(text), []);
  assert.deepEqual(
    importProblems(docImports(text), await packageEntries(), exportKeys()),
    [
      "import { defaultFrameworkResizeConfig } from '@adaptivestone/framework-module-resize/config/resize.js' (…/config/resize.js): 'defaultFrameworkResizeConfig' is not a value export of the entry",
    ],
  );
  const keys = new Set(exportKeys());
  for (const m of text.matchAll(
    /…(\/[A-Za-z0-9._/-]+\.js(?:on)?)(?![A-Za-z0-9_])/g,
  )) {
    assert.ok(keys.has(`.${m[1]}`), `…${m[1]}`);
  }
});

test('UPGRADING.md names every 0.4.0 trap, and what comes before npm i comes first', () => {
  const text = read('UPGRADING.md');
  const from = text.indexOf('## From 0.3.x to 0.4.0');
  const to = text.indexOf('## From 0.2.x to 0.3.0');
  assert.ok(from >= 0 && to > from, 'UPGRADING.md sections not found');
  const section = text.slice(from, to).replace(/\s+/g, ' ');
  for (const needle of [
    'storage.publicUrl',
    '3.729 to 3.734',
    '--legacy-peer-deps',
    'limits.sourceBytes',
    'upload.maxBytes',
    '2147483647',
    'previews stored earlier stop being served',
    'contentType',
    'storageRef',
    'RESIZE_MEDIA_ROW_NOT_KEPT',
    'An `engine` or `decoders` key',
    '975 MB',
    '590 MB',
    'A pipeline without steps pays nothing',
    'What a rewritten step writes',
    'at most 2 levels',
    'list the objects first',
    'older than a day and more than twice `taskTimeoutMs`',
    'call `invalidate()`',
    'does not run steps',
    'raster.info',
    'RESIZE_ORIGINAL_INSPECT_FAILED',
    'RESIZE_ORIGINAL_TOO_MANY_PIXELS',
    'RESIZE_TASK_MAX_ATTEMPTS',
    'summaryIntervalMs',
    'resolveWithObject',
    'this.where',
    'reports nothing new',
    './README.md#push-delivery-preview',
    'getResizer().verify()',
    'startServer()',
    'An S3 `storage.publicUrl`',
    '1.9 GB',
    'Add `/var/` to `.gitignore`',
  ]) {
    assert.ok(section.includes(needle), needle);
  }
  const install = section.indexOf('npm i @adaptivestone/');
  assert.ok(
    install > section.indexOf('3.729 to 3.734'),
    'the SDK pin comes first',
  );
  assert.ok(
    install > section.indexOf('getResizer().verify()'),
    'verify() comes first',
  );
  assert.equal(
    text.slice(0, from).includes('npm i '),
    false,
    'no install in the head',
  );
});

test('the README top and the 0.4.0 changelog send a host to UPGRADING.md before npm i', () => {
  // UPGRADING.md reaches node_modules only through the npm i it warns about, so npmjs.com's README
  // points at it by its GitHub URL. The changelog ships beside it, so it links relatively, and the
  // GitHub Release body (the changelog section) gets the tag's URL from RELEASE.md's command.
  const pointer = (target: string) =>
    new RegExp(
      `Before you upgrade, read \\[\`UPGRADING\\.md\`\\]\\(${target}\\): it lists what to change before you run \`npm i\`\\.`,
      'i',
    );
  const readme = read('README.md');
  const top = readme.slice(0, readme.indexOf('\n## ')).replace(/\s+/g, ' ');
  assert.match(
    top,
    pointer(
      'https://github\\.com/adaptivestone/framework-module-resizer/blob/main/UPGRADING\\.md',
    ),
    'the README top, above its first section',
  );
  const opening = /^# 0\.4\.0\n\n([\s\S]*?)\n\n/m.exec(read('CHANGELOG.md'));
  assert.ok(opening, 'CHANGELOG.md has a # 0.4.0 section');
  assert.match(
    opening[1].replace(/\s+/g, ' '),
    pointer('\\./UPGRADING\\.md'),
    'the first paragraph of # 0.4.0',
  );
  const release = read('RELEASE.md');
  for (const tag of ['vX.Y.Z', 'vX.Y.0-rc.N']) {
    assert.ok(
      release.includes(
        `sed 's#](\\./#](https://github.com/adaptivestone/framework-module-resizer/blob/${tag}/#g'`,
      ),
      `the ${tag} release body points relative links at the tag`,
    );
  }
});

// The README text from a heading to the next `## ` heading, or, for a subsection, the next heading.
const readmeSection = (heading: string): string => {
  const readme = read('README.md');
  const start = readme.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `README.md has no "${heading}"`);
  const end = readme.indexOf('\n## ', start + 1);
  return readme.slice(start, end < 0 ? undefined : end);
};
const readmeSubsection = (heading: string): string => {
  const readme = read('README.md');
  const start = readme.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `README.md has no "${heading}"`);
  const end = readme.indexOf('\n##', start + 1);
  return readme.slice(start, end < 0 ? undefined : end);
};

test('the README Error codes table has one row per code, in order, and names no other', () => {
  const rows = errorTableRows(read('README.md'));
  assert.deepEqual(
    rows.map((row) => row.code),
    [...RESIZE_ERROR_CODES].sort(),
  );
  for (const row of rows) {
    assert.ok(row.text.length > 0, `${row.code} has no text`);
    assert.match(row.text, /^[^a-z]/, `${row.code} opens mid-sentence`);
  }
});

test('a row that says See points at a row with its own text', () => {
  const rows = errorTableRows(read('README.md'));
  const texts = new Map(rows.map((row) => [row.code, row.text]));
  for (const row of rows) {
    const target = /^See `(RESIZE_[A-Z0-9_]+)`\.$/.exec(row.text)?.[1];
    if (target !== undefined) {
      assert.ok(texts.has(target), `${row.code} points at ${target}`);
      assert.match(texts.get(target) ?? '', /^(?!See )/, row.code);
    }
  }
});

test('no row of the table has a cut parenthesis', () => {
  for (const row of errorTableRows(read('README.md'))) {
    const prose = row.text.replace(/``.*?``/g, '').replace(/`[^`]*`/g, '');
    assert.equal(
      prose.split('(').length,
      prose.split(')').length,
      `${row.code}: ${prose.slice(0, 80)}`,
    );
  }
});

test('the adoptOriginal table says what the full table says', () => {
  const full = new Map(
    errorTableRows(read('README.md')).map((row) => [row.code, row.retryable]),
  );
  let codes = 0;
  for (const line of readmeSubsection('### `adoptOriginal()`').split('\n')) {
    const cells = line.split(' | ');
    const stated = cells.at(-1) ?? '';
    if (line.startsWith('| ') && /^`(true|false)`/.test(stated)) {
      for (const [code] of (cells.at(-2) ?? '').matchAll(
        /RESIZE_[A-Z0-9_]+/g,
      )) {
        codes += 1;
        assert.ok(stated.includes(full.get(code) ?? 'no row'), code);
      }
    }
  }
  assert.ok(codes >= 12, `only ${codes} codes read`);
});

// The `retryable` values a text states, by the `causeCode: '…'` named in the same clause ('' when
// none is). A clause ends at `. ` or `; `.
const retryableStated = (
  text: string,
  value: RegExp,
): Map<string, Set<string>> => {
  const stated = new Map<string, Set<string>>();
  for (const clause of text.split(/[.;] /)) {
    const cause = /causeCode: '(RESIZE_[A-Z0-9_]+)'/.exec(clause)?.[1] ?? '';
    for (const [, said] of clause.matchAll(value)) {
      stated.set(cause, (stated.get(cause) ?? new Set()).add(said));
    }
  }
  return stated;
};

test('a code in both the full table and the prewarm() table says the same, or says why not', () => {
  const full = new Map(
    errorTableRows(read('README.md')).map((row) => [row.code, row]),
  );
  const issues = [
    ...readmeSubsection('### `prewarm()` issues').matchAll(
      /^\| `(RESIZE_[A-Z0-9_]+)` \| .* \| (`(?:true|false)`[^|]*) \|$/gm,
    ),
  ];
  assert.ok(issues.length >= 13, `only ${issues.length} issues read`);
  for (const [, code, cell] of issues) {
    const row = full.get(code);
    assert.ok(row, code);
    if (row.retryable === '—') {
      // The row points at the prewarm() table, and a value it states is one that table states
      // under the same causeCode.
      assert.match(row.text, /`prewarm\(\)`/, `${code} does not point there`);
      const issue = retryableStated(cell, /`(true|false)`/g);
      for (const [cause, values] of retryableStated(
        row.text,
        /`retryable: (true|false)`/g,
      )) {
        for (const value of values) {
          assert.ok(
            issue.get(cause)?.has(value),
            `${code}${cause ? ` with ${cause}` : ''} says \`retryable: ${value}\`, which the prewarm() table does not`,
          );
        }
      }
    } else {
      // A row with its own value has the issue's, or a sentence that says the issue's.
      const issue = /^`(true|false)`/.exec(cell)?.[1];
      const said = /As a `prewarm\(\)` issue it is `(true|false)`/.exec(
        row.text,
      )?.[1];
      assert.equal(said ?? row.retryable.slice(1, -1), issue, code);
    }
  }
});

test('every symptom that left AGENTS.md has a row in the README', () => {
  const symptoms = readmeSection('## Error codes');
  for (const needle of [
    'previews never appear',
    'tasks stay `pending` on one queue',
    'a deleted preview is still served by the CDN',
    'first read of a new size is slow to fill',
    'the media store did not keep the identity of',
    'Input file is missing',
    'img.composite is not a function',
    'a preview URL fails while a read calls that preview ready',
    'did not settle within',
  ]) {
    assert.ok(symptoms.includes(needle), needle);
  }
});

test('the push troubleshooting table names every symptom that left AGENTS.md', () => {
  const push = readmeSection('## Push delivery (preview)');
  for (const needle of [
    'RESIZE_DELIVERY_UNSUPPORTED',
    'Failed tasks disappear',
    'the first record … was not started',
    'message … was not started',
    'setting the visibility … had not answered',
    'A task in the dead-letter queue with no `is dead` line',
  ]) {
    assert.ok(push.includes(needle), needle);
  }
});

test('## Config reference ends inside what npm shows of the README', () => {
  const readme = read('README.md');
  const drivers = readme.indexOf('\n## Drivers\n');
  const config = readme.indexOf('\n## Config reference\n');
  assert.ok(
    config >= 0 && config < drivers,
    `## Config reference at ${config}, ## Drivers at ${drivers}`,
  );
  assert.ok(drivers < 65536, `## Config reference ends at ${drivers}`);
});

test('the README says which text matches the installed version, and what a small source gets', () => {
  const readme = read('README.md').replace(/\s+/g, ' ');
  for (const needle of [
    'The guide and GitHub show the newest release; this file matches the version you have installed.',
    '| `WxH` | Larger than the box on one side only | Exactly `WxH`, cropped, the short side enlarged |',
    '`80×80` for `80x80`',
    '`620×372` for `{ width: 620 }`',
  ]) {
    assert.ok(readme.includes(needle), needle);
  }
});

test('the not-started row says what a function needs, with an explicit stopBeforeTimeoutMs too', () => {
  const row = readmeSection('## Push delivery (preview)')
    .split('\n')
    .find((line) => line.startsWith('| `the first record … was not started`'));
  assert.ok(row, 'no row');
  for (const needle of [
    "plus the slowest task's time",
    '`stopBeforeTimeoutMs`',
    'lower that',
  ]) {
    assert.ok(row.includes(needle), needle);
  }
});

test('a forgotten media schema has a symptom row, since nothing fails at boot', () => {
  const row = readmeSubsection('### Symptoms without a code')
    .split('\n')
    .find((line) => line.includes('reads count `no-original`'));
  assert.ok(row, 'no row');
  for (const needle of [
    '`uploadOriginal()` succeeded',
    '`verify()` passes',
    '`resizeMediaSchemaFragment`',
  ]) {
    assert.ok(row.includes(needle), needle);
  }
});

test('the docs say how far the excluded SDK range reaches', () => {
  for (const file of ['README.md', 'CHANGELOG.md', 'UPGRADING.md']) {
    const text = read(file).replace(/\s+/g, ' ');
    assert.ok(
      text.includes(
        '`--legacy-peer-deps`, `--force`, pnpm and yarn install them',
      ),
      file,
    );
  }
});

test('package.json, the lockfile and the changelog name one version', () => {
  const { version } = JSON.parse(read('package.json')) as { version: string };
  const lock = JSON.parse(read('package-lock.json')) as {
    version: string;
    packages: Record<string, { version: string }>;
  };
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
  // A release candidate stays under its X.Y.0 heading, and the next release's heading may go in
  // before its bump: the heading may run ahead of package.json, never behind it.
  const heading = /^# (\d+)\.(\d+)\.(\d+)$/.exec(
    read('CHANGELOG.md').split('\n')[0],
  );
  assert.ok(heading, 'CHANGELOG.md opens with # X.Y.Z');
  const [major, minor, patch] = version
    .replace(/-.*$/, '')
    .split('.')
    .map(Number);
  const [h1, h2, h3] = heading.slice(1).map(Number);
  assert.ok(
    h1 > major ||
      (h1 === major && (h2 > minor || (h2 === minor && h3 >= patch))),
    `${heading[0]} is behind ${version}`,
  );
});

test('RELEASE.md lists every check only the owner can run', () => {
  const text = read('RELEASE.md');
  const start = text.indexOf("## 6. The owner's checks");
  assert.ok(start >= 0);
  const checks = text.slice(start);
  for (const needle of [
    '**Real S3:**',
    '`adoptOriginal`',
    'a key with a space',
    '**Real SQS:**',
    '**Real Lambda:**',
    '#push-delivery-needs-an-aws-account',
    'C2 and C5 first',
    '**A count on real originals:**',
    '**A frontend**',
    '**The npm name `resize-scaffold`:**',
  ]) {
    assert.ok(checks.includes(needle), needle);
  }
});

test('the docs say `--no` refuses to install, since npx still looks the name up', () => {
  // With the package missing, `npx --no` asks the registry for the name and stops with an error: it
  // never installs or runs it, but it does fetch the name's metadata.
  for (const file of ['README.md', 'AGENTS.md', 'UPGRADING.md', 'RELEASE.md']) {
    const text = read(file).replace(/\s+/g, ' ');
    assert.doesNotMatch(
      text,
      /refuses to fetch|never fetches|missing fetches/,
      file,
    );
  }
});

test('RELEASE.md says what gates the 0.4.0 publish, and how to merge and tag it', () => {
  const text = read('RELEASE.md');
  const section = (heading: string): string => {
    const start = text.indexOf(heading);
    assert.ok(start >= 0, heading);
    const end = text.indexOf('\n## ', start + heading.length);
    return text.slice(start, end < 0 ? undefined : end).replace(/\s+/g, ' ');
  };
  // Read top to bottom, §3 Publish comes before §6: it must send the owner there first.
  assert.ok(
    section('## 3. Publish').includes('](#6-the-owners-checks-for-040)'),
    '§3 points at §6',
  );
  assert.doesNotMatch(
    section('## 4. Git tag convention'),
    /pick one convention/,
  );
  const checks = section("## 6. The owner's checks");
  for (const needle of [
    '**Real S3** and **A count on real originals** pass before `npm publish`',
    '**The npm page,** after `npm publish`',
    '`## Config reference`',
    'not a squash',
    'git diff feat/0.4-f-docs-release main',
    'git tag v0.4.0',
  ]) {
    assert.ok(checks.includes(needle), needle);
  }
});
