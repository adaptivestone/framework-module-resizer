// The pure plan: today's size rules (fit, own size, cover, a derived side, the caps, sharpening,
// animation), the decode box and the frame count, as plain values with no Sharp and no port.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SourceInfo } from './contracts/decoder.ts';
import type { VariantStep } from './contracts/pipeline.ts';
import { getPreviewIdentity } from './images.ts';
import {
  decodeBox,
  framesToDecode,
  groupBySize,
  type PlanRules,
  planRules,
  planVariants,
} from './plan.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import type {
  DeepPartial,
  Filters,
  MissingPreview,
  ResizeConfig,
} from './types.d.ts';

const scope = { resizer: 'default', pipeline: 'default' };

function rules(
  override: DeepPartial<ResizeConfig> = {},
  pipeline: Parameters<typeof planRules>[2] = {},
): PlanRules {
  return planRules(makeImageConfig(override), scope, pipeline);
}

function info(
  width: number,
  height: number,
  extra: Partial<SourceInfo> = {},
): SourceInfo {
  return { format: 'png', contentType: 'image/png', width, height, ...extra };
}

/** A requested cover size: both sides, or one of them. */
function size(
  width: number | undefined,
  height: number | undefined,
  format = 'jpeg',
  filters?: Filters,
): MissingPreview {
  const sizeKey =
    width !== undefined && height !== undefined
      ? `${Math.round(width)}x${Math.round(height)}`
      : width !== undefined
        ? `${width}w`
        : `${height}h`;
  return {
    sizeKey,
    format,
    ...(width !== undefined ? { requestedWidth: width } : {}),
    ...(height !== undefined ? { requestedHeight: height } : {}),
    ...(filters ? { filters } : {}),
  };
}

const fit = (format = 'jpeg'): MissingPreview => ({
  sizeKey: 'fit',
  format,
  fit: true,
});

/** The one size plan of a single request. */
function one(src: SourceInfo, request: MissingPreview, r = rules()) {
  const [plan] = planVariants(src, [request], r);
  const { width, height, mode, sharpen } = plan.size;
  return { width, height, mode, sharpen };
}

const step: VariantStep = (img) => img;

test('fit is bounded by maxSize and never enlarges', () => {
  assert.deepEqual(one(info(6000, 4000), fit()), {
    width: 1800,
    height: 1200,
    mode: 'fill',
    sharpen: false,
  });
  assert.deepEqual(one(info(200, 300), fit()), {
    width: 200,
    height: 300,
    mode: 'fill',
    sharpen: false,
  });
});

test('cover sizes are capped at limits.resultDimension', () => {
  assert.deepEqual(one(info(10000, 10000), size(9000, 9000)), {
    width: 5000,
    height: 5000,
    mode: 'cover',
    sharpen: true,
  });
});

test('a width-only size takes its height from the source aspect ratio', () => {
  assert.deepEqual(one(info(6000, 4000), size(620, undefined)), {
    width: 620,
    height: 413,
    mode: 'fill',
    sharpen: true,
  });
});

test('a derived side over the cap is cropped to the cap', () => {
  const r = rules({ limits: { resultDimension: 200 } });
  assert.deepEqual(one(info(1, 100), size(100, undefined), r), {
    width: 100,
    height: 200,
    mode: 'cover',
    sharpen: true,
  });
  assert.deepEqual(one(info(100, 1), size(undefined, 100), r), {
    width: 200,
    height: 100,
    mode: 'cover',
    sharpen: true,
  });
});

test('a vector source derives sides from its exact aspect ratio', () => {
  assert.deepEqual(one(info(1000, 0.6, { vector: true }), size(undefined, 5)), {
    width: 5000,
    height: 5,
    mode: 'cover',
    sharpen: true,
  });
  assert.deepEqual(
    one(info(40000, 300, { vector: true }), size(undefined, 25)),
    { width: 3333, height: 25, mode: 'fill', sharpen: true },
  );
});

test('own size: a raster no larger than the box keeps its size, unscaled and unsharpened', () => {
  assert.deepEqual(one(info(100, 80), size(300, 300)), {
    width: 100,
    height: 80,
    mode: 'fill',
    sharpen: false,
  });
});

test('own size is decided against the requested box, then fitted inside the cap', () => {
  const r = rules({ limits: { resultDimension: 100 } });
  assert.deepEqual(one(info(120, 60), size(200, 200), r), {
    width: 100,
    height: 50,
    mode: 'fill',
    sharpen: true,
  });
});

