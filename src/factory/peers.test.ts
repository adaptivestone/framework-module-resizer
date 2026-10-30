// createResizer with an optional AWS SDK missing. Each case runs in its own Node process, whose
// resolve hook makes the package missing (for import.meta.resolve and import() alike) and records
// every specifier resolved, so an SDK installed for the rest of the suite cannot hide the path.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';

const runNode = promisify(execFile);

const href = (path: string) =>
  JSON.stringify(new URL(path, import.meta.url).href);

/**
 * Run `body` (module code that ends by printing one JSON line) in a child process where `missing`
 * cannot be resolved. `resolved` (the specifiers resolved so far) and `driverFiles` (the resolved
 * driver modules) are in scope, with createResizer, the fakes, workUntil, sharp and a test image.
 */
async function inChild(
  missing: string | undefined,
  body: string,
): Promise<Record<string, unknown>> {
  const { stdout } = await runNode(process.execPath, [
    '--experimental-strip-types',
    '--input-type=module',
    '-e',
    `
      import { registerHooks } from 'node:module';
      const missing = ${JSON.stringify(missing ?? null)};
      const resolved = [];
      const driverFiles = [];
      registerHooks({
        resolve(specifier, context, nextResolve) {
          resolved.push(specifier);
          if (specifier === missing) {
            throw Object.assign(new Error("Cannot find package '" + missing + "' imported from " + context.parentURL), { code: 'ERR_MODULE_NOT_FOUND' });
          }
          const result = nextResolve(specifier, context);
          if (/\\/drivers\\/.*\\.ts$/.test(result.url)) {
            driverFiles.push(result.url.replace(/^.*\\/src\\//, ''));
          }
          return result;
        },
      });
      const { default: sharp } = await import('sharp');
      const { createResizer } = await import(${href('./createResizer.ts')});
      const fakes = await import(${href('../testHelpers/fakes.ts')});
      const { workUntil } = await import(${href('../testHelpers/work.ts')});
      const silent = fakes.silentLogger;
      const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#3366cc' } }).png().toBuffer();
      const sizes = [{ width: 16, height: 16 }];
      const errorOf = async (promise) => {
        try {
          await promise;
          return null;
        } catch (error) {
          return { code: error.code, message: error.message };
        }
      };
      ${body}
    `,
  ]);
  return JSON.parse(stdout.trim().split('\n').at(-1) as string);
}

const WHERE = 'the config passed to createResizer()';

test('s3 storage without @aws-sdk/client-s3: first use and verify() reject with RESIZE_PEER_MISSING naming the config passed to createResizer(); resolve() returns the empty decision', async () => {
  const seen = await inChild(
    '@aws-sdk/client-s3',
    `
      const resizer = createResizer(
        { storage: { driver: 's3', bucketPublic: 'cdn' } },
        { media: fakes.fakeMedia(), logger: silent },
      );
      const ready = await errorOf(resizer.ready());
      const verify = await errorOf(resizer.verify());
      const read = await resizer.resolve({
        media: { id: 'm1', original: { storageRef: { key: 'k' }, format: 'png' } },
        sizes,
      });
      const { builtinDrivers, probeDriver } = await import(${href('./builtins.ts')});
      const probe = probeDriver(builtinDrivers.storage.s3, 's3', 'the test');
      console.log(JSON.stringify({ ready, verify, decision: read.decision, driverFiles, missing: probe.missing }));
    `,
  );
  for (const error of [seen.ready, seen.verify] as Array<{
    code: string;
    message: string;
  }>) {
    assert.equal(error.code, 'RESIZE_PEER_MISSING');
    assert.ok(error.message.includes(`'s3' driver selected in ${WHERE}`));
    assert.ok(error.message.includes('@aws-sdk/client-s3'));
    assert.ok(error.message.includes('@aws-sdk/s3-request-presigner'));
  }
  assert.deepEqual(seen.decision, { ready: [], missing: [] });
  // Only the package that cannot be found is reported missing, not every peer of the driver.
  assert.deepEqual(seen.missing, ['@aws-sdk/client-s3']);
  // The probe needs no driver module.
  assert.deepEqual(seen.driverFiles, []);
});

