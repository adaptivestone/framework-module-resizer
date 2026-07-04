// LockProvider contract (05 · §10.6) — NO `app` parameter: the shipped driver reaches the
// framework `Lock` model through getApp() (02 · §4), custom ones close over their own
// Redis/redlock (so the module core stays DB-free). This is an INTERFACE, not an abstract
// class: drivers are plain object literals by design. It lives in its own file so a host
// wrapping the default imports it WITHOUT depending on resizer.ts; it is re-exported from
// resizer.ts so every existing import site keeps working unchanged.

export interface LockProvider {
  acquire(key: string, ttlMs: number): Promise<boolean>; // true if acquired
  release(key: string): Promise<void>;
}
