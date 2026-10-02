import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import { ResizeConfigError } from '../errors.ts';
import { getResizeConfig } from '../framework/config.ts';
import { validateResizeConfig } from '../resizeConfig.ts';
import {
  makeImageConfig,
  makeResizeConfig,
} from '../testHelpers/resizeConfig.ts';
import defaultResizeConfig, {
  defaultFrameworkResizeConfig,
  defaultQueueOptions,
  defaultWorkerOptions,
} from './resize.ts';

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
    // The core config holds image settings only; the framework defaults add queue and worker.
    assert.equal('queue' in defaultResizeConfig, false);
    assert.equal('worker' in defaultResizeConfig, false);
    assert.equal(defaultResizeConfig.concurrency, 4);
    assert.equal(defaultFrameworkResizeConfig.worker.enabled, false);
    assert.equal(defaultFrameworkResizeConfig.queue, defaultQueueOptions);
  });

  test('returns the final framework config without merging another defaults object', () => {
    const config = makeResizeConfig({ formats: ['webp'] });
    install(config);
    const resolved = getResizeConfig();
    assert.strictEqual(getResizeConfig(), resolved);
    assert.strictEqual(resolved.image.formats, config.formats);
    assert.strictEqual(resolved.queue, config.queue);
    assert.deepEqual(resolved.image.formats, ['webp']);
  });

  test('validates one cached framework config object once', () => {
    // Only validation reads upload.maxBytes; the per-call freshness check compares top-level
    // values by identity and never looks inside them.
    let maxBytesReads = 0;
    const config = makeResizeConfig();
    config.upload = new Proxy(config.upload, {
      get(target, key, receiver) {
        if (key === 'maxBytes') {
          maxBytesReads += 1;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    install(config);
    getResizeConfig();
    const afterFirstCall = maxBytesReads;
    assert.ok(afterFirstCall > 0);
    getResizeConfig();
    getResizeConfig();
    assert.equal(maxBytesReads, afterFirstCall);
  });

  test('validateResizeConfig checks a config without a framework app', () => {
    resetAppInstance();
    const config = makeImageConfig({ formats: ['webp'] });
    assert.strictEqual(validateResizeConfig(config), config);
    assert.throws(
      () => validateResizeConfig({ ...config, formats: [] }),
      (err: unknown) =>
        err instanceof ResizeConfigError &&
        err.code === 'RESIZE_CONFIG_FORMATS_INVALID',
    );
  });

  test('accepts arbitrary non-empty Sharp format ids from config', () => {
    const config = makeResizeConfig({
      formats: ['tiff'],
      upload: { formats: ['tiff', 'heif'] },
      encode: { formats: { tiff: { compression: 'lzw' } } },
    });
    install(config);
    assert.deepEqual(getResizeConfig().image.formats, ['tiff']);
    assert.deepEqual(getResizeConfig().image.upload.formats, ['tiff', 'heif']);
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
    assert.deepEqual(getResizeConfig().image.formats, ['png']);
  });

  test('throws clearly when the framework app is not initialized', () => {
    resetAppInstance();
    assert.throws(() => getResizeConfig(), /not initialized/);
  });

  test('preserves the framework-provided object and nested encoder options', () => {
    const config = makeResizeConfig({
      encode: { formats: { webp: { quality: 71, effort: 6 } } },
    });
    install(config);
    assert.strictEqual(getResizeConfig().image.encode, config.encode);
    assert.deepEqual(getResizeConfig().image.encode.formats.webp, {
      quality: 71,
      effort: 6,
    });
  });
});

describe('config split: core validation vs framework loading', () => {
  test('the core accepts a complete image config', () => {
    resetAppInstance();
    assert.doesNotThrow(() => validateResizeConfig(makeImageConfig()));
  });

  test('the core rejects queue and worker settings: they belong to the transport and worker', () => {
    for (const key of ['queue', 'worker']) {
      assert.throws(
        () => validateResizeConfig({ ...makeImageConfig(), [key]: {} }),
        (err: unknown) =>
          err instanceof ResizeConfigError &&
          err.code === 'RESIZE_CONFIG_REMOVED_KEY' &&
          err.message.includes(`\`${key}\``),
      );
    }
  });

  test('a framework config file may omit queue and worker; the defaults apply', () => {
    const { queue: _q, worker: _w, ...file } = makeResizeConfig();
    install(file);
    assert.strictEqual(getResizeConfig().queue, defaultQueueOptions);
    assert.strictEqual(getResizeConfig().worker, defaultWorkerOptions);
  });

  test('sees app.updateConfig()-style changes to the same config object', () => {
    const config = makeResizeConfig();
    install(config);
    assert.equal(getResizeConfig().mediaModelName, 'File');
    assert.equal(getResizeConfig().worker.enabled, false);
    // The framework's updateConfig() assigns into the cached object.
    Object.assign(config, {
      mediaModelName: 'Media',
      worker: { ...config.worker, enabled: true },
    });
    assert.equal(getResizeConfig().mediaModelName, 'Media');
    assert.equal(getResizeConfig().worker.enabled, true);
  });

  test('an invalid worker section is a config error', () => {
    install(makeResizeConfig({ worker: { sharpConcurrency: 0 } }));
    assert.throws(
      () => getResizeConfig(),
      (err: unknown) =>
        err instanceof ResizeConfigError &&
        err.code === 'RESIZE_CONFIG_INVALID',
    );
  });

  test('core validation does not read the framework app', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('../resizeConfig.ts', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(source, /from '[^']*framework[^']*'/);
  });

  test('getResizeConfig(configName) reads that config file', () => {
    resetAppInstance();
    setAppInstance({
      getConfig: (name: string) =>
        name === 'resizeListings'
          ? makeResizeConfig({ formats: ['webp'], mediaModelName: 'Photo' })
          : makeResizeConfig(),
      getModel: () => ({}),
      logger: { info() {}, warn() {}, error() {} },
    } as never);
    assert.deepEqual(getResizeConfig('resizeListings').image.formats, ['webp']);
    assert.equal(getResizeConfig('resizeListings').mediaModelName, 'Photo');
    assert.equal(getResizeConfig().mediaModelName, 'File');
  });

  test('a missing mediaModelName names the config file it is missing from', () => {
    resetAppInstance();
    const { mediaModelName: _omit, ...core } = makeResizeConfig();
    setAppInstance({
      getConfig: () => core,
      getModel: () => ({}),
      logger: { info() {}, warn() {}, error() {} },
    } as never);
    assert.throws(
      () => getResizeConfig('resizeListings'),
      (err: unknown) =>
        err instanceof ResizeConfigError &&
        err.code === 'RESIZE_CONFIG_MEDIA_MODEL_MISSING' &&
        err.message.includes('resizeListings'),
    );
  });
});
