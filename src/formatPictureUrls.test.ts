import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatPictureUrls } from './formatPictureUrls.ts';
import type { ReadDecision } from './types.d.ts';

describe('formatPictureUrls', () => {
  test('groups ready entries by sizeKey then format', () => {
    const decision: ReadDecision = {
      ready: [
        {
          sizeKey: '320x320',
          format: 'jpeg',
          url: 'https://cdn/a.jpg',
          preview: {
            key: 'a.jpg',
            sizeKey: '320x320',
            format: 'jpeg',
            contentType: 'image/jpeg',
          },
        },
        {
          sizeKey: '320x320',
          format: 'webp',
          url: 'https://cdn/a.webp',
          preview: {
            key: 'a.webp',
            sizeKey: '320x320',
            format: 'webp',
            contentType: 'image/webp',
          },
        },
        {
          sizeKey: 'fit',
          format: 'jpeg',
          url: 'https://cdn/b.jpg',
          preview: {
            key: 'b.jpg',
            sizeKey: 'fit',
            format: 'jpeg',
            contentType: 'image/jpeg',
          },
        },
      ],
      missing: [{ sizeKey: '620w', format: 'jpeg' }],
    };
    const out = formatPictureUrls(decision, { id: 'm1', mediaType: 'image' });
    assert.equal(out.id, 'm1');
    assert.equal(out.mediaType, 'image');
    assert.deepEqual(out.sizes, {
      '320x320': {
        jpeg: { url: 'https://cdn/a.jpg', contentType: 'image/jpeg' },
        webp: { url: 'https://cdn/a.webp', contentType: 'image/webp' },
      },
      fit: {
        jpeg: { url: 'https://cdn/b.jpg', contentType: 'image/jpeg' },
      },
    });
    // missing variants are not in the map (no URL yet)
    assert.equal('620w' in out.sizes, false);
  });

  test('original-backed entries use contentType when known, never invent image/<format>', () => {
    const decision: ReadDecision = {
      ready: [
        {
          sizeKey: '300x300',
          format: 'webp',
          url: 'https://cdn/orig.svg',
          isOriginal: true,
          contentType: 'image/svg+xml',
        },
      ],
      missing: [],
    };
    const out = formatPictureUrls(decision);
    assert.equal(out.id, undefined);
    assert.deepEqual(out.sizes['300x300'].webp, {
      url: 'https://cdn/orig.svg',
      contentType: 'image/svg+xml',
    });
  });

  test('omits contentType when unknown rather than guessing', () => {
    const decision: ReadDecision = {
      ready: [
        {
          sizeKey: '300x300',
          format: 'webp',
          url: 'https://cdn/orig.jpg',
          isOriginal: true,
        },
      ],
      missing: [],
    };
    const out = formatPictureUrls(decision);
    assert.deepEqual(out.sizes['300x300'].webp, {
      url: 'https://cdn/orig.jpg',
    });
  });

  test('skips filtered variants so they cannot collide on sizeKey+format', () => {
    const decision: ReadDecision = {
      ready: [
        {
          sizeKey: '300x300',
          format: 'jpeg',
          url: 'https://cdn/plain.jpg',
          contentType: 'image/jpeg',
        },
        {
          sizeKey: '300x300',
          format: 'jpeg',
          filters: { blur: 40 },
          url: 'https://cdn/blur.jpg',
          contentType: 'image/jpeg',
        },
      ],
      missing: [],
    };
    const out = formatPictureUrls(decision);
    assert.deepEqual(out.sizes['300x300'].jpeg, {
      url: 'https://cdn/plain.jpg',
      contentType: 'image/jpeg',
    });
  });
});
