// Stores an original as uploaded. The decoders measure it (format, size, frames) to check the
// upload rules, and with `upload.verify: 'decode'` decode it once; the bytes go to storage unchanged.
// It needs only the storage, the decoders and the image config; it creates no media, queues no work
// and logs nothing. Each upload is timed and counted on the metrics sink, stored or rejected.
import type { SourceDecoder, SourceInfo } from './contracts/decoder.ts';
import type { ResizeMetrics } from './contracts/metrics.ts';
import type { ResizeStorage } from './contracts/storage.ts';
import type { DecoderSet, IdentifiedSource } from './decoderSet.ts';
import {
  type ResizeError,
  ResizeOriginalError,
  ResizeStorageError,
} from './errors.ts';
import { hasErrorClass } from './helpers/errorClass.ts';
import { isModuleError, messageText } from './helpers/log.ts';
import { randomHex } from './helpers/random.ts';
import { engineDetail, isUnsupportedBytes } from './helpers/sharpError.ts';
import { errorCodeLabel, NoopMetrics } from './metrics.ts';
import type {
  Original,
  OriginalFormat,
  ResizeConfig,
  StorageRef,
  UploadOriginalOpts,
} from './types.d.ts';

interface IdentifiedOriginal {
  decoder: SourceDecoder;
  info: SourceInfo;
  format: OriginalFormat;
  contentType: string;
  extension: string;
  width: number;
  height: number;
}

/** The upload codes of the decoder codes that say what is wrong with the original. */
const ORIGINAL_CODES = new Map([
  ['RESIZE_SOURCE_FORMAT_UNSUPPORTED', 'RESIZE_ORIGINAL_FORMAT_UNSUPPORTED'],
  ['RESIZE_SOURCE_METADATA_MISSING', 'RESIZE_ORIGINAL_METADATA_MISSING'],
  // Sharp's pixel limit, and the SVG decoder's own check of limits.sourcePixels, before its density
  // probe.
  ['RESIZE_SOURCE_TOO_LARGE', 'RESIZE_ORIGINAL_TOO_MANY_PIXELS'],
]);

function asBuffer(body: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(body) ? body : Buffer.from(body);
}

/** The classes of a wiring bug, not an invalid original (a host's subclass of one counts too). */
const WIRING_ERRORS: ReadonlySet<string> = new Set([
  'ResizeSetupError',
  'ResizeConfigError',
]);

/** The engine's line for an upload's message: one line, short, since it may reach an end user. */
function uploadDetail(message: string): string {
  return engineDetail(message).slice(0, 200);
}

/**
 * The engine's own line for a damage error. The error's message is the worker's, which can talk
 * about limits.failOn; a decoder's damage without an engine error has only that message.
 */
function damageDetail(err: ResizeError): string {
  return uploadDetail(
    messageText(err.cause instanceof Error ? err.cause : err),
  );
}

/**
 * What a decoder rejected the original with, as an upload error. Only a failure that names the
 * bytes refuses them for good; any other failure of a decoder says nothing about them, so a retry
 * may help. A setup or config error is a wiring bug, not an invalid original, and passes through
 * unchanged; the class is told by the brand and the class names, so an error from a duplicate copy
 * of the package counts too.
 */
