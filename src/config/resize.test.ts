import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  DeepPartial,
  ResizeConfig,
  TMinimalResizeApp,
} from '../types.d.ts';
import defaultResizeConfig, {
  getResizeConfig,
  requiredFormats,
} from './resize.ts';

const makeApp = (resize: DeepPartial<ResizeConfig>): TMinimalResizeApp => ({
  getConfig: () => resize,
  getModel: () => ({}),
  logger: { info() {}, warn() {}, error() {} },
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
    const config = getResizeConfig(
      makeApp({ mediaModelName: 'File', encode: { quality: { avif: 50 } } }),
    );
    assert.equal(config.encode.quality.avif, 50); // overridden
    assert.equal(config.encode.quality.jpeg, 80); // sibling default kept
    assert.equal(config.encode.mozjpeg, true); // sibling default kept
    assert.equal(config.queue.maxAttempts, 3); // unrelated default kept
  });

  test('host arrays REPLACE the default (no concat)', () => {
    const config = getResizeConfig(
      makeApp({ mediaModelName: 'File', formats: ['webp', 'avif'] }),
    );
    assert.deepEqual(config.formats, ['webp', 'avif']);
  });

  test('throws when the required mediaModelName is missing', () => {
    assert.throws(() => getResizeConfig(makeApp({})), /mediaModelName/);
  });

  test('does NOT mutate the shared defaultResizeConfig singleton', () => {
    getResizeConfig(
      makeApp({ mediaModelName: 'File', encode: { quality: { avif: 10 } } }),
    );
    assert.equal(defaultResizeConfig.encode?.quality.avif, 64);
  });
});

describe('requiredFormats', () => {
  test('webpAvifOnly drops jpeg', () => {
    const config = getResizeConfig(
      makeApp({ mediaModelName: 'File', webpAvifOnly: true }),
    );
    assert.deepEqual(requiredFormats(config), ['webp', 'avif']);
  });

  test('otherwise returns config.formats verbatim', () => {
    const config = getResizeConfig(makeApp({ mediaModelName: 'File' }));
    assert.deepEqual(requiredFormats(config), ['jpeg', 'webp', 'avif']);
  });
});
