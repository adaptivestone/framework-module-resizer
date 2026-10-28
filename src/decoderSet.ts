// The decoders of one Resizer, in the order they are asked: the host's own first, so a host
// decoder can take over a built-in format, then the built-in ones. It chooses the decoder for a
// source's bytes and checks what each decoder's `inspect` reports. It does not log: the caller
// logs a mismatch between the stored and the detected format.
import type { SourceDecoder, SourceInfo } from './contracts/decoder.ts';
import { SharpDecoder } from './decoders/sharp.ts';
import { ResizeError, ResizeMediaError, ResizeSetupError } from './errors.ts';
import type { ResizeLimits } from './types.d.ts';

const UNSUPPORTED = 'RESIZE_SOURCE_FORMAT_UNSUPPORTED';

/** The decoder that read a source's bytes, and what it measured. */
export interface IdentifiedSource {
  decoder: SourceDecoder;
  info: SourceInfo;
  /**
   * Set when a stored format was given and the probe chose the decoder: no decoder lists the
   * stored format (`unlisted`), or the decoder that lists it refused the bytes (`refused`).
   */
  mismatch?: { stored: string; reason: 'unlisted' | 'refused' };
}

/** A decoder saying "these bytes are not my format": the next decoder is asked. */
function isRefusal(err: unknown): boolean {
  return ResizeError.isResizeError(err) && err.code === UNSUPPORTED;
}

function isPositiveFinite(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Why `info` breaks the decoder contract, or undefined when it keeps it. */
function infoProblem(
  decoder: SourceDecoder,
  info: SourceInfo,
): string | undefined {
  if (typeof info !== 'object' || info === null) {
    return 'its inspect() resolved with no object';
  }
  if (!decoder.formats.includes(info.format)) {
    return `its inspect() reported format '${String(info.format)}', which it does not list`;
  }
  if (typeof info.contentType !== 'string' || info.contentType === '') {
    return 'its inspect() reported no contentType';
  }
  if (!isPositiveFinite(info.width) || !isPositiveFinite(info.height)) {
    return `its inspect() reported the size ${String(info.width)}×${String(info.height)}`;
  }
  if (
    info.pages !== undefined &&
    !(Number.isInteger(info.pages) && info.pages > 0)
  ) {
    return `its inspect() reported ${String(info.pages)} pages`;
  }
  return undefined;
}

async function inspectChecked(
  decoder: SourceDecoder,
  bytes: Buffer,
  limits: ResizeLimits,
): Promise<SourceInfo> {
  const info = await decoder.inspect(bytes, limits);
  const problem = infoProblem(decoder, info);
  if (problem !== undefined) {
    throw new ResizeSetupError(
      `resize: the decoder of [${decoder.formats.join(', ')}] broke its contract: ${problem}`,
      { code: 'RESIZE_DECODER_INVALID' },
    );
  }
  return info;
}

export class DecoderSet {
  readonly decoders: readonly SourceDecoder[];

  constructor(decoders: readonly SourceDecoder[]) {
    this.decoders = Object.freeze([...decoders]);
  }

  /** The first decoder that lists `format`. */
  forFormat(format: string): SourceDecoder | undefined {
    return this.decoders.find((decoder) => decoder.formats.includes(format));
  }

  /**
   * Choose the decoder for `bytes`. A stored format (only a non-empty string counts) picks the
   * decoder to try first; without one, or when that decoder refuses or none lists the format,
   * the decoders are asked in order.
   */
  async identify(
    bytes: Buffer,
    limits: ResizeLimits,
    storedFormat?: unknown,
  ): Promise<IdentifiedSource> {
    if (typeof storedFormat !== 'string' || storedFormat === '') {
      return this.#probe(bytes, limits, this.decoders);
    }
    const listed = this.forFormat(storedFormat);
    let refusal: unknown;
    if (listed !== undefined) {
      try {
        return {
          decoder: listed,
          info: await inspectChecked(listed, bytes, limits),
        };
      } catch (err) {
        if (!isRefusal(err)) {
          throw err;
        }
        refusal = err;
      }
    }
    const reason = listed === undefined ? 'unlisted' : 'refused';
    let found: IdentifiedSource;
    try {
      found = await this.#probe(
        bytes,
        limits,
        this.decoders.filter((decoder) => decoder !== listed),
        listed === undefined ? undefined : { decoder: listed, refusal },
      );
    } catch (err) {
      // A worker without the decoder this record needs: a deploy with it can run the task. A
      // ResizeError other than "every decoder refused" means a decoder recognised its format.
      if (
        reason === 'unlisted' &&
        (isRefusal(err) || !ResizeError.isResizeError(err))
      ) {
        const message = err instanceof Error ? err.message : String(err);
        // The task row keeps only String(error), so the probe's message is part of this one.
        throw new ResizeSetupError(
          `resize: no decoder lists format '${storedFormat}' and none reads the bytes (${message}) — pass one in \`decoders\` in every process that uploads or generates previews (API and worker)`,
          { code: 'RESIZE_DECODER_MISSING', cause: err },
        );
      }
      throw err;
    }
    return { ...found, mismatch: { stored: storedFormat, reason } };
  }

  /** Each decoder's optional verify(), in order. */
  async verify(): Promise<void> {
    for (const decoder of this.decoders) {
      await decoder.verify?.();
    }
  }

  /**
   * Ask `candidates` in order; the first that accepts wins. A refusal moves on, any other
   * rejection is final. `earlier` is a decoder that already refused these bytes: it is named
   * among the formats tried, and its refusal is the first.
   */
  async #probe(
    bytes: Buffer,
    limits: ResizeLimits,
    candidates: readonly SourceDecoder[],
    earlier?: { decoder: SourceDecoder; refusal: unknown },
  ): Promise<IdentifiedSource> {
    let firstRefusal = earlier?.refusal;
    for (const decoder of candidates) {
      try {
        return { decoder, info: await inspectChecked(decoder, bytes, limits) };
      } catch (err) {
        if (!isRefusal(err)) {
          throw err;
        }
        firstRefusal ??= err;
      }
    }
    const tried = [...(earlier ? [earlier.decoder] : []), ...candidates].map(
      (decoder) => `[${decoder.formats.join(', ')}]`,
    );
    throw new ResizeMediaError(
      `resize: no decoder reads these bytes (tried ${tried.length > 0 ? tried.join(', ') : 'none'})`,
      { code: UNSUPPORTED, retryable: false, cause: firstRefusal },
    );
  }
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value !== '';
}

