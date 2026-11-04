// The guarded reads of a thrown value on the paths that must never throw. A thrown value may be host
// code: a getter, a `toString` or a Proxy trap can throw, and a message or a code can hold a line
// break.
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { ResizeError, ResizeStorageError } from '../errors.ts';
import type { ResizeLogger } from '../types.d.ts';
import {
  causeText,
  codeText,
  isModuleError,
  logNeverThrow,
  messageText,
  notRetryable,
} from './log.ts';

// Every trap throws. `no` and `trapped` serve the consumer's hostile-value test too, written out there.
const no = () => {
  throw new Error('no');
};
const trapped = new Proxy(
  {},
  {
    get: no,
    has: no,
    getPrototypeOf: no,
    ownKeys: no,
    getOwnPropertyDescriptor: no,
  },
);

test("messageText is a plain Error's message, without its name", () => {
  assert.equal(messageText(new Error('the engine line')), 'the engine line');
  assert.equal(messageText(new TypeError('a\nb')), 'a\nb');
});

test('messageText reads a value that is not an Error as causeText does', () => {
  assert.equal(messageText('a string'), 'a string');
  assert.equal(messageText(undefined), 'undefined');
  assert.equal(messageText({ toString: () => 'its text' }), 'its text');
});

test('messageText answers as causeText for a value that cannot be read', () => {
  const hostile = [
    { toString: no },
    Object.defineProperty(new Error('hidden'), 'message', { get: no }),
    Object.defineProperty(new Error('hidden'), 'message', {
      value: { toString: no },
    }),
    trapped,
  ];
  for (const value of hostile) {
    assert.equal(messageText(value), causeText(value));
    assert.equal(messageText(value), 'a thrown value that cannot be printed');
  }
});

test('causeText puts a multi-line error on one line', () => {
  assert.equal(causeText(new Error('a\nb\r\nc')), 'Error: a | b | c');
});

test('causeText treats U+2028, U+2029, U+0085, the form feed and the vertical tab as line breaks', () => {
  assert.equal(causeText(new Error('a\u2028b\u2029c')), 'Error: a | b | c');
  assert.equal(causeText(new Error('a \u2028\n b')), 'Error: a | b');
  assert.equal(causeText(new Error('a\fb\vc\u0085d')), 'Error: a | b | c | d');
});

test('causeText leaves no trailing separator after a message that ends in a line break', () => {
  assert.equal(causeText(new Error('a\n')), 'Error: a');
  assert.equal(causeText(new Error('a\r\n  ')), 'Error: a');
  assert.equal(causeText('a\u2029'), 'a');
});

test('causeText keeps a cause that starts with a line break', () => {
  assert.equal(
    causeText(new Error('a', { cause: '\nwhy\nmore' })),
    'Error: a (cause: why)',
  );
});

test('causeText keeps the first non-empty line of a cause error whose message starts with a line break', () => {
  assert.equal(
    causeText(
      new ResizeStorageError('download failed', {
        cause: new Error('\nHTTP 403 Forbidden'),
      }),
    ),
    'ResizeStorageError: download failed (cause: Error: HTTP 403 Forbidden)',
  );
  assert.equal(
    causeText(new Error('a', { cause: new TypeError('\r\n \n why\nmore') })),
    'Error: a (cause: TypeError: why)',
  );
  // Deduplicated on that line, not on the bare name.
  assert.equal(
    causeText(new Error('a: Error: why', { cause: new Error('\nwhy') })),
    'Error: a: Error: why',
  );
});

test('causeText adds the first line of a cause the message does not already hold', () => {
  assert.equal(
    causeText(new Error('a', { cause: new Error('why\nmore') })),
    'Error: a (cause: Error: why)',
  );
  assert.equal(
    causeText(new Error('a: Error: why', { cause: new Error('why') })),
    'Error: a: Error: why',
  );
});

test('causeText cuts at 1000 characters', () => {
  assert.equal(causeText(new Error('x'.repeat(5000))).length, 1000);
});

