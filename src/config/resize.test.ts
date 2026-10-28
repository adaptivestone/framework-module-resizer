import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import { ResizeConfigError } from '../errors.ts';
import {
  type ConfigSource,
  getProcessConfig,
  getResizeConfig,
  resolveFrameworkConfig,
  resolveProcessConfig,
} from '../framework/config.ts';
import { defaultWorkerOptions } from '../framework/defaults.ts';
import { validateResizeConfig } from '../resizeConfig.ts';
import {
  makeImageConfig,
  makeResizeConfig,
} from '../testHelpers/resizeConfig.ts';
import defaultResizeConfig, {
  defaultCoordination,
  defaultQueueOptions,
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

// How each kind of file is named in messages: the framework merges the environment file first.
const OVERRIDE = '(or its resize.<NODE_ENV>.ts override)';
const LISTINGS_FILE =
  'src/config/resizeListings.ts (or its resizeListings.<NODE_ENV>.ts override)';
const RESIZE_TS: ConfigSource = { configName: 'resize', explicit: false };
const LISTINGS_TS: ConfigSource = {
  configName: 'resizeListings',
  explicit: false,
};
const EXPLICIT: ConfigSource = { configName: 'resize', explicit: true };

const configError =
  (code: string, ...parts: Array<string | RegExp>) =>
  (err: unknown) =>
    err instanceof ResizeConfigError &&
    err.code === code &&
    parts.every((part) =>
      typeof part === 'string'
        ? err.message.includes(part)
        : part.test(err.message),
    );

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
    // The core config holds image settings only. Storage and the queue are the host's choice:
    // no defaults (no queue = eager only).
    assert.equal('queue' in defaultResizeConfig, false);
    assert.equal('worker' in defaultResizeConfig, false);
    assert.equal(defaultResizeConfig.concurrency, 4);
  });

  test('returns the final framework config without merging another defaults object', () => {
    const config = makeResizeConfig({
      formats: ['webp'],
      storage: { driver: 'local', rootDir: './m', publicBaseUrl: '/m' },
      queue: 'default',
      queues: { default: { driver: 'database', maxAttempts: 3 } },
    });
    install(config);
    const resolved = getResizeConfig();
    assert.strictEqual(getResizeConfig(), resolved);
    assert.strictEqual(resolved.image.formats, config.formats);
    assert.strictEqual(resolved.storage, config.storage);
    assert.equal(resolved.queue, 'default');
    assert.deepEqual(resolved.image.formats, ['webp']);
    const processConfig = getProcessConfig();
    assert.strictEqual(getProcessConfig(), processConfig);
    const entry = processConfig.queues.get('default');
    assert.strictEqual(entry?.section, config.queues?.default);
    assert.equal(entry?.name, 'default');
    assert.equal(entry?.backend, 'database');
    assert.equal(entry?.timing.maxAttempts, 3);
    assert.equal(entry?.timing.leaseMs, defaultQueueOptions.leaseMs);
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

  test('rejects invalid upload limits', () => {
    install(makeResizeConfig({ upload: { maxBytes: 0 } }));
    assert.throws(
      () => getResizeConfig(),
      (error: unknown) =>
        error instanceof ResizeConfigError &&
        error.code === 'RESIZE_CONFIG_UPLOAD_MAX_BYTES_INVALID',
    );
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

  test('rejects worker.concurrency and names src/config/resize.ts and the replacement', () => {
    for (const value of [8, undefined]) {
      install({
        ...makeResizeConfig(),
        worker: { ...defaultWorkerOptions, concurrency: value },
      });
      assert.throws(
        () => getProcessConfig(),
        configError(
          'RESIZE_CONFIG_REMOVED_KEY',
          '`worker.concurrency`',
          `src/config/resize.ts ${OVERRIDE}`,
          'top-level `concurrency`',
        ),
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

  test("the core config's removed queue and worker keys point framework hosts at src/config/resize.ts", () => {
    for (const [key, hint] of [
      [
        'queue',
        'framework hosts define each queue in `queues` of src/config/resize.ts',
      ],
      ['worker', 'framework hosts keep `worker` in src/config/resize.ts'],
    ]) {
      assert.throws(
        () => validateResizeConfig({ ...makeImageConfig(), [key]: {} }),
        configError('RESIZE_CONFIG_REMOVED_KEY', `\`${key}\``, hint),
      );
    }
  });

  test('a framework config file may omit storage, queue, queues and worker; the defaults apply', () => {
    install(makeResizeConfig());
    assert.equal(getResizeConfig().storage, undefined);
    assert.equal(getResizeConfig().queue, undefined);
    const processConfig = getProcessConfig();
    assert.equal(processConfig.queues.size, 0); // no queues: eager only
    assert.deepEqual(processConfig.worker, defaultWorkerOptions);
    assert.equal(processConfig.coordination, undefined);
  });

  test('queues entries need a driver; an SQS entry needs queueUrl', () => {
    const noDriver = `\`queues.bulk\` in src/config/resize.ts ${OVERRIDE} needs driver 'database' or 'sqs'`;
    for (const [queues, ...parts] of [
      [{ bulk: {} }, noDriver],
      [{ bulk: { driver: 'redis' } }, noDriver],
      [{ bulk: 'database' }, noDriver],
      [{ bulk: null }, noDriver],
      [{ bulk: { driver: 'sqs' } }, '`queues.bulk.queueUrl`', 'required'],
      [
        { bulk: { driver: 'sqs', queueUrl: '' } },
        '`queues.bulk.queueUrl`',
        'required',
      ],
      [[{ driver: 'database' }], '`queues`', 'must be an object'],
      ['database', '`queues`', 'must be an object'],
      [{ ' ': { driver: 'database' } }, '`queues`', 'blank'],
    ] as Array<[unknown, ...string[]]>) {
      assert.throws(
        () => resolveProcessConfig({ queues }),
        configError('RESIZE_CONFIG_INVALID', ...parts),
        JSON.stringify(queues),
      );
    }
    const resolved = resolveProcessConfig({
      queues: {
        default: { driver: 'database' },
        bulk: { driver: 'sqs', queueUrl: 'https://sqs.example/bulk' },
      },
    });
    assert.deepEqual([...resolved.queues.keys()], ['default', 'bulk']);
    assert.equal(resolved.queues.get('default')?.backend, 'database');
    assert.equal(
      resolved.queues.get('bulk')?.backend,
      'sqs:[null,null,null,10]',
    );
  });

  test('queues.<name>.lockTtlMs and queues.<name>.queues are RESIZE_CONFIG_REMOVED_KEY naming the entry', () => {
    for (const value of [{ failed: 600_000 }, undefined]) {
      assert.throws(
        () =>
          resolveProcessConfig({
            queues: { bulk: { driver: 'database', lockTtlMs: value } },
          }),
        configError(
          'RESIZE_CONFIG_REMOVED_KEY',
          '`queues.bulk.lockTtlMs`',
          `src/config/resize.ts ${OVERRIDE}`,
          'coordination in the same file',
          'lockTtlMs.failed → cooldownMs',
          'lockTtlMs.dispatch → gateTtlMs',
          'drop lockTtlMs.worker',
        ),
        JSON.stringify(value),
      );
    }
    assert.throws(
      () =>
        resolveProcessConfig({
          queues: {
            default: {
              driver: 'sqs',
              queueUrl: 'https://sqs.example/resize',
              queues: { bulk: 'https://sqs.example/bulk' },
            },
          },
        }),
      configError(
        'RESIZE_CONFIG_REMOVED_KEY',
        '`queues.default.queues`',
        `src/config/resize.ts ${OVERRIDE}`,
        'its own entry',
      ),
    );
  });

  test("a queue entry's invalid timing names the entry and keeps the timing code", () => {
    let error: unknown;
    try {
      resolveProcessConfig({
        queues: {
          default: { driver: 'database' },
          bulk: { driver: 'database', leaseMs: 0 },
        },
      });
    } catch (err) {
      error = err;
    }
    assert.ok(
      configError(
        'RESIZE_CONFIG_QUEUE_LEASE_INVALID',
        /queues\.bulk/,
        `src/config/resize.ts ${OVERRIDE}`,
        'leaseMs must be a positive safe integer',
      )(error),
      String(error),
    );
    const cause = (error as Error).cause;
    assert.ok(
      cause instanceof ResizeConfigError &&
        cause.code === 'RESIZE_CONFIG_QUEUE_LEASE_INVALID',
    );
    assert.throws(
      () =>
        resolveProcessConfig({
          queues: { slow: { driver: 'database', maxAttempts: 0 } },
        }),
      configError('RESIZE_CONFIG_QUEUE_INVALID', /queues\.slow/),
    );
  });

  test('two SQS entries with one queueUrl are RESIZE_CONFIG_INVALID', () => {
    assert.throws(
      () =>
        resolveProcessConfig({
          queues: {
            default: { driver: 'sqs', queueUrl: 'https://sqs.example/resize' },
            bulk: { driver: 'sqs', queueUrl: 'https://sqs.example/resize' },
          },
        }),
      configError(
        'RESIZE_CONFIG_INVALID',
        '`queues.default`',
        '`queues.bulk`',
        'https://sqs.example/resize',
      ),
    );
  });

  test('resize.ts with only process-wide sections resolves without mediaModelName', () => {
    install({
      queues: { bulk: { driver: 'database' } },
      worker: { ...defaultWorkerOptions, enabled: true },
      coordination: { cooldownMs: 1000 },
    });
    const resolved = getProcessConfig();
    assert.deepEqual([...resolved.queues.keys()], ['bulk']);
    assert.equal(resolved.worker.enabled, true);
    assert.deepEqual(resolved.coordination, { cooldownMs: 1000 });
  });

  test('a missing resize.ts means no queues, the default worker and no coordination, and is asked for once', () => {
    // The framework returns a new {} for a missing file and logs a warning on every request.
    const app = () => {
      const asked: string[] = [];
      setAppInstance({
        getConfig: (name: string) => {
          asked.push(name);
          return {};
        },
        getModel: () => ({}),
        logger: { info() {}, warn() {}, error() {} },
      } as never);
      return asked;
    };
    const asked = app();
    const first = getProcessConfig();
    assert.strictEqual(getProcessConfig(), first);
    getProcessConfig();
    assert.deepEqual(asked, ['resize']);
    assert.equal(first.queues.size, 0);
    assert.deepEqual(first.worker, defaultWorkerOptions);
    assert.equal(first.coordination, undefined);
    // Remembered per app: another app instance is asked again.
    resetAppInstance();
    const again = app();
    getProcessConfig();
    getProcessConfig();
    assert.deepEqual(again, ['resize']);
  });

  test('a partial worker section fills from defaultWorkerOptions; a wrong type is RESIZE_CONFIG_INVALID', () => {
    assert.deepEqual(
      resolveProcessConfig({ worker: { enabled: true } }).worker,
      {
        enabled: true,
        sharpConcurrency: 1,
        sharpCache: false,
      },
    );
    assert.deepEqual(
      resolveProcessConfig({
        worker: { sharpConcurrency: 4, sharpCache: undefined },
      }).worker,
      { enabled: false, sharpConcurrency: 4, sharpCache: false },
    );
    for (const [worker, key] of [
      [{ enabled: 'yes' }, '`worker.enabled`'],
      [{ sharpConcurrency: 0 }, '`worker.sharpConcurrency`'],
      [{ sharpConcurrency: 1.5 }, '`worker.sharpConcurrency`'],
      [{ sharpCache: 1 }, '`worker.sharpCache`'],
      [true, '`worker`'],
    ] as const) {
      assert.throws(
        () => resolveProcessConfig({ worker }),
        configError(
          'RESIZE_CONFIG_INVALID',
          key,
          `src/config/resize.ts ${OVERRIDE}`,
        ),
        JSON.stringify(worker),
      );
    }
  });

  test('queues, worker or coordination in another file, or in an explicit config, is RESIZE_CONFIG_INVALID naming the key and the override', () => {
    for (const [key, value] of [
      ['queues', { default: { driver: 'database' } }],
      ['worker', { enabled: true }],
      ['coordination', { cooldownMs: 1000 }],
    ] as const) {
      const raw = { ...makeResizeConfig(), [key]: value };
      assert.throws(
        () => resolveFrameworkConfig(raw, LISTINGS_TS),
        configError(
          'RESIZE_CONFIG_INVALID',
          `\`${key}\` in ${LISTINGS_FILE} is process-wide: it is read only from src/config/resize.ts`,
        ),
        key,
      );
      assert.throws(
        () => resolveFrameworkConfig(raw, EXPLICIT),
        configError(
          'RESIZE_CONFIG_INVALID',
          `\`${key}\` in the config passed to new FrameworkResizer() is process-wide: it is read only from src/config/resize.ts`,
        ),
        key,
      );
      // src/config/resize.ts holds them: the per-Resizer reading skips them.
      const resolved = resolveFrameworkConfig(raw, RESIZE_TS);
      assert.equal(key in resolved.image, false, key);
    }
  });

  test("a Resizer file's queue must be a name or false", () => {
    for (const queue of [undefined, false, 'default', 'bulk']) {
      assert.equal(
        resolveFrameworkConfig({ ...makeResizeConfig(), queue }, LISTINGS_TS)
          .queue,
        queue,
      );
    }
    for (const queue of [3, true, '', '  ', null, ['default']]) {
      assert.throws(
        () =>
          resolveFrameworkConfig({ ...makeResizeConfig(), queue }, LISTINGS_TS),
        configError('RESIZE_CONFIG_INVALID', `\`queue\` in ${LISTINGS_FILE}`),
        JSON.stringify(queue),
      );
    }
  });

  test('a queue object, in any file, is RESIZE_CONFIG_REMOVED_KEY pointing at queues in src/config/resize.ts', () => {
    const oldShape = { ...makeResizeConfig(), queue: { driver: 'database' } };
    const newShape =
      "is now a queue name — define the queue once in src/config/resize.ts as queues: { default: { driver: 'database', …timing } } and set queue: 'default' (or queue: false for eager only)";
    for (const [source, file] of [
      [RESIZE_TS, `src/config/resize.ts ${OVERRIDE}`],
      [LISTINGS_TS, `${LISTINGS_FILE}`],
      [EXPLICIT, 'the config passed to new FrameworkResizer()'],
    ] as const) {
      assert.throws(
        () => resolveFrameworkConfig(oldShape, source),
        configError(
          'RESIZE_CONFIG_REMOVED_KEY',
          `resize config: \`queue\` in ${file} ${newShape}`,
        ),
        file,
      );
    }
    // The process-wide reading catches it too, so the worker does at start.
    assert.throws(
      () => resolveProcessConfig(oldShape),
      configError(
        'RESIZE_CONFIG_REMOVED_KEY',
        `\`queue\` in src/config/resize.ts ${OVERRIDE} ${newShape}`,
      ),
    );
  });

  test('defaultQueueOptions has no lockTtlMs', () => {
    assert.equal('lockTtlMs' in defaultQueueOptions, false);
    assert.deepEqual(Object.keys(defaultQueueOptions).sort(), [
      'idlePollMs',
      'leaseMs',
      'maxAttempts',
      'retryBackoffMs',
      'taskTimeoutMs',
    ]);
  });

  test('…/config/resize.js holds only the core defaults', async () => {
    const mod = await import('./resize.ts');
    assert.deepEqual(Object.keys(mod).sort(), [
      'default',
      'defaultCoordination',
      'defaultQueueOptions',
    ]);
    assert.deepEqual(defaultCoordination, {
      gateTtlMs: 600_000,
      cooldownMs: 600_000,
    });
  });

  test('defaultFrameworkResizeConfig is the per-Resizer defaults: the image settings, no process-wide section', async () => {
    const framework = await import('../framework/index.ts');
    assert.deepEqual(
      framework.defaultFrameworkResizeConfig,
      defaultResizeConfig,
    );
    for (const key of [
      'worker',
      'coordination',
      'queue',
      'queues',
      'storage',
    ]) {
      assert.equal(key in framework.defaultFrameworkResizeConfig, false, key);
    }
    assert.deepEqual(framework.defaultWorkerOptions, {
      enabled: false,
      sharpConcurrency: 1,
      sharpCache: false,
    });
  });

  test("resize.ts's coordination is passed on unvalidated, outside the image config", () => {
    const raw = { ...makeResizeConfig(), coordination: { gateTtlMs: 0 } };
    assert.deepEqual(resolveProcessConfig(raw).coordination, { gateTtlMs: 0 });
    assert.equal(
      'coordination' in resolveFrameworkConfig(raw, RESIZE_TS).image,
      false,
    );
    assert.equal(
      resolveProcessConfig(makeResizeConfig()).coordination,
      undefined,
    );
  });

  test('queue: false is eager only', () => {
    install(makeResizeConfig({ queue: false }));
    assert.equal(getResizeConfig().queue, false);
  });

  test('sees app.updateConfig()-style changes to the same config object', () => {
    const config = makeResizeConfig({ worker: { enabled: false } });
    install(config);
    assert.equal(getResizeConfig().mediaModelName, 'File');
    assert.equal(getProcessConfig().worker.enabled, false);
    // The framework's updateConfig() assigns into the cached object.
    Object.assign(config, {
      mediaModelName: 'Media',
      worker: { ...config.worker, enabled: true },
      queues: { default: { driver: 'database' } },
    });
    assert.equal(getResizeConfig().mediaModelName, 'Media');
    assert.equal(getProcessConfig().worker.enabled, true);
    assert.deepEqual([...getProcessConfig().queues.keys()], ['default']);
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
