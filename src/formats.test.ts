import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  originalFormatInfo,
  supportedOriginalFormats,
  supportedPreviewFormats,
} from './formats.ts';
import { resizeMediaSchemaFragment } from './models/mediaFragment.ts';
import ResizeTaskModel from './models/ResizeTask.ts';

describe('format registry', () => {
  test('defines the supported originals with their storage metadata', () => {
    assert.deepEqual(supportedOriginalFormats, [
      'jpeg',
      'png',
      'webp',
      'avif',
      'gif',
      'svg',
    ]);
    assert.deepEqual(originalFormatInfo, {
      jpeg: { contentType: 'image/jpeg', extension: 'jpg' },
      png: { contentType: 'image/png', extension: 'png' },
      webp: { contentType: 'image/webp', extension: 'webp' },
      avif: { contentType: 'image/avif', extension: 'avif' },
      gif: { contentType: 'image/gif', extension: 'gif' },
      svg: { contentType: 'image/svg+xml', extension: 'svg' },
    });
  });

  test('keeps preview capabilities aligned with both stored schemas', () => {
    assert.deepEqual(supportedPreviewFormats, ['jpeg', 'webp', 'avif']);
    assert.deepEqual(
      [...ResizeTaskModel.modelSchema.previews[0].format.enum],
      supportedPreviewFormats,
    );
    assert.deepEqual(
      [...resizeMediaSchemaFragment.previews[0].format.enum],
      supportedPreviewFormats,
    );
  });
});
