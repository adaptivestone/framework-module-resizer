import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import mongoose from 'mongoose';
import { ResizeConfigError, ResizeSetupError } from '../errors.ts';
import { makeResizeConfig } from '../testHelpers/resizeConfig.ts';
import type { Preview } from '../types.d.ts';
import { FrameworkLockStore } from './locks.ts';
import { FrameworkMediaStore } from './media.ts';

// The framework stores over a fake app. One stateless media store drives the media tests
// (option-less constructor; every method reaches the model and the config through getApp() when
// it runs); the lock store tests build their own stores.
const mediaStore = new FrameworkMediaStore();

// Install a fake ambient app whose getConfig('resize') carries mediaModelName and whose
// getModel returns the given (recording) model. mediaModelName is required or
// getResizeConfig throws — so it is always present here.
function installApp(
  model: unknown,
  opts: { mediaModelName?: string } = {},
): { errors: unknown[][] } {
  const mediaModelName = opts.mediaModelName ?? 'File';
  const errors: unknown[][] = [];
  setAppInstance({
    getConfig: () => makeResizeConfig({ mediaModelName }),
    getModel: () => model,
    logger: {
      info() {},
      warn() {},
      error(...args: unknown[]) {
        errors.push(args);
      },
    },
  } as never);
  return { errors };
}

afterEach(() => {
  resetAppInstance();
});

describe('FrameworkMediaStore.loadMedia', () => {
  test('resolves the model by config.mediaModelName and returns findById(mediaId)', async () => {
    const doc = { id: 'm1' };
    const findByIdCalls: string[] = [];
    let modelAsked = '';
    setAppInstance({
      getConfig: () => makeResizeConfig({ mediaModelName: 'Media' }),
      getModel: (name: string) => {
        modelAsked = name;
        return {
          findById(id: string) {
            findByIdCalls.push(id);
            return Promise.resolve(doc);
          },
        };
      },
      logger: { info() {}, warn() {}, error() {} },
    } as never);

    const out = await mediaStore.loadMedia('m1');
    assert.equal(modelAsked, 'Media');
    assert.deepEqual(findByIdCalls, ['m1']);
    assert.equal(out, doc);
  });

  test('unknown model (getModel → false) is a config error, not missing media', async () => {
    installApp(false, { mediaModelName: 'Nope' });
    // A null here would let the worker complete every task as a deleted-media no-op.
    await assert.rejects(
      () => mediaStore.loadMedia('x'),
      (err: unknown) =>
        err instanceof ResizeConfigError &&
        err.code === 'RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN' &&
        err.message.includes("'Nope'"),
    );
    await assert.rejects(
      () => mediaStore.appendPreviews('x', []),
      (err: unknown) =>
        err instanceof ResizeConfigError &&
        err.code === 'RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN',
    );
    assert.throws(
      () => mediaStore.verify(),
      (err: unknown) =>
        err instanceof ResizeConfigError &&
        err.code === 'RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN',
    );
  });

  test('an explicit modelName wins over the app config', async () => {
    const asked: string[] = [];
    resetAppInstance();
    setAppInstance({
      getConfig: () => makeResizeConfig({ mediaModelName: 'File' }),
      getModel: (name: string) => {
        asked.push(name);
        return { findById: async () => null };
      },
      logger: { info() {}, warn() {}, error() {} },
    } as never);
    await new FrameworkMediaStore({ modelName: 'Photo' }).loadMedia('m1');
    assert.deepEqual(asked, ['Photo']);
  });

  test('verify() passes when the configured media model is registered', () => {
    installApp({}, { mediaModelName: 'Media' });
    assert.doesNotThrow(() => mediaStore.verify());
  });
});

