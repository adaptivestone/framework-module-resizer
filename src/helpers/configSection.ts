// The values a driver reads from its config section. A config is written by hand (and merged
// across environment files), so a driver checks each value it uses before it builds anything, and
// names the key and the config in the error.
import { ResizeConfigError } from '../errors.ts';

/** The ResizeConfigError for the key `path` of the config `where`, which must be `what`. */
export function invalidConfigValue(
  path: string,
  where: string,
  what: string,
): ResizeConfigError {
  return new ResizeConfigError(
    `resize config: \`${path}\` in ${where} must be ${what}`,
    { code: 'RESIZE_CONFIG_INVALID' },
  );
}

/** `value` (the key `path` of the config `where`), which must be a non-empty string. */
export function requiredString(
  value: unknown,
  path: string,
  where: string,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidConfigValue(path, where, 'a non-empty string');
  }
  return value;
}

/** Like requiredString, but `undefined` (a key left out) is allowed and comes back as it is. */
export function optionalString(
  value: unknown,
  path: string,
  where: string,
): string | undefined {
  return value === undefined ? undefined : requiredString(value, path, where);
}

/** `value` (the key `path` of the config `where`): a boolean, or `undefined` when left out. */
export function optionalBoolean(
  value: unknown,
  path: string,
  where: string,
): boolean | undefined {
  if (value !== undefined && typeof value !== 'boolean') {
    throw invalidConfigValue(path, where, 'a boolean');
  }
  return value;
}
