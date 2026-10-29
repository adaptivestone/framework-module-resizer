// The Sharp work on decoded rasters, with no port: straight alpha once on the decoded raster, the
// beforeSteps chain, the box reduction after it, one render per exact size, and the encode of each
// format from it. Every function but `straightAlpha` takes a straight-alpha raster: the Processor
// converts a premultiplied one first, and so does `runBeforeSteps` for a step's result, so nothing
// here forwards a premultiplied flag.
import sharp, { type FormatEnum, type OutputOptions } from 'sharp';
import type {
  DecodeBox,
  Raster,
  RasterInfo,
  SourceInfo,
} from './contracts/decoder.ts';
import type { BeforeStep, VariantStep } from './contracts/pipeline.ts';
import { ResizeMediaError, ResizeSetupError } from './errors.ts';
import { isAnimatedFormat, isAvifBuffer } from './helpers/imageFormat.ts';
import type { SizePlan, VariantPlan } from './plan.ts';
import { rasterInput, rasterProblem, readRaster } from './raster.ts';
import type { MediaLike, ResizeConfig, ResizeLimits } from './types.d.ts';

const timeout = (limits: ResizeLimits) => ({
  seconds: limits.processingTimeoutSeconds,
});

/** The raster as straight alpha: itself unless a decoder marked its bytes premultiplied. */
export async function straightAlpha(
  raster: Raster,
  limits: ResizeLimits,
): Promise<Raster> {
  if (raster.info.premultiplied !== true) {
    return raster;
  }
  // Sharp unpremultiplies raw input marked premultiplied on output, with no other operation.
  const { data, info } = await readRaster(
    sharp(raster.data, rasterInput(raster)).timeout(timeout(limits)),
  );
  const { delay, loop } = raster.info;
  return {
    data,
    info: {
      ...info,
      ...(delay !== undefined ? { delay } : {}),
      ...(loop !== undefined ? { loop } : {}),
    },
  };
}

/** The top frame, without timing (the raster itself when it has one frame and no timing). */
export function firstFrame(raster: Raster): Raster {
  const { width, height, channels, frames = 1, delay, loop } = raster.info;
  if (frames === 1 && delay === undefined && loop === undefined) {
    return raster;
  }
  const info: RasterInfo = { width, height, channels };
  if (raster.info.premultiplied === true) {
    info.premultiplied = true;
  }
  return { data: raster.data.subarray(0, width * height * channels), info };
}

export interface BeforeStepMeta {
  media: MediaLike;
  source: SourceInfo;
  ctx: Record<string, unknown>;
}

/** What a beforeStep resolved with, as a one-frame Raster, or a step error naming the problem. */
function stepResult(value: unknown): Raster {
  const frames = (value as { info?: RasterInfo } | null)?.info?.frames;
  const problem =
    rasterProblem(value) ??
    (frames !== undefined && frames !== 1
      ? `\`info.frames\` is ${frames}, not 1`
      : undefined);
  if (problem !== undefined) {
    throw new ResizeSetupError(
      `resize: a beforeStep resolved with something that is not a one-frame Raster: ${problem} — a beforeStep receives and returns a Raster ({ data, info }); rasterToSharp / sharpToRaster wrap a Sharp step`,
      { code: 'RESIZE_PIPELINE_STEP_INVALID' },
    );
  }
  return value as Raster;
}

/**
 * The pipeline's beforeSteps, in order, from the raster's first frame. Each step gets the current
 * raster and `scale` (its width over the source's); what it resolves with must be a one-frame
 * Raster, converted to straight alpha when marked premultiplied, and replaces the current one.
 * Not async itself: the raster is handed to the chain, so this frame keeps no reference to it.
 */
export function runBeforeSteps(
  raster: Raster,
  steps: readonly BeforeStep[],
  meta: BeforeStepMeta,
  limits: ResizeLimits,
): Promise<Raster> {
  return stepChain(firstFrame(raster), steps, meta, limits);
}

/**
 * Holds only the current raster, in its one binding: a step's input is dropped as soon as the step
 * resolves (unless the step keeps it), so the peak is one step's input and its output.
 */
