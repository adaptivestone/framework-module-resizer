// A config's image settings over the package defaults, so a config sets only what it changes.
// Plain objects merge key by key; arrays replace; `encode.formats` replaces as a whole (it lists
// the formats a host encodes, so a default jpeg must not come back into a webp-only list); a key
// set to undefined takes the default. Keys the defaults do not have pass through, so validation
// still reports removed and unknown keys, and a value of the wrong type is kept for it to report.
import defaultResizeConfig from '../config/resize.ts';

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

// Replaced as a whole, never merged.
const WHOLE = new Set(['encode.formats']);

/**
 * `value` over `base` at `path`. A host object in which no key needs a default comes back as that
 * same object (the Resizer keeps and compares the host's own objects); an object is copied only
 * when a key is filled in. A default is a deep copy, so the result never shares an object with the
 * package defaults.
 */
function over(value: unknown, base: unknown, path: string): unknown {
  if (value === undefined) {
    return structuredClone(base);
  }
  if (WHOLE.has(path) || !isPlainObject(value) || !isPlainObject(base)) {
    return value;
  }
  let copy: Record<string, unknown> | undefined;
  for (const key of Object.keys(base)) {
    const own = value[key];
    const merged = over(own, base[key], path === '' ? key : `${path}.${key}`);
    if (merged !== own) {
      copy ??= { ...value };
      copy[key] = merged;
    }
  }
  return copy ?? value;
}

/**
 * The image settings `partial` over the package defaults. A value that is not a plain object is
 * returned as it is; the Resizer validates the result.
 */
export function mergeImageConfig(partial: unknown): unknown {
  return isPlainObject(partial)
    ? over(partial, defaultResizeConfig, '')
    : partial;
}
