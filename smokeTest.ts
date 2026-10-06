// Packaging smoke test — pairs with .github/workflows/packaging.yml.
//
// Builds dist, packs the tarball, installs it into a THROWAWAY consumer (os.tmpdir) and
// verifies the PUBLISHED package — not the TS source the `npm test` suite runs against.
// It catches dist-only breakage (rewritten relative import paths, the exports map, the
// bin) that the source suite can't see, and locks in the module's designed "loud failure"
// contract: importing the AWS-backed subpaths without their optional-peer SDKs must throw
// a module-not-found error that names the missing SDK.
//
// Repo tooling (like preBuild.ts / postBuild.ts): plain TS, run with type-stripping via
// `node smokeTest.ts` (the `smoke` npm script). Top-level await, no test framework. It is
// a ROOT file (outside tsconfig's `src` rootDir, same as preBuild/postBuild) — biome lints
// it, tsc does not type-check it.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(ROOT, 'package.json'), 'utf8'),
) as { name: string; version: string };

// --- consumer-side assertion scripts (plain ESM, run in the consumer's resolution context).
// Kept template-literal-safe: single quotes + string concatenation only, no backticks / ${}.
const CHECK_CORE = `import assert from 'node:assert/strict';

const PKG = '@adaptivestone/framework-module-resize';

// (a) main entry: exactly the expected runtime exports, and no driver class leaks into it.
const mod = await import(PKG);
const expected = [
  'formatPictureUrls',
  'getSizeKey',
  'isCatalogCovered',
  'parseSizeKey',
  'resizeMediaPaths',
  'resizeMediaSchemaFragment',
  'ResizeError',
  'ResizeSetupError',
  'ResizeConfigError',
  'ResizeMediaError',
  'ResizeStorageError',
  'ResizeSecurityError',
  'ResizeGenerateError',
  'ResizeNoOriginalError',
  'ResizeOriginalError',
  'getResizer',
  'Resizer',
  'ResizeDatabase',
  'ResizeStorage',
  'TaskQueue',
  'resetResizerForTests',
  'runWorker',
];
for (const name of expected) {
  assert.ok(name in mod, 'main entry missing export: ' + name);
}
const actual = Object.keys(mod).filter((k) => k !== 'default');
assert.equal(
  actual.length,
  expected.length,
  'main entry export count drift: got ' + actual.length + ' expected ' + expected.length,
);
assert.deepEqual([...actual].sort(), [...expected].sort(), 'main entry export surface drift');
for (const driver of [
  'MongoDatabase',
  'MongoTaskQueue',
  'mongoDatabase',
  'SqsTaskQueue',
  'S3Storage',
  'LocalFsStorage',
  'FrameworkDatabase',
  'createResizeModels',
  'ResizeTaskModel',
  'ResizeWorker',
  'runResizeWorker',
  'FrameworkResizer',
]) {
  assert.ok(!(driver in mod), 'driver/adapter must stay subpath-only, not on main entry: ' + driver);
}
assert.equal(
  'prepareQueue' in mod.Resizer.prototype,
  false,
  'Resizer.prototype.prepareQueue must not exist at runtime',
);
console.log('  ok  main entry: ' + expected.length + ' core exports, no driver leakage');
console.log('  ok  Resizer has no runtime queue preparation API');

// (b) optional AWS-backed subpaths must FAIL loudly (module-not-found naming the SDK).
const optional = [
  ['/drivers/sqs.js', '@aws-sdk/client-sqs'],
  ['/drivers/s3.js', '@aws-sdk/client-s3'],
];
for (const [sub, sdk] of optional) {
  let err = null;
  try {
    await import(PKG + sub);
  } catch (e) {
    err = e;
  }
  assert.ok(err, sub + ' should FAIL to import while its SDK is absent');
  assert.equal(err.code, 'ERR_MODULE_NOT_FOUND', sub + ' wrong error code: ' + err.code);
  assert.ok(
    String(err.message).includes(sdk),
    sub + ' error should name ' + sdk + ', got: ' + err.message,
  );
  console.log('  ok  ' + sub + ' fails loudly (missing ' + sdk + ')');
}

// (c) always-safe subpaths import successfully.
const safe = [
  ['/drivers/mongo.js', 'mongoDatabase'],
  ['/drivers/mongo.js', 'MongoDatabase'],
  ['/drivers/mongo.js', 'MongoTaskQueue'],
  ['/drivers/mongo.js', 'createResizeModels'],
  ['/drivers/fs.js', 'LocalFsStorage'],
  ['/framework.js', 'FrameworkDatabase'],
  ['/framework.js', 'ResizeTaskModel'],
  ['/framework/ResizeTaskModel.js', 'default'],
  ['/framework.js', 'ResizeWorker'],
  ['/framework.js', 'FrameworkResizer'],
  ['/framework.js', 'runResizeWorker'],
];
for (const [sub, exp] of safe) {
  const m = await import(PKG + sub);
  assert.ok(exp in m, sub + ' should export ' + exp);
  console.log('  ok  ' + sub + ' imports (exports ' + exp + ')');
}
const taskModel = await import(PKG + '/framework/ResizeTaskModel.js');
const framework = await import(PKG + '/framework.js');
const expectedFramework = [
  'FrameworkDatabase',
  'FrameworkResizer',
  'ResizeTaskModel',
  'ResizeWorker',
  'runResizeWorker',
];
assert.deepEqual(
  Object.keys(framework).sort(),
  [...expectedFramework].sort(),
  'framework entry export surface drift',
);
assert.strictEqual(taskModel.default, framework.ResizeTaskModel);
const { MongoTaskQueue, MongoDatabase } = await import(PKG + '/drivers/mongo.js');
for (const Driver of [MongoTaskQueue, MongoDatabase]) {
  assert.equal(
    'prepare' in Driver.prototype,
    false,
    Driver.name + '.prototype.prepare must not exist at runtime',
  );
}
console.log('  ok  MongoTaskQueue + MongoDatabase have no runtime preparation methods');
`;

