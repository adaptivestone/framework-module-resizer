import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import type { DeepPartial, ResizeConfig } from '../types.d.ts';
import defaultResizeConfig, {
  getResizeConfig,
  requiredFormats,
} from './resize.ts';

// Install a fake ambient app whose getConfig('resize') returns the given override
// (the module reads it through getApp() — src/app.ts). Per-file isolation: node:test
// runs each test file in its own process, so the singleton never leaks across files.
const useHostConfig = (resize: DeepPartial<ResizeConfig>) => {
  resetAppInstance();
  setAppInstance({
    getConfig: () => resize,
    getModel: () => ({}),
    logger: { info() {}, warn() {}, error() {} },
  } as never);
};

afterEach(() => {
  resetAppInstance();
});

describe('defaultResizeConfig', () => {
  test('ships the documented codec defaults', () => {
    assert.equal(defaultResizeConfig.encode?.quality.jpeg, 80);
    assert.equal(defaultResizeConfig.encode?.quality.webp, 82);
    assert.equal(defaultResizeConfig.encode?.quality.avif, 64);
  });

  test('worker is disabled by default', () => {
    assert.equal(defaultResizeConfig.worker?.enabled, false);
  });
});

describe('getResizeConfig', () => {
  test('a deep override keeps every sibling default', () => {
    useHostConfig({
      mediaModelName: 'File',
      encode: { quality: { avif: 50 } },
    });
    const config = getResizeConfig();
    assert.equal(config.encode.quality.avif, 50); // overridden
    assert.equal(config.encode.quality.jpeg, 80); // sibling default kept
    assert.equal(config.encode.mozjpeg, true); // sibling default kept
    assert.equal(config.queue.maxAttempts, 3); // unrelated default kept
  });

  test('host arrays REPLACE the default (no concat)', () => {
    useHostConfig({ mediaModelName: 'File', formats: ['webp', 'avif'] });
    assert.deepEqual(getResizeConfig().formats, ['webp', 'avif']);
  });

  test('throws when the required mediaModelName is missing', () => {
    useHostConfig({});
    assert.throws(() => getResizeConfig(), /mediaModelName/);
  });

  test('throws a clear error when no app is initialized at all', () => {
    resetAppInstance();
    assert.throws(() => getResizeConfig(), /not initialized/);
  });

  test('does NOT mutate the shared defaultResizeConfig singleton', () => {
    useHostConfig({
      mediaModelName: 'File',
      encode: { quality: { avif: 10 } },
    });
    getResizeConfig();
    assert.equal(defaultResizeConfig.encode?.quality.avif, 64);
  });
});

describe('requiredFormats', () => {
  test('webpAvifOnly drops jpeg', () => {
    useHostConfig({ mediaModelName: 'File', webpAvifOnly: true });
    assert.deepEqual(requiredFormats(getResizeConfig()), ['webp', 'avif']);
  });

  test('otherwise returns config.formats verbatim', () => {
    useHostConfig({ mediaModelName: 'File' });
    assert.deepEqual(requiredFormats(getResizeConfig()), [
      'jpeg',
      'webp',
      'avif',
    ]);
  });
});
