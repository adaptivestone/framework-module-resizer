// Reads the engine's error text, the only place it says what went wrong. A Sharp upgrade that
// changes a message makes src/decoders/sharp.test.ts fail, and until then costs five attempts
// instead of one. Never add `unsupported image format` to the damage list: on a worker it means a
// format this process has no decoder for, and a rolling deploy must not dead-letter good media.
// libvips keeps one error buffer per process, so of two decodes that fail at once one can find it
// emptied by the other. The corrupt-header prefix or a seek line with nothing after it is therefore
// no evidence of damage: it stays retryable, and a file holding only PNG magic bytes takes the normal
// retries. No truncation measured depends on either being damage, apart from that file.
import { ResizeError, ResizeMediaError } from '../errors.ts';
import type { ResizeLimits } from '../types.d.ts';

const CORRUPT_HEADER = 'Input buffer has corrupt header:';
const SEEK_NOISE = /^source: bad seek to \d+$/;
const DAMAGE =
  /^(VipsJpeg:|vipspng:|webp2vips:|webp:|gifload_buffer:|svgload_buffer:|tiff2vips:|heif: Invalid input|glib: XML parse error)|Warning treated as error/;
// A healthy file this build cannot decode, or a failure that is not about the bytes.
const NOT_DAMAGE =
  /unsupported|not supported|not configured|not been built in|not implemented|omitted at compile time|maximum supported|insufficient memory|out of memory|out of order read/i;

/** The line that says what went wrong: the first that is not seek noise, without the prefix. */
export function engineDetail(message: string): string {
  const body = message.startsWith(CORRUPT_HEADER)
    ? message.slice(CORRUPT_HEADER.length)
    : message;
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => !SEEK_NOISE.test(line)) ?? lines[0] ?? '';
}

/**
 * True when the engine says the bytes are broken, not that it cannot do the work. Any line of the
 * message can clear a file; only the line engineDetail reads can condemn one.
 */
export function isEngineDamage(message: string): boolean {
  return !NOT_DAMAGE.test(message) && DAMAGE.test(engineDetail(message));
}

/** Bytes no loader of this build recognises. Never used on a worker: see the note above. */
export function isUnsupportedBytes(message: string): boolean {
  return message.includes('unsupported image format');
}

/**
 * The error to throw for what Sharp rejected with: a ResizeMediaError for damage or the pixel
 * limit, else `err` itself, which the caller reports as a retryable failure. A decoder does not
 * know its media: the caller adds the id. `failOn` is what the failed call ran at: leave it out for
 * a call that did not use limits.failOn, and the message does not name it.
 */
export function sharpDecodeError(
  err: unknown,
  limits: Pick<ResizeLimits, 'inputPixels'> &
    Partial<Pick<ResizeLimits, 'failOn'>>,
): unknown {
  if (!(err instanceof Error) || ResizeError.isResizeError(err)) {
    return err;
  }
  const detail = engineDetail(err.message);
  if (detail.includes('exceeds pixel limit')) {
    return new ResizeMediaError(
      `resize: the source exceeds the pixel limit limits.inputPixels (${limits.inputPixels})`,
      { code: 'RESIZE_SOURCE_TOO_LARGE', retryable: false, cause: err },
    );
  }
  if (isEngineDamage(err.message)) {
    return new ResizeMediaError(
      `resize: the source is damaged${limits.failOn === undefined ? '' : ` (limits.failOn '${limits.failOn}')`}: ${detail}`,
      { code: 'RESIZE_SOURCE_DAMAGED', retryable: false, cause: err },
    );
  }
  if (detail === '' && err.message.startsWith(CORRUPT_HEADER)) {
    // Sharp made this error for this one failure, so the text can change here.
    err.message = `${CORRUPT_HEADER} the engine gave no detail`;
  }
  return err;
}
