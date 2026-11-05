// A host's own engine, through `new Resizer({ engine })`: a test-only engine with no image library
// renders eager and queued with no core change. The last test runs the same path in a process where
// importing Sharp throws, so nothing in the Processor can lean on it.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { SourceDecoder } from './contracts/decoder.ts';
import type { LeasedTask } from './contracts/taskQueue.ts';
import { SharpDecoder } from './decoders/sharp.ts';
import { Resizer, resetResizerForTests } from './resizer.ts';
import { FakePngDecoder } from './testHelpers/fakeDecoder.ts';
import { decodePng, encodePng, FakeEngine } from './testHelpers/fakeEngine.ts';
import { fakeMedia, memoryStorage } from './testHelpers/fakes.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import type {
  DeepPartial,
  MediaLike,
  Preview,
  ResizeConfig,
} from './types.d.ts';
import { processTask } from './worker.ts';

const run = promisify(execFile);
const silent = { info() {}, warn() {}, error() {} };
afterEach(resetResizerForTests);

/** A 64×48 source: the left eighth is transparent, so a flattened format needs its background. */
function sourcePng(): Buffer {
  const data = Buffer.alloc(64 * 48 * 4);
  for (let i = 0; i < 64 * 48; i++) {
    data.set([200, 30, 90, i % 64 < 8 ? 0 : 255], i * 4);
  }
  return encodePng({ data, info: { width: 64, height: 48, channels: 4 } });
}

function setup(
  engine: FakeEngine | undefined,
  config: DeepPartial<ResizeConfig> = {},
  name?: string,
  decoder: SourceDecoder = new FakePngDecoder(),
) {
  const { storage, files } = memoryStorage();
  const doc: MediaLike = { id: 'm1', previews: [] };
  const resizer = new Resizer({
    ...(name ? { name } : {}),
    storage,
    media: fakeMedia({
      load: async () => doc,
      appendPreviews: async (_id: string, rows: Preview[]) => {
        doc.previews = [...(doc.previews ?? []), ...rows];
        return rows;
      },
    }),
    config: makeImageConfig({ formats: ['jpeg', 'webp'], ...config }),
    logger: silent,
    ...(engine ? { engine } : {}),
    decoders: [decoder],
  });
  return { resizer, files, doc };
}

const SIZES = [{ width: 32 }, { width: 16, height: 16 }, { fit: true }];

test('a fake engine renders every size eager, and each file is what its row says', async () => {
  const engine = new FakeEngine();
  const { resizer, files, doc } = setup(engine);
  doc.original = await resizer.uploadOriginal({
    body: sourcePng(),
    visibility: 'private',
  });
  const { created, failed } = await resizer.generate({
    media: doc,
    sizes: SIZES,
  });
  assert.equal(failed, 0);
  assert.equal(created.length, 6);
  for (const row of created) {
    const { info } = decodePng(
      files.get((row.storageRef as { key: string }).key) as Buffer,
    );
    assert.deepEqual(
      [info.width, info.height],
      [row.actualWidth, row.actualHeight],
    );
  }
  // { fit: true } on a 64×48 source is its own size with no sharpen: no resize at all.
  assert.equal(engine.calls.filter((c) => c.op === 'resize').length, 2);
  assert.equal(engine.calls.filter((c) => c.op === 'encode').length, 6);
});

test('only a format in encode.flatten is asked to flatten', async () => {
  const engine = new FakeEngine();
  const { resizer, doc } = setup(engine);
  doc.original = await resizer.uploadOriginal({
    body: sourcePng(),
    visibility: 'private',
  });
  await resizer.generate({ media: doc, sizes: [{ width: 32 }] });
  const encodes = engine.calls.filter((c) => c.op === 'encode');
  assert.equal(encodes.find((c) => c.format === 'jpeg')?.background, '#ffffff');
  assert.equal(encodes.find((c) => c.format === 'webp')?.background, undefined);
});

// worker.test.ts pins that a worker uses its Resizer's engine, on Sharp's resize. Here both pixel
// operations are the fake's, so the file is a PNG of the requested size.
test('a fake engine renders a queued task', async () => {
  const engine = new FakeEngine();
  const { resizer, files, doc } = setup(engine);
  doc.original = await resizer.uploadOriginal({
    body: sourcePng(),
    visibility: 'private',
  });
  await processTask({
    taskId: 't1',
    resizer: 'default',
    queue: 'default',
    mediaId: 'm1',
    pipeline: 'default',
    attempts: 1,
    previews: [
      {
        sizeKey: '20x20',
        format: 'webp',
        requestedWidth: 20,
        requestedHeight: 20,
      },
    ],
  } as unknown as LeasedTask);
  assert.equal(doc.previews?.length, 1);
  const [row] = doc.previews ?? [];
  const { info } = decodePng(
    files.get((row.storageRef as { key: string }).key) as Buffer,
  );
  assert.deepEqual([info.width, info.height], [20, 20]);
  assert.deepEqual(
    engine.calls.map((c) => [c.op, c.width, c.height]),
    [
      ['resize', 20, 20],
      ['encode', 20, 20],
    ],
  );
});

