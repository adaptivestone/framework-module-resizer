import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import { Catalog } from './catalog.ts';
import { defaultCoordination } from './config/resize.ts';
import type { LockStore } from './contracts/locks.ts';
import type { ResizeStorage } from './contracts/storage.ts';
import type { NewTask, TaskAddResult } from './contracts/taskQueue.ts';
import { Dispatcher } from './dispatcher.ts';
import {
  ResizeConfigError,
  ResizeError,
  ResizeNoOriginalError,
  ResizeSetupError,
  ResizeStorageError,
} from './errors.ts';
import { FrameworkResizer } from './framework/resizer.ts';
import { HookBus } from './hooks.ts';
import { NoopMetrics } from './metrics.ts';
import { PipelineRegistry } from './pipelines.ts';
import { prewarmFailure, Reader, type ReaderDeps } from './reader.ts';
import { Resizer, resetResizerForTests } from './resizer.ts';
import { RoutingTaskQueue } from './routing.ts';
import {
  fakeMedia,
  MemoryTaskQueue,
  PlainTaskQueue,
  recordingMetrics,
  refKey,
} from './testHelpers/fakes.ts';
import { stampFresh } from './testHelpers/fresh.ts';
import {
  makeImageConfig,
  makeResizeConfig,
} from './testHelpers/resizeConfig.ts';
import { timingOf } from './timing.ts';
import type { MediaLike, ResizeLogger, StorageRef } from './types.d.ts';

// ---------------------------------------------------------------------------
// Harness — a recording ambient app (getConfig('resize') → { mediaModelName },
// recording logger) + recording driver fakes. A Resizer takes its logger/config from the
// app when it is constructed, so install the fake before constructing the Resizer.
// ---------------------------------------------------------------------------

function installFakeApp() {
  const info: unknown[][] = [];
  const warn: unknown[][] = [];
  const errors: unknown[][] = [];
  setAppInstance({
    getConfig: () => makeResizeConfig(),
    getModel: () => ({}),
    logger: {
      info(...a: unknown[]) {
        info.push(a);
      },
      warn(...a: unknown[]) {
        warn.push(a);
      },
      error(...a: unknown[]) {
        errors.push(a);
      },
    },
  } as never);
  return { info, warn, errors };
}

function makeStorage(o: Partial<ResizeStorage> = {}): ResizeStorage {
  return {
    download: async () => Buffer.alloc(0),
    upload: async () => ({ key: 'k' }),
    publicUrl: (ref: StorageRef) => `https://cdn/${refKey(ref)}`,
    ...o,
  };
}

// A task queue that records every add; `tasks` defaults to a queue that gates by task.
function makeTasks(
  behavior?: (task: NewTask) => TaskAddResult,
  tasks: MemoryTaskQueue | PlainTaskQueue = new MemoryTaskQueue(),
) {
  const calls: NewTask[] = [];
  tasks.add = async (task) => {
    calls.push(task);
    return behavior ? behavior(task) : { status: 'added', taskId: 't1' };
  };
  return { tasks, calls };
}

function makeLocks(acquire: boolean | ((key: string) => boolean) = true) {
  const acquired: { key: string; ttl: number }[] = [];
  const extended: { key: string; ttl: number }[] = [];
  const released: string[] = [];
  const locks: LockStore = {
    acquire: async (key, _owner, ttl) => {
      acquired.push({ key, ttl });
      return typeof acquire === 'function' ? acquire(key) : acquire;
    },
    extend: async (key, _owner, ttl) => {
      extended.push({ key, ttl });
      return true;
    },
    release: async (key) => {
      released.push(key);
      return true;
    },
  };
  return { locks, acquired, extended, released };
}

afterEach(() => {
  resetResizerForTests();
  resetAppInstance();
});

// ---------------------------------------------------------------------------
// A Reader built from its parts: no Resizer, no media store, no framework app.
// ---------------------------------------------------------------------------

const silent: ResizeLogger = { info() {}, warn() {}, error() {} };

/** A Reader on a webp-only config; `dispatcher` undefined means an eager-only Resizer. */
function readerDeps(dispatcher: Dispatcher | undefined): ReaderDeps {
  const config = makeImageConfig({ formats: ['webp'] });
  return {
    catalog: new Catalog({ config }),
    dispatcher,
    hooks: new HookBus({ logger: silent }),
    pipelines: new PipelineRegistry(),
    storage: {
      download: async () => Buffer.alloc(0),
      upload: async () => ({ key: 'k' }),
      publicUrl: (ref) => `https://cdn/${(ref as { key: string }).key}`,
    },
    logger: silent,
    name: 'default',
    queueName: 'default',
  };
}

