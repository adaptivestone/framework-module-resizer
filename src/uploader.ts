// Stores an original as uploaded. The decoders measure it (format, size, frames) to check the
// upload rules, and with `upload.verify: 'decode'` decode it once; the bytes go to storage unchanged.
// It also measures an object already in storage, and always decodes it once, so a host can put what
// it holds on the module without uploading it again. It needs only the storage, the decoders and the
// image config; it creates no media, queues no work and logs nothing. Each upload and each adoption
// is timed on the metrics sink, whatever its outcome.
import type { SourceDecoder, SourceInfo } from './contracts/decoder.ts';
import type { ResizeMetrics } from './contracts/metrics.ts';
import type { ResizeStorage } from './contracts/storage.ts';
import type { DecoderSet, IdentifiedSource } from './decoderSet.ts';
import {
  type ResizeError,
  ResizeMediaError,
  ResizeOriginalError,
  ResizeSetupError,
  ResizeStorageError,
} from './errors.ts';
import { asBuffer, isBytes } from './helpers/bytes.ts';
import { hasErrorClass } from './helpers/errorClass.ts';
import { isModuleError, messageText, notRetryable } from './helpers/log.ts';
import { randomHex } from './helpers/random.ts';
import { engineDetail, isUnsupportedBytes } from './helpers/sharpError.ts';
import { errorCodeLabel, NoopMetrics } from './metrics.ts';
import { locatorJson } from './signatures.ts';
import type {
  AdoptOriginalOpts,
  Original,
  OriginalFormat,
  ResizeConfig,
  StorageRef,
  UploadOriginalOpts,
} from './types.d.ts';

/** The public method a message speaks for: a host reads which call refused its object. */
type Verb = 'uploadOriginal' | 'adoptOriginal';

interface IdentifiedOriginal {
  decoder: SourceDecoder;
  info: SourceInfo;
  format: OriginalFormat;
  contentType: string;
  extension: string;
  width: number;
  height: number;
}

/**
 * The upload codes of the decoder codes that say what is wrong with the original. A storage driver's
 * RESIZE_SOURCE_TOO_LARGE never reaches this map: it counts bytes, not pixels, and adoption passes
 * it on, or names the call's own `maxBytes`.
 */
const ORIGINAL_CODES = new Map([
  ['RESIZE_SOURCE_FORMAT_UNSUPPORTED', 'RESIZE_ORIGINAL_FORMAT_UNSUPPORTED'],
  ['RESIZE_SOURCE_METADATA_MISSING', 'RESIZE_ORIGINAL_METADATA_MISSING'],
  // Sharp's pixel limit, and the SVG decoder's own check of limits.sourcePixels, before its density
  // probe.
  ['RESIZE_SOURCE_TOO_LARGE', 'RESIZE_ORIGINAL_TOO_MANY_PIXELS'],
]);

/** The form a ref is saved in, or the refusal of one that has none: it could not be saved or read back. */
function savedForm(given: StorageRef): StorageRef {
  let json: StorageRef | undefined;
  let cause: unknown;
  try {
    json = locatorJson(given);
  } catch (err) {
    cause = err;
  }
  if (json === null || json === undefined) {
    throw new ResizeOriginalError(
      'resize adoptOriginal: storageRef cannot be saved, because JSON cannot represent it',
      { code: 'RESIZE_ORIGINAL_STORAGE_REF_INVALID', cause },
    );
  }
  return json;
}

/** Over the cap a call set itself: that call's rule on what it accepts, as at upload. */
const overMaxBytes = (cap: number): ResizeOriginalError =>
  new ResizeOriginalError(
    `resize adoptOriginal: object is over maxBytes (${cap})`,
    { code: 'RESIZE_ORIGINAL_TOO_LARGE' },
  );

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
 * bytes refuses them for good; any other failure of a decoder gives no verdict on them, so a retry
 * may help. A host decoder's final refusal (`retryable: false`), at `inspect` or in the upload check,
 * keeps its code and `retryable`. A setup or config error is a wiring bug, not an invalid original,
 * and passes through unchanged; the class is told by the brand and the class names, so an error
 * from a duplicate copy of the package counts too.
 */
