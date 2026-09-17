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
  'ResizeWorker',
  'defaultResizeConfig',
  'getResizeConfig',
  'requiredFormats',
  'calculateResizedDimensions',
  'formatPictureUrls',
  'getFilterSig',
  'getImageContentType',
  'getPreviewIdentity',
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
  'ResizeTaskModel',
  'getResizer',
  'Resizer',
  'resetResizerForTests',
  'processTask',
  'runResizeWorker',
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
  'MongoTransport',
  'SqsTransport',
  'S3Storage',
  'LocalFsStorage',
  'FrameworkMediaStore',
  'FrameworkLockProvider',
]) {
  assert.ok(!(driver in mod), 'driver must stay subpath-only, not on main entry: ' + driver);
}
assert.equal(
  typeof mod.Resizer.prototype.prepareQueue,
  'function',
  'Resizer.prototype.prepareQueue must exist at runtime',
);
console.log('  ok  main entry: ' + expected.length + ' core exports, no driver leakage');
console.log('  ok  Resizer.prototype.prepareQueue exists');

// (b) optional AWS-backed subpaths must FAIL loudly (module-not-found naming the SDK).
const optional = [
  ['/transports/sqs.js', '@aws-sdk/client-sqs'],
  ['/storage/s3.js', '@aws-sdk/client-s3'],
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
  ['/transports/mongo.js', 'MongoTransport'],
  ['/storage/fs.js', 'LocalFsStorage'],
  ['/mediaStore/framework.js', 'FrameworkMediaStore'],
  ['/locks/framework.js', 'FrameworkLockProvider'],
  ['/config/resize.js', 'getResizeConfig'],
  ['/models/ResizeTask.js', 'default'],
  ['/commands/ResizeWorker.js', 'default'],
];
for (const [sub, exp] of safe) {
  const m = await import(PKG + sub);
  assert.ok(exp in m, sub + ' should export ' + exp);
  console.log('  ok  ' + sub + ' imports (exports ' + exp + ')');
}
const { MongoTransport } = await import(PKG + '/transports/mongo.js');
const { FrameworkLockProvider } = await import(PKG + '/locks/framework.js');
assert.equal(
  typeof MongoTransport.prototype.prepare,
  'function',
  'MongoTransport.prototype.prepare must exist at runtime',
);
assert.equal(
  typeof FrameworkLockProvider.prototype.prepare,
  'function',
  'FrameworkLockProvider.prototype.prepare must exist at runtime',
);
console.log('  ok  MongoTransport + FrameworkLockProvider runtime prepare methods exist');
`;

const CHECK_AWS = `import assert from 'node:assert/strict';

const PKG = '@adaptivestone/framework-module-resize';

const sqs = await import(PKG + '/transports/sqs.js');
assert.equal(typeof sqs.SqsTransport, 'function', 'SqsTransport should be a class');
const s3 = await import(PKG + '/storage/s3.js');
assert.equal(typeof s3.S3Storage, 'function', 'S3Storage should be a class');
console.log('  ok  sqs + s3 subpaths import; SqsTransport + S3Storage are classes');
`;

// Compiled inside the throwaway consumer so package resolution and declarations come from the
// installed tarball. These imports intentionally avoid the optional AWS-backed subpaths.
const CHECK_TYPES = `import { Resizer } from '@adaptivestone/framework-module-resize';
import type {
  LockProvider,
  QueueTransport,
} from '@adaptivestone/framework-module-resize';
import { FrameworkLockProvider } from '@adaptivestone/framework-module-resize/locks/framework.js';
import { MongoTransport } from '@adaptivestone/framework-module-resize/transports/mongo.js';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type OptionalPrepare = (() => Promise<void>) | undefined;

declare const resizer: Resizer;
declare const mongo: MongoTransport;
declare const frameworkLock: FrameworkLockProvider;

const resizerPreparation: Promise<void> = resizer.prepareQueue();
const mongoPreparation: Promise<void> = mongo.prepare();
const lockPreparation: Promise<void> = frameworkLock.prepare();

const queuePrepareType: Equal<QueueTransport['prepare'], OptionalPrepare> = true;
const lockPrepareType: Equal<LockProvider['prepare'], OptionalPrepare> = true;
const queuePrepareIsOptional: {} extends Pick<QueueTransport, 'prepare'> ? true : false = true;
const lockPrepareIsOptional: {} extends Pick<LockProvider, 'prepare'> ? true : false = true;

void [
  resizerPreparation,
  mongoPreparation,
  lockPreparation,
  queuePrepareType,
  lockPrepareType,
  queuePrepareIsOptional,
  lockPrepareIsOptional,
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
    '  ok  installed declarations type-check prepareQueue + optional/concrete prepare methods',
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
      'sqs-consumer',
    ],
    consumer,
  );
  writeFileSync(join(consumer, 'checkAws.mjs'), CHECK_AWS);
  run('node', ['checkAws.mjs'], consumer);

  console.log('\n✓ Packaging smoke test passed');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
