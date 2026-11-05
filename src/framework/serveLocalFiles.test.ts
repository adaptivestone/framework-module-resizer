// Runs the guide's "Serve local files" recipe on the framework's own server, because the recipe
// rests on what the framework does around `bootHttp`: it serves no static files, and it mounts its
// 404 page after the hook. Models are skipped, so no Mongo is needed; the DSN only passes the boot
// check.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import Server, { type BootHttpHook } from '@adaptivestone/framework/server.js';

// biome-ignore-start lint/style/useBlockStatements: the guide's text, byte for byte
// biome-ignore-start lint/complexity/useLiteralKeys: the guide's text, byte for byte
// biome-ignore format: the guide's text, byte for byte
const bootHttp: BootHttpHook = async (app) => {
  if (process.env['NODE_ENV'] === 'production') return; // a reverse proxy or a CDN serves these files
  const { default: express } = await import('express'); // npm i -D express
  app.httpServer?.express.use('/media', express.static('var/media', { dotfiles: 'ignore', index: false, immutable: true, maxAge: '1y' }));
};
// biome-ignore-end lint/complexity/useLiteralKeys: the guide's text, byte for byte
// biome-ignore-end lint/style/useBlockStatements: the guide's text, byte for byte

const startDir = process.cwd();
const startEnv = process.env.NODE_ENV;
let dir: string;
let server: Server;
let port: unknown;
let base: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'resize-serve-'));
  const folders = {
    config: join(dir, 'config'),
    models: join(dir, 'models'),
    controllers: join(dir, 'controllers'),
    locales: join(dir, 'locales'),
    emails: join(dir, 'emails'),
    commands: join(dir, 'commands'),
    migrations: join(dir, 'migrations'),
  };
  await Promise.all(
    [
      ...Object.values(folders),
      join(dir, 'var/media/previews'),
      join(dir, 'var/media-private'),
    ].map((folder) => mkdir(folder, { recursive: true })),
  );
  await writeFile(join(dir, 'var/media/previews/x.webp'), 'preview');
  await writeFile(join(dir, 'var/media/.hidden'), 'hidden');
  await writeFile(join(dir, 'var/media-private/secret.jpg'), 'secret');

  process.chdir(dir);
  Object.assign(process.env, {
    NODE_ENV: 'development',
    HTTP_PORT: '0',
    HTTP_HOST: '127.0.0.1',
    AUTH_SALT: 'a'.repeat(32),
    MONGO_DSN: 'mongodb://127.0.0.1:1/x?serverSelectionTimeoutMS=100',
    LOGGER_CONSOLE_LEVEL: 'error',
  });
  server = new Server({ folders, bootHttp });
  await server.init({ isSkipModelInit: true, isSkipModelLoading: true });
  await server.startServer();
  // Framework 5.1 binds the port in the HttpServer constructor and does not wait for it.
  const listener = server.app.httpServer?.httpServer;
  assert.ok(listener);
  if (!listener.listening) {
    await once(listener, 'listening');
  }
  port = server.app.getConfig('http').port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await server.app.httpServer?.shutdown();
  server.app.events.emit('shutdown');
  process.chdir(startDir);
  if (startEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = startEnv;
  }
  await rm(dir, { recursive: true, force: true });
});

/** The status of a request for exactly `path`: fetch would collapse a `..` before sending it. */
const rawStatus = (path: string): Promise<number | undefined> =>
  new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port: Number(port), path }, (res) => {
      res.resume();
      resolve(res.statusCode);
    })
      .on('error', reject)
      .end();
  });

test('the development recipe serves rootDir at /media, with a long cache', async () => {
  const res = await fetch(`${base}/media/previews/x.webp`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/webp');
  assert.equal(
    res.headers.get('cache-control'),
    'public, max-age=31536000, immutable',
  );
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('it serves nothing outside rootDir, the private originals above all', async () => {
  for (const path of [
    '/media/previews/none',
    '/media/../media-private/secret.jpg',
    '/media/%2e%2e/media-private/secret.jpg',
    '/media/..%2fmedia-private/secret.jpg',
    '/media-private/secret.jpg',
  ]) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
});

test('a traversal sent as it is, which fetch would collapse, finds nothing either', async () => {
  for (const path of [
    '/media/../media-private/secret.jpg',
    '/media/%2e%2e/media-private/secret.jpg',
    '/media/%2e%2e%2fmedia-private/secret.jpg',
    '/media/previews/../../media-private/secret.jpg',
  ]) {
    assert.equal(await rawStatus(path), 404, path);
  }
});

test('it lists no folder and serves no dotfile', async () => {
  for (const path of ['/media/', '/media/previews/', '/media/.hidden']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
});

test('in production the recipe mounts nothing', async () => {
  process.env.NODE_ENV = 'production';
  try {
    await bootHttp({
      httpServer: { express: { use: () => assert.fail('mounted a folder') } },
    } as never);
  } finally {
    process.env.NODE_ENV = 'development';
  }
});
