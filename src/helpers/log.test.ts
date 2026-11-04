// The guarded reads of a thrown value on the paths that must never throw. A thrown value may be host
// code: a getter, a `toString` or a Proxy trap can throw, and a message or a code can hold a line
// break.
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { ResizeError, ResizeStorageError } from '../errors.ts';
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

// The sequences that corrupted a line, or lost its error, when a cause was a second argument.
const FORMAT_SEQUENCES = ['a%c3%a9.jpg', '%d0', '%s', '%o %O %j %i %f %%'];

test('logNeverThrow passes one string: the line, then the stack and the cause chain', () => {
  const { calls, logger } = recording();
  const err = new Error('download failed', { cause: new Error('HTTP 403') });
  logNeverThrow(logger, 'the line', err, 'warn');
  assert.equal(calls.length, 1);
  const [level, text, ...rest] = calls[0] as [string, string, ...unknown[]];
  assert.equal(level, 'warn');
  assert.deepEqual(rest, []);
  const [first, ...others] = text.split('\n');
  assert.equal(first, 'the line');
  const body = others.join('\n');
  assert.match(body, /^Error: download failed\n\s+at /);
  assert.match(body, /\[cause\]: Error: HTTP 403\n\s+at /);
});

test('logNeverThrow without an error passes the line alone', () => {
  const { calls, logger } = recording();
  logNeverThrow(logger, 'a');
  logNeverThrow(logger, 'b', undefined, 'info');
  assert.deepEqual(calls, [
    ['error', 'a'],
    ['info', 'b'],
  ]);
});

test('logNeverThrow reaches a cause four levels down', () => {
  const { calls, logger } = recording();
  let err = new Error('level 0');
  for (const level of [1, 2, 3, 4]) {
    err = new Error(`level ${level}`, { cause: err });
  }
  logNeverThrow(logger, 'm', err);
  assert.match(String(calls[0][1]), /\[cause\]: Error: level 0\n/);
});

test("logNeverThrow keeps the module's own line one line, whatever it holds", () => {
  const { calls, logger } = recording();
  logNeverThrow(logger, 'a\nb\r\nc d e\ff\vg\u0085h\n');
  assert.deepEqual(calls, [['error', 'a | b | c | d | e | f | g | h']]);
});

test('logNeverThrow cuts the appended text at 8000 characters, and says so', () => {
  const { calls, logger } = recording();
  logNeverThrow(logger, 'm', new Error('x'.repeat(100_000)));
  const text = String(calls[0][1]);
  assert.ok(text.length < 8100, `${text.length}`);
  assert.ok(text.startsWith('m\nError: xxx'));
  assert.ok(text.endsWith('… (cut at 8000 characters)'), text.slice(-60));
  // The line itself is the caller's: the cut is on what follows it.
  logNeverThrow(logger, 'm'.repeat(9000), new Error('short'));
  assert.ok(
    String(calls[1][1]).startsWith(`${'m'.repeat(9000)}\nError: short`),
  );
});

test('logNeverThrow stays quick on a long run of spaces', () => {
  const { logger } = recording();
  const spaces = `a${' '.repeat(200_000)}b`;
  const started = performance.now();
  logNeverThrow(logger, spaces, new Error(spaces));
  const tookMs = performance.now() - started;
  assert.ok(tookMs < 5000, `took ${tookMs} ms`);
});

test('logNeverThrow prints a thrown value that is no error', () => {
  const { calls, logger } = recording();
  logNeverThrow(logger, 'm', 'a string');
  logNeverThrow(logger, 'm', null);
  logNeverThrow(logger, 'm', { taskId: 'x' });
  assert.deepEqual(
    calls.map((call) => call[1]),
    ['m\na string', 'm\nnull', "m\n{ taskId: 'x' }"],
  );
});

