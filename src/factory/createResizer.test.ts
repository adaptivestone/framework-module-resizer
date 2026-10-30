// createResizer: one config object (or a function returning it) and the host's drivers registered
// by name build a whole Resizer. The tests register in-memory drivers (src/testHelpers/fakes.ts):
// a storage driver, a database driver whose task queue gates by task, and a plain queue driver of
// the SQS shape.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import sharp from 'sharp';
import defaultResizeConfig from '../config/resize.ts';
import {
  ResizeConfigError,
  type ResizeError,
  ResizeSetupError,
} from '../errors.ts';
import {
  getResizer,
  Resizer,
  resetResizerForTests,
  sharedPart,
} from '../resizer.ts';
import { carrierOf, RoutingTaskQueue } from '../routing.ts';
import {
  fakeDatabaseDriver,
  fakeMedia,
  fakeQueueDriver,
  MemoryTaskQueue,
  memoryStorage,
  memoryStorageDriver,
  PlainTaskQueue,
  silentLogger,
} from '../testHelpers/fakes.ts';
import { workUntil } from '../testHelpers/work.ts';
import type { MediaLike } from '../types.d.ts';
import {
  type ConfigSource,
  configuredOptions,
  createResizer,
  type ProcessSections,
} from './createResizer.ts';
import { resolveQueueEntries } from './queues.ts';

const WHERE = 'the config passed to createResizer()';
const sizes = [{ width: 16, height: 16 }];
const png = await sharp({
  create: { width: 64, height: 48, channels: 3, background: '#3366cc' },
})
  .png()
  .toBuffer();

afterEach(resetResizerForTests);

/** An error of `Class` with `code`, whose message holds every one of `parts`. */
const fails =
  (Class: typeof ResizeError, code: string, ...parts: Array<string | RegExp>) =>
  (err: unknown) => {
    assert.ok(err instanceof Class, String(err));
    assert.equal((err as ResizeError).code, code, String(err));
    for (const part of parts) {
      if (typeof part === 'string') {
        assert.ok(
          (err as Error).message.includes(part),
          `${(err as Error).message} should include ${part}`,
        );
      } else {
        assert.match((err as Error).message, part);
      }
    }
    return true;
  };

/** Upload the test image and keep its media document in `docs`. */
async function storedMedia(
  resizer: Resizer,
  docs: Map<string, MediaLike>,
  id = 'm1',
): Promise<MediaLike> {
  const original = await resizer.uploadOriginal({
    body: png,
    visibility: 'private',
  });
  const media: MediaLike = { id, original, previews: [] };
  docs.set(id, media);
  return media;
}

test('a config object and one call: custom storage and database drivers registered by name run upload, prewarm, the worker and resolve', async () => {
  const memory = memoryStorageDriver();
  const fake = fakeDatabaseDriver();
  const resizer = createResizer(
    {
      formats: ['webp'],
      storage: { driver: 'memory' },
      database: { driver: 'fake' },
      queues: { default: { driver: 'database', idlePollMs: 5 } },
    },
    {
      drivers: { storage: { memory }, database: { fake } },
      logger: silentLogger,
    },
  );
  assert.strictEqual(getResizer(), resizer);
  // Nothing is built before first use.
  assert.equal(memory.built.length, 0);
  assert.equal(fake.built.length, 0);
  const media = await storedMedia(resizer, fake.docs);
  assert.strictEqual(resizer.storage, memory.built[0]);
  assert.strictEqual(resizer.media, fake.built[0].media);
  assert.strictEqual(resizer.tasks, fake.built[0].built[0]);
  assert.equal(resizer.queueName, 'default');

  const warm = await resizer.prewarm({ media, sizes });
  assert.equal(warm.status, 'accepted');
  await workUntil(
    { resizers: [resizer], logger: silentLogger },
    () => (media.previews?.length ?? 0) === 1,
  );
  const { decision } = await resizer.resolve({ media, sizes });
  assert.equal(decision.ready.length, 1);
  assert.deepEqual(decision.missing, []);
  assert.equal(memory.built.length, 1);
  assert.equal(fake.built.length, 1);
});

