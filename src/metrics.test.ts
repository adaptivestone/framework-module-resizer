import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { ResizeMetrics } from './contracts/metrics.ts';
import { ResizeSetupError } from './errors.ts';
import { boundMetrics, isMetrics, LogMetrics, NoopMetrics } from './metrics.ts';
import { metricsOf, Resizer, resetResizerForTests } from './resizer.ts';
import { fakeMedia, recordingMetrics } from './testHelpers/fakes.ts';
import type { ResizeLogger } from './types.d.ts';

// A logger that keeps every line by level.
function recordingLogger(): ResizeLogger & {
  lines: Record<'info' | 'warn' | 'error' | 'debug', unknown[][]>;
} {
  const lines: Record<'info' | 'warn' | 'error' | 'debug', unknown[][]> = {
    info: [],
    warn: [],
    error: [],
    debug: [],
  };
  return {
    lines,
    info: (...a) => lines.info.push(a),
    warn: (...a) => lines.warn.push(a),
    error: (...a) => lines.error.push(a),
    debug: (...a) => lines.debug.push(a),
  };
}

const infoLines = (logger: ReturnType<typeof recordingLogger>) =>
  logger.lines.info.map((line) => line[0]);

describe('LogMetrics', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  test('request-path events are summed into one info line per window, only when something was counted', () => {
    const logger = recordingLogger();
    const metrics = new LogMetrics(logger);
    for (let i = 0; i < 50; i += 1) {
      metrics.count('resize.read', 1, {
        resizer: 'default',
        pipeline: 'default',
        outcome: 'ready',
      });
    }
    assert.equal(logger.lines.info.length, 0);
    mock.timers.tick(59_999);
    assert.equal(logger.lines.info.length, 0);
    mock.timers.tick(1);
    assert.deepEqual(infoLines(logger), [
      "resize: Resizer 'default' over 60 s: reads 50 (ready 50)",
    ]);
    mock.timers.tick(600_000);
    assert.equal(logger.lines.info.length, 1);
  });

  test('the summary lists its sections in a fixed order', () => {
    const logger = recordingLogger();
    const metrics = new LogMetrics(logger);
    const r = { resizer: 'default' };
    const read = (outcome: string) =>
      metrics.count('resize.read', 1, { ...r, pipeline: 'default', outcome });
    read('ready');
    read('enqueued');
    read('in-flight');
    read('ready');
    read('in-flight');
    read('ready');
    metrics.count('resize.preview.stale', 2, { ...r, pipeline: 'default' });
    metrics.timing('resize.upload', 5, {
      ...r,
      outcome: 'stored',
      format: 'png',
    });
    metrics.count('resize.upload.bytes', 100, { ...r, format: 'png' });
    metrics.timing('resize.upload', 5, {
      ...r,
      outcome: 'stored',
      format: 'png',
    });
    metrics.count('resize.upload.bytes', 50, { ...r, format: 'png' });
    metrics.timing('resize.upload', 1, {
      ...r,
      outcome: 'rejected',
      code: 'RESIZE_ORIGINAL_EMPTY',
    });
    const variant = {
      ...r,
      pipeline: 'default',
      format: 'webp',
      mode: 'task',
      outcome: 'stored',
    };
    metrics.timing('resize.variant', 9, variant);
    metrics.timing('resize.variant', 9, variant);
    metrics.timing('resize.variant', 9, variant);
    metrics.count('resize.variant.bytes', 300, {
      ...r,
      pipeline: 'default',
      format: 'webp',
    });
    metrics.timing('resize.claim', 10, { ...r, queue: 'default' });
    metrics.timing('resize.claim', 30, { ...r, queue: 'default' });
    mock.timers.tick(60_000);
    assert.deepEqual(infoLines(logger), [
      "resize: Resizer 'default' over 60 s: reads 6 (ready 3, enqueued 1, in-flight 2), stale previews served 2, uploads 3 (150 bytes, rejected 1), variants 3 (300 bytes), claims 2 (average wait 20 ms)",
    ]);
  });

  test('an upload section with nothing stored lists the rejected uploads alone', () => {
    const logger = recordingLogger();
    const metrics = new LogMetrics(logger);
    metrics.timing('resize.upload', 1, {
      resizer: 'default',
      outcome: 'rejected',
      code: 'RESIZE_ORIGINAL_EMPTY',
    });
    mock.timers.tick(60_000);
    assert.deepEqual(infoLines(logger), [
      "resize: Resizer 'default' over 60 s: uploads 1 (rejected 1)",
    ]);
  });

  test('one summary line per resizer label, in first-seen order; a call without one goes to a line without a Resizer', () => {
    const logger = recordingLogger();
    const metrics = new LogMetrics(logger);
    metrics.count('resize.read', 1, { resizer: 'b', outcome: 'ready' });
    metrics.count('resize.read', 1, { outcome: 'failed' });
    metrics.count('resize.read', 1, { resizer: 'a', outcome: 'enqueued' });
    metrics.count('resize.read', 1, { resizer: 'b', outcome: 'suppressed' });
    mock.timers.tick(60_000);
    assert.deepEqual(infoLines(logger), [
      "resize: Resizer 'b' over 60 s: reads 2 (ready 1, suppressed 1)",
      'resize: over 60 s: reads 1 (failed 1)',
      "resize: Resizer 'a' over 60 s: reads 1 (enqueued 1)",
    ]);
  });

  test('a task outcome and a failed variant are written at once, one info line each, and not summed', () => {
    const logger = recordingLogger();
    const metrics = new LogMetrics(logger);
    metrics.timing(
      'resize.task',
      1234.4,
      {
        resizer: 'default',
        queue: 'default',
        pipeline: 'default',
        outcome: 'completed',
      },
      { taskId: 't1', mediaId: 'm1', attempts: 1, variants: 3 },
    );
    metrics.timing(
      'resize.task',
      5,
      {
        resizer: 'default',
        queue: 'bulk',
        pipeline: 'default',
        outcome: 'dead',
        code: 'RESIZE_SOURCE_DECODE_FAILED',
      },
      { taskId: 't2', mediaId: 'm2', attempts: 5, variants: 1 },
    );
    metrics.timing(
      'resize.variant',
      40,
      {
        resizer: 'default',
        pipeline: 'default',
        format: 'webp',
        mode: 'task',
        outcome: 'failed',
        code: 'other',
      },
      {
        mediaId: 'm1',
        identity: 'default:default:300x300:webp:none',
        code: 'HOST_X',
      },
    );
    assert.deepEqual(infoLines(logger), [
      "resize: task t1 of media m1 completed in 1234 ms (Resizer 'default', queue 'default', pipeline 'default', attempt 1, variants 3)",
      "resize: task t2 of media m2 dead in 5 ms (Resizer 'default', queue 'bulk', pipeline 'default', attempt 5, variants 1, code RESIZE_SOURCE_DECODE_FAILED)",
      "resize: variant default:default:300x300:webp:none of media m1 failed in 40 ms (Resizer 'default', pipeline 'default', format 'webp', code HOST_X)",
    ]);
    mock.timers.tick(60_000);
    assert.equal(logger.lines.info.length, 3);
  });

  test('a missing value of a written line prints as ?', () => {
    const logger = recordingLogger();
    new LogMetrics(logger).timing('resize.task', 2, { outcome: 'failed' });
    assert.deepEqual(infoLines(logger), [
      "resize: task ? of media ? failed in 2 ms (Resizer '?', queue '?', pipeline '?', attempt ?, variants ?)",
    ]);
  });

  test('debug lines: one per call when debug is on, none by default, and a logger without debug is fine', () => {
    const logger = recordingLogger();
    const metrics = new LogMetrics(logger, { debug: true });
    metrics.count('resize.read', 1, { outcome: 'ready' }, { mediaId: 'm1' });
    metrics.timing('resize.unknown', 3);
    assert.deepEqual(
      logger.lines.debug.map((line) => line[0]),
      [
        'resize metric resize.read 1 {"outcome":"ready"} {"mediaId":"m1"}',
        'resize metric resize.unknown 3 {} {}',
      ],
    );
    // A name LogMetrics does not know gets only the debug line: the window holds the read alone.
    mock.timers.tick(60_000);
    assert.deepEqual(infoLines(logger), [
      'resize: over 60 s: reads 1 (ready 1)',
    ]);

    const quiet = recordingLogger();
    new LogMetrics(quiet).count('resize.read', 1, { outcome: 'ready' });
    assert.equal(quiet.lines.debug.length, 0);

    const { debug: _debug, ...withoutDebug } = recordingLogger();
    assert.doesNotThrow(() =>
      new LogMetrics(withoutDebug, { debug: true }).count('resize.read', 1),
    );
    const throwing = recordingLogger();
    throwing.debug = () => {
      throw new Error('debug down');
    };
    assert.doesNotThrow(() =>
      new LogMetrics(throwing, { debug: true }).count('resize.read', 1),
    );
  });

  test('flush() writes the pending summary now and closes the window; with nothing counted it writes nothing', () => {
    const logger = recordingLogger();
    const metrics = new LogMetrics(logger);
    metrics.flush();
    assert.equal(logger.lines.info.length, 0);
    metrics.count('resize.read', 1, { resizer: 'default', outcome: 'ready' });
    mock.timers.tick(30_000);
    metrics.flush();
    assert.deepEqual(infoLines(logger), [
      "resize: Resizer 'default' over 30 s: reads 1 (ready 1)",
    ]);
    // The window's timer was cleared with it.
    mock.timers.tick(60_000);
    metrics.flush();
    assert.equal(logger.lines.info.length, 1);
    // The next event opens a new window, which starts with it.
    metrics.count('resize.read', 1, { resizer: 'default', outcome: 'failed' });
    metrics.flush();
    mock.timers.tick(60_000);
    assert.deepEqual(infoLines(logger).slice(1), [
      "resize: Resizer 'default' over 1 s: reads 1 (failed 1)",
    ]);
  });

  test('summaryIntervalMs must be a positive safe integer', () => {
    const logger = recordingLogger();
    for (const summaryIntervalMs of [0, -1, 1.5, Number.NaN, '60000']) {
      assert.throws(
        () =>
          new LogMetrics(logger, {
            summaryIntervalMs: summaryIntervalMs as number,
          }),
        (err: unknown) =>
          err instanceof ResizeSetupError &&
          err.code === 'RESIZE_METRICS_INVALID' &&
          err.retryable === false &&
          err.message ===
            'resize: LogMetrics `summaryIntervalMs` must be a positive safe integer (ms)',
        String(summaryIntervalMs),
      );
    }
    const metrics = new LogMetrics(logger, { summaryIntervalMs: 1000 });
    metrics.count('resize.read', 1, { outcome: 'ready' });
    mock.timers.tick(1000);
    assert.deepEqual(infoLines(logger), [
      'resize: over 1 s: reads 1 (ready 1)',
    ]);
  });

  test('a logger whose info throws does not throw out of the window timer', () => {
    const consoleInfo = mock.method(console, 'info', () => {});
    try {
      const logger = recordingLogger();
      logger.info = () => {
        throw new Error('logger down');
      };
      const metrics = new LogMetrics(logger);
      metrics.count('resize.read', 1, { outcome: 'ready' });
      assert.doesNotThrow(() => mock.timers.tick(60_000));
      assert.doesNotThrow(() =>
        metrics.timing('resize.task', 1, { outcome: 'completed' }),
      );
      assert.equal(consoleInfo.mock.callCount(), 2);
    } finally {
      consoleInfo.mock.restore();
    }
  });
});

