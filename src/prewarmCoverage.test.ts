import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import type { LockStore } from './contracts/locks.ts';
import type { ResizeStorage } from './contracts/storage.ts';
import type {
  NewTask,
  TaskAddResult,
  TaskQueue,
} from './contracts/taskQueue.ts';
import { Resizer, resetResizerForTests } from './resizer.ts';
import {
  fakeMedia,
  MemoryTaskQueue,
  memoryLocks,
} from './testHelpers/fakes.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import type {
  EnqueueReceipt,
  MissingPreview,
  ResizeLogger,
} from './types.d.ts';

const logger: ResizeLogger = { info() {}, warn() {}, error() {} };

const storage: ResizeStorage = {
  download: async () => Buffer.alloc(0),
  upload: async ({ key }) => ({ key }),
  publicUrl: () => '',
};

// A task queue that gates by task (one add per prewarm, findActive after an in-flight add), or with
// `gates: false` one without gatesByTask, so each prewarm takes the gate lock in the lock store.
function makeTaskQueue(
  overrides: {
    add?: (task: NewTask) => Promise<TaskAddResult>;
    findActive?: (query: {
      resizer: string;
      mediaId: string;
      pipeline: string;
    }) => Promise<EnqueueReceipt[]>;
    gates?: false;
  } = {},
) {
  const memory = new MemoryTaskQueue();
  const added: NewTask[] = [];
  const tasks: TaskQueue = {
    ...(overrides.gates === false ? {} : { gatesByTask: true as const }),
    add: async (task) => {
      added.push(task);
      return overrides.add ? overrides.add(task) : memory.add(task);
    },
    claim: (queue, leaseMs) => memory.claim(queue, leaseMs),
    renew: (task, leaseMs) => memory.renew(task, leaseMs),
    complete: (task) => memory.complete(task),
    fail: (task, next, error) => memory.fail(task, next, error),
    findActive: overrides.findActive ?? ((query) => memory.findActive(query)),
    getTiming: (queue) => memory.getTiming(queue),
  };
  return { tasks, added };
}

function locks(
  acquire: boolean | ((key: string) => boolean | Promise<boolean>) = true,
) {
  const acquired: string[] = [];
  const extended: [string, number][] = [];
  const released: string[] = [];
  const lockStore: LockStore = {
    acquire: async (key) => {
      acquired.push(key);
      return typeof acquire === 'function' ? acquire(key) : acquire;
    },
    extend: async (key, _owner, ttlMs) => {
      extended.push([key, ttlMs]);
      return true;
    },
    release: async (key) => {
      released.push(key);
      return true;
    },
  };
  return { lockStore, acquired, extended, released };
}

// The add result of a queue whose active task of this media, pipeline and queue holds the gate.
const inFlight = async (): Promise<TaskAddResult> => ({
  status: 'in-flight',
  taskId: 'active-1',
});

function makeResizer(
  options: {
    storage?: ResizeStorage;
    tasks?: TaskQueue;
    lockStore?: LockStore;
    name?: string;
    queue?: string;
    hooks?: ConstructorParameters<typeof Resizer>[0]['hooks'];
    pipelines?: ConstructorParameters<typeof Resizer>[0]['pipelines'];
  } = {},
) {
  return new Resizer({
    storage: options.storage ?? storage,
    media: fakeMedia(),
    locks: options.lockStore ?? memoryLocks(),
    tasks: options.tasks,
    config: makeImageConfig(),
    logger,
    name: options.name,
    queue: options.queue,
    hooks: options.hooks,
    pipelines: options.pipelines,
  });
}

function taskPreview(format: 'jpeg' | 'webp' = 'jpeg'): MissingPreview {
  return {
    sizeKey: '300x300',
    format,
    requestedWidth: 300,
    requestedHeight: 300,
  };
}

afterEach(() => {
  resetResizerForTests();
});