test('a custom queue driver registered by name: queues on two backends route, and the plain backend is built on first need', async () => {
  const fake = fakeDatabaseDriver();
  const plain = fakeQueueDriver();
  const resizer = createResizer(
    {
      formats: ['webp'],
      storage: { driver: 'memory' },
      database: { driver: 'fake' },
      queues: {
        default: { driver: 'database', idlePollMs: 5 },
        bulk: { driver: 'plain', idlePollMs: 5 },
      },
    },
    {
      drivers: {
        storage: { memory: memoryStorageDriver() },
        database: { fake },
        queue: { plain },
      },
      logger: silentLogger,
    },
  );
  await resizer.ready();
  assert.equal(plain.built.length, 0);
  assert.ok(resizer.tasks instanceof RoutingTaskQueue);
  assert.equal(resizer.tasks.servesQueue('bulk'), true);
  const media = await storedMedia(resizer, fake.docs);

  const onDefault = await resizer.prewarm({ media, sizes });
  assert.equal(onDefault.status, 'accepted');
  assert.equal(plain.built.length, 0);
  assert.equal(fake.built[0].built[0].rows.length, 1);
  const onBulk = await resizer.prewarm({ media, sizes, queue: 'bulk' });
  assert.equal(onBulk.status, 'accepted');
  assert.equal(plain.built.length, 1);
  assert.equal(plain.built[0].rows.length, 1);
  assert.equal(plain.built[0].rows[0].task.queue, 'bulk');
  // The second call on 'bulk' uses the backend already built.
  await resizer.prewarm({
    media: { ...media, id: 'm2' },
    sizes,
    queue: 'bulk',
  });
  assert.equal(plain.built.length, 1);
});

test("a database-only Resizer gets no lock store; a router gets the database parts' lock store", async () => {
  const drivers = () => ({
    storage: { memory: memoryStorageDriver() },
    database: { fake: fakeDatabaseDriver() },
    queue: { plain: fakeQueueDriver() },
  });
  const databaseOnly = drivers();
  const single = createResizer(
    {
      storage: { driver: 'memory' },
      database: { driver: 'fake' },
      queues: { default: { driver: 'database' } },
    },
    { drivers: databaseOnly, logger: silentLogger },
  );
  await single.ready();
  assert.ok(single.tasks instanceof MemoryTaskQueue);
  assert.equal(single.locks, undefined);

  const routed = drivers();
  const twoBackends = createResizer(
    {
      storage: { driver: 'memory' },
      database: { driver: 'fake' },
      queues: {
        default: { driver: 'database' },
        bulk: { driver: 'plain' },
      },
    },
    { name: 'routed', drivers: routed, logger: silentLogger },
  );
  await twoBackends.ready();
  assert.strictEqual(twoBackends.locks, routed.database.fake.built[0].locks);

  // A single backend without gatesByTask takes the parts' lock store for its gate locks.
  const plainOnly = drivers();
  const plain = createResizer(
    {
      storage: { driver: 'memory' },
      database: { driver: 'fake' },
      queues: { default: { driver: 'plain' } },
    },
    { name: 'plain', drivers: plainOnly, logger: silentLogger },
  );
  await plain.ready();
  assert.ok(plain.tasks instanceof PlainTaskQueue);
  assert.strictEqual(plain.locks, plainOnly.database.fake.built[0].locks);

  // A router given in code gets the parts' lock store too, even when every route gates by task:
  // the core asks per call whether a carrier needs it.
  const inCode = drivers();
  const router = new RoutingTaskQueue({ default: new MemoryTaskQueue() });
  assert.equal(router.gatesByTask, true);
  const given = createResizer(
    { storage: { driver: 'memory' }, database: { driver: 'fake' } },
    { name: 'given', drivers: inCode, tasks: router, logger: silentLogger },
  );
  await given.ready();
  assert.strictEqual(given.locks, inCode.database.fake.built[0].locks);
});

