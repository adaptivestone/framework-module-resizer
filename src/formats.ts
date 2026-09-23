import type { OriginalFormat, PreviewFormat } from './types.d.ts';

export const originalFormatInfo = {
  jpeg: { contentType: 'image/jpeg', extension: 'jpg' },
  png: { contentType: 'image/png', extension: 'png' },
  webp: { contentType: 'image/webp', extension: 'webp' },
  avif: { contentType: 'image/avif', extension: 'avif' },
  gif: { contentType: 'image/gif', extension: 'gif' },
  svg: { contentType: 'image/svg+xml', extension: 'svg' },
} as const satisfies Record<
  OriginalFormat,
  { contentType: string; extension: string }
>;

export const supportedOriginalFormats = Object.freeze(
  Object.keys(originalFormatInfo) as OriginalFormat[],
);

export const supportedPreviewFormats = [
  'jpeg',
  'webp',
  'avif',
] as const satisfies readonly PreviewFormat[];
