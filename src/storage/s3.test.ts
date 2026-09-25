import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { S3Storage } from './s3.ts';

function fakeClient() {
  const sent: Array<{
    input: Record<string, unknown>;
    constructor: { name: string };
  }> = [];
  const client = {
    async send(command: {
      input: Record<string, unknown>;
      constructor: { name: string };
    }) {
      sent.push(command);
      if (command.constructor.name === 'GetObjectCommand') {
        return {
          Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
        };
      }
      return {};
    },
  };
  return { client, sent };
}

const args = (key: string, visibility: 'public' | 'private') => ({
  key,
  visibility,
  body: Buffer.from(key),
  contentType: 'image/jpeg',
});

describe('S3Storage', () => {
  test('routes original and derived preview to their own buckets while retaining grouping', async () => {
    const { client, sent } = fakeClient();
    const opts = { bucketPublic: 'pub', bucketPrivate: 'priv', client };
    const parent = await new S3Storage(opts).upload({
      ...args('originals/a.jpg', 'private'),
      namespace: 'users/u1',
    });
    assert.deepEqual(parent, {
      bucket: 'priv',
      key: 'users/u1/originals/a.jpg',
      namespace: 'users/u1',
    });
    const s = new S3Storage(opts);
    const child = await s.upload({
      ...args('previews/b.jpg', 'public'),
      parentRef: JSON.parse(JSON.stringify(parent)),
    });
    assert.deepEqual(child, {
      bucket: 'pub',
      key: 'users/u1/previews/b.jpg',
      namespace: 'users/u1',
    });
    assert.deepEqual(
      sent.map((x) => [x.input.Bucket, x.input.Key]),
      [
        ['priv', 'users/u1/originals/a.jpg'],
        ['pub', 'users/u1/previews/b.jpg'],
      ],
    );
    assert.deepEqual(await s.download(parent), Buffer.from([1, 2, 3]));
    assert.equal(sent[2].input.Bucket, 'priv');
    assert.equal(s.canServeOriginalPublicly(parent), false);
    assert.equal(s.canServeOriginalPublicly(child), true);
  });

  test('ungrouped public object gets a public URL without client I/O', () => {
    const s = new S3Storage({
      bucketPublic: 'pub',
      publicBaseUrl: 'https://cdn.example.com/',
    });
    assert.equal(
      s.publicUrl({ bucket: 'pub', key: 'previews/a.jpg' }),
      'https://cdn.example.com/previews/a.jpg',
    );
    const pathStyle = new S3Storage({
      bucketPublic: 'pub',
      endpoint: 'http://localhost:9000',
      forcePathStyle: true,
    });
    assert.equal(
      pathStyle.publicUrl({ bucket: 'pub', key: 'a.jpg' }),
      'http://localhost:9000/pub/a.jpg',
    );
    const virtual = new S3Storage({ bucketPublic: 'pub', region: 'eu-west-1' });
    assert.equal(
      virtual.publicUrl({ bucket: 'pub', key: 'a.jpg' }),
      'https://pub.s3.eu-west-1.amazonaws.com/a.jpg',
    );
  });

  test('refuses private URL, unknown bucket, missing bucket and invalid refs', async () => {
    const { client } = fakeClient();
    const s = new S3Storage({
      bucketPublic: 'pub',
      bucketPrivate: 'priv',
      client,
    });
    assert.throws(
      () => s.publicUrl({ bucket: 'priv', key: 'a.jpg' }),
      /private bucket/,
    );
    for (const ref of [
      { bucket: 'attacker', key: 'a.jpg' },
      { key: 'a.jpg' },
      null,
      { bucket: 'pub', key: '../x' },
      { bucket: 'pub', key: 'a.jpg', namespace: '../x' },
      { bucket: 'pub', key: 'users/a/originals/x.jpg', namespace: 'users/b' },
    ]) {
      await assert.rejects(() => s.download(ref));
      assert.throws(() => s.canServeOriginalPublicly(ref));
      assert.throws(() => s.publicUrl(ref));
    }
  });

  test('rejects invalid placement hints and private upload without a private bucket', async () => {
    const { client, sent } = fakeClient();
    const s = new S3Storage({
      bucketPublic: 'pub',
      bucketPrivate: 'priv',
      client,
    });
    await assert.rejects(
      () =>
        s.upload({
          ...args('a.jpg', 'public'),
          namespace: 'x',
          parentRef: { bucket: 'priv', key: 'a.jpg' },
        }),
      /conflict/,
    );
    await assert.rejects(
      () => s.upload({ ...args('a.jpg', 'public'), namespace: '../x' }),
      /invalid namespace/,
    );
    await assert.rejects(
      () => s.upload({ ...args('a.jpg', 'public'), parentRef: null }),
      /invalid parentRef/,
    );
    assert.equal(sent.length, 0);
    await assert.rejects(
      () =>
        new S3Storage({ bucketPublic: 'pub', client }).upload(
          args('a.jpg', 'private'),
        ),
      /distinct private bucket/,
    );
  });

  test('rejects an oversized composed key and URL-reserved names before S3 I/O', async () => {
    const { client, sent } = fakeClient();
    const s = new S3Storage({ bucketPublic: 'pub', client });
    await assert.rejects(
      () =>
        s.upload({
          ...args('previews/a.jpg', 'public'),
          namespace: 'x'.repeat(1020),
        }),
      /exceeds 1024 bytes/,
    );
    await assert.rejects(
      () => s.upload(args('previews/a?b.jpg', 'public')),
      /invalid logical key/,
    );
    assert.throws(
      () => s.publicUrl({ bucket: 'pub', key: 'previews/a#b.jpg' }),
      /invalid logical key/,
    );
    assert.equal(sent.length, 0);
  });

  test('signed URL uses the exact persisted private bucket and expiry', async () => {
    const client = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
    });
    const s = new S3Storage({
      bucketPublic: 'pub',
      bucketPrivate: 'priv',
      client,
    });
    const url = await s.signedUrl(
      { bucket: 'priv', key: 'users/u1/originals/a.jpg' },
      900,
    );
    assert.match(url, /priv/);
    assert.match(url, /users\/u1\/originals\/a.jpg/);
    assert.match(url, /X-Amz-Expires=900/);
  });
});
