// variantSteps through the whole path: `new Resizer`, `generate()`, the stored files and rows.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import sharp, {
  type FormatEnum,
  type OutputOptions,
  type OverlayOptions,
  type Sharp,
} from 'sharp';
import type { Raster } from './contracts/decoder.ts';
import type { ImageEngine } from './contracts/engine.ts';
import type { Pipeline, VariantStep } from './contracts/pipeline.ts';
import { SharpEngine } from './engines/sharp.ts';
import { rasterToSharp, sharpToRaster } from './engines/sharpRaster.ts';
import { ResizeGenerateError } from './errors.ts';
import { Resizer, resetResizerForTests } from './resizer.ts';
import {
  fakeMedia,
  MemoryTaskQueue,
  memoryStorage,
} from './testHelpers/fakes.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import { workUntil } from './testHelpers/work.ts';
import type {
  MediaLike,
  Preview,
  QueueTimingOptions,
  ResizeLimits,
  SizeInput,
} from './types.d.ts';
import { runWorker } from './worker.ts';

afterEach(resetResizerForTests);

const silent = { info() {}, warn() {}, error() {} };

const photo = (): Promise<Buffer> =>
  sharp({
    create: { width: 200, height: 100, channels: 3, background: '#336699' },
  })
    .png()
    .toBuffer();

async function run(
  pipeline: Pipeline,
  formats = ['jpeg', 'webp'],
  body?: Buffer,
  {
    sizes = [{ width: 100, height: 50 }],
    limits = {},
    engine,
  }: {
    sizes?: SizeInput[];
    limits?: Partial<ResizeLimits>;
    engine?: ImageEngine;
  } = {},
) {
  const { storage, files } = memoryStorage();
  const warns: unknown[][] = [];
  const doc: MediaLike = { id: 'm1', previews: [] };
  const resizer = new Resizer({
    storage,
    media: fakeMedia({
      load: async () => doc,
      appendPreviews: async (_id: string, rows: Preview[]) => rows,
    }),
    config: makeImageConfig({ formats, limits }),
    logger: {
      info() {},
      warn: (...args: unknown[]) => warns.push(args),
      error() {},
    },
    pipelines: { default: pipeline },
    engine,
  });
  doc.original = await resizer.uploadOriginal({
    body: body ?? (await photo()),
    visibility: 'private',
  });
  return {
    result: resizer.generate({ media: doc, sizes, formats }),
    files,
    warns,
  };
}

test('a step reads the stored media and the source through generate()', async () => {
  const seen: unknown[][] = [];
  const { result } = await run(
    {
      variantSteps: [
        (raster, { media, source, variant }) => {
          seen.push([media.id, source.width, source.format, variant.format]);
          return raster;
        },
      ],
    },
    ['webp'],
  );
  await result;
  assert.deepEqual(seen, [['m1', 200, 'png', 'webp']]);
});

test('a step that writes in place marks each format of a size once', async () => {
  const seen: number[] = [];
  const { result } = await run({
    variantSteps: [
      (raster) => {
        seen.push(raster.data[0]);
        raster.data.fill(0);
        return raster;
      },
    ],
  });
  assert.equal((await result).created.length, 2);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], 0);
  assert.equal(seen[1], seen[0]);
});

test('an old step that calls a Sharp method fails with its plain TypeError', async () => {
  const old = (img: unknown) =>
    (img as { composite(a: unknown[]): unknown }).composite([]);
  const { result, warns } = await run({ variantSteps: [old as never] });
  await assert.rejects(
    result,
    (err: unknown) => err instanceof ResizeGenerateError,
  );
  const [message, cause] = warns[0];
  assert.match(String(message), /variant .* failed for media m1/);
  assert.ok(cause instanceof TypeError);
  assert.match(cause.message, /\.composite is not a function/);
});

test('an old step that only returns its argument keeps working', async () => {
  const { result } = await run({ variantSteps: [(img) => img] }, ['webp']);
  const { created, failed } = await result;
  assert.equal(failed, 0);
  assert.equal(created.length, 1);
});