test('a function config reads its database section on first use and runs upload, enqueue and the worker', async () => {
  const fake = fakeDatabaseDriver();
  let reads = 0;
  const resizer = createResizer(
    () => {
      reads += 1;
      return {
        formats: ['webp'],
        storage: { driver: 'memory' },
        database: { driver: 'fake' },
        queues: { default: { driver: 'database', idlePollMs: 5 } },
      };
    },
    {
      drivers: {
        storage: { memory: memoryStorageDriver() },
        database: { fake },
      },
      logger: silentLogger,
    },
  );
  assert.equal(reads, 0);
  assert.equal(fake.built.length, 0);
  const media = await storedMedia(resizer, fake.docs);
  assert.equal(fake.built.length, 1);
  assert.deepEqual(resizer.config.formats, ['webp']);
  const warm = await resizer.prewarm({ media, sizes });
  assert.equal(warm.status, 'accepted');
  await workUntil(
    { resizers: [resizer], logger: silentLogger },
    () => (media.previews?.length ?? 0) === 1,
  );
  const { decision } = await resizer.resolve({ media, sizes });
  assert.equal(decision.ready.length, 1);
  // The function is read once, and its value kept.
  assert.equal(reads, 1);
});

test('image settings merge over the package defaults', async () => {
  const drivers = { storage: { memory: memoryStorageDriver() } };
  const resizer = createResizer(
    { formats: ['webp'], limits: { sourcePixels: 1000 } },
    { drivers, storage: memoryStorage().storage, media: fakeMedia() },
  );
  // An object config is merged and validated at construction.
  assert.deepEqual(resizer.config.formats, ['webp']);
  assert.deepEqual(resizer.config.limits, {
    ...defaultResizeConfig.limits,
    sourcePixels: 1000,
  });
  assert.deepEqual(resizer.config.encode, defaultResizeConfig.encode);
  const lazy = createResizer(() => ({ formats: ['avif'] }), {
    name: 'lazy',
    storage: memoryStorage().storage,
    media: fakeMedia(),
  });
  await lazy.ready();
  assert.deepEqual(lazy.config.formats, ['avif']);
  assert.deepEqual(lazy.config.limits, defaultResizeConfig.limits);
  // A wrong image setting fails at construction for an object config.
  assert.throws(
    () =>
      createResizer(
        { formats: 'webp' as unknown as string[] },
        { name: 'bad', media: fakeMedia() },
      ),
    (err: unknown) =>
      err instanceof ResizeConfigError &&
      err.code === 'RESIZE_CONFIG_FORMATS_INVALID',
  );
  assert.throws(
    () => createResizer('x' as never, { name: 'bad', media: fakeMedia() }),
    fails(ResizeConfigError, 'RESIZE_CONFIG_INVALID', WHERE, 'an object'),
  );
});

test('coordination: undefined takes the defaults; null is RESIZE_CONFIG_COORDINATION_INVALID from verify() and prewarm()', async () => {
  const drivers = () => ({
    storage: { memory: memoryStorageDriver() },
    database: { fake: fakeDatabaseDriver() },
  });
  const config = {
    storage: { driver: 'memory' },
    database: { driver: 'fake' },
    queues: { default: { driver: 'database' } },
  } as const;
  const defaults = createResizer(config, {
    drivers: drivers(),
    logger: silentLogger,
  });
  await defaults.verify();
  const nulled = drivers();
  const resizer = createResizer(
    { ...config, coordination: null as never },
    { name: 'nulled', drivers: nulled, logger: silentLogger },
  );
  await assert.rejects(
    resizer.verify(),
    fails(ResizeConfigError, 'RESIZE_CONFIG_COORDINATION_INVALID'),
  );
  const media = await storedMedia(resizer, nulled.database.fake.docs);
  const warm = await resizer.prewarm({ media, sizes });
  assert.equal(warm.status, 'incomplete');
  assert.match(warm.issues[0].message, /coordination/);
  assert.equal(warm.issues[0].retryable, false);
  // A coordination option wins over the config.
  const given = createResizer(
    { ...config, coordination: null as never },
    {
      name: 'given',
      drivers: drivers(),
      coordination: { cooldownMs: 1000 },
      logger: silentLogger,
    },
  );
  await given.verify();
});

