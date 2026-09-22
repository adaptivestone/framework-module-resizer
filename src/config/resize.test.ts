import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import { ResizeConfigError } from '../errors.ts';
import * as resizeConfigRuntime from '../resizeConfig.ts';
import defaultResizeConfig, {
  getResizeConfig,
  requiredFormats,
} from '../resizeConfigCompatibility.ts';
import type { DeepPartial, ResizeConfig } from '../types.d.ts';

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

  test('original uploads have byte and format allowlists', () => {
    assert.equal(defaultResizeConfig.upload.maxBytes, 25 * 1024 * 1024);
    assert.deepEqual(defaultResizeConfig.upload.formats, [
      'jpeg',
      'png',
      'webp',
      'avif',
      'gif',
      'svg',
    ]);
  });
});

describe('getResizeConfig', () => {
  test('does not expose the partial validator as a full-config public assertion', () => {
    assert.equal('validateResizeConfig' in resizeConfigRuntime, false);
  });

  test('a deep override keeps every sibling default', () => {
    useHostConfig({
      mediaModelName: 'File',
      encode: { quality: { avif: 50 } },
    });
    const config = getResizeConfig();
    assert.equal(config.encode.quality.avif, 50); // overridden
    assert.equal(config.encode.quality.jpeg, 80); // sibling default kept
    assert.equal(config.encode.mozjpeg, true); // sibling default kept
    assert.equal(config.queue.maxAttempts, 5); // unrelated default kept (delivery-count default)
  });

  test('host arrays REPLACE the default (no concat)', () => {
    useHostConfig({ mediaModelName: 'File', formats: ['webp', 'avif'] });
    assert.deepEqual(getResizeConfig().formats, ['webp', 'avif']);
  });

  test('throws when the required mediaModelName is missing', () => {
    useHostConfig({});
    assert.throws(() => getResizeConfig(), /mediaModelName/);
  });

  test('throws when lockTtlMs.worker > leaseMs (doneness invariant)', () => {
    useHostConfig({
      mediaModelName: 'File',
      queue: { lockTtlMs: { worker: 120000 }, leaseMs: 60000 },
    });
    assert.throws(() => getResizeConfig(), /lockTtlMs\.worker|leaseMs/);
  });

  test('validates original upload byte and format allowlists', () => {
    useHostConfig({ mediaModelName: 'File', upload: { maxBytes: 0 } });
    assert.throws(() => getResizeConfig(), /upload\.maxBytes/);
    useHostConfig({
      mediaModelName: 'File',
      upload: { formats: [] },
    });
    assert.throws(() => getResizeConfig(), /upload\.formats/);
  });

  test('rejects malformed nested values with ResizeConfigError, never TypeError', () => {
    const malformed: unknown[] = [
      { mediaModelName: '' },
      { mediaModelName: 'File', upload: null },
      { mediaModelName: 'File', upload: { maxBytes: 'nope' } },
      { mediaModelName: 'File', upload: { formats: null } },
      { mediaModelName: 'File', formats: ['png'] },
      { mediaModelName: 'File', queue: null },
      { mediaModelName: 'File', queue: { lockTtlMs: null } },
      { mediaModelName: 'File', queue: { leaseMs: 0 } },
      { mediaModelName: 'File', queue: { lockTtlMs: { worker: 'bad' } } },
    ];
    for (const config of malformed) {
      useHostConfig(config as DeepPartial<ResizeConfig>);
      assert.throws(
        () => getResizeConfig(),
        (error: unknown) => error instanceof ResizeConfigError,
      );
    }
  });

  test('accepts lockTtlMs.worker <= leaseMs', () => {
    useHostConfig({
      mediaModelName: 'File',
      queue: { lockTtlMs: { worker: 30000 }, leaseMs: 60000 },
    });
    assert.doesNotThrow(() => getResizeConfig());
    // The shipped default (worker 60000 == leaseMs 60000) also passes.
    resetAppInstance();
    setAppInstance({
      getConfig: () => ({ mediaModelName: 'File' }),
      getModel: () => ({}),
      logger: { info() {}, warn() {}, error() {} },
    } as never);
    assert.doesNotThrow(() => getResizeConfig());
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
