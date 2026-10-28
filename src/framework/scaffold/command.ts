#!/usr/bin/env node
// `resize-scaffold` — the package bin that vendors the resize module's integration files into a
// host project. It runs BEFORE any host wiring exists (chicken-and-egg: the framework
// discovers models/commands by scanning host folders, so ResizeTask + ResizeWorker must be real
// files in the host's src/). So this generator is STANDALONE: NO framework, NO getApp, NO other
// module imports — only node builtins. Paths resolve from process.cwd() (or --out <dir>).
//
// Templates live beside this file (src/framework/scaffold/templates → dist/framework/scaffold/templates, copied by
// postBuild), so they resolve relative to import.meta.url in BOTH the source and built layouts.
//
// House rule: a CLI procedure is functions, not a class (no stateful driver here). The programmatic
// entry `runScaffold(argv, cwd)` is a legitimate API (returns the exit code) that both the shebang
// auto-run and the tests call directly.
import { realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// The host-relative destinations the generator emits into.
const RESIZER = 'src/resizer.ts';
const MODEL = 'src/models/ResizeTask.ts';
const COMMAND = 'src/commands/ResizeWorker.ts';
const CONFIG = 'src/config/resize.ts';

// Load-bearing substrings `--check` verifies (also documents what each shim MUST reference).
// A construction site builds its Resizer through the framework adapter or the core class.
const RESIZER_MARKERS = ['new FrameworkResizer(', 'new Resizer('];
// The model shim imports the defining file so framework codegen can parse its BaseModel ancestor.
const MODEL_MARKERS = [
  'extends ResizeTaskModel',
  '@adaptivestone/framework-module-resize/framework/ResizeTaskModel.js',
];
// An ejected model (`--eject`) owns its schema: a full BaseModel subclass with the task fields
// the current driver writes. startedAt and finishedAt are among them although the driver works
// without them: a model that lacks them loses the times silently, so it is drift. The patterns
// match schema declarations however the host formats them, and not the gate index's partial
// filter (`active: true`).
const EJECTED_MODEL_MARKERS = [
  'extends BaseModel',
  '@adaptivestone/framework/modules/BaseModel.js',
];
const EJECTED_MODEL_FIELDS = [
  /\bresizer:\s*\{\s*type:/,
  /\bqueue:\s*\{\s*type:/,
  /\bavailableAt:\s*\{\s*type:/,
  /\bactive:\s*\{\s*type:/,
  /\bcooldownUntil:\s*\{\s*type:/,
  /\bstartedAt:\s*\{\s*type:/,
  /\bfinishedAt:\s*\{\s*type:/,
];
// The worker command imports the construction site AND re-exports the module's command, so the
// worker process has the Resizers its tasks name (a bare re-export starts with none).
const COMMAND_MARKERS = [
  '@adaptivestone/framework-module-resize/framework.js',
  'ResizeWorker',
  '../resizer',
];

// The config shape before 0.3.0, which this version rejects: a top-level `queue` object, and the
// defaults imported from …/config/resize.js. Only full-line `//` comments are skipped; nothing
// else is parsed out (a block comment or a trailing comment is still checked).
const OLD_DEFAULTS_IMPORT =
  /\bimport\s*\{[^}]*\bdefaultFrameworkResizeConfig\b[^}]*\}\s*from\s*['"]@adaptivestone\/framework-module-resize\/config\/resize\.js['"]/;
const QUEUE_OBJECT = /(?<![\w$])(['"]?)queue\1\s*:\s*\{/g;

/** `content` without its full-line `//` comments. */
const withoutLineComments = (content: string): string =>
  content
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

/**
 * The brace depth at each offset of `code`. Braces inside a string (such as a URL template) or a
 * comment do not count, and a quote inside a comment opens no string. Depth 1 is the config
 * object's own keys.
 */
function braceDepths(code: string): number[] {
  const depths = new Array<number>(code.length);
  let depth = 0;
  // What the scanner is inside: a string (its quote), a `//` or a `/* */` comment, or code.
  let inside: string | undefined;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    depths[i] = depth;
    if (inside === '//') {
      if (ch === '\n') {
        inside = undefined;
      }
    } else if (inside === '/*') {
      if (ch === '*' && code[i + 1] === '/') {
        depths[i + 1] = depth;
        i += 1;
        inside = undefined;
      }
    } else if (inside) {
      if (ch === '\\') {
        depths[i + 1] = depth;
        i += 1;
      } else if (ch === inside) {
        inside = undefined;
      }
    } else if (ch === '/' && (code[i + 1] === '/' || code[i + 1] === '*')) {
      inside = `/${code[i + 1]}`;
      depths[i + 1] = depth;
      i += 1;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      inside = ch;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
    }
  }
  return depths;
}

/** Whether a config file's code is in the old shape. A `queue` entry inside `queues` is not. */
function isOldConfigShape(content: string): boolean {
  const code = withoutLineComments(content);
  if (OLD_DEFAULTS_IMPORT.test(code)) {
    return true;
  }
  const depths = braceDepths(code);
  for (const match of code.matchAll(QUEUE_OBJECT)) {
    if (depths[match.index] === 1) {
      return true;
    }
  }
  return false;
}

// The process file's environment overrides (resize.<NODE_ENV>.ts), which the framework merges
// into it. Another Resizer's `configName` file is not known here, so it is not checked.
const CONFIG_OVERRIDE = /^resize\.[^.]+\.ts$/;

const OLD_CONFIG_HINT =
  "uses the old config shape — define each queue once as queues: { default: { driver: 'database' } }, set queue: 'default' (a name), and import defaultFrameworkResizeConfig and defaultWorkerOptions from @adaptivestone/framework-module-resize/framework.js (CHANGELOG 0.3.0); or move the file aside, re-run resize-scaffold and copy your settings back (only full-line // comments are skipped; a configName file of another Resizer is not checked)";

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
  transform?: (content: string) => string; // optional post-read edit
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

/**
 * The files a run emits, given the flags. Eager mode drops the model + command shims and the
 * config's `queue`, `queues` and `worker`; the construction site is the same in both modes (the
 * config holds the drivers).
 */
function planFiles(opts: { eject: boolean; eager: boolean }): FileSpec[] {
  const resizer: FileSpec = { target: RESIZER, template: 'resizer.ts.tpl' };
  const config: FileSpec = {
    target: CONFIG,
    template: opts.eager
      ? 'resize.config.eager.ts.tpl'
      : 'resize.config.ts.tpl',
  };
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
  // Content validator; omit → existence-only. The config is meant to diverge, so it is not
  // diffed: it is checked only for the old shape.
  validate?: (content: string) => boolean;
  hint?: string; // printed after a drift line
}

/** Check mode (CI-gatable): verify the shims exist + reference the module. NEVER writes. */
async function checkFiles(root: string, eager: boolean): Promise<number> {
  const items: CheckItem[] = [
    {
      target: RESIZER,
      validate: (c) => RESIZER_MARKERS.some((marker) => c.includes(marker)),
    },
  ];
  if (!eager) {
    items.push(
      {
        target: MODEL,
        validate: (c) =>
          MODEL_MARKERS.every((marker) => c.includes(marker)) ||
          (EJECTED_MODEL_MARKERS.every((marker) => c.includes(marker)) &&
            EJECTED_MODEL_FIELDS.every((field) => field.test(c))),
        hint: 'must extend ResizeTaskModel from @adaptivestone/framework-module-resize/framework/ResizeTaskModel.js (or be an ejected BaseModel with resizer, queue, availableAt, active, cooldownUntil, startedAt and finishedAt fields) — delete the file and re-run resize-scaffold for a fresh shim; for an ejected model, port the resizer, queue, availableAt, active, cooldownUntil, startedAt and finishedAt fields (and the gate index), or delete the file and re-run resize-scaffold --eject',
      },
      {
        target: COMMAND,
        validate: (c) => COMMAND_MARKERS.every((marker) => c.includes(marker)),
        hint: 'must import ../resizer.ts and export the module command — delete it and re-run resize-scaffold',
      },
    );
  }
  items.push({
    target: CONFIG,
    validate: (c) => !isOldConfigShape(c),
    hint: OLD_CONFIG_HINT,
  });
  // The old `queue` object most often lives in an environment override, so those are checked too.
  const overrides = await readdir(join(root, dirname(CONFIG))).catch(
    () => [] as string[],
  );
  for (const file of overrides
    .filter((name) => CONFIG_OVERRIDE.test(name))
    .sort()) {
    items.push({
      target: `${dirname(CONFIG)}/${file}`,
      validate: (c) => !isOldConfigShape(c),
      hint: OLD_CONFIG_HINT,
    });
  }

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
        console.log(
          `${pad('drift')}${item.target}${item.hint ? ` — ${item.hint}` : ''}`,
        );
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
  src/resizer.ts            construction site — new FrameworkResizer({ pipelines, hooks })
  src/models/ResizeTask.ts  thin shim: class ResizeTask extends ResizeTaskModel {}
  src/commands/ResizeWorker.ts  imports src/resizer.ts and re-exports the module's worker command
  src/config/resize.ts      media model, storage, the queue name, \`queues\`, \`worker\` (worker.enabled)
                            and overrides (framework merges environment files)

Options:
  --check      verify the shims exist + reference the module (and the worker command imports
               src/resizer.ts, and src/config/resize.ts and its resize.<NODE_ENV>.ts overrides
               are not in the old shape: no top-level \`queue\` object; only full-line //
               comments are skipped); exit 1 on missing/drift (no writes)
  --eject      write the FULL editable model instead of the shim (custom fields/indexes)
  --eager      eager-mode hosts: emit only src/resizer.ts + src/config/resize.ts (local storage, no queue)
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
  if (values.eager) {
    console.log(
      '\nDone. Next: set `mediaModelName` in src/config/resize.ts, import src/resizer.ts where',
    );
    console.log(
      'you need the Resizer (a static import is fine), then call generate() at upload.',
    );
  } else {
    console.log(
      '\nDone. Next: set `mediaModelName` (and check `storage`) in src/config/resize.ts, create',
    );
    console.log(
      'the ResizeTask and Lock indexes through your migrations, and import src/resizer.ts where you',
    );
    console.log(
      'need the Resizer (a static import is fine). The ResizeWorker command imports it too.',
    );
    console.log(
      "`queues` in src/config/resize.ts defines the 'default' queue (driver 'database', or 'sqs');",
    );
    console.log(
      'set worker.enabled — worker: { enabled: true } in src/config/resize.ts or an environment file — for the worker to run.',
    );
  }
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
