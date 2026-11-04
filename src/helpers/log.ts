// Logging on a path that must never throw (resolve, prewarm, the worker loop), and the guarded reads
// of a thrown value such a path needs. The host's logger is host code and may throw too, so its
// failure falls back to the console instead of breaking the guarantee. A thrown value may be host
// code as well: a getter, a `toString` or a Proxy trap can throw, and a message or a code can hold
// a line break. Also the cap on a line logged once per key, which such a path repeats on every call.
import { inspect, types } from 'node:util';
import { ResizeError } from '../errors.ts';
import type { ResizeLogger } from '../types.d.ts';

// The longest text a log line or a task row gets for a thrown value.
const MAX_TEXT_LENGTH = 1000;
// The most of that text a cause may take, so a long cause leaves room for the message.
const MAX_CAUSE_LENGTH = 500;
// The longest text a log call appends after its line: a stack and its causes fit well within it.
const MAX_ERROR_TEXT_LENGTH = 8000;
// How many levels of an error's fields and causes it shows.
const ERROR_TEXT_DEPTH = 5;

// Trimmed first: a text that ends in a line break gets no trailing ` | `, and one that starts with
// a line break keeps its first line. Cut before the regular expression: it takes quadratic time on
// a long run of spaces (a minute for 200,000 of them), and it would hold up the whole worker loop
// for it. U+2028 and U+2029 are line breaks too, for a viewer that honours them, and so are the
// form feed, the vertical tab and U+0085.
const flat = (value: unknown): string =>
  String(value)
    .trim()
    .slice(0, 2 * MAX_TEXT_LENGTH)
    .replace(/\s*[\r\n\f\v\u0085\u2028\u2029]+\s*/g, ' | ');

/**
 * The first line of a cause that has text. An error whose message starts with a line break prints
 * as `Name: \nwhy`, which flattens to `Name: | why`: the name alone says nothing.
 */
function firstLine(cause: unknown): string {
  const [head, next] = flat(cause).split(' | ');
  return head.endsWith(':') && next !== undefined ? `${head} ${next}` : head;
}

/**
 * One line for a log or a task row: never throws, so a value that cannot be printed cannot stop the
 * worker loop, and a message cannot forge a second log line. A cause the message does not already
 * hold is kept through the cut: it is the reason, and a long message gives way to it.
 */
export function causeText(error: unknown): string {
  let text: string;
  try {
    text = flat(error);
  } catch {
    return 'a thrown value that cannot be printed';
  }
  try {
    const cause = (error as { cause?: unknown } | null)?.cause;
    if (cause !== undefined) {
      const first = firstLine(cause);
      if (!text.includes(first)) {
        const why = ` (cause: ${first.slice(0, MAX_CAUSE_LENGTH)})`;
        return `${text.slice(0, MAX_TEXT_LENGTH - why.length)}${why}`;
      }
    }
  } catch {
    // A cause that cannot be read or printed: the message alone is what there is.
  }
  return text.slice(0, MAX_TEXT_LENGTH);
}

/** A thrown value's message; one that cannot be read reads as causeText. */
export function messageText(error: unknown): string {
  try {
    return error instanceof Error ? String(error.message) : causeText(error);
  } catch {
    return causeText(error);
  }
}

/** The error's code when it is one token, else `none`: a code can hold a line break too. */
export function codeText(error: unknown): string {
  try {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    if (typeof code === 'string' && /^[\w.:-]{1,100}$/.test(code)) {
      return code;
    }
  } catch {
    // A getter or a Proxy trap that throws: no code to show.
  }
  return 'none';
}

/** `ResizeError.isResizeError` for a value that may be hostile: a trap that throws means no. */
export function isModuleError(error: unknown): error is ResizeError {
  try {
    return ResizeError.isResizeError(error);
  } catch {
    return false;
  }
}

// A ResizeError says when no retry can help (`retryable: false`), so the task is dead-lettered at
// once instead of being downloaded and decoded again. The brand, not `instanceof`, identifies one:
// it also matches an error from a duplicate copy of this package. Errors from other libraries are
// retried, even with a `retryable` field of their own (an AWS SDK v2 4xx carries one). A value whose
// brand or `retryable` cannot be read is retried.
export function notRetryable(error: unknown): boolean {
  try {
    return ResizeError.isResizeError(error) && error.retryable === false;
  } catch {
    return false;
  }
}

/**
 * What a log call appends for a thrown value: the console's text for it, so its stack, its `cause`
 * chain and its fields. A value that cannot be printed that way (a getter, a host inspector or a
 * Proxy trap that throws; inspect() would show a Proxy's target, not what it pretends to be) reads
 * as causeText.
 */
function errorText(error: unknown): string {
  let text: string;
  try {
    text =
      typeof error === 'object' && error !== null && !types.isProxy(error)
        ? inspect(error, { depth: ERROR_TEXT_DEPTH })
        : causeText(error);
  } catch {
    text = causeText(error);
  }
  return text.length > MAX_ERROR_TEXT_LENGTH
    ? `${text.slice(0, MAX_ERROR_TEXT_LENGTH)} … (cut at ${MAX_ERROR_TEXT_LENGTH} characters)`
    : text;
}

/**
 * Log `message` at `level` (default 'error'), as one line, and after it, when given, `err`'s text
 * on the lines below. The logger gets ONE string, never a second argument: a second argument turns
 * the line into a format string on the console (a `%c3` in a URL eats the error, stack and all),
 * and a Winston logger without `splat` and pino drop it. A throwing logger falls back to the
 * console method of the same level.
 */
export function logNeverThrow(
  logger: ResizeLogger,
  message: string,
  err?: unknown,
  level: 'error' | 'warn' | 'info' = 'error',
): void {
  const line = message.trim().replace(/[\r\n\f\v\u0085\u2028\u2029]+/g, ' | ');
  const text = err === undefined ? line : `${line}\n${errorText(err)}`;
  try {
    logger[level](text);
  } catch {
    try {
      console[level](text);
    } catch {
      // Nothing left to write to, and this path must not throw.
    }
  }
}

// A once-log keeps at most this many keys: host input (pipeline names, format lists, the message of
// an error) is unbounded.
export const ONCE_LOG_KEYS = 100;

/**
 * True the first time `key` is seen, which it then records, while `seen` holds fewer than
 * ONCE_LOG_KEYS keys: past that, nothing new is logged.
 */
export function firstTime(seen: Set<string>, key: string): boolean {
  if (seen.has(key) || seen.size >= ONCE_LOG_KEYS) {
    return false;
  }
  seen.add(key);
  return true;
}