test('lanes: no queue is default when queues exist; an unknown name is RESIZE_CONFIG_QUEUE_UNKNOWN; false is eager; a queue object is RESIZE_CONFIG_REMOVED_KEY', async () => {
  const drivers = () => ({
    storage: { memory: memoryStorageDriver() },
    database: { fake: fakeDatabaseDriver() },
  });
  const base = {
    storage: { driver: 'memory' },
    database: { driver: 'fake' },
    queues: {
      default: { driver: 'database' },
      bulk: { driver: 'database' },
    },
  } as const;
  const implied = createResizer(base, { drivers: drivers() });
  await implied.ready();
  assert.equal(implied.queueName, 'default');
  assert.ok(implied.tasks);

  const bulk = createResizer(
    { ...base, queue: 'bulk' },
    { name: 'bulk', drivers: drivers() },
  );
  await bulk.ready();
  assert.equal(bulk.queueName, 'bulk');

  const unknown = createResizer(
    { ...base, queue: 'nope' },
    { name: 'unknown', drivers: drivers() },
  );
  await assert.rejects(
    unknown.ready(),
    fails(
      ResizeConfigError,
      'RESIZE_CONFIG_QUEUE_UNKNOWN',
      "Resizer 'unknown' queues to 'nope', which `queues` in the config passed to createResizer() does not define",
      'set `queue` to a defined name, or queue: false for eager only',
    ),
  );
  const noDefault = createResizer(
    { ...base, queues: { bulk: { driver: 'database' } } },
    { name: 'noDefault', drivers: drivers() },
  );
  await assert.rejects(
    noDefault.ready(),
    fails(
      ResizeConfigError,
      'RESIZE_CONFIG_QUEUE_UNKNOWN',
      `(the default when ${WHERE} sets no \`queue\`)`,
    ),
  );

  const eager = createResizer(
    { ...base, queue: false },
    { name: 'eager', drivers: drivers() },
  );
  await eager.ready();
  assert.equal(eager.tasks, undefined);
  const noQueues = createResizer(
    { storage: base.storage, database: base.database },
    { name: 'noQueues', drivers: drivers() },
  );
  await noQueues.ready();
  assert.equal(noQueues.tasks, undefined);
  assert.equal(noQueues.queueName, 'default');

  const old = createResizer(
    { ...base, queue: { driver: 'database' } as never },
    { name: 'old', drivers: drivers() },
  );
  await assert.rejects(
    old.ready(),
    fails(
      ResizeConfigError,
      'RESIZE_CONFIG_REMOVED_KEY',
      `\`queue\` in ${WHERE} is now a queue name`,
    ),
  );
  const blank = createResizer(
    { ...base, queue: ' ' },
    { name: 'blank', drivers: drivers() },
  );
  await assert.rejects(
    blank.ready(),
    fails(
      ResizeConfigError,
      'RESIZE_CONFIG_INVALID',
      `\`queue\` in ${WHERE} must be a queue name`,
    ),
  );
});

test('an unregistered storage or queue driver is RESIZE_CONFIG_INVALID listing the registered names; resolve() still never throws', async () => {
  const resizer = createResizer(
    { storage: { driver: 'gcs' } as never },
    {
      drivers: { storage: { memory: memoryStorageDriver() } },
      media: fakeMedia(),
      logger: silentLogger,
    },
  );
  await assert.rejects(
    resizer.ready(),
    fails(
      ResizeConfigError,
      'RESIZE_CONFIG_INVALID',
      `resize config: \`storage\` in ${WHERE} needs driver 'local', 's3' or 'memory'`,
    ),
  );
  const media: MediaLike = {
    id: 'm1',
    original: { storageRef: { key: 'k' }, format: 'png' },
  } as MediaLike;
  assert.deepEqual(await resizer.resolve({ media, sizes }), {
    decision: { ready: [], missing: [] },
    output: undefined,
  });

  const queued = createResizer(
    {
      queues: { default: { driver: 'database' }, bulk: { driver: 'redis' } },
    } as never,
    {
      name: 'queued',
      storage: memoryStorage().storage,
      media: fakeMedia(),
      logger: silentLogger,
    },
  );
  await assert.rejects(
    queued.ready(),
    fails(
      ResizeConfigError,
      'RESIZE_CONFIG_INVALID',
      `resize config: \`queues.bulk\` in ${WHERE} needs driver 'database' or 'sqs'`,
    ),
  );
  assert.deepEqual((await queued.resolve({ media, sizes })).decision, {
    ready: [],
    missing: [],
  });
  const database = createResizer(
    { database: { driver: 'postgres' } } as never,
    { name: 'database', storage: memoryStorage().storage },
  );
  await assert.rejects(
    database.ready(),
    fails(
      ResizeConfigError,
      'RESIZE_CONFIG_INVALID',
      `\`database\` in ${WHERE} needs driver 'mongo'`,
    ),
  );
});

