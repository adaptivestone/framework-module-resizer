// The fixed vectors of the preview signatures. A stored row's `origin` and `encodeSig` are compared
// against these recipes later, so a changed vector would make every stored preview look stale:
// never edit a vector to make a test pass.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { canonicalJson, encodeSignature, previewOrigin } from './signatures.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';

const ref = { key: 'originals/a1b2c3.jpg', visibility: 'private' };

const sha16 = (s: string): string =>
  createHash('sha256').update(s).digest('hex').slice(0, 16);

describe('canonicalJson', () => {
  test('canonicalJson sorts keys at every depth and drops undefined', () => {
    assert.equal(
      canonicalJson({ width: 4000, storageRef: ref, height: 3000 }),
      '{"height":3000,"storageRef":{"key":"originals/a1b2c3.jpg","visibility":"private"},"width":4000}',
    );
    assert.equal(
      canonicalJson({
        b: undefined,
        a: { d: 1, c: undefined },
        e: [{ g: 1, f: 2 }],
      }),
      '{"a":{"d":1},"e":[{"f":2,"g":1}]}',
    );
  });
});

describe('previewOrigin', () => {
  test('previewOrigin vectors', () => {
    assert.equal(
      previewOrigin(ref, { width: 4000, height: 3000 }),
      '8c64760b02a9f12a',
    );
    assert.equal(
      previewOrigin(
        { visibility: 'private', key: 'originals/a1b2c3.jpg' },
        { width: 4000, height: 3000 },
      ),
      '8c64760b02a9f12a',
    );
    assert.equal(
      previewOrigin(ref, { width: 3000, height: 4000 }),
      '85fe58ff22d3ce0c',
    );
    assert.equal(
      previewOrigin(
        { key: 'originals/ffff.jpg', visibility: 'private' },
        { width: 4000, height: 3000 },
      ),
      'bda63bc43f25605a',
    );
  });
});

describe('encodeSignature', () => {
  test('encodeSignature vectors on the default config', () => {
    const c = makeImageConfig();
    // The recipe itself, written out.
    assert.equal(
      sha16(
        '{"animated":null,"encode":{"chromaSubsampling":"4:2:0","mozjpeg":true,"quality":88},"flatten":"#ffffff","format":"jpeg","maxSize":null,"resultDimension":5000,"sharpen":{"cover":true,"fit":false},"version":null}',
      ),
      encodeSignature(c, { format: 'jpeg', fit: false }),
    );
    assert.equal(
      sha16(
        '{"animated":false,"encode":{"effort":4,"quality":82},"flatten":null,"format":"webp","maxSize":{"height":1200,"width":2000},"resultDimension":5000,"sharpen":{"cover":true,"fit":false},"version":null}',
      ),
      encodeSignature(c, { format: 'webp', fit: true }),
    );
    assert.equal(
      encodeSignature(c, { format: 'jpeg', fit: false }),
      'c2e290f0d33595ae',
    );
    assert.equal(
      encodeSignature(c, { format: 'jpeg', fit: true }),
      'a20802f7b8adab7b',
    );
    assert.equal(
      encodeSignature(c, { format: 'webp', fit: false }),
      'a1505869c88e3331',
    );
    assert.equal(
      encodeSignature(c, { format: 'webp', fit: true }),
      'da2a7b4a2a82233e',
    );
    assert.equal(
      encodeSignature(c, { format: 'avif', fit: false }),
      '2ff643ff6cb17b14',
    );
    assert.equal(
      encodeSignature(c, { format: 'avif', fit: true }),
      '2c25efc6c41f5489',
    );
    // gif has no encode entry: `encode` is {}.
    assert.equal(
      encodeSignature(c, { format: 'gif', fit: false }),
      '4b5afbc181b0a5dc',
    );
    assert.equal(
      encodeSignature(c, { format: 'webp', fit: false, version: 'v2' }),
      'caa8e1b8ce43acc3',
    );
  });

  test('encodeSignature changes only for the rows an input affects', () => {
    const cover = (format: string) => ({ format, fit: false });

    const quality70 = makeImageConfig({
      encode: { formats: { webp: { quality: 70 } } },
    });
    assert.equal(encodeSignature(quality70, cover('webp')), 'cb56c7fdee932190');

    // The same options with their keys in another order sign the same.
    const reordered = makeImageConfig();
    reordered.encode.formats.webp = { effort: 4, quality: 82 };
    assert.deepEqual(Object.keys(reordered.encode.formats.webp), [
      'effort',
      'quality',
    ]);
    assert.equal(encodeSignature(reordered, cover('webp')), 'a1505869c88e3331');

    const flattenWebp = makeImageConfig({
      encode: { flatten: { formats: ['jpeg', 'webp'] } },
    });
    assert.equal(
      encodeSignature(flattenWebp, cover('jpeg')),
      'c2e290f0d33595ae',
    );
    assert.equal(
      encodeSignature(flattenWebp, cover('webp')),
      'ffd051bf0e215efb',
    );

    const animated = makeImageConfig({ animated: true });
    assert.equal(encodeSignature(animated, cover('jpeg')), 'c2e290f0d33595ae');
    assert.equal(encodeSignature(animated, cover('avif')), '2ff643ff6cb17b14');
    assert.equal(encodeSignature(animated, cover('webp')), '8087ac9f83544054');
    assert.equal(encodeSignature(animated, cover('gif')), 'cdc6e9d0d37ea008');

    const maxSize = makeImageConfig({ maxSize: { width: 2400, height: 1600 } });
    assert.equal(encodeSignature(maxSize, cover('jpeg')), 'c2e290f0d33595ae');
    assert.equal(
      encodeSignature(maxSize, { format: 'jpeg', fit: true }),
      'da288ee14dfbf632',
    );

    // The whole sharpen object counts for every row.
    const sharpen = makeImageConfig({
      encode: { sharpen: { cover: true, fit: true } },
    });
    assert.equal(encodeSignature(sharpen, cover('jpeg')), 'd49191720a3eb059');
  });
});
