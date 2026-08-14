// Local filesystem storage (0.2 adoption) — default story for tests and first-week
// local. Same ResizeStorage contract as S3; no optional peers. SUBPATH-ONLY ENTRY
// (`…/storage/fs.js`), same as the other drivers.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { StorageRef } from '../types.d.ts';
import type { ResizeStorage } from './AbstractStorage.ts';

export interface LocalFsStorageOptions {
  rootDir: string; // files land under this directory
  publicBaseUrl: string; // URL prefix for publicUrl(), e.g. '/media' or 'http://localhost:3000/media'
}

/** Resolve `key` under `rootDir`; throw if it escapes the root (path traversal). */
function resolveInsideRoot(rootDir: string, key: string): string {
  if (!key || key.includes('\0')) {
    throw new Error('resize fs: invalid storage key');
  }
  const root = resolve(rootDir);
  const abs = resolve(root, key);
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `resize fs: key "${key}" escapes rootDir — refusing path traversal`,
    );
  }
  return abs;
}

export class LocalFsStorage implements ResizeStorage {
  private readonly rootDir: string;
  private readonly publicBaseUrl: string;

  constructor(opts: LocalFsStorageOptions) {
    this.rootDir = opts.rootDir;
    this.publicBaseUrl = opts.publicBaseUrl;
  }

  async download(ref: StorageRef): Promise<Buffer> {
    return readFile(resolveInsideRoot(this.rootDir, ref.key));
  }

  async upload({
    key,
    body,
  }: {
    key: string;
    body: Buffer | Uint8Array;
    contentType: string;
    // Accepted to match ResizeStorage; local/dev shares one tree (not a private store).
    visibility: 'public' | 'private';
  }): Promise<StorageRef> {
    const abs = resolveInsideRoot(this.rootDir, key);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, body);
    return { key };
  }

  // PURE string building — no I/O (called on the read path). Option is publicBaseUrl
  // (never `publicUrl`) so it cannot shadow this method name.
  publicUrl(ref: StorageRef): string {
    const base = this.publicBaseUrl.replace(/\/+$/, '');
    const key = ref.key.replace(/^\/+/, '');
    return `${base}/${key}`;
  }
}
