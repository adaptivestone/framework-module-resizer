import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import { ResizeConfigError } from '../errors.ts';
import { makeResizeConfig } from '../testHelpers/resizeConfig.ts';
import type { Preview } from '../types.d.ts';
import { FrameworkMediaStore } from './mediaStore.ts';

// One stateless instance drives the whole file (option-less constructor; every
// method reaches the model/config ambiently through getApp()).
const store = new FrameworkMediaStore();

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

describe('FrameworkMediaStore.load', () => {
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

    const out = await store.load('m1');
    assert.equal(modelAsked, 'Media');
    assert.deepEqual(findByIdCalls, ['m1']);
    assert.equal(out, doc);
  });

  test('unknown model (getModel → false) is a config error, not missing media', async () => {
    installApp(false, { mediaModelName: 'Nope' });
    // A null here would let the worker complete every task as a deleted-media no-op.
    await assert.rejects(
      () => store.load('x'),
      (err: unknown) =>
        err instanceof ResizeConfigError &&
        err.code === 'RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN' &&
        err.message.includes("'Nope'"),
    );
    await assert.rejects(
      () => store.appendPreviews('x', []),
      (err: unknown) =>
        err instanceof ResizeConfigError &&
        err.code === 'RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN',
    );
    assert.throws(
      () => store.verify(),
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
    await new FrameworkMediaStore({ modelName: 'Photo' }).load('m1');
    assert.deepEqual(asked, ['Photo']);
  });

  test('verify() passes when the configured media model is registered', () => {
    installApp({}, { mediaModelName: 'Media' });
    assert.doesNotThrow(() => store.verify());
  });
});

describe('FrameworkMediaStore.appendPreviews', () => {
  test('issues exactly ONE findByIdAndUpdate with $push {$each} and no $set without dims', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const model = {
      findByIdAndUpdate(id: string, update: Record<string, unknown>) {
        calls.push([id, update]);
        return Promise.resolve({});
      },
    };
    installApp(model);
    const previews = [
      { sizeKey: '100x100', format: 'webp' },
    ] as unknown as Preview[];

    await store.appendPreviews('m1', previews);

    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'm1');
    assert.deepEqual(calls[0][1], {
      $push: { previews: { $each: previews } },
    });
    assert.equal('$set' in calls[0][1], false);
  });

  test('adds $set with dotted original.width/height ONLY when backfillDims is passed', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const model = {
      findByIdAndUpdate(_id: string, update: Record<string, unknown>) {
        calls.push(update);
        return Promise.resolve({});
      },
    };
    installApp(model);

    await store.appendPreviews('m1', [] as Preview[], {
      width: 800,
      height: 600,
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].$push, { previews: { $each: [] } });
    assert.deepEqual(calls[0].$set, {
      'original.width': 800,
      'original.height': 600,
    });
  });
});
