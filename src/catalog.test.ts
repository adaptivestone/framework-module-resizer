import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Catalog } from './catalog.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import type { MediaLike, MissingPreview, PreviewScope } from './types.d.ts';

// encode.formats (the defaults) has jpeg, webp and avif.
const config = makeImageConfig({ formats: ['jpeg', 'webp'] });
const catalog = new Catalog({ config });
const scope: PreviewScope = { resizer: 'default', pipeline: 'default' };

test('storedIdentities keeps the usable rows of the scope only', () => {
  const media: MediaLike = {
    previews: [
      {
        storageRef: { key: 'a.jpg' },
        resizer: 'default',
        pipeline: 'default',
        sizeKey: '10x10',
        format: 'jpeg',
        contentType: 'image/jpeg',
      },
      // No storageRef.
      {
        storageRef: undefined,
        sizeKey: '30x30',
        format: 'jpeg',
        contentType: 'image/jpeg',
      },
      // An SVG row is never served.
      {
        storageRef: { key: 'b.svg' },
        sizeKey: '40x40',
        format: 'png',
        contentType: 'image/svg+xml',
      },
      // Another pipeline's rendering.
      {
        storageRef: { key: 'c.jpg' },
        pipeline: 'wm',
        sizeKey: '10x10',
        format: 'jpeg',
        contentType: 'image/jpeg',
      },
      // A row stored before previews recorded their scope belongs to `default`.
      {
        storageRef: { key: 'd.webp' },
        sizeKey: '20x20',
        format: 'webp',
        contentType: 'image/webp',
      },
    ],
  };
  assert.deepEqual(
    catalog.storedIdentities(media, scope),
    new Set([
      'default:default:10x10:jpeg:none',
      'default:default:20x20:webp:none',
    ]),
  );
  assert.deepEqual(
    catalog.storedIdentities(media, { resizer: 'default', pipeline: 'wm' }),
    new Set(['default:wm:10x10:jpeg:none']),
  );
});

test('storedPreviews keeps the later of two rows with one identity', () => {
  const first = {
    storageRef: { key: 'first.jpg' },
    sizeKey: '10x10',
    format: 'jpeg',
    contentType: 'image/jpeg',
  };
  const later = {
    storageRef: { key: 'later.jpg' },
    resizer: 'default',
    pipeline: 'default',
    sizeKey: '10x10',
    format: 'jpeg',
    contentType: 'image/jpeg',
  };
  const stored = catalog.storedPreviews({ previews: [first, later] }, scope);
  assert.equal(stored.size, 1);
  assert.equal(stored.get('default:default:10x10:jpeg:none'), later);
});

test('missing skips stored identities and sizes without a key', () => {
  const media: MediaLike = {
    previews: [
      {
        storageRef: { key: 'a.jpg' },
        sizeKey: '10x10',
        format: 'jpeg',
        contentType: 'image/jpeg',
      },
    ],
  };
  const missing = catalog.missing(
    media,
    [{ width: 10, height: 10 }, {}, { width: 30 }],
    ['jpeg'],
    scope,
  );
  assert.deepEqual(
    missing.map((variant) => variant.sizeKey),
    ['30w'],
  );
  // expand ignores what is stored.
  assert.deepEqual(
    catalog
      .expand([{ width: 10, height: 10 }, {}, { width: 30 }], ['jpeg'], scope)
      .map((variant) => variant.sizeKey),
    ['10x10', '30w'],
  );
});

test('identity is the scope, size key, format and filter signature', () => {
  assert.equal(
    catalog.identity(
      { resizer: 'listings', pipeline: 'wm' },
      { sizeKey: '10x10', format: 'webp', filters: { b: 2, a: 1 } },
    ),
    'listings:wm:10x10:webp:a:1|b:2',
  );
});

test('canonicalize removes duplicates and sorts the variants', () => {
  const webp: MissingPreview = { sizeKey: '10x10', format: 'webp' };
  const jpeg: MissingPreview = { sizeKey: '10x10', format: 'jpeg' };
  assert.deepEqual(catalog.canonicalize([webp, jpeg, webp]), [jpeg, webp]);
});

test('configuredFormats keeps configured ids in order and names the rest once', () => {
  assert.deepEqual(catalog.configuredFormats(['jpeg', 'jpg', 'webp', 'jpg']), {
    formats: ['jpeg', 'webp'],
    dropped: ['jpg'],
  });
  assert.deepEqual(catalog.configuredFormats(), {
    formats: ['jpeg', 'webp'],
    dropped: [],
  });
});

test('splitConfigured treats a malformed tap entry as unconfigured', () => {
  const { configured, unconfigured } = catalog.splitConfigured([
    { sizeKey: '10x10', format: 'webp' },
    { sizeKey: '10x10', format: 'raw' },
    null as never,
  ]);
  assert.equal(configured.length, 1);
  assert.equal(unconfigured.length, 2);
});
