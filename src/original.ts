import sharp, { type Metadata } from 'sharp';
import { ResizeOriginalError, ResizeStorageError } from './errors.ts';
import { isAvifBuffer } from './helpers/imageFormat.ts';
import { randomHex } from './helpers/random.ts';
import { getResizeConfig } from './resizeConfig.ts';
import type { Resizer } from './resizer.ts';
import type {
  Original,
  OriginalFormat,
  ResizeConfig,
  StorageRef,
  UploadOriginalOpts,
} from './types.d.ts';

interface PreparedOriginal {
  format: OriginalFormat;
  contentType: string;
  extension: string;
  width?: number;
  height?: number;
}

function originalStorageInfo(format: string): {
  contentType: string;
  extension: string;
} {
  return {
    contentType: format === 'svg' ? 'image/svg+xml' : `image/${format}`,
    extension: format === 'jpeg' ? 'jpg' : format,
  };
}

function asBuffer(body: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(body) ? body : Buffer.from(body);
}

function displayDimensions(metadata: Metadata): {
  width?: number;
  height?: number;
} {
  if (metadata.width === undefined || metadata.height === undefined) {
    return {};
  }
  const height = metadata.pageHeight ?? metadata.height;
  return (metadata.orientation ?? 1) >= 5
    ? { width: height, height: metadata.width }
    : { width: metadata.width, height };
}

async function prepareOriginal(
  body: Buffer,
  config: ResizeConfig,
): Promise<PreparedOriginal> {
  let metadata: Metadata;
  try {
    metadata = await sharp(body, {
      limitInputPixels: config.limits.inputPixels,
      animated: true,
    }).metadata();
  } catch (cause) {
    throw new ResizeOriginalError(
      'resize uploadOriginal: bytes are not a supported image',
      { code: 'RESIZE_ORIGINAL_INVALID', cause },
    );
  }

  if (!metadata.format) {
    throw new ResizeOriginalError(
      'resize uploadOriginal: Sharp did not identify the image format',
      { code: 'RESIZE_ORIGINAL_FORMAT_UNSUPPORTED' },
    );
  }
  const format: OriginalFormat =
    metadata.format === 'heif' && isAvifBuffer(body) ? 'avif' : metadata.format;
  if (metadata.width === undefined || metadata.height === undefined) {
    throw new ResizeOriginalError(
      'resize uploadOriginal: image metadata is missing width/height',
      { code: 'RESIZE_ORIGINAL_METADATA_MISSING' },
    );
  }
  const pages = metadata.pages ?? 1;
  // animated:true reports a stacked height; count each frame only once.
  const frameHeight = metadata.pageHeight ?? metadata.height;
  if (metadata.width * frameHeight * pages > config.limits.sourcePixels) {
    throw new ResizeOriginalError(
      `resize uploadOriginal: image ${metadata.width}x${frameHeight}x${pages}f exceeds limits.sourcePixels (${config.limits.sourcePixels})`,
      { code: 'RESIZE_ORIGINAL_TOO_MANY_PIXELS' },
    );
  }
  return {
    format,
    ...originalStorageInfo(format),
    ...displayDimensions(metadata),
  };
}

export async function uploadOriginalImpl(
  resizer: Resizer,
  opts: UploadOriginalOpts,
): Promise<Original> {
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
  const config = getResizeConfig();
  if (body.byteLength > config.upload.maxBytes) {
    throw new ResizeOriginalError(
      `resize uploadOriginal: body exceeds upload.maxBytes (${config.upload.maxBytes})`,
      { code: 'RESIZE_ORIGINAL_TOO_LARGE' },
    );
  }
  const prepared = await prepareOriginal(body, config);
  if (!config.upload.formats.includes(prepared.format)) {
    throw new ResizeOriginalError(
      `resize uploadOriginal: format ${prepared.format} is disabled by upload.formats`,
      { code: 'RESIZE_ORIGINAL_FORMAT_DISABLED' },
    );
  }
  const key = `originals/${randomHex()}.${prepared.extension}`;
  let ref: StorageRef;
  try {
    ref = await resizer.storage.upload({
      key,
      body,
      contentType: prepared.contentType,
      visibility: opts.visibility,
    });
  } catch (cause) {
    throw new ResizeStorageError(
      `resize uploadOriginal: storage upload failed for ${prepared.format} original`,
      { code: 'RESIZE_ORIGINAL_UPLOAD_FAILED', cause },
    );
  }
  if (
    typeof ref !== 'object' ||
    ref === null ||
    typeof ref.key !== 'string' ||
    !ref.key
  ) {
    throw new ResizeStorageError(
      'resize uploadOriginal: storage returned an invalid original locator',
      { code: 'RESIZE_ORIGINAL_STORAGE_REF_INVALID' },
    );
  }
  return {
    ...ref,
    format: prepared.format,
    contentType: prepared.contentType,
    size: body.byteLength,
    ...(prepared.width !== undefined ? { width: prepared.width } : {}),
    ...(prepared.height !== undefined ? { height: prepared.height } : {}),
  };
}
