import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { ResizeConfigError, ResizeSecurityError } from '../errors.ts';
import { asS3Client, silentLogger } from '../testHelpers/fakes.ts';
import type { S3StorageConfig } from '../types.d.ts';
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
  return { client: asS3Client(client), sent };
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
    // Visibility is enforced where a URL is made; the driver has no separate visibility check.
    assert.equal('canServeOriginalPublicly' in s, false);
    assert.throws(() => s.publicUrl(parent), /private bucket/);
    assert.equal(
      s.publicUrl(child),
      'https://pub.s3.us-east-1.amazonaws.com/users/u1/previews/b.jpg',
    );
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

  for (const region of ['eu-west-1', undefined]) {
    test(`AWS path-style URL uses ${region ?? 'us-east-1 by default'} without an endpoint`, () => {
      const { client, sent } = fakeClient();
      const s = new S3Storage({
        bucketPublic: 'pub',
        region,
        forcePathStyle: true,
        client,
      });
      assert.equal(
        s.publicUrl({ bucket: 'pub', key: 'previews/a.jpg' }),
        `https://s3.${region ?? 'us-east-1'}.amazonaws.com/pub/previews/a.jpg`,
      );
      assert.equal(sent.length, 0);
    });
  }

  test('AWS China regions use the amazonaws.com.cn domain in both URL forms', () => {
    const ref = { bucket: 'pub', key: 'previews/a.jpg' };
    assert.equal(
      new S3Storage({ bucketPublic: 'pub', region: 'cn-north-1' }).publicUrl(
        ref,
      ),
      'https://pub.s3.cn-north-1.amazonaws.com.cn/previews/a.jpg',
    );
    assert.equal(
      new S3Storage({
        bucketPublic: 'pub',
        region: 'cn-northwest-1',
        forcePathStyle: true,
      }).publicUrl(ref),
      'https://s3.cn-northwest-1.amazonaws.com.cn/pub/previews/a.jpg',
    );
  });

  test('explicit endpoint and CDN URL keep precedence over the AWS path-style base', () => {
    const opts = {
      bucketPublic: 'pub',
      endpoint: 'http://localhost:9000///',
      region: 'eu-west-1',
      forcePathStyle: true,
    };
    const ref = { bucket: 'pub', key: 'previews/a.jpg' };
    assert.equal(
      new S3Storage(opts).publicUrl(ref),
      'http://localhost:9000/pub/previews/a.jpg',
    );
    assert.equal(
      new S3Storage({
        ...opts,
        publicBaseUrl: 'https://cdn.example.com///',
      }).publicUrl(ref),
      'https://cdn.example.com/previews/a.jpg',
    );
  });

  test('bucket allowlist errors keep their security code without archived citations', async () => {
    const { client, sent } = fakeClient();
    const s = new S3Storage({ bucketPublic: 'pub', client });
    await assert.rejects(
      () => s.download({ bucket: 'attacker', key: 'a.jpg' }),
      (error) => {
        assert.ok(error instanceof ResizeSecurityError);
        assert.equal(error.code, 'RESIZE_S3_BUCKET_NOT_ALLOWED');
        assert.equal(
          error.message,
          'resize s3: ref.bucket "attacker" is not an allowlisted bucket (bucketPublic/bucketPrivate) — refusing cross-bucket access',
        );
        return true;
      },
    );
    assert.equal(sent.length, 0);
  });

  test('SVG uploads set attachment disposition while preserving their bytes and content type', async () => {
    const { client, sent } = fakeClient();
    const s = new S3Storage({
      bucketPublic: 'pub',
      bucketPrivate: 'priv',
      client,
    });
    const upload = {
      ...args('originals/a.svg', 'private'),
      body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      contentType: 'image/svg+xml',
    };
    await s.upload(upload);
    assert.equal(sent[0].constructor.name, 'PutObjectCommand');
    assert.deepEqual(sent[0].input, {
      Bucket: 'priv',
      Key: upload.key,
      Body: upload.body,
      ContentType: upload.contentType,
      ContentDisposition: 'attachment',
    });
  });

  test('non-SVG public uploads carry the cache header and no disposition', async () => {
    const { client, sent } = fakeClient();
    const s = new S3Storage({ bucketPublic: 'pub', client });
    for (const contentType of ['image/jpeg', 'image/png', 'image/webp']) {
      const upload = { ...args('previews/a', 'public'), contentType };
      await s.upload(upload);
      assert.deepEqual(sent.at(-1)?.input, {
        Bucket: 'pub',
        Key: upload.key,
        Body: upload.body,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      });
    }
  });

  test('public uploads are cacheable for a year and immutable; private uploads carry no cache header', async () => {
    const { client, sent } = fakeClient();
    const s = new S3Storage({
      bucketPublic: 'pub',
      bucketPrivate: 'priv',
      client,
    });
    await s.upload(args('previews/a.webp', 'public'));
    assert.equal(
      sent[0].input.CacheControl,
      'public, max-age=31536000, immutable',
    );
    await s.upload(args('originals/a.jpg', 'private'));
    assert.equal('CacheControl' in sent[1].input, false);
    await s.upload({ ...args('originals/b.jpg', 'public') });
    assert.equal(
      sent[2].input.CacheControl,
      'public, max-age=31536000, immutable',
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

describe('S3Storage.fromConfig', () => {
  const ctx = {
    logger: silentLogger,
    where: 'src/config/resize.production.ts',
  };
  const ref = { bucket: 'pub', key: 'previews/a.jpg' };
  const invalid = (key: string, what: string) => (err: unknown) =>
    err instanceof ResizeConfigError &&
    err.code === 'RESIZE_CONFIG_INVALID' &&
    err.message ===
      `resize config: \`storage.${key}\` in src/config/resize.production.ts must be ${what}`;

  test('needs bucketPublic and drops undefined keys', () => {
    // The local driver's keys stay in a section an environment file switched to S3, and undefined
    // values never reach the driver: no endpoint means the AWS URL, not path style.
    const s = S3Storage.fromConfig(
      {
        driver: 's3',
        bucketPublic: 'pub',
        bucketPrivate: undefined,
        publicBaseUrl: undefined,
        region: 'eu-west-1',
        endpoint: undefined,
        forcePathStyle: undefined,
        rootDir: '/srv/media',
      } as S3StorageConfig,
      ctx,
    );
    assert.ok(s instanceof S3Storage);
    assert.equal(
      s.publicUrl(ref),
      'https://pub.s3.eu-west-1.amazonaws.com/previews/a.jpg',
    );
    assert.equal(
      S3Storage.fromConfig(
        {
          driver: 's3',
          bucketPublic: 'pub',
          endpoint: 'http://localhost:9000',
          forcePathStyle: true,
        },
        ctx,
      ).publicUrl(ref),
      'http://localhost:9000/pub/previews/a.jpg',
    );
    assert.equal(
      S3Storage.fromConfig(
        {
          driver: 's3',
          bucketPublic: 'pub',
          publicBaseUrl: 'https://cdn.example.com',
        },
        ctx,
      ).publicUrl(ref),
      'https://cdn.example.com/previews/a.jpg',
    );
    for (const keys of [{}, { bucketPublic: '' }, { bucketPublic: 1 }]) {
      assert.throws(
        () =>
          S3Storage.fromConfig(
            { driver: 's3', ...keys } as unknown as S3StorageConfig,
            ctx,
          ),
        invalid('bucketPublic', 'a non-empty string'),
      );
    }
    for (const key of [
      'bucketPrivate',
      'publicBaseUrl',
      'region',
      'endpoint',
    ]) {
      assert.throws(
        () =>
          S3Storage.fromConfig(
            {
              driver: 's3',
              bucketPublic: 'pub',
              [key]: 5,
            } as unknown as S3StorageConfig,
            ctx,
          ),
        invalid(key, 'a string'),
      );
    }
  });

  test('accepts what rc.2 accepted: an empty publicBaseUrl and forcePathStyle as given', () => {
    // '' is no CDN base: the bucket URL.
    assert.equal(
      S3Storage.fromConfig(
        {
          driver: 's3',
          bucketPublic: 'pub',
          publicBaseUrl: '',
          region: 'eu-west-1',
        },
        ctx,
      ).publicUrl(ref),
      'https://pub.s3.eu-west-1.amazonaws.com/previews/a.jpg',
    );
    // Passed on unchecked, as the framework adapter did: a truthy string turns path style on.
    assert.equal(
      S3Storage.fromConfig(
        {
          driver: 's3',
          bucketPublic: 'pub',
          region: 'eu-west-1',
          forcePathStyle: 'true',
        } as unknown as S3StorageConfig,
        ctx,
      ).publicUrl(ref),
      'https://s3.eu-west-1.amazonaws.com/pub/previews/a.jpg',
    );
  });

  test("a section's bucketPrivate is the private bucket: publicUrl refuses it", async () => {
    const s = S3Storage.fromConfig(
      { driver: 's3', bucketPublic: 'pub', bucketPrivate: 'priv' },
      ctx,
    );
    assert.throws(
      () => s.publicUrl({ bucket: 'priv', key: 'originals/a.jpg' }),
      ResizeSecurityError,
    );
  });
});
