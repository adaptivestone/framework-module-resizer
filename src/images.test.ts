import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  calculateResizedDimensions,
  DEFAULT_SCOPE,
  expandMissingPreviews,
  getFilterSig,
  getImageContentType,
  getPreviewIdentity,
  getSizeKey,
  isCatalogCovered,
  parseSizeKey,
  previewScope,
} from './images.ts';

describe('getSizeKey', () => {
  test('fit → "fit"', () => {
    assert.equal(getSizeKey({ fit: true }), 'fit');
  });

  test('both dims → "WxH"', () => {
    assert.equal(getSizeKey({ width: 1760, height: 990 }), '1760x990');
  });

  test('width only → "Ww"', () => {
    assert.equal(getSizeKey({ width: 620 }), '620w');
  });

  test('height only → "Hh"', () => {
    assert.equal(getSizeKey({ height: 400 }), '400h');
  });

  test('fit wins over width/height', () => {
    assert.equal(getSizeKey({ fit: true, width: 300, height: 300 }), 'fit');
  });

  test('rounds fractional dimensions so the key round-trips', () => {
    assert.equal(getSizeKey({ width: 300.4, height: 300.6 }), '300x301');
  });

  test('throws when no dimension and not fit', () => {
    assert.throws(() => getSizeKey({}));
  });

  test('a non-positive dimension does not count', () => {
    assert.throws(() => getSizeKey({ width: 0 }));
    assert.throws(() => getSizeKey({ width: -5 }));
  });

  test('a non-finite dimension does not count', () => {
    assert.throws(() => getSizeKey({ width: Number.NaN }));
    assert.throws(() => getSizeKey({ width: Number.POSITIVE_INFINITY }));
  });
});

describe('parseSizeKey', () => {
  test('"fit" → fit:true, no dims', () => {
    const r = parseSizeKey('fit');
    assert.equal(r.sizeKey, 'fit');
    assert.equal(r.fit, true);
    assert.equal(r.width, undefined);
    assert.equal(r.height, undefined);
  });

  test('"WxH" → both dims as numbers, fit:false', () => {
    assert.deepEqual(parseSizeKey('1760x990'), {
      sizeKey: '1760x990',
      width: 1760,
      height: 990,
      fit: false,
    });
  });

  test('"Ww" → width only', () => {
    const r = parseSizeKey('620w');
    assert.equal(r.sizeKey, '620w');
    assert.equal(r.width, 620);
    assert.equal(r.height, undefined);
    assert.equal(r.fit, false);
  });

  test('"Hh" → height only', () => {
    const r = parseSizeKey('400h');
    assert.equal(r.sizeKey, '400h');
    assert.equal(r.height, 400);
    assert.equal(r.width, undefined);
    assert.equal(r.fit, false);
  });

  test('unknown key → echoed, no dims, fit:false', () => {
    const r = parseSizeKey('garbage');
    assert.equal(r.sizeKey, 'garbage');
    assert.equal(r.width, undefined);
    assert.equal(r.height, undefined);
    assert.equal(r.fit, false);
  });

  test('round-trips with getSizeKey for every key shape', () => {
    for (const size of [
      { fit: true },
      { width: 1760, height: 990 },
      { width: 620 },
      { height: 400 },
    ] as const) {
      const key = getSizeKey(size);
      const parsed = parseSizeKey(key);
      assert.equal(parsed.sizeKey, key);
    }
  });
});

