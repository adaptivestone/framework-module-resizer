// S3Storage with a real SDK client against a real HTTP server: what a stream and its connection do
// shows only here. The recording fakes of s3.test.ts never open a socket.
import assert from 'node:assert/strict';
import type { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { ResizeMediaError, ResizeStorageError } from '../errors.ts';
import { type FakeS3, fakeS3 } from '../testHelpers/fakeS3.ts';

let s3: FakeS3;

before(async () => {
  s3 = await fakeS3();
});

after(() => s3.close());

test('download over maxBytes rejects from ContentLength, reads no body and closes the connection', {
  timeout: 10_000,
}, async () => {
  const closed = s3.hang('priv/huge.jpg', 300 * 1024 * 1024);
  await assert.rejects(
    s3
      .storage()
      .download({ bucket: 'priv', key: 'huge.jpg' }, { maxBytes: 1024 }),
    (err: unknown) => {
      assert.ok(err instanceof ResizeMediaError);
      assert.equal(err.code, 'RESIZE_SOURCE_TOO_LARGE');
      assert.equal(err.retryable, false);
      assert.match(err.message, /limits\.sourceBytes/);
      assert.doesNotMatch(err.message, /huge\.jpg/);
      return true;
    },
  );
  await closed; // resolves only when the driver dropped the stream
});

test('that hanging response reaches the driver as the body real S3 gives, and destroying it closes the connection', {
  timeout: 10_000,
}, async () => {
  const closed = s3.hang('priv/checksum.jpg', 10);
  const out = await s3.client.send(
    new GetObjectCommand({ Bucket: 'priv', Key: 'checksum.jpg' }),
  );
  // An SDK from before flexible checksums has no such setting and hands over the raw response.
  const validates = s3.client.config.responseChecksumValidation !== undefined;
  assert.equal(
    out.Body?.constructor.name,
    validates ? 'ChecksumStream' : 'IncomingMessage',
  );
  (out.Body as unknown as Readable).destroy();
  await closed;
});

test('download at exactly maxBytes, and without maxBytes, returns the bytes', async () => {
  s3.objects.set('priv/a.jpg', Buffer.from('abc'));
  const ref = { bucket: 'priv', key: 'a.jpg' };
  assert.deepEqual(
    await s3.storage().download(ref, { maxBytes: 3 }),
    Buffer.from('abc'),
  );
  assert.deepEqual(await s3.storage().download(ref), Buffer.from('abc'));
});

test('the fake server stores a PUT, records raw targets and answers a missing key as S3 does', async () => {
  const ref = await s3.storage().upload({
    key: 'put.jpg',
    body: Buffer.from('put'),
    contentType: 'image/jpeg',
    visibility: 'private',
  });
  assert.deepEqual(s3.objects.get('priv/put.jpg'), Buffer.from('put'));
  assert.deepEqual(await s3.storage().download(ref), Buffer.from('put'));
  assert.ok(
    s3.requests.some(
      ({ method, url }) => method === 'PUT' && url.startsWith('/priv/put.jpg'),
    ),
  );
  await assert.rejects(
    s3.storage().download({ bucket: 'priv', key: 'none.jpg' }),
    (err: unknown) => {
      assert.ok(err instanceof ResizeStorageError);
      assert.equal(err.code, 'RESIZE_STORAGE_NOT_FOUND');
      return true;
    },
  );
});