test('an sqs own queue without @aws-sdk/client-sqs: RESIZE_PEER_MISSING naming queues.<name>', async () => {
  const seen = await inChild(
    '@aws-sdk/client-sqs',
    `
      const resizer = createResizer(
        { queues: { default: { driver: 'sqs', queueUrl: 'https://sqs.example/resize' } } },
        { storage: fakes.memoryStorage().storage, media: fakes.fakeMedia(), logger: silent },
      );
      const ready = await errorOf(resizer.ready());
      const verify = await errorOf(resizer.verify());
      console.log(JSON.stringify({ ready, verify, driverFiles }));
    `,
  );
  for (const error of [seen.ready, seen.verify] as Array<{
    code: string;
    message: string;
  }>) {
    assert.equal(error.code, 'RESIZE_PEER_MISSING');
    assert.ok(
      error.message.includes(
        `'sqs' driver selected in \`queues.default\` in ${WHERE}`,
      ),
      error.message,
    );
    assert.ok(error.message.includes('@aws-sdk/client-sqs'));
  }
  assert.deepEqual(seen.driverFiles, []);
});

test('a database Resizer beside an sqs queue without its SDK: database reads, enqueue and the worker work; bulk is RESIZE_QUEUE_NOT_SERVED; drivers/sqs.ts is never resolved', async () => {
  const seen = await inChild(
    '@aws-sdk/client-sqs',
    `
      const fake = fakes.fakeDatabaseDriver();
      const resizer = createResizer(
        {
          formats: ['webp'],
          database: { driver: 'fake' },
          queues: {
            default: { driver: 'database', idlePollMs: 5 },
            bulk: { driver: 'sqs', queueUrl: 'https://sqs.example/bulk' },
          },
        },
        { drivers: { database: { fake } }, storage: fakes.memoryStorage().storage, logger: silent },
      );
      await resizer.verify();
      const original = await resizer.uploadOriginal({ body: png, visibility: 'private' });
      const media = { id: 'm1', original, previews: [] };
      fake.docs.set('m1', media);
      const onDefault = await resizer.prewarm({ media, sizes });
      const onBulk = await resizer.prewarm({ media, sizes, queue: 'bulk' });
      await workUntil({ resizers: [resizer], logger: silent }, () => media.previews.length === 1);
      const read = await resizer.resolve({ media, sizes });
      const bulkWorker = await errorOf(
        workUntil({ queue: 'bulk', resizers: [resizer], logger: silent }, () => false),
      );
      console.log(JSON.stringify({
        tasks: resizer.tasks.constructor.name,
        locks: resizer.locks === undefined,
        onDefault: onDefault.status,
        onBulk: { status: onBulk.status, issues: onBulk.issues.map(({ code, message, retryable }) => ({ code, message, retryable })) },
        ready: read.decision.ready.length,
        missing: read.decision.missing.length,
        bulkWorker,
        driverFiles,
        sqsResolved: resolved.filter((s) => s.startsWith('@aws-sdk/')),
      }));
    `,
  );
  assert.equal(seen.tasks, 'MemoryTaskQueue');
  assert.equal(seen.locks, true);
  assert.equal(seen.onDefault, 'accepted');
  const onBulk = seen.onBulk as {
    status: string;
    issues: Array<{ code: string; message: string; retryable: boolean }>;
  };
  assert.equal(onBulk.status, 'incomplete');
  assert.equal(onBulk.issues[0].code, 'RESIZE_QUEUE_NOT_SERVED');
  assert.equal(onBulk.issues[0].retryable, false);
  assert.ok(onBulk.issues[0].message.includes('@aws-sdk/client-sqs'));
  assert.equal(seen.ready, 1);
  assert.equal(seen.missing, 0);
  const bulkWorker = seen.bulkWorker as { code: string; message: string };
  assert.equal(bulkWorker.code, 'RESIZE_QUEUE_NOT_SERVED');
  assert.ok(bulkWorker.message.includes("'bulk'"));
  assert.ok(bulkWorker.message.includes('@aws-sdk/client-sqs'));
  assert.deepEqual(seen.driverFiles, []);
  // Only the probe asked for the SDK (by name, through the resolver), and nothing else of AWS.
  const asked = seen.sqsResolved as string[];
  assert.ok(asked.length > 0);
  assert.deepEqual([...new Set(asked)], ['@aws-sdk/client-sqs']);
});

