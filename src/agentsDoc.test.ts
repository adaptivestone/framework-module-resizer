import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
// The real export surface — if AGENTS.md names something this entry doesn't export, fail.
import { RESIZE_ERROR_CODES } from './errorCodes.ts';
import * as mainEntry from './index.ts';

const AGENTS_URL = new URL('../AGENTS.md', import.meta.url);
const PKG_URL = new URL('../package.json', import.meta.url);

const readAgents = () => readFile(AGENTS_URL, 'utf8');
const readPkg = async () => JSON.parse(await readFile(PKG_URL, 'utf8'));

describe('AGENTS.md drift guard (the doc ships with the package — it must not rot)', () => {
  test('ships with the package: listed in package.json files', async () => {
    const pkg = await readPkg();
    assert.ok(
      pkg.files.includes('AGENTS.md'),
      'package.json "files" must include AGENTS.md (npm auto-includes only README/LICENSE)',
    );
    assert.ok(
      pkg.files.includes('UPGRADING.md'),
      'package.json "files" must include UPGRADING.md: AGENTS.md links to it',
    );
  });

  test('every full-name subpath mentioned exists in the exports map', async () => {
    const doc = await readAgents();
    const pkg = await readPkg();
    const mentioned = [
      ...doc.matchAll(
        /@adaptivestone\/framework-module-resize(\/[A-Za-z0-9./_-]+\.js)/g,
      ),
    ].map((m) => `.${m[1]}`);
    assert.ok(
      mentioned.length >= 2,
      'AGENTS.md should mention driver subpaths',
    );
    for (const sub of mentioned) {
      assert.ok(
        sub in pkg.exports,
        `AGENTS.md names an unexported subpath: ${sub}`,
      );
    }
  });

  test('every value imported from the main entry in snippets is a real export', async () => {
    const doc = await readAgents();
    const names = [
      ...doc.matchAll(
        /import\s*\{([^}]*)\}\s*from\s*'@adaptivestone\/framework-module-resize'/g,
      ),
    ]
      .flatMap((m) => m[1].split(','))
      .map((n) => n.trim())
      .filter((n) => n.length > 0 && !n.startsWith('type '));
    assert.ok(
      names.length >= 2,
      'AGENTS.md should import from the main entry in snippets',
    );
    for (const name of names) {
      assert.ok(
        name in mainEntry,
        `AGENTS.md imports a name the main entry does not export: ${name}`,
      );
    }
  });

  test('every value imported from …/framework.js or …/drivers/mongo.js in snippets is a real export of that entry', async () => {
    const doc = await readAgents();
    const entries: Record<string, Record<string, unknown>> = {
      '/framework.js': await import('./framework/index.ts'),
      '/drivers/mongo.js': await import('./drivers/mongo/index.ts'),
    };
    const imports = [
      ...doc.matchAll(
        /import\s*\{([^}]*)\}\s*from\s*'@adaptivestone\/framework-module-resize(\/framework\.js|\/drivers\/mongo\.js)'/g,
      ),
    ].flatMap((m) =>
      m[1]
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n.length > 0 && !n.startsWith('type '))
        .map((name) => ({ name, subpath: m[2] })),
    );
    assert.ok(
      imports.length >= 2,
      'AGENTS.md should import from …/framework.js or …/drivers/mongo.js in snippets',
    );
    for (const { name, subpath } of imports) {
      assert.ok(
        name in entries[subpath],
        `AGENTS.md imports a name ${subpath} does not export: ${name}`,
      );
    }
  });
});

// The text from a heading to the next `## ` heading.
const section = (doc: string, heading: string): string => {
  const start = doc.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `AGENTS.md has no "${heading}"`);
  const end = doc.indexOf('\n## ', start + 1);
  return doc.slice(start, end < 0 ? undefined : end);
};

