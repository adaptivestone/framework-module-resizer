// Local filesystem storage (0.2 adoption) — default story for tests and first-week
// local. Same ResizeStorage contract as S3; no optional peers. SUBPATH-ONLY ENTRY
// (`…/storage/fs.js`), same as the other drivers.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { ResizeSecurityError } from '../errors.ts';
import type { StorageRef } from '../types.d.ts';
import type { ResizeStorage } from './AbstractStorage.ts';

export interface LocalFsStorageOptions {
  rootDir: string; // public previews land under this directory
  privateRootDir?: string; // private originals; defaults to a sibling of rootDir
  publicBaseUrl: string; // URL prefix for publicUrl(), e.g. '/media' or 'http://localhost:3000/media'
}

/** Resolve `key` under `rootDir`; throw if it escapes the root (path traversal). */
function resolveInsideRoot(rootDir: string, key: string): string {
  if (!key || key.includes('\0')) {
    throw new ResizeSecurityError('resize fs: invalid storage key', {
      code: 'RESIZE_FS_KEY_INVALID',
    });
  }
  const root = resolve(rootDir);
  const abs = resolve(root, key);
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new ResizeSecurityError(
      `resize fs: key "${key}" escapes rootDir — refusing path traversal`,
      { code: 'RESIZE_FS_PATH_TRAVERSAL' },
    );
  }
  return abs;
}

/** URL refs may carry a leading slash; treat it as a URL separator, not an absolute FS path. */
function normalizePublicKey(key: string): string {
  return key.replace(/^\/+/, '');
}

export class LocalFsStorage implements ResizeStorage {
  readonly #rootDir: string;
  readonly #privateRootDir: string;
  readonly #publicBaseUrl: string;

  constructor(opts: LocalFsStorageOptions) {
    this.#rootDir = opts.rootDir;
    this.#privateRootDir = opts.privateRootDir ?? `${opts.rootDir}-private`;
    this.#publicBaseUrl = opts.publicBaseUrl;
  }

  async download(ref: StorageRef): Promise<Buffer> {
    return readFile(
      resolveInsideRoot(
        ref.bucket === 'local-private' ? this.#privateRootDir : this.#rootDir,
        ref.key,
      ),
    );
  }

  async upload({
    key,
    body,
    visibility,
  }: {
    key: string;
    body: Buffer | Uint8Array;
    contentType: string;
    visibility: 'public' | 'private';
  }): Promise<StorageRef> {
    const isPrivate = visibility === 'private';
    const abs = resolveInsideRoot(
      isPrivate ? this.#privateRootDir : this.#rootDir,
      key,
    );
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, body);
    return isPrivate ? { key, bucket: 'local-private' } : { key };
  }

  // PURE string building — no I/O (called on the read path). Option is publicBaseUrl
  // (never `publicUrl`) so it cannot shadow this method name.
  publicUrl(ref: StorageRef): string {
    // Keep the same path-traversal validation for this pure URL builder as for I/O. Local
    // A private locator must never be converted into a public URL.
    if (ref.bucket === 'local-private') {
      throw new ResizeSecurityError(
        'resize fs: refusing public URL for private original',
        {
          code: 'RESIZE_FS_PRIVATE_URL',
        },
      );
    }
    resolveInsideRoot(this.#rootDir, normalizePublicKey(ref.key));
    const base = this.#publicBaseUrl.replace(/\/+$/, '');
    const key = normalizePublicKey(ref.key);
    return `${base}/${key}`;
  }

  canServeOriginalPublicly(ref: StorageRef): boolean {
    resolveInsideRoot(this.#rootDir, normalizePublicKey(ref.key));
    return ref.bucket !== 'local-private';
  }
}
