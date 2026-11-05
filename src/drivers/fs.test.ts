import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, test } from 'node:test';
import {
  ResizeConfigError,
  ResizeMediaError,
  ResizeSecurityError,
  ResizeStorageError,
} from '../errors.ts';
import { silentLogger } from '../testHelpers/fakes.ts';
import type { LocalStorageConfig } from '../types.d.ts';
import { LocalFsStorage } from './fs.ts';

const fresh = () => mkdtemp(join(tmpdir(), 'resize-fs-'));
const uploadArgs = (key: string, visibility: 'public' | 'private') => ({
  key,
  visibility,
  body: Buffer.from(key),
  contentType: 'image/jpeg',
});

describe('LocalFsStorage', () => {
  test('download over maxBytes rejects from stat without reading the file', async (t) => {
    const dir = await fresh();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const s = new LocalFsStorage({ rootDir: dir, publicBaseUrl: '/media' });
    const abs = join(dir, 'huge.jpg');
    await writeFile(abs, '');
    // Sparse and over 2 GiB: readFile would reject with ERR_FS_FILE_TOO_LARGE, so the code proves stat refused it.
    await truncate(abs, 3 * 1024 ** 3);
    await assert.rejects(
      s.download(
        { path: 'huge.jpg', visibility: 'public' },
        { maxBytes: 1024 },
      ),
      (err: unknown) => {
        assert.ok(err instanceof ResizeMediaError);
        assert.equal(err.code, 'RESIZE_SOURCE_TOO_LARGE');
        assert.equal(err.retryable, false);
        assert.match(err.message, /limits\.sourceBytes/);
        assert.doesNotMatch(err.message, /huge\.jpg/);
        return true;
      },
    );
  });

  test('download at exactly maxBytes returns the bytes', async (t) => {
    const dir = await fresh();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const s = new LocalFsStorage({ rootDir: dir, publicBaseUrl: '/media' });
    const bytes = Buffer.from('0123456789');
    await writeFile(join(dir, 'ten.jpg'), bytes);
    assert.deepEqual(
      await s.download(
        { path: 'ten.jpg', visibility: 'public' },
        { maxBytes: 10 },
      ),
      bytes,
    );
  });

  test('a missing object with maxBytes is still RESIZE_STORAGE_NOT_FOUND', async (t) => {
    const dir = await fresh();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const s = new LocalFsStorage({ rootDir: dir, publicBaseUrl: '/media' });
    await assert.rejects(
      s.download({ path: 'gone.jpg', visibility: 'public' }, { maxBytes: 1 }),
      { code: 'RESIZE_STORAGE_NOT_FOUND' },
    );
  });

  test('a symlink out of the root is refused before its size is read', async (t) => {
    const dir = await fresh();
    const outside = await fresh();
    t.after(async () => {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    });
    await writeFile(join(outside, 'file'), 'larger than one byte');
    await symlink(join(outside, 'file'), join(dir, 'link'));
    const s = new LocalFsStorage({ rootDir: dir, publicBaseUrl: '/media' });
    await assert.rejects(
      s.download({ path: 'link', visibility: 'public' }, { maxBytes: 1 }),
      { code: 'RESIZE_FS_PATH_TRAVERSAL' },
    );
  });

  test('LocalFsStorage: a missing object is RESIZE_STORAGE_NOT_FOUND, retryable, with its cause', async (t) => {
    const dir = await fresh();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const s = new LocalFsStorage({ rootDir: dir, publicBaseUrl: '/media' });
    await writeFile(join(dir, 'file'), 'x');
    for (const [path, cause] of [
      ['gone.jpg', 'ENOENT'],
      ['gone/a.jpg', 'ENOENT'],
      ['file/a.jpg', 'ENOTDIR'], // a parent that is a file
    ]) {
      await assert.rejects(
        () => s.download({ path, visibility: 'public' }),
        (err: unknown) => {
          assert.ok(err instanceof ResizeStorageError, path);
          assert.equal(err.code, 'RESIZE_STORAGE_NOT_FOUND', path);
          assert.equal(err.retryable, true, path);
          assert.equal(
            err.message,
            `resize fs: object not found: ${path}`,
            path,
          );
          assert.equal((err.cause as { code?: string }).code, cause, path);
          return true;
        },
      );
    }
  });

  test('LocalFsStorage: a traversal stays a refusal, and other read failures stay as they are', async (t) => {
    const dir = await fresh();
    const outside = await fresh();
    t.after(async () => {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    });
    await writeFile(join(outside, 'file'), 'x');
    await symlink(join(outside, 'file'), join(dir, 'link'));
    const s = new LocalFsStorage({ rootDir: dir, publicBaseUrl: '/media' });
    await assert.rejects(
      () => s.download({ path: 'link', visibility: 'public' }),
      (err: unknown) =>
        err instanceof ResizeSecurityError &&
        err.code === 'RESIZE_FS_PATH_TRAVERSAL' &&
        err.retryable === false,
    );
    // A folder where a file should be: the disk answered, and it is not a missing object.
    await mkdir(join(dir, 'folder'));
    await assert.rejects(
      () => s.download({ path: 'folder', visibility: 'public' }),
      { code: 'EISDIR' },
    );
  });

  test('a trailing slash keeps private originals outside the public root', async (t) => {
    const dir = await fresh();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const publicRoot = join(dir, 'media');
    for (const suffix of new Set(['/', sep])) {
      const key = `originals/a-${suffix === '/' ? 'slash' : 'separator'}.svg`;
      const s = new LocalFsStorage({
        rootDir: `${publicRoot}${suffix}`,
        publicBaseUrl: '/media',
      });
      const ref = await s.upload({
        ...uploadArgs(key, 'private'),
        body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        contentType: 'image/svg+xml',
      });
      assert.deepEqual(
        await readFile(join(`${publicRoot}-private`, key)),
        await s.download(ref),
      );
      await assert.rejects(() => readFile(join(publicRoot, '-private', key)), {
        code: 'ENOENT',
      });
      assert.throws(() => s.publicUrl(ref), /private original/);
    }
  });

  test('rejects a private root equal to or inside the normalized public root', async (t) => {
    const dir = await fresh();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const publicRoot = join(dir, 'media');
    for (const privateRootDir of [
      publicRoot,
      `${publicRoot}${sep}`,
      join(publicRoot, 'private'),
      join(publicRoot, 'nested', 'private'),
      join(dir, 'other', '..', 'media', 'private'),
    ]) {
      assert.throws(
        () =>
          new LocalFsStorage({
            rootDir: `${publicRoot}${sep}`,
            privateRootDir,
            publicBaseUrl: '/media',
          }),
        (err) =>
          err instanceof ResizeSecurityError &&
          err.code === 'RESIZE_FS_PRIVATE_ROOT_PUBLIC',
      );
    }
  });

  test('allows an explicit sibling private root sharing the public name prefix', async (t) => {
    const dir = await fresh();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const privateRootDir = join(dir, 'media-private');
    const s = new LocalFsStorage({
      rootDir: join(dir, 'media'),
      privateRootDir,
      publicBaseUrl: '/media',
    });
    const ref = await s.upload(uploadArgs('originals/a.jpg', 'private'));
    assert.deepEqual(
      await readFile(join(privateRootDir, 'originals/a.jpg')),
      await s.download(ref),
    );
  });

  test('private and public refs round-trip under separate roots', async () => {
    const dir = await fresh();
    const s = new LocalFsStorage({ rootDir: dir, publicBaseUrl: '/media' });
    const privateRef = await s.upload(uploadArgs('originals/a.jpg', 'private'));
    const publicRef = await s.upload(uploadArgs('originals/a.jpg', 'public'));
    assert.deepEqual(privateRef, {
      path: 'originals/a.jpg',
      visibility: 'private',
    });
    assert.deepEqual(publicRef, {
      path: 'originals/a.jpg',
      visibility: 'public',
    });
    assert.deepEqual(
      await s.download(privateRef),
      Buffer.from('originals/a.jpg'),
    );
    assert.deepEqual(
      await readFile(join(`${dir}-private`, 'originals/a.jpg')),
      Buffer.from('originals/a.jpg'),
    );
    // Visibility is enforced where a URL is made; the driver has no separate visibility check.
    assert.equal('canServeOriginalPublicly' in s, false);
    assert.throws(() => s.publicUrl(privateRef), /private original/);
    assert.equal(s.publicUrl(publicRef), '/media/originals/a.jpg');
  });

  test('fresh driver inherits namespace from a private parent for a public preview', async () => {
    const dir = await fresh();
    const options = { rootDir: dir, publicBaseUrl: '/media' };
    const parent = await new LocalFsStorage(options).upload({
      ...uploadArgs('originals/a.jpg', 'private'),
      namespace: 'products/originals/x',
    });
    const s = new LocalFsStorage(options);
    const preview = await s.upload({
      ...uploadArgs('previews/b.jpg', 'public'),
      parentRef: JSON.parse(JSON.stringify(parent)),
    });
    assert.deepEqual(preview, {
      path: 'products/originals/x/previews/b.jpg',
      visibility: 'public',
      namespace: 'products/originals/x',
    });
    assert.equal(
      s.publicUrl(preview),
      '/media/products/originals/x/previews/b.jpg',
    );
  });

  test('rejects ambiguous or unsafe placement before writing', async () => {
    const dir = await fresh();
    const s = new LocalFsStorage({ rootDir: dir, publicBaseUrl: '/media' });
    await assert.rejects(
      () =>
        s.upload({ ...uploadArgs('a.jpg', 'public'), namespace: '../escape' }),
      /invalid namespace/,
    );
    await assert.rejects(
      () =>
        s.upload({
          ...uploadArgs('a.jpg', 'public'),
          namespace: 'x',
          parentRef: { path: 'a.jpg', visibility: 'private' },
        }),
      /conflict/,
    );
    await assert.rejects(
      () => s.upload({ ...uploadArgs('a.jpg', 'public'), parentRef: null }),
      /invalid parentRef/,
    );
    await assert.rejects(
      () => s.upload(uploadArgs('../outside.jpg', 'public')),
      /invalid logical key/,
    );
  });

  test('the local driver stays strict: a path with a space is refused', async (t) => {
    const dir = await fresh();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const s = new LocalFsStorage({ rootDir: dir, publicBaseUrl: '/media' });
    await assert.rejects(
      s.download({ path: 'my cat.jpg', visibility: 'private' }),
      { code: 'RESIZE_STORAGE_KEY_INVALID' },
    );
  });

  test('rejects malformed refs, including a private ref in publicUrl', async () => {
    const s = new LocalFsStorage({
      rootDir: await fresh(),
      publicBaseUrl: '/media',
    });
    for (const ref of [
      null,
      { path: 'a.jpg' },
      { path: 'a.jpg', visibility: 'other' },
      { path: '../x', visibility: 'public' },
      { path: 'a.jpg', visibility: 'public', namespace: '..' },
      {
        path: 'users/a/originals/x.jpg',
        visibility: 'public',
        namespace: 'users/b',
      },
    ]) {
      await assert.rejects(() => s.download(ref));
      assert.throws(() => s.publicUrl(ref));
    }
  });

  test('does not follow a symlink out of the public root for reads or writes', async () => {
    const dir = await fresh();
    const outside = await fresh();
    await writeFile(join(outside, 'secret.jpg'), Buffer.from('secret'));
    await symlink(
      outside,
      join(dir, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const s = new LocalFsStorage({ rootDir: dir, publicBaseUrl: '/media' });
    await assert.rejects(
      () => s.upload(uploadArgs('escape/new/deep.jpg', 'public')),
      /resolved path escapes rootDir/,
    );
    await assert.rejects(
      () => s.download({ path: 'escape/secret.jpg', visibility: 'public' }),
      /resolved path escapes rootDir/,
    );
  });

  test('rejects URL-reserved characters in a suggested name', async () => {
    const s = new LocalFsStorage({
      rootDir: await fresh(),
      publicBaseUrl: '/media',
    });
    await assert.rejects(
      () => s.upload(uploadArgs('previews/a?b.jpg', 'public')),
      /invalid logical key/,
    );
    assert.throws(
      () => s.publicUrl({ path: 'previews/a#b.jpg', visibility: 'public' }),
      /invalid logical key/,
    );
  });
});

describe('LocalFsStorage.fromConfig', () => {
  const ctx = { logger: silentLogger, where: 'src/config/resize.ts' };

  test("builds from its own keys and ignores another driver's", async (t) => {
    const dir = await fresh();
    t.after(() => rm(dir, { recursive: true, force: true }));
    // An environment file that switched drivers leaves the other driver's keys in the merged
    // section; they never reach the constructor.
    const section = {
      driver: 'local',
      rootDir: join(dir, 'media'),
      publicBaseUrl: '/media',
      privateRootDir: undefined,
      bucketPublic: 'x',
    } as LocalStorageConfig;
    const s = LocalFsStorage.fromConfig(section, ctx);
    assert.ok(s instanceof LocalFsStorage);
    const ref = await s.upload(uploadArgs('previews/a.jpg', 'public'));
    assert.equal(s.publicUrl(ref), '/media/previews/a.jpg');
    const original = await s.upload(uploadArgs('originals/a.jpg', 'private'));
    assert.deepEqual(
      await readFile(join(dir, 'media-private', 'originals/a.jpg')),
      await s.download(original),
    );
    const own = LocalFsStorage.fromConfig(
      {
        driver: 'local',
        rootDir: join(dir, 'media'),
        publicBaseUrl: '/media',
        privateRootDir: join(dir, 'vault'),
      },
      ctx,
    );
    await own.upload(uploadArgs('originals/b.jpg', 'private'));
    assert.ok(await readFile(join(dir, 'vault', 'originals/b.jpg')));
  });

  test('rejects a missing rootDir with RESIZE_CONFIG_INVALID naming where', () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ publicBaseUrl: '/media' }, '`storage.rootDir`', 'a non-empty string'],
      [
        { rootDir: 7, publicBaseUrl: '/media' },
        '`storage.rootDir`',
        'a non-empty string',
      ],
      [{ rootDir: '/srv/media' }, '`storage.publicBaseUrl`', 'a string'],
      [
        { rootDir: '/srv/media', publicBaseUrl: '/media', privateRootDir: 1 },
        '`storage.privateRootDir`',
        'a non-empty string',
      ],
      // In a config, null stays refused, as on 0.3.0; only the constructor takes it as left out.
      [
        {
          rootDir: '/srv/media',
          publicBaseUrl: '/media',
          privateRootDir: null,
        },
        '`storage.privateRootDir`',
        'a non-empty string',
      ],
    ];
    for (const [keys, key, kind] of cases) {
      assert.throws(
        () =>
          LocalFsStorage.fromConfig(
            { driver: 'local', ...keys } as unknown as LocalStorageConfig,
            ctx,
          ),
        (err: unknown) =>
          err instanceof ResizeConfigError &&
          err.code === 'RESIZE_CONFIG_INVALID' &&
          err.message ===
            `resize config: ${key} in src/config/resize.ts must be ${kind}`,
      );
    }
  });

  test('an empty rootDir or privateRootDir is refused, from a config and from the constructor', () => {
    const invalid = { code: 'RESIZE_CONFIG_INVALID' };
    assert.throws(
      () =>
        LocalFsStorage.fromConfig(
          { driver: 'local', rootDir: '', publicBaseUrl: '/m' },
          ctx,
        ),
      {
        ...invalid,
        message:
          /`storage\.rootDir` in src\/config\/resize\.ts must be a non-empty string/,
      },
    );
    assert.throws(
      () =>
        LocalFsStorage.fromConfig(
          {
            driver: 'local',
            rootDir: 'a',
            privateRootDir: '',
            publicBaseUrl: '/m',
          },
          ctx,
        ),
      { ...invalid, message: /`storage\.privateRootDir`/ },
    );
    assert.throws(
      () => new LocalFsStorage({ rootDir: '', publicBaseUrl: '/m' }),
      { ...invalid, message: /rootDir must be a non-empty string/ },
    );
    assert.throws(
      () =>
        new LocalFsStorage({
          rootDir: 'a',
          privateRootDir: '',
          publicBaseUrl: '/m',
        }),
      { ...invalid, message: /privateRootDir must be a non-empty string/ },
    );
  });

  for (const blank of [' ', '\t', ' \n ']) {
    test(`a whitespace-only root ${JSON.stringify(blank)} is refused as empty, from a config and from the constructor`, () => {
      const invalid = { code: 'RESIZE_CONFIG_INVALID' };
      assert.throws(
        () =>
          LocalFsStorage.fromConfig(
            { driver: 'local', rootDir: blank, publicBaseUrl: '/m' },
            ctx,
          ),
        {
          ...invalid,
          message: /`storage\.rootDir` in src\/config\/resize\.ts/,
        },
      );
      assert.throws(
        () =>
          LocalFsStorage.fromConfig(
            {
              driver: 'local',
              rootDir: 'a',
              privateRootDir: blank,
              publicBaseUrl: '/m',
            },
            ctx,
          ),
        { ...invalid, message: /`storage\.privateRootDir`/ },
      );
      assert.throws(
        () => new LocalFsStorage({ rootDir: blank, publicBaseUrl: '/m' }),
        { ...invalid, message: /rootDir must be a non-empty string/ },
      );
      assert.throws(
        () =>
          new LocalFsStorage({
            rootDir: 'a',
            privateRootDir: blank,
            publicBaseUrl: '/m',
          }),
        { ...invalid, message: /privateRootDir must be a non-empty string/ },
      );
    });
  }

  test("'.' is the replacement for an empty root: it is the working directory", () => {
    const fromCwd = LocalFsStorage.fromConfig(
      { driver: 'local', rootDir: '.', publicBaseUrl: '/m' },
      ctx,
    );
    assert.ok(fromCwd instanceof LocalFsStorage);
    assert.ok(
      LocalFsStorage.fromConfig(
        {
          driver: 'local',
          rootDir: './var/media',
          privateRootDir: '.',
          publicBaseUrl: '/m',
        },
        ctx,
      ) instanceof LocalFsStorage,
    );
  });

  test('privateRootDir: null takes the default in the constructor, as before', async (t) => {
    const dir = await fresh();
    t.after(() =>
      Promise.all([
        rm(dir, { recursive: true, force: true }),
        rm(`${join(dir, 'media')}-private`, { recursive: true, force: true }),
      ]),
    );
    const s = new LocalFsStorage({
      rootDir: join(dir, 'media'),
      privateRootDir: null as unknown as string,
      publicBaseUrl: '/m',
    });
    const ref = await s.upload(uploadArgs('originals/a.jpg', 'private'));
    assert.ok(await readFile(join(dir, 'media-private', 'originals/a.jpg')));
    assert.deepEqual(await s.download(ref), Buffer.from('originals/a.jpg'));
  });

  test('an empty publicBaseUrl is accepted as on rc.2 and gives root-relative URLs', async (t) => {
    const dir = await fresh();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const s = LocalFsStorage.fromConfig(
      { driver: 'local', rootDir: join(dir, 'media'), publicBaseUrl: '' },
      ctx,
    );
    const ref = await s.upload(uploadArgs('previews/a.jpg', 'public'));
    assert.equal(s.publicUrl(ref), '/previews/a.jpg');
  });
});