function originalError(cause: unknown, verb: Verb): ResizeError {
  if (!isModuleError(cause)) {
    const message = messageText(cause);
    const detail = uploadDetail(message);
    return isUnsupportedBytes(cause)
      ? new ResizeOriginalError(
          `resize ${verb}: bytes are not a supported image: ${detail}`,
          { code: 'RESIZE_ORIGINAL_INVALID', cause },
        )
      : new ResizeOriginalError(
          `resize ${verb}: the decoder could not read the image: ${detail}`,
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
        ? `resize ${verb}: the SVG could not be parsed: ${xml[1]}`
        : `resize ${verb}: bytes are not a supported image: ${detail}`,
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
  verb: Verb,
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
          `resize ${verb}: the image is damaged: ${damageDetail(cause)}`,
          { code: 'RESIZE_ORIGINAL_DAMAGED', cause },
        );
      }
      // The decoder's own word that no retry can help (an encrypted PDF) stands, as at `inspect`.
      if (ORIGINAL_CODES.has(cause.code) || notRetryable(cause)) {
        throw originalError(cause, verb);
      }
    }
    // A timeout, or a file this build cannot decode, gives no verdict on the image.
    throw new ResizeOriginalError(
      `resize ${verb}: the decode check failed: ${uploadDetail(messageText(cause))}`,
      { code: 'RESIZE_ORIGINAL_VERIFY_FAILED', retryable: true, cause },
    );
  }
}

/**
 * Identify the bytes and hold them to `limits.sourcePixels`. `countFrames: false` means pages count
 * as 1: a worker checks one frame, and the plan bounds how many it decodes.
 */
