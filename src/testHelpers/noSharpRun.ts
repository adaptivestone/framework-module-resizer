// Test-only: the Processor's render paths, eager and queued, on a fake engine and a fake decoder.
// customEngine.test.ts runs this file in a process where importing Sharp throws, so nothing these
// paths reach can lean on Sharp, also where src/importGraph.test.ts cannot see it: a `require`, a
// path into node_modules, or a dynamic import of a file that imports it. A lazy import on a path no
// section reaches passes, so this says what stays out.
//
// Reached, each by a section below: a width, a height, a box, fit, and a source no larger than its
// box; unstored previews; a variantStep, a beforeStep, and a beforeStep that changes the size, with
// the reduction after it; an animation with its timing, and a format written from its first frame; a
// grey source, with and without alpha; a decoder's premultiplied raster; an original with no stored
// size, eager and queued; a queued task; a stale row replaced, eager and queued.
//
// Not reached: every failure path (a download, decoder, step, engine, upload or store that fails,
// and the contract checks on what they return); a stopped task; an original replaced during a task;
// rows the store left out; filtered variants; a size key that names no side; an original with no
// stored size whose rows are already fresh; `invalidate()`, the task observers and a real metrics
// sink. Nor is anything behind a Resizer: the Processor gets none, and a small decoder set of its
// own, because src/decoderSet.ts and src/engineCheck.ts import the built-in decoders and engine, and
// so Sharp, and src/worker.ts imports it for its settings. So the upload path, the built-in decoders
// (SVG too) and the worker loop stay out.
import assert from 'node:assert/strict';
import { Catalog } from '../catalog.ts';
import type {
  DecodeBox,
  RenderOptions,
  SourceDecoder,
} from '../contracts/decoder.ts';
import type { Pipeline } from '../contracts/pipeline.ts';
import type { LeasedTask } from '../contracts/taskQueue.ts';
import type { DecoderSet } from '../decoderSet.ts';
import { HookBus } from '../hooks.ts';
import { PipelineRegistry } from '../pipelines.ts';
import { Processor, type ProcessorDeps } from '../processor.ts';
import type { MediaLike, Preview, ResizeLogger } from '../types.d.ts';
import { FakePngDecoder } from './fakeDecoder.ts';
import { decodePng, encodePng, FakeEngine } from './fakeEngine.ts';
import { docMedia, memoryStorage, refKey } from './fakes.ts';
import { makeImageConfig } from './resizeConfig.ts';

const W = 64;
const H = 48;
/** Four areas of colour, with the left eighth transparent: a flattened format needs its background. */
const pixels = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  const x = i % W;
  const y = Math.floor(i / W);
  pixels.set(
    [x < W / 2 ? 200 : 20, y < H / 2 ? 30 : 180, 90, x < 8 ? 0 : 255],
    i * 4,
  );
}
const png = encodePng({
  data: pixels,
  info: { width: W, height: H, channels: 4 },
});

const problems: unknown[][] = [];
const logger: ResizeLogger = {
  info() {},
  warn: (...args: unknown[]) => {
    problems.push(args);
  },
  error: (...args: unknown[]) => {
    problems.push(args);
  },
};

