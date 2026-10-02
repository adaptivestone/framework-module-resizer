// FrameworkLockStore: the lock store over the framework's own `Lock` model (no extra collection).
// Framework apps pass it with the Mongo transport; createFrameworkResizer adds it for a transport.

import { LockStore } from '../contracts/lockStore.ts';
import { getApp } from './app.ts';

export class FrameworkLockStore extends LockStore {
  // The framework Lock TTL is SECONDS — the ms→s conversion lives HERE and nowhere else
  // (call sites pass ms, e.g. the transport's lockTtlMs.dispatch). Round UP so a sub-second
  // ttl never truncates to a 0-second (immediately-expired) lock.
  async acquire(key: string, ttlMs: number): Promise<boolean> {
    const acquired = await getApp()
      .getModel('Lock')
      .acquireLock(key, Math.ceil(ttlMs / 1000));
    return Boolean(acquired);
  }

  async release(key: string): Promise<void> {
    await getApp().getModel('Lock').releaseLock(key);
  }
}
