import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import defaultFolders from '@adaptivestone/framework/folderConfig.js';
import { resetAppInstance } from '@adaptivestone/framework/helpers/appInstance.js';
import Server from '@adaptivestone/framework/server.js';
import { getResizeConfig } from '../resizeConfig.ts';
import { runScaffold } from '../scaffold/command.ts';

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
  }
});

test('the Framework loads the scaffold bridge and merges the environment override', async () => {
  previousEnv = process.env.NODE_ENV;
  root = await mkdtemp(join(tmpdir(), 'resize-framework-config-'));
  const linkedPackage = join(
    root,
    'node_modules/@adaptivestone/framework-module-resize',
  );
  await mkdir(dirname(linkedPackage), { recursive: true });
  await symlink(
    resolve(fileURLToPath(new URL('../../', import.meta.url))),
    linkedPackage,
    'dir',
  );
  assert.equal(await runScaffold(['--eager', '--agents', 'skip'], root), 0);
  await writeFile(
    join(root, 'src/config/resize.production.ts'),
    `export default { formats: ['webp'], worker: { enabled: true } };\n`,
  );
  process.env.NODE_ENV = 'production';
  const server = new Server({
    ...defaultFolders,
    folders: { ...defaultFolders.folders, config: join(root, 'src/config') },
  } as never);
  await server.init({ isSkipModelInit: true, isSkipModelLoading: true });
  const resolved = getResizeConfig();
  assert.deepEqual(resolved.formats, ['webp']);
  assert.equal(resolved.worker.enabled, true);
  assert.deepEqual(resolved.upload.formats, [
    'jpeg',
    'png',
    'webp',
    'avif',
    'gif',
    'svg',
  ]);
  assert.equal(resolved.mediaModelName, 'File');
});