test('a step that resizes through the helpers gives the row its size', async () => {
  const { result, files } = await run(
    {
      variantSteps: [
        async (r) =>
          sharpToRaster(rasterToSharp(r).resize(50, 40, { fit: 'fill' })),
      ],
    },
    ['webp'],
  );
  const [row] = (await result).created;
  assert.deepEqual([row.actualWidth, row.actualHeight], [50, 40]);
  const { width, height } = await sharp(
    files.get((row.storageRef as { key: string }).key),
  ).metadata();
  assert.deepEqual([width, height], [50, 40]);
});

const plain = (width: number, height: number): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();

test('a slow step through rasterToSharp is killed near the limit, and fails only its variant', async () => {
  // Without the limit this blur runs for about 7 s on the large size.
  const { result, warns } = await run(
    {
      variantSteps: [
        async (r) =>
          sharpToRaster(rasterToSharp(r).blur(r.info.width === 2000 ? 400 : 1)),
      ],
    },
    ['webp'],
    await plain(2000, 1000),
    {
      sizes: [
        { width: 2000, height: 1000 },
        { width: 100, height: 50 },
      ],
      limits: { processingTimeoutSeconds: 1 },
    },
  );
  const { created, failed } = await result;
  assert.equal(failed, 1);
  assert.deepEqual(
    created.map((row) => row.sizeKey),
    ['100x50'],
  );
  assert.equal(warns.length, 1);
  assert.match(String(warns[0][1]), /timeout/);
});

test("a chain's own shorter timeout overrides the limit", async () => {
  const { result, warns } = await run(
    {
      variantSteps: [
        async (r) =>
          sharpToRaster(rasterToSharp(r).blur(400).timeout({ seconds: 1 })),
      ],
    },
    ['webp'],
    await plain(2000, 1000),
    { sizes: [{ width: 2000, height: 1000 }] },
  );
  await assert.rejects(result);
  assert.match(String(warns[0][1]), /timeout/);
});

test("a chain's own longer timeout, a timeout of 0 and a raster spread into a new object run past the limit", async () => {
  // This blur runs for longer than the limit of 1 s.
  const chains: Record<string, (r: Raster) => Sharp> = {
    '1000x500': (r) => rasterToSharp(r).blur(500).timeout({ seconds: 30 }),
    '990x495': (r) => rasterToSharp(r).blur(500).timeout({ seconds: 0 }),
    '980x490': (r) => rasterToSharp({ ...r }).blur(500),
  };
  const { result } = await run(
    {
      variantSteps: [
        async (r, { variant }) => sharpToRaster(chains[variant.sizeKey](r)),
      ],
    },
    ['webp'],
    await plain(1000, 500),
    {
      sizes: Object.keys(chains).map((key) => {
        const [width, height] = key.split('x').map(Number);
        return { width, height };
      }),
      limits: { processingTimeoutSeconds: 1 },
    },
  );
  const { created, failed } = await result;
  assert.equal(failed, 0);
  assert.equal(created.length, 3);
});

test("a chained step's input carries the limit too", async () => {
  const { result, warns } = await run(
    {
      variantSteps: [
        async (r) => sharpToRaster(rasterToSharp(r).blur(1)),
        async (r) => sharpToRaster(rasterToSharp(r).blur(400)),
      ],
    },
    ['webp'],
    await plain(2000, 1000),
    {
      sizes: [{ width: 2000, height: 1000 }],
      limits: { processingTimeoutSeconds: 1 },
    },
  );
  await assert.rejects(result);
  assert.match(String(warns[0][1]), /timeout/);
});

test('a second chain in one step keeps the limit', async () => {
  const { result, warns } = await run(
    {
      variantSteps: [
        async (r) => {
          const first = await sharpToRaster(rasterToSharp(r).blur(1));
          return sharpToRaster(rasterToSharp(first).blur(400));
        },
      ],
    },
    ['webp'],
    await plain(2000, 1000),
    {
      sizes: [{ width: 2000, height: 1000 }],
      limits: { processingTimeoutSeconds: 1 },
    },
  );
  await assert.rejects(result);
  assert.match(String(warns[0][1]), /timeout/);
});

