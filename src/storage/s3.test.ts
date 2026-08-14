import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { S3Storage } from './s3.ts';

// No live AWS and NO test-only seam in the driver. The driver statically imports the SDK for
// the command classes (installed as a devDep here), but the CLIENT is a legitimate public
// option (`client?: S3Client`) — bring-your-own configured instance. The tests pass a fake
// client whose recording `send(cmd)` inspects `cmd.input` (populated by the REAL command
// classes) and returns scripted outputs. `publicUrl` is pure/synchronous → it can never
// touch `getClient` / the SDK client construction, so those tests provide NO client at all.

interface FakeCommand {
  input: Record<string, unknown>;
  constructor: { name: string };
}

// A recording fake S3 client. `send` routes on the REAL command's constructor name and
// returns a scripted GetObject Body (with `transformToByteArray`) or an empty PutObject reply.
function makeFakeS3() {
  const sent: FakeCommand[] = [];
  const client = {
    async send(command: FakeCommand) {
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

// ---------------------------------------------------------------------------
// upload — visibility routing + persisted ref + no ACL + client honoring (05 · §10.5)
// ---------------------------------------------------------------------------

describe('S3Storage.upload', () => {
  test('routes visibility:public → bucketPublic and returns the persisted {bucket,key}', async () => {
    const { client, sent } = makeFakeS3();
    const s = new S3Storage({
      bucketPublic: 'pub',
      bucketPrivate: 'priv',
      client,
    });
    const ref = await s.upload({
      key: 'a/b.jpg',
      body: Buffer.from('x'),
      contentType: 'image/jpeg',
      visibility: 'public',
    });
    assert.deepEqual(ref, { bucket: 'pub', key: 'a/b.jpg' });
    assert.equal(sent[0].input.Bucket, 'pub');
    assert.equal(sent[0].input.Key, 'a/b.jpg');
    assert.equal(sent[0].input.ContentType, 'image/jpeg');
  });

  test('routes visibility:private → bucketPrivate', async () => {
    const { client, sent } = makeFakeS3();
    const s = new S3Storage({
      bucketPublic: 'pub',
      bucketPrivate: 'priv',
      client,
    });
    const ref = await s.upload({
      key: 'k',
      body: Buffer.alloc(0),
      contentType: 'image/webp',
      visibility: 'private',
    });
    assert.equal(ref.bucket, 'priv');
    assert.equal(sent[0].input.Bucket, 'priv');
  });

  test('private falls back to bucketPublic when bucketPrivate is absent', async () => {
    const { client } = makeFakeS3();
    const s = new S3Storage({ bucketPublic: 'pub', client });
    const ref = await s.upload({
      key: 'k',
      body: Buffer.alloc(0),
      contentType: 'image/avif',
      visibility: 'private',
    });
    assert.equal(ref.bucket, 'pub');
  });

  test('sends NO per-object ACL param', async () => {
    const { client, sent } = makeFakeS3();
    const s = new S3Storage({ bucketPublic: 'pub', client });
    await s.upload({
      key: 'k',
      body: Buffer.alloc(0),
      contentType: 'image/jpeg',
      visibility: 'public',
    });
    assert.equal('ACL' in sent[0].input, false);
  });

  test('honors the provided client and reuses that one instance across calls (no reconstruction)', async () => {
    const { client, sent } = makeFakeS3();
    const s = new S3Storage({ bucketPublic: 'pub', client });
    const up = {
      key: 'k',
      body: Buffer.alloc(0),
      contentType: 'image/jpeg',
      visibility: 'public' as const,
    };
    await s.upload(up);
    await s.download({ bucket: 'pub', key: 'k' });
    // Every I/O op routed through the SAME injected client (upload send + download send).
    assert.equal(sent.length, 2);
  });
});

// ---------------------------------------------------------------------------
// download — ref.bucket ?? fallbacks; returns a Buffer (05 · §10.5)
// ---------------------------------------------------------------------------

describe('S3Storage.download', () => {
  test('uses ref.bucket when present (allowlisted) and returns a Buffer', async () => {
    const { client, sent } = makeFakeS3();
    const s = new S3Storage({
      bucketPublic: 'pub',
      bucketPrivate: 'priv',
      client,
    });
    // ref.bucket wins over the private fallback — must be one of the configured buckets.
    const buf = await s.download({ bucket: 'pub', key: 'orig.jpg' });
    assert.ok(Buffer.isBuffer(buf));
    assert.deepEqual([...buf], [1, 2, 3]);
    assert.equal(sent[0].input.Bucket, 'pub');
    assert.equal(sent[0].input.Key, 'orig.jpg');
  });

  test('falls back to bucketPrivate when ref.bucket is absent', async () => {
    const { client, sent } = makeFakeS3();
    const s = new S3Storage({
      bucketPublic: 'pub',
      bucketPrivate: 'priv',
      client,
    });
    await s.download({ key: 'k' });
    assert.equal(sent[0].input.Bucket, 'priv');
  });

  test('falls back to bucketPublic when both ref.bucket and bucketPrivate are absent', async () => {
    const { client, sent } = makeFakeS3();
    const s = new S3Storage({ bucketPublic: 'pub', client });
    await s.download({ key: 'k' });
    assert.equal(sent[0].input.Bucket, 'pub');
  });
});

// ---------------------------------------------------------------------------
// publicUrl — PURE, no client; all three forms (05 · §10.5)
// ---------------------------------------------------------------------------

describe('S3Storage.publicUrl (pure — no client)', () => {
  test('publicUrl base form (trims a trailing slash) — provide NO client; pure/synchronous', () => {
    // No `client` option and no `await`: `publicUrl` is synchronous, so it structurally
    // cannot reach `getClient` / SDK client construction. Returning the right string proves it.
    const s = new S3Storage({
      bucketPublic: 'pub',
      publicUrl: 'https://cdn.example.com/',
    });
    assert.equal(
      s.publicUrl({ key: 'a/b.jpg' }),
      'https://cdn.example.com/a/b.jpg',
    );
  });

  test('publicBaseUrl is the preferred option (alias of the deprecated publicUrl)', () => {
    const s = new S3Storage({
      bucketPublic: 'pub',
      publicBaseUrl: 'https://cdn.example.com/',
    });
    assert.equal(
      s.publicUrl({ key: 'a/b.jpg' }),
      'https://cdn.example.com/a/b.jpg',
    );
  });

  test('publicBaseUrl wins when both publicBaseUrl and publicUrl are set', () => {
    const s = new S3Storage({
      bucketPublic: 'pub',
      publicBaseUrl: 'https://new.example.com',
      publicUrl: 'https://old.example.com',
    });
    assert.equal(s.publicUrl({ key: 'k' }), 'https://new.example.com/k');
  });

  test('endpoint + forcePathStyle → path-style URL', () => {
    const s = new S3Storage({
      bucketPublic: 'pub',
      endpoint: 'http://localhost:9000',
      forcePathStyle: true,
    });
    assert.equal(
      s.publicUrl({ key: 'a/b.jpg' }),
      'http://localhost:9000/pub/a/b.jpg',
    );
  });

  test('virtual-hosted form uses region (defaulting to us-east-1) and ref.bucket ?? bucketPublic', () => {
    // `other` is an allowlisted bucket here (bucketPrivate) so ref.bucket can select it.
    const s = new S3Storage({
      bucketPublic: 'pub',
      bucketPrivate: 'other',
      region: 'eu-west-1',
    });
    assert.equal(
      s.publicUrl({ key: 'a/b.jpg' }),
      'https://pub.s3.eu-west-1.amazonaws.com/a/b.jpg',
    );
    assert.equal(
      s.publicUrl({ bucket: 'other', key: 'k' }),
      'https://other.s3.eu-west-1.amazonaws.com/k',
    );

    const sDefault = new S3Storage({ bucketPublic: 'pub' });
    assert.equal(
      sDefault.publicUrl({ key: 'k' }),
      'https://pub.s3.us-east-1.amazonaws.com/k',
    );
  });
});

// ---------------------------------------------------------------------------
// bucket allowlist — a tampered ref.bucket is refused (05 · §10.5)
// ---------------------------------------------------------------------------

describe('S3Storage bucket allowlist', () => {
  test('download/publicUrl/signedUrl throw a named error for a bucket ∉ {public,private}', async () => {
    const client = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
    });
    const s = new S3Storage({
      bucketPublic: 'pub',
      bucketPrivate: 'priv',
      client,
    });
    const tampered = { bucket: 'attacker-bucket', key: 'k' };
    await assert.rejects(() => s.download(tampered), /attacker-bucket/);
    assert.throws(() => s.publicUrl(tampered), /attacker-bucket/);
    await assert.rejects(
      () => s.signedUrl?.(tampered, 900) as Promise<string>,
      /attacker-bucket/,
    );
  });

  test('the configured buckets pass; a ref without a bucket is unchanged', async () => {
    const { client } = makeFakeS3();
    const s = new S3Storage({
      bucketPublic: 'pub',
      bucketPrivate: 'priv',
      client,
    });
    // configured buckets pass
    await s.download({ bucket: 'pub', key: 'k' });
    await s.download({ bucket: 'priv', key: 'k' });
    assert.equal(
      s.publicUrl({ bucket: 'pub', key: 'k' }).includes('pub'),
      true,
    );
    // no ref.bucket → fallbacks, no throw
    assert.doesNotThrow(() => s.publicUrl({ key: 'k' }));
    await s.download({ key: 'k' });
  });
});

// ---------------------------------------------------------------------------
// signedUrl — lazy presigner + expiresIn passthrough (05 · §10.5)
// ---------------------------------------------------------------------------

describe('S3Storage.signedUrl', () => {
  test('presigns with the REAL presigner and passes expiresIn (bucket = ref.bucket ?? private ?? public)', async () => {
    // No presigner seam exists any more, so we exercise the REAL `getSignedUrl`. It signs
    // offline given a client that carries region + credentials, so we bring our own real
    // S3Client with dummy creds (nothing goes over the network for presigning).
    const client = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
    });
    const s = new S3Storage({
      bucketPublic: 'pub',
      bucketPrivate: 'priv',
      client,
    });
    assert.equal(typeof s.signedUrl, 'function');
    const url = await s.signedUrl?.({ key: 'orig.jpg' }, 900);
    // bucket routed to the private fallback; key + expiry reflected in the produced URL.
    assert.ok(String(url).includes('orig.jpg'));
    assert.ok(String(url).includes('priv'));
    assert.ok(String(url).includes('X-Amz-Expires=900'));
  });
});