// Runs in a consumer installed WITHOUT peer dependencies (no @adaptivestone/framework, no
// mongoose): the main entry, the config, and the fs and Mongo drivers must load, a custom driver
// extends a contract class, and a core Resizer must work.
const CHECK_FRAMEWORK_FREE = `import assert from 'node:assert/strict';

const PKG = '@adaptivestone/framework-module-resize';
const mod = await import(PKG);
const { default: defaultResizeConfig } = await import(PKG + '/config/resize.js');
const resizer = new mod.Resizer({
  config: defaultResizeConfig,
  logger: { info() {}, warn() {}, error() {} },
  storage: { download: async () => Buffer.alloc(0), upload: async () => ({}), publicUrl: () => '' },
  // A plain object of the contract's shape works as well as a subclass.
  db: {
    loadMedia: async () => null,
    appendPreviews: async () => {},
    acquireLock: async () => true,
    releaseLock: async () => {},
  },
});
assert.equal(resizer.name, 'default');
const mongo = await import(PKG + '/drivers/mongo.js');
const fs = await import(PKG + '/drivers/fs.js');
class MemoryDatabase extends mod.ResizeDatabase {
  async loadMedia() { return null; }
  async appendPreviews() {}
  async acquireLock() { return true; }
  async releaseLock() {}
}
new mod.Resizer({
  name: 'drivers',
  config: defaultResizeConfig,
  logger: { info() {}, warn() {}, error() {} },
  storage: new fs.LocalFsStorage({ rootDir: './var/media', publicBaseUrl: '/media' }),
  db: new MemoryDatabase(),
});
new mongo.MongoDatabase({ mediaModel: { findById: async () => null, findByIdAndUpdate: async () => null } });
console.log('  ok  drivers/fs.js and drivers/mongo.js load without mongoose; a custom driver extends ResizeDatabase');
let frameworkErr = null;
try {
  await import(PKG + '/framework.js');
} catch (e) {
  frameworkErr = e;
}
assert.ok(frameworkErr, '…/framework.js needs @adaptivestone/framework and should fail without it');
console.log('  ok  main entry loads and a core Resizer works without @adaptivestone/framework');
`;

const CHECK_AWS = `import assert from 'node:assert/strict';

const PKG = '@adaptivestone/framework-module-resize';

const sqs = await import(PKG + '/drivers/sqs.js');
assert.equal(typeof sqs.SqsTaskQueue, 'function', 'SqsTaskQueue should be a class');
const s3 = await import(PKG + '/drivers/s3.js');
assert.equal(typeof s3.S3Storage, 'function', 'S3Storage should be a class');
console.log('  ok  sqs + s3 subpaths import; SqsTaskQueue + S3Storage are classes');
`;