async function identifyOriginal(
  decoders: DecoderSet,
  body: Buffer,
  config: ResizeConfig,
  { verb, countFrames }: { verb: Verb; countFrames: boolean },
): Promise<IdentifiedOriginal> {
  let identified: IdentifiedSource;
  try {
    identified = await decoders.identify(body, config.limits);
  } catch (cause) {
    throw originalError(cause, verb);
  }
  const { info } = identified;
  const pages = countFrames ? (info.pages ?? 1) : 1;
  if (info.width * info.height * pages > config.limits.sourcePixels) {
    throw new ResizeOriginalError(
      `resize ${verb}: image ${info.width}x${info.height}x${pages}f exceeds limits.sourcePixels (${config.limits.sourcePixels})`,
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
    // A host with a larger upload.maxBytes would otherwise store originals no task can read.
    if (body.byteLength > config.limits.sourceBytes) {
      throw new ResizeOriginalError(
        `resize uploadOriginal: body exceeds limits.sourceBytes (${config.limits.sourceBytes}): a worker could not read it`,
        { code: 'RESIZE_ORIGINAL_TOO_LARGE' },
      );
    }
    const measured = await identifyOriginal(this.#decoders, body, config, {
      verb: 'uploadOriginal',
      countFrames: true,
    });
    if (!config.upload.formats.includes(measured.format)) {
      throw new ResizeOriginalError(
        `resize uploadOriginal: format ${measured.format} is disabled by upload.formats`,
        { code: 'RESIZE_ORIGINAL_FORMAT_DISABLED' },
      );
    }
    if (opts.visibility === 'public') {
      this.#checkPublic(measured, 'uploadOriginal');
    }
    if (config.upload.verify === 'decode') {
      await this.#decodeCheck(measured, body, 'uploadOriginal');
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
      // A driver's final refusal (an invalid namespace, no private bucket) fails the same upload the
      // same way, so it stays final here; any other failure gives no verdict on the upload.
      throw new ResizeStorageError(
        `resize uploadOriginal: storage upload failed for ${measured.format} original`,
        {
          code: 'RESIZE_ORIGINAL_UPLOAD_FAILED',
          retryable: !notRetryable(cause),
          cause,
        },
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

  /**
   * Measure and decode an object already in storage, and return the `Original` an upload of it would
   * return. It stores nothing. The adoption is timed from here to its return or its throw: an
   * adopted one with its format, a rejected one with its code.
   */
  async adopt(opts: AdoptOriginalOpts): Promise<Original> {
    const started = performance.now();
    let original: Original & { format: string };
    try {
      original = await this.#adopt(opts);
    } catch (err) {
      this.#metrics.timing('resize.adopt', performance.now() - started, {
        outcome: 'rejected',
        ...errorCodeLabel(err),
      });
      throw err;
    }
    this.#metrics.timing('resize.adopt', performance.now() - started, {
      outcome: 'adopted',
      format: original.format,
    });
    return original;
  }

  /**
   * The adoption itself, each step before any later cost. `upload.maxBytes` and `upload.formats` are
   * not applied: they are the policy for what clients send, and this object is already held. What a
   * worker could never render is refused, which is why the decode always runs. Everything from here
   * on uses the ref's JSON form, which is what a save stores: an `undefined` value in the given ref
   * would otherwise be stored as null by a bare `$set`, which the shipped drivers refuse for good,
   * and the driver now refuses what it would refuse on every delivery.
   */
  async #adopt(
    opts: AdoptOriginalOpts,
  ): Promise<Original & { format: string; size: number }> {
    const given = opts?.storageRef;
    if (given === null || given === undefined) {
      throw new ResizeOriginalError(
        'resize adoptOriginal: storageRef is required',
        { code: 'RESIZE_ORIGINAL_STORAGE_REF_INVALID' },
      );
    }
    const { maxBytes } = opts;
    if (
      maxBytes !== undefined &&
      !(Number.isSafeInteger(maxBytes) && maxBytes > 0)
    ) {
      throw new ResizeSetupError(
        'resize adoptOriginal: maxBytes must be a positive safe integer',
        { code: 'RESIZE_ADOPT_MAX_BYTES_INVALID', retryable: false },
      );
    }
    const ref = savedForm(given);
    const { sourceBytes } = this.#config.limits;
    const cap = Math.min(maxBytes ?? sourceBytes, sourceBytes);
    const downloaded = await this.#download(ref, cap);
    // Before asBuffer, which copies a Uint8Array: a file about to be refused costs no second copy.
    if (downloaded.byteLength > cap) {
      if (cap < sourceBytes) {
        throw overMaxBytes(cap);
      }
      throw new ResizeMediaError(
        `resize adoptOriginal: object is ${downloaded.byteLength} bytes, over limits.sourceBytes (${sourceBytes})`,
        { code: 'RESIZE_SOURCE_TOO_LARGE', retryable: false },
      );
    }
    if (downloaded.byteLength === 0) {
      throw new ResizeOriginalError('resize adoptOriginal: object is empty', {
        code: 'RESIZE_ORIGINAL_EMPTY',
      });
    }
    const body = asBuffer(downloaded);
    const measured = await identifyOriginal(
      this.#decoders,
      body,
      this.#config,
      { verb: 'adoptOriginal', countFrames: false },
    );
    if (this.#isPublic(ref)) {
      this.#checkPublic(measured, 'adoptOriginal');
    }
    await this.#decodeCheck(measured, body, 'adoptOriginal');
    return {
      storageRef: ref,
      format: measured.format,
      contentType: measured.contentType,
      size: body.byteLength,
      width: measured.width,
      height: measured.height,
    };
  }

  /**
   * The object's bytes, asked for within `cap`. A driver's own ResizeError says what is wrong with
   * the ref or the object, so it passes through as the same object, except a refusal of a cap this
   * call set: the driver cannot know that, and its line names limits.sourceBytes, so it is not kept
   * as the cause either. Any other failure, a driver that resolved with no bytes included, gives no
   * verdict on the object.
   */
  async #download(
    ref: StorageRef,
    cap: number,
  ): Promise<Uint8Array | ArrayBufferLike> {
    try {
      const bytes: unknown = await this.#storage.download(ref, {
        maxBytes: cap,
      });
      if (!isBytes(bytes)) {
        throw new TypeError('storage.download() resolved with no bytes');
      }
      return bytes;
    } catch (cause) {
      if (isModuleError(cause)) {
        if (
          cause.code === 'RESIZE_SOURCE_TOO_LARGE' &&
          cap < this.#config.limits.sourceBytes
        ) {
          throw overMaxBytes(cap);
        }
        throw cause;
      }
      throw new ResizeStorageError(
        'resize adoptOriginal: the object could not be read from storage',
        { code: 'RESIZE_ORIGINAL_DOWNLOAD_FAILED', cause },
      );
    }
  }

  /** A driver's `publicUrl` must refuse a ref it would not expose, so a URL means public. */
  #isPublic(ref: StorageRef): boolean {
    try {
      this.#storage.publicUrl(ref);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The rule for a public original: never an SVG, and otherwise only what its decoder says is safe,
   * since a host decoder's source kind may hold anything.
   */
  #checkPublic({ decoder, format }: IdentifiedOriginal, verb: Verb): void {
    if (format === 'svg') {
      throw new ResizeOriginalError(
        verb === 'uploadOriginal'
          ? 'resize uploadOriginal: SVG originals must be stored privately'
          : 'resize adoptOriginal: this SVG object is public — move it to private storage first; SVG originals stay private',
        { code: 'RESIZE_ORIGINAL_SVG_PUBLIC' },
      );
    }
    if (decoder.publicOriginals !== true) {
      throw new ResizeOriginalError(
        verb === 'uploadOriginal'
          ? `resize uploadOriginal: format '${format}' is stored privately unless its decoder sets publicOriginals: true — pass visibility: 'private', or set publicOriginals on the decoder`
          : `resize adoptOriginal: this '${format}' object is public, and its decoder does not set publicOriginals: true — move it to private storage, or set publicOriginals on the decoder`,
        { code: 'RESIZE_ORIGINAL_PUBLIC_REFUSED' },
      );
    }
  }

  /**
   * One decode of the first frame. No vector source renders on the request path: inspect has parsed
   * an SVG's XML, and its render starts a process per upload. A host's vector decoder says so with
   * `vector`.
   */
  async #decodeCheck(
    measured: IdentifiedOriginal,
    body: Buffer,
    verb: Verb,
  ): Promise<void> {
    if (measured.format !== 'svg' && !measured.info.vector) {
      await verifyDecodes(measured, body, this.#config, verb);
    }
  }
}
