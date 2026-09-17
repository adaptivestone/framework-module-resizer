import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import { ResizeError } from './errors.ts';
import { FrameworkLockProvider } from './locks/framework.ts';
import { FrameworkMediaStore } from './mediaStore/framework.ts';
import {
  getResizer,
  type LockProvider,
  type MediaStore,
  type Pipeline,
  type QueueTransport,
  Resizer,
  type ResizeStorage,
  resetResizerForTests,
} from './resizer.ts';
import type { MissingPreview, SizeInput } from './types.d.ts';

// ---------------------------------------------------------------------------
// Fakes. The Resizer stores passed driver references verbatim (identity checks);
// omitted defaults are fresh framework-driver instances (instanceof checks). The
// hook bus needs a recording ambient app (logger/events) read via getApp() at
// CALL time — stolen from the old hooks.test.ts harness.
// ---------------------------------------------------------------------------

const fakeTransport = (): QueueTransport => ({
  enqueue: async () => ({ taskId: null }),
  startWorker: async () => {},
});
const fakeStorage = (): ResizeStorage => ({
  download: async () => Buffer.alloc(0),
  upload: async () => ({ key: 'k' }),
  publicUrl: () => '',
});
const fakeMediaStore = (): MediaStore => ({
  load: async () => null,
  appendPreviews: async () => {},
});
const fakeLockProvider = (): LockProvider => ({
  acquire: async () => true,
  release: async () => {},
});

// A recording fake app: logger.error pushes to `errors`; events.emit (when present)
// pushes to `emitted` (or throws when emitThrows). Reads happen at CALL time (getApp()),
// so installing this before each run is enough.
function installFakeApp(
  opts: { withEvents?: boolean; emitThrows?: boolean } = {},
): { errors: unknown[][]; emitted: unknown[][] } {
  const errors: unknown[][] = [];
  const emitted: unknown[][] = [];
  const events = opts.withEvents
    ? {
        emit(name: string, ...args: unknown[]) {
          if (opts.emitThrows) {
            throw new Error('emit boom');
          }
          emitted.push([name, ...args]);
        },
      }
    : undefined;
  setAppInstance({
    getConfig: () => ({}),
    getModel: () => ({}),
    logger: {
      info() {},
      warn() {},
      error(...args: unknown[]) {
        errors.push(args);
      },
    },
    events,
  } as never);
  return { errors, emitted };
}

// The minimal valid options: only `storage` is required.
const baseOpts = () => ({ storage: fakeStorage() });

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  resetResizerForTests();
  resetAppInstance();
});

// ---------------------------------------------------------------------------
// Constructor + wiring semantics (02 · §6, delta #12)
// ---------------------------------------------------------------------------

describe('Resizer constructor — driver wiring', () => {
  test('fills mediaStore/lockProvider defaults when omitted', () => {
    const r = new Resizer(baseOpts());
    assert.ok(r.mediaStore instanceof FrameworkMediaStore);
    assert.ok(r.lockProvider instanceof FrameworkLockProvider);
  });

  test('keeps passed drivers (no defaulting when provided)', () => {
    const storage = fakeStorage();
    const transport = fakeTransport();
    const mediaStore = fakeMediaStore();
    const lockProvider = fakeLockProvider();
    const r = new Resizer({ storage, transport, mediaStore, lockProvider });
    assert.equal(r.storage, storage);
    assert.equal(r.transport, transport);
    assert.equal(r.mediaStore, mediaStore);
    assert.equal(r.lockProvider, lockProvider);
  });

  test('transport is undefined when omitted (eager-only host)', () => {
    const r = new Resizer(baseOpts());
    assert.equal(r.transport, undefined);
  });

  test('throws a named error when storage is missing (JS host / half-filled scaffold)', () => {
    // A JS host or half-filled scaffold could omit the required `storage` — fail loudly at
    // construction with a NAMED error, not a downstream TypeError (02 · §6 review fix).
    assert.throws(() => new Resizer({} as never), /storage/);
    // The bad construction must NOT have claimed the active slot.
    assert.throws(() => getResizer(), /no Resizer constructed/);
  });

  test('seeds pipelines from options', () => {
    const photo: Pipeline = { beforeSteps: [] };
    const r = new Resizer({ ...baseOpts(), pipelines: { photo } });
    assert.equal(r.getPipeline('photo'), photo);
  });

  test('seeds hooks from options — single fn form threads through runWaterfall', async () => {
    installFakeApp();
    const r = new Resizer({
      ...baseOpts(),
      hooks: { resolveSizes: (v: number) => v + 1 },
    });
    assert.equal(await r.runWaterfall('resolveSizes', 1, {}), 2);
  });

  test('seeds hooks from options — array form runs every tap in order', async () => {
    installFakeApp();
    const r = new Resizer({
      ...baseOpts(),
      hooks: {
        resolveSizes: [(v: number) => v + 1, async (v: number) => v * 2],
      },
    });
    assert.equal(await r.runWaterfall('resolveSizes', 1, {}), 4); // (1+1)*2
  });
});