/** One Processor over its own storage, media store and engine, with the original stored. */
function processorOn(
  pipelines: Record<string, Pipeline>,
  opts: {
    decoder?: SourceDecoder;
    config?: Parameters<typeof makeImageConfig>[0];
    source?: Buffer;
    storedSize?: boolean;
    taps?: ConstructorParameters<typeof HookBus>[0]['taps'];
  } = {},
) {
  const { storage, files } = memoryStorage();
  const source = opts.source ?? png;
  files.set('o', source);
  const { width, height } = decodePng(source).info;
  const media: MediaLike = {
    id: 'm1',
    original: {
      storageRef: { key: 'o' },
      format: 'png',
      contentType: 'image/png',
      size: source.length,
      ...(opts.storedSize === false ? {} : { width, height }),
    },
    previews: [],
  };
  const store = docMedia(new Map([['m1', media]]));
  const engine = new FakeEngine();
  const config = makeImageConfig({ formats: ['jpeg', 'webp'], ...opts.config });
  const decoder = opts.decoder ?? new FakePngDecoder();
  const registry = new PipelineRegistry(pipelines);
  const deps: ProcessorDeps = {
    catalog: new Catalog({
      config,
      versionOf: (p) => (registry.has(p) ? registry.get(p).version : undefined),
    }),
    media: store,
    storage,
    decoders: {
      identify: async (bytes: Buffer) => ({
        decoder,
        info: await decoder.inspect(bytes, config.limits),
      }),
    } as unknown as DecoderSet,
    engine,
    pipelines: registry,
    hooks: new HookBus({ logger, taps: opts.taps }),
    config,
    logger,
    name: 'default',
  };
  const fileOf = (row: Preview) => {
    const file = files.get(refKey(row.storageRef));
    assert.ok(file, `${row.sizeKey}.${row.format} was uploaded`);
    return file;
  };
  return {
    processor: new Processor(deps),
    engine,
    store,
    fileOf,
    media,
    // The caller's own copy of the document, as a host loads it: generate() changes this one.
    loaded: () => structuredClone(media),
  };
}

const resizes = (engine: FakeEngine) =>
  engine.calls.filter((c) => c.op === 'resize');

const task20x20 = {
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
} as unknown as LeasedTask;

// Eager, with a watermark in plain JS: it paints the bottom-right corner of its own copy of the
// pixels, in place, and every preview must show it.
{
  const seenChannels: number[] = [];
  const { processor, engine, fileOf, loaded } = processorOn({
    marked: {
      variantSteps: [
        (raster) => {
          const { width, height, channels } = raster.info;
          seenChannels.push(channels);
          for (let y = height - 2; y < height; y++) {
            for (let x = width - 2; x < width; x++) {
              raster.data.set([1, 2, 3], (y * width + x) * channels);
            }
          }
          return raster;
        },
      ],
    },
  });
  const { created, failed } = await processor.generate({
    media: loaded(),
    sizes: [{ width: 32 }, { width: 16, height: 16 }, { fit: true }],
    pipeline: 'marked',
  });
  assert.equal(failed, 0);
  assert.equal(created.length, 6);
  // A row can agree with its file and both be wrong, so the sizes are named.
  const expected: Record<string, [number, number]> = {
    '32w': [32, 24],
    '16x16': [16, 16],
    fit: [W, H],
  };
  for (const row of created) {
    const { data, info } = decodePng(fileOf(row));
    assert.deepEqual(
      [info.width, info.height],
      [row.actualWidth, row.actualHeight],
    );
    assert.deepEqual([info.width, info.height], expected[row.sizeKey]);
    const last = (info.height * info.width - 1) * info.channels;
    assert.deepEqual(
      [...data.subarray(last, last + 3)],
      [1, 2, 3],
      `${row.sizeKey}.${row.format} has the mark`,
    );
    assert.ok(row.origin && row.encodeSig, 'rows are signed');
  }
  // jpeg is flattened (the fake then writes 3 channels), webp keeps alpha, and a step sees alpha.
  const channelsOf = (format: string) =>
    decodePng(fileOf(created.find((r) => r.format === format) as Preview)).info
      .channels;
  assert.equal(channelsOf('jpeg'), 3);
  assert.equal(channelsOf('webp'), 4);
  assert.ok(seenChannels.every((channels) => channels === 4));
  assert.ok(
    engine.calls.some((c) => c.op === 'encode' && c.background === '#ffffff'),
  );
  // { fit: true } on a 64×48 source is its own size with no sharpen: no resize at all.
  assert.equal(resizes(engine).length, 2);
  assert.equal(engine.calls.filter((c) => c.op === 'encode').length, 6);
}

