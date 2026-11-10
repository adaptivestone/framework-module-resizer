// The preload is one flag in each test script, and nothing else would notice it going missing: a
// test that builds a real SDK client would quietly look in the owner's ~/.aws again.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const FLAG = '--import ./src/testHelpers/noAws.ts';
const STARTS_RUNNER = /\s--test(\s|$)/;
const WORKFLOWS = new URL('../../.github/workflows/', import.meta.url);
const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

test('every script that runs tests preloads noAws.ts', () => {
  const scripts: Record<string, string> = packageJson.scripts;
  const runners = Object.entries(scripts).filter(([, command]) =>
    STARTS_RUNNER.test(command),
  );
  assert.ok(runners.length > 0, 'no script starts the test runner');
  for (const [name, command] of runners) {
    assert.ok(command.includes(FLAG), `${name}: ${command}`);
  }
  // The smoke test is no `--test` run, and it builds real SDK clients too.
  assert.ok(scripts.smoke.includes(FLAG), scripts.smoke);
});

test('no workflow starts the test runner except through the script', () => {
  const bypasses: string[] = [];
  for (const file of readdirSync(WORKFLOWS)) {
    const lines = readFileSync(new URL(file, WORKFLOWS), 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim().startsWith('#') && STARTS_RUNNER.test(line)) {
        bypasses.push(`${file}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(bypasses, []);
});

test('the preload points the SDK at no file and turns the metadata service off', async () => {
  await import('./noAws.ts');
  for (const name of ['AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE']) {
    const path = process.env[name];
    assert.ok(path, name);
    assert.equal(existsSync(path), false, name);
  }
  assert.equal(process.env.AWS_EC2_METADATA_DISABLED, 'true');
});
