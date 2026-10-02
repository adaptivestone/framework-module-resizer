// Lock store contract: short-lived named locks that stop two requests or workers from doing the
// same variant at once. A driver closes over its own storage and receives no `app`. Extend this
// class (or pass any object of the same shape).

export abstract class LockStore {
  /** Take `key` for `ttlMs` milliseconds. Resolves `true` if taken, `false` if someone holds it. */
  abstract acquire(key: string, ttlMs: number): Promise<boolean>;

  /** Release `key`. Releasing a lock that already expired is not an error. */
  abstract release(key: string): Promise<void>;
}