test('with tasks in code, an unregistered queue driver still fails verify() through coordination', async () => {
  const resizer = createResizer(
    { queues: { default: { driver: 'redis' } } } as never,
    {
      storage: memoryStorage().storage,
      media: fakeMedia(),
      tasks: new MemoryTaskQueue(),
      logger: silentLogger,
    },
  );
  await resizer.ready();
  assert.equal(resizer.queueName, 'default');
  await assert.rejects(
    resizer.verify(),
    fails(ResizeConfigError, 'RESIZE_CONFIG_INVALID', '`queues.default`'),
  );
});

test('a drivers entry without fromConfig is RESIZE_DRIVER_INVALID at construction, and the name stays free', () => {
  for (const [drivers, named] of [
    [{ storage: { bad: {} } }, '`drivers.storage.bad`'],
    [{ database: { bad: { fromConfig: 1 } } }, '`drivers.database.bad`'],
    [{ queue: { bad: null } }, '`drivers.queue.bad`'],
    [{ queue: 'x' }, '`drivers.queue`'],
    [{ decoders: {} }, '`drivers.decoders`'],
  ] as const) {
    assert.throws(
      () =>
        createResizer(
          {},
          {
            drivers: drivers as never,
            storage: memoryStorage().storage,
            media: fakeMedia(),
          },
        ),
      (err: unknown) => {
        fails(ResizeSetupError, 'RESIZE_DRIVER_INVALID', named)(err);
        assert.equal((err as ResizeError).retryable, false);
        return true;
      },
      named,
    );
  }
  // The name was never registered.
  createResizer({}, { storage: memoryStorage().storage, media: fakeMedia() });
});

test('a driver that returns something that is not the part is RESIZE_DRIVER_INVALID at first use', async () => {
  const noPublicUrl = createResizer(
    { storage: { driver: 'odd' } },
    {
      drivers: {
        storage: {
          odd: {
            fromConfig: () =>
              ({
                upload: async () => ({}),
                download: async () => Buffer.alloc(0),
              }) as never,
          },
        },
      },
      media: fakeMedia(),
    },
  );
  await assert.rejects(
    noPublicUrl.ready(),
    fails(ResizeSetupError, 'RESIZE_DRIVER_INVALID', '`drivers.storage.odd`'),
  );
  const noReplace = createResizer(
    { database: { driver: 'odd' } },
    {
      name: 'noReplace',
      drivers: {
        database: {
          odd: {
            fromConfig: () => ({
              media: {
                loadMedia: async () => null,
                appendPreviews: async () => [],
              } as never,
            }),
          },
        },
      },
      storage: memoryStorage().storage,
    },
  );
  await assert.rejects(
    noReplace.ready(),
    fails(ResizeSetupError, 'RESIZE_DRIVER_INVALID', '`drivers.database.odd`'),
  );
  const elsewhere = createResizer(
    { queues: { default: { driver: 'odd' } } },
    {
      name: 'elsewhere',
      drivers: {
        queue: {
          odd: { fromConfig: () => new PlainTaskQueue({ queues: ['other'] }) },
        },
      },
      storage: memoryStorage().storage,
      media: fakeMedia(),
    },
  );
  await assert.rejects(
    elsewhere.ready(),
    fails(
      ResizeSetupError,
      'RESIZE_DRIVER_INVALID',
      '`drivers.queue.odd`',
      "'default'",
    ),
  );
  const notQueue = createResizer(
    { queues: { default: { driver: 'odd' } } },
    {
      name: 'notQueue',
      drivers: { queue: { odd: { fromConfig: () => ({}) as never } } },
      storage: memoryStorage().storage,
      media: fakeMedia(),
    },
  );
  await assert.rejects(
    notQueue.ready(),
    fails(ResizeSetupError, 'RESIZE_DRIVER_INVALID', '`drivers.queue.odd`'),
  );
});

