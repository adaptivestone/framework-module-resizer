import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import defaultFolders from '@adaptivestone/framework/folderConfig.js';
import { resetAppInstance } from '@adaptivestone/framework/helpers/appInstance.js';
import Server from '@adaptivestone/framework/server.js';
import { getProcessConfig, getResizeConfig } from '../framework/config.ts';
import { runScaffold } from '../framework/scaffold/command.ts';

// The scaffolded config imports the defaults from the built …/framework.js.
const skip = existsSync(
  new URL('../../dist/framework/defaults.js', import.meta.url),
)
  ? false
  : 'Requires dist/framework/defaults.js; run npm run build to enable this integration test';

let root: string | undefined;
let previousEnv: string | undefined;
afterEach(async () => {
  resetAppInstance();
  if (previousEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = previousEnv;
  }
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

/**
 * A host project scaffolded with `flags`, its `resize.production.ts` holding `override`, loaded by
 * a real framework Server in production mode.
 */
async function loadScaffold(flags: string[], override: string): Promise<void> {
  previousEnv = process.env.NODE_ENV;
  root = await mkdtemp(join(tmpdir(), 'resize-framework-config-'));
  const linkedPackage = join(
    root,
    'node_modules/@adaptivestone/framework-module-resize',
  );
  await mkdir(dirname(linkedPackage), { recursive: true });
  await symlink(
    resolve(fileURLToPath(new URL('../..', import.meta.url))),
    linkedPackage,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.equal(await runScaffold([...flags, '--agents', 'skip'], root), 0);
  await writeFile(
    join(root, 'src/config/resize.production.ts'),
    `export default ${override};\n`,
  );
  process.env.NODE_ENV = 'production';
  const server = new Server({
    ...defaultFolders,
    folders: { ...defaultFolders.folders, config: join(root, 'src/config') },
  } as never);
  await server.init({ isSkipModelInit: true, isSkipModelLoading: true });
}

test('the Framework loads the scaffold bridge and merges the environment override', {
  skip,
}, async () => {
  // The queue scaffold: its config imports both defaults from …/framework.js and writes the full
  // worker section, which the environment file below switches on field by field.
  await loadScaffold([], "{ formats: ['webp'], worker: { enabled: true } }");
  const resolved = getResizeConfig();
  assert.deepEqual(resolved.image.formats, ['webp']);
  assert.deepEqual(resolved.image.upload.formats, [
    'jpeg',
    'png',
    'webp',
    'avif',
    'gif',
    'svg',
  ]);
  assert.equal(resolved.mediaModelName, 'File');
  assert.equal(resolved.queue, 'default');
  const processConfig = getProcessConfig();
  assert.deepEqual(processConfig.worker, {
    enabled: true,
    sharpConcurrency: 1,
    sharpCache: false,
  });
  assert.deepEqual([...processConfig.queues.keys()], ['default']);
  assert.equal(processConfig.queues.get('default')?.section.driver, 'database');
});

test('an eager scaffold switches the worker on from an environment file that sets only worker.enabled', {
  skip,
}, async () => {
  // The eager config has no worker section: the override's one key merges into nothing, and
  // the missing keys come from defaultWorkerOptions.
  await loadScaffold(['--eager'], '{ worker: { enabled: true } }');
  const processConfig = getProcessConfig();
  assert.deepEqual(processConfig.worker, {
    enabled: true,
    sharpConcurrency: 1,
    sharpCache: false,
  });
  assert.equal(processConfig.queues.size, 0);
  assert.equal(getResizeConfig().queue, undefined);
});
