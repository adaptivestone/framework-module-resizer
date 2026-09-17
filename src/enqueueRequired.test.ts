import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import {
  type LockProvider,
  type QueueTransport,
  Resizer,
  type ResizeStorage,
  resetResizerForTests,
} from './resizer.ts';
import type { MissingPreview } from './types.d.ts';

const storage: ResizeStorage = {
  download: async () => Buffer.alloc(0),
  upload: async ({ key }) => ({ key }),
  publicUrl: () => '',
};

function installApp() {
  setAppInstance({
    getConfig: () => ({ mediaModelName: 'File' }),
    getModel: () => ({}),
    logger: { info() {}, warn() {}, error() {} },
  } as never);
}

function locks(
  acquire: boolean | ((key: string) => boolean | Promise<boolean>) = true,
) {
  const released: string[] = [];
  const lockProvider: LockProvider = {
    acquire: async (key) =>
      typeof acquire === 'function' ? acquire(key) : acquire,
    release: async (key) => {
      released.push(key);
    },
  };
  return { lockProvider, released };
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
  resetAppInstance();
});

describe('enqueueRequired — explicit coverage', () => {
  test('returns accepted variants and the durable transport receipt', async () => {
    installApp();
    const calls: MissingPreview[][] = [];
    const transport: QueueTransport = {
      enqueue: async ({ previews }) => {
        calls.push(previews);
        return { taskId: 'task-1' };
      },
      startWorker: async () => {},
    };
    const r = new Resizer({
      storage,
      transport,
      lockProvider: locks().lockProvider,
    });
    const result = await r.enqueueRequired({
      media: { id: 'm1', original: { key: 'original.jpg' } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
    });

    assert.equal(result.status, 'accepted');
    assert.equal(result.accepted.length, 2);
    assert.equal(result.unconfirmed.length, 0);
    assert.deepEqual(result.tasks, [{ taskId: 'task-1', previews: calls[0] }]);
  });

  test('distinguishes already ready, SVG, empty, and policy-filtered requests', async () => {
    installApp();
    const transport: QueueTransport = {
      enqueue: async () => ({ taskId: 'unexpected' }),
      startWorker: async () => {},
    };
    const ready = new Resizer({ storage, transport });
    const readyResult = await ready.enqueueRequired({
      media: {
        id: 'm1',
        original: { key: 'original.jpg' },
        previews: [
          {
            key: 'ready.jpg',
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
    const svg = new Resizer({ storage, transport });
    const svgResult = await svg.enqueueRequired({
      media: {
        id: 'm2',
        original: { key: 'logo.svg', contentType: 'image/svg+xml' },
      },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(svgResult.status, 'not-required');
    assert.equal(svgResult.reason, 'svg');
    assert.equal(svgResult.notRequired.length, 1);

    resetResizerForTests();
    const empty = new Resizer({ storage, transport });
    assert.equal(
      (
        await empty.enqueueRequired({
          media: { id: 'm3', original: { key: 'x.jpg' } },
          sizes: [],
        })
      ).reason,
      'empty-request',
    );

    resetResizerForTests();
    const filtered = new Resizer({
      storage,
      transport,
      hooks: { beforeEnqueue: () => [] },
    });
    const filteredResult = await filtered.enqueueRequired({
      media: { id: 'm4', original: { key: 'x.jpg' } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(filteredResult.status, 'not-required');
    assert.equal(filteredResult.reason, 'filtered');
    assert.equal(filteredResult.notRequired.length, 1);
  });

  test('reports no transport, no original, and null taskId as incomplete', async () => {
    installApp();
    const noTransport = new Resizer({ storage });
    const missingTransport = await noTransport.enqueueRequired({
      media: { id: 'm1', original: { key: 'x.jpg' } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(missingTransport.status, 'incomplete');
    assert.equal(
      missingTransport.issues[0].code,
      'RESIZE_ENQUEUE_NO_TRANSPORT',
    );

    resetResizerForTests();
    const transport: QueueTransport = {
      enqueue: async () => ({ taskId: null }),
      startWorker: async () => {},
    };
    const noOriginal = new Resizer({
      storage,
      transport,
      lockProvider: locks().lockProvider,
    });
    const missingOriginal = await noOriginal.enqueueRequired({
      media: { id: 'm2' },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(missingOriginal.status, 'incomplete');
    assert.equal(missingOriginal.issues[0].code, 'RESIZE_ENQUEUE_NO_ORIGINAL');

    const nullTask = await noOriginal.enqueueRequired({
      media: { id: 'm3', original: { key: 'x.jpg' } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(nullTask.status, 'incomplete');
    assert.equal(nullTask.accepted.length, 0);
    assert.equal(nullTask.unconfirmed.length, 1);
    assert.equal(nullTask.issues[0].code, 'RESIZE_ENQUEUE_UNCONFIRMED');
  });

  test('does not accept an empty custom-transport task id', async () => {
    installApp();
    const transport: QueueTransport = {
      enqueue: async () => ({ taskId: '' }),
      startWorker: async () => {},
    };
    const r = new Resizer({
      storage,
      transport,
      lockProvider: locks().lockProvider,
    });
    const result = await r.enqueueRequired({
      media: { id: 'm1', original: { key: 'x.jpg' } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.tasks.length, 0);
  });
});

describe('enqueueRequired — lock races and retries', () => {
  test('a held lock is incomplete when the transport cannot prove an active task', async () => {
    installApp();
    let enqueueCalls = 0;
    const transport: QueueTransport = {
      enqueue: async () => {
        enqueueCalls++;
        return { taskId: 'unexpected' };
      },
      startWorker: async () => {},
    };
    const r = new Resizer({
      storage,
      transport,
      lockProvider: locks(false).lockProvider,
    });
    const result = await r.enqueueRequired({
      media: { id: 'm1', original: { key: 'x.jpg' } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.accepted.length, 0);
    assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_LOCK_CONTENDED');
    assert.equal(enqueueCalls, 0);
  });

  test('a queryable transport may prove coverage by an existing active task', async () => {
    installApp();
    const transport: QueueTransport = {
      enqueue: async () => ({ taskId: 'unexpected' }),
      findActive: async () => [
        { taskId: 'active-1', previews: [taskPreview()] },
      ],
      startWorker: async () => {},
    };
    const r = new Resizer({
      storage,
      transport,
      lockProvider: locks(false).lockProvider,
    });
    const result = await r.enqueueRequired({
      media: { id: 'm1', original: { key: 'x.jpg' } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(result.status, 'accepted');
    assert.equal(result.accepted.length, 1);
    assert.equal(result.unconfirmed.length, 0);
    assert.equal(result.tasks[0].taskId, 'active-1');
  });

  test('does not accept an active task whose identity matches but payload differs', async () => {
    installApp();
    const transport: QueueTransport = {
      enqueue: async () => ({ taskId: 'unexpected' }),
      findActive: async () => [
        {
          taskId: 'other-payload',
          previews: [{ ...taskPreview(), requestedWidth: 301 }],
        },
      ],
      startWorker: async () => {},
    };
    const r = new Resizer({
      storage,
      transport,
      lockProvider: locks(false).lockProvider,
    });

    const result = await r.enqueueRequired({
      media: { id: 'm1', original: { key: 'x.jpg' } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });

    assert.equal(result.status, 'incomplete');
    assert.equal(result.accepted.length, 0);
    assert.equal(result.unconfirmed.length, 1);
    assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_LOCK_CONTENDED');
  });

  test('rejects two different payloads that share one preview identity', async () => {
    installApp();
    let enqueueCalls = 0;
    const transport: QueueTransport = {
      enqueue: async () => {
        enqueueCalls++;
        return { taskId: 'unexpected' };
      },
      startWorker: async () => {},
    };
    const r = new Resizer({
      storage,
      transport,
      lockProvider: locks().lockProvider,
      hooks: {
        beforeEnqueue: (missing) => {
          const first = missing[0];
          return first
            ? [...missing, { ...first, requestedWidth: 301 }]
            : missing;
        },
      },
    });

    const result = await r.enqueueRequired({
      media: { id: 'm1', original: { key: 'x.jpg' } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });

    assert.equal(result.status, 'incomplete');
    assert.equal(result.accepted.length, 0);
    assert.equal(result.unconfirmed.length, 2);
    assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_VARIANT_CONFLICT');
    assert.equal(enqueueCalls, 0);
  });

  test('an enqueue failure releases its lock and a later call can safely retry', async () => {
    installApp();
    let calls = 0;
    const transport: QueueTransport = {
      enqueue: async () => {
        calls++;
        if (calls === 1) {
          throw new Error('connection dropped after lock');
        }
        return { taskId: 'task-2' };
      },
      startWorker: async () => {},
    };
    const { lockProvider, released } = locks(true);
    const r = new Resizer({ storage, transport, lockProvider });
    const opts: Parameters<Resizer['enqueueRequired']>[0] = {
      media: { id: 'm1', original: { key: 'x.jpg' } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    };
    const first = await r.enqueueRequired(opts);
    const second = await r.enqueueRequired(opts);
    assert.equal(first.status, 'incomplete');
    assert.equal(first.issues[0].code, 'RESIZE_ENQUEUE_TRANSPORT_FAILED');
    assert.equal(released.length, 1);
    assert.equal(second.status, 'accepted');
    assert.equal(second.tasks[0].taskId, 'task-2');
  });

  test('partial lock coverage reports accepted and unconfirmed variants separately', async () => {
    installApp();
    const transport: QueueTransport = {
      enqueue: async () => ({ taskId: 'jpeg-task' }),
      startWorker: async () => {},
    };
    const r = new Resizer({
      storage,
      transport,
      lockProvider: locks((key) => key.includes(':jpeg:')).lockProvider,
    });
    const result = await r.enqueueRequired({
      media: { id: 'm1', original: { key: 'x.jpg' } },
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
