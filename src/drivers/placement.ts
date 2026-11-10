import { ResizeSecurityError } from '../errors.ts';

/** Validate an audit grouping without interpreting it as authorization. */
export function validateNamespace(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== 'string' ||
    !value ||
    !value
      .split('/')
      .every(
        (part) =>
          part !== '.' && part !== '..' && /^[A-Za-z0-9_.-]+$/.test(part),
      )
  ) {
    throw new ResizeSecurityError('resize storage: invalid namespace', {
      code: 'RESIZE_STORAGE_NAMESPACE_INVALID',
    });
  }
  return value;
}

/** A suggested relative name must not escape or ambiguously change its namespace. */
export function validateLogicalKey(key: string): string {
  if (
    typeof key !== 'string' ||
    !key ||
    !key
      .split('/')
      .every(
        (part) =>
          part !== '.' && part !== '..' && /^[A-Za-z0-9_.-]+$/.test(part),
      )
  ) {
    throw new ResizeSecurityError('resize storage: invalid logical key', {
      code: 'RESIZE_STORAGE_KEY_INVALID',
    });
  }
  return key;
}

/**
 * A key already in a bucket, which the module only reads. It may hold a client's file name, so it
 * is not held to the alphabet of the keys the module writes. S3 keys are flat, and the SDK encodes
 * the key itself. Control characters, and the parts a URL or a proxy would resolve as a path, are
 * refused. A lone surrogate is not valid UTF-8, so no such key exists, and encoding it throws.
 */
export function validateStoredKey(key: string): string {
  if (
    !key.isWellFormed() ||
    /\p{Cc}/u.test(key) ||
    key.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new ResizeSecurityError(
      "resize s3: invalid object key: it holds a control character, a '.' or '..' part, a leading '/' or an empty part",
      { code: 'RESIZE_STORAGE_KEY_INVALID' },
    );
  }
  return key;
}
