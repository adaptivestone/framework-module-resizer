import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatPictureUrls } from './formatPictureUrls.ts';
import type { ReadDecision, ReadyEntry } from './types.d.ts';

// A ready entry as resolve() builds it: always backed by a stored preview.
function entry(
  over: Partial<ReadyEntry> & Pick<ReadyEntry, 'sizeKey' | 'format' | 'url'>,
): ReadyEntry {
  const contentType = over.contentType ?? `image/${over.format}`;
  return {
    contentType,
    preview: {
      storageRef: { key: over.url },
      sizeKey: over.sizeKey,
      format: over.format,
      contentType,
    },
    ...over,
  };
}

describe('formatPictureUrls', () => {
  test('treats inherited size keys as data without modifying shared prototypes', () => {
    const sizeKeys = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
    const targets = [
      Object.prototype,
      Object,
      Object.prototype.toString,
      Object.prototype.hasOwnProperty,
    ];
    const descriptors = targets.map((target) =>
      Object.getOwnPropertyDescriptor(target, 'webp'),
    );
    try {
      const out = formatPictureUrls({
        ready: sizeKeys.map((sizeKey) =>
          entry({
            sizeKey,
            format: 'webp',
            url: `https://cdn/${sizeKey}.webp`,
          }),
        ),
        missing: [],
      });
      assert.deepEqual(
        targets.map((target) =>
          Object.getOwnPropertyDescriptor(target, 'webp'),
        ),
        descriptors,
      );
      assert.equal(Object.getPrototypeOf(out.sizes), Object.prototype);
      for (const sizeKey of sizeKeys) {
        assert.ok(Object.hasOwn(out.sizes, sizeKey));
        assert.deepEqual(out.sizes[sizeKey], {
          webp: {
            url: `https://cdn/${sizeKey}.webp`,
            contentType: 'image/webp',
          },
        });
      }
      assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
    } finally {
      // Keep a regressing implementation from polluting subsequent tests.
      targets.forEach((target, index) => {
        if (descriptors[index]) {
          Object.defineProperty(target, 'webp', descriptors[index]);
        } else {
          Reflect.deleteProperty(target, 'webp');
        }
      });
    }
  });

  test('treats special format keys from untyped callers as own data properties', () => {
    const formatKeys = ['__proto__', 'constructor', 'toString'];
    const out = formatPictureUrls({
      ready: formatKeys.map((format) =>
        entry({
          sizeKey: '320w',
          format: format as ReadyEntry['format'],
          url: `https://cdn/${format}`,
          contentType: 'image/webp',
        }),
      ),
      missing: [],
    });
    const byFormat = out.sizes['320w'];
    assert.equal(Object.getPrototypeOf(byFormat), Object.prototype);
    for (const format of formatKeys) {
      assert.ok(Object.hasOwn(byFormat, format));
      assert.deepEqual(byFormat[format], {
        url: `https://cdn/${format}`,
        contentType: 'image/webp',
      });
    }
    assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
  });

  test('groups ready entries by sizeKey then format', () => {
    const decision: ReadDecision = {
      ready: [
        entry({ sizeKey: '320x320', format: 'jpeg', url: 'https://cdn/a.jpg' }),
        entry({
          sizeKey: '320x320',
          format: 'webp',
          url: 'https://cdn/a.webp',
        }),
        entry({ sizeKey: 'fit', format: 'jpeg', url: 'https://cdn/b.jpg' }),
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

  test("each cell carries its entry's contentType", () => {
    const out = formatPictureUrls({
      ready: [
        entry({
          sizeKey: '300x300',
          format: 'jpeg',
          url: 'https://cdn/a.jpg',
          contentType: 'image/jpeg',
        }),
      ],
      missing: [],
    });
    assert.equal(out.id, undefined);
    assert.deepEqual(out.sizes['300x300'].jpeg, {
      url: 'https://cdn/a.jpg',
      contentType: 'image/jpeg',
    });
  });

  test('skips filtered variants so they cannot collide on sizeKey+format', () => {
    const decision: ReadDecision = {
      ready: [
        entry({
          sizeKey: '300x300',
          format: 'jpeg',
          url: 'https://cdn/plain.jpg',
        }),
        entry({
          sizeKey: '300x300',
          format: 'jpeg',
          filters: { blur: 40 },
          url: 'https://cdn/blur.jpg',
        }),
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
