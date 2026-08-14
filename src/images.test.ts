import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  calculateResizedDimensions,
  getFilterSig,
  getImageContentType,
  getPreviewIdentity,
  getSizeKey,
  isCatalogCovered,
  parseSizeKey,
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

  test('boolean and string values stringify', () => {
    assert.equal(
      getFilterSig({ sharpen: true, tone: 'warm' }),
      'sharpen:true|tone:warm',
    );
  });

  test('plain filters keep their prior (unescaped) signatures', () => {
    // Regression guard: values/keys with no `\`, `|`, `:` are unchanged by the escaping.
    assert.equal(getFilterSig({ blur: 40 }), 'blur:40');
    assert.equal(getFilterSig({ b: 2, a: 1 }), 'a:1|b:2');
  });

  test('escapes | : \\ so distinct filter bags never collide', () => {
    // Before escaping, `{ a: '1|b:2' }` and `{ a: 1, b: 2 }` both produced 'a:1|b:2'.
    assert.notEqual(getFilterSig({ a: '1|b:2' }), getFilterSig({ a: 1, b: 2 }));
    assert.equal(getFilterSig({ a: '1|b:2' }), 'a:1\\|b\\:2');
    assert.equal(getFilterSig({ a: 1, b: 2 }), 'a:1|b:2');
    // a backslash in a value is itself escaped (and escaped BEFORE | / :).
    assert.equal(getFilterSig({ a: 'x\\y' }), 'a:x\\\\y');
  });
});

describe('getPreviewIdentity', () => {
  test('composes sizeKey:format:none when no filters', () => {
    assert.equal(getPreviewIdentity('fit', 'webp'), 'fit:webp:none');
  });

  test('composes with the filter signature', () => {
    assert.equal(
      getPreviewIdentity('300x300', 'avif', { blur: 40 }),
      '300x300:avif:blur:40',
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
      isCatalogCovered({ original: { key: 'o' }, previews: [] }, sizes, [
        ...formats,
      ]),
      false,
    );
  });

  test('true when every size×format identity is already stored', () => {
    assert.equal(
      isCatalogCovered(
        {
          original: { key: 'o' },
          previews: [
            {
              key: 'p',
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

  test('SVG original is covered without previews (pass-through)', () => {
    assert.equal(
      isCatalogCovered(
        { original: { key: 'x.svg', contentType: 'image/svg+xml' } },
        sizes,
        [...formats],
      ),
      true,
    );
  });

  test('empty sizes is covered (nothing to generate)', () => {
    assert.equal(
      isCatalogCovered({ original: { key: 'o' } }, [], ['jpeg']),
      true,
    );
  });
});