// The other sizes, unstored: a height alone, a source no larger than its box keeps its own size, and
// a width larger than the source enlarges it.
{
  const { processor, store, fileOf, loaded } = processorOn({ default: {} });
  const { created, failed } = await processor.generate({
    media: loaded(),
    sizes: [{ height: 24 }, { width: 100, height: 100 }, { width: 128 }],
    formats: ['webp'],
    persist: false,
  });
  assert.equal(failed, 0);
  assert.deepEqual(
    created.map((row) => {
      const { info } = decodePng(fileOf(row));
      return [row.sizeKey, info.width, info.height];
    }),
    [
      ['24h', 32, 24],
      ['100x100', W, H],
      ['128w', 128, 96],
    ],
  );
  assert.equal(store.appendCalls.length, 0);
}

// A beforeStep in plain JS: the raster goes through the reduction to the plan's box, then its size.
{
  const { processor, engine, fileOf, loaded } = processorOn({
    tinted: {
      beforeSteps: [
        ({ data, info }) => ({ data: Buffer.from(data).fill(77), info }),
      ],
    },
  });
  const { created, failed } = await processor.generate({
    media: loaded(),
    sizes: [{ width: 16, height: 16 }],
    formats: ['webp'],
    pipeline: 'tinted',
  });
  assert.equal(failed, 0);
  assert.deepEqual(
    resizes(engine).map((c) => c.mode),
    ['fill', 'cover'],
  );
  const { data, info } = decodePng(fileOf(created[0]));
  assert.deepEqual([info.width, info.height, data[0]], [16, 16, 77]);
}

// A beforeStep that changes the size made a new image: the plan is made again from its pixels.
{
  const { processor, fileOf, loaded } = processorOn({
    topHalf: {
      beforeSteps: [
        ({ data, info }) => ({
          data: data.subarray(0, info.width * (H / 2) * info.channels),
          info: { ...info, height: H / 2 },
        }),
      ],
    },
  });
  const { created, failed } = await processor.generate({
    media: loaded(),
    sizes: [{ fit: true }],
    formats: ['webp'],
    pipeline: 'topHalf',
  });
  assert.equal(failed, 0);
  const { info } = decodePng(fileOf(created[0]));
  assert.deepEqual([info.width, info.height], [W, H / 2]);
}

// An animation: every frame of the decoder's stack is resized on its own and encoded together, and
// a format the engine does not animate, at the same size, is written from the first frame.
{
  const frames = 3;
  class ThreeFrames extends FakePngDecoder {
    async inspect(bytes: Buffer) {
      return {
        ...(await super.inspect(bytes)),
        pages: frames,
        animated: true,
      };
    }
    async render(bytes: Buffer, box: DecodeBox, opts: RenderOptions) {
      assert.equal(opts.frames, frames);
      const { data, info } = await super.render(bytes, box, opts);
      return {
        data: Buffer.concat(Array.from({ length: frames }, () => data)),
        info: { ...info, frames, delay: [100, 100, 100], loop: 0 },
      };
    }
  }
  const { processor, engine, fileOf, loaded } = processorOn(
    { default: {} },
    { decoder: new ThreeFrames(), config: { animated: true } },
  );
  const { created, failed } = await processor.generate({
    media: loaded(),
    sizes: [{ width: 16, height: 12 }],
  });
  assert.equal(failed, 0);
  assert.equal(resizes(engine).length, frames);
  const heightOf = (format: string) =>
    decodePng(fileOf(created.find((r) => r.format === format) as Preview)).info
      .height;
  // encodePng stacks the frames, so an animated file is three frames high.
  assert.equal(heightOf('webp'), 12 * frames);
  assert.equal(heightOf('jpeg'), 12);
}

