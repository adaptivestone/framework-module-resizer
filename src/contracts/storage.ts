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
  parentRef?: StorageRef; // the original's ref when the worker stores one of its previews
}

export abstract class ResizeStorage {
  /** Download an existing object by its stored locator (the worker reads originals). */
  abstract download(ref: StorageRef): Promise<Buffer | Uint8Array>;

  /** Upload a new object and return the JSON-compatible locator to persist. */
  abstract upload(args: StorageUploadArgs): Promise<StorageRef>;

  /** Public URL of an object. Pure and synchronous: the read path calls it, so no I/O. */
  abstract publicUrl(ref: StorageRef): string;

  /**
   * Optional, pure: whether an original may be served to anonymous readers. Without it every
   * original is treated as private.
   */
  canServeOriginalPublicly?(ref: StorageRef): boolean;

  /** Optional: a time-limited URL for an owner/admin read of a private original. */
  signedUrl?(ref: StorageRef, ttlSeconds: number): Promise<string>;
}
