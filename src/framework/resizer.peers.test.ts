import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';

const runNode = promisify(execFile);

// Each process gets a fresh module cache, so installed SDKs elsewhere in the suite do not hide
// the missing-peer path. Resolution hooks leave node_modules and other implementers' files alone.
async function failedDriverImport(
  driver: 's3' | 'sqs',
  missing: string,
  code = 'ERR_MODULE_NOT_FOUND',
  message = `Cannot find package '${missing}' imported from driver`,
) {
  const { stdout } = await runNode(process.execPath, [
    '--experimental-strip-types',
    '--input-type=module',
    '-e',
    `
      import { registerHooks } from 'node:module';
      import { setAppInstance } from '@adaptivestone/framework/helpers/appInstance.js';
      import { FrameworkResizer } from ${JSON.stringify(new URL('./resizer.ts', import.meta.url).href)};
      import { makeResizeConfig } from ${JSON.stringify(new URL('../testHelpers/resizeConfig.ts', import.meta.url).href)};
      import { ResizeSetupError } from ${JSON.stringify(new URL('../errors.ts', import.meta.url).href)};
      const original = Object.assign(new Error(${JSON.stringify(message)}), { code: ${JSON.stringify(code)} });
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === ${JSON.stringify(missing)} && context.parentURL?.endsWith('/drivers/${driver}.ts')) {
            throw original;
          }
          return nextResolve(specifier, context);
        },
      });
      const config = makeResizeConfig({
        storage: ${driver === 's3' ? "{ driver: 's3', bucketPublic: 'cdn' }" : "{ driver: 'local', rootDir: './media', publicBaseUrl: '/media' }"},
        queue: ${driver === 'sqs' ? "{ driver: 'sqs', queueUrl: 'https://sqs.example/resize' }" : 'false'},
      });
      setAppInstance({
        getConfig: () => config,
        logger: { info() {}, warn() {}, error() {} },
      });
      const resizer = new FrameworkResizer({ configName: 'resizeListings' });
      try {
        await resizer.ready();
        console.log(JSON.stringify({ resolved: true }));
      } catch (error) {
        console.log(JSON.stringify({
          setupError: error instanceof ResizeSetupError,
          code: error.code,
          message: error.message,
          sameError: error === original,
          sameCause: error.cause === original,
        }));
      }
    `,
  ]);
  return JSON.parse(stdout);
}

for (const [driver, peers] of [
  ['s3', ['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner']],
  ['sqs', ['@aws-sdk/client-sqs']],
] as const) {
  for (const peer of peers) {
    test(`${driver}: missing ${peer} names the config and installation remedy`, async () => {
      const error = await failedDriverImport(driver, peer);
      assert.equal(error.setupError, true);
      assert.equal(error.code, 'RESIZE_PEER_MISSING');
      assert.equal(error.sameCause, true);
      assert.match(error.message, /src\/config\/resizeListings\.ts/);
      assert.ok(error.message.includes(`'${driver}'`));
      assert.match(error.message, /install/);
      for (const required of peers) {
        assert.ok(error.message.includes(required));
      }
    });
  }

  test(`${driver}: unrelated missing packages and other import failures stay unchanged`, async () => {
    for (const [code, message] of [
      [
        'ERR_MODULE_NOT_FOUND',
        "Cannot find package '@aws-sdk/credential-provider-node' imported from driver",
      ],
      ['ERR_MODULE_NOT_FOUND', 'Cannot find module /drivers/missing.ts'],
      ['ERR_MODULE_NOT_FOUND', `Cannot find module '${peers[0]}/missing'`],
      ['ERR_INVALID_PACKAGE_CONFIG', `Cannot find package '${peers[0]}'`],
    ]) {
      const error = await failedDriverImport(driver, peers[0], code, message);
      assert.equal(error.sameError, true);
      assert.equal(error.setupError, false);
      assert.equal(error.code, code);
      assert.equal(error.message, message);
    }
  });
}
