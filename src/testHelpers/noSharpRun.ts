// Test-only: the whole render path of the Processor, eager and queued, on a fake engine and a fake
// decoder. customEngine.test.ts runs this file in a process where importing Sharp throws, so nothing
// on that path can lean on Sharp, also where src/importGraph.test.ts cannot see it: a `require`, or
// a dynamic import of a file that imports it. Every branch of render.ts that calls the engine runs
// here, because a lazy import on a branch no section reaches would pass. The Processor gets no
// Resizer and a small decoder set of its own, because src/decoderSet.ts and src/engineCheck.ts
// import the built-in decoders and engine, and so Sharp.
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
import { fakeMedia, memoryStorage, refKey } from './fakes.ts';
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
  } = {},
) {
  const { storage, files } = memoryStorage();
  files.set('o', png);
  const media: MediaLike = {
    id: 'm1',
    original: {
      storageRef: { key: 'o' },
      format: 'png',
      contentType: 'image/png',
      size: png.length,
      width: W,
      height: H,
    },
    previews: [],
  };
  const engine = new FakeEngine();
  const config = makeImageConfig({ formats: ['jpeg', 'webp'], ...opts.config });
  const decoder = opts.decoder ?? new FakePngDecoder();
  const registry = new PipelineRegistry(pipelines);
  const deps: ProcessorDeps = {
    catalog: new Catalog({
      config,
      versionOf: (p) => (registry.has(p) ? registry.get(p).version : undefined),
    }),
    media: fakeMedia({
      load: async () => media,
      appendPreviews: async (_id: string, rows: Preview[]) => {
        media.previews = [...(media.previews ?? []), ...rows];
        return rows;
      },
    }),
    storage,
    decoders: {
      identify: async (bytes: Buffer) => ({
        decoder,
        info: await decoder.inspect(bytes, config.limits),
      }),
    } as unknown as DecoderSet,
    engine,
    pipelines: registry,
    hooks: new HookBus({ logger }),
    config,
    logger,
    name: 'default',
  };
  const fileOf = (row: Preview) => {
    const file = files.get(refKey(row.storageRef));
    assert.ok(file, `${row.sizeKey}.${row.format} was uploaded`);
    return file;
  };
  return { processor: new Processor(deps), engine, fileOf, media };
}

// Eager, with a watermark in plain JS: it paints the bottom-right corner of its own copy of the
// pixels, in place, and every preview must show it.
{
  const seenChannels: number[] = [];
  const { processor, engine, fileOf, media } = processorOn({
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
    media,
    sizes: [{ width: 32 }, { width: 16, height: 16 }, { fit: true }],
    pipeline: 'marked',
  });
  assert.equal(failed, 0);
  assert.equal(created.length, 6);
  for (const row of created) {
    const { data, info } = decodePng(fileOf(row));
    assert.deepEqual(
      [info.width, info.height],
      [row.actualWidth, row.actualHeight],
    );
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
  assert.equal(engine.calls.filter((c) => c.op === 'resize').length, 2);
  assert.equal(engine.calls.filter((c) => c.op === 'encode').length, 6);
}

// A beforeStep in plain JS: the raster goes through the reduction to the plan's box, then its size.
{
  const { processor, engine, fileOf, media } = processorOn({
    tinted: {
      beforeSteps: [
        ({ data, info }) => ({ data: Buffer.from(data).fill(77), info }),
      ],
    },
  });
  const { created, failed } = await processor.generate({
    media,
    sizes: [{ width: 16, height: 16 }],
    formats: ['webp'],
    pipeline: 'tinted',
  });
  assert.equal(failed, 0);
  assert.deepEqual(
    engine.calls.filter((c) => c.op === 'resize').map((c) => c.mode),
    ['fill', 'cover'],
  );
  const { data } = decodePng(fileOf(created[0]));
  assert.equal(data[0], 77);
}

// An animation: every frame of the decoder's stack is resized on its own and encoded together.
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
        info: { ...info, frames },
      };
    }
  }
  const { processor, engine, fileOf, media } = processorOn(
    { default: {} },
    {
      decoder: new ThreeFrames(),
      config: { animated: true, formats: ['webp'] },
    },
  );
  const { created, failed } = await processor.generate({
    media,
    sizes: [{ width: 16, height: 12 }],
  });
  assert.equal(failed, 0);
  assert.equal(engine.calls.filter((c) => c.op === 'resize').length, frames);
  // encodePng stacks the frames, so the file is three frames high.
  const { info } = decodePng(fileOf(created[0]));
  assert.deepEqual([info.width, info.height], [16, 12 * frames]);
}

// Queued: the task path, which also reads the media back and checks what the store kept.
{
  const { processor, engine, fileOf, media } = processorOn({ default: {} });
  const task = {
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
  assert.deepEqual(await processor.processTask(task), {
    requested: 1,
    rendered: 1,
  });
  const [row] = media.previews ?? [];
  const { info } = decodePng(fileOf(row));
  assert.deepEqual([info.width, info.height], [20, 20]);
  assert.equal(engine.calls.filter((c) => c.op === 'resize').length, 1);
}

assert.deepEqual(problems, [], 'the run logged no warning and no error');
console.log('rendered without sharp');
