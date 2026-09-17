import sharp, { type Metadata } from 'sharp';
import { getResizeConfig } from './config/resize.ts';
import { ResizeOriginalError, ResizeStorageError } from './errors.ts';
import { randomHex } from './helpers/random.ts';
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

interface ParsedTag {
  name: string;
  attributes: Map<string, string>;
  end: number;
  selfClosing: boolean;
}

const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*/;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function asBuffer(body: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(body) ? body : Buffer.from(body);
}

function skipWhitespace(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/u.test(text[i])) {
    i++;
  }
  return i;
}

function markupEnd(text: string, from: number): number {
  let quote: '"' | "'" | undefined;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  throw new ResizeOriginalError('resize uploadOriginal: unterminated XML tag', {
    code: 'RESIZE_ORIGINAL_SVG_INVALID',
  });
}

function parseStartTag(text: string, start: number): ParsedTag {
  const end = markupEnd(text, start + 1);
  let inner = text.slice(start + 1, end);
  const selfClosing = /\/\s*$/u.test(inner);
  if (selfClosing) {
    inner = inner.replace(/\/\s*$/u, '');
  }
  let at = skipWhitespace(inner, 0);
  const nameMatch = XML_NAME.exec(inner.slice(at));
  if (!nameMatch) {
    throw new ResizeOriginalError(
      'resize uploadOriginal: invalid XML element name',
      {
        code: 'RESIZE_ORIGINAL_SVG_INVALID',
      },
    );
  }
  const name = nameMatch[0];
  at += name.length;
  const attributes = new Map<string, string>();
  while (at < inner.length) {
    at = skipWhitespace(inner, at);
    if (at >= inner.length) {
      break;
    }
    const attributeMatch = XML_NAME.exec(inner.slice(at));
    if (!attributeMatch) {
      throw new ResizeOriginalError(
        'resize uploadOriginal: invalid SVG attribute syntax',
        { code: 'RESIZE_ORIGINAL_SVG_INVALID' },
      );
    }
    const attribute = attributeMatch[0];
    at += attribute.length;
    at = skipWhitespace(inner, at);
    if (inner[at] !== '=') {
      throw new ResizeOriginalError(
        'resize uploadOriginal: SVG attributes must have quoted values',
        { code: 'RESIZE_ORIGINAL_SVG_INVALID' },
      );
    }
    at = skipWhitespace(inner, at + 1);
    const quote = inner[at];
    if (quote !== '"' && quote !== "'") {
      throw new ResizeOriginalError(
        'resize uploadOriginal: SVG attributes must have quoted values',
        { code: 'RESIZE_ORIGINAL_SVG_INVALID' },
      );
    }
    const valueEnd = inner.indexOf(quote, at + 1);
    if (valueEnd < 0) {
      throw new ResizeOriginalError(
        'resize uploadOriginal: unterminated SVG attribute value',
        { code: 'RESIZE_ORIGINAL_SVG_INVALID' },
      );
    }
    if (attributes.has(attribute)) {
      throw new ResizeOriginalError(
        `resize uploadOriginal: duplicate SVG attribute ${attribute}`,
        { code: 'RESIZE_ORIGINAL_SVG_INVALID' },
      );
    }
    attributes.set(attribute, inner.slice(at + 1, valueEnd));
    at = valueEnd + 1;
  }
  return { name, attributes, end: end + 1, selfClosing };
}

function parseEndTag(
  text: string,
  start: number,
): { name: string; end: number } {
  const close = text.indexOf('>', start + 2);
  if (close < 0) {
    throw new ResizeOriginalError(
      'resize uploadOriginal: unterminated XML closing tag',
      {
        code: 'RESIZE_ORIGINAL_SVG_INVALID',
      },
    );
  }
  const body = text.slice(start + 2, close).trim();
  if (!XML_NAME.test(body) || XML_NAME.exec(body)?.[0] !== body) {
    throw new ResizeOriginalError(
      'resize uploadOriginal: invalid XML closing tag',
      {
        code: 'RESIZE_ORIGINAL_SVG_INVALID',
      },
    );
  }
  return { name: body, end: close + 1 };
}

