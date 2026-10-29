// Stores an original as uploaded. The decoders measure it (format, size, frames) to check the
// upload rules; the bytes go to storage unchanged. It needs only the storage, the decoders and the
// image config; it creates no media, queues no work and logs nothing.
import type { ResizeStorage } from './contracts/storage.ts';
import type { DecoderSet, IdentifiedSource } from './decoderSet.ts';
import {
  ResizeError,
  ResizeOriginalError,
  ResizeStorageError,
} from './errors.ts';
import { randomHex } from './helpers/random.ts';
import type {
  Original,
  OriginalFormat,
  ResizeConfig,
  StorageRef,
  UploadOriginalOpts,
} from './types.d.ts';

interface IdentifiedOriginal {
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
  // The SVG decoder checks limits.sourcePixels itself, before its density probe.
  ['RESIZE_SOURCE_TOO_LARGE', 'RESIZE_ORIGINAL_TOO_MANY_PIXELS'],
]);

function asBuffer(body: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(body) ? body : Buffer.from(body);
}

/**
 * What a decoder rejected the original with, as an upload error. A setup or config error is a
 * wiring bug, not an invalid original, and passes through unchanged; the class is told by the brand
 * and the name, so an error from a duplicate copy of the package counts too.
 */
function originalError(cause: unknown): ResizeError {
  if (!ResizeError.isResizeError(cause)) {
    return new ResizeOriginalError(
      'resize uploadOriginal: bytes are not a supported image',
      { code: 'RESIZE_ORIGINAL_INVALID', cause },
    );
  }
  if (cause.name === 'ResizeSetupError' || cause.name === 'ResizeConfigError') {
    return cause;
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
}

export class Uploader {
  readonly #storage: ResizeStorage;
  readonly #decoders: DecoderSet;
  readonly #config: ResizeConfig;

  constructor(deps: UploaderDeps) {
    this.#storage = deps.storage;
    this.#decoders = deps.decoders;
    this.#config = deps.config;
  }

  /** Store an untouched, byte-sniffed original. Does not create media or queue work. */
  async upload(opts: UploadOriginalOpts): Promise<Original> {
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
    const prepared = await identifyOriginal(this.#decoders, body, config);
    if (!config.upload.formats.includes(prepared.format)) {
      throw new ResizeOriginalError(
        `resize uploadOriginal: format ${prepared.format} is disabled by upload.formats`,
        { code: 'RESIZE_ORIGINAL_FORMAT_DISABLED' },
      );
    }
    if (prepared.format === 'svg' && opts.visibility === 'public') {
      throw new ResizeOriginalError(
        'resize uploadOriginal: SVG originals must be stored privately',
        { code: 'RESIZE_ORIGINAL_SVG_PUBLIC' },
      );
    }
    const key = `originals/${randomHex()}.${prepared.extension}`;
    let ref: StorageRef;
    try {
      ref = await this.#storage.upload({
        key,
        body,
        contentType: prepared.contentType,
        visibility: opts.visibility,
        ...(opts.namespace === undefined ? {} : { namespace: opts.namespace }),
      });
    } catch (cause) {
      throw new ResizeStorageError(
        `resize uploadOriginal: storage upload failed for ${prepared.format} original`,
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
      format: prepared.format,
      contentType: prepared.contentType,
      size: body.byteLength,
      width: prepared.width,
      height: prepared.height,
    };
  }
}
