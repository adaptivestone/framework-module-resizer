import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import { ResizeConfigError, ResizeSetupError } from './errors.ts';
import { createFrameworkResizer } from './framework/resizer.ts';
import { FrameworkLockProvider } from './locks/framework.ts';
import { FrameworkMediaStore } from './mediaStore/framework.ts';
import {
  getResizer,
  type LockProvider,
  listResizers,
  type MediaStore,
  type Pipeline,
  type QueueTransport,
  Resizer,
  type ResizeStorage,
  resetResizerForTests,
} from './resizer.ts';
import { makeResizeConfig } from './testHelpers/resizeConfig.ts';
import type { MissingPreview, SizeInput } from './types.d.ts';

// ---------------------------------------------------------------------------
// Fakes. The Resizer stores passed driver references verbatim (identity checks);
// omitted defaults are fresh framework-driver instances (instanceof checks). The
// hook bus needs a recording ambient app (logger/events), which the Resizer reads
// when it is constructed — stolen from the old hooks.test.ts harness.
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
// pushes to `emitted` (or throws when emitThrows). The Resizer reads the app when it is
// constructed, so install this before constructing the Resizer.
function installFakeApp(
  opts: { withEvents?: boolean; emitThrows?: boolean } = {},
): { errors: unknown[][]; emitted: unknown[][] } {
  resetAppInstance();
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
    getConfig: () => makeResizeConfig(),
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

beforeEach(() => {
  installFakeApp();
});

afterEach(() => {
  resetResizerForTests();
  resetAppInstance();
});

// ---------------------------------------------------------------------------
// Constructor + wiring semantics (02 · §6, delta #12)
// ---------------------------------------------------------------------------

describe('Resizer constructor — driver wiring', () => {
  test('createFrameworkResizer fills mediaStore, and lockProvider when there is a transport', () => {
    const eager = createFrameworkResizer(baseOpts());
    assert.ok(eager.mediaStore instanceof FrameworkMediaStore);
    assert.ok(!(eager.lockProvider instanceof FrameworkLockProvider));
    resetResizerForTests();
    const queued = createFrameworkResizer({
      ...baseOpts(),
      transport: fakeTransport(),
    });
    assert.ok(queued.mediaStore instanceof FrameworkMediaStore);
    assert.ok(queued.lockProvider instanceof FrameworkLockProvider);
  });

  test('keeps passed drivers (no defaulting when provided)', () => {
    const storage = fakeStorage();
    const transport = fakeTransport();
    const mediaStore = fakeMediaStore();
    const lockProvider = fakeLockProvider();
    const r = createFrameworkResizer({
      storage,
      transport,
      mediaStore,
      lockProvider,
    });
    assert.equal(r.storage, storage);
    assert.equal(r.transport, transport);
    assert.equal(r.mediaStore, mediaStore);
    assert.equal(r.lockProvider, lockProvider);
  });

  test('transport is undefined when omitted (eager-only host)', () => {
    const r = createFrameworkResizer(baseOpts());
    assert.equal(r.transport, undefined);
  });

  test('throws a named error when storage is missing (JS host / half-filled scaffold)', () => {
    // A JS host or half-filled scaffold could omit the required `storage` — fail loudly at
    // construction with a NAMED error, not a downstream TypeError (02 · §6 review fix).
    assert.throws(() => createFrameworkResizer({} as never), /storage/);
    // The bad construction must NOT have claimed the active slot.
    assert.throws(() => getResizer(), /no Resizer named 'default'/);
  });

  test('rejects invalid config during construction without claiming the singleton', () => {
    resetAppInstance();
    setAppInstance({
      getConfig: () => ({ mediaModelName: 'File', upload: null }),
      getModel: () => ({}),
      logger: { info() {}, warn() {}, error() {} },
    } as never);
    assert.throws(
      () => createFrameworkResizer(baseOpts()),
      /upload must be an object/,
    );
    assert.throws(() => getResizer(), /no Resizer named 'default'/);
    resetAppInstance();
    setAppInstance({
      getConfig: () => makeResizeConfig(),
      getModel: () => ({}),
      logger: { info() {}, warn() {}, error() {} },
    } as never);
    assert.doesNotThrow(() => createFrameworkResizer(baseOpts()));
  });

  test('the default media store loads from the Resizer’s own media model', async () => {
    const asked: string[] = [];
    resetAppInstance();
    setAppInstance({
      getConfig: () => makeResizeConfig(), // mediaModelName 'File'
      getModel: (name: string) => {
        asked.push(name);
        return { findById: async () => null };
      },
      logger: { info() {}, warn() {}, error() {} },
    } as never);
    const photos = createFrameworkResizer({
      ...baseOpts(),
      name: 'photos',
      config: makeResizeConfig({ mediaModelName: 'Photo' }),
    });
    const files = createFrameworkResizer(baseOpts());
    await photos.mediaStore.load('m1');
    await files.mediaStore.load('m2');
    assert.deepEqual(asked, ['Photo', 'File']);
  });

  test('seeds pipelines from options', () => {
    const photo: Pipeline = { beforeSteps: [] };
    const r = createFrameworkResizer({ ...baseOpts(), pipelines: { photo } });
    assert.equal(r.getPipeline('photo'), photo);
  });

  test('seeds hooks from options — single fn form threads through runWaterfall', async () => {
    installFakeApp();
    const r = createFrameworkResizer({
      ...baseOpts(),
      hooks: { resolveSizes: (v: number) => v + 1 },
    });
    assert.equal(await r.runWaterfall('resolveSizes', 1, {}), 2);
  });

  test('seeds hooks from options — array form runs every tap in order', async () => {
    installFakeApp();
    const r = createFrameworkResizer({
      ...baseOpts(),
      hooks: {
        resolveSizes: [(v: number) => v + 1, async (v: number) => v * 2],
      },
    });
    assert.equal(await r.runWaterfall('resolveSizes', 1, {}), 4); // (1+1)*2
  });
});

// ---------------------------------------------------------------------------
// Named registry: several Resizers per process, one per name
// ---------------------------------------------------------------------------

describe('Resizer registry', () => {
  test('a second Resizer with the same name throws a clear error', () => {
    createFrameworkResizer(baseOpts());
    assert.throws(
      () => createFrameworkResizer(baseOpts()),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_DUPLICATE_RESIZER' &&
        err.message.includes("'default'"),
    );
  });

  test('Resizers with different names coexist and are found by name', () => {
    const media = createFrameworkResizer(baseOpts());
    const listings = createFrameworkResizer({
      ...baseOpts(),
      name: 'listings',
    });
    assert.equal(getResizer(), media);
    assert.equal(getResizer('default'), media);
    assert.equal(getResizer('listings'), listings);
    assert.equal(media.name, 'default');
    assert.equal(listings.name, 'listings');
  });

  test('each Resizer keeps its own config', () => {
    const a = createFrameworkResizer({
      ...baseOpts(),
      config: makeResizeConfig({ formats: ['webp'] }),
    });
    const b = createFrameworkResizer({
      ...baseOpts(),
      name: 'b',
      config: makeResizeConfig({ formats: ['jpeg'] }),
    });
    assert.deepEqual(a.config.formats, ['webp']);
    assert.deepEqual(b.config.formats, ['jpeg']);
  });

  test('getResizer() names the missing Resizer', () => {
    createFrameworkResizer({ ...baseOpts(), name: 'listings' });
    assert.throws(
      () => getResizer(),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_NO_RESIZER' &&
        err.message.includes("'default'"),
    );
  });

  test('an invalid config throws at construction and does not claim the name', () => {
    assert.throws(
      () =>
        createFrameworkResizer({
          ...baseOpts(),
          config: { mediaModelName: 'File' } as never,
        }),
      (err: unknown) => err instanceof ResizeConfigError,
    );
    assert.doesNotThrow(() => createFrameworkResizer(baseOpts()));
  });

  test('a named Resizer may have a transport', () => {
    const transport = fakeTransport();
    const listings = createFrameworkResizer({
      ...baseOpts(),
      name: 'listings',
      transport,
    });
    assert.equal(listings.transport, transport);
  });

  test('queue defaults to "default" and can be set per Resizer', () => {
    const media = createFrameworkResizer(baseOpts());
    const bulk = createFrameworkResizer({
      ...baseOpts(),
      name: 'bulk',
      queue: 'bulk',
    });
    assert.equal(media.queue, 'default');
    assert.equal(bulk.queue, 'bulk');
  });

  test('an empty queue name is rejected', () => {
    assert.throws(
      () => createFrameworkResizer({ ...baseOpts(), queue: '' }),
      (err: unknown) =>
        err instanceof ResizeSetupError && err.code === 'RESIZE_QUEUE_INVALID',
    );
  });

  test('listResizers() returns every registered Resizer in construction order', () => {
    const a = createFrameworkResizer(baseOpts());
    const b = createFrameworkResizer({ ...baseOpts(), name: 'b' });
    assert.deepEqual(listResizers(), [a, b]);
    resetResizerForTests();
    assert.deepEqual(listResizers(), []);
  });

  test('an empty name is rejected', () => {
    assert.throws(
      () => createFrameworkResizer({ ...baseOpts(), name: '' }),
      (err: unknown) =>
        err instanceof ResizeSetupError && err.code === 'RESIZE_NAME_INVALID',
    );
  });

  test('explicit config, logger and drivers need no framework app', () => {
    resetAppInstance();
    const r = new Resizer({
      storage: fakeStorage(),
      mediaStore: fakeMediaStore(),
      lockProvider: fakeLockProvider(),
      config: makeResizeConfig(),
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(r.name, 'default');
    assert.equal(getResizer(), r);
  });

  test('a core Resizer requires config and mediaStore, and lockProvider with a transport', () => {
    resetAppInstance();
    const core = {
      storage: fakeStorage(),
      mediaStore: fakeMediaStore(),
      config: makeResizeConfig(),
    };
    const rejects = (opts: unknown, code: string) =>
      assert.throws(
        () => new Resizer(opts as never),
        (err: unknown) =>
          err instanceof ResizeSetupError &&
          err.code === code &&
          err.message.includes('createFrameworkResizer'),
      );
    rejects({ ...core, config: undefined }, 'RESIZE_CONFIG_REQUIRED');
    rejects({ ...core, mediaStore: undefined }, 'RESIZE_MEDIA_STORE_REQUIRED');
    rejects(
      { ...core, transport: fakeTransport() },
      'RESIZE_LOCK_PROVIDER_REQUIRED',
    );
    // None of the rejected constructions claimed the name.
    const r = new Resizer(core);
    assert.equal(r.logger, console);
  });

  test('resetResizerForTests() forgets every Resizer', () => {
    const first = createFrameworkResizer(baseOpts());
    createFrameworkResizer({ ...baseOpts(), name: 'listings' });
    resetResizerForTests();
    const second = createFrameworkResizer(baseOpts());
    assert.notEqual(first, second);
    assert.equal(getResizer(), second);
    assert.throws(() => getResizer('listings'), /no Resizer named 'listings'/);
  });
});

// ---------------------------------------------------------------------------
// Named pipelines (04 · §8) — ported from registry.test.ts
// ---------------------------------------------------------------------------

describe('named pipelines', () => {
  test('a registered pipeline is retrievable', () => {
    const r = createFrameworkResizer(baseOpts());
    const p: Pipeline = { beforeSteps: [] };
    r.registerPipeline('photo', p);
    assert.equal(r.getPipeline('photo'), p);
  });

  test('re-registering a name replaces it (last-wins)', () => {
    const r = createFrameworkResizer(baseOpts());
    const p1: Pipeline = { beforeSteps: [] };
    const p2: Pipeline = { variantSteps: [] };
    r.registerPipeline('photo', p1);
    r.registerPipeline('photo', p2);
    assert.equal(r.getPipeline('photo'), p2);
  });

  test('unknown name → structurally empty pipeline {}, and frozen', () => {
    const r = createFrameworkResizer(baseOpts());
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
    const r = createFrameworkResizer(baseOpts());
    r.hook('resolveSizes', (v: number) => v + 1);
    r.hook('resolveSizes', async (v: number) => v * 2);
    const out = await r.runWaterfall('resolveSizes', 1, {});
    assert.equal(out, 4); // (1 + 1) * 2
  });

  test('threads ctx to each tap', async () => {
    installFakeApp();
    const r = createFrameworkResizer(baseOpts());
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
    const r = createFrameworkResizer(baseOpts());
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
    const r = createFrameworkResizer(baseOpts());
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
    const r = createFrameworkResizer(baseOpts());
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
    const r = createFrameworkResizer(baseOpts());
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
    const r = createFrameworkResizer(baseOpts());
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
    const r = createFrameworkResizer(baseOpts());
    const seen: string[] = [];
    r.hook('afterTaskComplete', () => {
      seen.push('ran');
    });
    await r.runObservers('afterTaskComplete', {}, {});
    assert.deepEqual(seen, ['ran']);
  });

  test('a THROWING app.events.emit is caught (logged) and taps still run', async () => {
    const { errors } = installFakeApp({ withEvents: true, emitThrows: true });
    const r = createFrameworkResizer(baseOpts());
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
    const r = createFrameworkResizer({
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
    const r = createFrameworkResizer(baseOpts());
    const { decision, output } = await r.resolve({
      media: {},
      sizes: [],
      formats: ['jpeg'],
    });
    assert.deepEqual(decision, { ready: [], missing: [] });
    assert.equal(output, undefined);
  });

  test('generate is wired (no longer a stub): empty sizes → empty created', async () => {
    // A config WITH mediaModelName so the Resizer's config validation does not throw.
    resetAppInstance();
    setAppInstance({
      getConfig: () => makeResizeConfig(),
      getModel: () => ({}),
      logger: { info() {}, warn() {}, error() {} },
    } as never);
    const r = createFrameworkResizer(baseOpts());
    const result = await r.generate({
      media: {
        id: 'm1',
        original: { storageRef: { key: 'o' }, contentType: 'image/jpeg' },
      },
      sizes: [],
    });
    assert.deepEqual(result.created, []);
    assert.equal(result.failed, 0);
  });
});