describe('getFilterSig', () => {
  test('undefined → "none"', () => {
    assert.equal(getFilterSig(undefined), 'none');
  });

  test('empty bag → "none"', () => {
    assert.equal(getFilterSig({}), 'none');
  });

  test('single filter → "k:v"', () => {
    assert.equal(getFilterSig({ blur: 40 }), 'blur:40');
  });

  test('keys are sorted (order-independent)', () => {
    assert.equal(getFilterSig({ b: 2, a: 1 }), 'a:1|b:2');
    assert.equal(getFilterSig({ a: 1, b: 2 }), getFilterSig({ b: 2, a: 1 }));
  });

  test('boolean and string values retain their JSON types', () => {
    assert.equal(
      getFilterSig({ sharpen: true, tone: 'warm' }),
      'sharpen:true|tone:"warm"',
    );
  });

  test('numeric filters keep their prior signatures', () => {
    // JSON preserves the existing representation for numbers.
    assert.equal(getFilterSig({ blur: 40 }), 'blur:40');
    assert.equal(getFilterSig({ b: 2, a: 1 }), 'a:1|b:2');
  });

  test('escapes | : \\ so distinct filter bags never collide', () => {
    // Before escaping, `{ a: '1|b:2' }` and `{ a: 1, b: 2 }` both produced 'a:1|b:2'.
    assert.notEqual(getFilterSig({ a: '1|b:2' }), getFilterSig({ a: 1, b: 2 }));
    assert.equal(getFilterSig({ a: '1|b:2' }), 'a:"1\\|b\\:2"');
    assert.equal(getFilterSig({ a: 1, b: 2 }), 'a:1|b:2');
    // a backslash in a value is itself escaped (and escaped BEFORE | / :).
    assert.equal(getFilterSig({ a: 'x\\y' }), `a:"x${'\\'.repeat(4)}y"`);
  });

  test('keeps nested runtime filter values deterministic and distinct', () => {
    const first = { crop: { x: 0, y: 0 } } as never;
    const reordered = { crop: { y: 0, x: 0 } } as never;
    const second = { crop: { x: 10, y: 0 } } as never;
    assert.equal(getFilterSig(first), getFilterSig(reordered));
    assert.notEqual(getFilterSig(first), getFilterSig(second));
  });

  test('keeps scalar leaf types distinct in nested runtime filters', () => {
    assert.notEqual(
      getFilterSig({ crop: { x: 1 } } as never),
      getFilterSig({ crop: { x: '1' } } as never),
    );
  });
});

describe('getPreviewIdentity', () => {
  test('composes resizer:pipeline:sizeKey:format:none when no filters', () => {
    assert.equal(
      getPreviewIdentity(DEFAULT_SCOPE, 'fit', 'webp'),
      'default:default:fit:webp:none',
    );
  });

  test('composes with the filter signature', () => {
    assert.equal(
      getPreviewIdentity(DEFAULT_SCOPE, '300x300', 'avif', { blur: 40 }),
      'default:default:300x300:avif:blur:40',
    );
  });

  test('includes the resizer and pipeline', () => {
    assert.equal(
      getPreviewIdentity(
        { resizer: 'listings', pipeline: 'watermark' },
        '300x300',
        'webp',
      ),
      'listings:watermark:300x300:webp:none',
    );
  });

  test('names containing ":" cannot collide', () => {
    const a = getPreviewIdentity(
      { resizer: 'a:b', pipeline: 'c' },
      '300x300',
      'webp',
    );
    const b = getPreviewIdentity(
      { resizer: 'a', pipeline: 'b:c' },
      '300x300',
      'webp',
    );
    assert.notEqual(a, b);
  });
});

describe('previewScope', () => {
  test('a stored preview without resizer/pipeline belongs to the default scope', () => {
    assert.deepEqual(previewScope({}), DEFAULT_SCOPE);
    assert.deepEqual(previewScope({ pipeline: 'watermark' }), {
      resizer: 'default',
      pipeline: 'watermark',
    });
    assert.deepEqual(
      previewScope({ resizer: 'listings', pipeline: 'watermark' }),
      { resizer: 'listings', pipeline: 'watermark' },
    );
  });
});

describe('expandMissingPreviews with a scope', () => {
  const media = {
    id: 'm1',
    previews: [
      {
        storageRef: { k: 1 },
        sizeKey: '300x300',
        format: 'webp',
        contentType: 'image/webp',
      },
    ],
  };
  const sizes = [{ width: 300, height: 300 }];

  test('ignores previews of another pipeline or Resizer', () => {
    assert.equal(
      expandMissingPreviews(media, sizes, ['webp'], DEFAULT_SCOPE).length,
      0,
    );
    assert.equal(
      expandMissingPreviews(media, sizes, ['webp'], {
        resizer: 'default',
        pipeline: 'watermark',
      }).length,
      1,
    );
    assert.equal(
      expandMissingPreviews(media, sizes, ['webp'], {
        resizer: 'listings',
        pipeline: 'default',
      }).length,
      1,
    );
  });

  test('isCatalogCovered uses the default scope unless given one', () => {
    assert.equal(isCatalogCovered(media, sizes, ['webp']), true);
    assert.equal(
      isCatalogCovered(media, sizes, ['webp'], {
        resizer: 'default',
        pipeline: 'watermark',
      }),
      false,
    );
  });
});