// Compiled inside the throwaway consumer so package resolution and declarations come from the
// installed tarball. These imports intentionally avoid the optional AWS-backed subpaths.
const CHECK_TYPES = `import { Resizer } from '@adaptivestone/framework-module-resize';
import {
  ResizeDatabase,
  type TaskQueue,
} from '@adaptivestone/framework-module-resize';
import {
  FrameworkDatabase,
  FrameworkResizer,
  type FrameworkResizeConfig,
} from '@adaptivestone/framework-module-resize/framework.js';
import ResizeTaskModel from '@adaptivestone/framework-module-resize/framework/ResizeTaskModel.js';
import { defaultFrameworkResizeConfig } from '@adaptivestone/framework-module-resize/config/resize.js';

// The scaffold imports the defining model file so framework codegen can detect its ancestor.
class ResizeTask extends ResizeTaskModel {}
void ResizeTask;

// The scaffolded config with its commented-out worker line enabled must stay a complete config.
const hostConfig = {
  ...defaultFrameworkResizeConfig,
  mediaModelName: 'File',
  storage: { driver: 'local', rootDir: './var/media', publicBaseUrl: '/media' },
  queue: { driver: 'database' },
  worker: { ...defaultFrameworkResizeConfig.worker, enabled: true },
} satisfies FrameworkResizeConfig;
// An environment file switching both drivers.
const productionConfig = {
  storage: { driver: 's3', bucketPublic: 'cdn', bucketPrivate: 'originals' },
  queue: { driver: 'sqs', queueUrl: 'https://sqs.example/resize', maxAttempts: 3 },
} satisfies Partial<FrameworkResizeConfig>;
// The scaffolded construction site (never called here: it would register a Resizer).
const construct = () => new FrameworkResizer({ pipelines: { default: {} } });
void [hostConfig, productionConfig, construct];
import { MongoTaskQueue } from '@adaptivestone/framework-module-resize/drivers/mongo.js';

class MemoryDatabase extends ResizeDatabase {
  async loadMedia(): Promise<null> { return null; }
  async appendPreviews(): Promise<void> {}
  async acquireLock(): Promise<boolean> { return true; }
  async releaseLock(): Promise<void> {}
}
const db: ResizeDatabase = new MemoryDatabase();
void [db, FrameworkDatabase, MongoTaskQueue];

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type ResizerHasPrepareQueue = 'prepareQueue' extends keyof Resizer ? true : false;
type QueueHasPrepare = 'prepare' extends keyof TaskQueue ? true : false;
type LockHasPrepare = 'prepare' extends keyof ResizeDatabase ? true : false;

const resizerHasPrepareQueue: Equal<ResizerHasPrepareQueue, false> = true;
const queueHasPrepare: Equal<QueueHasPrepare, false> = true;
const lockHasPrepare: Equal<LockHasPrepare, false> = true;

void [
  resizerHasPrepareQueue,
  queueHasPrepare,
  lockHasPrepare,
];
`;

