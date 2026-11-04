// Storage contract. A driver stores originals and previews and builds their URLs; it closes over
// its own client and receives no `app`. Extend this class (or pass any object of the same shape —
// the core never checks `instanceof`, so duplicate package copies still work).
import type { StorageRef } from '../types.d.ts';

export interface StorageUploadArgs {
  key: string; // suggested object key; a driver may return a different locator
  body: Buffer | Uint8Array;
  contentType: string;
  visibility: 'public' | 'private';
  namespace?: string; // placement hint from uploadOriginal({ namespace })
  // The original's ref when the worker stores one of its previews. An adopted original's ref was
  // not written by this driver, so a driver must tolerate that.
  parentRef?: StorageRef;
}

export interface StorageDownloadOptions {
  /** The largest object the caller will read. A driver refuses a larger one before reading it, when it can. */
  maxBytes?: number;
}

export abstract class ResizeStorage {
  /**
   * Download an existing object by its stored locator (the worker reads originals). A missing
   * object rejects with a retryable ResizeStorageError with the code RESIZE_STORAGE_NOT_FOUND. An
   * object over `maxBytes` rejects with a ResizeMediaError with the code RESIZE_SOURCE_TOO_LARGE
   * and `retryable: false`, without the key in its message: a key may hold a client's file name,
   * and this line reaches logs. A driver that ignores `maxBytes` still works: the core checks the
   * length afterwards, but the memory is already spent. Anything other than bytes is
   * RESIZE_STORAGE_DOWNLOAD_INVALID. `adoptOriginal` passes refs a host built: refuse one outside
   * this driver's scope with a ResizeError, which reaches the host unchanged. A `maxBytes` here may
   * be lower than `limits.sourceBytes`: `adoptOriginal` passes a call's own cap.
   */
  abstract download(
    ref: StorageRef,
    opts?: StorageDownloadOptions,
  ): Promise<Buffer | Uint8Array>;

  /**
   * Upload a new object and return the JSON-compatible locator to persist. It must stay the same on
   * every load, for ever: its JSON form is signed into every preview's origin, so one that changes
   * reads as a replaced original.
   */
  abstract upload(args: StorageUploadArgs): Promise<StorageRef>;

  /**
   * Public URL of an object. Pure and synchronous: the read path calls it for stored previews,
   * so no I/O. It must refuse a ref it would not expose (e.g. a private original): `adoptOriginal`
   * relies on that to tell a public object from a private one.
   */
  abstract publicUrl(ref: StorageRef): string;

  /**
   * Optional: a time-limited URL for a private object. The module never calls it; a host calls it
   * itself, e.g. to hand a private original to its owner.
   */
  signedUrl?(ref: StorageRef, ttlSeconds: number): Promise<string>;
}