describe('AGENTS.md stays what a new integration needs', () => {
  test('it holds at most 5,000 words, counted as wc -w does', async () => {
    const words = (await readAgents()).split(/\s+/).filter(Boolean).length;
    assert.ok(
      words <= 5000,
      `AGENTS.md has ${words} words: move detail to README.md or UPGRADING.md`,
    );
  });

  test('its troubleshooting table holds about 20 rows, and points at the full table', async () => {
    const doc = section(await readAgents(), '## Troubleshooting');
    const rows =
      doc.split('\n').filter((line) => line.startsWith('| ')).length - 1;
    assert.ok(rows >= 15 && rows <= 25, `${rows} troubleshooting rows`);
    assert.match(doc, /\.\/README\.md#error-codes/);
    assert.match(doc, /\.\/README\.md#symptoms-without-a-code/);
    assert.match(doc, /\.\/UPGRADING\.md/);
  });

  test('every code it names is a real code', async () => {
    const named = (await readAgents()).match(/\bRESIZE_[A-Z0-9_]+\b/g) ?? [];
    assert.deepEqual(
      [...new Set(named)]
        .filter((code) => !RESIZE_ERROR_CODES.has(code))
        .sort(),
      ['RESIZE_PUBLIC_BASE_URL'], // the scaffold's environment variable
    );
  });

  test('it says which text matches the installed version', async () => {
    const doc = (await readAgents()).replace(/\s+/g, ' ');
    assert.ok(
      doc.includes(
        'The guide and GitHub show the newest release; this file matches the version you have installed.',
      ),
    );
  });

  test('its local-files snippet is the recipe serveLocalFiles.test.ts runs on the framework server', async () => {
    const flat = (text: string) => text.replace(/\s+/g, ' ');
    const tested = await readFile(
      new URL('./framework/serveLocalFiles.test.ts', import.meta.url),
      'utf8',
    );
    const recipe = /const bootHttp: BootHttpHook = [\s\S]*?\n\};/.exec(
      tested,
    )?.[0];
    assert.ok(recipe, 'serveLocalFiles.test.ts holds no bootHttp recipe');
    const doc = flat(await readAgents());
    assert.ok(doc.includes(flat(recipe)), 'AGENTS.md lacks the tested recipe');
    assert.ok(doc.includes('new Server({ folders, bootHttp })'));
  });

  test('step 7 shows the migration that creates the indexes, with commands the framework has', async () => {
    const doc = (await readAgents()).replace(/\s+/g, ' ');
    for (const needle of [
      'npm run cli migration/create',
      // The framework's migration/create writes into the folder and never makes it.
      'create `src/migrations` first if it is missing',
      "await this.app.getModelOrThrow('ResizeTask').createIndexes();",
      'npm run cli migration/migrate',
    ]) {
      assert.ok(doc.includes(needle), needle);
    }
    // The framework's CLI names a command by its file under dist/commands, in lower case.
    const commands = new URL(
      'commands/migration/',
      import.meta.resolve('@adaptivestone/framework/server.js'),
    );
    for (const file of ['Create.js', 'Migrate.js']) {
      assert.ok(existsSync(new URL(file, commands)), `migration/${file}`);
    }
  });

  test('its troubleshooting table names the likeliest config error and a forgotten step 6', async () => {
    const rows = section(await readAgents(), '## Troubleshooting')
      .split('\n')
      .filter((line) => line.startsWith('| '));
    const row = (needle: string) => rows.find((line) => line.includes(needle));
    assert.match(
      row('`RESIZE_CONFIG_MEDIA_MODEL_MISSING`') ?? '',
      /`RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN`.*'File'/,
    );
    assert.match(
      row('`no-original`') ?? '',
      /`uploadOriginal\(\)` succeeded.*`resizeMediaSchemaFragment`/,
    );
  });

  test('step 8 leads push delivery with the settings a host must get right', async () => {
    const doc = (await readAgents()).replace(/\s+/g, ' ');
    const push = doc.slice(doc.indexOf('Push delivery (preview)'));
    for (const needle of [
      'createSqsHandler()',
      'ReportBatchItemFailures',
      'batch size 1',
      'do not bundle',
      'install Sharp',
      '`maxReceiveCount` = `maxAttempts` + 2',
      'MaximumConcurrency',
      './README.md#push-delivery-preview',
    ]) {
      assert.ok(push.includes(needle), needle);
    }
    assert.ok(
      push.indexOf('ReportBatchItemFailures') < push.indexOf('batch size 1'),
      'ReportBatchItemFailures leads',
    );
  });
});