function originalError(cause: unknown): ResizeError {
  if (!isModuleError(cause)) {
    const message = messageText(cause);
    const detail = uploadDetail(message);
    return isUnsupportedBytes(message)
      ? new ResizeOriginalError(
          `resize uploadOriginal: bytes are not a supported image: ${detail}`,
          { code: 'RESIZE_ORIGINAL_INVALID', cause },
        )
      : new ResizeOriginalError(
          `resize uploadOriginal: the decoder could not read the image: ${detail}`,
          { code: 'RESIZE_ORIGINAL_INSPECT_FAILED', retryable: true, cause },
        );
  }
  if (hasErrorClass(cause, WIRING_ERRORS)) {
    return cause;
  }
  if (cause.code === 'RESIZE_SOURCE_DAMAGED') {
    const detail = damageDetail(cause);
    const xml = detail.match(/XML parse error: (.*)$/);
    return new ResizeOriginalError(
      xml
        ? `resize uploadOriginal: the SVG could not be parsed: ${xml[1]}`
        : `resize uploadOriginal: bytes are not a supported image: ${detail}`,
      { code: 'RESIZE_ORIGINAL_INVALID', cause },
    );
  }
  const code = ORIGINAL_CODES.get(cause.code);
  return code === undefined
    ? new ResizeOriginalError(cause.message, {
        code: cause.code,
        retryable: cause.retryable,
        cause,
      })
    : new ResizeOriginalError(cause.message, { code, cause });
}

/** One real decode: a truncated body often passes `inspect`, which reads only the header. */
async function verifyDecodes(
  { decoder, info }: IdentifiedOriginal,
  body: Buffer,
  config: ResizeConfig,
): Promise<void> {
  try {
    await decoder.render(
      body,
      { width: 16, height: 16 },
      { limits: config.limits, source: info, frames: 1 },
    );
  } catch (cause) {
    if (isModuleError(cause)) {
      if (hasErrorClass(cause, WIRING_ERRORS)) {
        throw cause;
      }
      if (cause.code === 'RESIZE_SOURCE_DAMAGED') {
        throw new ResizeOriginalError(
          `resize uploadOriginal: the image is damaged: ${damageDetail(cause)}`,
          { code: 'RESIZE_ORIGINAL_DAMAGED', cause },
        );
      }
      if (ORIGINAL_CODES.has(cause.code)) {
        throw originalError(cause);
      }
    }
    // A timeout, or a file this build cannot decode, says nothing about the image.
    throw new ResizeOriginalError(
      `resize uploadOriginal: the decode check failed: ${uploadDetail(messageText(cause))}`,
      { code: 'RESIZE_ORIGINAL_VERIFY_FAILED', retryable: true, cause },
    );
  }
}

async function identifyOriginal(
  decoders: DecoderSet,
  body: Buffer,
  config: ResizeConfig,
): Promise<IdentifiedOriginal> {
  let identified: IdentifiedSource;
  try {
    identified = await decoders.identify(body, config.limits);
  } catch (cause) {
    throw originalError(cause);
  }
  const { info } = identified;
  const pages = info.pages ?? 1;
  if (info.width * info.height * pages > config.limits.sourcePixels) {
    throw new ResizeOriginalError(
      `resize uploadOriginal: image ${info.width}x${info.height}x${pages}f exceeds limits.sourcePixels (${config.limits.sourcePixels})`,
      { code: 'RESIZE_ORIGINAL_TOO_MANY_PIXELS' },
    );
  }
  return {
    decoder: identified.decoder,
    info,
    format: info.format,
    contentType: info.contentType,
    extension: info.format === 'jpeg' ? 'jpg' : info.format,
    // A vector source may report a fractional natural size.
    width: Math.max(1, Math.round(info.width)),
    height: Math.max(1, Math.round(info.height)),
  };
}

export interface UploaderDeps {
  storage: ResizeStorage;
  decoders: DecoderSet;
  config: ResizeConfig;
  // Where each upload is recorded (a Resizer passes its bound sink); default: nothing is recorded.
  metrics?: ResizeMetrics;
}

const noMetrics = new NoopMetrics();

export class Uploader {
  readonly #storage: ResizeStorage;
  readonly #decoders: DecoderSet;
  readonly #config: ResizeConfig;
  readonly #metrics: ResizeMetrics;

  constructor(deps: UploaderDeps) {
    this.#storage = deps.storage;
    this.#decoders = deps.decoders;
    this.#config = deps.config;
    this.#metrics = deps.metrics ?? noMetrics;
  }

