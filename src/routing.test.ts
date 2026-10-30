// RoutingTaskQueue: queue names routed to backends, object routes used as they are and builder
// routes built once, on first need. carrierOf finds the backend of a name on any task queue, and
// the unavailable reasons are kept beside the task queue they belong to.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { TaskQueue } from './contracts/taskQueue.ts';
import { ResizeError, ResizeSetupError } from './errors.ts';
import { Resizer, resetResizerForTests } from './resizer.ts';
import {
  carrierOf,
  markUnavailable,
  RoutingTaskQueue,
  unavailableReason,
} from './routing.ts';
import {
  fakeMedia,
  MemoryTaskQueue,
  memoryLocks,
  PlainTaskQueue,
} from './testHelpers/fakes.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import { workUntil } from './testHelpers/work.ts';
import { timingOf } from './timing.ts';

afterEach(resetResizerForTests);

const silent = { info() {}, warn() {}, error() {} };

const taskOn = (queue: string, mediaId = 'm1') => ({
  resizer: 'default',
  queue,
  mediaId,
  pipeline: 'default',
  previews: [{ sizeKey: '10x10', format: 'webp' }],
});

const setupError = (code: string) => (err: unknown) =>
  err instanceof ResizeSetupError &&
  err.code === code &&
  err.retryable === false;

test('add, claim, renew, complete and fail go to the route of the queue name', async () => {
  const memory = new MemoryTaskQueue();
  const plain = new PlainTaskQueue();
  const router = new RoutingTaskQueue({ default: memory, bulk: plain });
  assert.equal((await router.add(taskOn('bulk'))).status, 'added');
  assert.equal(plain.added.length, 1);
  assert.deepEqual(memory.added, []);
  await router.add(taskOn('default'));
  assert.equal(memory.added.length, 1);
  const fromMemory = await router.claim('default', 60_000);
  assert.equal(fromMemory?.taskId, memory.rows[0].id);
  assert.equal(memory.rows[0].status, 'processing');
  const fromPlain = await router.claim('bulk', 60_000);
  assert.ok(fromPlain);
  assert.equal(await router.renew(fromPlain, 60_000), true);
  assert.equal(await router.complete(fromPlain), true);
  assert.equal(plain.rows[0].status, 'completed');
  assert.ok(fromMemory);
  assert.equal(
    await router.fail(fromMemory, { retryAt: new Date(0) }, 'boom'),
    true,
  );
  assert.equal(memory.rows[0].status, 'pending');
  assert.equal(memory.rows[0].error, 'boom');
});

test('a builder route is built once, on first need; a rejected build is forgotten', async () => {
  const plain = new PlainTaskQueue();
  let builds = 0;
  let fail = true;
  const router = new RoutingTaskQueue({
    bulk: async () => {
      builds += 1;
      if (fail) {
        throw new Error('not up yet');
      }
      return plain;
    },
  });
  assert.equal(router.servesQueue('bulk'), true);
  assert.equal(builds, 0);
  await assert.rejects(() => router.routeOf('bulk'), /not up yet/);
  assert.equal(builds, 1);
  fail = false;
  assert.equal(await router.routeOf('bulk'), plain);
  assert.equal(await router.routeOf('bulk'), plain);
  assert.equal(builds, 2);
});

test('routeOf resolves a nested router; an unknown name resolves undefined; servesQueue answers without building', async () => {
  const plain = new PlainTaskQueue();
  let builds = 0;
  const inner = new RoutingTaskQueue({
    bulk: async () => {
      builds += 1;
      return plain;
    },
  });
  const outer = new RoutingTaskQueue({ bulk: inner });
  assert.equal(outer.servesQueue('bulk'), true);
  assert.equal(outer.servesQueue('nope'), false);
  assert.equal(builds, 0);
  assert.equal(await outer.routeOf('nope'), undefined);
  assert.equal(await outer.routeOf('bulk'), plain);
  assert.equal(await carrierOf(outer, 'bulk'), plain);
  assert.equal(builds, 1);
});

