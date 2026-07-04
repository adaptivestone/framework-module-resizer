// LockProvider seam + the framework-backed default (05 · §10.6). A DEFAULTED strategy:
// active out of the box (registry pre-fills the slot), swappable for Redis/redlock via
// registerLockProvider. Used for enqueue dispatch locks + worker locks (keys stay
// module-owned + identity-derived — 03 · Identity). No `app` parameter: reads the
// framework `Lock` model through getApp() (02 · §4).
import { getApp } from './app.ts';

export interface LockProvider {
  acquire(key: string, ttlMs: number): Promise<boolean>; // true if acquired
  release(key: string): Promise<void>;
}

export const frameworkLockProvider: LockProvider = {
  // The framework Lock TTL is SECONDS — the ms→s conversion lives HERE and nowhere else
  // (call sites pass ms, e.g. config.queue.lockTtlMs.dispatch). Round UP so a sub-second
  // ttl never truncates to a 0-second (immediately-expired) lock.
  async acquire(key, ttlMs) {
    const acquired = await getApp()
      .getModel('Lock')
      .acquireLock(key, Math.ceil(ttlMs / 1000));
    return Boolean(acquired);
  },
  async release(key) {
    await getApp().getModel('Lock').releaseLock(key);
  },
};