/** Run a command inheriting stdio; throws (failing the smoke) on a non-zero exit. */
function run(cmd: string, args: string[], cwd: string): void {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

/** Run a command and capture stdout (trimmed). */
function capture(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
}

console.log('→ Building dist');
run('node', ['--run', 'build'], ROOT);

const scratch = mkdtempSync(join(tmpdir(), 'resize-smoke-'));
try {
  console.log('→ Packing the published tarball');
  const packOut = capture(
    'npm',
    ['pack', '--silent', '--pack-destination', scratch],
    ROOT,
  );
  const tarball = packOut
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!tarball) {
    throw new Error('npm pack did not report a tarball name');
  }
  const tarballPath = join(scratch, tarball);
  console.log(`  source: ${manifest.name}@${manifest.version} from ${ROOT}`);
  console.log(`  artifact: ${tarball}`);

  // A throwaway consumer. Install the tarball + the REQUIRED peers the import graph needs
  // at module-load time: `@adaptivestone/framework` (the ambient appInstance gateway + the
  // BaseModel the ResizeTask model extends) and `mongoose`. The AWS SDKs are OPTIONAL peers
  // and stay UNINSTALLED here on purpose — step (b) asserts the loud failure.
  const consumer = join(scratch, 'consumer');
  mkdirSync(consumer);
  console.log(
    '→ Installing the tarball + required peers into a throwaway consumer',
  );
  run('npm', ['init', '-y'], consumer);
  run(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      tarballPath,
      '@adaptivestone/framework',
      'mongoose',
    ],
    consumer,
  );

  // (a0) AGENTS.md must ship inside the installed package (package.json "files").
  const installedPackage = join(
    consumer,
    'node_modules',
    '@adaptivestone',
    'framework-module-resize',
  );
  const installedAgents = join(installedPackage, 'AGENTS.md');
  if (!existsSync(installedAgents)) {
    throw new Error('installed package is missing AGENTS.md');
  }
  console.log('  ok  AGENTS.md ships with the package');

  // Compile a real TypeScript consumer against the installed package. Use this repository's
  // pinned compiler directly; do not install or resolve another TypeScript in the consumer.
  const typescriptCompiler = join(
    ROOT,
    'node_modules',
    'typescript',
    'bin',
    'tsc',
  );
  if (!existsSync(typescriptCompiler)) {
    throw new Error(
      `repository TypeScript compiler is missing: ${typescriptCompiler}`,
    );
  }
  writeFileSync(join(consumer, 'checkTypes.mts'), CHECK_TYPES);
  writeFileSync(
    join(consumer, 'tsconfig.smoke.json'),
    JSON.stringify(
      {
        compilerOptions: {
          lib: ['ESNext'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: 'ES2022',
          typeRoots: [join(ROOT, 'node_modules', '@types')],
          types: ['node'],
        },
        files: ['./checkTypes.mts'],
      },
      null,
      2,
    ),
  );
  console.log(
    '→ Type-checking a consumer against the installed package declarations',
  );
  run(
    process.execPath,
    [typescriptCompiler, '--project', 'tsconfig.smoke.json'],
    consumer,
  );
  console.log(
    '  ok  installed declarations type-check without runtime preparation APIs',
  );

  // (a) main entry imports + exposes the core exports, (b) optional subpaths fail loudly
  // without their SDKs, (c) the always-safe subpaths import. Runs INSIDE the consumer so
  // module resolution is the consumer's, exercising the real published resolution.
  writeFileSync(join(consumer, 'checkCore.mjs'), CHECK_CORE);
  console.log(
    '→ Verifying the installed package (core surface, AWS SDKs absent)',
  );
  run('node', ['checkCore.mjs'], consumer);

  // (d) the resize-scaffold bin: emit the 4 integration files into a scratch dir, then
  // `--check` must pass (exit 0). Run from a subdir inside the consumer so npx resolves the
  // bin from the consumer's node_modules/.bin.
  const scaffoldDir = join(consumer, 'scaffold-scratch');
  mkdirSync(scaffoldDir);
  console.log('→ Running the resize-scaffold bin');
  run('npx', ['--no-install', 'resize-scaffold'], scaffoldDir);
  const scaffoldFiles = [
    'src/resizer.ts',
    'src/models/ResizeTask.ts',
    'src/commands/ResizeWorker.ts',
    'src/config/resize.ts',
  ];
  for (const rel of scaffoldFiles) {
    if (!existsSync(join(scaffoldDir, rel))) {
      throw new Error(`resize-scaffold did not emit ${rel}`);
    }
  }
  console.log(`  ok  scaffold emitted ${scaffoldFiles.length} files`);
  const agentsPointer = join(scaffoldDir, 'AGENTS.md');
  if (!existsSync(agentsPointer)) {
    throw new Error('resize-scaffold did not write the AGENTS.md pointer');
  }
  if (
    !readFileSync(agentsPointer, 'utf8').includes(
      'framework-module-resize:agents:start',
    )
  ) {
    throw new Error('AGENTS.md pointer is missing its idempotency marker');
  }
  console.log('  ok  scaffold wrote the AGENTS.md pointer');
  run('npx', ['--no-install', 'resize-scaffold', '--check'], scaffoldDir);
  console.log('  ok  resize-scaffold --check exited 0');

  // (e) install the AWS SDKs, then the sqs/s3 subpaths must import and expose their classes.
  console.log('→ Installing the AWS SDKs, re-checking the optional subpaths');
  run(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '@aws-sdk/client-s3',
      '@aws-sdk/s3-request-presigner',
      '@aws-sdk/client-sqs',
    ],
    consumer,
  );
  writeFileSync(join(consumer, 'checkAws.mjs'), CHECK_AWS);
  run('node', ['checkAws.mjs'], consumer);

  // (f) a second consumer WITHOUT peer dependencies: the main entry must not need the framework.
  const bare = join(scratch, 'framework-free');
  mkdirSync(bare);
  console.log(
    '→ Installing the tarball without peers, checking the framework-free core',
  );
  run('npm', ['init', '-y'], bare);
  run(
    'npm',
    ['install', '--no-audit', '--no-fund', '--omit=peer', tarballPath],
    bare,
  );
  writeFileSync(join(bare, 'checkFrameworkFree.mjs'), CHECK_FRAMEWORK_FREE);
  run('node', ['checkFrameworkFree.mjs'], bare);

  console.log('\n✓ Packaging smoke test passed');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
