import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
// The real export surface — if AGENTS.md names something this entry doesn't export, fail.
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
});
