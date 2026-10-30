import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Catalog } from './catalog.ts';
import { previewOrigin } from './signatures.ts';
import { stampFresh } from './testHelpers/fresh.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import type {
  MediaLike,
  MissingPreview,
  Original,
  Preview,
  PreviewScope,
} from './types.d.ts';

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
  const media: MediaLike = stampFresh(
    {
      original: { storageRef: { key: 'o' }, width: 10, height: 10 },
      previews: [
        {
          storageRef: { key: 'a.jpg' },
          sizeKey: '10x10',
          format: 'jpeg',
          contentType: 'image/jpeg',
        },
      ],
    },
    { config },
  );
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
  // A stored identity whose row is stale is still missing: it renders again.
  const stale = structuredClone(media);
  delete stale.previews?.[0].encodeSig;
  assert.deepEqual(
    catalog
      .missing(
        stale,
        [{ width: 10, height: 10 }, {}, { width: 30 }],
        ['jpeg'],
        scope,
      )
      .map((variant) => variant.sizeKey),
    ['10x10', '30w'],
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

// Freshness. A media whose original holds its storage ref and dimensions, with one cover row per
// format and, when asked, one fit row. Every test that changes a config builds its own.
function freshMedia(
  opts: { formats?: string[]; fit?: boolean; original?: Original } = {},
): MediaLike & { previews: Preview[] } {
  const previews: Preview[] = (opts.formats ?? ['jpeg', 'webp']).map(
    (format) => ({
      storageRef: { key: `10x10.${format}` },
      identity: `default:default:10x10:${format}:none`,
      resizer: 'default',
      pipeline: 'default',
      sizeKey: '10x10',
      format,
      contentType: `image/${format}`,
    }),
  );
  if (opts.fit) {
    previews.push({
      storageRef: { key: 'fit.jpeg' },
      identity: 'default:default:fit:jpeg:none',
      resizer: 'default',
      pipeline: 'default',
      sizeKey: 'fit',
      format: 'jpeg',
      contentType: 'image/jpeg',
      fit: true,
    });
  }
  return {
    id: 'm1',
    original: opts.original ?? {
      storageRef: { key: 'o' },
      width: 64,
      height: 48,
    },
    previews,
  };
}

const JPEG_ID = 'default:default:10x10:jpeg:none';
const WEBP_ID = 'default:default:10x10:webp:none';

test('splitStored: rows made with the current settings are fresh; another quality, a missing signature or another original is stale', () => {
  const configA = makeImageConfig();
  const configB = makeImageConfig({
    encode: { formats: { webp: { quality: 42 } } },
  });
  const media = stampFresh(freshMedia(), { config: configA });
  const onB = new Catalog({ config: configB });

  const split = onB.splitStored(media, scope);
  assert.deepEqual([...split.fresh.keys()], [JPEG_ID]);
  assert.deepEqual([...split.stale.keys()], [WEBP_ID]);
  assert.equal(split.fresh.get(JPEG_ID), media.previews[0]);
  assert.equal(split.stale.get(WEBP_ID), media.previews[1]);

  // On A both are fresh; a row whose signatures were removed is stale.
  const onA = new Catalog({ config: configA });
  assert.deepEqual(
    [...onA.splitStored(media, scope).fresh.keys()],
    [JPEG_ID, WEBP_ID],
  );
  const unsigned = stampFresh(freshMedia(), { config: configA });
  delete unsigned.previews[0].origin;
  delete unsigned.previews[0].encodeSig;
  assert.deepEqual(
    [...onA.splitStored(unsigned, scope).stale.keys()],
    [JPEG_ID],
  );

  // Another original: every row is stale.
  const replaced = stampFresh(freshMedia(), { config: configA });
  replaced.original = { storageRef: { key: 'o-new' }, width: 64, height: 48 };
  const all = onA.splitStored(replaced, scope);
  assert.equal(all.fresh.size, 0);
  assert.deepEqual([...all.stale.keys()], [JPEG_ID, WEBP_ID]);
});

test('a fit row is judged with the fit settings', () => {
  const fitConfig = makeImageConfig({
    encode: { sharpen: { cover: true, fit: false } },
  });
  const fitCatalog = new Catalog({ config: fitConfig });
  const media = stampFresh(freshMedia({ formats: [], fit: true }), {
    config: fitConfig,
  });
  const fitId = 'default:default:fit:jpeg:none';
  assert.deepEqual([...fitCatalog.freshIdentities(media, scope)], [fitId]);
  assert.equal(
    fitCatalog.encodeSig('default', 'jpeg', true),
    media.previews[0].encodeSig,
  );
  // Signed as a fit row, read as a cover row: stale.
  delete media.previews[0].fit;
  assert.deepEqual(
    [...fitCatalog.splitStored(media, scope).stale.keys()],
    [fitId],
  );
});

test('the live pipeline version and config are read on every call', () => {
  const liveConfig = makeImageConfig();
  const pipeline: { version?: string } = { version: 'v1' };
  const live = new Catalog({
    config: liveConfig,
    versionOf: (name) => (name === 'default' ? pipeline.version : undefined),
  });
  const media = stampFresh(freshMedia(), {
    config: liveConfig,
    version: 'v1',
  });
  assert.deepEqual([...live.freshIdentities(media, scope)], [JPEG_ID, WEBP_ID]);

  pipeline.version = 'v2';
  assert.equal(live.freshIdentities(media, scope).size, 0);
  assert.deepEqual(
    [...live.splitStored(media, scope).stale.keys()],
    [JPEG_ID, WEBP_ID],
  );

  stampFresh(media, { config: liveConfig, version: 'v2' });
  assert.deepEqual([...live.freshIdentities(media, scope)], [JPEG_ID, WEBP_ID]);

  liveConfig.encode.formats.webp = {
    ...liveConfig.encode.formats.webp,
    quality: 50,
  };
  const split = live.splitStored(media, scope);
  assert.deepEqual([...split.fresh.keys()], [JPEG_ID]);
  assert.deepEqual([...split.stale.keys()], [WEBP_ID]);
});

test('a media without stored dimensions has no fresh row, unless the decoded size is passed', () => {
  const plain = new Catalog({ config: makeImageConfig() });
  const decoded = { width: 64, height: 48 };
  // Rows signed as the worker signs them for such a media: with the decoded size.
  const signed = (key: string): MediaLike & { previews: Preview[] } => {
    const media = freshMedia({ original: { storageRef: { key } } });
    for (const row of media.previews) {
      row.origin = previewOrigin({ key: 'o' }, decoded);
      row.encodeSig = plain.encodeSig('default', row.format, false);
    }
    return media;
  };

  const media = signed('o');
  const unproven = plain.splitStored(media, scope);
  assert.equal(unproven.fresh.size, 0);
  assert.deepEqual([...unproven.stale.keys()], [JPEG_ID, WEBP_ID]);

  const proven = plain.splitStored(media, scope, decoded);
  assert.deepEqual([...proven.fresh.keys()], [JPEG_ID, WEBP_ID]);
  assert.equal(proven.stale.size, 0);

  // A replaced original makes the rows stale, whatever size is passed.
  const replaced = plain.splitStored(signed('o2'), scope, decoded);
  assert.equal(replaced.fresh.size, 0);
  assert.deepEqual([...replaced.stale.keys()], [JPEG_ID, WEBP_ID]);

  // A stored null counts as missing.
  const nulls = signed('o');
  nulls.original = {
    storageRef: { key: 'o' },
    width: null,
    height: null,
  } as unknown as Original;
  assert.equal(plain.freshIdentities(nulls, scope).size, 0);
});

test('a fresh row of an identity wins over a stale one, whatever their order', () => {
  const freshConfig = makeImageConfig();
  const fresh = new Catalog({ config: freshConfig });
  const media = stampFresh(freshMedia({ formats: ['jpeg'] }), {
    config: freshConfig,
  });
  const newFresh = media.previews[0];
  // A row stored before previews recorded their identity, scope or signatures.
  const oldStale: Preview = {
    storageRef: { key: 'old.jpg' },
    sizeKey: '10x10',
    format: 'jpeg',
    contentType: 'image/jpeg',
  };
  for (const previews of [
    [newFresh, oldStale],
    [oldStale, newFresh],
  ]) {
    const split = fresh.splitStored({ ...media, previews }, scope);
    assert.equal(split.fresh.get(JPEG_ID), newFresh);
    assert.equal(split.stale.size, 0);
    // storedPreviews keeps its rule: the later row wins.
    assert.equal(
      fresh.storedPreviews({ ...media, previews }, scope).get(JPEG_ID),
      previews[1],
    );
  }

  // Of two stale rows the later is kept.
  const older: Preview = { ...oldStale, storageRef: { key: 'older.jpg' } };
  const stale = fresh.splitStored({ previews: [older, oldStale] }, scope);
  assert.equal(stale.stale.get(JPEG_ID), oldStale);
});

test('freshIdentities holds the fresh identities only; storedIdentities keeps every usable row', () => {
  const freshConfig = makeImageConfig();
  const fresh = new Catalog({ config: freshConfig });
  const media = stampFresh(freshMedia(), { config: freshConfig });
  media.previews[1].encodeSig = 'outdated';
  assert.deepEqual(fresh.freshIdentities(media, scope), new Set([JPEG_ID]));
  assert.deepEqual(
    fresh.storedIdentities(media, scope),
    new Set([JPEG_ID, WEBP_ID]),
  );
  // Another scope's rows are neither fresh nor stale here.
  const other = fresh.splitStored(media, {
    resizer: 'default',
    pipeline: 'wm',
  });
  assert.equal(other.fresh.size + other.stale.size, 0);
});
