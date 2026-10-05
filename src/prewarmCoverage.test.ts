import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import type { ResizeStorage } from './contracts/storage.ts';
import type { NewTask, TaskQueue } from './contracts/taskQueue.ts';
import { Resizer, resetResizerForTests } from './resizer.ts';
import type { FakeLocks } from './testHelpers/fakes.ts';
import { fakeDb, MemoryTaskQueue } from './testHelpers/fakes.ts';
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

function makeTaskQueue(
  overrides: {
    add?: (task: NewTask) => Promise<{ taskId: string | null }>;
    findActive?: (query: {
      resizer: string;
      mediaId: string;
      pipeline: string;
    }) => Promise<EnqueueReceipt[]>;
  } = {},
) {
  const memory = new MemoryTaskQueue();
  const added: NewTask[] = [];
  const tasks: TaskQueue = {
    add: async (task) => {
      added.push(task);
      return overrides.add ? overrides.add(task) : memory.add(task);
    },
    claim: (queue, leaseMs) => memory.claim(queue, leaseMs),
    renew: (task, leaseMs) => memory.renew(task, leaseMs),
    complete: (task) => memory.complete(task),
    fail: (task, next, error) => memory.fail(task, next, error),
    findActive: overrides.findActive ?? ((query) => memory.findActive(query)),
    getTiming: () => memory.getTiming(),
  };
  return { tasks, added };
}

function locks(
  acquire: boolean | ((key: string) => boolean | Promise<boolean>) = true,
) {
  const released: string[] = [];
  const dbLocks: FakeLocks = {
    acquire: async (key) =>
      typeof acquire === 'function' ? acquire(key) : acquire,
    release: async (key) => {
      released.push(key);
    },
  };
  return { dbLocks, released };
}

