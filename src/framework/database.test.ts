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
import { FrameworkDatabase } from './database.ts';

// One stateless instance drives the whole file (option-less constructor; every
// method reaches the model/config ambiently through getApp()).
const db = new FrameworkDatabase();

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

describe('FrameworkDatabase.loadMedia', () => {
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

    const out = await db.loadMedia('m1');
    assert.equal(modelAsked, 'Media');
    assert.deepEqual(findByIdCalls, ['m1']);
    assert.equal(out, doc);
  });

  test('unknown model (getModel → false) is a config error, not missing media', async () => {
    installApp(false, { mediaModelName: 'Nope' });
    // A null here would let the worker complete every task as a deleted-media no-op.
    await assert.rejects(
      () => db.loadMedia('x'),
      (err: unknown) =>
        err instanceof ResizeConfigError &&
        err.code === 'RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN' &&
        err.message.includes("'Nope'"),
    );
    await assert.rejects(
      () => db.appendPreviews('x', []),
      (err: unknown) =>
        err instanceof ResizeConfigError &&
        err.code === 'RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN',
    );
    assert.throws(
      () => db.verify(),
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
    await new FrameworkDatabase({ modelName: 'Photo' }).loadMedia('m1');
    assert.deepEqual(asked, ['Photo']);
  });

  test('verify() passes when the configured media model is registered', () => {
    installApp({}, { mediaModelName: 'Media' });
    assert.doesNotThrow(() => db.verify());
  });

  test("verify() fails when the framework's Lock model is not registered", () => {
    setAppInstance({
      getConfig: () => makeResizeConfig({ mediaModelName: 'File' }),
      getModel: (name: string) => (name === 'Lock' ? undefined : {}),
      logger: { info() {}, warn() {}, error() {} },
    } as never);
    assert.throws(
      () => db.verify(),
      (err: Error & { code?: string }) =>
        err.code === 'RESIZE_MONGO_MODEL_MISSING' &&
        /Lock model/.test(err.message),
    );
  });
});

describe('FrameworkDatabase.appendPreviews', () => {
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

    assert.deepEqual(await db.appendPreviews('m1', [fresh, taken, legacy]), [
      fresh,
      legacy,
    ]);
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

    assert.deepEqual(await db.appendPreviews('m1', []), []);
    assert.equal(calls.length, 0);

    assert.deepEqual(
      await db.appendPreviews('m1', [] as Preview[], {
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

describe('FrameworkDatabase.verify: the media schema', () => {
  // A model-shaped object with a real schema whose preview rows are declared as given.
  const withRows = (modelName: string, row: Record<string, unknown>) => ({
    modelName,
    schema: new mongoose.Schema({ previews: [row] }),
  });

  test('a media model without previews.identity is a setup error naming the fragment', () => {
    installApp(withRows('File', { storageRef: { type: 'Mixed' } }));
    assert.throws(
      () => db.verify(),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_MONGO_MEDIA_MODEL_OUTDATED' &&
        err.message.includes("'File'") &&
        err.message.includes('resizeMediaSchemaFragment'),
    );
  });

  test('a media model with previews.identity, or without a schema, passes', () => {
    installApp(withRows('File', { identity: { type: String } }));
    assert.doesNotThrow(() => db.verify());
    resetAppInstance();
    installApp({ findById: async () => null });
    assert.doesNotThrow(() => db.verify());
  });
});

describe('FrameworkDatabase locks', () => {
  test('acquireLock resolves the Lock model and rounds milliseconds up to seconds', async () => {
    const asked: string[] = [];
    const acquired: Array<[string, number]> = [];
    setAppInstance({
      getModel: (name: string) => {
        asked.push(name);
        return {
          acquireLock: async (key: string, seconds: number) => {
            acquired.push([key, seconds]);
            return true;
          },
        };
      },
    } as never);

    assert.equal(await db.acquireLock('subsecond', 1), true);
    assert.equal(await db.acquireLock('exact', 2000), true);
    assert.equal(await db.acquireLock('rounded', 2001), true);
    assert.deepEqual(asked, ['Lock', 'Lock', 'Lock']);
    assert.deepEqual(acquired, [
      ['subsecond', 1],
      ['exact', 2],
      ['rounded', 3],
    ]);
  });

  test('acquireLock returns a boolean for the framework model result', async () => {
    const results = [null, false, undefined, { id: 'lock' }, true];
    setAppInstance({
      getModel: () => ({ acquireLock: async () => results.shift() }),
    } as never);

    for (const expected of [false, false, false, true, true]) {
      assert.equal(await db.acquireLock('key', 1000), expected);
    }
  });

  test('releaseLock resolves the Lock model and awaits its release', async () => {
    const asked: string[] = [];
    const released: string[] = [];
    const error = new Error('release failed');
    setAppInstance({
      getModel: (name: string) => {
        asked.push(name);
        return {
          releaseLock: async (key: string) => {
            released.push(key);
            if (key === 'broken') {
              throw error;
            }
            return true;
          },
        };
      },
    } as never);

    assert.equal(await db.releaseLock('key'), undefined);
    await assert.rejects(() => db.releaseLock('broken'), error);
    assert.deepEqual(asked, ['Lock', 'Lock']);
    assert.deepEqual(released, ['key', 'broken']);
  });
});
