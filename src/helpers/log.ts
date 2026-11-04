// Logging on a path that must never throw (resolve, prewarm, the worker loop), and the guarded reads
// of a thrown value such a path needs. The host's logger is host code and may throw too, so its
// failure falls back to the console instead of breaking the guarantee. A thrown value may be host
// code as well: a getter, a `toString` or a Proxy trap can throw, and a message or a code can hold
// a line break.
import { ResizeError } from '../errors.ts';
import type { ResizeLogger } from '../types.d.ts';

// The longest text a log line or a task row gets for a thrown value.
const MAX_TEXT_LENGTH = 1000;

// Trimmed first: a text that ends in a line break gets no trailing ` | `, and one that starts with
// a line break keeps its first line. Cut before the regular expression: it takes quadratic time on
// a long run of spaces (a minute for 200,000 of them), and it would hold up the whole worker loop
// for it. U+2028 and U+2029 are line breaks too, for a viewer that honours them.
const flat = (value: unknown): string =>
  String(value)
    .trim()
    .slice(0, 2 * MAX_TEXT_LENGTH)
    .replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' | ');

/**
 * One line for a log or a task row: never throws, so a value that cannot be printed cannot stop the
 * worker loop, and a message cannot forge a second log line.
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
      const first = flat(cause).split(' | ')[0];
      if (!text.includes(first)) {
        text += ` (cause: ${first})`;
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
 * Log `message` and `err` (when given) at `level` (default 'error'); a throwing logger falls back
 * to the console method of the same level. The console formats `err` too, and `util.inspect` throws
 * on some values, so that fallback is guarded as well.
 */
export function logNeverThrow(
  logger: ResizeLogger,
  message: string,
  err?: unknown,
  level: 'error' | 'warn' | 'info' = 'error',
): void {
  const rest = err === undefined ? [] : [err];
  try {
    logger[level](message, ...rest);
  } catch {
    try {
      console[level](message, ...rest);
    } catch {
      try {
        console[level](message);
      } catch {
        // Nothing left to write to, and this path must not throw.
      }
    }
  }
}