function makeResizer(
  options: {
    storage?: ResizeStorage;
    tasks?: TaskQueue;
    dbLocks?: FakeLocks;
    name?: string;
    queue?: string;
    hooks?: ConstructorParameters<typeof Resizer>[0]['hooks'];
    pipelines?: ConstructorParameters<typeof Resizer>[0]['pipelines'];
  } = {},
) {
  return new Resizer({
    storage: options.storage ?? storage,
    db: fakeDb({ locks: options.dbLocks }),
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
        return { taskId: 'task-1' };
      },
    });
    const r = makeResizer({
      storage,
      tasks,
      dbLocks: locks().dbLocks,
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

  test('added tasks record the Resizer name and queue; findActive uses the Resizer, media, and pipeline scope', async () => {
    const added: { resizer: string; queue: string }[] = [];
    const looked: { resizer: string; mediaId: string; pipeline: string }[] = [];
    const { tasks } = makeTaskQueue({
      add: async ({ resizer, queue }) => {
        added.push({ resizer, queue });
        return { taskId: 'task-1' };
      },
      findActive: async ({ resizer, mediaId, pipeline }) => {
        looked.push({ resizer, mediaId, pipeline });
        return [];
      },
    });
    const r = makeResizer({
      storage,
      // The jpeg lock is won for add; the webp lock is lost and checked via findActive.
      tasks,
      dbLocks: locks((key) => key.endsWith(':jpeg:none')).dbLocks,
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
      { resizer: 'listings', mediaId: 'm1', pipeline: 'default' },
    ]);
  });

  test('distinguishes already ready, SVG, empty, and policy-filtered requests', async () => {
    const { tasks } = makeTaskQueue({
      add: async () => ({ taskId: 'unexpected' }),
    });
    const ready = makeResizer({
      storage,
      tasks,
      dbLocks: locks().dbLocks,
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
      dbLocks: locks().dbLocks,
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

  test('reports no task queue, no original, and null taskId as incomplete', async () => {
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
      add: async () => ({ taskId: null }),
    });
    const noOriginal = makeResizer({
      storage,
      tasks,
      dbLocks: locks().dbLocks,
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
      add: async () => ({ taskId: '' }),
    });
    const r = makeResizer({
      storage,
      tasks,
      dbLocks: locks().dbLocks,
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

describe('prewarm — dispatch-lock races and retries', () => {
  test('a contended dispatch lock is incomplete without findActive proof', async () => {
    let addCalls = 0;
    const { tasks } = makeTaskQueue({
      add: async () => {
        addCalls++;
        return { taskId: 'unexpected' };
      },
    });
    const r = makeResizer({
      storage,
      tasks,
      dbLocks: locks(false).dbLocks,
    });
    const result = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'x.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.accepted.length, 0);
    assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_LOCK_CONTENDED');
    assert.equal(addCalls, 0);
  });

  test('findActive may prove coverage by an existing active task', async () => {
    const { tasks } = makeTaskQueue({
      add: async () => ({ taskId: 'unexpected' }),
      findActive: async () => [
        { taskId: 'active-1', previews: [taskPreview()] },
      ],
    });
    const r = makeResizer({
      storage,
      tasks,
      dbLocks: locks(false).dbLocks,
    });
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
      add: async () => ({ taskId: 'unexpected' }),
      findActive: async () => [
        {
          taskId: 'other-payload',
          previews: [{ ...taskPreview(), requestedWidth: 301 }],
        },
      ],
    });
    const r = makeResizer({
      storage,
      tasks,
      dbLocks: locks(false).dbLocks,
    });

    const result = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'x.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });

    assert.equal(result.status, 'incomplete');
    assert.equal(result.accepted.length, 0);
    assert.equal(result.unconfirmed.length, 1);
    assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_LOCK_CONTENDED');
  });

  test('rejects two different payloads that share one preview identity', async () => {
    let addCalls = 0;
    const { tasks } = makeTaskQueue({
      add: async () => {
        addCalls++;
        return { taskId: 'unexpected' };
      },
    });
    const r = makeResizer({
      storage,
      tasks,
      dbLocks: locks().dbLocks,
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
          return { taskId: 'unexpected' };
        },
      });
      const r = makeResizer({
        storage,
        tasks,
        dbLocks: locks().dbLocks,
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
        return { taskId: 'same-payload' };
      },
    });
    const r = makeResizer({
      storage,
      tasks,
      dbLocks: locks().dbLocks,
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
      add: async () => ({ taskId: 'filtered' }),
    });
    const r = makeResizer({
      storage,
      tasks,
      dbLocks: locks().dbLocks,
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
      add: async () => ({ taskId: 'unexpected' }),
      findActive: async () => [
        {
          taskId: 'active-conflict',
          previews: [requested, { ...requested, requestedWidth: 20 }],
        },
      ],
    });
    const r = makeResizer({
      storage,
      tasks,
      dbLocks: locks(false).dbLocks,
    });

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
      add: async () => ({ taskId: 'unexpected' }),
      findActive: async () => [
        {
          taskId: 'active-conflict',
          previews: [jpeg, { ...jpeg, requestedWidth: 20 }],
        },
        { taskId: 'active-correct', previews: [webp] },
      ],
    });
    const r = makeResizer({
      storage,
      tasks,
      dbLocks: locks(false).dbLocks,
    });

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

  test('an add failure releases its dispatch lock and a later call can safely retry', async () => {
    let calls = 0;
    const { tasks } = makeTaskQueue({
      add: async () => {
        calls++;
        if (calls === 1) {
          throw new Error('connection dropped after lock');
        }
        return { taskId: 'task-2' };
      },
    });
    const { dbLocks, released } = locks(true);
    const r = makeResizer({
      storage,
      tasks,
      dbLocks,
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
    assert.equal(released.length, 1);
    assert.equal(second.status, 'accepted');
    assert.equal(second.tasks[0].taskId, 'task-2');
  });

  test('partial lock coverage reports accepted and unconfirmed variants separately', async () => {
    const { tasks } = makeTaskQueue({
      add: async () => ({ taskId: 'jpeg-task' }),
    });
    const r = makeResizer({
      storage,
      tasks,
      dbLocks: locks((key) => key.includes(':jpeg:')).dbLocks,
    });
    const result = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'x.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
    });
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(
      result.accepted.map((v) => v.format),
      ['jpeg'],
    );
    assert.deepEqual(
      result.unconfirmed.map((v) => v.format),
      ['webp'],
    );
  });
});

describe('prewarm — pipeline scope is part of preview identity', () => {
  test('a default pipeline preview does not make a watermark pipeline request ready', async () => {
    const { tasks } = makeTaskQueue({
      add: async () => ({ taskId: 'task-1' }),
    });
    const r = makeResizer({
      storage,
      tasks,
      dbLocks: locks().dbLocks,
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
  for (const [label, add, code] of [
    ['a null taskId', async () => ({ taskId: null }), 'UNCONFIRMED'],
    [
      'a throwing add',
      async () => {
        throw new Error('connection dropped after insert');
      },
      'QUEUE_FAILED',
    ],
  ] as const) {
    test(`${label} confirmed by findActive leaves no RESIZE_ENQUEUE_${code} issue`, async () => {
      const { tasks } = makeTaskQueue({
        add,
        findActive: async () => [
          { taskId: 'active-1', previews: [taskPreview('jpeg')] },
        ],
      });
      const r = makeResizer({ storage, tasks, dbLocks: locks().dbLocks });
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
  }

  test('a partly confirmed failure keeps its issue for the unconfirmed previews only', async () => {
    const { tasks } = makeTaskQueue({
      add: async () => {
        throw new Error('connection dropped after insert');
      },
      findActive: async () => [
        { taskId: 'active-1', previews: [taskPreview('jpeg')] },
      ],
    });
    const r = makeResizer({ storage, tasks, dbLocks: locks().dbLocks });
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
        code: 'RESIZE_ENQUEUE_QUEUE_FAILED',
        message: 'adding the task failed; outcome is unconfirmed',
        retryable: true,
        previews: [taskPreview('webp')],
      },
    ]);
  });
});

describe('prewarm — an internal error after expansion', () => {
  test('echoes the expanded request, all of it unconfirmed', async () => {
    const { tasks, added } = makeTaskQueue();
    const r = makeResizer({
      storage,
      tasks,
      dbLocks: locks().dbLocks,
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
      db: fakeDb(),
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

describe('prewarm — dispatch locks', () => {
  test('are acquired in parallel; contended and failed locks are still reported', async () => {
    const { tasks, added } = makeTaskQueue({
      add: async () => ({ taskId: 'task-1' }),
      findActive: async () => [],
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const r = makeResizer({
      storage,
      tasks,
      dbLocks: locks(async (key) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        if (key.includes(':avif:')) {
          throw new Error('lock backend down');
        }
        return !key.includes(':webp:');
      }).dbLocks,
    });
    const result = await r.prewarm({
      media: { id: 'm1', original: { storageRef: { key: 'x.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp', 'avif'],
    });
    assert.equal(maxInFlight, 3);
    assert.deepEqual(
      added[0]?.previews.map((p) => p.format),
      ['jpeg'],
    );
    assert.deepEqual(
      result.accepted.map((p) => p.format),
      ['jpeg'],
    );
    assert.deepEqual(
      result.issues.map((issue) => [
        issue.code,
        issue.previews.map((p) => p.format),
      ]),
      [
        ['RESIZE_ENQUEUE_LOCK_CONTENDED', ['webp']],
        ['RESIZE_ENQUEUE_LOCK_FAILED', ['avif']],
      ],
    );
  });
});
