import { createRequire } from 'node:module';
import sharp, { type Metadata } from 'sharp';
import { ResizeOriginalError, ResizeStorageError } from './errors.ts';
import { randomHex } from './helpers/random.ts';
import { getResizeConfig } from './resizeConfig.ts';
import type { Resizer } from './resizer.ts';
import type {
  Original,
  OriginalFormat,
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

interface StrictXmlTag {
  local?: string;
  uri?: string;
  attributes: Record<string, { value: string }>;
}

interface StrictXmlParser {
  on(name: 'doctype', handler: () => void): void;
  on(name: 'opentag', handler: (tag: StrictXmlTag) => void): void;
  on(name: 'error', handler: (error: Error) => void): void;
  write(chunk: string): this;
  close(): this;
}

const { SaxesParser } = createRequire(import.meta.url)('saxes') as {
  SaxesParser: new (options: { xmlns: true }) => StrictXmlParser;
};

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function asBuffer(body: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(body) ? body : Buffer.from(body);
}

function parsePixelLength(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /^\s*(\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?(?:px)?\s*$/u.exec(
    value,
  );
  if (!match) {
    return undefined;
  }
  const parsed = Number(value.trim().replace(/px$/iu, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseViewBox(value: string | undefined): {
  width?: number;
  height?: number;
} {
  if (value === undefined) {
    return {};
  }
  const numbers = value
    .trim()
    .split(/[\s,]+/u)
    .map(Number);
  if (
    numbers.length !== 4 ||
    numbers.some((number) => !Number.isFinite(number)) ||
    numbers[2] <= 0 ||
    numbers[3] <= 0
  ) {
    return {};
  }
  return { width: numbers[2], height: numbers[3] };
}

function parseSvg(text: string): PreparedOriginal {
  let root: StrictXmlTag | undefined;
  try {
    const parser = new SaxesParser({ xmlns: true });
    parser.on('doctype', () => {
      throw new ResizeOriginalError(
        'resize uploadOriginal: SVG DTD and entity declarations are not allowed',
        { code: 'RESIZE_ORIGINAL_SVG_DTD_FORBIDDEN' },
      );
    });
    parser.on('opentag', (tag) => {
      if (root === undefined) {
        root = tag;
      }
    });
    parser.on('error', (error) => {
      throw error;
    });
    parser.write(text).close();
  } catch (cause) {
    if (cause instanceof ResizeOriginalError) {
      throw cause;
    }
    throw new ResizeOriginalError(
      'resize uploadOriginal: SVG XML is not well-formed',
      { code: 'RESIZE_ORIGINAL_SVG_INVALID', cause },
    );
  }

  const parsedRoot = root;
  if (parsedRoot === undefined) {
    throw new ResizeOriginalError(
      'resize uploadOriginal: XML root is not an SVG element',
      { code: 'RESIZE_ORIGINAL_NOT_SVG' },
    );
  }
  if (
    parsedRoot.local?.toLowerCase() !== 'svg' ||
    (parsedRoot.uri !== '' && parsedRoot.uri !== SVG_NAMESPACE)
  ) {
    throw new ResizeOriginalError(
      'resize uploadOriginal: XML root is not an SVG element',
      { code: 'RESIZE_ORIGINAL_NOT_SVG' },
    );
  }

  const attribute = (name: string): string | undefined =>
    parsedRoot.attributes[name]?.value;
  const viewBox = parseViewBox(attribute('viewBox'));
  const width = parsePixelLength(attribute('width')) ?? viewBox.width;
  const height = parsePixelLength(attribute('height')) ?? viewBox.height;
  return {
    format: 'svg',
    contentType: 'image/svg+xml',
    extension: 'svg',
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
}

function decodeXmlCandidate(body: Buffer): string | undefined {
  let encoding: 'utf-8' | 'utf-16le' | 'utf-16be' = 'utf-8';
  // XML autodetection signatures that this small, non-rendering parser deliberately does not
  // decode. Reject before Sharp: an SVG in an unfamiliar encoding must never reach a renderer.
  const signature = body.subarray(0, 4).toString('hex');
  if (
    signature === '0000feff' ||
    signature === 'fffe0000' ||
    signature === '0000003c' ||
    signature === '3c000000' ||
    signature === '4c6fa794'
  ) {
    throw new ResizeOriginalError(
      'resize uploadOriginal: XML encoding is not supported',
      { code: 'RESIZE_ORIGINAL_SVG_ENCODING_UNSUPPORTED' },
    );
  }
  if (body[0] === 0xff && body[1] === 0xfe) {
    encoding = 'utf-16le';
  } else if (body[0] === 0xfe && body[1] === 0xff) {
    encoding = 'utf-16be';
  } else if (body[0] === 0x3c && body[1] === 0x00) {
    encoding = 'utf-16le';
  } else if (body[0] === 0x00 && body[1] === 0x3c) {
    encoding = 'utf-16be';
  }
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(body);
  } catch (cause) {
    const prefix = body
      .subarray(0, Math.min(body.length, 1024))
      .toString('latin1');
    if (prefix.trimStart()[0] !== '<') {
      return undefined;
    }
    const declared =
      /^\s*<\?xml\s[^?]*\bencoding\s*=\s*(["'])([^"']+)\1/iu.exec(prefix)?.[2];
    if (!declared) {
      throw new ResizeOriginalError(
        'resize uploadOriginal: XML bytes are invalid UTF-8 and declare no supported encoding',
        { code: 'RESIZE_ORIGINAL_SVG_ENCODING_UNSUPPORTED', cause },
      );
    }
    try {
      text = new TextDecoder(declared, { fatal: true }).decode(body);
    } catch (encodingCause) {
      throw new ResizeOriginalError(
        `resize uploadOriginal: XML encoding ${declared} is not supported`,
        {
          code: 'RESIZE_ORIGINAL_SVG_ENCODING_UNSUPPORTED',
          cause: encodingCause,
        },
      );
    }
  }
  const first = text.replace(/^\uFEFF/u, '').trimStart()[0];
  return first === '<' ? text : undefined;
}

function isAvif(body: Buffer): boolean {
  if (body.length < 16 || body.toString('ascii', 4, 8) !== 'ftyp') {
    return false;
  }
  const brands = body.toString('ascii', 8, Math.min(body.length, 64));
  return brands.includes('avif') || brands.includes('avis');
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

async function prepareOriginal(body: Buffer): Promise<PreparedOriginal> {
  const xml = decodeXmlCandidate(body);
  if (xml !== undefined) {
    return parseSvg(xml);
  }

  const config = getResizeConfig();
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

  let format: Exclude<OriginalFormat, 'svg'> | undefined;
  if (
    metadata.format === 'jpeg' ||
    metadata.format === 'png' ||
    metadata.format === 'webp' ||
    metadata.format === 'gif'
  ) {
    format = metadata.format;
  } else if (metadata.format === 'heif' && isAvif(body)) {
    format = 'avif';
  }
  if (!format) {
    throw new ResizeOriginalError(
      `resize uploadOriginal: detected image format ${metadata.format ?? 'unknown'} is not supported`,
      { code: 'RESIZE_ORIGINAL_FORMAT_UNSUPPORTED' },
    );
  }
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
  const contentTypes: Record<Exclude<OriginalFormat, 'svg'>, string> = {
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    avif: 'image/avif',
    gif: 'image/gif',
  };
  return {
    format,
    contentType: contentTypes[format],
    extension: format === 'jpeg' ? 'jpg' : format,
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
  const prepared = await prepareOriginal(body);
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