test('rows from the fake engine and from Sharp carry the same encodeSig', async () => {
  const signatures = async (engine: FakeEngine | undefined, name: string) => {
    const { resizer, doc } = setup(engine, {}, name, new SharpDecoder());
    doc.original = await resizer.uploadOriginal({
      body: sourcePng(),
      visibility: 'private',
    });
    const { created } = await resizer.generate({ media: doc, sizes: SIZES });
    return Object.fromEntries(
      created.map((r) => [`${r.sizeKey}:${r.format}`, r.encodeSig]),
    );
  };
  assert.deepEqual(
    await signatures(new FakeEngine(), 'fake'),
    await signatures(undefined, 'sharp'),
  );
});

test('an engine that writes png alone passes verify() with its own entry, and Sharp reads its file as its row says', async () => {
  const engine = new FakeEngine({ formats: ['png'], animatedFormats: [] });
  const { resizer, files, doc } = setup(engine, {
    formats: ['png'],
    encode: { formats: { png: {} } },
  });
  await resizer.verify();
  doc.original = await resizer.uploadOriginal({
    body: sourcePng(),
    visibility: 'private',
  });
  const { created } = await resizer.generate({
    media: doc,
    sizes: [{ width: 32 }],
  });
  const [row] = created;
  const meta = await sharp(
    files.get((row.storageRef as { key: string }).key) as Buffer,
  ).metadata();
  assert.deepEqual(
    [meta.format, meta.width, meta.height, meta.channels],
    [row.format, row.actualWidth, row.actualHeight, 4],
  );
  assert.equal(row.contentType, 'image/png');
});

test('animatedFormats decides how many frames the decoder is asked for', async () => {
  const colours = [
    [200, 20, 30],
    [10, 200, 30],
    [10, 20, 200],
  ];
  const frames = Buffer.concat(
    colours.map(
      (c) => Buffer.alloc(16 * 12 * 3).map((_, i) => c[i % 3]) as Buffer,
    ),
  );
  const gif = await sharp(frames, {
    raw: { width: 16, height: 36, channels: 3, pageHeight: 12 },
  })
    .gif({ delay: 100 })
    .toBuffer();
  const asked = async (animatedFormats: string[], name: string) => {
    const decoder = new SharpDecoder();
    const render = decoder.render.bind(decoder);
    const seen: number[] = [];
    decoder.render = (bytes, box, opts) => {
      seen.push(opts.frames);
      return render(bytes, box, opts);
    };
    const engine = new FakeEngine({ animatedFormats });
    const { resizer, doc } = setup(
      engine,
      { animated: true, formats: ['webp'] },
      name,
      decoder,
    );
    doc.original = await resizer.uploadOriginal({
      body: gif,
      visibility: 'private',
    });
    assert.equal(
      (await resizer.generate({ media: doc, sizes: [{ width: 8 }] })).failed,
      0,
    );
    return seen;
  };
  assert.deepEqual(await asked([], 'still'), [1]);
  assert.deepEqual(await asked(['webp'], 'moving'), [3]);
});

// The import is reported on stderr and in the exit code as well as thrown, so a caller that catches
// the error and falls back still fails the run.
const BLOCK_SHARP = `data:text/javascript,${encodeURIComponent(`import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'sharp' || specifier.startsWith('sharp/')) {
    const message = 'sharp was imported from ' + context.parentURL;
    console.error(message);
    process.exitCode = 1;
    throw new Error(message);
  }
  return next(specifier, context);
} });`)}`;

test('the hook that blocks Sharp does block it', async () => {
  for (const code of [
    "await import('sharp')",
    "await import('sharp').catch(() => {})",
    "import { createRequire } from 'node:module'; try { createRequire(import.meta.url)('sharp'); } catch {}",
  ]) {
    await assert.rejects(
      run(process.execPath, [
        '--no-warnings',
        '--import',
        BLOCK_SHARP,
        '--input-type=module',
        '-e',
        code,
      ]),
      (err: Error & { stderr: string }) =>
        /sharp was imported from/.test(err.stderr),
      code,
    );
  }
});

test('the Processor renders through a fake engine where importing Sharp throws', async () => {
  const file = fileURLToPath(
    new URL('./testHelpers/noSharpRun.ts', import.meta.url),
  );
  const { stdout } = await run(process.execPath, [
    '--experimental-strip-types',
    '--no-warnings',
    '--import',
    BLOCK_SHARP,
    file,
  ]);
  assert.match(stdout, /rendered without sharp/);
});
