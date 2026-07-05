#!/usr/bin/env node
// `resize-scaffold` — the package bin that vendors the resize module's integration files into a
// host project (08 · §12). It runs BEFORE any host wiring exists (chicken-and-egg: the framework
// discovers models/commands by scanning host folders, so ResizeTask + ResizeWorker must be real
// files in the host's src/). So this generator is STANDALONE: NO framework, NO getApp, NO other
// module imports — only node builtins. Paths resolve from process.cwd() (or --out <dir>).
//
// Templates live beside this file (src/scaffold/templates → dist/scaffold/templates, copied by
// postBuild), so they resolve relative to import.meta.url in BOTH the source and built layouts.
//
// House rule: a CLI procedure is functions, not a class (no stateful driver here). The programmatic
// entry `runScaffold(argv, cwd)` is a legitimate API (returns the exit code) that both the shebang
// auto-run and the tests call directly.
import { realpathSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// The host-relative destinations the generator emits into.
const RESIZER = 'src/resizer.ts';
const MODEL = 'src/models/ResizeTask.ts';
const COMMAND = 'src/commands/ResizeWorker.ts';
const CONFIG = 'src/config/resize.ts';

// Load-bearing substrings `--check` verifies (also documents what each shim MUST reference).
const RESIZER_MARKER = 'new Resizer(';
const MODEL_MARKER = 'extends ResizeTaskModel';
const COMMAND_MARKER =
  '@adaptivestone/framework-module-resize/commands/ResizeWorker.js';

// --agents pointer: make the shipped AGENTS.md discoverable from the host's own agent file.
// Append-only + marker-idempotent — the scaffold NEVER rewrites host-authored content.
const AGENTS_MODES = ['agents', 'claude', 'print', 'skip'] as const;
type AgentsMode = (typeof AGENTS_MODES)[number];

const AGENTS_START = '<!-- framework-module-resize:agents:start -->';
const AGENTS_END = '<!-- framework-module-resize:agents:end -->';
const AGENTS_SNIPPET = `${AGENTS_START}
## Image resizing

This app uses @adaptivestone/framework-module-resize. BEFORE changing resize-related code,
read the version-matched agent guide shipped with the installed package:
node_modules/@adaptivestone/framework-module-resize/AGENTS.md
${AGENTS_END}
`;

interface FileSpec {
  target: string; // host-relative path
  template: string; // template file name (in ./templates)
  transform?: (content: string) => string; // optional post-read edit (eager mode)
}

/** Templates resolve relative to THIS file → works in src (tests) and dist (postBuild copy). */
function templatePath(name: string): string {
  return fileURLToPath(new URL(`./templates/${name}`, import.meta.url));
}

async function readTemplate(name: string): Promise<string> {
  return readFile(templatePath(name), 'utf8');
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    await stat(abs);
    return true;
  } catch {
    return false;
  }
}

// Eager-mode hosts (11 · Modes) generate synchronously at upload — no queue/worker. So the emitted
// resizer.ts must NOT wire a transport: comment out the `transport:` line in place.
function commentOutTransport(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      const indent = line.slice(0, line.length - trimmed.length);
      if (trimmed.startsWith('transport:')) {
        return `${indent}// eager mode (11 · Modes): no transport — generate() runs synchronously at upload\n${indent}// ${trimmed}`;
      }
      // The MongoTransport import is now unused (its only use, the transport line, is commented) —
      // comment it too so a host tsc with noUnusedLocals stays clean.
      if (trimmed.startsWith('import { MongoTransport }')) {
        return `${indent}// eager mode (11 · Modes): MongoTransport unused (no transport)\n${indent}// ${trimmed}`;
      }
      return line;
    })
    .join('\n');
}

/** The files a run emits, given the flags. Eager mode drops the model + command shims. */
function planFiles(opts: { eject: boolean; eager: boolean }): FileSpec[] {
  const resizer: FileSpec = {
    target: RESIZER,
    template: 'resizer.ts.tpl',
    transform: opts.eager ? commentOutTransport : undefined,
  };
  const config: FileSpec = { target: CONFIG, template: 'resize.config.ts.tpl' };
  if (opts.eager) {
    return [resizer, config];
  }
  const model: FileSpec = {
    target: MODEL,
    template: opts.eject
      ? 'ResizeTask.model.full.ts.tpl'
      : 'ResizeTask.model.ts.tpl',
  };
  const command: FileSpec = {
    target: COMMAND,
    template: 'ResizeWorker.command.ts.tpl',
  };
  return [resizer, model, command, config];
}

const pad = (s: string): string => s.padEnd(16);

/** Write mode: create missing dirs, write each file only if absent (or with --force). */
async function writeFiles(
  root: string,
  specs: FileSpec[],
  force: boolean,
): Promise<number> {
  for (const spec of specs) {
    const dest = join(root, spec.target);
    const already = await fileExists(dest);
    if (already && !force) {
      console.log(`${pad('exists (skipped)')}${spec.target}`);
      continue;
    }
    let content = await readTemplate(spec.template);
    if (spec.transform) {
      content = spec.transform(content);
    }
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, content);
    console.log(`${pad(already ? 'overwrote' : 'created')}${spec.target}`);
  }
  return 0;
}

interface CheckItem {
  target: string;
  // Content validator; omit → existence-only (config is meant to diverge, so it is not diffed).
  validate?: (content: string) => boolean;
}