// ---------------------------------------------------------------------------
// Explicit queue infrastructure preparation
// ---------------------------------------------------------------------------

describe('Resizer.prepareQueue', () => {
  test('is an eager-mode no-op without a transport and never reaches framework locks', async () => {
    const r = new Resizer(baseOpts());
    // No ambient app is installed. Calling the default FrameworkLockProvider would throw.
    await r.prepareQueue();
  });

  test('runs transport then locks, and concurrent callers share the pending work', async () => {
    const transportGate = deferred();
    const lockGate = deferred();
    const order: string[] = [];
    let transportCalls = 0;
    let lockCalls = 0;
    const transport: QueueTransport = {
      ...fakeTransport(),
      prepare: async () => {
        transportCalls += 1;
        order.push('transport:start');
        await transportGate.promise;
        order.push('transport:end');
      },
    };
    const lockProvider: LockProvider = {
      ...fakeLockProvider(),
      prepare: async () => {
        lockCalls += 1;
        order.push('lock:start');
        await lockGate.promise;
        order.push('lock:end');
      },
    };
    const r = new Resizer({ ...baseOpts(), transport, lockProvider });

    const calls = Array.from({ length: 10 }, () => r.prepareQueue());
    await Promise.resolve();
    assert.equal(transportCalls, 1);
    assert.equal(lockCalls, 0, 'locks must wait for transport preparation');
    transportGate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(lockCalls, 1);
    lockGate.resolve();
    await Promise.all(calls);
    assert.deepEqual(order, [
      'transport:start',
      'transport:end',
      'lock:start',
      'lock:end',
    ]);

    await r.prepareQueue();
    assert.equal(transportCalls, 1, 'successful preparation is cached');
    assert.equal(lockCalls, 1, 'successful preparation is cached');
  });

  test('supports every optional-prepare combination', async () => {
    const cases = [
      { transportPrepare: false, lockPrepare: true, expected: ['lock'] },
      { transportPrepare: true, lockPrepare: false, expected: ['transport'] },
      { transportPrepare: false, lockPrepare: false, expected: [] },
    ];

    for (const entry of cases) {
      const calls: string[] = [];
      const transport: QueueTransport = {
        ...fakeTransport(),
        ...(entry.transportPrepare
          ? { prepare: async () => void calls.push('transport') }
          : {}),
      };
      const lockProvider: LockProvider = {
        ...fakeLockProvider(),
        ...(entry.lockPrepare
          ? { prepare: async () => void calls.push('lock') }
          : {}),
      };
      const r = new Resizer({ ...baseOpts(), transport, lockProvider });
      await r.prepareQueue();
      assert.deepEqual(calls, entry.expected);
      resetResizerForTests();
    }
  });

  test('a transport failure skips locks, clears the cache, and retries', async () => {
    const cause = new Error('transport unavailable');
    let transportCalls = 0;
    let lockCalls = 0;
    const transport: QueueTransport = {
      ...fakeTransport(),
      prepare: async () => {
        transportCalls += 1;
        if (transportCalls === 1) {
          throw cause;
        }
      },
    };
    const lockProvider: LockProvider = {
      ...fakeLockProvider(),
      prepare: async () => {
        lockCalls += 1;
      },
    };
    const r = new Resizer({ ...baseOpts(), transport, lockProvider });

    await assert.rejects(r.prepareQueue(), (error: unknown) => {
      assert.ok(error instanceof ResizeError);
      assert.equal(error.code, 'RESIZE_QUEUE_PREPARE_FAILED');
      assert.equal(error.cause, cause);
      return true;
    });
    assert.equal(lockCalls, 0);
    await r.prepareQueue();
    assert.equal(transportCalls, 2);
    assert.equal(lockCalls, 1);
  });

  test('a lock failure retries the whole transport-then-lock sequence', async () => {
    let transportCalls = 0;
    let lockCalls = 0;
    const transport: QueueTransport = {
      ...fakeTransport(),
      prepare: async () => {
        transportCalls += 1;
      },
    };
    const lockProvider: LockProvider = {
      ...fakeLockProvider(),
      prepare: async () => {
        lockCalls += 1;
        if (lockCalls === 1) {
          throw new Error('lock unavailable');
        }
      },
    };
    const r = new Resizer({ ...baseOpts(), transport, lockProvider });

    await assert.rejects(r.prepareQueue(), /queue preparation failed/);
    await r.prepareQueue();
    assert.equal(transportCalls, 2);
    assert.equal(lockCalls, 2);
  });

  test('turns a synchronous custom-driver throw into a rejection with the cause', async () => {
    const cause = new Error('sync failure');
    const transport: QueueTransport = {
      ...fakeTransport(),
      prepare: () => {
        throw cause;
      },
    };
    const r = new Resizer({
      ...baseOpts(),
      transport,
      lockProvider: fakeLockProvider(),
    });

    const preparing = r.prepareQueue();
    assert.ok(preparing instanceof Promise);
    await assert.rejects(preparing, (error: unknown) => {
      assert.ok(error instanceof ResizeError);
      assert.equal(error.cause, cause);
      return true;
    });
  });

  test('preserves an existing ResizeError from a custom driver', async () => {
    const existing = new ResizeError('known failure', { code: 'KNOWN' });
    const transport: QueueTransport = {
      ...fakeTransport(),
      prepare: async () => {
        throw existing;
      },
    };
    const r = new Resizer({
      ...baseOpts(),
      transport,
      lockProvider: fakeLockProvider(),
    });
    await assert.rejects(r.prepareQueue(), (error) => error === existing);
  });
});

