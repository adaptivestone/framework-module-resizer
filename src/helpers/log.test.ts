// The guarded reads of a thrown value on the paths that must never throw. A thrown value may be host
// code: a getter, a `toString` or a Proxy trap can throw, and a message or a code can hold a line
// break.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResizeError } from '../errors.ts';
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

test('causeText treats U+2028 and U+2029 as line breaks', () => {
  assert.equal(causeText(new Error('a\u2028b\u2029c')), 'Error: a | b | c');
  assert.equal(causeText(new Error('a \u2028\n b')), 'Error: a | b');
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

test('logNeverThrow survives a throwing logger and a value console cannot format', (t) => {
  // The real console, so its formatter runs; only what it writes is held back.
  const written: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  const logger = { error: no, warn: no, info: no };
  logNeverThrow(logger, 'm', new Error('x', { cause: trapped }));
  // Whatever this Node's formatter makes of that value, the message is written.
  assert.equal(written.length, 1);
  assert.match(written[0], /^m/);
  // A custom inspect that throws stops every Node's formatter: the message goes alone.
  logNeverThrow(logger, 'n', {
    [Symbol.for('nodejs.util.inspect.custom')]: no,
  });
  assert.equal(written[1], 'n\n');
});
