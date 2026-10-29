// INTERNAL utility — tells an error's class by name, without `instanceof`. NOT exported from the
// main entry. A duplicate copy of the package has its own classes, which `instanceof` would not
// match; the class names are the same in every copy.

/**
 * True when `err` is named one of `names`, or is a subclass of one (a host's
 * `class HostSetupError extends ResizeSetupError`): its `name`, or a constructor name along its
 * prototype chain. A prototype chain that cannot be read matches nothing.
 */
export function hasErrorClass(
  err: unknown,
  names: ReadonlySet<string>,
): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const { name } = err as { name?: unknown };
  if (typeof name === 'string' && names.has(name)) {
    return true;
  }
  try {
    for (
      let proto: unknown = Object.getPrototypeOf(err);
      proto !== null && proto !== Object.prototype;
      proto = Object.getPrototypeOf(proto)
    ) {
      const ctorName = (proto as { constructor?: { name?: unknown } })
        .constructor?.name;
      if (typeof ctorName === 'string' && names.has(ctorName)) {
        return true;
      }
    }
  } catch {
    // A prototype chain that cannot be read (a hostile proxy): no class matches.
  }
  return false;
}
