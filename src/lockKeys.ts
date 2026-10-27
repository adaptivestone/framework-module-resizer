// Lock keys and owners. A dispatch lock is held per preview identity of a media while that variant
// is queued, so concurrent reads queue it once; the worker also holds it for a cooldown after the
// variant's task is dead-lettered. A worker lock is held while one worker renders the variant.

/**
 * The owner of every dispatch lock. The worker releases dispatch locks that a read took, possibly
 * in another process: when it skips a preview that is already stored, once it has rendered, and for
 * the dead-letter cooldown (release, then acquire for `lockTtlMs.failed`). An owner chosen by each
 * read would make those calls fail: the read's lock would stay until its TTL, and the cooldown
 * would shrink to the dispatch TTL even for errors that dead-letter at once. So all dispatch locks
 * share this owner, and only worker locks get a fresh random owner per acquire.
 */
export const DISPATCH_LOCK_OWNER = 'resize:dispatch';

/** The dispatch lock of one preview identity of a media: while held, reads do not queue it. */
export function dispatchLockKey(mediaId: string, identity: string): string {
  return `resize_dispatch:${mediaId}:${identity}`;
}

/** The worker lock of one preview identity of a media: one worker renders it at a time. */
export function workerLockKey(mediaId: string, identity: string): string {
  return `resize_worker:${mediaId}:${identity}`;
}
