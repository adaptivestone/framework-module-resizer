// The pixel work on decoded rasters: straight alpha once on the decoded raster, the beforeSteps
// chain, the box reduction after it, one render per exact size, and the encode of each format from
// it. No image library here: every pixel operation is a call on the engine. What an engine returns
// is checked here, because the core relies on it. Every function but `straightAlpha` takes a
// straight-alpha raster: the Processor converts a premultiplied one first, and so do both step
// chains for a step's result, so nothing here forwards a premultiplied flag.
import type {
  DecodeBox,
  Raster,
  RasterInfo,
  SourceInfo,
} from './contracts/decoder.ts';
import type {
  EncodedImage,
  EngineCallOptions,
  ImageEngine,
  ResizeRequest,
} from './contracts/engine.ts';
import type { BeforeStep, VariantStep } from './contracts/pipeline.ts';
import { ResizeError, ResizeMediaError, ResizeSetupError } from './errors.ts';
import { limitStepRaster, rasterProblem } from './helpers/raster.ts';
import type { SizePlan, VariantPlan } from './plan.ts';
import type { MediaLike, ResizeConfig, ResizeLimits } from './types.d.ts';

/**
 * Whether a resize result has the requested size. A `coverBox` request only has to cover its box,
 * within a pixel of the computed size: Sharp's `fit: 'outside'` rounds exact halves its own way.
 */
function sizeFits(info: RasterInfo, req: ResizeRequest): boolean {
  if (req.coverBox === undefined) {
    return info.width === req.width && info.height === req.height;
  }
  return (
    Math.abs(info.width - req.width) <= 1 &&
    Math.abs(info.height - req.height) <= 1 &&
    info.width >= req.coverBox.width &&
    info.height >= req.coverBox.height
  );
}

/** A resize result the plan can rely on, or an engine contract error. */
async function resized(
  engine: ImageEngine,
  frame: Raster,
  req: ResizeRequest,
  opts: EngineCallOptions,
): Promise<Raster> {
  const out = await engine.resize(frame, req, opts);
  const problem =
    rasterProblem(out) ??
    (!sizeFits(out.info, req)
      ? `it is ${out.info.width}×${out.info.height}, not ${req.width}×${req.height}`
      : (out.info.frames ?? 1) !== 1
        ? `it has ${out.info.frames} frames`
        : undefined);
  if (problem !== undefined) {
    throw new ResizeSetupError(
      `resize: engine '${engine.id}' broke its contract: the result of resize(): ${problem}`,
      { code: 'RESIZE_ENGINE_INVALID' },
    );
  }
  return out;
}

/**
 * An encode result a row can record, or an engine contract error: hosts read this size through
 * `formatPictureUrls`, and `format` becomes the file extension. The content type is a guard against
 * a mislabelled file, not a boundary: an engine is host code.
 */
function checkEncoded(
  engine: ImageEngine,
  out: EncodedImage,
  raster: Raster,
): void {
  const positive = (n: unknown) => Number.isInteger(n) && (n as number) > 0;
  const { width, height } = raster.info;
  const problem = !Buffer.isBuffer(out?.data)
    ? '`data` is not a Buffer'
    : out.data.length === 0
      ? '`data` is empty'
      : typeof out.format !== 'string' || out.format === ''
        ? 'no `format`'
        : !/^[a-z0-9]+$/i.test(out.format)
          ? `the \`format\` '${out.format}' is not a file extension`
          : typeof out.contentType !== 'string' || out.contentType === ''
            ? 'no `contentType`'
            : !/^image\/[a-z0-9.+-]+$/i.test(out.contentType)
              ? `the \`contentType\` '${out.contentType}' is not an image type`
              : !positive(out.width) || !positive(out.height)
                ? `the size ${String(out.width)}×${String(out.height)}`
                : out.width !== width || out.height !== height
                  ? `it is ${out.width}×${out.height}, not ${width}×${height}`
                  : undefined;
  if (problem !== undefined) {
    throw new ResizeSetupError(
      `resize: engine '${engine.id}' broke its contract: the result of encode(): ${problem}`,
      { code: 'RESIZE_ENGINE_INVALID' },
    );
  }
}