describe('NoopMetrics', () => {
  afterEach(() => {
    resetResizerForTests();
  });

  test('NoopMetrics records nothing', async () => {
    const metrics = new NoopMetrics();
    assert.ok(metrics instanceof ResizeMetrics);
    assert.equal(isMetrics(metrics), true);
    assert.equal(
      metrics.count('resize.read', 1, { outcome: 'ready' }),
      undefined,
    );
    assert.equal(
      metrics.timing('resize.task', 1, { outcome: 'dead' }),
      undefined,
    );

    const logger = recordingLogger();
    const resizer = new Resizer({
      storage: {
        download: async () => Buffer.alloc(0),
        upload: async () => ({ key: 'k' }),
        publicUrl: () => '',
      },
      media: fakeMedia(),
      logger,
      metrics,
    });
    assert.equal(resizer.metrics, metrics);
    for (let i = 0; i < 3; i += 1) {
      await resizer.resolve({
        media: { id: 'm1', original: { storageRef: { key: 'o' } } },
        sizes: [],
      });
    }
    await metricsOf(resizer).flush();
    assert.deepEqual(logger.lines.info, []);
  });
});

describe('boundMetrics', () => {
  const pipelineLabel = (p: string) => (p === 'default' ? p : 'unregistered');

  test('boundMetrics adds the resizer label and normalizes pipeline and code labels', () => {
    const sink = recordingMetrics();
    const bound = boundMetrics(sink, {
      resizer: 'r1',
      logger: recordingLogger(),
      pipelineLabel,
    });
    bound.count('x', 1, { pipeline: 'retired', code: 'HOST_X' });
    bound.timing(
      'y',
      2,
      { pipeline: 'default', code: 'RESIZE_SOURCE_DECODE_FAILED' },
      { mediaId: 'm1' },
    );
    bound.count('z', 3, { resizer: 'spoofed' });
    assert.deepEqual(sink.calls, [
      {
        kind: 'count',
        name: 'x',
        value: 1,
        labels: { resizer: 'r1', pipeline: 'unregistered', code: 'other' },
        context: { pipeline: 'retired', code: 'HOST_X' },
      },
      {
        kind: 'timing',
        name: 'y',
        value: 2,
        labels: {
          resizer: 'r1',
          pipeline: 'default',
          code: 'RESIZE_SOURCE_DECODE_FAILED',
        },
        context: { mediaId: 'm1' },
      },
      {
        kind: 'count',
        name: 'z',
        value: 3,
        labels: { resizer: 'r1' },
        context: {},
      },
    ]);
  });

  test("boundMetrics never changes the caller's labels or context: the sink gets new objects", () => {
    const sink = recordingMetrics();
    const logger = recordingLogger();
    const bound = boundMetrics(sink, { resizer: 'r1', logger, pipelineLabel });
    const labels = Object.freeze({ pipeline: 'retired', code: 'HOST_X' });
    const context = Object.freeze({ mediaId: 'm1' });
    bound.count('x', 1, labels, context);
    bound.timing('y', 2, labels, context);
    // Frozen inputs: a write to either would have thrown, and been logged as a sink failure.
    assert.deepEqual(logger.lines.error, []);
    assert.deepEqual(labels, { pipeline: 'retired', code: 'HOST_X' });
    assert.deepEqual(context, { mediaId: 'm1' });
    assert.equal(sink.calls.length, 2);
    for (const call of sink.calls) {
      assert.notEqual(call.labels, labels);
      assert.notEqual(call.context, context);
      assert.deepEqual(call.labels, {
        resizer: 'r1',
        pipeline: 'unregistered',
        code: 'other',
      });
      assert.deepEqual(call.context, {
        mediaId: 'm1',
        pipeline: 'retired',
        code: 'HOST_X',
      });
    }
  });

  test('without pipelineLabel the pipeline label passes unchanged', () => {
    const sink = recordingMetrics();
    boundMetrics(sink, { resizer: 'r1', logger: recordingLogger() }).count(
      'x',
      1,
      { pipeline: 'retired' },
    );
    assert.deepEqual(sink.calls[0].labels, {
      resizer: 'r1',
      pipeline: 'retired',
    });
    assert.deepEqual(sink.calls[0].context, {});
  });

  test('boundMetrics never throws, and logs the first failure of each method once', () => {
    const logger = recordingLogger();
    const sink = {
      count() {
        throw new Error('count down');
      },
      timing() {
        throw new Error('timing down');
      },
    };
    const bound = boundMetrics(sink, { resizer: 'r1', logger, pipelineLabel });
    assert.doesNotThrow(() => bound.count('resize.read', 1));
    assert.doesNotThrow(() => bound.count('resize.read', 1));
    assert.doesNotThrow(() => bound.timing('resize.task', 1));
    assert.equal(logger.lines.error.length, 2);
    for (const line of logger.lines.error) {
      assert.match(
        String(line[0]),
        /metrics sink of Resizer 'r1' failed on 'resize\./,
      );
    }
    assert.match(
      String(logger.lines.error[0][0]),
      /further failures of count\(\)/,
    );
    assert.match(
      String(logger.lines.error[1][0]),
      /further failures of timing\(\)/,
    );
  });

  test('boundMetrics catches rejected promises from count, timing and flush', async () => {
    const logger = recordingLogger();
    const rejections: unknown[] = [];
    const record = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', record);
    try {
      const sink = {
        async count() {
          throw new Error('count down');
        },
        async timing() {
          throw new Error('timing down');
        },
        async flush() {
          throw new Error('flush down');
        },
      };
      const bound = boundMetrics(sink, { resizer: 'r1', logger });
      bound.count('resize.read', 1);
      bound.timing('resize.task', 1);
      await bound.flush();
      await nextTurn();
      assert.deepEqual(rejections, []);
      assert.equal(logger.lines.error.length, 3);
    } finally {
      process.off('unhandledRejection', record);
    }
  });

  test('flush() calls the sink flush when it has one, and resolves without one', async () => {
    const sink = recordingMetrics();
    const bound = boundMetrics(sink, {
      resizer: 'r1',
      logger: recordingLogger(),
    });
    await bound.flush();
    assert.equal(sink.flushes, 1);
    const plain = { count() {}, timing() {} };
    await boundMetrics(plain, {
      resizer: 'r1',
      logger: recordingLogger(),
    }).flush();
  });

  test('isMetrics checks for count and timing functions', () => {
    assert.equal(isMetrics({ count() {}, timing() {} }), true);
    assert.equal(isMetrics(new LogMetrics(recordingLogger())), true);
    for (const value of [undefined, null, {}, { count() {} }, 'x', 1]) {
      assert.equal(isMetrics(value), false, String(value));
    }
  });
});

test("the window timer is unref'd: a process that counts one event exits at once", () => {
  const url = new URL('./metrics.ts', import.meta.url).href;
  const script = `import { LogMetrics } from ${JSON.stringify(url)};
new LogMetrics({ info() {}, warn() {}, error() {} }).count('resize.read', 1, { outcome: 'ready' });`;
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    { timeout: 5000, encoding: 'utf8' },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
