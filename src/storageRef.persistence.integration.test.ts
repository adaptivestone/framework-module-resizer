import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import { defaultOptions } from '@adaptivestone/framework/modules/BaseModel.js';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { resizeMediaSchemaFragment } from './models/mediaFragment.ts';
import { Resizer, resetResizerForTests } from './resizer.ts';
import type { ResizeStorage } from './storage/AbstractStorage.ts';
import { LocalFsStorage } from './storage/fs.ts';
import { S3Storage } from './storage/s3.ts';
import { makeResizeConfig } from './testHelpers/resizeConfig.ts';
import type { MediaLike } from './types.d.ts';

let mongo: MongoMemoryServer | undefined;
let connection: mongoose.Connection | undefined;
let dir: string | undefined;
afterEach(async () => {
  resetResizerForTests();
  resetAppInstance();
  if (connection) {
    await connection.close();
  }
  if (mongo) {
    await mongo.stop();
  }
  if (dir) {
    await rm(dir, { recursive: true, force: true });
  }
  connection = undefined;
  mongo = undefined;
  dir = undefined;
});

test('refs survive media save/load and fresh-driver preview generation', async () => {
  mongo = await MongoMemoryServer.create();
  connection = await mongoose.createConnection(mongo.getUri()).asPromise();
  const Media = connection.model(
    'ResizeMediaRefTest',
    new mongoose.Schema({ ...resizeMediaSchemaFragment }, defaultOptions),
    'resize_media_ref_test',
  );
  dir = await mkdtemp(join(tmpdir(), 'resize-ref-persist-'));
  const bytes = await sharp({
    create: { width: 24, height: 18, channels: 3, background: '#456789' },
  })
    .png()
    .toBuffer();
  setAppInstance({
    getConfig: () => makeResizeConfig({ mediaModelName: 'ResizeMediaRefTest' }),
    getModel: () => Media,
    logger: { info() {}, warn() {}, error() {} },
  } as never);

  const objects = new Map<string, Buffer>();
  const client = {
    async send(command: {
      input: { Bucket: string; Key: string; Body?: Buffer };
      constructor: { name: string };
    }) {
      const name = `${command.input.Bucket}/${command.input.Key}`;
      if (command.constructor.name === 'PutObjectCommand') {
        objects.set(name, Buffer.from(command.input.Body ?? []));
        return {};
      }
      const stored = objects.get(name);
      if (!stored) {
        throw new Error(`missing test object ${name}`);
      }
      return { Body: { transformToByteArray: async () => stored } };
    },
  };
  const factory = {
    fs: (): ResizeStorage =>
      new LocalFsStorage({ rootDir: dir as string, publicBaseUrl: '/media' }),
    s3: (): ResizeStorage =>
      new S3Storage({
        bucketPublic: 'pub',
        bucketPrivate: 'priv',
        publicBaseUrl: '/media',
        client: client as never,
      }),
  };

  for (const [name, createStorage] of Object.entries(factory)) {
    for (const namespace of [undefined, 'products/p1']) {
      resetResizerForTests();
      const uploader = new Resizer({ storage: createStorage() });
      const original = await uploader.uploadOriginal({
        body: bytes,
        visibility: 'private',
        ...(namespace ? { namespace } : {}),
      });
      const row = await Media.create({ original, previews: [] });
      const loaded = (await Media.findById(
        row.id,
      ).lean()) as unknown as MediaLike;
      assert.deepEqual(loaded.original?.storageRef, original.storageRef);

      resetResizerForTests();
      const worker = new Resizer({ storage: createStorage() });
      const result = await worker.generate({
        media: loaded,
        sizes: [{ width: 8, height: 8 }],
        formats: ['webp'],
        persist: false,
      });
      assert.equal(result.created.length, 1);
      await Media.findByIdAndUpdate(row.id, {
        $push: { previews: { $each: result.created } },
      });
      const reloaded = (await Media.findById(
        row.id,
      ).lean()) as unknown as MediaLike;
      assert.deepEqual(
        reloaded.previews?.[0]?.storageRef,
        result.created[0].storageRef,
      );
      const { decision } = await worker.resolve({
        media: reloaded,
        sizes: [{ width: 8, height: 8 }],
        formats: ['webp'],
        enqueueMissing: false,
      });
      assert.equal(
        decision.ready.length,
        1,
        `${name} ${namespace ?? 'ungrouped'}`,
      );
      if (namespace) {
        assert.match(decision.ready[0].url, /products\/p1\/previews\//);
      }
    }
  }

  const scalar = await Media.create({
    original: { storageRef: 0 },
    previews: [
      {
        storageRef: false,
        sizeKey: '8x8',
        format: 'webp',
        contentType: 'image/webp',
      },
    ],
  });
  const scalarReloaded = await Media.findById(scalar.id).lean();
  assert.equal(scalarReloaded?.original?.storageRef, 0);
  assert.equal(scalarReloaded?.previews?.[0]?.storageRef, false);
});

for (const [mode, options] of Object.entries({
  framework: defaultOptions,
  mongoose: { minimize: false },
})) {
  test(`${mode}: opaque refs retain empty objects through create, preview append and save`, async () => {
    mongo = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongo.getUri()).asPromise();
    const Media = connection.model(
      'OpaqueEmptyRef',
      new mongoose.Schema({ ...resizeMediaSchemaFragment }, options),
    );
    for (const storageRef of [
      {},
      { id: 'x', options: {}, nested: { empty: {} } },
    ]) {
      const row = await Media.create({
        original: { storageRef, format: 'png' },
      });
      await Media.findByIdAndUpdate(row.id, {
        $push: {
          previews: {
            storageRef,
            sizeKey: '8x8',
            format: 'webp',
            contentType: 'image/webp',
          },
        },
      });
      const loaded = await Media.findById(row.id).orFail();
      assert.deepEqual(loaded.original?.storageRef, storageRef);
      assert.deepEqual(loaded.previews[0].storageRef, storageRef);
      loaded.set('original.width', 24);
      loaded.markModified('previews');
      await loaded.save();
      const reloaded = await Media.findById(row.id).lean().orFail();
      assert.deepEqual(reloaded.original?.storageRef, storageRef);
      assert.deepEqual(reloaded.previews[0].storageRef, storageRef);
    }
  });
}