/** An engine of the host's: it records what encode() gets, and writes a marker file. */
function recordingEngine() {
  const sharpEngine = new SharpEngine();
  const encoded: Raster[] = [];
  const engine: ImageEngine = {
    id: 'recording',
    formats: ['jpeg', 'webp', 'avif'],
    animatedFormats: [],
    resize: (frame, req, opts) => sharpEngine.resize(frame, req, opts),
    encode: async (raster) => {
      encoded.push(raster);
      return {
        data: Buffer.from('preview'),
        format: 'webp',
        contentType: 'image/webp',
        width: raster.info.width,
        height: raster.info.height,
      };
    },
  };
  return { engine, encoded };
}

test('a step with no image library runs beside a custom engine, and encode gets its result', async () => {
  const { engine, encoded } = recordingEngine();
  const { result } = await run(
    {
      beforeSteps: [
        ({ data, info }) => ({ data: Buffer.from(data).fill(9), info }),
      ],
      variantSteps: [
        (raster) => {
          raster.data.fill(7, 0, raster.info.channels);
          return raster;
        },
      ],
    },
    ['webp'],
    undefined,
    { engine, sizes: [{ width: 100, height: 50 }] },
  );
  const { created, failed } = await result;
  assert.equal(failed, 0);
  assert.equal(created.length, 1);
  const [{ data, info }] = encoded;
  assert.deepEqual([info.width, info.height], [100, 50]);
  assert.equal(data[0], 7);
  // Nothing of the step's time limit shows on the raster an engine or a step sees.
  assert.deepEqual(Object.keys(encoded[0]).sort(), ['data', 'info']);
  assert.deepEqual(Object.keys(info).sort(), ['channels', 'height', 'width']);
});

test('a rasterToSharp chain in a step keeps the limit beside a custom engine', async () => {
  const { engine } = recordingEngine();
  const { result, warns } = await run(
    { variantSteps: [async (r) => sharpToRaster(rasterToSharp(r).blur(400))] },
    ['webp'],
    await plain(2000, 1000),
    {
      engine,
      sizes: [{ width: 2000, height: 1000 }],
      limits: { processingTimeoutSeconds: 1 },
    },
  );
  await assert.rejects(result);
  assert.match(String(warns[0][1]), /timeout/);
});

test('beforeSteps stay unbounded, as on 0.3.0', async () => {
  const { result } = await run(
    { beforeSteps: [async (r) => sharpToRaster(rasterToSharp(r).blur(500))] },
    ['webp'],
    await plain(1000, 500),
    {
      sizes: [{ width: 1000, height: 500 }],
      limits: { processingTimeoutSeconds: 1 },
    },
  );
  const { created, failed } = await result;
  assert.equal(failed, 0);
  assert.equal(created.length, 1);
});

