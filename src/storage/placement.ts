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
