// The engine of one Resizer: the host's, or the built-in Sharp engine, checked by shape (the core
// never checks `instanceof`), and what `verify()` asks of it.
import { isDeepStrictEqual } from 'node:util';
import defaultResizeConfig from './config/resize.ts';
import type { ImageEngine } from './contracts/engine.ts';
import { SharpEngine } from './engines/sharp.ts';
import { ResizeSetupError } from './errors.ts';
import type { ResizeConfig } from './types.d.ts';

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string' && v !== '');

export function createEngine(given?: unknown): ImageEngine {
  // Only `undefined` means the default: `null` is not an engine.
  if (given === undefined) {
    return new SharpEngine();
  }
  const e = given as Partial<ImageEngine> | null;
  if (
    typeof e?.id !== 'string' ||
    e.id === '' ||
    !isStringList(e.formats) ||
    e.formats.length === 0 ||
    !isStringList(e.animatedFormats) ||
    typeof e.resize !== 'function' ||
    typeof e.encode !== 'function' ||
    (e.verify !== undefined && typeof e.verify !== 'function')
  ) {
    throw new ResizeSetupError(
      'resize: `engine` is not an image engine — it needs an `id`, a non-empty `formats` list, an `animatedFormats` list, and `resize` and `encode` functions; `verify`, when given, must be a function',
      { code: 'RESIZE_ENGINE_INVALID' },
    );
  }
  return e as ImageEngine;
}

/**
 * The engine's own check, then what the host asks of it against its list: every entry of `formats`,
 * and every `encode.formats` entry the host wrote or changed. A package default the host left alone
 * and does not generate is no request, so a build without HEIF keeps working, and an engine that
 * writes webp alone hears nothing of jpeg. A per-call `formats` that asks for one fails at render.
 */
export async function verifyEngine(
  engine: ImageEngine,
  config: ResizeConfig,
  resizerName: string,
): Promise<void> {
  await engine.verify?.();
  const defaults = defaultResizeConfig.encode.formats;
  const entries = Object.entries(config.encode.formats)
    .filter(
      ([format, options]) => !isDeepStrictEqual(options, defaults[format]),
    )
    .map(([format]) => format);
  const missing = [...new Set([...config.formats, ...entries])].filter(
    (format) => !engine.formats.includes(format),
  );
  if (missing.length > 0) {
    throw new ResizeSetupError(
      `resize: Resizer '${resizerName}' has [${missing.join(', ')}] in \`formats\` or \`encode.formats\`, which engine '${engine.id}' does not write — it writes [${engine.formats.join(', ')}]`,
      { code: 'RESIZE_ENGINE_FORMAT_UNSUPPORTED' },
    );
  }
}