describe('FrameworkMediaStore.appendPreviews', () => {
  // A media model that records each findOneAndUpdate; `matched` decides whether a document is
  // returned (null: nothing matched).
  function recordingModel(
    matched: (filter: Record<string, unknown>) => boolean,
  ) {
    const calls: Array<[Record<string, unknown>, Record<string, unknown>]> = [];
    const options: unknown[] = [];
    return {
      calls,
      options,
      model: {
        findOneAndUpdate(
          filter: Record<string, unknown>,
          update: Record<string, unknown>,
          opts: unknown,
        ) {
          calls.push([filter, update]);
          options.push(opts);
          return Promise.resolve(matched(filter) ? { _id: 'm1' } : null);
        },
      },
    };
  }

  test('pushes each preview unless its identity is already stored, and resolves with the stored ones', async () => {
    const { calls, options, model } = recordingModel(
      (filter) =>
        (filter['previews.identity'] as { $ne?: string } | undefined)?.$ne !==
        'taken',
    );
    installApp(model);
    const fresh = { identity: 'fresh', sizeKey: '100x100' } as Preview;
    const taken = { identity: 'taken', sizeKey: '200x200' } as Preview;
    const legacy = { sizeKey: '300x300' } as Preview;

    assert.deepEqual(
      await mediaStore.appendPreviews('m1', [fresh, taken, legacy]),
      [fresh, legacy],
    );
    assert.deepEqual(calls, [
      [
        { _id: 'm1', 'previews.identity': { $ne: 'fresh' } },
        { $push: { previews: fresh } },
      ],
      [
        { _id: 'm1', 'previews.identity': { $ne: 'taken' } },
        { $push: { previews: taken } },
      ],
      // No identity: stored unconditionally.
      [{ _id: 'm1' }, { $push: { previews: legacy } }],
    ]);
    // Only the id comes back, not the whole media document per preview.
    for (const opts of options) {
      assert.deepEqual(opts, { projection: { _id: 1 } });
    }
  });

  test('sets the dotted original.width/height ONLY when backfillDims is passed, even with nothing to push', async () => {
    const { calls, options, model } = recordingModel(() => true);
    installApp(model);

    assert.deepEqual(await mediaStore.appendPreviews('m1', []), []);
    assert.equal(calls.length, 0);

    assert.deepEqual(
      await mediaStore.appendPreviews('m1', [] as Preview[], {
        width: 800,
        height: 600,
      }),
      [],
    );
    assert.deepEqual(calls, [
      [
        { _id: 'm1' },
        { $set: { 'original.width': 800, 'original.height': 600 } },
      ],
    ]);
    assert.deepEqual(options, [{ projection: { _id: 1 } }]);
  });
});