async function stepChain(
  raster: Raster,
  steps: readonly BeforeStep[],
  meta: BeforeStepMeta,
  limits: ResizeLimits,
): Promise<Raster> {
  for (const step of steps) {
    const scale = raster.info.width / meta.source.width;
    raster = stepResult(await step(raster, { ...meta, scale }));
    raster = await straightAlpha(raster, limits);
  }
  return raster;
}

/**
 * One frame, reduced to cover `box` when both of its sides exceed it; otherwise the frame as it is
 * (a raster is never enlarged).
 */
export async function reduceToBox(
  raster: Raster,
  box: DecodeBox,
  limits: ResizeLimits,
): Promise<Raster> {
  const frame = firstFrame(raster);
  if (frame.info.width <= box.width || frame.info.height <= box.height) {
    return frame;
  }
  return readRaster(
    sharp(frame.data, rasterInput(frame))
      .resize(box.width, box.height, { fit: 'outside' })
      .toColorspace('srgb')
      .timeout(timeout(limits)),
  );
}

/** One frame resized to the size's exact width and height, as sRGB. */
function resizeFrame(
  frame: Raster,
  size: SizePlan,
  limits: ResizeLimits,
): Promise<Raster> {
  let img = sharp(frame.data, rasterInput(frame))
    .resize(size.width, size.height, {
      fit: size.mode === 'cover' ? 'cover' : 'fill',
      position: 'center',
    })
    .toColorspace('srgb');
  if (size.sharpen) {
    img = img.sharpen();
  }
  return readRaster(img.timeout(timeout(limits)));
}

/**
 * The raster at the size's exact width and height. An animated size keeps every frame and its
 * timing; any other size is made from the first frame.
 */
export async function renderSize(
  raster: Raster,
  size: SizePlan,
  limits: ResizeLimits,
): Promise<Raster> {
  const source = size.animated ? raster : firstFrame(raster);
  const { width, height, channels, frames = 1, delay, loop } = source.info;
  if (
    width === size.width &&
    height === size.height &&
    !size.sharpen &&
    channels >= 3
  ) {
    return source;
  }
  if (frames === 1) {
    return resizeFrame(source, size, limits);
  }
  // Sharp does not resize a raw multi-page image per frame (the page height goes stale), so each
  // frame is resized on its own, one at a time, and copied into one stack allocated once: the
  // frames are held once, never as a list plus a joined copy. The plan bounds the frames so the
  // stack fits the pixel budget at this size.
  const frameBytes = width * height * channels;
  const frameAt = (i: number): Raster => ({
    data: source.data.subarray(i * frameBytes, (i + 1) * frameBytes),
    info: { width, height, channels },
  });
  const first = await resizeFrame(frameAt(0), size, limits);
  const outBytes = first.data.length;
  const stack = Buffer.allocUnsafe(frames * outBytes);
  first.data.copy(stack, 0);
  for (let i = 1; i < frames; i++) {
    const { data } = await resizeFrame(frameAt(i), size, limits);
    if (data.length !== outBytes) {
      throw new ResizeSetupError(
        `resize: frame ${i} resized to ${data.length} bytes, not ${outBytes} like the first frame`,
      );
    }
    data.copy(stack, i * outBytes);
  }
  const info: RasterInfo = { ...first.info, frames };
  if (delay !== undefined) {
    info.delay = delay;
  }
  if (loop !== undefined) {
    info.loop = loop;
  }
  return { data: stack, info };
}

/** The sized rasters of one task: one render per size key, dropped after its last variant. */
export class SizedRasters {
  #raster: Raster | undefined;
  readonly #limits: ResizeLimits;
  /** Variants not yet released, per size key. */
  readonly #pending = new Map<string, number>();
  readonly #rendered = new Map<string, Promise<Raster>>();

  constructor(
    raster: Raster,
    plans: readonly VariantPlan[],
    limits: ResizeLimits,
  ) {
    this.#raster = raster;
    this.#limits = limits;
    for (const plan of plans) {
      const key = plan.size.key;
      this.#pending.set(key, (this.#pending.get(key) ?? 0) + 1);
    }
  }

