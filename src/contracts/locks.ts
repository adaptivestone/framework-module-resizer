// Lock contract: a key-value store whose entries expire after a TTL and carry an owner. The core
// takes one kind of lock: the gate lock of a task queue without gatesByTask, one per Resizer,
// queue, media and pipeline, which keeps a second task from being queued while one is in flight. A
// read takes it with a fresh owner when it queues a task; the worker that runs the task extends
// it, takes it back under the same owner when it lapsed (`acquire`, which yields to any live
// holder), and releases it once the task completes. Locks only prevent duplicate work; correctness
// never depends on them. The owner is what makes `release` a compare-and-delete: a caller whose
// lock expired and was taken over by someone else cannot delete (or extend) the new holder's lock.
// An expired lock is not extended, even for its owner, but its owner can still release it until
// another owner takes it over, unless the store's TTL sweep has already removed it (then `release`
// returns `false`). Keep the owner with the lock, not in process memory: one process may release a
// lock that another took under the same owner. The store closes over its own client and receives
// no `app`. Extend this class (or pass any object of the same shape — the core never checks
// `instanceof`, so duplicate package copies still work).

export abstract class LockStore {
  /**
   * Take `key` for `owner` for `ttlMs`. `true` when the key was free, or its lock had expired and
   * this call took it over (of several callers racing for it, one wins). `false` while an unexpired
   * lock holds the key, even one with the same owner: callers may share an owner and must still
   * exclude each other.
   */
  abstract acquire(key: string, owner: string, ttlMs: number): Promise<boolean>;

  /**
   * Move the expiry of `owner`'s live lock to `ttlMs` from now. `false`: `owner` holds no live lock
   * on `key`.
   */
  abstract extend(key: string, owner: string, ttlMs: number): Promise<boolean>;

  /**
   * Delete the lock only if `owner` holds it, expired or not. `false`: `owner` does not (the lock
   * is gone, or another owner took it over); that is not an error.
   */
  abstract release(key: string, owner: string): Promise<boolean>;

  /** Optional startup check: throw when the store cannot work (e.g. an unknown lock model). */
  verify?(): void | Promise<void>;
}