test('a long message gives way to its cause: the reason stays inside the cut', () => {
  const text = causeText(
    new Error('x'.repeat(5000), { cause: new Error('why') }),
  );
  assert.equal(text.length, 1000);
  assert.ok(text.endsWith(' (cause: Error: why)'), text.slice(-40));
  // A cause as long as the message leaves room for the message too.
  const both = causeText(
    new Error('x'.repeat(5000), { cause: 'y'.repeat(5000) }),
  );
  assert.equal(both.length, 1000);
  assert.match(both, /^Error: x+ \(cause: y+\)$/);
});

test('causeText stays quick on a long run of spaces', () => {
  // Without the cut before its regular expression this took about a minute (quadratic time),
  // with the event loop blocked for all of it.
  // The run is inside the text, so trimming does not remove it.
  const spaces = `a${' '.repeat(200_000)}b`;
  const started = performance.now();
  assert.ok(causeText(new Error(spaces)).length <= 1000);
  assert.ok(causeText(new Error('c', { cause: spaces })).length <= 1000);
  const tookMs = performance.now() - started;
  assert.ok(tookMs < 5000, `took ${tookMs} ms`);
});

test('causeText never throws', () => {
  const hostile = {
    toString() {
      throw new Error('no');
    },
  };
  assert.equal(causeText(hostile), 'a thrown value that cannot be printed');
  assert.equal(
    causeText(Object.create(null)),
    'a thrown value that cannot be printed',
  );
  const badCause = Object.defineProperty(new Error('a'), 'cause', {
    get() {
      throw new Error('no');
    },
  });
  assert.equal(causeText(badCause), 'Error: a');
  assert.equal(causeText(new Error('a', { cause: hostile })), 'Error: a');
  const badMessage = Object.defineProperty(new Error('a'), 'message', {
    get() {
      throw new Error('no');
    },
  });
  assert.equal(causeText(badMessage), 'a thrown value that cannot be printed');
  assert.equal(causeText(trapped), 'a thrown value that cannot be printed');
  assert.equal(causeText(new Error('a', { cause: trapped })), 'Error: a');
});

test('codeText reads one token, under a guard', () => {
  const withCode = (code: unknown) => Object.assign(new Error('x'), { code });
  assert.equal(codeText(withCode('ENOENT')), 'ENOENT');
  assert.equal(codeText(new Error('x')), 'none');
  assert.equal(codeText(null), 'none');
  assert.equal(codeText(withCode(5)), 'none');
  assert.equal(codeText(withCode('x'.repeat(101))), 'none');
  assert.equal(
    codeText(withCode('X\nresize worker: task forged is dead')),
    'none',
  );
  assert.equal(
    codeText(Object.defineProperty(new Error('x'), 'code', { get: no })),
    'none',
  );
  assert.equal(codeText(trapped), 'none');
});

test('notRetryable and isModuleError never throw, and a value they cannot read is retried', () => {
  assert.equal(notRetryable(new ResizeError('x', { retryable: false })), true);
  assert.equal(notRetryable(new ResizeError('x')), false);
  assert.equal(
    notRetryable(Object.assign(new Error('x'), { retryable: false })),
    false,
  );
  assert.equal(notRetryable(trapped), false);
  const branded = Object.defineProperty(new ResizeError('x'), 'retryable', {
    get: no,
  });
  assert.equal(notRetryable(branded), false);
  assert.equal(isModuleError(new ResizeError('x')), true);
  assert.equal(isModuleError(trapped), false);
});

// A logger that keeps every call's arguments, by level.
const recording = () => {
  const calls: unknown[][] = [];
  const keep =
    (level: string) =>
    (...args: unknown[]) => {
      calls.push([level, ...args]);
    };
  return {
    calls,
    logger: { info: keep('info'), warn: keep('warn'), error: keep('error') },
  };
};

// The sequences that corrupt a line, or lose its error, wherever the line is read as a format string.
const FORMAT_SEQUENCES = ['a%c3%a9.jpg', '%d0', '%s', '%o %O %j %i %f %%'];

test('logNeverThrow passes the line, and the error object itself as the second argument', () => {
  const { calls, logger } = recording();
  const err = new Error('download failed');
  logNeverThrow(logger, 'resize worker: the download failed', err);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 3);
  assert.equal(calls[0][1], 'resize worker: the download failed');
  assert.equal(calls[0][2], err);
});