test('the limit moves no byte: a fast step writes the same files with it turned off', async () => {
  const logo = await sharp({
    create: {
      width: 30,
      height: 20,
      channels: 4,
      background: { r: 0, g: 40, b: 250, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  const filesOf = async (seconds: number | undefined) => {
    resetResizerForTests();
    const { result, files } = await run(
      {
        variantSteps: [
          async (r) => {
            const img = rasterToSharp(r)
              .blur(2)
              .composite([{ input: logo, gravity: 'southeast' }]);
            return sharpToRaster(
              seconds === undefined ? img : img.timeout({ seconds }),
            );
          },
        ],
      },
      ['jpeg', 'webp'],
      await photo(),
    );
    const { created, failed } = await result;
    assert.equal(failed, 0);
    return new Map(
      created.map((row) => [
        row.format,
        files.get((row.storageRef as { key: string }).key) as Buffer,
      ]),
    );
  };
  const limited = await filesOf(undefined);
  const off = await filesOf(0);
  assert.equal(limited.size, 2);
  for (const [format, bytes] of limited) {
    assert.ok(bytes.equals(off.get(format) as Buffer), format);
  }
});

test('a healthy task completes beside slow variants: the limit frees the threads they hold', async () => {
  // What it proves, on any machine: chains that hold all of libuv's threads leave the healthy task's
  // Sharp calls waiting, and only the limit cutting a chain lets them run. Nothing here races a clock:
  // on a busy machine a cut comes seconds late, and the healthy task waits for it. The deadline and
  // `taskTimeoutMs` are for a stuck worker. Without the limit the first upload comes with no cut.
  const deadline = 120_000;
  const threads = Number(process.env.UV_THREADPOOL_SIZE) || 4;
  const tasks = new MemoryTaskQueue({
    timing: {
      idlePollMs: 5,
      taskTimeoutMs: deadline,
      maxAttempts: 3,
      retryBackoffMs: { base: deadline, max: deadline },
    },
  });
  const bodies = new Map([
    ['slow', await plain(2000, 1000)],
    ['healthy', await plain(40, 20)],
  ]);
  const stored = new Map<string, Preview[]>();
  let chainsEntered = 0;
  let cuts = 0;
  let cutsAtFirstUpload: number | undefined;
  new Resizer({
    config: makeImageConfig({
      formats: ['webp'],
      concurrency: threads,
      limits: { processingTimeoutSeconds: 1 },
    }),
    logger: {
      ...silent,
      warn: (_msg, err) => {
        if (/timeout/.test(String(err))) {
          cuts++;
        }
      },
    },
    storage: {
      download: async (ref) =>
        bodies.get((ref as { key: string }).key) as Buffer,
      upload: async () => {
        cutsAtFirstUpload ??= cuts;
        return { key: 'preview' };
      },
      publicUrl: () => '',
    },
    media: fakeMedia({
      load: async (id) => ({
        id,
        original: { storageRef: { key: id } },
        previews: [],
      }),
      previews: stored,
    }),
    tasks,
    pipelines: {
      slow: {
        variantSteps: [
          async (r) => {
            chainsEntered++;
            return sharpToRaster(rasterToSharp(r).blur(400));
          },
        ],
      },
    },
  });
  const webp = (width: number, height: number) => ({
    sizeKey: `${width}x${height}`,
    format: 'webp',
    requestedWidth: width,
    requestedHeight: height,
  });
  await tasks.add({
    resizer: 'default',
    queue: 'bulk',
    mediaId: 'slow',
    pipeline: 'slow',
    previews: Array.from({ length: threads }, (_, i) =>
      webp(2000 - i * 10, 1000 - i * 5),
    ),
  });
  const stop = new AbortController();
  const working = runWorker({
    logger: silent,
    queue: ['bulk', 'default'],
    signal: stop.signal,
  });
  const giveUpAt = Date.now() + deadline;
  const until = async (done: () => boolean) => {
    while (!done()) {
      assert.ok(Date.now() < giveUpAt, 'the worker never got there');
      await delay(5);
    }
  };
  try {
    // A chain's first call is a short metadata read, so a chain entered is not yet a thread held. A
    // chain cut this early, on a busy machine, means the others cannot all be running at once.
    await until(
      () =>
        (chainsEntered === threads && sharp.counters().process >= threads) ||
        cuts > 0,
    );
    await tasks.add({
      resizer: 'default',
      queue: 'default',
      mediaId: 'healthy',
      pipeline: 'default',
      previews: [webp(20, 10)],
    });
    const [slow, healthy] = tasks.rows;
    await until(
      () => healthy.status === 'completed' || healthy.status === 'dead',
    );
    assert.equal(healthy.status, 'completed');
    assert.equal(healthy.attempts, 1);
    assert.equal(stored.get('healthy')?.length, 1);
    assert.ok(
      (cutsAtFirstUpload as number) > 0,
      'the healthy task got a thread with no chain cut',
    );
    // The rest of the chains fail too, not all with this message, as on 0.3.0.
    await until(() => slow.status === 'pending');
    assert.equal(stored.get('slow')?.length ?? 0, 0);
    assert.equal(slow.attempts, 1);
  } finally {
    stop.abort();
    await working;
  }
});

/** A worker on an in-memory queue whose media store keeps its rows, as a real one does. */
function slowStepWorker(
  variantSteps: VariantStep[],
  previews: Array<{ sizeKey: string; width: number; height: number }>,
  timing: Partial<QueueTimingOptions>,
  concurrency = 4,
) {
  const tasks = new MemoryTaskQueue({ timing: { idlePollMs: 5, ...timing } });
  const stored = new Map<string, Preview[]>();
  new Resizer({
    config: makeImageConfig({ formats: ['webp'], concurrency }),
    logger: silent,
    storage: {
      download: async () => plain(40, 20),
      upload: async ({ key }) => ({ key }),
      publicUrl: () => '',
    },
    media: fakeMedia({
      load: async (id) => ({
        id,
        original: { storageRef: { key: id }, width: 40, height: 20 },
        previews: stored.get(id) ?? [],
      }),
      previews: stored,
    }),
    tasks,
    pipelines: { default: { variantSteps } },
  });
  const add = () =>
    tasks.add({
      resizer: 'default',
      queue: 'default',
      mediaId: 'm1',
      pipeline: 'default',
      previews: previews.map(({ sizeKey, width, height }) => ({
        sizeKey,
        format: 'webp',
        requestedWidth: width,
        requestedHeight: height,
      })),
    });
  return { tasks, stored, add };
}

const overlay = (r: Raster) =>
  sharpToRaster(
    rasterToSharp(r).composite([
      {
        input: {
          create: { width: 4, height: 4, channels: 3, background: '#fff' },
        },
        gravity: 'southeast',
      },
    ]),
  );

// A delivery's media writes are not fenced, and that is what heals this: the timed-out delivery goes
// on, stores its row late, and a later delivery finds it fresh. Stopping such a variant, before its
// encode or before a later step, turns it into a task that dies after maxAttempts with no rows.
for (const steps of [1, 2]) {
  test(`a step slower than taskTimeoutMs ends completed with its row, on a pipeline of ${steps} step${steps === 1 ? '' : 's'}`, async () => {
    let slowRuns = 0;
    const slow: VariantStep = async (r) => {
      slowRuns++;
      // Its timer starts after the task's, so it always ends after the task timed out.
      await delay(250);
      return overlay(r);
    };
    const { tasks, stored, add } = slowStepWorker(
      steps === 1 ? [slow] : [slow, overlay],
      [{ sizeKey: '20x10', width: 20, height: 10 }],
      {
        taskTimeoutMs: 100,
        maxAttempts: 3,
        // Longer than the late write takes, so the next delivery finds its row.
        retryBackoffMs: { base: 400, max: 400 },
      },
    );
    await add();
    const [row] = tasks.rows;
    await workUntil(
      { logger: silent },
      () => row.status === 'completed' || row.status === 'dead',
    );
    assert.equal(row.status, 'completed');
    assert.ok(row.attempts >= 2, 'a delivery timed out on the way');
    assert.equal(stored.get('m1')?.length, 1);
    assert.equal(stored.get('m1')?.[0].sizeKey, '20x10');
    // The last delivery rendered nothing: it found the late row.
    assert.equal(slowRuns, row.attempts - 1);
  });
}

test('a worker stopped during a step saves the variant in progress and gives the task back; the variant not started stays for the next worker', async () => {
  const stop = new AbortController();
  const { tasks, stored, add } = slowStepWorker(
    [
      async (r) => {
        stop.abort();
        await delay(20);
        return r;
      },
      overlay,
    ],
    [
      { sizeKey: '20x10', width: 20, height: 10 },
      { sizeKey: '10x5', width: 10, height: 5 },
    ],
    { taskTimeoutMs: 5000, maxAttempts: 3 },
    1,
  );
  await add();
  await runWorker({ logger: silent, signal: stop.signal });
  const [row] = tasks.rows;
  // Its second step and its encode ran after the stop.
  assert.equal(stored.get('m1')?.length, 1);
  assert.equal(row.status, 'pending');
});

/** A 200×100 source with smooth colours, whose columns take their alpha from `alpha`. */
function transparentSource(alpha: (x: number) => number): Promise<Buffer> {
  const data = Buffer.alloc(200 * 100 * 4);
  for (let i = 0; i < 200 * 100; i++) {
    const x = i % 200;
    data.set([x, 60 + Math.floor(i / 200), 200 - x, alpha(x)], i * 4);
  }
  return sharp(data, { raw: { width: 200, height: 100, channels: 4 } })
    .png()
    .toBuffer();
}

/** Its colours alone: Sharp lands an overlay after the flatten, and that adds an alpha channel. */
async function rgbOf(img: Sharp): Promise<Buffer> {
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const pixels = info.width * info.height;
  const rgb = Buffer.alloc(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    data.copy(rgb, i * 3, i * info.channels, i * info.channels + 3);
  }
  return rgb;
}

/** The same step in both forms: rewritten through `generate()`, and as 0.3.0's one Sharp chain. */
async function compositeInBothForms(body: Buffer) {
  const logo = await sharp({
    create: {
      width: 30,
      height: 20,
      channels: 4,
      background: { r: 0, g: 40, b: 250, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  const overlay: OverlayOptions[] = [{ input: logo, gravity: 'southeast' }];
  const sized = new Map<string, Raster>();
  const { result, files } = await run(
    {
      variantSteps: [
        async (r, { variant }) => {
          sized.set(variant.format, {
            data: Buffer.from(r.data),
            info: { ...r.info },
          });
          return sharpToRaster(rasterToSharp(r).composite(overlay));
        },
      ],
    },
    ['jpeg', 'webp'],
    body,
  );
  const { created, failed } = await result;
  assert.equal(failed, 0);
  const { encode } = makeImageConfig();
  const { background } = encode.flatten;
  const both = new Map<
    string,
    {
      rewritten: Buffer;
      chain: Buffer;
      /** Both forms' pixels after the flatten, before the encoder. */
      rewrittenFlat: Buffer;
      chainFlat: Buffer;
    }
  >();
  for (const row of created) {
    const { format } = row;
    const raster = sized.get(format) as Raster;
    assert.equal(raster.info.channels, 4);
    const chain = rasterToSharp(raster).composite(overlay);
    const stepped = await sharpToRaster(
      rasterToSharp(raster).composite(overlay),
    );
    both.set(format, {
      rewritten: files.get((row.storageRef as { key: string }).key) as Buffer,
      chain: await (encode.flatten.formats.includes(format)
        ? chain.flatten({ background })
        : chain
      )
        .toFormat(
          format as keyof FormatEnum,
          encode.formats[format] as OutputOptions,
        )
        .toBuffer(),
      rewrittenFlat: await rgbOf(
        rasterToSharp(stepped).flatten({ background }),
      ),
      chainFlat: await rgbOf(
        rasterToSharp(raster).composite(overlay).flatten({ background }),
      ),
    });
  }
  return both;
}

test('a rewritten composite on a transparent source matches the Sharp-form chain on JPEG and WebP', async () => {
  const both = await compositeInBothForms(
    await transparentSource((x) => (x < 100 ? 0 : 255)),
  );
  for (const format of ['jpeg', 'webp']) {
    const forms = both.get(format);
    assert.ok(forms?.rewritten.equals(forms.chain), format);
  }
});

test('a rewritten composite on partly transparent pixels moves only the flattened format, by a few levels', async () => {
  const both = await compositeInBothForms(
    await transparentSource((x) => Math.floor((x * 255) / 199)),
  );
  const [webp, jpeg] = ['webp', 'jpeg'].map((format) => {
    const forms = both.get(format);
    assert.ok(forms);
    return forms;
  });
  assert.ok(webp.rewritten.equals(webp.chain));
  const mostApart = (a: Buffer, b: Buffer) => {
    let most = 0;
    for (let i = 0; i < a.length; i++) {
      most = Math.max(most, Math.abs(a[i] - b[i]));
    }
    return most;
  };
  const encoded = mostApart(
    await sharp(jpeg.rewritten).raw().toBuffer(),
    await sharp(jpeg.chain).raw().toBuffer(),
  );
  assert.ok(encoded <= 8, `${encoded} levels in the JPEG`);
  // The move itself is smaller: the JPEG encoder spreads it.
  const flattened = mostApart(jpeg.rewrittenFlat, jpeg.chainFlat);
  assert.ok(flattened <= 2, `${flattened} levels before the encoder`);
});