  /**
   * Store an untouched, byte-sniffed original. Does not create media or queue work. The upload is
   * timed from here to its return or its throw: a stored one with its format and bytes, a rejected
   * one with its code.
   */
  async upload(opts: UploadOriginalOpts): Promise<Original> {
    const started = performance.now();
    let original: Original & { format: string; size: number };
    try {
      original = await this.#store(opts);
    } catch (err) {
      this.#metrics.timing('resize.upload', performance.now() - started, {
        outcome: 'rejected',
        ...errorCodeLabel(err),
      });
      throw err;
    }
    const format = { format: original.format };
    this.#metrics.timing('resize.upload', performance.now() - started, {
      outcome: 'stored',
      ...format,
    });
    this.#metrics.count('resize.upload.bytes', original.size, format);
    return original;
  }

  /** The upload itself: check, measure and store the original, or throw why it was refused. */
  async #store(
    opts: UploadOriginalOpts,
  ): Promise<Original & { format: string; size: number }> {
    if (
      !opts ||
      (!Buffer.isBuffer(opts.body) && !(opts.body instanceof Uint8Array))
    ) {
      throw new ResizeOriginalError(
        'resize uploadOriginal: body must be a Buffer or Uint8Array',
        { code: 'RESIZE_ORIGINAL_BODY_INVALID' },
      );
    }
    if (opts.visibility !== 'public' && opts.visibility !== 'private') {
      throw new ResizeOriginalError(
        'resize uploadOriginal: visibility must be public or private',
        { code: 'RESIZE_ORIGINAL_VISIBILITY_INVALID' },
      );
    }
    const body = asBuffer(opts.body);
    if (body.byteLength === 0) {
      throw new ResizeOriginalError('resize uploadOriginal: body is empty', {
        code: 'RESIZE_ORIGINAL_EMPTY',
      });
    }
    const config = this.#config;
    if (body.byteLength > config.upload.maxBytes) {
      throw new ResizeOriginalError(
        `resize uploadOriginal: body exceeds upload.maxBytes (${config.upload.maxBytes})`,
        { code: 'RESIZE_ORIGINAL_TOO_LARGE' },
      );
    }
    const measured = await identifyOriginal(this.#decoders, body, config);
    if (!config.upload.formats.includes(measured.format)) {
      throw new ResizeOriginalError(
        `resize uploadOriginal: format ${measured.format} is disabled by upload.formats`,
        { code: 'RESIZE_ORIGINAL_FORMAT_DISABLED' },
      );
    }
    if (measured.format === 'svg' && opts.visibility === 'public') {
      throw new ResizeOriginalError(
        'resize uploadOriginal: SVG originals must be stored privately',
        { code: 'RESIZE_ORIGINAL_SVG_PUBLIC' },
      );
    }
    // SVG is skipped: inspect has parsed its XML, and a render starts a process per upload.
    if (config.upload.verify === 'decode' && measured.format !== 'svg') {
      await verifyDecodes(measured, body, config);
    }
    const key = `originals/${randomHex()}.${measured.extension}`;
    let ref: StorageRef;
    try {
      ref = await this.#storage.upload({
        key,
        body,
        contentType: measured.contentType,
        visibility: opts.visibility,
        ...(opts.namespace === undefined ? {} : { namespace: opts.namespace }),
      });
    } catch (cause) {
      throw new ResizeStorageError(
        `resize uploadOriginal: storage upload failed for ${measured.format} original`,
        { code: 'RESIZE_ORIGINAL_UPLOAD_FAILED', cause },
      );
    }
    if (ref === null || ref === undefined) {
      throw new ResizeStorageError(
        'resize uploadOriginal: storage returned an invalid original locator',
        { code: 'RESIZE_ORIGINAL_STORAGE_REF_INVALID' },
      );
    }
    return {
      storageRef: ref,
      format: measured.format,
      contentType: measured.contentType,
      size: body.byteLength,
      width: measured.width,
      height: measured.height,
    };
  }
}