test('an sqs own queue without its SDK beside a database queue: a worker for the database queue starts; verify() rejects with RESIZE_PEER_MISSING', async () => {
  const seen = await inChild(
    '@aws-sdk/client-sqs',
    `
      const fake = fakes.fakeDatabaseDriver();
      const resizer = createResizer(
        {
          formats: ['webp'],
          database: { driver: 'fake' },
          queue: 'default',
          queues: {
            default: { driver: 'sqs', queueUrl: 'https://sqs.example/resize' },
            bulk: { driver: 'database', idlePollMs: 5 },
          },
        },
        { drivers: { database: { fake } }, storage: fakes.memoryStorage().storage, logger: silent },
      );
      const original = await resizer.uploadOriginal({ body: png, visibility: 'private' });
      const media = { id: 'm1', original, previews: [] };
      fake.docs.set('m1', media);
      const onDefault = await resizer.prewarm({ media, sizes });
      const onBulk = await resizer.prewarm({ media, sizes, queue: 'bulk' });
      await workUntil({ queue: 'bulk', resizers: [resizer], logger: silent }, () => media.previews.length === 1);
      const verify = await errorOf(resizer.verify());
      console.log(JSON.stringify({
        databaseQueue: resizer.tasks === fake.built[0].built[0],
        locks: resizer.locks === undefined,
        onDefault: onDefault.issues.map(({ code, message }) => ({ code, message })),
        onBulk: onBulk.status,
        previews: media.previews.length,
        verify,
        driverFiles,
      }));
    `,
  );
  assert.equal(seen.databaseQueue, true);
  assert.equal(seen.locks, true);
  const onDefault = seen.onDefault as Array<{ code: string; message: string }>;
  assert.equal(onDefault[0].code, 'RESIZE_QUEUE_NOT_SERVED');
  assert.ok(onDefault[0].message.includes('@aws-sdk/client-sqs'));
  assert.equal(seen.onBulk, 'accepted');
  assert.equal(seen.previews, 1);
  const verify = seen.verify as { code: string; message: string };
  assert.equal(verify.code, 'RESIZE_PEER_MISSING');
  assert.ok(verify.message.includes('`queues.default`'));
  assert.deepEqual(seen.driverFiles, []);
});

test('local storage and a host database load no AWS module', async () => {
  const seen = await inChild(
    undefined,
    `
      const { mkdtemp, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const root = await mkdtemp(join(tmpdir(), 'resize-peers-'));
      try {
        const fake = fakes.fakeDatabaseDriver();
        const resizer = createResizer(
          {
            formats: ['webp'],
            storage: { driver: 'local', rootDir: join(root, 'public'), publicBaseUrl: '/media' },
            database: { driver: 'fake' },
            queues: { default: { driver: 'database', idlePollMs: 5 } },
          },
          { drivers: { database: { fake } }, logger: silent },
        );
        await resizer.verify();
        const original = await resizer.uploadOriginal({ body: png, visibility: 'private' });
        const media = { id: 'm1', original, previews: [] };
        fake.docs.set('m1', media);
        const warm = await resizer.prewarm({ media, sizes });
        await workUntil({ resizers: [resizer], logger: silent }, () => media.previews.length === 1);
        console.log(JSON.stringify({
          warm: warm.status,
          previews: media.previews.length,
          aws: resolved.filter((s) => s.startsWith('@aws-sdk/')),
          driverFiles,
        }));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    `,
  );
  assert.equal(seen.warm, 'accepted');
  assert.equal(seen.previews, 1);
  assert.deepEqual(seen.aws, []);
  assert.deepEqual(seen.driverFiles, ['drivers/fs.ts', 'drivers/placement.ts']);
});
