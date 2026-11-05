// What counts as the bytes of a stored object, in one place: a worker's source and an adopted object
// are read through the same driver, so they accept the same shapes.
import { types } from 'node:util';

/**
 * A Uint8Array (a Buffer is one) or an ArrayBuffer. The storage contract promises the first; a worker
 * has always rendered the second, so a driver that resolves with it keeps working. Both checks for
 * the first, since each misses what the other sees: `instanceof` a value from another realm, as under
 * a test runner that runs a host in a vm context, and `util.types` a Proxy around an array.
 */
export const isBytes = (
  value: unknown,
): value is Uint8Array | ArrayBufferLike =>
  value instanceof Uint8Array ||
  types.isUint8Array(value) ||
  types.isAnyArrayBuffer(value);

/** A Node Buffer of the bytes: a Buffer as it is, a Uint8Array copied, an ArrayBuffer as a view. */
export function asBuffer(bytes: Uint8Array | ArrayBufferLike): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as Uint8Array);
}