describe('Reader', () => {
  const media: MediaLike = {
    id: 'm1',
    original: { storageRef: { key: 'o' } },
    previews: [
      {
        storageRef: { key: 'p' },
        sizeKey: '10x10',
        format: 'webp',
        contentType: 'image/webp',
      },
    ],
  };

  test('a Reader serves stored previews and queues the missing ones, with no Resizer and no media store', async () => {
    const media = stampFresh({
      id: 'm1',
      original: { storageRef: { key: 'o' }, width: 64, height: 48 },
      previews: [
        {
          storageRef: { key: 'p' },
          sizeKey: '10x10',
          format: 'webp',
          contentType: 'image/webp',
        },
      ],
    });
    const tasks = new MemoryTaskQueue();
    const reader = new Reader(
      readerDeps(
        new Dispatcher({
          tasks,
          locks: undefined, // a task queue that gates by task needs none
          coordination: defaultCoordination,
          timingOf: (queue) => timingOf(tasks, queue),
          name: 'default',
          logger: silent,
        }),
      ),
    );
    const { decision } = await reader.resolve({
      media,
      sizes: [
        { width: 10, height: 10 },
        { width: 20, height: 20 },
      ],
    });
    assert.deepEqual(
      decision.ready.map((e) => e.url),
      ['https://cdn/p'],
    );
    assert.deepEqual(
      decision.missing.map((v) => v.sizeKey),
      ['20x20'],
    );
    assert.deepEqual(
      tasks.added[0].previews.map((v) => v.sizeKey),
      ['20x20'],
    );
    // Another media: the task queued above holds the gate of m1.
    assert.equal(
      (
        await reader.prewarm({
          media: { ...media, id: 'm2' },
          sizes: [{ width: 30, height: 30 }],
        })
      ).status,
      'accepted',
    );
  });

  test('resolve on such a queue logs once per queue name and returns its decision', async () => {
    const media = stampFresh({
      id: 'm1',
      original: { storageRef: { key: 'o' }, width: 64, height: 48 },
      previews: [
        {
          storageRef: { key: 'p' },
          sizeKey: '10x10',
          format: 'webp',
          contentType: 'image/webp',
        },
      ],
    });
    // A task queue that serves only 'default'.
    const tasks = new MemoryTaskQueue({ queues: ['default'] });
    const warnings: unknown[][] = [];
    const logged: unknown[][] = [];
    const logger: ResizeLogger = {
      info() {},
      warn: (...a: unknown[]) => warnings.push(a),
      error: (...a: unknown[]) => logged.push(a),
    };
    const deps = readerDeps(
      new Dispatcher({
        tasks,
        locks: undefined,
        coordination: defaultCoordination,
        timingOf: (queue) => timingOf(tasks, queue),
        name: 'default',
        logger,
      }),
    );
    deps.logger = logger;
    const reader = new Reader(deps);
    const sizes = [
      { width: 10, height: 10 },
      { width: 20, height: 20 },
    ];
    for (const queue of ['bulk', 'bulk', 'other']) {
      const { decision } = await reader.resolve({ media, sizes, queue });
      assert.deepEqual(
        decision.ready.map((e) => e.url),
        ['https://cdn/p'],
      );
      assert.deepEqual(
        decision.missing.map((v) => v.sizeKey),
        ['20x20'],
      );
    }
    assert.equal(warnings.length, 2);
    assert.match(String(warnings[0][0]), /cannot queue to 'bulk'/);
    assert.match(String(warnings[1][0]), /cannot queue to 'other'/);
    assert.deepEqual(logged, []);
    assert.deepEqual(tasks.added, []);
  });

  test('a Reader without a Dispatcher (eager only) reports RESIZE_ENQUEUE_NO_QUEUE from prewarm', async () => {
    const reader = new Reader(readerDeps(undefined));
    const result = await reader.prewarm({
      media,
      sizes: [{ width: 30, height: 30 }],
    });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_NO_QUEUE');
    assert.equal(result.issues[0].retryable, false);
  });

  test('a Reader whose task queue cannot be used serves stored previews, queues nothing, logs nothing and prewarm reports the failure', async () => {
    const media = stampFresh({
      id: 'm1',
      original: { storageRef: { key: 'o' }, width: 64, height: 48 },
      previews: [
        {
          storageRef: { key: 'p' },
          sizeKey: '10x10',
          format: 'webp',
          contentType: 'image/webp',
        },
      ],
    });
    const logged: unknown[][] = [];
    const deps = readerDeps(undefined);
    deps.logger = {
      info: (...a: unknown[]) => logged.push(a),
      warn: (...a: unknown[]) => logged.push(a),
      error: (...a: unknown[]) => logged.push(a),
    };
    const failure = new ResizeConfigError('the lease is invalid', {
      code: 'RESIZE_CONFIG_QUEUE_LEASE_INVALID',
    });
    deps.queueFailure = { error: failure };
    const reader = new Reader(deps);
    const sizes = [
      { width: 10, height: 10 },
      { width: 20, height: 20 },
    ];
    for (const enqueueMissing of [undefined, true]) {
      const { decision } = await reader.resolve({
        media,
        sizes,
        ...(enqueueMissing ? { enqueueMissing } : {}),
      });
      assert.deepEqual(
        decision.ready.map((e) => e.url),
        ['https://cdn/p'],
      );
      assert.deepEqual(
        decision.missing.map((v) => v.sizeKey),
        ['20x20'],
      );
    }
    const result = await reader.prewarm({ media, sizes });
    assert.deepEqual(logged, []);
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(
      result.requested.map((v) => v.sizeKey),
      ['10x10', '20x20'],
    );
    assert.deepEqual(
      result.ready.map((v) => v.sizeKey),
      ['10x10'],
    );
    assert.deepEqual(
      result.unconfirmed.map((v) => v.sizeKey),
      ['20x20'],
    );
    assert.deepEqual(result.issues, [
      {
        code: 'RESIZE_ENQUEUE_INTERNAL_ERROR',
        message: 'the lease is invalid',
        retryable: false,
        previews: result.unconfirmed,
      },
    ]);
  });

  test('a Reader never throws: an unexpected error is logged once and returns the safe result', async () => {
    const errors: unknown[][] = [];
    const deps = readerDeps(undefined);
    deps.logger = {
      info() {},
      warn() {},
      error(...a: unknown[]) {
        errors.push(a);
      },
    };
    const reader = new Reader(deps);
    assert.deepEqual(await reader.resolve(undefined as never), {
      decision: { ready: [], missing: [] },
      output: undefined,
    });
    const result = await reader.prewarm(undefined as never);
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(result.requested, []);
    assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_INTERNAL_ERROR');
    assert.equal(result.issues[0].retryable, true);
    assert.deepEqual(
      errors.map((e) => String(e[0])),
      [
        'resize resolve: unexpected internal error — returning the safe empty decision',
        'resize prewarm: unexpected internal error — nothing confirmed',
      ],
    );
  });

  test('prewarmFailure advises against a retry for setup, config and media errors, also from a duplicate package copy', () => {
    // An error of another copy of this package: the brand and the class name, no shared class.
    const branded = (name: string) => ({
      [Symbol.for('@adaptivestone/framework-module-resize.error')]: true,
      name,
      message: 'm',
      code: 'X',
    });
    const advice = (err: unknown) =>
      prewarmFailure(err, []).issues[0].retryable;
    for (const name of [
      'ResizeSetupError',
      'ResizeConfigError',
      'ResizeMediaError',
      'ResizeNoOriginalError',
      'ResizeOriginalError',
    ]) {
      assert.equal(advice(branded(name)), false, name);
    }
    assert.equal(advice(new ResizeConfigError('m')), false);
    assert.equal(advice(new Error('m')), true);
    assert.equal(advice(branded('ResizeStorageError')), true);
    // The class name alone, without the brand, is not this package's error.
    assert.equal(advice({ name: 'ResizeSetupError', message: 'm' }), true);
  });

  test('prewarmFailure honours retryable: false on any error of this package', () => {
    const advice = (err: unknown) =>
      prewarmFailure(err, []).issues[0].retryable;
    assert.equal(
      advice(new ResizeStorageError('m', { retryable: false })),
      false,
    );
    assert.equal(advice(new ResizeError('m', { retryable: false })), false);
    assert.equal(advice(new ResizeStorageError('m')), true);
    // From a duplicate copy of the package: the brand and the field.
    assert.equal(
      advice({
        [Symbol.for('@adaptivestone/framework-module-resize.error')]: true,
        name: 'ResizeStorageError',
        message: 'm',
        retryable: false,
      }),
      false,
    );
    // Without the brand the field is not this package's advice.
    assert.equal(advice({ name: 'X', message: 'm', retryable: false }), true);
  });

  test("prewarmFailure keeps a subclass's advice: a host's subclass of a setup or media error", () => {
    const advice = (err: unknown) =>
      prewarmFailure(err, []).issues[0].retryable;
    class HostSetupError extends ResizeSetupError {}
    class TenantSetupError extends HostSetupError {}
    class HostMediaError extends ResizeNoOriginalError {}
    class HostStorageError extends ResizeStorageError {}
    assert.equal(new HostSetupError('m').name, 'HostSetupError');
    assert.equal(advice(new HostSetupError('m')), false);
    assert.equal(advice(new TenantSetupError('m')), false);
    assert.equal(advice(new HostMediaError('m1')), false);
    assert.equal(advice(new HostStorageError('m')), true);
  });
});

// ---------------------------------------------------------------------------
// Read path — ready vs missing partitioning
// ---------------------------------------------------------------------------