/** The raster as straight alpha: itself unless its bytes are marked premultiplied. Plain JS (D8). */
export function straightAlpha(raster: Raster): Raster {
  if (raster.info.premultiplied !== true) {
    return raster;
  }
  const { premultiplied: _dropped, ...info } = raster.info;
  const { channels } = info;
  if (channels !== 2 && channels !== 4) {
    return { data: raster.data, info };
  }
  // Off the shared pool: the result is the next step's input, which owns its memory.
  const data = Buffer.allocUnsafeSlow(raster.data.length);
  const colours = channels - 1;
  for (let i = 0; i < data.length; i += channels) {
    const alpha = raster.data[i + colours];
    data[i + colours] = alpha;
    for (let c = 0; c < colours; c++) {
      data[i + c] =
        alpha === 0
          ? 0
          : Math.min(255, Math.round((raster.data[i + c] * 255) / alpha));
    }
  }
  return { data, info };
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

/** What a step resolved with, as a one-frame Raster, or a step error naming the problem. */
function stepResult(
  value: unknown,
  kind: 'beforeStep' | 'variantStep',
): Raster {
  const frames = (value as { info?: RasterInfo } | null)?.info?.frames;
  // The usual slip when porting a Sharp step: it forgot to read the pixels back.
  const isSharp =
    typeof (value as { toBuffer?: unknown } | null)?.toBuffer === 'function';
  const problem = isSharp
    ? 'it is a Sharp instance, not its pixels: return sharpToRaster(img)'
    : Buffer.isBuffer(value)
      ? 'it is a Buffer, not a Raster: return { data, info } (with Sharp: sharpToRaster(img), not img.toBuffer())'
      : (rasterProblem(value) ??
        (frames !== undefined && frames !== 1
          ? `\`info.frames\` is ${frames}, not 1`
          : undefined));
  if (problem !== undefined) {
    throw new ResizeSetupError(
      `resize: a ${kind} resolved with something that is not a one-frame Raster: ${problem} — a ${kind} receives and returns a Raster ({ data, info }), whatever the engine; rasterToSharp / sharpToRaster wrap a Sharp step`,
      { code: 'RESIZE_PIPELINE_STEP_INVALID' },
    );
  }
  const raster = value as Raster;
  // Sharp's own `{ data, info }` from `toBuffer({ resolveWithObject: true })`: after a resize its
  // flag says premultiplied on straight bytes (see readRaster). A raster a step built has no
  // `format`, and its flag is believed.
  if ((raster.info as { format?: unknown }).format === 'raw') {
    const { premultiplied: _dropped, ...info } = raster.info;
    return { data: raster.data, info };
  }
  return raster;
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
): Promise<Raster> {
  return stepChain(firstFrame(raster), steps, meta);
}

/**
 * Holds only the current raster, in its one binding: a step's input is dropped as soon as the step
 * resolves (unless the step keeps it), so the peak is one step's input and its output.
 */
async function stepChain(
  raster: Raster,
  steps: readonly BeforeStep[],
  meta: BeforeStepMeta,
): Promise<Raster> {
  for (const step of steps) {
    const scale = raster.info.width / meta.source.width;
    raster = stepResult(await step(raster, { ...meta, scale }), 'beforeStep');
    raster = straightAlpha(raster);
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
  engine: ImageEngine,
  opts: EngineCallOptions,
): Promise<Raster> {
  const frame = firstFrame(raster);
  const { width, height } = frame.info;
  if (width <= box.width || height <= box.height) {
    return frame;
  }
  // One factor, the smaller, then each side rounded: Sharp's `fit: 'outside'` up to exact halves,
  // which it can round the other way (see sizeFits). The engine's own size is kept.
  const factor = Math.min(width / box.width, height / box.height);
  return resized(
    engine,
    frame,
    {
      width: Math.round(width / factor),
      height: Math.round(height / factor),
      mode: 'fill',
      sharpen: false,
      coverBox: box,
    },
    opts,
  );
}

/** One frame resized to the size's exact width and height, as sRGB. */
function resizeFrame(
  frame: Raster,
  size: SizePlan,
  engine: ImageEngine,
  opts: EngineCallOptions,
): Promise<Raster> {
  return resized(
    engine,
    frame,
    {
      width: size.width,
      height: size.height,
      mode: size.mode,
      sharpen: size.sharpen,
    },
    opts,
  );
}

/**
 * The raster at the size's exact width and height. An animated size keeps every frame and its
 * timing; any other size is made from the first frame.
 */
export async function renderSize(
  raster: Raster,
  size: SizePlan,
  engine: ImageEngine,
  opts: EngineCallOptions,
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
    return resizeFrame(source, size, engine, opts);
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
  const first = await resizeFrame(frameAt(0), size, engine, opts);
  const outBytes = first.data.length;
  const stack = Buffer.allocUnsafe(frames * outBytes);
  first.data.copy(stack, 0);
  for (let i = 1; i < frames; i++) {
    const { data } = await resizeFrame(frameAt(i), size, engine, opts);
    if (data.length !== outBytes) {
      throw new ResizeSetupError(
        `resize: engine '${engine.id}' broke its contract: the result of resize(): frame ${i} holds ${data.length} bytes, not ${outBytes} like the first frame`,
        { code: 'RESIZE_ENGINE_INVALID' },
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
  readonly #engine: ImageEngine;
  readonly #opts: EngineCallOptions;
  /** Variants not yet released, per size key. */
  readonly #pending = new Map<string, number>();
  readonly #rendered = new Map<string, Promise<Raster>>();

  constructor(
    raster: Raster,
    plans: readonly VariantPlan[],
    engine: ImageEngine,
    opts: EngineCallOptions,
  ) {
    this.#raster = raster;
    this.#engine = engine;
    this.#opts = opts;
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
      rendered = renderSize(this.#raster, size, this.#engine, this.#opts);
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
  engine: ImageEngine;
  media: MediaLike;
  source: SourceInfo;
  signal?: AbortSignal;
}

export type EncodedVariant = EncodedImage;

/**
 * Past its timeout, its lease or the shutdown, a task's result counts for nothing, so its variants
 * stop spending threads and memory. What is already past its steps goes on, and the delivery can
 * still store those rows (see the consumer: media writes are not fenced).
 */
function stopIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ResizeError(
      'resize: the task stopped, so the remaining steps and the encode of this variant did not run',
      { code: 'RESIZE_TASK_ABORTED' },
    );
  }
}

/**
 * The variant's steps in order, from its own copy of the sized pixels: other formats share them.
 * The copy gets its own ArrayBuffer: `Buffer.from` would take a small one from Node's shared pool,
 * where a step writing through `data.buffer` reaches the other formats and unrelated Buffers. Each
 * raster handed to a step carries the limit, for `rasterToSharp` to read. A running step cannot be
 * interrupted, but a stopped task's remaining steps and encode do not run.
 */
async function runVariantSteps(
  sized: Raster,
  plan: VariantPlan,
  opts: EncodeOptions,
): Promise<Raster> {
  stopIfAborted(opts.signal);
  const data = Buffer.allocUnsafeSlow(sized.data.length);
  sized.data.copy(data);
  let raster: Raster = { data, info: { ...sized.info } };
  for (const step of opts.variantSteps) {
    limitStepRaster(raster, opts.limits.processingTimeoutSeconds);
    raster = straightAlpha(
      stepResult(
        await step(raster, {
          variant: plan.variant,
          ctx: opts.ctx,
          media: opts.media,
          source: opts.source,
        }),
        'variantStep',
      ),
    );
    stopIfAborted(opts.signal);
  }
  return raster;
}

/** One preview file: variantSteps on the sized pixels, then the engine's flatten and encoder. */
export async function encodeVariant(
  sized: Raster,
  plan: VariantPlan,
  opts: EncodeOptions,
): Promise<EncodedVariant> {
  const { format } = plan.variant;
  const { engine } = opts;
  const source = engine.animatedFormats.includes(format)
    ? sized
    : firstFrame(sized);
  const raster =
    opts.variantSteps.length > 0
      ? await runVariantSteps(source, plan, opts)
      : source;
  // From the step's result: transparency a step adds is flattened, and one it removes needs no
  // background.
  const { channels } = raster.info;
  const flatten =
    (channels === 2 || channels === 4) &&
    opts.encode.flatten.formats.includes(format);
  const encoded = await engine.encode(
    raster,
    {
      format,
      options: opts.encode.formats[format] ?? {},
      ...(flatten ? { background: opts.encode.flatten.background } : {}),
    },
    { limits: opts.limits, signal: opts.signal },
  );
  checkEncoded(engine, encoded, raster);
  if (
    /^(svgz?|x?html?|xml)$/i.test(encoded.format) ||
    /^image\/svg/i.test(encoded.contentType)
  ) {
    throw new ResizeMediaError(
      `resize: engine '${engine.id}' returned '${encoded.format}' (${encoded.contentType}): SVG, HTML and XML cannot be published as a preview`,
      { code: 'RESIZE_SVG_PUBLIC_PREVIEW' },
    );
  }
  return encoded;
}
