import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import { frameworkLockProvider, type LockProvider } from './locks.ts';
import { frameworkMediaStore, type MediaStore } from './mediaStore.ts';
import {
  getResizer,
  type Pipeline,
  type QueueTransport,
  Resizer,
  type ResizeStorage,
  resetResizerForTests,
} from './resizer.ts';

// ---------------------------------------------------------------------------
// Fakes. The Resizer stores driver references verbatim, so identity is all we
// check; the hook bus needs a recording ambient app (logger/events) read via
// getApp() at CALL time — stolen from the old hooks.test.ts harness.
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
          if (opts.emitThrows) throw new Error('emit boom');
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
    assert.equal(r.mediaStore, frameworkMediaStore);
    assert.equal(r.lockProvider, frameworkLockProvider);
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
// Read/eager stubs — bodies land in build step 5
// ---------------------------------------------------------------------------

describe('resolve/generate stubs', () => {
  test('resolve rejects with a not-implemented error', async () => {
    const r = new Resizer(baseOpts());
    await assert.rejects(
      () => r.resolve({ media: {}, sizes: [] }),
      /not implemented/,
    );
  });

  test('generate rejects with a not-implemented error', async () => {
    const r = new Resizer(baseOpts());
    await assert.rejects(
      () => r.generate({ media: {}, sizes: [] }),
      /not implemented/,
    );
  });
});