  /** The raster at this size, rendered on the first call and shared until released. */
  get(size: SizePlan): Promise<Raster> {
    let rendered = this.#rendered.get(size.key);
    if (rendered === undefined) {
      if (this.#raster === undefined) {
        return Promise.reject(
          new ResizeSetupError(
            'resize: a size was requested after the sized rasters of the task were cleared',
          ),
        );
      }
      rendered = renderSize(this.#raster, size, this.#limits);
      this.#rendered.set(size.key, rendered);
    }
    return rendered;
  }

  /** One variant of this size is done; after the last one the sized raster is dropped. */
  release(size: SizePlan): void {
    const left = (this.#pending.get(size.key) ?? 0) - 1;
    if (left > 0) {
      this.#pending.set(size.key, left);
      return;
    }
    this.#pending.delete(size.key);
    this.#rendered.delete(size.key);
  }

  /**
   * The task's variants are done: drop the base raster and every sized one, including those of
   * variants that never ran (an aborted task), so nothing after the render keeps the pixels.
   */
  clear(): void {
    this.#raster = undefined;
    this.#pending.clear();
    this.#rendered.clear();
  }
}

export interface EncodeOptions {
  variantSteps: readonly VariantStep[];
  ctx: Record<string, unknown>;
  encode: ResizeConfig['encode'];
  limits: ResizeLimits;
}

export interface EncodedVariant {
  data: Buffer;
  format: string;
  contentType: string;
  /** One frame. */
  width: number;
  height: number;
}

/**
 * One delay per frame: a shorter list repeats its last delay (the GIF encoder writes 0 for a frame
 * without one, which plays it as fast as the viewer can), a longer one is cut.
 */
function delayPerFrame(delay: readonly number[], frames: number): number[] {
  return Array.from(
    { length: frames },
    (_, i) => delay[Math.min(i, delay.length - 1)],
  );
}

/** One preview file: variantSteps on the sized pixels, the alpha flatten, then the encoder. */
export async function encodeVariant(
  sized: Raster,
  plan: VariantPlan,
  opts: EncodeOptions,
): Promise<EncodedVariant> {
  const { format } = plan.variant;
  const source = isAnimatedFormat(format) ? sized : firstFrame(sized);
  const { channels, frames = 1, delay, loop } = source.info;
  let img = sharp(source.data, rasterInput(source));
  for (const step of opts.variantSteps) {
    img = await step(img, { variant: plan.variant, ctx: opts.ctx });
  }
  if (
    (channels === 2 || channels === 4) &&
    opts.encode.flatten.formats.includes(format)
  ) {
    img = img.flatten({ background: opts.encode.flatten.background });
  }
  // Raw pixels carry no timing: without the source's, an animation plays at the encoder's default
  // speed and loops once.
  const timing =
    frames > 1
      ? {
          ...(delay !== undefined && delay.length > 0
            ? { delay: delayPerFrame(delay, frames) }
            : {}),
          ...(loop !== undefined ? { loop } : {}),
        }
      : {};
  const { data, info } = await img
    .toFormat(
      format as keyof FormatEnum,
      {
        ...timing,
        ...opts.encode.formats[format],
      } as OutputOptions,
    )
    .timeout(timeout(opts.limits))
    .toBuffer({ resolveWithObject: true });
  // Sharp reports AVIF output through its HEIF container id; the brands in the bytes tell them
  // apart, so a configured `heif: { compression: 'av1' }` gets the AVIF type and extension too.
  const outputFormat =
    info.format === 'heif' && isAvifBuffer(data) ? 'avif' : info.format;
  if (outputFormat === 'svg') {
    throw new ResizeMediaError('resize: SVG cannot be published as a preview', {
      code: 'RESIZE_SVG_PUBLIC_PREVIEW',
    });
  }
  return {
    data,
    format: outputFormat,
    contentType: `image/${outputFormat}`,
    width: info.width,
    height: info.pageHeight ?? info.height,
  };
}