/** True when `entry` has the shape of a decoder: a formats list and inspect and render. */
function isDecoderShape(entry: unknown): entry is SourceDecoder {
  if (typeof entry !== 'object' || entry === null) {
    return false;
  }
  const { formats, inspect, render } = entry as Record<string, unknown>;
  return (
    Array.isArray(formats) &&
    formats.length > 0 &&
    formats.every(isNonEmptyString) &&
    typeof inspect === 'function' &&
    typeof render === 'function'
  );
}

/**
 * The decoder set of a Resizer: `extra` (the host's decoders, checked here) before the built-in
 * ones. The core never checks `instanceof`: any object of the decoder's shape is accepted.
 */
export function createDecoderSet(extra?: unknown): DecoderSet {
  // Only `undefined` means "no decoders": `null` is not a list.
  const given = extra === undefined ? [] : extra;
  if (!Array.isArray(given)) {
    throw new ResizeSetupError(
      'resize: `decoders` must be an array of decoders (objects with `formats`, `inspect` and `render`)',
      { code: 'RESIZE_DECODER_INVALID' },
    );
  }
  given.forEach((entry, index) => {
    if (!isDecoderShape(entry)) {
      throw new ResizeSetupError(
        `resize: decoders[${index}] is not a decoder — it needs a non-empty \`formats\` list of format ids and \`inspect\` and \`render\` functions`,
        { code: 'RESIZE_DECODER_INVALID' },
      );
    }
  });
  return new DecoderSet([...(given as SourceDecoder[]), new SharpDecoder()]);
}