describe('prewarm — explicit coverage', () => {
  test('returns accepted variants and the task receipt', async () => {
    const calls: MissingPreview[][] = [];
    const { tasks } = makeTaskQueue({
      add: async ({ previews }) => {
        calls.push(previews);
        return { status: 'added', taskId: 'task-1' };
      },
    });
    const r = makeResizer({
      storage,
      tasks,
      lockStore: locks().lockStore,
    });
    const result = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'original.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
    });

    assert.equal(result.status, 'accepted');
    assert.equal(result.accepted.length, 2);
    assert.equal(result.unconfirmed.length, 0);
    assert.deepEqual(result.tasks, [{ taskId: 'task-1', previews: calls[0] }]);
  });

  test('added tasks record the Resizer name and queue; after an in-flight add, findActive uses the Resizer, media, and pipeline scope', async () => {
    const added: { resizer: string; queue: string }[] = [];
    const looked: { resizer: string; mediaId: string; pipeline: string }[] = [];
    const { tasks } = makeTaskQueue({
      // The first prewarm adds the task; the second finds it in flight and looks it up.
      add: async ({ resizer, queue }) => {
        added.push({ resizer, queue });
        return added.length === 1
          ? { status: 'added', taskId: 'task-1' }
          : { status: 'in-flight', taskId: 'task-1' };
      },
      findActive: async ({ resizer, mediaId, pipeline }) => {
        looked.push({ resizer, mediaId, pipeline });
        return [];
      },
    });
    const r = makeResizer({
      storage,
      tasks,
      name: 'listings',
      queue: 'interactive',
    });
    const media = {
      id: 'm1',
      original: { storageRef: { key: 'original.jpg' } },
    };
    await r.prewarm({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
    });
    await r.prewarm({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
      queue: 'bulk',
    });
    assert.deepEqual(added, [
      { resizer: 'listings', queue: 'interactive' },
      { resizer: 'listings', queue: 'bulk' },
    ]);
    assert.deepEqual(looked, [
      { resizer: 'listings', mediaId: 'm1', pipeline: 'default' },
    ]);
  });

  test('distinguishes already ready, SVG, empty, and policy-filtered requests', async () => {
    const { tasks } = makeTaskQueue({
      add: async () => ({ status: 'added', taskId: 'unexpected' }),
    });
    const ready = makeResizer({
      storage,
      tasks,
      lockStore: locks().lockStore,
    });
    const readyResult = await ready.prewarm({
      media: {
        id: 'm1',
        original: { storageRef: { key: 'original.jpg' } },
        previews: [
          {
            storageRef: { key: 'ready.jpg' },
            sizeKey: '300x300',
            format: 'jpeg',
            contentType: 'image/jpeg',
          },
        ],
      },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(readyResult.status, 'ready');
    assert.equal(readyResult.ready.length, 1);

    resetResizerForTests();
    const svg = makeResizer({
      storage,
      tasks,
      lockStore: locks().lockStore,
    });
    const svgResult = await svg.prewarm({
      media: {
        id: 'm2',
        original: {
          storageRef: { key: 'logo.svg' },
          contentType: 'image/svg+xml',
        },
      },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(svgResult.status, 'accepted');
    assert.equal(svgResult.accepted.length, 1);

    resetResizerForTests();
    const empty = makeResizer({ storage, tasks });
    assert.equal(
      (
        await empty.prewarm({
          media: { id: 'm3', original: { storageRef: { key: 'x.jpg' } } },
          sizes: [],
        })
      ).reason,
      'empty-request',
    );

    resetResizerForTests();
    const filtered = makeResizer({
      storage,
      tasks,
      hooks: { beforeEnqueue: () => [] },
    });
    const filteredResult = await filtered.prewarm({
      media: { id: 'm4', original: { storageRef: { key: 'x.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(filteredResult.status, 'not-required');
    assert.equal(filteredResult.reason, 'filtered');
    assert.equal(filteredResult.notRequired.length, 1);
  });

  test('reports no task queue, no original, and an unconfirmed add as incomplete', async () => {
    const noQueue = makeResizer({ storage });
    const missingQueue = await noQueue.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'x.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(missingQueue.status, 'incomplete');
    assert.equal(missingQueue.issues[0].code, 'RESIZE_ENQUEUE_NO_QUEUE');

    resetResizerForTests();
    const { tasks } = makeTaskQueue({
      add: async () => ({ status: 'unconfirmed' }),
    });
    const noOriginal = makeResizer({
      storage,
      tasks,
      lockStore: locks().lockStore,
    });
    const missingOriginal = await noOriginal.prewarm({
      media: { id: 'm2' },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(missingOriginal.status, 'incomplete');
    assert.equal(missingOriginal.issues[0].code, 'RESIZE_ENQUEUE_NO_ORIGINAL');

    const nullTask = await noOriginal.prewarm({
      media: { id: 'm3', original: { storageRef: { key: 'x.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(nullTask.status, 'incomplete');
    assert.equal(nullTask.accepted.length, 0);
    assert.equal(nullTask.unconfirmed.length, 1);
    assert.equal(nullTask.issues[0].code, 'RESIZE_ENQUEUE_UNCONFIRMED');
  });

  test('does not accept an empty task ID', async () => {
    const { tasks } = makeTaskQueue({
      add: async () => ({ status: 'added', taskId: '' }),
    });
    const r = makeResizer({
      storage,
      tasks,
      lockStore: locks().lockStore,
    });
    const result = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'x.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.tasks.length, 0);
  });
});

describe('prewarm — a task in flight, and the gate lock', () => {
  test('a held gate lock is incomplete and adds nothing; findActive is not read', async () => {
    let addCalls = 0;
    let lookups = 0;
    const { tasks } = makeTaskQueue({
      gates: false,
      add: async () => {
        addCalls++;
        return { status: 'added', taskId: 'unexpected' };
      },
      findActive: async () => {
        lookups++;
        return [{ taskId: 'active-1', previews: [taskPreview()] }];
      },
    });
    const r = makeResizer({
      storage,
      tasks,
      lockStore: locks(false).lockStore,
    });
    const result = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'x.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.accepted.length, 0);
    assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_LOCK_CONTENDED');
    assert.equal(result.issues[0].retryable, true);
    assert.equal(addCalls, 0);
    assert.equal(lookups, 0);
  });

  test('findActive may prove coverage by the active task after an in-flight add', async () => {
    const { tasks } = makeTaskQueue({
      add: inFlight,
      findActive: async () => [
        { taskId: 'active-1', previews: [taskPreview()] },
      ],
    });
    const r = makeResizer({ storage, tasks });
    const result = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'x.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(result.status, 'accepted');
    assert.equal(result.accepted.length, 1);
    assert.equal(result.unconfirmed.length, 0);
    assert.equal(result.tasks[0].taskId, 'active-1');
  });

  test('does not accept a findActive task with a matching identity but different payload', async () => {
    const { tasks } = makeTaskQueue({
      add: inFlight,
      findActive: async () => [
        {
          taskId: 'other-payload',
          previews: [{ ...taskPreview(), requestedWidth: 301 }],
        },
      ],
    });
    const r = makeResizer({ storage, tasks });

    const result = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'x.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });

    assert.equal(result.status, 'incomplete');
    assert.equal(result.accepted.length, 0);
    assert.equal(result.unconfirmed.length, 1);
    assert.equal(result.issues[0].code, 'RESIZE_TASK_IN_FLIGHT');
    assert.equal(result.issues[0].retryable, true);
  });

  test('rejects two different payloads that share one preview identity', async () => {
    let addCalls = 0;
    const { tasks } = makeTaskQueue({
      add: async () => {
        addCalls++;
        return { status: 'added', taskId: 'unexpected' };
      },
    });
    const r = makeResizer({
      storage,
      tasks,
      lockStore: locks().lockStore,
      hooks: {
        beforeEnqueue: (missing) => {
          const first = missing[0];
          return first
            ? [...missing, { ...first, requestedWidth: 301 }]
            : missing;
        },
      },
    });

    const result = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'x.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });

    assert.equal(result.status, 'incomplete');
    assert.equal(result.accepted.length, 0);
    assert.equal(result.unconfirmed.length, 2);
    assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_VARIANT_CONFLICT');
    assert.equal(addCalls, 0);
  });

  for (const [label, override] of [
    ['requestedHeight', { requestedHeight: 301 }],
    ['fit', { fit: true }],
  ] as const) {
    test(`rejects a ${label} conflict for one preview identity`, async () => {
      let addCalls = 0;
      const { tasks } = makeTaskQueue({
        add: async () => {
          addCalls++;
          return { status: 'added', taskId: 'unexpected' };
        },
      });
      const r = makeResizer({
        storage,
        tasks,
        lockStore: locks().lockStore,
        hooks: {
          beforeEnqueue: (missing) =>
            missing[0] ? [...missing, { ...missing[0], ...override }] : missing,
        },
      });

      const result = await r.prewarm({
        media: { id: `m-${label}`, original: { storageRef: { key: 'x.jpg' } } },
        sizes: [{ width: 300, height: 300 }],
        formats: ['jpeg'],
      });

      assert.equal(result.status, 'incomplete');
      assert.equal(result.accepted.length, 0);
      assert.equal(result.unconfirmed.length, 2);
      assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_VARIANT_CONFLICT');
      assert.equal(addCalls, 0);
    });
  }

  test('deduplicates identical payloads before strict confirmation', async () => {
    const calls: MissingPreview[][] = [];
    const { tasks } = makeTaskQueue({
      add: async ({ previews }) => {
        calls.push(previews);
        return { status: 'added', taskId: 'same-payload' };
      },
    });
    const r = makeResizer({
      storage,
      tasks,
      lockStore: locks().lockStore,
      hooks: {
        beforeEnqueue: (missing) =>
          missing[0] ? [...missing, missing[0]] : missing,
      },
    });

    const result = await r.prewarm({
      media: { id: 'm-same', original: { storageRef: { key: 'x.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });

    assert.equal(result.status, 'accepted');
    assert.equal(result.accepted.length, 1);
    assert.equal(calls[0]?.length, 1);
    assert.equal(result.issues.length, 0);
  });

  test('keeps different filter payloads as separate identities', async () => {
    const { tasks } = makeTaskQueue({
      add: async () => ({ status: 'added', taskId: 'filtered' }),
    });
    const r = makeResizer({
      storage,
      tasks,
      lockStore: locks().lockStore,
      hooks: {
        beforeEnqueue: (missing) =>
          missing[0]
            ? [...missing, { ...missing[0], filters: { tone: 'warm' } }]
            : missing,
      },
    });

    const result = await r.prewarm({
      media: { id: 'm-filters', original: { storageRef: { key: 'x.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });

    assert.equal(result.status, 'accepted');
    assert.equal(result.accepted.length, 2);
    assert.equal(result.issues.length, 0);
  });

  test('does not confirm a requested payload from a conflicting findActive receipt', async () => {
    const requested = taskPreview('webp');
    const { tasks } = makeTaskQueue({
      add: inFlight,
      findActive: async () => [
        {
          taskId: 'active-conflict',
          previews: [requested, { ...requested, requestedWidth: 20 }],
        },
      ],
    });
    const r = makeResizer({ storage, tasks });

    const result = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'x.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['webp'],
    });

    assert.equal(result.status, 'incomplete');
    assert.equal(result.accepted.length, 0);
    assert.equal(result.unconfirmed.length, 1);
    assert.equal(result.tasks.length, 0);
    assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_VARIANT_CONFLICT');
    assert.deepEqual(result.issues[0].previews, [requested]);
  });

  test('a conflicting findActive receipt does not block a separate correct receipt', async () => {
    const jpeg = taskPreview('jpeg');
    const webp = taskPreview('webp');
    const { tasks } = makeTaskQueue({
      add: inFlight,
      findActive: async () => [
        {
          taskId: 'active-conflict',
          previews: [jpeg, { ...jpeg, requestedWidth: 20 }],
        },
        { taskId: 'active-correct', previews: [webp] },
      ],
    });
    const r = makeResizer({ storage, tasks });

    const result = await r.prewarm({
      media: { id: 'm-separate', original: { storageRef: { key: 'x.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
    });

    assert.equal(result.status, 'incomplete');
    assert.deepEqual(result.accepted, [webp]);
    assert.deepEqual(result.unconfirmed, [jpeg]);
    assert.deepEqual(result.tasks, [
      { taskId: 'active-correct', previews: [webp] },
    ]);
    assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_VARIANT_CONFLICT');
    assert.deepEqual(result.issues[0].previews, [jpeg]);
  });

  test('an add failure shortens the gate lock to one lease, and a later call can safely retry', async () => {
    let calls = 0;
    const { tasks } = makeTaskQueue({
      gates: false,
      add: async () => {
        calls++;
        if (calls === 1) {
          throw new Error('connection dropped after lock');
        }
        return { status: 'added', taskId: 'task-2' };
      },
    });
    const { lockStore, extended, released } = locks(true);
    const r = makeResizer({
      storage,
      tasks,
      lockStore,
    });
    const opts: Parameters<Resizer['prewarm']>[0] = {
      media: { id: 'm1', original: { storageRef: { key: 'x.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    };
    const first = await r.prewarm(opts);
    const second = await r.prewarm(opts);
    assert.equal(first.status, 'incomplete');
    assert.equal(first.issues[0].code, 'RESIZE_ENQUEUE_QUEUE_FAILED');
    // Kept for the default lease (the queue may have stored the task), never released.
    assert.deepEqual(extended, [
      ['resize_gate:default:default:m1:default', 60_000],
    ]);
    assert.deepEqual(released, []);
    // This lock store grants every acquire, as one whose lock has lapsed would.
    assert.equal(second.status, 'accepted');
    assert.equal(second.tasks[0].taskId, 'task-2');
  });
});

describe('prewarm — pipeline scope is part of preview identity', () => {
  test('a default pipeline preview does not make a watermark pipeline request ready', async () => {
    const { tasks } = makeTaskQueue({
      add: async () => ({ status: 'added', taskId: 'task-1' }),
    });
    const r = makeResizer({
      storage,
      tasks,
      lockStore: locks().lockStore,
      pipelines: { watermark: {} },
    });
    const media = {
      id: 'm1',
      original: { storageRef: { key: 'original.jpg' } },
      previews: [
        {
          storageRef: { key: 'p.jpg' },
          sizeKey: '300x300',
          format: 'jpeg',
          contentType: 'image/jpeg',
        },
      ],
    };
    const sizes = [{ width: 300, height: 300 }];
    const clean = await r.prewarm({ media, sizes, formats: ['jpeg'] });
    assert.equal(clean.status, 'ready');
    const watermarked = await r.prewarm({
      media,
      sizes,
      formats: ['jpeg'],
      pipeline: 'watermark',
    });
    assert.equal(watermarked.status, 'accepted');
    assert.equal(watermarked.accepted.length, 1);
  });
});

describe('prewarm — issues describe only what stays unconfirmed', () => {
  test('an in-flight add whose active task holds every variant leaves no issue', async () => {
    const { tasks } = makeTaskQueue({
      add: inFlight,
      findActive: async () => [
        { taskId: 'active-1', previews: [taskPreview('jpeg')] },
      ],
    });
    const r = makeResizer({ storage, tasks });
    const result = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'x.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(result.status, 'accepted');
    assert.deepEqual(result.unconfirmed, []);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.tasks, [
      { taskId: 'active-1', previews: [taskPreview('jpeg')] },
    ]);
  });

  test('a partly covered in-flight add reports RESIZE_TASK_IN_FLIGHT for the rest only', async () => {
    const { tasks } = makeTaskQueue({
      add: inFlight,
      findActive: async () => [
        { taskId: 'active-1', previews: [taskPreview('jpeg')] },
      ],
    });
    const r = makeResizer({ storage, tasks });
    const result = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'x.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
    });
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(result.accepted, [taskPreview('jpeg')]);
    assert.deepEqual(result.unconfirmed, [taskPreview('webp')]);
    assert.deepEqual(result.issues, [
      {
        code: 'RESIZE_TASK_IN_FLIGHT',
        message:
          'a task for this media, pipeline and queue is active, or cooling down after a dead-letter; a read after it finishes queues these',
        retryable: true,
        previews: [taskPreview('webp')],
      },
    ]);
  });

  for (const [label, add, code] of [
    [
      'an unconfirmed add',
      async (): Promise<TaskAddResult> => ({ status: 'unconfirmed' }),
      'RESIZE_ENQUEUE_UNCONFIRMED',
    ],
    [
      'a throwing add',
      async () => {
        throw new Error('connection dropped after insert');
      },
      'RESIZE_ENQUEUE_QUEUE_FAILED',
    ],
  ] as const) {
    test(`${label} is never confirmed through findActive, which is read only after an in-flight add`, async () => {
      let lookups = 0;
      const { tasks } = makeTaskQueue({
        add,
        findActive: async () => {
          lookups++;
          return [{ taskId: 'active-1', previews: [taskPreview('jpeg')] }];
        },
      });
      const r = makeResizer({ storage, tasks });
      const result = await r.prewarm({
        media: { id: 'm1', original: { storageRef: { key: 'x.jpg' } } },
        sizes: [{ width: 300, height: 300 }],
        formats: ['jpeg'],
      });
      assert.equal(result.status, 'incomplete');
      assert.deepEqual(result.accepted, []);
      assert.deepEqual(result.tasks, []);
      assert.deepEqual(
        result.issues.map((issue) => [issue.code, issue.retryable]),
        [[code, true]],
      );
      assert.equal(lookups, 0);
    });
  }
});

describe('prewarm — an internal error after expansion', () => {
  test('echoes the expanded request, all of it unconfirmed', async () => {
    const { tasks, added } = makeTaskQueue();
    const r = makeResizer({
      storage,
      tasks,
      lockStore: locks().lockStore,
      // A host bug: the tap returns nothing, which the policy step cannot read.
      hooks: { beforeEnqueue: (() => undefined) as never },
    });
    const result = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'x.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
    });
    const expanded = [taskPreview('jpeg'), taskPreview('webp')];
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(result.requested, expanded);
    assert.deepEqual(result.unconfirmed, expanded);
    assert.deepEqual(result.ready, []);
    assert.deepEqual(result.accepted, []);
    assert.deepEqual(result.notRequired, []);
    assert.deepEqual(result.tasks, []);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_INTERNAL_ERROR');
    assert.equal(result.issues[0].retryable, true);
    assert.deepEqual(result.issues[0].previews, expanded);
    assert.equal(added.length, 0);
  });

  test('a config error before expansion still reports an empty request', async () => {
    const r = new Resizer({
      storage,
      media: fakeMedia(),
      logger,
      config: () => ({ ...makeImageConfig(), upload: null }) as never,
    });
    const result = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'x.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
    });
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(result.requested, []);
    assert.deepEqual(result.unconfirmed, []);
    assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_INTERNAL_ERROR');
    assert.equal(result.issues[0].retryable, false);
  });
});

describe('prewarm — the gate lock of a queue without gatesByTask', () => {
  const media = (id: string) => ({
    id,
    original: { storageRef: { key: 'x.jpg' } },
  });
  const request = {
    sizes: [{ width: 300, height: 300 }],
    formats: ['jpeg', 'webp'],
  };

  test('one acquire covers the request: a held lock is LOCK_CONTENDED, a rejecting one LOCK_FAILED, for every variant', async () => {
    const { tasks, added } = makeTaskQueue({ gates: false });
    const gate = locks((key) => {
      if (key.includes(':failing:')) {
        throw new Error('lock backend down');
      }
      return !key.includes(':held:');
    });
    const r = makeResizer({ storage, tasks, lockStore: gate.lockStore });
    const free = await r.prewarm({ media: media('free'), ...request });
    const held = await r.prewarm({ media: media('held'), ...request });
    const failing = await r.prewarm({ media: media('failing'), ...request });
    assert.deepEqual(gate.acquired, [
      'resize_gate:default:default:free:default',
      'resize_gate:default:default:held:default',
      'resize_gate:default:default:failing:default',
    ]);
    assert.deepEqual(
      added.map((task) => task.mediaId),
      ['free'],
    );
    assert.equal(free.status, 'accepted');
    for (const [result, code] of [
      [held, 'RESIZE_ENQUEUE_LOCK_CONTENDED'],
      [failing, 'RESIZE_ENQUEUE_LOCK_FAILED'],
    ] as const) {
      assert.equal(result.status, 'incomplete');
      assert.deepEqual(result.accepted, []);
      assert.deepEqual(
        result.issues.map((issue) => [
          issue.code,
          issue.retryable,
          issue.previews.map((p) => p.format),
        ]),
        [[code, true, ['jpeg', 'webp']]],
      );
    }
  });
});