/** Check mode (CI-gatable): verify the shims exist + reference the module. NEVER writes. */
async function checkFiles(root: string, eager: boolean): Promise<number> {
  const items: CheckItem[] = [
    { target: RESIZER, validate: (c) => c.includes(RESIZER_MARKER) },
  ];
  if (!eager) {
    items.push(
      { target: MODEL, validate: (c) => c.includes(MODEL_MARKER) },
      { target: COMMAND, validate: (c) => c.includes(COMMAND_MARKER) },
    );
  }
  items.push({ target: CONFIG }); // existence only

  let failed = false;
  for (const item of items) {
    const dest = join(root, item.target);
    if (!(await fileExists(dest))) {
      console.log(`${pad('missing')}${item.target}`);
      failed = true;
      continue;
    }
    if (item.validate) {
      const content = await readFile(dest, 'utf8');
      if (!item.validate(content)) {
        console.log(`${pad('drift')}${item.target}`);
        failed = true;
        continue;
      }
    }
    console.log(`${pad('ok')}${item.target}`);
  }
  return failed ? 1 : 0;
}

/** Pointer step (write mode only; --check never calls this). `exists (skipped)` = the marker
 * is already present — to refresh, the host deletes the marked block and re-runs. */
async function writeAgentsPointer(
  root: string,
  mode: AgentsMode,
): Promise<void> {
  if (mode === 'skip') {
    return;
  }
  if (mode === 'print') {
    console.log(
      `\nAdd this to your agent instructions file (AGENTS.md / CLAUDE.md):\n\n${AGENTS_SNIPPET}`,
    );
    return;
  }
  const target = mode === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
  const dest = join(root, target);
  const existing = (await fileExists(dest))
    ? await readFile(dest, 'utf8')
    : null;
  if (existing?.includes(AGENTS_START)) {
    console.log(`${pad('exists (skipped)')}${target}`);
    return;
  }
  const content =
    existing === null
      ? AGENTS_SNIPPET
      : `${existing.trimEnd()}\n\n${AGENTS_SNIPPET}`;
  await writeFile(dest, content);
  console.log(`${pad(existing === null ? 'created' : 'appended')}${target}`);
}

const USAGE = `resize-scaffold — vendor the resize module's integration files into a host project.

Usage: npx @adaptivestone/framework-module-resize resize-scaffold [options]

Emits (into process.cwd(), or --out <dir>):
  src/resizer.ts            construction site — new Resizer({ transport, storage, pipelines })
  src/models/ResizeTask.ts  thin shim: class ResizeTask extends ResizeTaskModel {}
  src/commands/ResizeWorker.ts  re-export of the module's worker command
  src/config/resize.ts      editable config (spreads the module defaults)

Options:
  --check      verify the shims exist + reference the module; exit 1 on missing/drift (no writes)
  --eject      write the FULL editable model instead of the shim (custom fields/indexes)
  --eager      eager-mode hosts: emit only src/resizer.ts (no transport) + src/config/resize.ts
  --force      overwrite existing files (default: never overwrite)
  --agents <m> host pointer to the shipped AGENTS.md: agents (default: append to the host
               AGENTS.md, create if missing), claude (CLAUDE.md), print (stdout only), skip.
               Append-only + marker-idempotent — never rewrites host content
  --out <dir>  project root to write into (default: current working directory)
  --help       show this help`;

/**
 * Programmatic entry (also what the shebang calls). Returns the process exit code:
 * 0 on success/clean-check, 1 on a failed --check or a usage error. Never calls process.exit.
 */
export async function runScaffold(
  argv: string[],
  cwd: string,
): Promise<number> {
  let values: {
    check?: boolean;
    eject?: boolean;
    eager?: boolean;
    force?: boolean;
    out?: string;
    help?: boolean;
    agents?: string;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      allowPositionals: true, // ignore stray positionals; strict on unknown flags
      options: {
        check: { type: 'boolean', default: false },
        eject: { type: 'boolean', default: false },
        eager: { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        out: { type: 'string' },
        help: { type: 'boolean', default: false },
        agents: { type: 'string', default: 'agents' },
      },
    }));
  } catch (err) {
    console.log(USAGE);
    console.error(`\nresize-scaffold: ${(err as Error).message}`);
    return 1;
  }

  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const agents = values.agents as string;
  if (!(AGENTS_MODES as readonly string[]).includes(agents)) {
    console.log(USAGE);
    console.error(
      `\nresize-scaffold: invalid --agents value '${agents}' (expected ${AGENTS_MODES.join('|')})`,
    );
    return 1;
  }

  // --out may be absolute or relative-to-cwd; resolve() handles both.
  const root = values.out ? resolve(cwd, values.out) : cwd;

  if (values.check) {
    return checkFiles(root, Boolean(values.eager));
  }

  const specs = planFiles({
    eject: Boolean(values.eject),
    eager: Boolean(values.eager),
  });
  const code = await writeFiles(root, specs, Boolean(values.force));
  await writeAgentsPointer(root, agents as AgentsMode);
  console.log(
    '\nDone. Next: fill the `storage` TODO in src/resizer.ts, set `mediaModelName` in',
  );
  console.log(
    'src/config/resize.ts, and `import ./resizer.ts` from src/server.ts (runs in every process).',
  );
  return code;
}

// Auto-run ONLY when executed directly as the bin (realpath-safe), not when imported by tests.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runScaffold(process.argv.slice(2), process.cwd()).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
