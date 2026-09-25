import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { LocalFsStorage } from './fs.ts';

const fresh = () => mkdtemp(join(tmpdir(), 'resize-fs-'));
const uploadArgs = (key: string, visibility: 'public' | 'private') => ({
  key,
  visibility,
  body: Buffer.from(key),
  contentType: 'image/jpeg',
});

describe('LocalFsStorage', () => {
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
    assert.equal(s.canServeOriginalPublicly(privateRef), false);
    assert.equal(s.canServeOriginalPublicly(publicRef), true);
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
      assert.throws(() => s.canServeOriginalPublicly(ref));
      assert.throws(() => s.publicUrl(ref));
    }
  });

  test('does not follow a symlink out of the public root for reads or writes', async () => {
    const dir = await fresh();
    const outside = await fresh();
    await writeFile(join(outside, 'secret.jpg'), Buffer.from('secret'));
    await symlink(outside, join(dir, 'escape'), 'dir');
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