test('logNeverThrow without an error passes the line alone', () => {
  const { calls, logger } = recording();
  logNeverThrow(logger, 'resize worker: m', undefined, 'warn');
  assert.deepEqual(calls, [['warn', 'resize worker: m']]);
});

test("logNeverThrow keeps the module's own line one line, whatever it holds", () => {
  const { calls, logger } = recording();
  const err = new Error('x\ny');
  logNeverThrow(logger, ' a\nb\r\nc d e\ff\vg\u0085h\n', err);
  assert.equal(calls[0][1], 'a | b | c | d | e | f | g | h');
  assert.equal(calls[0][2], err);
});

test('logNeverThrow stays quick on a long run of spaces', () => {
  const { calls, logger } = recording();
  const started = performance.now();
  logNeverThrow(logger, `a${' '.repeat(200_000)}b`, new Error('x'));
  assert.ok(performance.now() - started < 1000);
  assert.equal(calls.length, 1);
});

test('a logger that ignores the error never makes the module touch it', () => {
  const touched: string[] = [];
  const note = (trap: string) => () => {
    touched.push(trap);
    throw new Error(`the ${trap} trap ran`);
  };
  const hostile = new Proxy(new Error('x'), {
    get: note('get'),
    has: note('has'),
    getPrototypeOf: note('getPrototypeOf'),
    ownKeys: note('ownKeys'),
    getOwnPropertyDescriptor: note('getOwnPropertyDescriptor'),
  });
  const inspecting = Object.assign(new Error('y'), {
    [Symbol.for('nodejs.util.inspect.custom')]: note('inspect'),
  });
  Object.defineProperty(inspecting, 'stack', { get: note('stack') });
  const quiet = { info() {}, warn() {}, error() {} };
  logNeverThrow(quiet, 'm', hostile);
  logNeverThrow(quiet, 'n', inspecting, 'warn');
  assert.deepEqual(touched, []);
});

test('a logger that is not the console gets every `%` as it is', () => {
  for (const sequence of FORMAT_SEQUENCES) {
    const { calls, logger } = recording();
    const err = new Error('x');
    logNeverThrow(logger, `line ${sequence}`, err);
    assert.deepEqual(calls[0], ['error', `line ${sequence}`, err]);
  }
});

/** What the real console writes: its formatter runs, and only its output is held back. */
const held = (t: TestContext) => {
  const written: string[] = [];
  const keep = (chunk: unknown) => {
    written.push(String(chunk));
    return true;
  };
  t.mock.method(process.stderr, 'write', keep);
  t.mock.method(process.stdout, 'write', keep);
  return written;
};

test('the real console prints every `%` as it is, and the stack (util.format semantics)', (t) => {
  for (const level of ['error', 'warn', 'info'] as const) {
    for (const sequence of FORMAT_SEQUENCES) {
      const err = new Error('boom');
      const line = `resize worker: download https://bucket/${sequence} failed`;
      const written = held(t);
      logNeverThrow(console, line, err, level);
      t.mock.restoreAll();
      assert.equal(written.length, 1, sequence);
      assert.ok(written[0].startsWith(`${line} `), written[0]);
      assert.ok(written[0].includes(String(err.stack)), written[0]);
    }
  }
});

test('the real console prints a line with no error as it is: one argument formats nothing', (t) => {
  for (const sequence of FORMAT_SEQUENCES) {
    const written = held(t);
    logNeverThrow(console, `line ${sequence}`);
    t.mock.restoreAll();
    assert.deepEqual(written, [`line ${sequence}\n`]);
  }
});

test('a throwing logger falls back to the real console: the line as it is, and the stack', (t) => {
  const err = new Error('boom');
  const written = held(t);
  logNeverThrow({ error: no, warn: no, info: no }, 'line a%c3%d0%s', err);
  t.mock.restoreAll();
  assert.equal(written.length, 1);
  assert.ok(written[0].startsWith('line a%c3%d0%s '), written[0]);
  assert.ok(written[0].includes(String(err.stack)), written[0]);
});

