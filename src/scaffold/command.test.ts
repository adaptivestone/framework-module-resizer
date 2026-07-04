import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runScaffold } from './command.ts';

// A fresh temp project root per test (node:fs.mkdtemp under os.tmpdir()).
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'resize-scaffold-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// runScaffold prints per-file status via console.log; capture it so tests can assert on the
// ok/drift/missing/skipped lines while keeping the fixed runScaffold(argv, cwd) signature.
async function run(
  argv: string[],
  cwd = root,
): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => {
    lines.push(a.map(String).join(' '));
  };
  try {
    const code = await runScaffold(argv, cwd);
    return { code, out: lines.join('\n') };
  } finally {
    console.log = orig;
  }
}

const read = (rel: string) => readFile(join(root, rel), 'utf8');
const exists = (rel: string) =>
  stat(join(root, rel)).then(
    () => true,
    () => false,
  );

const MODEL = 'src/models/ResizeTask.ts';
const COMMAND = 'src/commands/ResizeWorker.ts';
const RESIZER = 'src/resizer.ts';
const CONFIG = 'src/config/resize.ts';

describe('runScaffold — default run', () => {
  test('emits the four files with the expected key content', async () => {
    const { code } = await run([]);
    assert.equal(code, 0);

    assert.match(await read(RESIZER), /new Resizer\(/);
    assert.match(await read(MODEL), /extends ResizeTaskModel/);
    assert.match(
      await read(COMMAND),
      /@adaptivestone\/framework-module-resize\/commands\/ResizeWorker\.js/,
    );
    assert.match(await read(CONFIG), /\.\.\.defaultResizeConfig/);
  });

  test('auto-creates missing directories', async () => {
    // The temp root starts empty — no src/, no nested dirs.
    assert.equal(await exists('src'), false);
    await run([]);
    assert.equal(await exists('src/models'), true);
    assert.equal(await exists('src/commands'), true);
    assert.equal(await exists('src/config'), true);
  });

  test('reports each written file as created', async () => {
    const { out } = await run([]);
    assert.match(out, /created/);
    assert.match(out, new RegExp(RESIZER));
    assert.match(out, new RegExp(MODEL));
  });
});

describe('runScaffold — idempotency & --force', () => {
  test('re-run without --force skips existing files (unchanged, exit 0)', async () => {
    await run([]);
    const before = await stat(join(root, MODEL));
    const beforeContent = await read(MODEL);

    const { code, out } = await run([]);
    assert.equal(code, 0);
    assert.match(out, /exists \(skipped\)/);

    const after = await stat(join(root, MODEL));
    assert.equal(after.mtimeMs, before.mtimeMs); // not touched
    assert.equal(await read(MODEL), beforeContent);
  });

  test('--force overwrites an existing file', async () => {
    await run([]);
    await writeFile(join(root, MODEL), '// hand-edited\n');
    assert.match(await read(MODEL), /hand-edited/);

    const { code, out } = await run(['--force']);
    assert.equal(code, 0);
    assert.match(out, /overwrote|overwrit/i);
    assert.match(await read(MODEL), /extends ResizeTaskModel/); // template restored
  });
});

describe('runScaffold — --eject', () => {
  test('writes the full editable model (schema + indexes, BaseModel subpath)', async () => {
    const { code } = await run(['--eject']);
    assert.equal(code, 0);

    const model = await read(MODEL);
    assert.match(model, /modelSchema/);
    assert.match(model, /initHooks/);
    assert.match(model, /extends BaseModel/);
    assert.match(model, /@adaptivestone\/framework\/modules\/BaseModel\.js/);
    // Still the full set of files.
    assert.equal(await exists(COMMAND), true);
    assert.equal(await exists(CONFIG), true);
  });

  test('honors skip-if-exists without --force', async () => {
    await run([]); // writes the shim
    const { out } = await run(['--eject']); // model already exists
    assert.match(out, /exists \(skipped\)/);
    assert.match(await read(MODEL), /extends ResizeTaskModel/); // still the shim
  });
});

describe('runScaffold — --eager', () => {
  test('emits only resizer.ts + config, with the transport commented out', async () => {
    const { code } = await run(['--eager']);
    assert.equal(code, 0);

    assert.equal(await exists(RESIZER), true);
    assert.equal(await exists(CONFIG), true);
    assert.equal(await exists(MODEL), false);
    assert.equal(await exists(COMMAND), false);

    // The transport line is commented (eager mode never enqueues).
    const resizer = await read(RESIZER);
    assert.doesNotMatch(resizer, /^\s*transport: new MongoTransport/m);
    assert.match(resizer, /\/\/\s*transport/);
    // The now-unused MongoTransport import is commented too (4.3).
    assert.doesNotMatch(resizer, /^\s*import \{ MongoTransport \}/m);
    assert.match(resizer, /\/\/\s*import \{ MongoTransport \}/);
  });
});

describe('runScaffold — --check', () => {
  test('clean scaffold → exit 0 with ok lines', async () => {
    await run([]);
    const { code, out } = await run(['--check']);
    assert.equal(code, 0);
    assert.match(out, /ok/);
    assert.doesNotMatch(out, /missing|drift/);
  });

  test('missing file → exit 1 + missing', async () => {
    await run([]);
    await rm(join(root, CONFIG));
    const { code, out } = await run(['--check']);
    assert.equal(code, 1);
    assert.match(out, /missing/);
  });

  test('corrupted model shim (no extends ResizeTaskModel) → exit 1 + drift', async () => {
    await run([]);
    await writeFile(join(root, MODEL), 'export default class ResizeTask {}\n');
    const { code, out } = await run(['--check']);
    assert.equal(code, 1);
    assert.match(out, /drift/);
  });

  test('drifted command re-export path → exit 1 + drift', async () => {
    await run([]);
    await writeFile(
      join(root, COMMAND),
      "export { default } from './somewhere-else.js';\n",
    );
    const { code, out } = await run(['--check']);
    assert.equal(code, 1);
    assert.match(out, /drift/);
  });

  test('never creates files (empty root → exit 1, nothing written)', async () => {
    const { code, out } = await run(['--check']);
    assert.equal(code, 1);
    assert.match(out, /missing/);
    assert.equal(await exists('src'), false);
    assert.equal(await exists(RESIZER), false);
  });
});

describe('runScaffold — --out', () => {
  test('redirects the project root', async () => {
    const outDir = join(root, 'nested', 'app');
    await mkdir(outDir, { recursive: true });
    const { code } = await run(['--out', outDir], root);
    assert.equal(code, 0);
    assert.equal(await exists('nested/app/src/resizer.ts'), true);
    assert.equal(await exists(RESIZER), false); // NOT at the cwd root
  });
});

describe('runScaffold — --help', () => {
  test('prints usage and exits 0 without writing', async () => {
    const { code, out } = await run(['--help']);
    assert.equal(code, 0);
    assert.match(out, /resize-scaffold/);
    assert.equal(await exists(RESIZER), false);
  });
});

// Build/packaging smoke — cheap source assertions (no real build in the unit suite).
describe('packaging smoke', () => {
  test('command.ts starts with the node shebang', async () => {
    const src = await readFile(
      fileURLToPath(new URL('./command.ts', import.meta.url)),
      'utf8',
    );
    assert.equal(src.split('\n')[0], '#!/usr/bin/env node');
  });

  test('package.json bin points at dist/scaffold/command.js', async () => {
    const pkg = JSON.parse(
      await readFile(
        fileURLToPath(new URL('../../package.json', import.meta.url)),
        'utf8',
      ),
    );
    assert.equal(pkg.bin['resize-scaffold'], './dist/scaffold/command.js');
  });
});