test('the flags are set only when every route is an object route with them, and are own data properties', () => {
  const memory = new MemoryTaskQueue();
  const gating = new RoutingTaskQueue({ a: memory, b: memory });
  assert.equal(gating.gatesByTask, true);
  assert.equal(gating.claimFilters, true);
  const flag = Object.getOwnPropertyDescriptor(gating, 'gatesByTask');
  assert.equal(flag?.get, undefined);
  assert.equal(flag?.value, true);
  const mixed = new RoutingTaskQueue({ a: memory, b: new PlainTaskQueue() });
  assert.equal(mixed.gatesByTask, undefined);
  assert.equal(mixed.claimFilters, undefined);
  const cold = new RoutingTaskQueue({ a: memory, b: async () => memory });
  assert.equal(cold.gatesByTask, undefined);
  assert.equal(cold.claimFilters, undefined);
});

test('getTiming goes through timingOf on an object route and through opts.getTiming for a builder route', () => {
  const memory = new MemoryTaskQueue({ queueTiming: { a: { leaseMs: 1234 } } });
  const router = new RoutingTaskQueue(
    { a: memory, b: async () => memory },
    {
      getTiming: (queue) => (queue === 'b' ? { leaseMs: 4321 } : undefined),
    },
  );
  assert.equal(router.getTiming('a')?.leaseMs, 1234);
  assert.equal(timingOf(router, 'a').leaseMs, 1234);
  assert.equal(timingOf(router, 'b').leaseMs, 4321);
  assert.equal(router.getTiming('nope'), undefined);
});

test("a builder route's timing is the router's option before and after the build, even when its carrier has no getTiming or another one", async () => {
  const plain = new PlainTaskQueue();
  // A carrier without getTiming: the router's option is the only timing of its names.
  Object.defineProperty(plain, 'getTiming', { value: undefined });
  const router = new RoutingTaskQueue(
    { bulk: async () => plain },
    {
      getTiming: () => ({
        maxAttempts: 2,
        idlePollMs: 5,
        retryBackoffMs: { base: 5, max: 5 },
      }),
    },
  );
  assert.equal(timingOf(router, 'bulk').maxAttempts, 2);
  assert.equal(await router.routeOf('bulk'), plain);
  assert.equal(timingOf(router, 'bulk').maxAttempts, 2);
  const resizer = new Resizer({
    config: makeImageConfig({ formats: ['webp'] }),
    logger: silent,
    queueName: 'bulk',
    storage: {
      download: async () => {
        throw new Error('storage down');
      },
      upload: async () => ({ key: 'k' }),
      publicUrl: () => '',
    },
    media: fakeMedia({
      load: async (id) => ({
        id,
        original: { storageRef: { key: 'o' } },
        previews: [],
      }),
    }),
    locks: memoryLocks(),
    tasks: router,
  });
  await plain.add(taskOn('bulk'));
  const [row] = plain.rows;
  await workUntil(
    { queue: 'bulk', logger: silent, resizers: [resizer] },
    () => row.status === 'dead',
  );
  assert.equal(row.attempts, 2);
  // A carrier with a timing of its own is not asked for the router's names.
  const other = new RoutingTaskQueue(
    { x: async () => new PlainTaskQueue({ timing: { maxAttempts: 9 } }) },
    { getTiming: () => ({ maxAttempts: 2 }) },
  );
  await other.routeOf('x');
  assert.equal(timingOf(other, 'x').maxAttempts, 2);
});

test("a route's getTiming runs once for a name read by the Dispatcher and by the worker", async () => {
  const memory = new MemoryTaskQueue({ timing: { idlePollMs: 5 } });
  let reads = 0;
  const getTiming = memory.getTiming.bind(memory);
  memory.getTiming = (queue) => {
    reads += 1;
    return getTiming(queue);
  };
  const resizer = new Resizer({
    config: makeImageConfig({ formats: ['webp'] }),
    logger: silent,
    storage: {
      download: async () => Buffer.alloc(0),
      upload: async () => ({ key: 'k' }),
      publicUrl: () => '',
    },
    media: fakeMedia(),
    tasks: new RoutingTaskQueue({ default: memory }),
  });
  const result = await resizer.prewarm({
    media: { id: 'm1', original: { storageRef: { key: 'o' } }, previews: [] },
    sizes: [{ width: 10, height: 10 }],
  });
  assert.equal(result.status, 'accepted');
  const [row] = memory.rows;
  await workUntil(
    { logger: silent, resizers: [resizer] },
    () => row.status === 'completed',
  );
  assert.equal(reads, 1);
});

