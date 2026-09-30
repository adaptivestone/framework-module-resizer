import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import { ResizeConfigError } from '../errors.ts';
import { getResizeConfig } from '../resizeConfig.ts';
import { makeResizeConfig } from '../testHelpers/resizeConfig.ts';
import type { ResizeConfig } from '../types.d.ts';
import defaultResizeConfig from './resize.ts';

function install(config: unknown) {
  resetAppInstance();
  setAppInstance({
    getConfig: () => config,
    getModel: () => ({}),
    logger: { info() {}, warn() {}, error() {} },
  } as never);
}

afterEach(resetAppInstance);

describe('getResizeConfig', () => {
  test('ships the canonical host defaults without assuming a media model', () => {
    assert.equal('mediaModelName' in defaultResizeConfig, false);
    assert.deepEqual(defaultResizeConfig.formats, ['jpeg', 'webp', 'avif']);
    assert.deepEqual(defaultResizeConfig.upload.formats, [
      'jpeg',
      'png',
      'webp',
      'avif',
      'gif',
      'svg',
    ]);
    assert.equal(defaultResizeConfig.worker.enabled, false);
  });

  test('returns the final framework config without merging another defaults object', () => {
    const config = makeResizeConfig({ formats: ['webp'] });
    install(config);
    assert.strictEqual(getResizeConfig(), config);
    assert.deepEqual(getResizeConfig().formats, ['webp']);
  });

  test('accepts arbitrary non-empty Sharp format ids from config', () => {
    const config = makeResizeConfig({
      formats: ['tiff'],
      upload: { formats: ['tiff', 'heif'] },
      encode: { formats: { tiff: { compression: 'lzw' } } },
    });
    install(config);
    assert.deepEqual(getResizeConfig().formats, ['tiff']);
    assert.deepEqual(getResizeConfig().upload.formats, ['tiff', 'heif']);
  });

  test('rejects a partial host config because the framework config must be complete', () => {
    install({ mediaModelName: 'File' });
    assert.throws(
      () => getResizeConfig(),
      (error: unknown) =>
        error instanceof ResizeConfigError &&
        error.code === 'RESIZE_CONFIG_UPLOAD_INVALID',
    );
  });

  test('rejects missing mediaModelName, empty format lists, and blank ids', () => {
    const cases: unknown[] = [
      makeResizeConfig({ mediaModelName: '' }),
      makeResizeConfig({ formats: [] }),
      makeResizeConfig({ formats: [''] }),
      makeResizeConfig({ upload: { formats: [] } }),
      makeResizeConfig({ upload: { formats: ['  '] } }),
    ];
    for (const config of cases) {
      install(config);
      assert.throws(
        () => getResizeConfig(),
        (error: unknown) => error instanceof ResizeConfigError,
      );
    }
  });

  test('rejects invalid upload limits and queue lease invariants', () => {
    for (const config of [
      makeResizeConfig({ upload: { maxBytes: 0 } }),
      makeResizeConfig({ queue: { leaseMs: 0 } }),
      makeResizeConfig({
        queue: { leaseMs: 60_000, lockTtlMs: { worker: 120_000 } },
      }),
    ]) {
      install(config);
      assert.throws(
        () => getResizeConfig(),
        (error: unknown) => error instanceof ResizeConfigError,
      );
    }
  });

  test('rejects 0.2.x keys that would otherwise be ignored silently', () => {
    const base = makeResizeConfig();
    const cases: Array<[unknown, string]> = [
      [{ ...base, webpAvifOnly: true }, '`webpAvifOnly`'],
      [
        { ...base, encode: { ...base.encode, quality: { avif: 50 } } },
        '`encode.quality`',
      ],
      [
        { ...base, encode: { ...base.encode, flattenBackground: '#000' } },
        '`encode.flattenBackground`',
      ],
    ];
    for (const [config, path] of cases) {
      install(config);
      assert.throws(
        () => getResizeConfig(),
        (error: unknown) =>
          error instanceof ResizeConfigError &&
          error.code === 'RESIZE_CONFIG_REMOVED_KEY' &&
          error.message.includes(path),
      );
    }
  });

  test('requires an encode.formats entry for every generated format', () => {
    // 'jpg' is a Sharp alias: it would encode JPEG without the 'jpeg' options or flatten.
    install(makeResizeConfig({ formats: ['jpg', 'webp'] }));
    assert.throws(
      () => getResizeConfig(),
      (error: unknown) =>
        error instanceof ResizeConfigError &&
        error.code === 'RESIZE_CONFIG_FORMATS_INVALID' &&
        error.message.includes('[jpg]'),
    );

    const config = makeResizeConfig({
      formats: ['png'],
      encode: { formats: { png: {} } },
    });
    install(config);
    assert.deepEqual(getResizeConfig().formats, ['png']);
  });

  test('throws clearly when the framework app is not initialized', () => {
    resetAppInstance();
    assert.throws(() => getResizeConfig(), /not initialized/);
  });

  test('preserves the framework-provided object and nested encoder options', () => {
    const config: ResizeConfig = makeResizeConfig({
      encode: { formats: { webp: { quality: 71, effort: 6 } } },
    });
    install(config);
    assert.strictEqual(getResizeConfig(), config);
    assert.deepEqual(getResizeConfig().encode.formats.webp, {
      quality: 71,
      effort: 6,
    });
  });
});
