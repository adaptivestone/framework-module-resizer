// The in-memory stores follow the contracts tests rely on: the media store keeps one stored preview
// row per preview identity and resolves with the previews it stored; the locks honour owners, and
// clockLocks also their TTLs. MemoryTaskQueue gates by task like the database queue: one active
// task per Resizer, media and pipeline. PlainTaskQueue has the SQS shape and stores every task.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NewTask } from '../contracts/taskQueue.ts';
import type { Preview } from '../types.d.ts';
import {
  clockLocks,
  fakeMedia,
  MemoryTaskQueue,
  memoryLocks,
  PlainTaskQueue,
  ReleasingTaskQueue,
} from './fakes.ts';

const preview = (identity: string | undefined, path: string): Preview =>
  ({
    storageRef: { path },
    ...(identity === undefined ? {} : { identity }),
    sizeKey: '16x16',
    format: 'webp',
  }) as Preview;

const newTask = (over: Partial<NewTask> = {}): NewTask => ({
  resizer: 'default',
  queue: 'default',
  mediaId: 'm1',
  pipeline: 'default',
  previews: [{ sizeKey: '10x10', format: 'webp' }],
  requestKey: 'k1',
  ...over,
});

const m1 = { resizer: 'default', mediaId: 'm1', pipeline: 'default' };

test('memoryLocks honours owners', async () => {
  const locks = memoryLocks();
  assert.equal(await locks.acquire('k', 'A', 1), true);
  assert.equal(await locks.acquire('k', 'B', 1), false);
  assert.equal(await locks.release('k', 'B'), false);
  assert.equal(await locks.extend('k', 'B', 1), false);
  assert.equal(await locks.extend('k', 'A', 1), true);
  assert.equal(await locks.release('k', 'A'), true);
  assert.equal(await locks.acquire('k', 'B', 1), true);
});

test('fakeMedia keeps one row per identity and resolves with the stored rows', async () => {
  const previews = new Map<string, Preview[]>();
  const media = fakeMedia({ previews });
  const a = preview('a', 'a1');
  const b = preview('b', 'b1');

  assert.deepEqual(
    await media.appendPreviews('m1', [a, b, preview('a', 'a2')]),
    [a, b],
  );
  assert.deepEqual(await media.appendPreviews('m1', [preview('a', 'a3')]), []);
  // Identities are per media.
  assert.deepEqual(await media.appendPreviews('m2', [a]), [a]);
  // A preview without an identity is always stored.
  const plain = preview(undefined, 'plain');
  assert.deepEqual(await media.appendPreviews('m1', [plain, plain]), [
    plain,
    plain,
  ]);
  assert.deepEqual(previews.get('m1'), [a, b, plain, plain]);
  assert.deepEqual(previews.get('m2'), [a]);
});

test('fakeMedia treats seeded previews as already stored', async () => {
  const seeded = preview('a', 'other-worker');
  const media = fakeMedia({ previews: new Map([['m1', [seeded]]]) });
  assert.deepEqual(
    await media.appendPreviews('m1', [preview('a', 'late')]),
    [],
  );
});

test('MemoryTaskQueue gates by task: one active task per Resizer, media and pipeline', async () => {
  const tasks = new MemoryTaskQueue();
  assert.equal(tasks.gatesByTask, true);
  assert.deepEqual(await tasks.add(newTask()), {
    status: 'added',
    taskId: 'task-1',
  });
  // Another request for the same media and pipeline waits for the active task, whatever it asks.
  assert.deepEqual(
    await tasks.add(
      newTask({
        previews: [{ sizeKey: '20x20', format: 'webp' }],
        requestKey: 'k2',
      }),
    ),
    { status: 'in-flight', taskId: 'task-1' },
  );
  assert.equal((await tasks.add(newTask({ pipeline: 'wm' }))).status, 'added');
  assert.equal(
    (await tasks.add(newTask({ resizer: 'listings' }))).status,
    'added',
  );
  assert.equal(tasks.rows.length, 3);
  assert.equal(tasks.added.length, 4);
});

test('retry backoff and release keep the gate; complete opens it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const tasks = new MemoryTaskQueue();
  await tasks.add(newTask());
  const first = await tasks.claim('default', 1000);
  assert.ok(first);
  assert.equal(
    await tasks.fail(first, { retryAt: new Date(60_000) }, 'boom'),
    true,
  );
  // In the retry backoff the task still holds the gate.
  assert.deepEqual(await tasks.add(newTask()), {
    status: 'in-flight',
    taskId: 'task-1',
  });

  t.mock.timers.setTime(60_000);
  const retry = await tasks.claim('default', 1000);
  assert.ok(retry);
  assert.equal(retry.taskId, 'task-1');
  assert.equal(retry.attempts, 2);
  assert.equal((await tasks.add(newTask())).status, 'in-flight');
  assert.equal(await tasks.complete(retry), true);
  assert.equal(tasks.rows[0].active, false);
  const next = await tasks.add(newTask());
  assert.equal(next.status, 'added');
  assert.equal(tasks.rows.length, 2);
  assert.equal(tasks.rows[1].active, true);

  // `release` lives on the queues without the gate: it gives the task back and leaves the row
  // active.
  const releasing = new ReleasingTaskQueue();
  await releasing.add(newTask());
  const claimed = await releasing.claim('default', 1000);
  assert.ok(claimed);
  assert.equal(await releasing.release(claimed), true);
  assert.equal(releasing.rows[0].status, 'pending');
  assert.equal(releasing.rows[0].active, true);
});