// ---------------------------------------------------------------------------
// One-per-process active-instance slot (mirrors setAppInstance)
// ---------------------------------------------------------------------------

describe('Resizer one-per-process slot', () => {
  test('a second construction throws a clear error', () => {
    new Resizer(baseOpts());
    assert.throws(
      () => new Resizer(baseOpts()),
      /only one Resizer per process/,
    );
  });

  test('resetResizerForTests() allows a fresh construction', () => {
    const first = new Resizer(baseOpts());
    resetResizerForTests();
    const second = new Resizer(baseOpts());
    assert.notEqual(first, second);
    assert.equal(getResizer(), second);
  });

  test('getResizer() throws a clear error before any construction', () => {
    assert.throws(() => getResizer(), /no Resizer constructed/);
  });

  test('getResizer() returns the active instance after construction', () => {
    const r = new Resizer(baseOpts());
    assert.equal(getResizer(), r);
  });
});

// ---------------------------------------------------------------------------
// Named pipelines (04 · §8) — ported from registry.test.ts
// ---------------------------------------------------------------------------

describe('named pipelines', () => {
  test('a registered pipeline is retrievable', () => {
    const r = new Resizer(baseOpts());
    const p: Pipeline = { beforeSteps: [] };
    r.registerPipeline('photo', p);
    assert.equal(r.getPipeline('photo'), p);
  });

  test('re-registering a name replaces it (last-wins)', () => {
    const r = new Resizer(baseOpts());
    const p1: Pipeline = { beforeSteps: [] };
    const p2: Pipeline = { variantSteps: [] };
    r.registerPipeline('photo', p1);
    r.registerPipeline('photo', p2);
    assert.equal(r.getPipeline('photo'), p2);
  });

  test('unknown name → structurally empty pipeline {}, and frozen', () => {
    const r = new Resizer(baseOpts());
    const empty = r.getPipeline('nope');
    assert.deepEqual(empty, {});
    assert.equal(Object.isFrozen(empty), true);
  });
});

