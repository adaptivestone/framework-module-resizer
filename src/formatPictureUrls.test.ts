import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import sharp from 'sharp';
import { formatPictureUrls } from './formatPictureUrls.ts';
import { Resizer, resetResizerForTests } from './resizer.ts';
import {
  docMedia,
  MemoryTaskQueue,
  memoryStorage,
  silentLogger,
} from './testHelpers/fakes.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import type { MediaLike, ReadDecision, ReadyEntry } from './types.d.ts';

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

  test('an entry carries the size its row records, since a size key does not promise a size', () => {
    const stored = entry({
      sizeKey: '720x720',
      format: 'webp',
      url: '/a.webp',
    });
    stored.preview = {
      ...stored.preview,
      actualWidth: 400,
      actualHeight: 300,
    };
    const out = formatPictureUrls({ ready: [stored], missing: [] });
    // A type pin, before the deepEqual: that assertion narrows `actual` to what it expects, so
    // after it the line would compile on a type without these fields.
    const width: number | undefined = out.sizes['720x720'].webp.width;
    const height: number | undefined = out.sizes['720x720'].webp.height;
    assert.deepEqual([width, height], [400, 300]);
    assert.deepEqual(out.sizes['720x720'].webp, {
      url: '/a.webp',
      contentType: 'image/webp',
      width: 400,
      height: 300,
    });
  });

  test('a row without both dimensions leaves them out, with no key set to undefined', () => {
    const rows: Partial<ReadyEntry['preview']>[] = [
      {},
      { actualWidth: 400 },
      { actualHeight: 300 },
    ];
    for (const row of rows) {
      const stored = entry({
        sizeKey: '720x720',
        format: 'webp',
        url: '/a.webp',
      });
      stored.preview = { ...stored.preview, ...row };
      const cell = formatPictureUrls({ ready: [stored], missing: [] }).sizes[
        '720x720'
      ].webp;
      assert.deepEqual(cell, { url: '/a.webp', contentType: 'image/webp' });
      assert.deepEqual(Object.keys(cell), ['url', 'contentType']);
    }
  });

  test('a dimension that is not a positive, finite number leaves both out', () => {
    for (const bad of [Number.NaN, Infinity, -Infinity, 0, -1]) {
      for (const row of [
        { actualWidth: bad, actualHeight: 300 },
        { actualWidth: 400, actualHeight: bad },
        { actualWidth: bad, actualHeight: bad },
      ]) {
        const stored = entry({
          sizeKey: '720x720',
          format: 'webp',
          url: '/a.webp',
        });
        stored.preview = { ...stored.preview, ...row };
        const cell = formatPictureUrls({ ready: [stored], missing: [] }).sizes[
          '720x720'
        ].webp;
        assert.deepEqual(
          Object.keys(cell),
          ['url', 'contentType'],
          `${row.actualWidth}x${row.actualHeight}`,
        );
      }
    }
  });

  test('an entry an untyped host built, with no row, keeps its URL', () => {
    const { preview: _row, ...bare } = entry({
      sizeKey: '720x720',
      format: 'webp',
      url: '/a.webp',
    });
    const out = formatPictureUrls({
      ready: [bare as ReadyEntry],
      missing: [],
    });
    assert.deepEqual(out.sizes['720x720'].webp, {
      url: '/a.webp',
      contentType: 'image/webp',
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

describe('formatPictureUrls — the size a row records is not part of its freshness', () => {
  afterEach(resetResizerForTests);

  test('a row with or without it reads as fresh, at one URL, and queues nothing', async () => {
    const body = await sharp({
      create: {
        width: 100,
        height: 60,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();
    const docs = new Map<string, MediaLike>();
    const { storage } = memoryStorage();
    const tasks = new MemoryTaskQueue();
    const r = new Resizer({
      storage,
      media: docMedia(docs),
      tasks,
      config: makeImageConfig({ formats: ['webp'] }),
      logger: silentLogger,
    });
    const original = await r.uploadOriginal({ body, visibility: 'private' });
    docs.set('m1', { id: 'm1', original, previews: [] });
    const sizes = [{ width: 160, height: 160 }];
    await r.generate({
      media: structuredClone(docs.get('m1') as MediaLike),
      sizes,
      formats: ['webp'],
    });
    const recorded = structuredClone(docs.get('m1') as MediaLike);
    const [row] = recorded.previews ?? [];
    assert.deepEqual([row.actualWidth, row.actualHeight], [100, 60]);

    // A row as an older writer left it: the same signatures, no recorded size.
    const { actualWidth: _w, actualHeight: _h, ...bareRow } = row;
    const bare: MediaLike = { ...recorded, previews: [bareRow] };

    const cells = [];
    for (const media of [recorded, bare]) {
      const { decision } = await r.resolve({
        media,
        sizes,
        formats: ['webp'],
      });
      assert.equal(decision.missing.length, 0);
      assert.equal(decision.stale, undefined);
      assert.equal(decision.ready.length, 1);
      assert.equal(decision.ready[0].stale, undefined);
      cells.push(formatPictureUrls(decision).sizes['160x160'].webp);
    }
    assert.equal(tasks.rows.length, 0);
    assert.deepEqual(cells[0], {
      url: cells[1].url,
      contentType: 'image/webp',
      width: 100,
      height: 60,
    });
    assert.deepEqual(cells[1], {
      url: cells[0].url,
      contentType: 'image/webp',
    });
  });
});