test('a dead task holds the gate until its cooldown ends; then one add takes it over', async () => {
  let now = 0;
  const tasks = new MemoryTaskQueue({ now: () => now });
  await tasks.add(newTask());
  const claimed = await tasks.claim('default', 1000);
  assert.ok(claimed);
  assert.equal(
    await tasks.fail(claimed, 'dead', 'x', { cooldownMs: 1000 }),
    true,
  );
  assert.deepEqual(await tasks.add(newTask()), {
    status: 'in-flight',
    taskId: 'task-1',
  });
  now = 999;
  assert.equal((await tasks.add(newTask())).status, 'in-flight');

  now = 1000;
  const takeover = await tasks.add(newTask());
  assert.equal(takeover.status, 'added');
  assert.equal(tasks.rows.length, 2);
  // The new task is the gate now: the next add waits for it.
  assert.deepEqual(await tasks.add(newTask()), {
    status: 'in-flight',
    taskId: tasks.rows[1].id,
  });
  assert.equal(tasks.rows.length, 2);
  const dead = tasks.rows[0];
  assert.equal(dead.status, 'dead');
  assert.equal(dead.active, false);
  assert.equal(dead.error, 'x');
  assert.equal(dead.cooldownUntil, 1000);
});

test('findActive returns only a pending or processing active task', async () => {
  const tasks = new MemoryTaskQueue({ now: () => 0 });
  assert.deepEqual(await tasks.findActive(m1), []);
  await tasks.add(newTask());
  await tasks.add(newTask({ mediaId: 'm2' }));
  const receipt = { taskId: 'task-1', previews: newTask().previews };
  assert.deepEqual(await tasks.findActive(m1), [receipt]);

  const claimed = await tasks.claim('default', 1000);
  assert.ok(claimed);
  assert.equal(claimed.taskId, 'task-1');
  assert.deepEqual(await tasks.findActive(m1), [receipt]);

  await tasks.fail(claimed, 'dead', 'x', { cooldownMs: 1000 });
  // The dead task still holds the gate (its cooldown is running), but nothing will run it.
  assert.equal((await tasks.add(newTask())).status, 'in-flight');
  assert.deepEqual(await tasks.findActive(m1), []);
});

test('claim with resizers takes only their tasks', async () => {
  const tasks = new MemoryTaskQueue();
  assert.equal(tasks.claimFilters, true);
  await tasks.add(newTask({ resizer: 'a' }));
  await tasks.add(newTask({ resizer: 'b' }));
  const claimed = await tasks.claim('default', 1000, undefined, {
    resizers: ['b'],
  });
  assert.equal(claimed?.resizer, 'b');
  assert.equal(
    await tasks.claim('default', 1000, undefined, { resizers: ['b'] }),
    null,
  );
  // Without the option any task is claimed.
  assert.equal((await tasks.claim('default', 1000))?.resizer, 'a');
});

test('PlainTaskQueue stores every add and declares no gate, no claim filter and no findActive', async () => {
  const tasks = new PlainTaskQueue();
  assert.deepEqual(await tasks.add(newTask()), {
    status: 'added',
    taskId: 'task-1',
  });
  assert.deepEqual(await tasks.add(newTask()), {
    status: 'added',
    taskId: 'task-2',
  });
  assert.equal(tasks.rows.length, 2);
  assert.equal(tasks.added.length, 2);
  assert.equal(tasks.gatesByTask, undefined);
  assert.equal(tasks.claimFilters, undefined);
  assert.equal(tasks.findActive, undefined);
  // It ignores the claim filter: a worker may receive any Resizer's task.
  const claimed = await tasks.claim('default', 1000, undefined, {
    resizers: ['listings'],
  });
  assert.equal(claimed?.resizer, 'default');
});

test('clockLocks expires locks, lets them be taken over, and checks owners', async () => {
  let now = 0;
  const locks = clockLocks(() => now);
  assert.equal(await locks.acquire('k', 'A', 10), true);
  // A live lock excludes everyone, its own owner included.
  assert.equal(await locks.acquire('k', 'A', 10), false);
  assert.equal(await locks.acquire('k', 'B', 10), false);
  assert.equal(await locks.extend('k', 'B', 10), false);

  now = 10;
  assert.equal(await locks.extend('k', 'A', 10), false);
  assert.equal(await locks.acquire('k', 'B', 10), true);
  assert.equal(await locks.release('k', 'A'), false);
  assert.deepEqual(locks.entry('k'), { owner: 'B', expiresAt: 20 });

  now = 15;
  assert.equal(await locks.extend('k', 'B', 10), true);
  assert.deepEqual(locks.entry('k'), { owner: 'B', expiresAt: 25 });
  assert.equal(await locks.release('k', 'B'), true);
  assert.equal(locks.entry('k'), undefined);
});

test('clockLocks: an expired lock can be released by its owner until someone takes it over', async () => {
  let now = 0;
  const locks = clockLocks(() => now);
  assert.equal(await locks.acquire('k', 'A', 10), true);
  now = 50;
  assert.equal(await locks.release('k', 'A'), true);
  assert.equal(locks.entry('k'), undefined);
});
