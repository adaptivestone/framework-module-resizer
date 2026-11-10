// A real HTTP server that speaks as much S3 as the driver uses, with a real SDK client in front of
// it. A recording fake of `send` cannot show what the SDK puts on the wire, or what dropping a
// stream does to its connection. Requests are path style. The signature is not checked: the SDK
// owns signing, and real S3 stays the owner's check.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { S3Client } from '@aws-sdk/client-s3';
import { S3Storage } from '../drivers/s3.ts';

const NO_SUCH_KEY =
  '<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>';

export interface FakeS3 {
  endpoint: string;
  client: S3Client; // a real SDK client: region us-east-1, path style, fixed test credentials
  objects: Map<string, Buffer>; // key `${bucket}/${key}`, the key decoded once from the request path
  requests: Array<{ method: string; url: string }>; // raw request targets, in order
  /** The next GET of `path` answers this Content-Length, writes two bytes and never ends. Resolves when the client closes that connection. */
  hang(path: string, contentLength: number): Promise<void>;
  storage(): S3Storage; // bucketPublic 'pub', bucketPrivate 'priv', this endpoint, forcePathStyle, this client
  close(): Promise<void>;
}

export async function fakeS3(): Promise<FakeS3> {
  const objects: FakeS3['objects'] = new Map();
  const requests: FakeS3['requests'] = [];
  const hangs = new Map<
    string,
    { contentLength: number; closed: () => void }
  >();
  const server = createServer((req, res) => {
    const method = req.method ?? '';
    const url = req.url ?? '';
    requests.push({ method, url });
    const path = decodeURIComponent(url.split('?')[0].slice(1));
    if (method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        objects.set(path, Buffer.concat(chunks));
        res.end();
      });
      return;
    }
    if (method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    const hang = hangs.get(path);
    if (hang) {
      hangs.delete(path);
      req.socket.once('close', hang.closed);
      // Real S3 sends a checksum for an object uploaded with one, as the SDK does by default, so
      // the driver gets the SDK's ChecksumStream around the response, not the response itself.
      res.writeHead(200, {
        'content-length': hang.contentLength,
        'x-amz-checksum-crc32': 'AAAAAA==',
      });
      res.write('xx');
      return;
    }
    const body = objects.get(path);
    if (body === undefined) {
      res.writeHead(404, { 'content-type': 'application/xml' });
      res.end(NO_SUCH_KEY);
      return;
    }
    res.writeHead(200, { 'content-length': body.length });
    res.end(body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${port}`;
  const client = new S3Client({
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  return {
    endpoint,
    client,
    objects,
    requests,
    hang: (path, contentLength) =>
      new Promise((closed) => {
        hangs.set(path, { contentLength, closed });
      }),
    storage: () =>
      new S3Storage({
        bucketPublic: 'pub',
        bucketPrivate: 'priv',
        endpoint,
        forcePathStyle: true,
        client,
      }),
    close: async () => {
      client.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => {
        server.close(resolve);
      });
    },
  };
}
