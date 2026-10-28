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
    // The recipe itself, written out. A row signs the sharpen flag of its own fit mode (the default
    // config sharpens cover rows only), and an animated format signs its animation settings.
    assert.equal(
      sha16(
        '{"animated":null,"encode":{"chromaSubsampling":"4:2:0","mozjpeg":true,"quality":88},"flatten":"#ffffff","format":"jpeg","maxSize":null,"resultDimension":5000,"sharpen":true,"version":null}',
      ),
      encodeSignature(c, { format: 'jpeg', fit: false }),
    );
    assert.equal(
      sha16(
        '{"animated":{"animated":false,"animationFrames":64},"encode":{"effort":4,"quality":82},"flatten":null,"format":"webp","maxSize":{"height":1200,"width":2000},"resultDimension":5000,"sharpen":false,"version":null}',
      ),
      encodeSignature(c, { format: 'webp', fit: true }),
    );
    assert.equal(
      encodeSignature(c, { format: 'jpeg', fit: false }),
      '83d53beb7e1f8872',
    );
    assert.equal(
      encodeSignature(c, { format: 'jpeg', fit: true }),
      '5e71af5703629b0d',
    );
    assert.equal(
      encodeSignature(c, { format: 'webp', fit: false }),
      '5bff549d897f4636',
    );
    assert.equal(
      encodeSignature(c, { format: 'webp', fit: true }),
      '287c3af56c8b2a35',
    );
    assert.equal(
      encodeSignature(c, { format: 'avif', fit: false }),
      '620ba576b62ed200',
    );
    assert.equal(
      encodeSignature(c, { format: 'avif', fit: true }),
      '90689746d79697f5',
    );
    // gif has no encode entry: `encode` is {}.
    assert.equal(
      encodeSignature(c, { format: 'gif', fit: false }),
      'a0113f7fe92058f1',
    );
    assert.equal(
      encodeSignature(c, { format: 'gif', fit: true }),
      'd73b43bfcd2f3b93',
    );
    assert.equal(
      encodeSignature(c, { format: 'webp', fit: false, version: 'v2' }),
      'b8283c2b8050efb8',
    );
  });

  test('encodeSignature changes only for the rows an input affects', () => {
    const cover = (format: string) => ({ format, fit: false });
    const fit = (format: string) => ({ format, fit: true });

    const quality70 = makeImageConfig({
      encode: { formats: { webp: { quality: 70 } } },
    });
    assert.equal(encodeSignature(quality70, cover('webp')), '428c6aa9b8c3b733');
    assert.equal(encodeSignature(quality70, cover('jpeg')), '83d53beb7e1f8872');

    // The same options with their keys in another order sign the same.
    const reordered = makeImageConfig();
    reordered.encode.formats.webp = { effort: 4, quality: 82 };
    assert.deepEqual(Object.keys(reordered.encode.formats.webp), [
      'effort',
      'quality',
    ]);
    assert.equal(encodeSignature(reordered, cover('webp')), '5bff549d897f4636');

    const flattenWebp = makeImageConfig({
      encode: { flatten: { formats: ['jpeg', 'webp'] } },
    });
    assert.equal(
      encodeSignature(flattenWebp, cover('jpeg')),
      '83d53beb7e1f8872',
    );
    assert.equal(
      encodeSignature(flattenWebp, cover('webp')),
      '56e84f45d6c5e06a',
    );

    // `animated` counts for the animated formats only.
    const animated = makeImageConfig({ animated: true });
    assert.equal(encodeSignature(animated, cover('jpeg')), '83d53beb7e1f8872');
    assert.equal(encodeSignature(animated, cover('avif')), '620ba576b62ed200');
    assert.equal(encodeSignature(animated, cover('webp')), '7700166d4996a056');
    assert.equal(encodeSignature(animated, cover('gif')), '36b05b342b7c7982');

    // So does the animation frame cap.
    const frames = makeImageConfig({ limits: { animationFrames: 32 } });
    assert.equal(encodeSignature(frames, cover('jpeg')), '83d53beb7e1f8872');
    assert.equal(encodeSignature(frames, fit('jpeg')), '5e71af5703629b0d');
    assert.equal(encodeSignature(frames, cover('avif')), '620ba576b62ed200');
    assert.equal(encodeSignature(frames, cover('webp')), 'a65ee58d08542284');
    assert.equal(encodeSignature(frames, fit('webp')), '6904dc4087be56d3');
    assert.equal(encodeSignature(frames, cover('gif')), '956b62f8eb94e0db');

    // `maxSize` counts for fit rows only.
    const maxSize = makeImageConfig({ maxSize: { width: 2400, height: 1600 } });
    assert.equal(encodeSignature(maxSize, cover('jpeg')), '83d53beb7e1f8872');
    assert.equal(encodeSignature(maxSize, cover('webp')), '5bff549d897f4636');
    assert.equal(encodeSignature(maxSize, fit('jpeg')), '422c6bae973f3d32');

    // A row signs only the sharpen half of its own fit mode: `sharpen.fit` changes fit rows only,
    // `sharpen.cover` cover rows only.
    const sharpenFit = makeImageConfig({
      encode: { sharpen: { cover: true, fit: true } },
    });
    assert.equal(
      encodeSignature(sharpenFit, cover('jpeg')),
      '83d53beb7e1f8872',
    );
    assert.equal(encodeSignature(sharpenFit, fit('jpeg')), '16860bd35329345d');
    const sharpenCover = makeImageConfig({
      encode: { sharpen: { cover: false, fit: false } },
    });
    assert.equal(
      encodeSignature(sharpenCover, cover('jpeg')),
      'b074fbe24e5e7f6f',
    );
    assert.equal(
      encodeSignature(sharpenCover, fit('jpeg')),
      '5e71af5703629b0d',
    );
    // `sharpen: false` sharpens no row, as { cover: false, fit: false } does: they sign the same.
    const noSharpen = makeImageConfig({ encode: { sharpen: false } });
    assert.equal(encodeSignature(noSharpen, cover('jpeg')), 'b074fbe24e5e7f6f');
    assert.equal(encodeSignature(noSharpen, fit('jpeg')), '5e71af5703629b0d');
  });
});