describe('resolve — partitioning', () => {
  test('a falsy scalar preview ref remains ready and is passed through unchanged', async () => {
    installFakeApp();
    const refs: unknown[] = [];
    const r = new FrameworkResizer({
      storage: makeStorage({
        publicUrl: (ref) => {
          refs.push(ref);
          return `/media/${String(ref)}`;
        },
      }),
    });
    await r.ready();
    const { decision } = await r.resolve({
      media: stampFresh(
        {
          id: 'scalar',
          original: { storageRef: 0, width: 64, height: 48 },
          previews: [
            {
              storageRef: false,
              contentType: 'image/jpeg',
              sizeKey: '20x20',
              format: 'jpeg',
            },
          ],
        },
        { config: r.config },
      ),
      sizes: [{ width: 20, height: 20 }],
      formats: ['jpeg'],
    });
    assert.equal(decision.ready[0]?.url, '/media/false');
    assert.deepEqual(refs, [false]);
  });
  test('partitions existing previews to ready and absent ones to missing', async () => {
    installFakeApp();
    const r = new FrameworkResizer({ storage: makeStorage() });
    await r.ready();
    const media: MediaLike = stampFresh(
      {
        id: 'm1',
        original: {
          storageRef: { key: 'orig.jpg' },
          contentType: 'image/jpeg',
          width: 64,
          height: 48,
        },
        previews: [
          {
            storageRef: { key: 'p1' },
            contentType: 'image/jpeg',
            sizeKey: '300x300',
            format: 'jpeg',
          },
        ],
      },
      { config: r.config },
    );
    const { decision } = await r.resolve({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
      enqueueMissing: false,
    });
    assert.equal(decision.ready.length, 1);
    assert.deepEqual(decision.ready[0], {
      sizeKey: '300x300',
      format: 'jpeg',
      url: 'https://cdn/p1',
      preview: media.previews?.[0],
      contentType: 'image/jpeg',
    });
    assert.equal(decision.missing.length, 1);
    assert.deepEqual(decision.missing[0], {
      sizeKey: '300x300',
      format: 'webp',
      requestedWidth: 300,
      requestedHeight: 300,
    });
  });

  test('a null original preserves cached previews, missing variants, and the formatting hook', async () => {
    const { errors } = installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks, acquired } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      media: fakeMedia(),
      locks,
      hooks: {
        formatPublicUrls: (decision) =>
          decision.ready.map((entry) => entry.url),
      },
    });
    // Plain/lean Mongo records can carry BSON null for this optional nested field.
    const media = {
      id: 'm1',
      original: null,
      previews: [
        {
          storageRef: { key: 'cached.jpg' },
          contentType: 'image/jpeg',
          sizeKey: '300x300',
          format: 'jpeg',
        },
      ],
    } as unknown as MediaLike;

    const { decision, output } = await r.resolve({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
    });

    assert.equal(decision.ready.length, 1);
    assert.equal(decision.ready[0].url, 'https://cdn/cached.jpg');
    // Without an original no row can be proven fresh: it is served stale, and nothing is queued.
    assert.equal(decision.ready[0].stale, true);
    assert.deepEqual(decision.stale, [
      {
        sizeKey: '300x300',
        format: 'jpeg',
        requestedWidth: 300,
        requestedHeight: 300,
      },
    ]);
    assert.deepEqual(decision.missing, [
      {
        sizeKey: '300x300',
        format: 'webp',
        requestedWidth: 300,
        requestedHeight: 300,
      },
    ]);
    assert.deepEqual(output, ['https://cdn/cached.jpg']);
    assert.equal(calls.length, 0);
    assert.equal(acquired.length, 0);
    assert.equal(errors.length, 0);
  });

  test('a legacy original on a retired bucket never reaches the driver: its previews serve and missing ones queue', async () => {
    const { errors } = installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage({
        publicUrl: (ref: StorageRef) => {
          if (refKey(ref) === 'legacy-origin.jpg') {
            throw new Error('original bucket is no longer allowlisted');
          }
          return `https://cdn/${refKey(ref)}`;
        },
      }),
      tasks,
      media: fakeMedia(),
      locks,
    });
    await r.ready();
    const { decision } = await r.resolve({
      media: stampFresh(
        {
          id: 'm1',
          original: {
            storageRef: { key: 'legacy-origin.jpg' },
            bucket: 'retired-bucket',
            width: 50,
            height: 50,
          },
          previews: [
            {
              storageRef: { key: 'public-preview.jpg' },
              contentType: 'image/jpeg',
              sizeKey: '300x300',
              format: 'jpeg',
            },
          ],
        },
        { config: r.config },
      ),
      sizes: [
        { width: 300, height: 300 },
        { width: 100, height: 100 },
      ],
      formats: ['jpeg'],
    });
    assert.deepEqual(
      decision.ready.map((entry) => entry.url),
      ['https://cdn/public-preview.jpg'],
    );
    assert.deepEqual(
      decision.missing.map((m) => m.sizeKey),
      ['100x100'],
    );
    assert.deepEqual(
      calls[0]?.previews.map((p) => p.sizeKey),
      ['100x100'],
    );
    assert.equal(errors.length, 0);
  });

  test('a filtered variant is distinct from the unfiltered same size', async () => {
    installFakeApp();
    const r = new FrameworkResizer({ storage: makeStorage() });
    await r.ready();
    const media: MediaLike = stampFresh(
      {
        id: 'm1',
        original: {
          storageRef: { key: 'orig.jpg' },
          contentType: 'image/jpeg',
          width: 64,
          height: 48,
        },
        previews: [
          {
            storageRef: { key: 'p1' },
            contentType: 'image/jpeg',
            sizeKey: '300x300',
            format: 'jpeg',
          },
        ],
      },
      { config: r.config },
    );
    const { decision } = await r.resolve({
      media,
      sizes: [
        { width: 300, height: 300 },
        { width: 300, height: 300, filters: { blur: 40 } },
      ],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.equal(decision.ready.length, 1);
    assert.equal(decision.ready[0].url, 'https://cdn/p1');
    assert.equal(decision.missing.length, 1);
    assert.deepEqual(decision.missing[0], {
      sizeKey: '300x300',
      format: 'jpeg',
      filters: { blur: 40 },
      requestedWidth: 300,
      requestedHeight: 300,
    });
  });

  test('a getSizeKey-throwing size is skipped; others are processed', async () => {
    installFakeApp();
    const r = new FrameworkResizer({ storage: makeStorage() });
    const { decision } = await r.resolve({
      media: { id: 'm1' },
      sizes: [{}, { width: 300, height: 300 }],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.equal(decision.ready.length, 0);
    assert.equal(decision.missing.length, 1);
    assert.equal(decision.missing[0].sizeKey, '300x300');
  });
});

// ---------------------------------------------------------------------------
// Read path — hooks (resolveSizes / formatPublicUrls / beforeEnqueue)
// ---------------------------------------------------------------------------

describe('resolve — waterfall hooks', () => {
  test('resolveSizes tap expands the size list fed to the loop', async () => {
    installFakeApp();
    const r = new FrameworkResizer({
      storage: makeStorage(),
      hooks: {
        resolveSizes: () => [
          { width: 100, height: 100 },
          { width: 200, height: 200 },
        ],
      },
    });
    const { decision } = await r.resolve({
      media: { id: 'm1' },
      sizes: [],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.equal(decision.missing.length, 2);
    assert.deepEqual(decision.missing.map((m) => m.sizeKey).sort(), [
      '100x100',
      '200x200',
    ]);
  });

  test('formatPublicUrls tap output is returned as `output`', async () => {
    installFakeApp();
    const r = new FrameworkResizer({
      storage: makeStorage(),
      hooks: { formatPublicUrls: () => ({ shaped: true }) },
    });
    const { decision, output } = await r.resolve({
      media: { id: 'm1' },
      sizes: [],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.deepEqual(output, { shaped: true });
    assert.deepEqual(decision, { ready: [], missing: [] });
  });

  test('with no formatPublicUrls tap, output === undefined', async () => {
    installFakeApp();
    const r = new FrameworkResizer({ storage: makeStorage() });
    const { decision, output } = await r.resolve({
      media: { id: 'm1' },
      sizes: [],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.deepEqual(decision, { ready: [], missing: [] });
    assert.equal(output, undefined);
  });

  test('a throwing formatPublicUrls tap yields output === undefined (does not leak the decision)', async () => {
    const { errors } = installFakeApp();
    const r = new FrameworkResizer({
      storage: makeStorage(),
      hooks: {
        formatPublicUrls: () => {
          throw new Error('dto boom');
        },
      },
    });
    const { decision, output } = await r.resolve({
      media: { id: 'm1' },
      sizes: [],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.deepEqual(decision, { ready: [], missing: [] });
    assert.equal(output, undefined);
    assert.ok(errors.length >= 1);
  });

  test('a throwing beforeEnqueue tap is skipped (missing kept intact)', async () => {
    const { errors } = installFakeApp();
    const r = new FrameworkResizer({
      storage: makeStorage(),
      hooks: {
        beforeEnqueue: () => {
          throw new Error('boom');
        },
      },
    });
    const { decision } = await r.resolve({
      media: { id: 'm1' },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.equal(decision.missing.length, 1);
    assert.ok(errors.length >= 1);
  });
});

// ---------------------------------------------------------------------------
// Read path — enqueue wiring (missing variants reach the Dispatcher)
// ---------------------------------------------------------------------------

describe('resolve — enqueue wiring', () => {
  test('threads the pipeline name and enqueues only the missing variants', async () => {
    installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      media: fakeMedia(),
      locks,
      pipelines: { photo: {} },
    });
    await r.ready();
    const media: MediaLike = stampFresh(
      {
        id: 'm1',
        original: {
          storageRef: { key: 'orig.jpg' },
          contentType: 'image/jpeg',
          width: 64,
          height: 48,
        },
        previews: [
          {
            storageRef: { key: 'p1' },
            contentType: 'image/jpeg',
            sizeKey: '300x300',
            format: 'jpeg',
            pipeline: 'photo', // previews are scoped by pipeline
          },
        ],
      },
      { config: r.config },
    );
    await r.resolve({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
      pipeline: 'photo',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mediaId, 'm1');
    assert.equal(calls[0].pipeline, 'photo');
    assert.deepEqual(
      calls[0].previews.map((p) => `${p.sizeKey}:${p.format}`),
      ['300x300:webp'],
    );
  });

  test('sends the Resizer name and its queueName, or the per-call queue', async () => {
    installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      media: fakeMedia(),
      locks,
      name: 'listings',
      queueName: 'interactive',
    });
    const media: MediaLike = {
      id: 'm1',
      original: { storageRef: { key: 'orig.jpg' }, contentType: 'image/jpeg' },
    };
    await r.resolve({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    await r.resolve({
      media,
      sizes: [{ width: 100, height: 100 }],
      formats: ['jpeg'],
      queue: 'bulk',
    });
    assert.deepEqual(
      calls.map((c) => [c.resizer, c.queue]),
      [
        ['listings', 'interactive'],
        ['listings', 'bulk'],
      ],
    );
  });

  test('nothing is enqueued when nothing is missing', async () => {
    installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      media: fakeMedia(),
      locks,
    });
    await r.ready();
    const media: MediaLike = stampFresh(
      {
        id: 'm1',
        original: {
          storageRef: { key: 'orig.jpg' },
          contentType: 'image/jpeg',
          width: 64,
          height: 48,
        },
        previews: [
          {
            storageRef: { key: 'p1' },
            contentType: 'image/jpeg',
            sizeKey: '300x300',
            format: 'jpeg',
          },
        ],
      },
      { config: r.config },
    );
    await r.resolve({
      media,
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(calls.length, 0);
  });

  test('uses String(media._id) for the task and the gate lock when id is absent', async () => {
    installFakeApp();
    const { tasks, calls } = makeTasks(undefined, new PlainTaskQueue());
    const { locks, acquired } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      media: fakeMedia(),
      locks,
    });
    await r.resolve({
      media: {
        _id: { toString: () => 'abc123' },
        original: { storageRef: { key: 'orig.jpg' } },
      },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.deepEqual(
      acquired.map(({ key }) => key),
      ['resize_gate:default:default:abc123:default'],
    );
    assert.equal(calls[0].mediaId, 'abc123');
  });

  test('resolve does not throw when tasks.add throws; the gate lock is shortened to one lease', async () => {
    installFakeApp();
    const { tasks } = makeTasks(() => {
      throw new Error('task queue down');
    }, new PlainTaskQueue());
    const { locks, extended, released } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      media: fakeMedia(),
      locks,
    });
    const { decision } = await r.resolve({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(decision.missing.length, 1);
    // The default lease: the queue may have stored the task before it threw.
    assert.deepEqual(extended, [
      { key: 'resize_gate:default:default:m1:default', ttl: 60_000 },
    ]);
    assert.deepEqual(released, []);
  });

  test('resolve does not throw when the task queue cannot confirm the add; the gate lock is shortened to one lease', async () => {
    installFakeApp();
    const { tasks } = makeTasks(
      () => ({ status: 'unconfirmed' }),
      new PlainTaskQueue(),
    );
    const { locks, extended, released } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      media: fakeMedia(),
      locks,
    });
    await r.resolve({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.deepEqual(extended, [
      { key: 'resize_gate:default:default:m1:default', ttl: 60_000 },
    ]);
    assert.deepEqual(released, []);
  });

  test('an original without a key leaves variants missing without enqueueing or locking', async () => {
    const { info } = installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks, acquired } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      media: fakeMedia(),
      locks,
    });
    const { decision } = await r.resolve({
      media: { id: 'm1', original: {} as MediaLike['original'] },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(decision.missing.length, 1);
    assert.equal(calls.length, 0);
    assert.equal(acquired.length, 0);
    assert.equal(info.length, 0);
  });

  test('an absent original leaves variants missing without enqueueing or locking', async () => {
    const { info } = installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks, acquired } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      media: fakeMedia(),
      locks,
    });
    const { decision } = await r.resolve({
      media: { id: 'm1' },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(decision.missing.length, 1);
    assert.equal(calls.length, 0);
    assert.equal(acquired.length, 0);
    assert.equal(info.length, 0);
  });
});

describe('prewarm — missing original key', () => {
  test('returns zero without enqueueing or locking', async () => {
    installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks, acquired } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      media: fakeMedia(),
      locks,
    });
    const result = await r.prewarm({
      media: { id: 'm1', original: {} as MediaLike['original'] },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.issues[0].code, 'RESIZE_ENQUEUE_NO_ORIGINAL');
    assert.equal(calls.length, 0);
    assert.equal(acquired.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Read path — no task queue on the instance
// ---------------------------------------------------------------------------

describe('resolve — no task queue (eager-only host)', () => {
  test('defaults enqueueMissing to false: missing intact, no warn', async () => {
    const { warn } = installFakeApp();
    const r = new FrameworkResizer({ storage: makeStorage() });
    const { decision } = await r.resolve({
      media: { id: 'm1' },
      sizes: [
        { width: 300, height: 300 },
        { width: 100, height: 100 },
      ],
      formats: ['jpeg'],
    });
    assert.equal(decision.missing.length, 2);
    assert.equal(warn.length, 0);
  });

  test('explicit enqueueMissing:true with no task queue still warns once', async () => {
    const { warn } = installFakeApp();
    const r = new FrameworkResizer({ storage: makeStorage() });
    const { decision } = await r.resolve({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
      enqueueMissing: true,
    });
    assert.equal(decision.missing.length, 1);
    assert.equal(warn.length, 1);
  });
});

// ---------------------------------------------------------------------------
// SVG originals, including legacy public copies, require raster previews.
// ---------------------------------------------------------------------------

describe('resolve — SVG raster previews', () => {
  test('queues missing size×format variants instead of exposing a public original', async () => {
    installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      media: fakeMedia(),
      locks,
    });
    const media: MediaLike = {
      id: 'm1',
      original: {
        storageRef: { key: 'logo.svg' },
        contentType: 'image/svg+xml',
        width: 20,
        height: 20,
      },
    };
    const { decision } = await r.resolve({
      media,
      sizes: [
        { width: 300, height: 300 },
        { width: 100, height: 100 },
      ],
      formats: ['jpeg', 'webp'],
    });
    assert.equal(decision.ready.length, 0);
    assert.equal(decision.missing.length, 4);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].previews.length, 4);
  });

  test('never signs an SVG original or serves an SVG preview', async () => {
    installFakeApp();
    let signedCalls = 0;
    const r = new FrameworkResizer({
      storage: makeStorage({
        signedUrl: async () => {
          signedCalls++;
          return 'https://signed/private.svg';
        },
      }),
    });
    const media: MediaLike = {
      id: 'm1',
      original: {
        storageRef: { key: 'private/logo.svg' },
        contentType: 'image/svg+xml',
        width: 20,
        height: 20,
      },
      previews: [
        {
          storageRef: { key: 'published/logo.svg' },
          sizeKey: '300x300',
          format: 'jpeg',
          contentType: 'image/svg+xml',
        },
      ],
    };
    for (const ctx of [{}, { isOwner: true }]) {
      const { decision } = await r.resolve({
        media,
        sizes: [{ width: 300, height: 300 }],
        formats: ['jpeg'],
        ctx,
        enqueueMissing: false,
      });
      assert.deepEqual(decision.ready, []);
      assert.equal(decision.missing.length, 1);
    }
    assert.equal(signedCalls, 0);
  });

  test('stored raster preview is returned for an SVG original', async () => {
    installFakeApp();
    const r = new FrameworkResizer({ storage: makeStorage() });
    await r.ready();
    const { decision } = await r.resolve({
      media: stampFresh(
        {
          id: 'm1',
          original: {
            storageRef: { key: 'logo' },
            format: 'svg',
            width: 64,
            height: 48,
          },
          previews: [
            {
              storageRef: { key: 'logo.webp' },
              sizeKey: '300x300',
              format: 'webp',
              contentType: 'image/webp',
            },
          ],
        },
        { config: r.config },
      ),
      sizes: [{ width: 300, height: 300 }],
      formats: ['webp'],
      enqueueMissing: false,
    });
    assert.equal(decision.ready[0].url, 'https://cdn/logo.webp');
    assert.equal(decision.ready[0].contentType, 'image/webp');
    assert.deepEqual(decision.missing, []);
  });
});

// ---------------------------------------------------------------------------
// The original is never served in place of a preview
// ---------------------------------------------------------------------------

describe('resolve — the original is never served', () => {
  // Smaller than every requested box: the worker makes a preview at its own size instead.
  const smallOriginal = (): MediaLike => ({
    id: 'm1',
    original: {
      storageRef: { key: 'orig.jpg' },
      contentType: 'image/jpeg',
      width: 100,
      height: 100,
    },
  });

  test('a small public original with a 300×300 size is missing and queued', async () => {
    installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(true);
    const r = new FrameworkResizer({
      // A custom driver written before the removal still declares its originals public: ignored.
      storage: makeStorage({
        canServeOriginalPublicly: () => true,
      } as Partial<ResizeStorage>),
      tasks,
      media: fakeMedia(),
      locks,
    });
    const { decision } = await r.resolve({
      media: smallOriginal(),
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg', 'webp'],
    });
    assert.deepEqual(decision.ready, []);
    assert.deepEqual(decision.missing, [
      {
        sizeKey: '300x300',
        format: 'jpeg',
        requestedWidth: 300,
        requestedHeight: 300,
      },
      {
        sizeKey: '300x300',
        format: 'webp',
        requestedWidth: 300,
        requestedHeight: 300,
      },
    ]);
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0].previews.map((p) => `${p.sizeKey}:${p.format}`),
      ['300x300:jpeg', '300x300:webp'],
    );
  });

  test('an owner or admin ctx changes nothing: the original is neither signed nor linked', async () => {
    installFakeApp();
    const signed: StorageRef[] = [];
    const linked: StorageRef[] = [];
    const r = new FrameworkResizer({
      storage: makeStorage({
        publicUrl: (ref: StorageRef) => {
          linked.push(ref);
          return `https://cdn/${refKey(ref)}`;
        },
        signedUrl: async (ref: StorageRef) => {
          signed.push(ref);
          return `https://signed/${refKey(ref)}`;
        },
      }),
    });
    const read = (ctx: Record<string, unknown>) =>
      r.resolve({
        media: smallOriginal(),
        sizes: [{ width: 300, height: 300 }],
        formats: ['jpeg'],
        ctx,
        enqueueMissing: false,
      });
    const anonymous = await read({});
    assert.deepEqual(anonymous.decision.ready, []);
    assert.equal(anonymous.decision.missing.length, 1);
    for (const ctx of [{ isOwner: true }, { isAdmin: true }]) {
      assert.deepEqual((await read(ctx)).decision, anonymous.decision);
    }
    assert.deepEqual(signed, []);
    assert.deepEqual(linked, []);
  });

  test('every size shape is missing for a step-less pipeline too', async () => {
    installFakeApp();
    const r = new FrameworkResizer({
      storage: makeStorage(),
      pipelines: { plain: { beforeSteps: [], variantSteps: [] } },
    });
    for (const pipeline of ['default', 'plain']) {
      const { decision } = await r.resolve({
        media: smallOriginal(),
        sizes: [
          { width: 300, height: 300 },
          { width: 300 },
          { fit: true },
          { width: 300, height: 300, filters: { blur: 40 } },
        ],
        formats: ['jpeg'],
        pipeline,
        enqueueMissing: false,
      });
      assert.deepEqual(decision.ready, []);
      assert.deepEqual(
        decision.missing.map((m) => m.sizeKey),
        ['300x300', '300w', 'fit', '300x300'],
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Read path — the never-throw guarantee
// ---------------------------------------------------------------------------

describe('resolve — never throws', () => {
  // p2's ref is rejected by the driver (e.g. its bucket is no longer allowlisted).
  const throwingStorage = () =>
    makeStorage({
      publicUrl: (ref: StorageRef) => {
        if (refKey(ref) === 'p2') {
          throw new Error('bucket is not allowlisted');
        }
        return `https://cdn/${refKey(ref)}`;
      },
    });
  const storedPreview = (key: string, sizeKey: string) => ({
    storageRef: { key },
    contentType: 'image/jpeg',
    sizeKey,
    format: 'jpeg',
  });
  const threeStored = (): MediaLike => ({
    id: 'm1',
    original: { storageRef: { key: 'orig.jpg' }, width: 4000, height: 3000 },
    previews: [
      storedPreview('p1', '300x300'),
      storedPreview('p2', '100x100'),
      storedPreview('p3', '50x50'),
    ],
  });
  const sizes = [
    { width: 300, height: 300 },
    { width: 100, height: 100 },
    { width: 50, height: 50 },
    { width: 600, height: 600 },
  ];

  test('a publicUrl throw skips only that cell: later cells, the hook and the enqueue proceed', async () => {
    const { errors } = installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: throwingStorage(),
      tasks,
      media: fakeMedia(),
      locks,
      hooks: {
        formatPublicUrls: (decision) =>
          decision.ready.map((entry) => entry.url),
      },
    });
    await r.ready();
    const { decision, output } = await r.resolve({
      media: stampFresh(threeStored(), { config: r.config }),
      sizes,
      formats: ['jpeg'],
      enqueueMissing: true,
    });
    assert.deepEqual(
      decision.ready.map((entry) => entry.url),
      ['https://cdn/p1', 'https://cdn/p3'],
    );
    // The rejected preview is neither ready nor missing; the absent size still queues.
    assert.deepEqual(
      decision.missing.map((m) => m.sizeKey),
      ['600x600'],
    );
    assert.deepEqual(output, ['https://cdn/p1', 'https://cdn/p3']);
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0].previews.map((p) => p.sizeKey),
      ['600x600'],
    );
    assert.equal(errors.length, 1);
  });

  test('a publicUrl throw without enqueueing still returns every other cell', async () => {
    const { errors } = installFakeApp();
    const r = new FrameworkResizer({ storage: throwingStorage() });
    await r.ready();
    const { decision } = await r.resolve({
      media: stampFresh(threeStored(), { config: r.config }),
      sizes,
      formats: ['jpeg'],
      enqueueMissing: false,
    });
    assert.deepEqual(
      decision.ready.map((entry) => entry.url),
      ['https://cdn/p1', 'https://cdn/p3'],
    );
    assert.deepEqual(
      decision.missing.map((m) => m.sizeKey),
      ['600x600'],
    );
    assert.equal(errors.length, 1);
  });

  test('resolve(undefined) returns the logged safe empty decision', async () => {
    const { errors } = installFakeApp();
    const r = new FrameworkResizer({ storage: makeStorage() });
    const { decision, output } = await r.resolve(undefined as never);
    assert.deepEqual(decision, { ready: [], missing: [] });
    assert.equal(output, undefined);
    assert.equal(errors.length, 1);
  });

  test('media with no id/_id → logged safe empty decision (never-throw wrapper absorbs requireMediaId)', async () => {
    const { errors } = installFakeApp();
    const r = new FrameworkResizer({ storage: makeStorage() });
    const { decision, output } = await r.resolve({
      media: {
        original: {
          storageRef: { key: 'orig.jpg' },
          contentType: 'image/jpeg',
        },
      },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
    });
    assert.deepEqual(decision, { ready: [], missing: [] });
    assert.equal(output, undefined);
    assert.ok(errors.length >= 1);
  });
});

describe('resolve — unknown pipeline', () => {
  test('serves stored previews of that pipeline, reports nothing missing, queues nothing and logs', async () => {
    const { errors } = installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks, acquired } = makeLocks(true);
    let beforeEnqueueCalls = 0;
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      media: fakeMedia(),
      locks,
      hooks: {
        beforeEnqueue: (missing) => {
          beforeEnqueueCalls += 1;
          return [...missing, { sizeKey: '10x10', format: 'jpeg' }];
        },
        formatPublicUrls: (decision) =>
          decision.ready.map((entry) => entry.url),
      },
    });
    const media: MediaLike = {
      id: 'm1',
      // Smaller than the box: still not served, for an unknown pipeline as for any other.
      original: { storageRef: { key: 'orig.jpg' }, width: 100, height: 100 },
      previews: [
        {
          storageRef: { key: 'retired.webp' },
          contentType: 'image/webp',
          sizeKey: '300x300',
          format: 'webp',
          pipeline: 'retired',
        },
        {
          storageRef: { key: 'default.jpg' },
          contentType: 'image/jpeg',
          sizeKey: '300x300',
          format: 'jpeg',
        },
      ],
    };
    const { decision, output } = await r.resolve({
      media,
      sizes: [{ width: 300, height: 300 }, { width: 600 }],
      formats: ['jpeg', 'webp'],
      pipeline: 'retired',
      enqueueMissing: true,
    });
    assert.deepEqual(
      decision.ready.map((entry) => entry.url),
      ['https://cdn/retired.webp'],
    );
    assert.deepEqual(decision.missing, []);
    assert.deepEqual(output, ['https://cdn/retired.webp']);
    assert.equal(beforeEnqueueCalls, 0);
    assert.equal(calls.length, 0);
    assert.equal(acquired.length, 0);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /'retired'/);
  });

  test('"default" is always known, registered or not', async () => {
    const { errors } = installFakeApp();
    const r = new FrameworkResizer({ storage: makeStorage() });
    const { decision } = await r.resolve({
      media: { id: 'm1' },
      sizes: [{ width: 300, height: 300 }],
      formats: ['jpeg'],
      pipeline: 'default',
      enqueueMissing: false,
    });
    assert.equal(decision.missing.length, 1);
    assert.equal(errors.length, 0);
  });
});

describe('resolve — per-call formats', () => {
  test('formats without an encode.formats entry are dropped with one logged error', async () => {
    const { errors } = installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      media: fakeMedia(),
      locks,
    });
    const { decision } = await r.resolve({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [
        { width: 100, height: 100 },
        { width: 200, height: 200 },
      ],
      // 'toString' is inherited, not an own key of encode.formats.
      formats: ['jpg', 'webp', '../../etc', 'toString', 'jpg'],
    });
    assert.deepEqual(
      decision.missing.map((m) => `${m.sizeKey}:${m.format}`),
      ['100x100:webp', '200x200:webp'],
    );
    assert.deepEqual(
      calls[0].previews.map((p) => p.format),
      ['webp', 'webp'],
    );
    assert.equal(errors.length, 1);
    const message = String(errors[0][0]);
    for (const dropped of ['jpg', '../../etc', 'toString']) {
      assert.ok(message.includes(dropped), `${dropped} named in: ${message}`);
    }
    assert.ok(!message.includes('webp'));
  });

  test('a beforeEnqueue tap cannot queue a format without an encode.formats entry', async () => {
    const { errors } = installFakeApp();
    const { tasks, calls } = makeTasks();
    const { locks } = makeLocks(true);
    const r = new FrameworkResizer({
      storage: makeStorage(),
      tasks,
      media: fakeMedia(),
      locks,
      hooks: {
        beforeEnqueue: (missing) => [
          ...missing,
          {
            sizeKey: '300x300',
            format: 'jpg',
            requestedWidth: 300,
            requestedHeight: 300,
          },
        ],
      },
    });
    const { decision } = await r.resolve({
      media: { id: 'm1', original: { storageRef: { key: 'orig.jpg' } } },
      sizes: [{ width: 300, height: 300 }],
      formats: ['webp'],
    });
    assert.deepEqual(
      decision.missing.map((m) => m.format),
      ['webp'],
    );
    assert.deepEqual(
      calls[0].previews.map((p) => p.format),
      ['webp'],
    );
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /"jpg".*beforeEnqueue/);
  });

  test('a stored preview of an unconfigured format is not served', async () => {
    const { errors } = installFakeApp();
    const r = new FrameworkResizer({ storage: makeStorage() });
    const { decision } = await r.resolve({
      media: {
        id: 'm1',
        previews: [
          {
            storageRef: { key: 'old.png' },
            contentType: 'image/png',
            sizeKey: '300x300',
            format: 'png',
          },
        ],
      },
      sizes: [{ width: 300, height: 300 }],
      formats: ['png'],
      enqueueMissing: false,
    });
    assert.deepEqual(decision, { ready: [], missing: [] });
    assert.equal(errors.length, 1);
  });

  test('the configured default formats log nothing', async () => {
    const { errors } = installFakeApp();
    const r = new FrameworkResizer({ storage: makeStorage() });
    const { decision } = await r.resolve({
      media: { id: 'm1' },
      sizes: [{ width: 300, height: 300 }],
      enqueueMissing: false,
    });
    assert.deepEqual(
      decision.missing.map((m) => m.format),
      ['jpeg', 'webp', 'avif'],
    );
    assert.equal(errors.length, 0);
  });
});

describe('several Resizers in one process', () => {
  test('each resolve uses its own formats and logger', async () => {
    const errorsA: unknown[][] = [];
    const errorsB: unknown[][] = [];
    const logger = (errors: unknown[][]) => ({
      info() {},
      warn() {},
      error: (...args: unknown[]) => {
        errors.push(args);
      },
    });
    // Core Resizers with explicit parts: no framework app is installed in this test.
    const mediaStore = fakeMedia();
    const a = new Resizer({
      storage: makeStorage(),
      media: mediaStore,
      config: makeImageConfig({ formats: ['webp'] }),
      logger: logger(errorsA),
    });
    const b = new Resizer({
      name: 'listings',
      storage: makeStorage(),
      media: mediaStore,
      config: makeImageConfig({ formats: ['jpeg'] }),
      logger: logger(errorsB),
    });
    const media = { id: 'm1', previews: [] };
    const sizes = [{ width: 10, height: 10 }];

    const fromA = await a.resolve({ media, sizes });
    const fromB = await b.resolve({ media, sizes });
    assert.deepEqual(
      fromA.decision.missing.map((m) => m.format),
      ['webp'],
    );
    assert.deepEqual(
      fromB.decision.missing.map((m) => m.format),
      ['jpeg'],
    );

    // A media without an id is a never-throw failure, logged by the Resizer that hit it.
    await b.resolve({ media: {} as never, sizes });
    assert.equal(errorsA.length, 0);
    assert.equal(errorsB.length, 1);
  });
});

describe('pipelines are part of preview identity', () => {
  const stored = {
    storageRef: { k: 'clean' },
    sizeKey: '300x300',
    format: 'webp',
    contentType: 'image/webp',
  };
  const sizes = [{ width: 300, height: 300 }];

  test('a default preview is not served for another pipeline', async () => {
    installFakeApp();
    const r = new FrameworkResizer({
      storage: makeStorage(),
      pipelines: { watermark: {} },
    });
    await r.ready();
    const media = stampFresh(
      {
        id: 'm1',
        original: { storageRef: { k: 'o' }, width: 64, height: 48 },
        previews: [{ ...stored }],
      },
      { config: r.config },
    );
    const clean = await r.resolve({ media, sizes, formats: ['webp'] });
    const watermarked = await r.resolve({
      media,
      sizes,
      formats: ['webp'],
      pipeline: 'watermark',
    });
    assert.equal(clean.decision.ready.length, 1);
    assert.equal(watermarked.decision.ready.length, 0);
    assert.equal(watermarked.decision.missing.length, 1);
  });

  test('a preview stored for a pipeline is served only to that pipeline', async () => {
    installFakeApp();
    const r = new FrameworkResizer({
      storage: makeStorage(),
      pipelines: { watermark: {} },
    });
    await r.ready();
    const media = stampFresh(
      {
        id: 'm1',
        original: { storageRef: { k: 'o' }, width: 64, height: 48 },
        previews: [{ ...stored, pipeline: 'watermark' }],
      },
      { config: r.config },
    );
    const watermarked = await r.resolve({
      media,
      sizes,
      formats: ['webp'],
      pipeline: 'watermark',
    });
    const clean = await r.resolve({ media, sizes, formats: ['webp'] });
    assert.equal(watermarked.decision.ready.length, 1);
    assert.equal(clean.decision.ready.length, 0);
  });

  test("another Resizer's preview is not served", async () => {
    installFakeApp();
    const r = new FrameworkResizer({
      name: 'listings',
      storage: makeStorage(),
    });
    const media = { id: 'm1', previews: [stored] };
    const result = await r.resolve({ media, sizes, formats: ['webp'] });
    assert.equal(result.decision.ready.length, 0);
    assert.equal(result.decision.missing.length, 1);
  });
});

describe('rows written before previews recorded their metadata', () => {
  test('rows without bytes, createdAt, origin or encodeSig are served marked stale, and queued once', async () => {
    const tasks = new MemoryTaskQueue();
    const reader = new Reader(
      readerDeps(
        new Dispatcher({
          tasks,
          locks: undefined, // a task queue that gates by task needs none
          coordination: defaultCoordination,
          timingOf: (queue) => timingOf(tasks, queue),
          name: 'default',
          logger: silent,
        }),
      ),
    );
    // One row with its identity, one from before rows carried an identity.
    const media: MediaLike = {
      id: 'm1',
      original: { storageRef: { key: 'o' }, width: 64, height: 48 },
      previews: [
        {
          storageRef: { key: 'cover' },
          identity: 'default:default:10x10:webp:none',
          resizer: 'default',
          pipeline: 'default',
          sizeKey: '10x10',
          requestedWidth: 10,
          requestedHeight: 10,
          actualWidth: 10,
          actualHeight: 10,
          format: 'webp',
          contentType: 'image/webp',
        },
        {
          storageRef: { key: 'fit' },
          sizeKey: 'fit',
          format: 'webp',
          contentType: 'image/webp',
          fit: true,
        },
      ],
    };
    const sizes = [{ width: 10, height: 10 }, { fit: true }];
    const { decision } = await reader.resolve({ media, sizes });
    // Neither row recorded its signatures, so neither is proven fresh: both serve and get replaced.
    const variants = [
      {
        sizeKey: '10x10',
        requestedWidth: 10,
        requestedHeight: 10,
        format: 'webp',
      },
      { sizeKey: 'fit', format: 'webp', fit: true },
    ];
    assert.deepEqual(
      decision.ready.map((e) => [e.url, e.stale]),
      [
        ['https://cdn/cover', true],
        ['https://cdn/fit', true],
      ],
    );
    assert.deepEqual(decision.missing, []);
    assert.deepEqual(decision.stale, variants);
    const prewarmed = await reader.prewarm({ media, sizes });
    assert.equal(prewarmed.status, 'accepted');
    assert.deepEqual(prewarmed.ready, []);
    assert.deepEqual(prewarmed.accepted, variants);
    assert.equal(tasks.rows.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Read metrics: one `resize.read` per resolve(), and the logs a read writes once.
// ---------------------------------------------------------------------------

describe('read metrics', () => {
  function recordingLogger() {
    const info: unknown[][] = [];
    const warn: unknown[][] = [];
    const error: unknown[][] = [];
    const logger: ResizeLogger = {
      info: (...a: unknown[]) => {
        info.push(a);
      },
      warn: (...a: unknown[]) => {
        warn.push(a);
      },
      error: (...a: unknown[]) => {
        error.push(a);
      },
    };
    return { logger, info, warn, error };
  }
  // One stored jpeg preview of Resizer `resizer`, 300x300; stamp it fresh before reading.
  const storedMedia = (resizer = 'default'): MediaLike => ({
    id: 'm1',
    original: { storageRef: { key: 'orig.jpg' }, width: 4000, height: 3000 },
    previews: [
      {
        storageRef: { key: 'p1' },
        resizer,
        contentType: 'image/jpeg',
        sizeKey: '300x300',
        format: 'jpeg',
      },
    ],
  });
  const stored = [{ width: 300, height: 300 }];
  const withMissing = [
    { width: 300, height: 300 },
    { width: 600, height: 600 },
  ];
  const readsOf = (sink: ReturnType<typeof recordingMetrics>) =>
    sink.calls.filter((call) => call.name === 'resize.read');

  test('each resolve() counts one read with its outcome', async () => {
    const sink = recordingMetrics();
    const r = new Resizer({
      name: 'reads',
      storage: makeStorage(),
      media: fakeMedia(),
      tasks: new MemoryTaskQueue(),
      metrics: sink,
      logger: silent,
    });
    await r.ready();
    const media = stampFresh(storedMedia('reads'), { config: r.config });
    const read = { media, formats: ['jpeg'] };
    await r.resolve({ ...read, sizes: stored });
    await r.resolve({ ...read, sizes: withMissing });
    await r.resolve({ ...read, sizes: withMissing });
    await r.resolve({ ...read, sizes: withMissing, enqueueMissing: false });
    await r.resolve({ media: { id: 'm2' }, sizes: stored, formats: ['jpeg'] });
    await r.resolve({ ...read, sizes: withMissing, pipeline: 'retired' });

    const tapped = new Resizer({
      name: 'tapped',
      storage: makeStorage(),
      media: fakeMedia(),
      tasks: new MemoryTaskQueue(),
      metrics: sink,
      logger: silent,
      hooks: { beforeEnqueue: () => [] },
    });
    await tapped.resolve({ ...read, sizes: withMissing });

    const eagerLog = recordingLogger();
    const eager = new Resizer({
      name: 'eager',
      storage: makeStorage(),
      media: fakeMedia(),
      metrics: sink,
      logger: eagerLog.logger,
    });
    await eager.resolve({ ...read, sizes: withMissing });
    assert.equal(eagerLog.warn.length, 0);
    await eager.resolve({ ...read, sizes: withMissing, enqueueMissing: true });
    assert.equal(eagerLog.warn.length, 1);

    // No lock store beside a task queue that does not gate by task: it cannot be used.
    const plain = new Resizer({
      name: 'plain',
      storage: makeStorage(),
      media: fakeMedia(),
      tasks: new PlainTaskQueue(),
      metrics: sink,
      logger: silent,
    });
    await plain.resolve({ ...read, sizes: withMissing });

    const reads = readsOf(sink);
    assert.deepEqual(
      reads.map((call) => [call.labels.resizer, call.labels.outcome]),
      [
        ['reads', 'ready'],
        ['reads', 'enqueued'],
        ['reads', 'in-flight'],
        ['reads', 'suppressed'],
        ['reads', 'no-original'],
        ['reads', 'unknown-pipeline'],
        ['tapped', 'suppressed'],
        ['eager', 'eager-only'],
        ['eager', 'eager-only'],
        ['plain', 'failed'],
      ],
    );
    assert.ok(reads.every((call) => call.kind === 'count' && call.value === 1));
    assert.deepEqual(reads[0].labels, {
      resizer: 'reads',
      pipeline: 'default',
      outcome: 'ready',
    });
    assert.deepEqual(reads[0].context, {
      mediaId: 'm1',
      ready: 1,
      missing: 0,
      stale: 0,
    });
    assert.deepEqual(reads[1].context, {
      mediaId: 'm1',
      ready: 1,
      missing: 1,
      stale: 0,
    });
    assert.equal(reads[5].labels.pipeline, 'unregistered');
    assert.equal(reads[5].context.pipeline, 'retired');
  });

  test("the Reader's never-throw catch counts one failed read", async () => {
    const sink = recordingMetrics();
    const reader = new Reader({ ...readerDeps(undefined), metrics: sink });
    // @ts-expect-error a JS host may call resolve() with no options
    const result = await reader.resolve(undefined);
    assert.deepEqual(result, {
      decision: { ready: [], missing: [] },
      output: undefined,
    });
    const reads = readsOf(sink);
    assert.equal(reads.length, 1);
    assert.deepEqual(reads[0].labels, {
      pipeline: 'default',
      outcome: 'failed',
    });
    assert.equal('mediaId' in reads[0].context, false);
  });

  test('a beforeEnqueue tap that empties the list in place counts suppressed, not ready', async () => {
    const sink = recordingMetrics();
    const r = new Resizer({
      name: 'emptied',
      storage: makeStorage(),
      media: fakeMedia(),
      tasks: new MemoryTaskQueue(),
      metrics: sink,
      logger: silent,
      hooks: {
        beforeEnqueue: (missing) => {
          missing.length = 0;
          return missing;
        },
      },
    });
    await r.ready();
    const media = stampFresh(storedMedia('emptied'), { config: r.config });
    await r.resolve({ media, formats: ['jpeg'], sizes: withMissing });
    const [read] = readsOf(sink);
    assert.equal(read.labels.outcome, 'suppressed');
    assert.deepEqual(read.context, {
      mediaId: 'm1',
      ready: 1,
      missing: 1,
      stale: 0,
    });
  });

  test('a route whose build fails: resolve() serves the stored previews, logs once, and counts failed', async () => {
    const sink = recordingMetrics();
    const log = recordingLogger();
    const r = new Resizer({
      storage: makeStorage(),
      media: fakeMedia(),
      tasks: new RoutingTaskQueue({
        default: new MemoryTaskQueue(),
        bulk: async () => {
          throw new Error('boom');
        },
      }),
      metrics: sink,
      logger: log.logger,
    });
    await r.ready();
    const media = stampFresh(storedMedia(), { config: r.config });
    for (let i = 0; i < 2; i++) {
      const { decision } = await r.resolve({
        media,
        sizes: withMissing,
        formats: ['jpeg'],
        queue: 'bulk',
      });
      assert.deepEqual(
        decision.ready.map((entry) => entry.url),
        ['https://cdn/p1'],
      );
      assert.equal(decision.missing.length, 1);
    }
    assert.equal(log.error.length, 1);
    assert.match(String(log.error[0][0]), /its backend could not be built/);
    assert.deepEqual(
      readsOf(sink).map((call) => call.labels.outcome),
      ['failed', 'failed'],
    );
  });

  test('a read on a media without original logs nothing', async () => {
    const sink = recordingMetrics();
    const log = recordingLogger();
    const r = new Resizer({
      storage: makeStorage(),
      media: fakeMedia(),
      tasks: new MemoryTaskQueue(),
      metrics: sink,
      logger: log.logger,
    });
    for (let i = 0; i < 3; i++) {
      await r.resolve({
        media: { id: 'm1' },
        sizes: stored,
        formats: ['jpeg'],
      });
    }
    assert.deepEqual(log.info, []);
    assert.deepEqual(log.warn, []);
    assert.deepEqual(log.error, []);
    assert.deepEqual(
      readsOf(sink).map((call) => call.labels.outcome),
      ['no-original', 'no-original', 'no-original'],
    );
  });

  test('an unregistered pipeline is logged once per name, and at most 100 names', async () => {
    const log = recordingLogger();
    const r = new Resizer({
      storage: makeStorage(),
      media: fakeMedia(),
      metrics: new NoopMetrics(),
      logger: log.logger,
    });
    const read = { media: { id: 'm1' }, sizes: stored, formats: ['jpeg'] };
    await r.resolve({ ...read, pipeline: 'retired' });
    await r.resolve({ ...read, pipeline: 'retired' });
    await r.resolve({ ...read, pipeline: 'old' });
    assert.equal(log.error.length, 2);
    assert.match(String(log.error[0][0]), /'retired'/);
    assert.match(String(log.error[1][0]), /'old'/);

    const manyLog = recordingLogger();
    const many = new Resizer({
      name: 'many',
      storage: makeStorage(),
      media: fakeMedia(),
      metrics: new NoopMetrics(),
      logger: manyLog.logger,
    });
    for (let i = 0; i < 150; i++) {
      await many.resolve({ ...read, pipeline: `p${i}` });
    }
    assert.equal(manyLog.error.length, 100);
  });

  test('the eager-only warning is written once', async () => {
    const log = recordingLogger();
    const r = new Resizer({
      storage: makeStorage(),
      media: fakeMedia(),
      metrics: new NoopMetrics(),
      logger: log.logger,
    });
    await r.ready();
    const media = stampFresh(storedMedia(), { config: r.config });
    for (let i = 0; i < 3; i++) {
      await r.resolve({
        media,
        sizes: withMissing,
        formats: ['jpeg'],
        enqueueMissing: true,
      });
    }
    assert.equal(log.warn.length, 1);
  });

  test('a dropped per-call format list is logged once per list', async () => {
    const log = recordingLogger();
    const r = new Resizer({
      storage: makeStorage(),
      media: fakeMedia(),
      metrics: new NoopMetrics(),
      logger: log.logger,
    });
    const read = { media: { id: 'm1' }, sizes: stored };
    await r.resolve({ ...read, formats: ['jpg'] });
    await r.resolve({ ...read, formats: ['jpg'] });
    await r.resolve({ ...read, formats: ['bmp'] });
    assert.equal(log.error.length, 2);
    assert.match(String(log.error[0][0]), /"jpg"/);
    assert.match(String(log.error[1][0]), /"bmp"/);
  });

  test('a metrics sink that throws or rejects never breaks a read', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const sinks = {
        throwing: {
          count() {
            throw new Error('x');
          },
          timing() {
            throw new Error('x');
          },
        },
        rejecting: {
          async count() {
            throw new Error('y');
          },
          async timing() {
            throw new Error('y');
          },
        },
        baseline: new NoopMetrics(),
      };
      const results: Record<string, unknown> = {};
      const errors: Record<string, unknown[][]> = {};
      for (const [name, metrics] of Object.entries(sinks)) {
        const log = recordingLogger();
        errors[name] = log.error;
        const r = new Resizer({
          name,
          storage: makeStorage(),
          media: fakeMedia(),
          tasks: new MemoryTaskQueue(),
          metrics,
          logger: log.logger,
        });
        await r.ready();
        const media = stampFresh(storedMedia(name), { config: r.config });
        const reads = [];
        for (let i = 0; i < 2; i++) {
          const { decision, output } = await r.resolve({
            media,
            sizes: withMissing,
            formats: ['jpeg'],
          });
          reads.push({
            ready: decision.ready.map((entry) => entry.url),
            missing: decision.missing,
            output,
          });
        }
        results[name] = reads;
      }
      // Let the rejections settle before looking.
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(
        (results.baseline as { ready: string[] }[]).map((read) => read.ready),
        [['https://cdn/p1'], ['https://cdn/p1']],
      );
      assert.deepEqual(results.throwing, results.baseline);
      assert.deepEqual(results.rejecting, results.baseline);
      assert.deepEqual(errors.baseline, []);
      for (const name of ['throwing', 'rejecting']) {
        assert.equal(errors[name].length, 1, name);
        assert.match(
          String(errors[name][0][0]),
          new RegExp(
            `the metrics sink of Resizer '${name}' failed on 'resize\\.read'`,
          ),
        );
      }
      assert.deepEqual(rejections, []);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

// ---------------------------------------------------------------------------
// Freshness on the read path: a stale row is served, marked, and its replacement queued.
// ---------------------------------------------------------------------------

describe('freshness on the read path', () => {
  // The Reader's image config (readerDeps' own), and another one the stale rows were made with.
  const config = makeImageConfig({ formats: ['webp'] });
  const otherConfig = makeImageConfig({
    formats: ['webp'],
    encode: { formats: { webp: { quality: 50 } } },
  });
  const variant = {
    sizeKey: '10x10',
    requestedWidth: 10,
    requestedHeight: 10,
    format: 'webp',
  };
  const added = {
    sizeKey: '20x20',
    requestedWidth: 20,
    requestedHeight: 20,
    format: 'webp',
  };
  const sizes = [{ width: 10, height: 10 }];

  // One stored 10x10 webp row of the default Resizer and `pipeline`, not yet signed.
  function seeded(pipeline = 'default'): MediaLike {
    return {
      id: 'm1',
      original: { storageRef: { key: 'o' }, width: 64, height: 48 },
      previews: [
        {
          storageRef: { key: 'p1' },
          resizer: 'default',
          pipeline,
          sizeKey: '10x10',
          format: 'webp',
          contentType: 'image/webp',
        },
      ],
    };
  }

  function freshReader(
    opts: {
      storage?: ResizeStorage;
      hooks?: HookBus;
      logger?: ResizeLogger;
    } = {},
  ) {
    const tasks = new MemoryTaskQueue();
    const sink = recordingMetrics();
    const deps = readerDeps(
      new Dispatcher({
        tasks,
        locks: undefined, // a task queue that gates by task needs none
        coordination: defaultCoordination,
        timingOf: (queue) => timingOf(tasks, queue),
        name: 'default',
        logger: silent,
      }),
    );
    const reader = new Reader({
      ...deps,
      metrics: sink,
      storage: opts.storage ?? deps.storage,
      hooks: opts.hooks ?? deps.hooks,
      logger: opts.logger ?? deps.logger,
    });
    const named = (name: string) =>
      sink.calls.filter((call) => call.name === name);
    return { reader, tasks, named };
  }

  test('a stale row is served, marked stale, and queued', async () => {
    const { reader, tasks, named } = freshReader();
    const media = stampFresh(seeded(), { config: otherConfig });
    const { decision } = await reader.resolve({ media, sizes });
    assert.equal(decision.ready.length, 1);
    assert.equal(decision.ready[0].url, 'https://cdn/p1');
    assert.equal(decision.ready[0].stale, true);
    assert.deepEqual(decision.stale, [variant]);
    assert.deepEqual(decision.missing, []);
    assert.equal(tasks.rows.length, 1);
    assert.deepEqual(tasks.added[0].previews, [variant]);
    const stale = named('resize.preview.stale');
    assert.equal(stale.length, 1);
    assert.equal(stale[0].kind, 'count');
    assert.equal(stale[0].value, 1);
    assert.deepEqual(stale[0].labels, { pipeline: 'default' });
    assert.deepEqual(stale[0].context, { mediaId: 'm1' });
    const reads = named('resize.read');
    assert.equal(reads[0].labels.outcome, 'enqueued');
    assert.equal(reads[0].context.stale, 1);
  });

  test('a fresh decision has no stale key', async () => {
    const { reader, tasks, named } = freshReader();
    const media = stampFresh(seeded(), { config });
    const { decision } = await reader.resolve({ media, sizes });
    assert.equal(decision.ready.length, 1);
    assert.equal(Object.hasOwn(decision, 'stale'), false);
    assert.equal(Object.hasOwn(decision.ready[0], 'stale'), false);
    assert.equal(tasks.rows.length, 0);
    assert.deepEqual(named('resize.preview.stale'), []);
    assert.equal(named('resize.read')[0].labels.outcome, 'ready');
    assert.equal(named('resize.read')[0].context.stale, 0);
  });

  test('stale and missing variants are queued as one task; the next read is in-flight', async () => {
    const { reader, tasks, named } = freshReader();
    const media = stampFresh(seeded(), { config: otherConfig });
    const both = [...sizes, { width: 20, height: 20 }];
    const first = await reader.resolve({ media, sizes: both });
    assert.deepEqual(first.decision.stale, [variant]);
    assert.deepEqual(first.decision.missing, [added]);
    assert.equal(tasks.rows.length, 1);
    assert.deepEqual(tasks.rows[0].task.previews, [variant, added]);
    const second = await reader.resolve({ media, sizes: both });
    assert.equal(second.decision.ready[0].stale, true);
    assert.equal(tasks.rows.length, 1);
    assert.deepEqual(
      named('resize.read').map((call) => call.labels.outcome),
      ['enqueued', 'in-flight'],
    );
  });

  test('a beforeEnqueue tap that drops a stale variant keeps it served and queues nothing', async () => {
    const hooks = new HookBus({
      logger: silent,
      taps: { beforeEnqueue: () => [] },
    });
    const { reader, tasks, named } = freshReader({ hooks });
    const media = stampFresh(seeded(), { config: otherConfig });
    const { decision } = await reader.resolve({ media, sizes });
    assert.equal(Object.hasOwn(decision, 'stale'), false);
    assert.equal(decision.ready[0].stale, true);
    assert.deepEqual(decision.missing, []);
    assert.equal(tasks.rows.length, 0);
    assert.equal(named('resize.read')[0].labels.outcome, 'suppressed');
    // Counted before the hook: the read found it stale, whatever the tap kept.
    assert.deepEqual(
      named('resize.preview.stale').map((call) => call.value),
      [1],
    );
    assert.equal(named('resize.read')[0].context.stale, 1);
  });

  test('a stale identity requested as two cells is served twice, queued once and counted once', async () => {
    const { reader, tasks, named } = freshReader();
    const media = stampFresh(seeded(), { config: otherConfig });
    const { decision } = await reader.resolve({
      media,
      sizes: [...sizes, ...sizes],
    });
    assert.deepEqual(
      decision.ready.map((entry) => [entry.url, entry.stale]),
      [
        ['https://cdn/p1', true],
        ['https://cdn/p1', true],
      ],
    );
    assert.deepEqual(decision.stale, [variant]);
    assert.equal(tasks.rows.length, 1);
    assert.deepEqual(tasks.rows[0].task.previews, [variant]);
    assert.deepEqual(
      named('resize.preview.stale').map((call) => call.value),
      [1],
    );
    assert.equal(named('resize.read')[0].context.stale, 1);
  });

  test('a stale cell whose publicUrl throws is not served but is queued', async () => {
    const errors: unknown[][] = [];
    const { reader, tasks, named } = freshReader({
      logger: {
        info() {},
        warn() {},
        error: (...a: unknown[]) => {
          errors.push(a);
        },
      },
      storage: {
        download: async () => Buffer.alloc(0),
        upload: async () => ({ key: 'k' }),
        publicUrl: () => {
          throw new Error('bucket not allowlisted');
        },
      },
    });
    const media = stampFresh(seeded(), { config: otherConfig });
    const { decision } = await reader.resolve({ media, sizes });
    assert.deepEqual(decision.ready, []);
    assert.deepEqual(decision.stale, [variant]);
    assert.deepEqual(decision.missing, []);
    assert.equal(tasks.rows.length, 1);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /publicUrl failed/);
    // Counted though not served: its replacement is queued.
    assert.deepEqual(
      named('resize.preview.stale').map((call) => call.value),
      [1],
    );
    assert.equal(named('resize.read')[0].context.stale, 1);
    assert.equal(named('resize.read')[0].context.ready, 0);
  });

  test('an unregistered pipeline serves its stored rows unmarked and queues nothing', async () => {
    const { reader, tasks, named } = freshReader();
    const media = stampFresh(seeded('retired'), { config: otherConfig });
    const { decision } = await reader.resolve({
      media,
      sizes,
      pipeline: 'retired',
    });
    assert.equal(decision.ready.length, 1);
    assert.equal(Object.hasOwn(decision.ready[0], 'stale'), false);
    assert.equal(Object.hasOwn(decision, 'stale'), false);
    assert.deepEqual(decision.missing, []);
    assert.equal(tasks.rows.length, 0);
    assert.deepEqual(named('resize.preview.stale'), []);
    assert.equal(named('resize.read')[0].labels.outcome, 'unknown-pipeline');
  });

  test('a media without stored dimensions: its rows are served stale and queued once', async () => {
    const { reader, tasks, named } = freshReader();
    // Signed as the worker signs them, then the stored dimensions are gone: no row is proven fresh.
    const media = stampFresh(seeded(), { config });
    const original = media.original as { width?: number; height?: number };
    delete original.width;
    delete original.height;
    for (let i = 0; i < 2; i++) {
      const { decision } = await reader.resolve({ media, sizes });
      assert.equal(decision.ready[0].stale, true);
      assert.deepEqual(decision.stale, [variant]);
    }
    assert.equal(tasks.rows.length, 1);
    assert.deepEqual(
      named('resize.read').map((call) => call.labels.outcome),
      ['enqueued', 'in-flight'],
    );
  });
});