test('markUnavailable keeps a reason per name; carrierOf ignores it; a task queue without reasons has none', async () => {
  const tasks = new MemoryTaskQueue({ queues: ['default'] });
  const error = new ResizeSetupError('peer missing', {
    code: 'RESIZE_PEER_MISSING',
  });
  const reason = {
    driver: 'sqs',
    packages: ['@aws-sdk/client-sqs'],
    error,
  };
  markUnavailable(tasks, ['bulk', 'audit'], reason);
  assert.equal(unavailableReason(tasks, 'bulk'), reason);
  assert.equal(unavailableReason(tasks, 'audit'), reason);
  assert.equal(unavailableReason(tasks, 'default'), undefined);
  assert.equal(await carrierOf(tasks, 'bulk'), undefined);
  assert.equal(await carrierOf(tasks, 'default'), tasks);
  assert.equal(unavailableReason(new MemoryTaskQueue(), 'bulk'), undefined);
});

test("findActive is the carrier's, or [] when the carrier has none", async () => {
  const memory = new MemoryTaskQueue();
  const router = new RoutingTaskQueue({
    default: memory,
    bulk: new PlainTaskQueue(),
  });
  await router.add(taskOn('default'));
  const query = { resizer: 'default', mediaId: 'm1', pipeline: 'default' };
  assert.deepEqual(await router.findActive({ ...query, queue: 'default' }), [
    { taskId: memory.rows[0].id, previews: memory.rows[0].task.previews },
  ]);
  await router.add(taskOn('bulk'));
  assert.deepEqual(await router.findActive({ ...query, queue: 'bulk' }), []);
});

test('invalid routes are RESIZE_QUEUE_ROUTES_INVALID', () => {
  const invalid: unknown[] = [
    {},
    null,
    [],
    { a: {} },
    { a: 42 },
    { a: new MemoryTaskQueue({ queues: ['x'] }) },
  ];
  for (const routes of invalid) {
    assert.throws(
      () => new RoutingTaskQueue(routes as never),
      setupError('RESIZE_QUEUE_ROUTES_INVALID'),
      JSON.stringify(routes),
    );
  }
  assert.throws(
    () => new RoutingTaskQueue({ a: new MemoryTaskQueue({ queues: ['x'] }) }),
    /'a'/,
  );
});

test('a builder that resolves something that is not a task queue is RESIZE_DRIVER_INVALID', async () => {
  let builds = 0;
  const router = new RoutingTaskQueue({
    bulk: async () => {
      builds += 1;
      return { add: async () => ({ status: 'unconfirmed' }) } as never;
    },
  });
  await assert.rejects(
    () => router.routeOf('bulk'),
    setupError('RESIZE_DRIVER_INVALID'),
  );
  await assert.rejects(() => router.routeOf('bulk'));
  assert.equal(builds, 2, 'an invalid build is not kept');
});

test('add or claim on a name without a route rejects with RESIZE_QUEUE_NOT_SERVED', async () => {
  const router = new RoutingTaskQueue({ default: new MemoryTaskQueue() });
  await assert.rejects(
    () => router.add(taskOn('bulk')),
    (err: unknown) =>
      ResizeError.isResizeError(err) &&
      err.code === 'RESIZE_QUEUE_NOT_SERVED' &&
      /'bulk'/.test(err.message),
  );
  await assert.rejects(
    () => router.claim('bulk', 60_000),
    (err: unknown) =>
      ResizeError.isResizeError(err) && err.code === 'RESIZE_QUEUE_NOT_SERVED',
  );
});

test('carrierOf: a queue without routeOf carries every name it serves', async () => {
  const every = new PlainTaskQueue();
  assert.equal(await carrierOf(every, 'anything'), every);
  const listed = new PlainTaskQueue({ queues: ['default'] });
  assert.equal(await carrierOf(listed, 'default'), listed);
  assert.equal(await carrierOf(listed, 'bulk'), undefined);
  const bare: TaskQueue = {
    add: async () => ({ status: 'unconfirmed' }),
    claim: async () => null,
    renew: async () => false,
    complete: async () => false,
    fail: async () => false,
  };
  assert.equal(await carrierOf(bare, 'bulk'), bare);
});