test('a host driver under a built-in name wins', async () => {
  const memory = memoryStorageDriver();
  const resizer = createResizer(
    {
      storage: { driver: 'local', rootDir: './never', publicBaseUrl: '/m' },
    },
    { drivers: { storage: { local: memory } }, media: fakeMedia() },
  );
  await resizer.ready();
  assert.strictEqual(resizer.storage, memory.built[0]);
});

test('without a database section or media, first use is RESIZE_MEDIA_REQUIRED naming the config', async () => {
  const resizer = createResizer(
    {},
    { storage: memoryStorage().storage, logger: silentLogger },
  );
  await assert.rejects(
    resizer.ready(),
    fails(ResizeSetupError, 'RESIZE_MEDIA_REQUIRED', WHERE),
  );
});

test('without a storage section or option, first use is RESIZE_CONFIG_STORAGE_MISSING', async () => {
  const resizer = createResizer(
    {},
    { media: fakeMedia(), logger: silentLogger },
  );
  await assert.rejects(
    resizer.ready(),
    fails(
      ResizeConfigError,
      'RESIZE_CONFIG_STORAGE_MISSING',
      `resize config: \`storage\` is missing — set storage: { driver: 'local', rootDir, publicBaseUrl } (or driver 's3') in ${WHERE}, or pass \`storage\` to createResizer()`,
    ),
  );
});

test('a database queue without a database section is RESIZE_CONFIG_INVALID', async () => {
  const resizer = createResizer(
    { queues: { default: { driver: 'database' } } },
    {
      storage: memoryStorage().storage,
      media: fakeMedia(),
      logger: silentLogger,
    },
  );
  await assert.rejects(
    resizer.ready(),
    fails(
      ResizeConfigError,
      'RESIZE_CONFIG_INVALID',
      `\`queues.default\` in ${WHERE} uses driver 'database', which needs a \`database\` section`,
    ),
  );
});

test('options win over the config: storage, media, tasks: false, queueName', async () => {
  const fake = fakeDatabaseDriver();
  const memory = memoryStorageDriver();
  const { storage } = memoryStorage();
  const media = fakeMedia();
  const resizer = createResizer(
    {
      storage: { driver: 'memory' },
      database: { driver: 'fake' },
      queues: { default: { driver: 'database' } },
    },
    {
      drivers: { storage: { memory }, database: { fake } },
      storage,
      media,
      tasks: false,
      logger: silentLogger,
    },
  );
  // Given in code, readable at once.
  assert.strictEqual(resizer.storage, storage);
  assert.strictEqual(resizer.media, media);
  await resizer.ready();
  assert.equal(resizer.tasks, undefined);
  assert.equal(resizer.locks, undefined);
  assert.equal(memory.built.length, 0);
  assert.equal(fake.built.length, 0);

  const named = createResizer(
    {
      storage: { driver: 'memory' },
      database: { driver: 'fake' },
      queue: 'default',
      queues: {
        default: { driver: 'database' },
        bulk: { driver: 'database' },
      },
    },
    {
      name: 'named',
      drivers: { storage: { memory }, database: { fake } },
      queueName: 'bulk',
      logger: silentLogger,
    },
  );
  assert.equal(named.queueName, 'bulk');
  await named.verify();
  // Tasks given in code: the queue set is never built.
  const tasks = new MemoryTaskQueue();
  const given = createResizer(
    {
      storage: { driver: 'memory' },
      database: { driver: 'fake' },
      queues: { default: { driver: 'database' } },
    },
    {
      name: 'given',
      drivers: { storage: { memory }, database: { fake } },
      tasks,
      logger: silentLogger,
    },
  );
  await given.ready();
  assert.strictEqual(given.tasks, tasks);
  assert.equal(fake.built.at(-1)?.taskQueueCalls.length, 0);
});

