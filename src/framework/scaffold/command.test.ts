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
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import defaultResizeConfig, {
  defaultFrameworkResizeConfig,
} from '../../config/resize.ts';
import { getResizeConfig } from '../config.ts';
import { runScaffold } from './command.ts';

// A fresh temp project root per test (node:fs.mkdtemp under os.tmpdir()).
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'resize-scaffold-'));
});
afterEach(async () => {
  resetAppInstance();
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

    const resizer = await read(RESIZER);
    assert.match(resizer, /new FrameworkResizer\(\{/);
    assert.match(resizer, /framework\.js/);
    assert.doesNotMatch(
      resizer,
      /^\s*(storage|tasks|db):/m,
      'drivers live in the config',
    );
    assert.match(
      resizer,
      /a normal static import is fine[\s\S]+resizer\.verify\(\)/,
      'the framework is read lazily, so the guidance is a static import (+ verify() at boot)',
    );
    assert.match(await read(MODEL), /extends ResizeTaskModel/);
    const command = await read(COMMAND);
    assert.match(
      command,
      /^import '\.\.\/resizer\.ts';$/m,
      'the worker command must build the Resizers in the CLI process',
    );
    assert.match(
      command,
      /export \{ ResizeWorker as default \} from '@adaptivestone\/framework-module-resize\/framework\.js';/,
    );
    const configSource = await read(CONFIG);
    assert.match(
      configSource,
      /@adaptivestone\/framework-module-resize\/config\/resize\.js/,
    );
    assert.match(configSource, /\.\.\.defaultFrameworkResizeConfig/);
    assert.match(configSource, /satisfies FrameworkResizeConfig/);
    assert.match(configSource, /storage: \{ driver: 'local'/);
    assert.match(configSource, /^ {2}queue: \{ driver: 'database' \},$/m);
    assert.match(
      configSource,
      /indexes[\s\S]+migration process; the module never creates them/,
    );

    assert.match(configSource, /mediaModelName: 'File'/);
    // The template's effective config, mirrored here so it is checked by the resolver.
    const scaffoldedConfig = {
      ...defaultFrameworkResizeConfig,
      mediaModelName: 'File',
      storage: {
        driver: 'local' as const,
        rootDir: './var/media',
        publicBaseUrl: '/media',
      },
      queue: { driver: 'database' as const },
    };
    assert.deepEqual(scaffoldedConfig.formats, ['jpeg', 'webp', 'avif']);
    assert.equal(scaffoldedConfig.worker.enabled, false);
    assert.deepEqual(scaffoldedConfig.encode.formats.tiff, undefined);

    setAppInstance({
      getConfig: () => scaffoldedConfig,
      getModel: () => ({}),
      logger: { info() {}, warn() {}, error() {} },
    } as never);
    const resolved = getResizeConfig();
    assert.equal(resolved.mediaModelName, 'File');
    assert.strictEqual(resolved.queue, scaffoldedConfig.queue);
    assert.strictEqual(resolved.storage, scaffoldedConfig.storage);
    assert.strictEqual(resolved.image.encode, scaffoldedConfig.encode);
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
    assert.match(
      model,
      /requestKey:\s*\{\s*type:\s*String\s*\}/,
      'the ejected schema accepts the transport request identity',
    );
    assert.match(
      model,
      /\{ fileId: 1, pipeline: 1, requestKey: 1 \}/,
      'the ejected schema carries the active-request dedupe index',
    );
    assert.match(
      model,
      /resizer:\s*\{\s*type:\s*String,\s*default:\s*'default'\s*\}/,
      'the ejected schema records the Resizer of each task',
    );
    assert.match(
      model,
      /queue:\s*\{\s*type:\s*String,\s*default:\s*'default'\s*\}/,
      'the ejected schema records the queue of each task',
    );
    assert.match(
      model,
      /\{ queue: 1, status: 1, createdAt: 1 \}/,
      'the ejected schema carries the queue-scoped lease index',
    );
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
  test('emits only resizer.ts + config, with local storage and no task queue', async () => {
    const { code } = await run(['--eager']);
    assert.equal(code, 0);

    assert.equal(await exists(RESIZER), true);
    assert.equal(await exists(CONFIG), true);
    assert.equal(await exists(MODEL), false);
    assert.equal(await exists(COMMAND), false);

    const resizer = await read(RESIZER);
    assert.match(resizer, /a normal static import is fine/);
    assert.match(resizer, /new FrameworkResizer\(\{/);
    const configSource = await read(CONFIG);
    assert.match(configSource, /storage: \{ driver: 'local'[^}]*publicBaseUrl/);
    assert.doesNotMatch(configSource, /^\s*queue:/m, 'eager: no task queue');
    assert.match(configSource, /Eager mode: no task queue/);
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

  test('an ejected model passes --check (it owns its schema)', async () => {
    await run(['--eject']);
    const { code, out } = await run(['--check']);
    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /drift/);
  });

  test('an old model shim importing the removed subpath → exit 1 + drift', async () => {
    await run([]);
    await writeFile(
      join(root, MODEL),
      "import ResizeTaskModel from '@adaptivestone/framework-module-resize/models/ResizeTask.js';\nexport default class ResizeTask extends ResizeTaskModel {}\n",
    );
    const { code, out } = await run(['--check']);
    assert.equal(code, 1);
    assert.match(
      out,
      /drift\s+src\/models\/ResizeTask\.ts — must extend ResizeTaskModel/,
    );
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

  test('bare command re-export (no construction site) → exit 1 + drift with the fix', async () => {
    await run([]);
    await writeFile(
      join(root, COMMAND),
      "export { ResizeWorker as default } from '@adaptivestone/framework-module-resize/framework.js';\n",
    );
    const { code, out } = await run(['--check']);
    assert.equal(code, 1);
    assert.match(out, /drift\s+src\/commands\/ResizeWorker\.ts — must import/);
    assert.match(out, /re-run resize-scaffold/);
  });

  test('a host command that builds its Resizers from ../resizer.ts passes', async () => {
    await run([]);
    await writeFile(
      join(root, COMMAND),
      [
        "import { ResizeWorker as ModuleResizeWorker } from '@adaptivestone/framework-module-resize/framework.js';",
        "import { ensureResizers } from '../resizer.ts';",
        'export default class ResizeWorker extends ModuleResizeWorker {',
        '  async run() { ensureResizers(); return super.run(); }',
        '}',
        '',
      ].join('\n'),
    );
    const { code } = await run(['--check']);
    assert.equal(code, 0);
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

describe('runScaffold — --agents pointer', () => {
  const START = '<!-- framework-module-resize:agents:start -->';
  const POINTER_PATH =
    'node_modules/@adaptivestone/framework-module-resize/AGENTS.md';

  test('default run creates AGENTS.md with the marked pointer', async () => {
    const { code, out } = await run([]);
    assert.equal(code, 0);
    assert.match(out, /AGENTS\.md/);
    const doc = await read('AGENTS.md');
    assert.ok(doc.includes(START));
    assert.ok(doc.includes(POINTER_PATH));
    assert.ok(doc.includes('framework-module-resize:agents:end'));
  });

  test('re-run is idempotent: marker detected, file byte-identical, reported skipped', async () => {
    await run([]);
    const before = await read('AGENTS.md');
    const { code, out } = await run([]);
    assert.equal(code, 0);
    assert.match(out, /exists \(skipped\)\s*AGENTS\.md/);
    assert.equal(await read('AGENTS.md'), before);
  });

  test('existing host AGENTS.md is appended to, never rewritten', async () => {
    await writeFile(
      join(root, 'AGENTS.md'),
      '# Host rules\n\nDo not break prod.\n',
    );
    const { code, out } = await run([]);
    assert.equal(code, 0);
    assert.match(out, /appended\s*AGENTS\.md/);
    const doc = await read('AGENTS.md');
    assert.ok(doc.startsWith('# Host rules')); // host content stays first and intact
    assert.match(doc, /Do not break prod\./);
    assert.ok(doc.includes(START));
  });

  test('--agents claude targets CLAUDE.md instead', async () => {
    const { code } = await run(['--agents', 'claude']);
    assert.equal(code, 0);
    assert.equal(await exists('AGENTS.md'), false);
    assert.ok((await read('CLAUDE.md')).includes(START));
  });

  test('--agents print writes no file and prints the snippet', async () => {
    const { code, out } = await run(['--agents', 'print']);
    assert.equal(code, 0);
    assert.equal(await exists('AGENTS.md'), false);
    assert.ok(out.includes(START));
    assert.ok(out.includes(POINTER_PATH));
  });

  test('--agents skip writes no file and prints no snippet', async () => {
    const { code, out } = await run(['--agents', 'skip']);
    assert.equal(code, 0);
    assert.equal(await exists('AGENTS.md'), false);
    assert.ok(!out.includes(START));
  });

  test('invalid --agents value → usage + exit 1, nothing written', async () => {
    const { code, out } = await run(['--agents', 'bogus']);
    assert.equal(code, 1);
    assert.match(out, /resize-scaffold/); // usage text
    assert.equal(await exists('src'), false);
    assert.equal(await exists('AGENTS.md'), false);
  });

  test('--force does not rewrite an existing pointer block', async () => {
    await run([]);
    const before = await read('AGENTS.md');
    const { out } = await run(['--force']);
    assert.match(out, /exists \(skipped\)\s*AGENTS\.md/);
    assert.equal(await read('AGENTS.md'), before);
  });

  test('--eager runs also get the pointer', async () => {
    const { code } = await run(['--eager']);
    assert.equal(code, 0);
    assert.ok((await read('AGENTS.md')).includes(START));
  });

  test('--check ignores the pointer entirely (no write, no failure without it)', async () => {
    await run(['--agents', 'skip']); // scaffold WITHOUT a pointer
    const { code } = await run(['--check']);
    assert.equal(code, 0); // absence of the pointer must never fail a host CI
    assert.equal(await exists('AGENTS.md'), false); // and --check never writes one
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

  test('package.json bin points at dist/framework/scaffold/command.js', async () => {
    const pkg = JSON.parse(
      await readFile(
        fileURLToPath(new URL('../../../package.json', import.meta.url)),
        'utf8',
      ),
    );
    assert.equal(
      pkg.bin['resize-scaffold'],
      './dist/framework/scaffold/command.js',
    );
  });
});

describe('scaffolded ResizeWorker command', () => {
  test('loads src/resizer.ts before the module worker starts', async () => {
    await run([]);
    // The temp root cannot resolve the package name; point the shim at this checkout's command.
    const moduleCommand = pathToFileURL(
      fileURLToPath(new URL('../index.ts', import.meta.url)),
    ).href;
    const shim = (await read(COMMAND)).replace(
      '@adaptivestone/framework-module-resize/framework.js',
      moduleCommand,
    );
    await writeFile(join(root, COMMAND), shim);
    await writeFile(join(root, 'package.json'), '{ "type": "module" }\n');
    // Stand-in construction site: records that it ran.
    await writeFile(
      join(root, RESIZER),
      'Object.assign(globalThis, { resizeSiteLoaded: true });\nexport {};\n',
    );
    const flags = globalThis as { resizeSiteLoaded?: boolean };
    let loadedWhenWorkerStarted: boolean | undefined;
    setAppInstance({
      // runResizeWorker reads the config first; worker.enabled is false, so it returns there.
      getConfig: () => {
        loadedWhenWorkerStarted = flags.resizeSiteLoaded;
        return { ...defaultResizeConfig, mediaModelName: 'File' };
      },
      getModel: () => undefined,
      logger: { info() {}, warn() {}, error() {} },
    } as never);
    try {
      const { default: Command } = await import(
        pathToFileURL(join(root, COMMAND)).href
      );
      assert.equal(await new Command({}, {}, {}).run(), true);
      assert.equal(loadedWhenWorkerStarted, true);
    } finally {
      delete flags.resizeSiteLoaded;
    }
  });
});
