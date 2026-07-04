// FrameworkLockProvider — the framework-backed DEFAULT lock provider (05 · §10.6). A DEFAULTED
// strategy: active out of the box (the core constructs it internally for the ResizerOptions
// default), swappable via the `lockProvider` constructor option for Redis/redlock. Used for
// enqueue dispatch locks + worker locks (keys stay module-owned + identity-derived — 03 ·
// Identity). Subpath entry `…/locks/framework.js`: a host wrapping this default imports it from
// there (uniform rule 02 · §6); no optional deps, so importing is always safe. No `app`
// parameter: reads the framework `Lock` model through getApp() (02 · §4).
import { getApp } from '../app.ts';
import type { LockProvider } from './AbstractLockProvider.ts';

export class FrameworkLockProvider implements LockProvider {
  // The framework Lock TTL is SECONDS — the ms→s conversion lives HERE and nowhere else
  // (call sites pass ms, e.g. config.queue.lockTtlMs.dispatch). Round UP so a sub-second
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
