import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { LocalFsStorage } from './fs.ts';

const fresh = () => mkdtemp(join(tmpdir(), 'resize-fs-'));

describe('LocalFsStorage.upload / download', () => {
  test('round-trips a buffer under rootDir/key and creates parent dirs', async () => {
    const dir = await fresh();
    const s = new LocalFsStorage({ rootDir: dir, publicBaseUrl: '/media' });
    const body = Buffer.from('hello-preview');
    const ref = await s.upload({
      key: 'uploads/a/b.jpg',
      body,
      contentType: 'image/jpeg',
      visibility: 'public',
    });
    assert.deepEqual(ref, { key: 'uploads/a/b.jpg' });
    const onDisk = await readFile(join(dir, 'uploads/a/b.jpg'));
    assert.deepEqual(onDisk, body);
    const downloaded = await s.download(ref);
    assert.deepEqual(downloaded, body);
  });

  test('download reads a file the host already placed at original.key', async () => {
    const dir = await fresh();
    await writeFile(join(dir, 'orig.png'), Buffer.from('orig'));
    const s = new LocalFsStorage({ rootDir: dir, publicBaseUrl: '/media' });
    const buf = await s.download({ key: 'orig.png' });
    assert.deepEqual(buf, Buffer.from('orig'));
  });
});

describe('LocalFsStorage.publicUrl', () => {
  test('joins publicBaseUrl + key and trims slashes', () => {
    const s = new LocalFsStorage({
      rootDir: '/tmp/x',
      publicBaseUrl: 'https://cdn.example.com/media/',
    });
    assert.equal(
      s.publicUrl({ key: 'uploads/a.jpg' }),
      'https://cdn.example.com/media/uploads/a.jpg',
    );
    assert.equal(
      s.publicUrl({ key: '/uploads/a.jpg' }),
      'https://cdn.example.com/media/uploads/a.jpg',
    );
  });
});

describe('LocalFsStorage path traversal', () => {
  test('refuses a key that escapes rootDir', async () => {
    const dir = await fresh();
    const s = new LocalFsStorage({ rootDir: dir, publicBaseUrl: '/media' });
    await assert.rejects(
      () =>
        s.upload({
          key: '../outside.jpg',
          body: Buffer.from('x'),
          contentType: 'image/jpeg',
          visibility: 'public',
        }),
      /escapes rootDir/,
    );
    await assert.rejects(
      () => s.download({ key: '../../etc/passwd' }),
      /escapes rootDir/,
    );
  });
});