describe('FrameworkMediaStore.replacePreviews', () => {
  // A media model that records each findOneAndUpdate and resolves with `before` (the pre-image).
  function pipelineModel(
    before: unknown,
    castObject?: (doc: { previews: Preview[] }) => { previews?: unknown[] },
  ) {
    const calls: Array<{ filter: unknown; update: unknown; options: unknown }> =
      [];
    return {
      calls,
      model: {
        findOneAndUpdate(filter: unknown, update: unknown, options: unknown) {
          calls.push({ filter, update, options });
          return Promise.resolve(before);
        },
        ...(castObject ? { castObject } : {}),
      },
    };
  }
  const row = (identity: string | undefined, path: string) =>
    ({
      storageRef: { path },
      ...(identity === undefined ? {} : { identity }),
      sizeKey: '16x16',
      format: 'webp',
    }) as Preview;

  test('FrameworkMediaStore.replacePreviews sends one update pipeline with returnDocument before', async () => {
    const oldA = row('a', 'a1');
    const oldB = row('b', 'b1');
    const before = {
      _id: 'm1',
      previews: [row(undefined, 'x0'), oldA, oldB, row('c', 'c1')],
    };
    const casts: unknown[] = [];
    const { calls, model } = pipelineModel(before, (doc) => {
      casts.push(doc);
      return { previews: doc.previews.map((p) => ({ ...p, cast: true })) };
    });
    installApp(model);
    const next = row('a', 'a9');
    const legacy = row(undefined, 'legacy');

    const result = await mediaStore.replacePreviews(
      'm1',
      ['b', 'a'],
      [next, row('a', 'a-repeat'), legacy],
    );

    // The first row per identity is cast; a row without an identity is kept.
    assert.deepEqual(casts, [{ previews: [next, legacy] }]);
    const written = [
      { ...next, cast: true },
      { ...legacy, cast: true },
    ];
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].filter, { _id: 'm1' });
    assert.deepEqual(calls[0].update, [
      {
        $set: {
          previews: {
            $concatArrays: [
              {
                $filter: {
                  input: { $ifNull: ['$previews', []] },
                  cond: {
                    $not: [
                      { $in: ['$$this.identity', { $literal: ['b', 'a'] }] },
                    ],
                  },
                },
              },
              { $literal: written },
            ],
          },
        },
      },
    ]);
    assert.deepEqual(calls[0].options, {
      projection: { previews: 1 },
      returnDocument: 'before',
      updatePipeline: true,
      lean: true,
    });
    assert.deepEqual(result, { stored: written, removed: [oldA, oldB] });
  });

  test('a model without castObject gets the rows as given, minus undefined keys', async () => {
    const { calls, model } = pipelineModel({ _id: 'm1', previews: [] });
    installApp(model);
    const given = {
      ...row('a', 'a1'),
      bytes: undefined,
      origin: undefined,
    } as Preview;

    const result = await mediaStore.replacePreviews('m1', [], [given]);

    const expected = row('a', 'a1');
    const update = calls[0].update as Array<{
      $set: { previews: { $concatArrays: [unknown, { $literal: Preview[] }] } };
    }>;
    const literal = update[0].$set.previews.$concatArrays[1].$literal;
    assert.deepEqual(literal, [expected]);
    assert.equal(Object.hasOwn(literal[0], 'bytes'), false);
    assert.deepEqual(result, { stored: [expected], removed: [] });
    // The caller's row is left as it was.
    assert.equal(Object.hasOwn(given, 'bytes'), true);
  });
});

describe('FrameworkMediaStore.verify: the media schema', () => {
  // A model-shaped object with a real schema whose preview rows are declared as given.
  const withRows = (modelName: string, row: Record<string, unknown>) => ({
    modelName,
    schema: new mongoose.Schema({ previews: [row] }),
  });

  test('a media model without previews.identity is a setup error naming the fragment', () => {
    installApp(withRows('File', { storageRef: { type: 'Mixed' } }));
    assert.throws(
      () => mediaStore.verify(),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_MONGO_MEDIA_MODEL_OUTDATED' &&
        err.message.includes("'File'") &&
        err.message.includes('resizeMediaSchemaFragment'),
    );
  });

  test('a media model with strict rows without origin or encodeSig is a setup error naming them', () => {
    installApp(withRows('File', { identity: { type: String } }));
    assert.throws(
      () => mediaStore.verify(),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_MONGO_MEDIA_MODEL_OUTDATED' &&
        err.message.includes("'File'") &&
        err.message.includes('previews.origin') &&
        err.message.includes('previews.encodeSig') &&
        !err.message.includes('previews.identity'),
    );
  });

  test('a media model with previews.identity, origin and encodeSig, or without a schema, passes', () => {
    installApp(
      withRows('File', {
        identity: { type: String },
        origin: { type: String },
        encodeSig: { type: String },
      }),
    );
    assert.doesNotThrow(() => mediaStore.verify());
    resetAppInstance();
    installApp({ findById: async () => null });
    assert.doesNotThrow(() => mediaStore.verify());
  });
});

test("FrameworkLockStore.verify() fails when the framework's Lock model is not registered", () => {
  setAppInstance({
    getModel: (name: string) => (name === 'Lock' ? undefined : {}),
  } as never);
  assert.throws(
    () => new FrameworkLockStore().verify(),
    (err: Error & { code?: string }) =>
      err instanceof ResizeSetupError &&
      err.code === 'RESIZE_MONGO_MODEL_MISSING' &&
      /Lock model/.test(err.message),
  );
});

test('both stores can be built before the framework app exists', () => {
  // Nothing is read from the framework until first use.
  resetAppInstance();
  assert.doesNotThrow(() => new FrameworkMediaStore());
  assert.doesNotThrow(() => new FrameworkLockStore());
});
