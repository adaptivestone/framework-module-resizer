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
        '{"animated":{"animated":false,"animationFrames":64,"pixelBudget":50000000},"encode":{"effort":4,"quality":82},"flatten":null,"format":"webp","maxSize":{"height":1200,"width":2000},"resultDimension":5000,"sharpen":false,"version":null}',
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
      '9a360524ab7ba00b',
    );
    assert.equal(
      encodeSignature(c, { format: 'webp', fit: true }),
      'd1382a568c3270da',
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
      'a275d5cfd7116722',
    );
    assert.equal(
      encodeSignature(c, { format: 'gif', fit: true }),
      '529aa100b4db0a2a',
    );
    assert.equal(
      encodeSignature(c, { format: 'webp', fit: false, version: 'v2' }),
      '7ccee5bd2d5aa3dd',
    );
  });

  test('encodeSignature changes only for the rows an input affects', () => {
    const cover = (format: string) => ({ format, fit: false });
    const fit = (format: string) => ({ format, fit: true });

    const quality70 = makeImageConfig({
      encode: { formats: { webp: { quality: 70 } } },
    });
    assert.equal(encodeSignature(quality70, cover('webp')), '3936af03d1b04d94');
    assert.equal(encodeSignature(quality70, cover('jpeg')), '83d53beb7e1f8872');

    // The same options with their keys in another order sign the same.
    const reordered = makeImageConfig();
    reordered.encode.formats.webp = { effort: 4, quality: 82 };
    assert.deepEqual(Object.keys(reordered.encode.formats.webp), [
      'effort',
      'quality',
    ]);
    assert.equal(encodeSignature(reordered, cover('webp')), '9a360524ab7ba00b');

    const flattenWebp = makeImageConfig({
      encode: { flatten: { formats: ['jpeg', 'webp'] } },
    });
    assert.equal(
      encodeSignature(flattenWebp, cover('jpeg')),
      '83d53beb7e1f8872',
    );
    assert.equal(
      encodeSignature(flattenWebp, cover('webp')),
      '80adcd788ca1d6c4',
    );

    // `animated` counts for the animated formats only.
    const animated = makeImageConfig({ animated: true });
    assert.equal(encodeSignature(animated, cover('jpeg')), '83d53beb7e1f8872');
    assert.equal(encodeSignature(animated, cover('avif')), '620ba576b62ed200');
    assert.equal(encodeSignature(animated, cover('webp')), '984ba2b2149a2dd7');
    assert.equal(encodeSignature(animated, cover('gif')), 'b2db30509308f358');

    // So does the animation frame cap.
    const frames = makeImageConfig({ limits: { animationFrames: 32 } });
    assert.equal(encodeSignature(frames, cover('jpeg')), '83d53beb7e1f8872');
    assert.equal(encodeSignature(frames, fit('jpeg')), '5e71af5703629b0d');
    assert.equal(encodeSignature(frames, cover('avif')), '620ba576b62ed200');
    assert.equal(encodeSignature(frames, cover('webp')), '4f8d99b530e4e662');
    assert.equal(encodeSignature(frames, fit('webp')), 'b32410ef228847cc');
    assert.equal(encodeSignature(frames, cover('gif')), '54f2ff53458f6874');

    // `maxSize` counts for fit rows only.
    const maxSize = makeImageConfig({ maxSize: { width: 2400, height: 1600 } });
    assert.equal(encodeSignature(maxSize, cover('jpeg')), '83d53beb7e1f8872');
    assert.equal(encodeSignature(maxSize, cover('webp')), '9a360524ab7ba00b');
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

  test('the pixel budget counts for animated formats only', () => {
    const cover = (format: string) => ({ format, fit: false });
    const base = makeImageConfig();
    // The budget is min(limits.sourcePixels, limits.inputPixels): 50 000 000 on the defaults,
    // where sourcePixels is the smaller one.
    assert.equal(
      Math.min(base.limits.sourcePixels, base.limits.inputPixels),
      50_000_000,
    );

    // inputPixels below sourcePixels lowers the budget: animated rows change, jpeg does not.
    const lowInput = makeImageConfig({ limits: { inputPixels: 40_000_000 } });
    assert.equal(encodeSignature(lowInput, cover('jpeg')), '83d53beb7e1f8872');
    assert.notEqual(
      encodeSignature(lowInput, cover('webp')),
      encodeSignature(base, cover('webp')),
    );
    assert.notEqual(
      encodeSignature(lowInput, cover('gif')),
      encodeSignature(base, cover('gif')),
    );
    assert.equal(encodeSignature(lowInput, cover('webp')), '0e6418299a0f3b3d');
    assert.equal(encodeSignature(lowInput, cover('gif')), 'fb7a053a8c8523d3');

    // inputPixels raised leaves the budget at sourcePixels: no row changes.
    const highInput = makeImageConfig({ limits: { inputPixels: 300_000_000 } });
    for (const format of ['jpeg', 'avif', 'webp', 'gif']) {
      assert.equal(
        encodeSignature(highInput, cover(format)),
        encodeSignature(base, cover(format)),
      );
    }

    // sourcePixels lowered lowers the budget too: animated rows change, jpeg does not.
    const lowSource = makeImageConfig({ limits: { sourcePixels: 40_000_000 } });
    assert.equal(encodeSignature(lowSource, cover('jpeg')), '83d53beb7e1f8872');
    assert.notEqual(
      encodeSignature(lowSource, cover('webp')),
      encodeSignature(base, cover('webp')),
    );
    assert.notEqual(
      encodeSignature(lowSource, cover('gif')),
      encodeSignature(base, cover('gif')),
    );

    // Only the budget is signed, not the limit that set it: the same min signs the same.
    assert.equal(
      encodeSignature(lowSource, cover('webp')),
      encodeSignature(lowInput, cover('webp')),
    );
    assert.equal(
      encodeSignature(lowSource, cover('gif')),
      encodeSignature(lowInput, cover('gif')),
    );
  });
});
