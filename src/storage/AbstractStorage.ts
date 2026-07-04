// Storage contract (05 · §10.4) — NO `app` parameter anywhere; shipped drivers reach the
// framework through getApp(), custom ones close over their own. This is an INTERFACE, not an
// abstract class: drivers are plain object literals by design (05 · §10.5). It lives in its own
// file so the optional-peer S3 driver can import it WITHOUT depending on resizer.ts (the driver
// is a subpath-only entry — 05 · §10.5); it is re-exported from resizer.ts so every existing
// import site keeps working unchanged.
import type { StorageRef } from '../types.d.ts';

export interface ResizeStorage {
  // Download an existing object by its stored locator (the worker's original).
  download(ref: StorageRef): Promise<Buffer | Uint8Array>;
  // Upload a NEW object; the DRIVER picks physical placement + returns the locator to persist.
  upload(args: {
    key: string;
    body: Buffer | Uint8Array;
    contentType: string;
    visibility: 'public' | 'private';
  }): Promise<StorageRef>;
  // PURE, synchronous, NO I/O — the read path calls this to build public URLs (05 · §10.4).
  publicUrl(ref: StorageRef): string;
  // Optional: a time-limited signed URL for owner/admin reads of a private original.
  signedUrl?(ref: StorageRef, ttlSeconds: number): Promise<string>;
}