test('own size is off with variantSteps and for vector sources', () => {
  const withSteps = rules({}, { variantSteps: [step] });
  assert.equal(withSteps.ownSize, false);
  assert.deepEqual(one(info(100, 80), size(300, 300), withSteps), {
    width: 300,
    height: 300,
    mode: 'cover',
    sharpen: true,
  });
  assert.deepEqual(one(info(100, 80, { vector: true }), size(300, 300)), {
    width: 300,
    height: 300,
    mode: 'cover',
    sharpen: true,
  });
});

test('own size and fit share one size plan when they have the same geometry', () => {
  const plans = planVariants(
    info(100, 80),
    [size(300, 300), size(200, 200), fit()],
    rules(),
  );
  assert.equal(plans.length, 3);
  assert.equal(new Set(plans.map((p) => p.size.key)).size, 1);
});

test('a source larger than the box in one direction is cover-cropped', () => {
  assert.deepEqual(one(info(1000, 200), size(300, 300)), {
    width: 300,
    height: 300,
    mode: 'cover',
    sharpen: true,
  });
});

test('fractional requested sides are rounded', () => {
  assert.deepEqual(one(info(6000, 4000), size(300.5, 200)), {
    width: 301,
    height: 200,
    mode: 'cover',
    sharpen: true,
  });
});

test('each plan carries the preview identity of its scope', () => {
  const listings = { resizer: 'listings', pipeline: 'wm' };
  const request = size(20, 20, 'webp', { blur: 4 });
  const [plan] = planVariants(
    info(100, 100),
    [request],
    planRules(makeImageConfig(), listings, {}),
  );
  assert.equal(plan.variant, request);
  assert.equal(
    plan.identity,
    getPreviewIdentity(listings, '20x20', 'webp', { blur: 4 }),
  );
});

test('a size animates only for an animated source, with animate on, and only for animated formats', () => {
  const animatedSource = info(100, 100, { pages: 3, animated: true });
  const on = rules({ animated: true });
  assert.equal(on.animate, true);
  const [webp, jpeg] = planVariants(
    animatedSource,
    [size(10, undefined, 'webp'), size(10, undefined, 'jpeg')],
    on,
  );
  assert.equal(webp.size.key, jpeg.size.key);
  assert.equal(webp.size.animated, true);
  assert.equal(jpeg.size.animated, true);

  const [alone] = planVariants(
    animatedSource,
    [size(20, undefined, 'jpeg')],
    on,
  );
  assert.equal(alone.size.animated, false);

  const [still] = planVariants(
    info(100, 100, { pages: 3, animated: false }),
    [size(10, undefined, 'webp')],
    on,
  );
  assert.equal(still.size.animated, false);

  const withBefore = rules({ animated: true }, { beforeSteps: [(b) => b] });
  assert.equal(withBefore.animate, false);
  const [stepped] = planVariants(
    animatedSource,
    [size(10, undefined, 'webp')],
    withBefore,
  );
  assert.equal(stepped.size.animated, false);
});

test('the decode box is the largest scale any plan needs', () => {
  const src = info(6000, 4000);
  const plans = planVariants(
    src,
    [fit(), size(620, undefined), size(300, 300)],
    rules(),
  );
  assert.deepEqual(decodeBox(src, plans, { atLeastOwnSize: false }), {
    width: 1800,
    height: 1200,
  });
});

test('a raster box never exceeds the source; a vector box may', () => {
  const raster = info(100, 80);
  const covers = planVariants(
    raster,
    [size(300, 300)],
    rules({}, { variantSteps: [step] }),
  );
  assert.equal(covers[0].size.mode, 'cover');
  assert.deepEqual(decodeBox(raster, covers, { atLeastOwnSize: false }), {
    width: 100,
    height: 80,
  });

  const vector = info(20, 10, { vector: true });
  const wide = planVariants(vector, [size(2000, undefined)], rules());
  assert.deepEqual(decodeBox(vector, wide, { atLeastOwnSize: false }), {
    width: 2000,
    height: 1000,
  });
});

test("with beforeSteps the box is at least the source's own size", () => {
  const src = info(6000, 4000);
  const plans = planVariants(src, [size(300, 300)], rules());
  assert.deepEqual(decodeBox(src, plans, { atLeastOwnSize: true }), {
    width: 6000,
    height: 4000,
  });
});

test('the box follows the capped sizes, not the requested ones', () => {
  const vector = info(100, 100, { vector: true });
  const plans = planVariants(vector, [size(9000, 9000)], rules());
  assert.deepEqual(decodeBox(vector, plans, { atLeastOwnSize: false }), {
    width: 5000,
    height: 5000,
  });
});