test('logNeverThrow survives a throwing logger and a value console cannot format', (t) => {
  const written = held(t);
  const logger = { error: no, warn: no, info: no };
  logNeverThrow(logger, 'm', new Error('x', { cause: trapped }));
  // Whatever this Node's formatter makes of that value, the message is written.
  assert.equal(written.length, 1);
  assert.match(written[0], /^m/);
  // A custom inspect that throws stops every Node's formatter: the line goes alone, as it is.
  logNeverThrow(logger, 'n%c3', {
    [Symbol.for('nodejs.util.inspect.custom')]: no,
  });
  assert.equal(written[1], 'n%c3\n');
});

test('a console that cannot write is the end of it: nothing throws', (t) => {
  t.mock.method(console, 'error', no);
  logNeverThrow({ error: no, warn: no, info: no }, 'm', new Error('x'));
});

/**
 * A real Winston logger as the framework's `#createLogger` builds it: its format at the logger,
 * its default `redact` list, and its console text at the transport, without the colours.
 */
const frameworkWinston = async () => {
  const winston = (await import('winston')).default;
  const Transport = (await import('winston-transport')).default;
  const { createRedactFormat } = await import(
    '@adaptivestone/framework/services/logging/redaction.js'
  );
  const { default: logConfig } = await import(
    '@adaptivestone/framework/config/log.js'
  );
  const { format } = winston;
  const infos: Record<string | symbol, unknown>[] = [];
  class Capture extends Transport {
    log(info: Record<string | symbol, unknown>, done: () => void) {
      infos.push(info);
      done();
    }
  }
  const logger = winston.createLogger({
    format: format.combine(
      format.errors({ stack: true }),
      createRedactFormat(logConfig.redact as string[]),
    ),
    level: 'silly',
    transports: [
      new Capture({
        format: format.printf(
          (info) => `${info.level} : ${info.message} ${info.stack ?? ''}`,
        ),
      }),
    ],
  });
  const flushed = () => new Promise((resolve) => setImmediate(resolve));
  return {
    logger: logger as unknown as ResizeLogger,
    infos,
    flushed,
    printed: (info: Record<string | symbol, unknown>) =>
      String(info[Symbol.for('message')]),
  };
};

const withSecrets = () =>
  Object.assign(new Error('boom'), {
    token: 'SECRET-TOKEN',
    config: { headers: { Authorization: 'Bearer SECRET-AUTH' } },
  });

test("the framework's Winston format: the secrets are not printed, and a transport gets info.stack", async () => {
  const { logger, infos, flushed, printed } = await frameworkWinston();
  const err = withSecrets();
  logNeverThrow(logger, 'resize worker: task t is dead', err);
  await flushed();
  assert.equal(infos.length, 1);
  const [info] = infos;
  assert.equal(info.stack, err.stack);
  assert.equal(info.message, 'resize worker: task t is dead boom');
  assert.ok(printed(info).includes(String(err.stack)), printed(info));
  assert.doesNotMatch(printed(info), /SECRET/);
  // Its fields reach every transport, Sentry too, through the framework's redaction.
  assert.equal(info.token, '[REDACTED]');
  assert.doesNotMatch(JSON.stringify(info), /SECRET/);
});

test('a `%` that reads as no format sequence keeps the error on Winston, and the line as it is', async () => {
  const { logger, infos, flushed } = await frameworkWinston();
  const err = withSecrets();
  const line = 'resize worker: 100% of https://bucket/a%C3%A9.jpg failed';
  logNeverThrow(logger, line, err);
  await flushed();
  assert.equal(infos[0].message, `${line} boom`);
  assert.equal(infos[0].stack, err.stack);
});

// A limit the README names, pinned so that it cannot change unnoticed. Winston's own `log()` merges
// the error into the entry only when the line matches /%[scdjifoO%]/ nowhere. The module does not
// touch another logger's text, since a Winston logger without `splat` would print `%%`.
test('a format sequence in the line loses the error on Winston: the line stays literal, with no stack', async () => {
  for (const sequence of FORMAT_SEQUENCES) {
    const { logger, infos, flushed, printed } = await frameworkWinston();
    const line = `resize worker: download https://bucket/${sequence} failed`;
    logNeverThrow(logger, line, withSecrets());
    await flushed();
    assert.equal(infos[0].message, line);
    assert.equal(infos[0].stack, undefined);
    assert.doesNotMatch(printed(infos[0]), /SECRET/);
  }
});