// ---------------------------------------------------------------------------
// Hook bus — waterfall (04 · §9) — ported from hooks.test.ts
// ---------------------------------------------------------------------------

describe('runWaterfall', () => {
  test('threads the value through taps in registration order', async () => {
    installFakeApp();
    const r = new Resizer(baseOpts());
    r.hook('resolveSizes', (v: number) => v + 1);
    r.hook('resolveSizes', async (v: number) => v * 2);
    const out = await r.runWaterfall('resolveSizes', 1, {});
    assert.equal(out, 4); // (1 + 1) * 2
  });

  test('threads ctx to each tap', async () => {
    installFakeApp();
    const r = new Resizer(baseOpts());
    const ctx = { entity: 'event' };
    let seen: unknown;
    r.hook('beforeEnqueue', (v: unknown, c: unknown) => {
      seen = c;
      return v;
    });
    await r.runWaterfall('beforeEnqueue', [], ctx);
    assert.equal(seen, ctx);
  });

  test('a throwing tap is logged and skipped (prior value kept); later taps still run', async () => {
    const { errors } = installFakeApp();
    const r = new Resizer(baseOpts());
    r.hook('resolveSizes', (v: number) => v + 1);
    r.hook('resolveSizes', () => {
      throw new Error('boom');
    });
    r.hook('resolveSizes', (v: number) => v + 10);
    const out = await r.runWaterfall('resolveSizes', 0, {});
    assert.equal(out, 11); // 0+1 → (throw → keep 1) → 1+10
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /resolveSizes/);
  });

  test('with no taps returns the input unchanged', async () => {
    installFakeApp();
    const r = new Resizer(baseOpts());
    const value = { a: 1 };
    assert.equal(await r.runWaterfall('formatPublicUrls', value, {}), value);
  });
});

// ---------------------------------------------------------------------------
// Hook bus — observers (04 · §9) — ported from hooks.test.ts
// ---------------------------------------------------------------------------