test('a hostile value cannot throw out of logNeverThrow, and falls back to causeText', () => {
  const hostile: [string, unknown, string][] = [
    ['a Proxy', trapped, 'a thrown value that cannot be printed'],
    [
      'a throwing inspector',
      {
        [Symbol.for('nodejs.util.inspect.custom')]: no,
        toString: () => 'its text',
      },
      'its text',
    ],
    [
      'a throwing inspector and toString',
      { [Symbol.for('nodejs.util.inspect.custom')]: no, toString: no },
      'a thrown value that cannot be printed',
    ],
  ];
  for (const [what, value, text] of hostile) {
    const { calls, logger } = recording();
    logNeverThrow(logger, 'm', value);
    assert.deepEqual(calls, [['error', `m\n${text}`]], what);
  }
  // A getter that throws never gets out, whatever this Node's inspect makes of it.
  for (const key of ['stack', 'message', 'name', 'cause', 'code']) {
    const { calls, logger } = recording();
    const value = Object.defineProperty(new Error('hidden'), key, { get: no });
    logNeverThrow(logger, 'm', value);
    assert.equal(calls.length, 1, key);
    assert.match(String(calls[0][1]), /^m\n./, key);
  }
  // Nor does a Proxy as the cause.
  const { calls, logger } = recording();
  logNeverThrow(logger, 'm', new Error('x', { cause: trapped }));
  assert.match(String(calls[0][1]), /^m\nError: x/);
});

test('the real console prints every `%` as it is, and the stack (util.format semantics)', (t) => {
  const written: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  for (const sequence of FORMAT_SEQUENCES) {
    written.length = 0;
    const err = new Error(`download https://bucket/${sequence} failed`);
    const line = `resize worker: task t is dead: ${causeText(err)}`;
    logNeverThrow(console, line, err);
    assert.equal(written.length, 1, sequence);
    const [first] = written[0].split('\n');
    assert.equal(first, line, sequence);
    assert.ok(written[0].includes(String(err.stack)), sequence);
  }
});

test('a throwing logger falls back to the real console, with the same one string', (t) => {
  const written: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  const logger = { error: no, warn: no, info: no };
  const err = new Error('%c3%a9');
  logNeverThrow(logger, 'm %d0', err);
  assert.equal(written.length, 1);
  assert.ok(written[0].startsWith(`m %d0\n${String(err.stack)}`), written[0]);
  // A value the console could not format reaches it as text.
  logNeverThrow(logger, 'n', {
    [Symbol.for('nodejs.util.inspect.custom')]: no,
  });
  assert.equal(written[1], 'n\n[object Object]\n');
});

test('a console that cannot write is the end of it: nothing throws', (t) => {
  t.mock.method(console, 'error', no);
  logNeverThrow({ error: no, warn: no, info: no }, 'm', new Error('x'));
});

test('a Winston logger keeps every `%` and the stack, with and without splat', async (t) => {
  // From the framework's dependencies: an optional peer, so it may not be there.
  let winston: typeof import('winston');
  try {
    winston = (await import('winston')).default;
  } catch {
    t.skip('winston is not installed');
    return;
  }
  const { format } = winston;
  const shapes = {
    simple: format.simple(),
    splat: format.combine(format.splat(), format.simple()),
    // The framework's console format, without its colours.
    framework: format.combine(
      format.errors({ stack: true }),
      format.timestamp(),
      format.printf(
        (info) =>
          `${info.timestamp} ${info.level} : ${info.message} ${info.stack ?? ''}`,
      ),
    ),
  };
  for (const [shape, logFormat] of Object.entries(shapes)) {
    for (const sequence of FORMAT_SEQUENCES) {
      const out: string[] = [];
      const logger = winston.createLogger({
        format: logFormat,
        transports: [
          new winston.transports.Stream({
            stream: new Writable({
              write(chunk, _encoding, done) {
                out.push(String(chunk));
                done();
              },
            }),
          }),
        ],
      });
      const err = new Error(`download https://bucket/${sequence} failed`);
      const line = `resize worker: task t is dead: ${causeText(err)}`;
      logNeverThrow(logger, line, err);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(out.length, 1, `${shape} ${sequence}`);
      assert.ok(out[0].includes(line), `${shape} ${sequence}: ${out[0]}`);
      assert.ok(
        out[0].includes(String(err.stack)),
        `${shape} ${sequence}: ${out[0]}`,
      );
    }
  }
});
