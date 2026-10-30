// Local filesystem driver. Each persisted ref identifies both a relative path and its root.
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { DriverContext } from '../contracts/drivers.ts';
import { ResizeStorage } from '../contracts/storage.ts';
import { ResizeSecurityError } from '../errors.ts';
import { optionalString, requiredString } from '../helpers/configSection.ts';
import type { LocalStorageConfig, StorageRef } from '../types.d.ts';
import { validateLogicalKey, validateNamespace } from './placement.ts';

export interface LocalFsStorageOptions {
  rootDir: string;
  privateRootDir?: string;
  publicBaseUrl: string;
}

interface LocalFsStorageRef {
  path: string;
  visibility: 'public' | 'private';
  namespace?: string;
}

function resolveInsideRoot(rootDir: string, path: string): string {
  const root = resolve(rootDir);
  const abs = resolve(root, path);
  const rel = relative(root, abs);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ResizeSecurityError('resize fs: path escapes rootDir', {
      code: 'RESIZE_FS_PATH_TRAVERSAL',
    });
  }
  return abs;
}

/** Check the actual target after symlinks are resolved, not just its lexical path. */
async function assertRealPathInsideRoot(
  rootDir: string,
  path: string,
): Promise<void> {
  const root = await realpath(rootDir);
  const target = await realpath(path);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ResizeSecurityError('resize fs: resolved path escapes rootDir', {
      code: 'RESIZE_FS_PATH_TRAVERSAL',
    });
  }
}

export class LocalFsStorage extends ResizeStorage {
  readonly #rootDir: string;
  readonly #privateRootDir: string;
  readonly #publicBaseUrl: string;

  constructor(opts: LocalFsStorageOptions) {
    super();
    this.#rootDir = resolve(opts.rootDir);
    this.#privateRootDir = resolve(
      opts.privateRootDir ?? `${this.#rootDir}-private`,
    );
    const privateRelativePath = relative(this.#rootDir, this.#privateRootDir);
    if (
      !privateRelativePath ||
      (privateRelativePath !== '..' &&
        !privateRelativePath.startsWith(`..${sep}`) &&
        !isAbsolute(privateRelativePath))
    ) {
      throw new ResizeSecurityError(
        'resize fs: privateRootDir must be outside the public rootDir',
        { code: 'RESIZE_FS_PRIVATE_ROOT_PUBLIC' },
      );
    }
    this.#publicBaseUrl = opts.publicBaseUrl;
  }

  /**
   * The storage of a config's `storage` section (driver 'local'). Only this driver's keys are read:
   * an environment file that switched the driver leaves the other driver's keys (e.g. bucketPublic)
   * in the merged section. A missing or mistyped key is RESIZE_CONFIG_INVALID naming `ctx.where`.
   */
  static fromConfig(
    section: LocalStorageConfig,
    ctx: DriverContext,
  ): LocalFsStorage {
    const { where } = ctx;
    const rootDir = requiredString(section.rootDir, 'storage.rootDir', where);
    const publicBaseUrl = requiredString(
      section.publicBaseUrl,
      'storage.publicBaseUrl',
      where,
    );
    const privateRootDir = optionalString(
      section.privateRootDir,
      'storage.privateRootDir',
      where,
    );
    return new LocalFsStorage({
      rootDir,
      publicBaseUrl,
      ...(privateRootDir === undefined ? {} : { privateRootDir }),
    });
  }

  #ref(value: StorageRef): LocalFsStorageRef {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ResizeSecurityError('resize fs: invalid storage ref', {
        code: 'RESIZE_FS_REF_INVALID',
      });
    }
    const ref = value as Record<string, unknown>;
    if (
      typeof ref.path !== 'string' ||
      (ref.visibility !== 'public' && ref.visibility !== 'private')
    ) {
      throw new ResizeSecurityError('resize fs: invalid storage ref', {
        code: 'RESIZE_FS_REF_INVALID',
      });
    }
    validateLogicalKey(ref.path);
    const namespace = validateNamespace(ref.namespace);
    if (namespace && !ref.path.startsWith(`${namespace}/`)) {
      throw new ResizeSecurityError(
        'resize fs: namespace does not match path',
        {
          code: 'RESIZE_FS_REF_INVALID',
        },
      );
    }
    resolveInsideRoot(
      ref.visibility === 'private' ? this.#privateRootDir : this.#rootDir,
      ref.path,
    );
    return ref as unknown as LocalFsStorageRef;
  }

  async download(ref: StorageRef): Promise<Buffer> {
    const parsed = this.#ref(ref);
    const root =
      parsed.visibility === 'private' ? this.#privateRootDir : this.#rootDir;
    const abs = resolveInsideRoot(root, parsed.path);
    await assertRealPathInsideRoot(root, abs);
    return readFile(abs);
  }

  async upload({
    key,
    body,
    visibility,
    namespace,
    parentRef,
  }: {
    key: string;
    body: Buffer | Uint8Array;
    contentType: string;
    visibility: 'public' | 'private';
    namespace?: string;
    parentRef?: StorageRef;
  }): Promise<StorageRef> {
    if (parentRef !== undefined && namespace !== undefined) {
      throw new ResizeSecurityError(
        'resize fs: namespace and parentRef conflict',
        { code: 'RESIZE_FS_HINT_CONFLICT' },
      );
    }
    if (parentRef === null) {
      throw new ResizeSecurityError('resize fs: invalid parentRef', {
        code: 'RESIZE_FS_REF_INVALID',
      });
    }
    const grouping = validateNamespace(
      parentRef === undefined ? namespace : this.#ref(parentRef).namespace,
    );
    if (visibility !== 'public' && visibility !== 'private') {
      throw new ResizeSecurityError('resize fs: invalid visibility', {
        code: 'RESIZE_FS_VISIBILITY_INVALID',
      });
    }
    const path = grouping
      ? `${grouping}/${validateLogicalKey(key)}`
      : validateLogicalKey(key);
    const root =
      visibility === 'private' ? this.#privateRootDir : this.#rootDir;
    const abs = resolveInsideRoot(root, path);
    await mkdir(root, { recursive: true });
    let parent = resolve(root);
    for (const segment of path.split('/').slice(0, -1)) {
      parent = resolve(parent, segment);
      try {
        await mkdir(parent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
      await assertRealPathInsideRoot(root, parent);
    }
    // Exclusive creation refuses an existing symlink leaf (and accidental collisions).
    await writeFile(abs, body, { flag: 'wx' });
    return {
      path,
      visibility,
      ...(grouping === undefined ? {} : { namespace: grouping }),
    };
  }

  publicUrl(ref: StorageRef): string {
    const parsed = this.#ref(ref);
    if (parsed.visibility !== 'public') {
      throw new ResizeSecurityError(
        'resize fs: refusing public URL for private original',
        {
          code: 'RESIZE_FS_PRIVATE_URL',
        },
      );
    }
    return `${this.#publicBaseUrl.replace(/\/+$/, '')}/${parsed.path}`;
  }
}