function skipSpecialMarkup(text: string, start: number): number | undefined {
  if (text.startsWith('<!--', start)) {
    const end = text.indexOf('-->', start + 4);
    if (end < 0) {
      throw new ResizeOriginalError(
        'resize uploadOriginal: unterminated XML comment',
        {
          code: 'RESIZE_ORIGINAL_SVG_INVALID',
        },
      );
    }
    return end + 3;
  }
  if (text.startsWith('<?', start)) {
    const end = text.indexOf('?>', start + 2);
    if (end < 0) {
      throw new ResizeOriginalError(
        'resize uploadOriginal: unterminated XML processing instruction',
        { code: 'RESIZE_ORIGINAL_SVG_INVALID' },
      );
    }
    return end + 2;
  }
  if (text.startsWith('<![CDATA[', start)) {
    const end = text.indexOf(']]>', start + 9);
    if (end < 0) {
      throw new ResizeOriginalError(
        'resize uploadOriginal: unterminated CDATA section',
        {
          code: 'RESIZE_ORIGINAL_SVG_INVALID',
        },
      );
    }
    return end + 3;
  }
  return undefined;
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

function parseSvg(text: string): PreparedOriginal {
  if (/<!DOCTYPE\b|<!ENTITY\b/iu.test(text)) {
    throw new ResizeOriginalError(
      'resize uploadOriginal: SVG DTD and entity declarations are not allowed',
      { code: 'RESIZE_ORIGINAL_SVG_DTD_FORBIDDEN' },
    );
  }
  if (text.includes('\0')) {
    throw new ResizeOriginalError(
      'resize uploadOriginal: SVG contains NUL bytes',
      {
        code: 'RESIZE_ORIGINAL_SVG_INVALID',
      },
    );
  }

  let at = skipWhitespace(text.replace(/^\uFEFF/u, ''), 0);
  const source = text.replace(/^\uFEFF/u, '');
  for (;;) {
    const skipped = skipSpecialMarkup(source, at);
    if (skipped === undefined || source.startsWith('<![CDATA[', at)) {
      break;
    }
    at = skipWhitespace(source, skipped);
  }
  if (
    source[at] !== '<' ||
    source.startsWith('</', at) ||
    source.startsWith('<!', at)
  ) {
    throw new ResizeOriginalError(
      'resize uploadOriginal: XML root is not an SVG element',
      {
        code: 'RESIZE_ORIGINAL_NOT_SVG',
      },
    );
  }
  const root = parseStartTag(source, at);
  const colon = root.name.indexOf(':');
  const localName = colon < 0 ? root.name : root.name.slice(colon + 1);
  const namespace =
    colon < 0
      ? root.attributes.get('xmlns')
      : root.attributes.get(`xmlns:${root.name.slice(0, colon)}`);
  if (
    localName.toLowerCase() !== 'svg' ||
    (namespace !== undefined && namespace !== SVG_NAMESPACE) ||
    (colon >= 0 && namespace === undefined)
  ) {
    throw new ResizeOriginalError(
      'resize uploadOriginal: XML root is not an SVG element',
      {
        code: 'RESIZE_ORIGINAL_NOT_SVG',
      },
    );
  }

  const stack = root.selfClosing ? [] : [root.name];
  at = root.end;
  let rootClosed = root.selfClosing;
  while (at < source.length) {
    if (source[at] !== '<') {
      const next = source.indexOf('<', at);
      const end = next < 0 ? source.length : next;
      if (rootClosed && source.slice(at, end).trim() !== '') {
        throw new ResizeOriginalError(
          'resize uploadOriginal: data appears after the SVG root element',
          { code: 'RESIZE_ORIGINAL_SVG_INVALID' },
        );
      }
      at = end;
      continue;
    }
    const skipped = skipSpecialMarkup(source, at);
    if (skipped !== undefined) {
      if (rootClosed && source.startsWith('<![CDATA[', at)) {
        throw new ResizeOriginalError(
          'resize uploadOriginal: CDATA appears outside the SVG root element',
          { code: 'RESIZE_ORIGINAL_SVG_INVALID' },
        );
      }
      at = skipped;
      continue;
    }
    if (source.startsWith('<!', at)) {
      throw new ResizeOriginalError(
        'resize uploadOriginal: unsupported SVG declaration',
        { code: 'RESIZE_ORIGINAL_SVG_INVALID' },
      );
    }
    if (source.startsWith('</', at)) {
      const closing = parseEndTag(source, at);
      const expected = stack.pop();
      if (closing.name !== expected) {
        throw new ResizeOriginalError(
          `resize uploadOriginal: mismatched SVG closing tag ${closing.name}`,
          { code: 'RESIZE_ORIGINAL_SVG_INVALID' },
        );
      }
      rootClosed = stack.length === 0;
      at = closing.end;
      continue;
    }
    if (rootClosed) {
      throw new ResizeOriginalError(
        'resize uploadOriginal: multiple XML root elements are not allowed',
        { code: 'RESIZE_ORIGINAL_SVG_INVALID' },
      );
    }
    const child = parseStartTag(source, at);
    if (!child.selfClosing) {
      stack.push(child.name);
    }
    at = child.end;
  }
  if (!rootClosed || stack.length > 0) {
    throw new ResizeOriginalError(
      'resize uploadOriginal: unclosed SVG element',
      {
        code: 'RESIZE_ORIGINAL_SVG_INVALID',
      },
    );
  }

  const width = parsePixelLength(root.attributes.get('width'));
  const height = parsePixelLength(root.attributes.get('height'));
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
  return (metadata.orientation ?? 1) >= 5
    ? { width: metadata.height, height: metadata.width }
    : { width: metadata.width, height: metadata.height };
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
  if (metadata.width * metadata.height * pages > config.limits.sourcePixels) {
    throw new ResizeOriginalError(
      `resize uploadOriginal: image ${metadata.width}x${metadata.height}x${pages}f exceeds limits.sourcePixels (${config.limits.sourcePixels})`,
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