test('frames are 1 unless a plan animates, then bounded by pages, animationFrames and the pixel budget', () => {
  const on = rules({ animated: true });
  const limits = {
    ...makeImageConfig().limits,
    animationFrames: 64,
    sourcePixels: 10 * 100 * 100,
  };
  const many = info(100, 100, { pages: 100, animated: true });
  const animatedPlans = planVariants(many, [size(10, 10, 'webp')], on);
  assert.equal(animatedPlans[0].size.animated, true);
  assert.equal(framesToDecode(many, animatedPlans, limits), 10);

  const few = info(100, 100, { pages: 3, animated: true });
  assert.equal(
    framesToDecode(few, planVariants(few, [size(10, 10, 'webp')], on), limits),
    3,
  );

  const stillPlans = planVariants(many, [size(10, 10, 'jpeg')], on);
  assert.equal(stillPlans[0].size.animated, false);
  assert.equal(framesToDecode(many, stillPlans, limits), 1);
});

test('the frame budget is divided by the larger of the source and the largest animated size', () => {
  const on = rules({ animated: true });
  const limits = {
    ...makeImageConfig().limits,
    animationFrames: 64,
    sourcePixels: 50_000_000,
    inputPixels: 50_000_000,
  };
  const src = info(100, 100, { pages: 64, animated: true });
  // A width-only size enlarges: 3000×3000 per frame.
  const large = planVariants(src, [size(3000, undefined, 'webp')], on);
  assert.equal(large[0].size.animated, true);
  assert.equal(large[0].size.width, 3000);
  assert.equal(large[0].size.height, 3000);
  assert.equal(framesToDecode(src, large, limits), 5);

  // A size no larger than the source: the source's own pixels count, capped by animationFrames.
  const small = planVariants(src, [size(100, 100, 'webp')], on);
  assert.equal(framesToDecode(src, small, limits), 64);

  // A still size of the same task does not count: only animated sizes hold a stack.
  const mixed = planVariants(
    src,
    [size(100, 100, 'webp'), size(4000, undefined, 'jpeg')],
    on,
  );
  assert.equal(mixed[1].size.animated, false);
  assert.equal(framesToDecode(src, mixed, limits), 64);
});

test('frames are capped by animationFrames and by the inputPixels side of the budget', () => {
  const on = rules({ animated: true });
  const src = info(100, 100, { pages: 100, animated: true });
  const plans = planVariants(src, [size(10, 10, 'webp')], on);
  const base = makeImageConfig().limits;
  assert.equal(framesToDecode(src, plans, { ...base, animationFrames: 7 }), 7);
  assert.equal(
    framesToDecode(src, plans, {
      ...base,
      animationFrames: 64,
      sourcePixels: 50_000_000,
      inputPixels: 4 * 100 * 100,
    }),
    4,
  );
});

test('the decode box rounds a float product down to the exact side', () => {
  const src = info(100, 100);
  const plans = planVariants(
    src,
    [size(7, 7)],
    rules({}, { variantSteps: [step] }),
  );
  assert.deepEqual(decodeBox(src, plans, { atLeastOwnSize: false }), {
    width: 7,
    height: 7,
  });
});

test('a size key that names no side and is not fit is the source at its own size', () => {
  const src = info(640, 480);
  assert.deepEqual(one(src, { sizeKey: 'none', format: 'jpeg' }), {
    width: 640,
    height: 480,
    mode: 'fill',
    sharpen: true,
  });
});

test('equal sides with a different mode are separate size plans', () => {
  const src = info(400, 200);
  // A fit inside maxSize keeps 400×200 (fill); a 400×200 cover box is the same area, cover-cropped.
  const [byFit, byCover] = planVariants(
    src,
    [fit(), size(400, 200)],
    rules({}, { variantSteps: [step] }),
  );
  assert.equal(byFit.size.width, byCover.size.width);
  assert.equal(byFit.size.height, byCover.size.height);
  assert.notEqual(byFit.size.mode, byCover.size.mode);
  assert.notEqual(byFit.size.key, byCover.size.key);
});

test('the decode box of an empty plan list is the smallest box', () => {
  assert.deepEqual(decodeBox(info(100, 80), [], { atLeastOwnSize: false }), {
    width: 1,
    height: 1,
  });
});

test("groupBySize puts each size's variants together, sizes in first-appearance order", () => {
  const src = info(200, 200);
  const r = rules({}, { variantSteps: [step] });
  const plans = planVariants(
    src,
    [
      size(60, undefined),
      size(50, undefined),
      size(undefined, 60),
      size(40, undefined),
      size(undefined, 50),
    ],
    r,
  );
  assert.deepEqual(
    groupBySize(plans).map((p) => p.variant.sizeKey),
    ['60w', '60h', '50w', '50h', '40w'],
  );
  // The input list is left as it is.
  assert.deepEqual(
    plans.map((p) => p.variant.sizeKey),
    ['60w', '50w', '60h', '40w', '50h'],
  );
});
