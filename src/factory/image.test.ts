import assert from 'node:assert/strict';
import { test } from 'node:test';
import defaultResizeConfig from '../config/resize.ts';
import { makeImageConfig } from '../testHelpers/resizeConfig.ts';
import type { ResizeConfig } from '../types.d.ts';
import { mergeImageConfig } from './image.ts';

const merge = (partial: unknown) => mergeImageConfig(partial) as ResizeConfig;

test("a complete config comes back deep-equal, with the host's own objects", () => {
  const config = makeImageConfig();
  const merged = merge(config);
  assert.deepEqual(merged, config);
  // Nothing needed a default, so the host's object itself comes back.
  assert.strictEqual(merged, config);
  assert.strictEqual(merged.formats, config.formats);
  assert.strictEqual(merged.encode, config.encode);
  assert.strictEqual(merged.limits, config.limits);
});

test('encode.formats is replaced as a whole', () => {
  const formats = { webp: {} };
  const merged = merge({ encode: { formats } });
  assert.deepEqual(merged.encode.formats, { webp: {} });
  assert.strictEqual(merged.encode.formats, formats);
  // The other encode keys take their defaults.
  assert.deepEqual(merged.encode.sharpen, defaultResizeConfig.encode.sharpen);
  assert.deepEqual(merged.encode.flatten, defaultResizeConfig.encode.flatten);
});

test('objects merge key by key; arrays replace; undefined takes the default', () => {
  const formatsOnly = merge({ formats: ['webp'] });
  assert.deepEqual(formatsOnly.formats, ['webp']);
  assert.deepEqual(formatsOnly.limits, defaultResizeConfig.limits);
  assert.deepEqual(formatsOnly, { ...defaultResizeConfig, formats: ['webp'] });

  const limits = merge({ limits: { sourcePixels: 1 } }).limits;
  assert.deepEqual(limits, { ...defaultResizeConfig.limits, sourcePixels: 1 });

  const upload = merge({ upload: { formats: ['png'] } }).upload;
  assert.equal(upload.maxBytes, defaultResizeConfig.upload.maxBytes);
  assert.deepEqual(upload.formats, ['png']);

  assert.equal(merge({ encode: { sharpen: false } }).encode.sharpen, false);

  assert.deepEqual(
    merge({ maxSize: undefined }).maxSize,
    defaultResizeConfig.maxSize,
  );
  assert.deepEqual(merge({}), defaultResizeConfig);
});

test('the result shares no object with the defaults', () => {
  const before = structuredClone(defaultResizeConfig);
  const merged = merge({ formats: ['webp'] });
  merged.limits.sourcePixels = 1;
  merged.encode.formats.jpeg.quality = 1;
  merged.upload.formats.push('tiff');
  merge({ limits: { inputPixels: 2 } }).maxSize.width = 1;
  assert.deepEqual(defaultResizeConfig, before);
  assert.notStrictEqual(merge({}).encode, merge({}).encode);
});

test('a value that is not an object is returned as it is; unknown and removed keys pass through', () => {
  assert.equal(mergeImageConfig('x'), 'x');
  assert.equal(mergeImageConfig(null), null);
  const list = [1];
  assert.strictEqual(mergeImageConfig(list), list);
  const merged = mergeImageConfig({ webpAvifOnly: true }) as Record<
    string,
    unknown
  >;
  assert.equal(merged.webpAvifOnly, true);
  // A wrong type inside is kept for validation to report.
  assert.equal(merge({ limits: 'x' }).limits, 'x');
});