describe('runObservers', () => {
  test('awaits every tap in registration order', async () => {
    installFakeApp();
    const r = new Resizer(baseOpts());
    const order: number[] = [];
    r.hook('afterTaskComplete', async () => {
      await Promise.resolve();
      order.push(1);
    });
    r.hook('afterTaskComplete', () => {
      order.push(2);
    });
    await r.runObservers('afterTaskComplete', {}, {});
    assert.deepEqual(order, [1, 2]);
  });

  test('a throwing tap is logged and does not stop later taps', async () => {
    const { errors } = installFakeApp();
    const r = new Resizer(baseOpts());
    const seen: string[] = [];
    r.hook('onTaskFailed', () => {
      throw new Error('boom');
    });
    r.hook('onTaskFailed', () => {
      seen.push('second');
    });
    await r.runObservers('onTaskFailed', {}, new Error('x'), {});
    assert.deepEqual(seen, ['second']);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /onTaskFailed/);
  });

  test('mirrors onto app.events as resize:<name> BEFORE the taps run', async () => {
    const { emitted } = installFakeApp({ withEvents: true });
    const r = new Resizer(baseOpts());
    let emittedLenWhenTapRan = -1;
    r.hook('onPreviewGenerated', () => {
      emittedLenWhenTapRan = emitted.length;
    });
    await r.runObservers('onPreviewGenerated', 'preview-arg', {});
    assert.equal(emittedLenWhenTapRan, 1); // the emit already happened before the tap
    assert.deepEqual(emitted[0], [
      'resize:onPreviewGenerated',
      'preview-arg',
      {},
    ]);
  });

  test('a missing app.events is fine — taps still run', async () => {
    installFakeApp(); // no events
    const r = new Resizer(baseOpts());
    const seen: string[] = [];
    r.hook('afterTaskComplete', () => {
      seen.push('ran');
    });
    await r.runObservers('afterTaskComplete', {}, {});
    assert.deepEqual(seen, ['ran']);
  });

  test('a THROWING app.events.emit is caught (logged) and taps still run', async () => {
    const { errors } = installFakeApp({ withEvents: true, emitThrows: true });
    const r = new Resizer(baseOpts());
    const seen: string[] = [];
    r.hook('onTaskDeadLettered', () => {
      seen.push('ran');
    });
    await r.runObservers('onTaskDeadLettered', {}, new Error('x'), {});
    assert.deepEqual(seen, ['ran']);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /onTaskDeadLettered/);
  });
});

// ---------------------------------------------------------------------------
// Typed taps (04 · §9) — HookSignatures infers each tap; runtime behavior unchanged.
// (Type-level enforcement is compile-only; test files are excluded from tsc, so these
//  assert the RUNTIME contract with correctly-typed signatures.)
// ---------------------------------------------------------------------------

describe('typed hooks', () => {
  test('a correctly-typed constructor hook + late .hook() both run through the bus', async () => {
    installFakeApp();
    const injected: SizeInput = { width: 10, height: 10 };
    const r = new Resizer({
      ...baseOpts(),
      hooks: {
        resolveSizes: (sizes: SizeInput[]) => [...sizes, injected],
      },
    });
    // A second, late tap over the SAME name — typed (missing: MissingPreview[]).
    let seenMissing: MissingPreview[] | undefined;
    r.hook('beforeEnqueue', (missing: MissingPreview[]) => {
      seenMissing = missing;
      return missing;
    });
    const sizes = (await r.runWaterfall('resolveSizes', [], {})) as SizeInput[];
    assert.deepEqual(sizes, [injected]);
    await r.runWaterfall(
      'beforeEnqueue',
      [{ sizeKey: 'fit', format: 'webp' }],
      {},
    );
    assert.deepEqual(seenMissing, [{ sizeKey: 'fit', format: 'webp' }]);
  });
});

// ---------------------------------------------------------------------------
// Read/eager stubs — resolve landed in build step 5; generate lands in step 8
// ---------------------------------------------------------------------------

describe('resolve/generate stubs', () => {
  test('resolve delegates to the engine (no longer a stub)', async () => {
    installFakeApp();
    const r = new Resizer(baseOpts());
    const { decision, output } = await r.resolve({
      media: {},
      sizes: [],
      formats: ['jpeg'],
    });
    assert.deepEqual(decision, { ready: [], missing: [] });
    assert.equal(output, undefined);
  });

  test('generate is wired (no longer a stub): empty sizes → empty created', async () => {
    // A config WITH mediaModelName so getResizeConfig() inside generateImpl does not throw.
    setAppInstance({
      getConfig: () => ({ mediaModelName: 'File' }),
      getModel: () => ({}),
      logger: { info() {}, warn() {}, error() {} },
    } as never);
    const r = new Resizer(baseOpts());
    const result = await r.generate({
      media: { id: 'm1', original: { key: 'o', contentType: 'image/jpeg' } },
      sizes: [],
    });
    assert.deepEqual(result.created, []);
    assert.equal(result.failed, 0);
  });
});