// A grey source, with and without alpha: the core asks for a resize even at its own size, because
// an encoder gets colour, and the engine returns it.
for (const [channels, written] of [
  [1, 3],
  [2, 4],
] as const) {
  const source = encodePng({
    data: Buffer.alloc(W * H * channels, 120),
    info: { width: W, height: H, channels },
  });
  const { processor, engine, fileOf, loaded } = processorOn(
    { default: {} },
    { source },
  );
  const { created, failed } = await processor.generate({
    media: loaded(),
    sizes: [{ fit: true }],
    formats: ['webp'],
  });
  assert.equal(failed, 0);
  assert.equal(resizes(engine).length, 1);
  assert.equal(decodePng(fileOf(created[0])).info.channels, written);
}

// A decoder's premultiplied raster reaches the steps and the engine as straight alpha.
{
  class Premultiplied extends FakePngDecoder {
    async render(bytes: Buffer, box: DecodeBox, opts: RenderOptions) {
      const { data, info } = await super.render(bytes, box, opts);
      return { data, info: { ...info, premultiplied: true } };
    }
  }
  const source = encodePng({
    data: Buffer.from([100, 50, 25, 128]),
    info: { width: 1, height: 1, channels: 4 },
  });
  const { processor, fileOf, loaded } = processorOn(
    { default: {} },
    { decoder: new Premultiplied(), source },
  );
  const { created, failed } = await processor.generate({
    media: loaded(),
    sizes: [{ fit: true }],
    formats: ['webp'],
  });
  assert.equal(failed, 0);
  assert.deepEqual(
    [...decodePng(fileOf(created[0])).data],
    [199, 100, 50, 128],
  );
}

// An original with no stored size: the render measures it, and the store and the caller's copy get
// the dimensions, eager and queued.
{
  const { processor, media } = processorOn(
    { default: {} },
    { storedSize: false },
  );
  await processor.processTask(task20x20);
  assert.deepEqual([media.original?.width, media.original?.height], [W, H]);
}
{
  const { processor, store, media, loaded } = processorOn(
    { default: {} },
    { storedSize: false },
  );
  const caller = loaded();
  const { failed } = await processor.generate({
    media: caller,
    sizes: [{ width: 32 }],
    formats: ['webp'],
  });
  assert.equal(failed, 0);
  assert.deepEqual(store.appendCalls[0].backfillDims, { width: W, height: H });
  for (const { original } of [media, caller]) {
    assert.deepEqual([original?.width, original?.height], [W, H]);
  }
}

// Queued: the task path, which also reads the media back and checks what the store kept.
{
  const { processor, engine, fileOf, media } = processorOn({ default: {} });
  assert.deepEqual(await processor.processTask(task20x20), {
    requested: 1,
    rendered: 1,
  });
  const [row] = media.previews ?? [];
  const { info } = decodePng(fileOf(row));
  assert.deepEqual([info.width, info.height], [20, 20]);
  assert.equal(resizes(engine).length, 1);
}

// A stale row, here one made with other settings: rendered again and replaced in one write, eager
// and queued, and each removed row reaches its observer.
{
  const removed: Preview[] = [];
  const { processor, store, media, loaded } = processorOn(
    { default: {} },
    {
      taps: {
        onPreviewReplaced: (row) => {
          removed.push(row);
        },
      },
    },
  );
  const makeStale = () => {
    const [row] = media.previews ?? [];
    row.encodeSig = 'made with other settings';
    return row;
  };
  await processor.processTask(task20x20);
  const stale = makeStale();
  const { created, replaced } = await processor.generate({
    media: loaded(),
    sizes: [{ width: 20, height: 20 }],
    formats: ['webp'],
  });
  assert.deepEqual(replaced, [stale.storageRef]);
  assert.deepEqual(media.previews, created);
  const staleAgain = makeStale();
  assert.deepEqual(await processor.processTask(task20x20), {
    requested: 1,
    rendered: 1,
  });
  assert.equal(store.replaceCalls.length, 2);
  assert.deepEqual(removed, [stale, staleAgain]);
  assert.equal(media.previews?.length, 1);
  assert.notEqual(media.previews?.[0].encodeSig, 'made with other settings');
}

assert.deepEqual(problems, [], 'the run logged no warning and no error');
console.log('rendered without sharp');