describe('getImageContentType', () => {
  test('maps each raster preview format', () => {
    assert.equal(getImageContentType('jpeg'), 'image/jpeg');
    assert.equal(getImageContentType('webp'), 'image/webp');
    assert.equal(getImageContentType('avif'), 'image/avif');
  });

  test('undefined format → undefined', () => {
    assert.equal(getImageContentType(undefined), undefined);
  });
});

describe('calculateResizedDimensions', () => {
  test('cover passes both target dims through unchanged', () => {
    const r = calculateResizedDimensions(4000, 3000, 300, 300, false);
    assert.equal(r.width, 300);
    assert.equal(r.height, 300);
  });

  test('cover width-only leaves height undefined', () => {
    const r = calculateResizedDimensions(4000, 3000, 620, undefined, false);
    assert.equal(r.width, 620);
    assert.equal(r.height, undefined);
  });

  test('cover height-only leaves width undefined', () => {
    const r = calculateResizedDimensions(4000, 3000, undefined, 400, false);
    assert.equal(r.width, undefined);
    assert.equal(r.height, 400);
  });

  test('fit downscales to fit inside maxSize, preserving aspect ratio', () => {
    // 4000x3000 into 2000x1200 → height-bound: scale 0.4 → 1600x1200
    const r = calculateResizedDimensions(
      4000,
      3000,
      undefined,
      undefined,
      true,
      {
        width: 2000,
        height: 1200,
      },
    );
    assert.equal(r.width, 1600);
    assert.equal(r.height, 1200);
  });

  test('fit never upscales a source smaller than maxSize', () => {
    const r = calculateResizedDimensions(
      1000,
      800,
      undefined,
      undefined,
      true,
      {
        width: 2000,
        height: 1200,
      },
    );
    assert.equal(r.width, 1000);
    assert.equal(r.height, 800);
  });

  test('fit rounds both sides', () => {
    // 3000x1000 into 2000x1200 → width-bound: scale 2/3 → 2000x667 (1000*0.6667=666.7→667)
    const r = calculateResizedDimensions(
      3000,
      1000,
      undefined,
      undefined,
      true,
      {
        width: 2000,
        height: 1200,
      },
    );
    assert.equal(r.width, 2000);
    assert.equal(r.height, 667);
  });

  test('fit uses the default maxSize {2000,1200} when omitted', () => {
    const r = calculateResizedDimensions(
      4000,
      3000,
      undefined,
      undefined,
      true,
    );
    assert.equal(r.width, 1600);
    assert.equal(r.height, 1200);
  });
});

describe('isCatalogCovered', () => {
  const sizes = [{ width: 20, height: 20 }];
  const formats = ['jpeg'] as const;

  test('false when no matching preview is stored', () => {
    assert.equal(
      isCatalogCovered(
        { original: { storageRef: { key: 'o' } }, previews: [] },
        sizes,
        [...formats],
      ),
      false,
    );
  });

  test('true when every size×format identity is already stored', () => {
    assert.equal(
      isCatalogCovered(
        {
          original: { storageRef: { key: 'o' } },
          previews: [
            {
              storageRef: { key: 'p' },
              sizeKey: '20x20',
              format: 'jpeg',
              contentType: 'image/jpeg',
            },
          ],
        },
        sizes,
        [...formats],
      ),
      true,
    );
  });

  test('SVG original is covered only after raster previews are persisted', () => {
    assert.equal(
      isCatalogCovered(
        {
          original: {
            storageRef: { key: 'x.svg' },
            contentType: 'image/svg+xml',
          },
        },
        sizes,
        [...formats],
      ),
      false,
    );
    assert.equal(
      isCatalogCovered(
        {
          original: {
            storageRef: { key: 'x.svg' },
            contentType: 'image/svg+xml',
          },
        },
        [{ width: 100, height: 100 }],
        ['webp'],
      ),
      false,
    );
  });

  test('empty sizes is covered (nothing to generate)', () => {
    assert.equal(
      isCatalogCovered(
        { original: { storageRef: { key: 'o' } } },
        [],
        ['jpeg'],
      ),
      true,
    );
  });
});