test('configuredOptions: eagerDatabase gives media (and locks beside tasks in code) at once; shareQueues keeps the queue set and each backend in the registry', async () => {
  const fake = fakeDatabaseDriver();
  const plain = fakeQueueDriver();
  const drivers = {
    storage: { memory: memoryStorageDriver() },
    database: { fake },
    queue: { plain },
  };
  const process: ProcessSections = {
    queues: resolveQueueEntries(
      { default: { driver: 'database' }, bulk: { driver: 'plain' } },
      'the shared file',
    ),
    coordination: undefined,
    validated: new Set(),
  };
  const source = (): ConfigSource => ({
    own: () => ({ image: {}, storage: { driver: 'memory' } }),
    process: () => process,
    database: () => ({ driver: 'fake' }),
    eagerDatabase: true,
    where: { own: 'the own file', process: 'the shared file' },
    storageAdvice: 'or pass `storage` to the test',
  });
  const a = new Resizer(
    configuredOptions(source(), {
      drivers,
      shareQueues: 'test',
      logger: silentLogger,
    }),
  );
  // The fake database driver is synchronous, so its parts exist at construction.
  assert.strictEqual(a.media, fake.built[0].media);
  const inCode = new PlainTaskQueue();
  const b = new Resizer(
    configuredOptions(source(), {
      name: 'b',
      drivers,
      tasks: inCode,
      shareQueues: 'test',
      logger: silentLogger,
    }),
  );
  assert.strictEqual(b.locks, fake.built[1].locks);
  const c = new Resizer(
    configuredOptions(source(), {
      name: 'c',
      drivers,
      shareQueues: 'test',
      logger: silentLogger,
    }),
  );
  await a.ready();
  await c.ready();
  assert.ok(a.tasks instanceof RoutingTaskQueue);
  assert.strictEqual(a.tasks, c.tasks);
  const bulk = await carrierOf(a.tasks, 'bulk');
  assert.strictEqual(bulk, plain.built[0]);
  assert.equal(plain.built.length, 1);
  const notShared = async (): Promise<never> => {
    throw new Error('not shared');
  };
  assert.strictEqual(await sharedPart('test:queues', notShared), a.tasks);
  assert.strictEqual(
    await sharedPart('test:backend:plain:', notShared),
    plain.built[0],
  );
  // Without shareQueues, each Resizer keeps its own set.
  const d = new Resizer(
    configuredOptions(source(), { name: 'd', drivers, logger: silentLogger }),
  );
  await d.ready();
  assert.notStrictEqual(d.tasks, a.tasks);
});

test('eagerDatabase with an async driver that rejects: construction does not crash, and first use rejects with its error', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    let builds = 0;
    const down = {
      fromConfig: async (): Promise<never> => {
        builds += 1;
        throw new Error('db down');
      },
    };
    const source: ConfigSource = {
      own: () => ({ image: {} }),
      process: () => ({
        queues: [],
        coordination: undefined,
        validated: new Set(),
      }),
      database: () => ({ driver: 'down' }),
      eagerDatabase: true,
      where: { own: 'the own file', process: 'the shared file' },
      storageAdvice: 'or pass `storage` to the test',
    };
    const resizer = new Resizer(
      configuredOptions(source, {
        drivers: { database: { down } },
        storage: memoryStorage().storage,
        logger: silentLogger,
      }),
    );
    // Started at construction; its rejection must not be left unhandled.
    assert.equal(builds, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
    // First use builds again and rejects with the driver's error.
    await assert.rejects(resizer.ready(), /db down/);
    assert.equal(builds, 2);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
