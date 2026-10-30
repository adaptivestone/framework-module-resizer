// The pure plan: which exact size each missing preview gets, which variants share one render, the
// box a decoder renders and how many frames it decodes. Today's size rules made explicit, as plain
// values: no Sharp, no port, no I/O. The Processor turns the plan into pixels.
import type { DecodeBox, SourceInfo } from './contracts/decoder.ts';
import type { Pipeline } from './contracts/pipeline.ts';
import { isAnimatedFormat } from './helpers/imageFormat.ts';
import {
  calculateResizedDimensions,
  coverDimensions,
  getPreviewIdentity,
} from './images.ts';
import type {
  MissingPreview,
  PreviewScope,
  ResizeConfig,
  ResizeLimits,
} from './types.d.ts';

/** The settings the plan reads, taken once from the config and the pipeline. */
export interface PlanRules {
  scope: PreviewScope;
  maxSize: { width: number; height: number };
  resultDimension: number;
  sharpen: { cover: boolean; fit: boolean } | false;
  /** False when the pipeline has variantSteps: its steps keep the full box they were written for. */
  ownSize: boolean;
  /** config.animated, and the pipeline has neither beforeSteps nor variantSteps. */
  animate: boolean;
}

/** One exact output geometry; variants with one key share one render. */
export interface SizePlan {
  /** The geometry, e.g. '620x413:fill:s:'. */
  key: string;
  /** Exact output size of one frame, integers ≥ 1. */
  width: number;
  height: number;
  /** fill: the aspect ratio is kept (or the size is exact); cover: centre crop. */
  mode: 'fill' | 'cover';
  sharpen: boolean;
  animated: boolean;
}

export interface VariantPlan {
  variant: MissingPreview;
  identity: string;
  size: SizePlan;
}

type Geometry = Omit<SizePlan, 'key' | 'animated'>;

export function planRules(
  config: ResizeConfig,
  scope: PreviewScope,
  pipeline: Pipeline,
): PlanRules {
  const hasVariantSteps = (pipeline.variantSteps ?? []).length > 0;
  const hasBeforeSteps = (pipeline.beforeSteps ?? []).length > 0;
  const { sharpen } = config.encode;
  return {
    scope: { resizer: scope.resizer, pipeline: scope.pipeline },
    maxSize: { width: config.maxSize.width, height: config.maxSize.height },
    resultDimension: config.limits.resultDimension,
    sharpen: sharpen ? { cover: sharpen.cover, fit: sharpen.fit } : false,
    ownSize: !hasVariantSteps,
    animate: config.animated && !hasBeforeSteps && !hasVariantSteps,
  };
}

const side = (n: number): number => Math.max(1, Math.round(n));

/** The exact output geometry of one variant on a `w × h` source (display size of one frame). */
function geometry(
  info: SourceInfo,
  v: MissingPreview,
  rules: PlanRules,
): Geometry {
  const { width: w, height: h } = info;
  const s = rules.sharpen;
  const fitSharpen = s !== false && s.fit;
  const coverSharpen = s !== false && s.cover;
  const rw = v.requestedWidth;
  const rh = v.requestedHeight;

  // Fit: inside maxSize, never enlarged. Only `true` is a fit variant, as the row is signed.
  if (v.fit === true) {
    const d = calculateResizedDimensions(
      w,
      h,
      undefined,
      undefined,
      true,
      rules.maxSize,
    );
    return {
      width: d.width as number,
      height: d.height as number,
      mode: 'fill',
      sharpen: fitSharpen,
    };
  }

  const d = coverDimensions(w, h, rw, rh, rules.resultDimension);

  // Own size: a raster no larger than the requested box is the whole image at its own size, only
  // scaled down to fit the capped box; not sharpened when nothing was scaled.
  if (
    rules.ownSize &&
    !info.vector &&
    rw !== undefined &&
    rh !== undefined &&
    w <= Math.round(rw) &&
    h <= Math.round(rh)
  ) {
    const scale = Math.min(
      (d.width as number) / w,
      (d.height as number) / h,
      1,
    );
    return {
      width: side(w * scale),
      height: side(h * scale),
      mode: 'fill',
      sharpen: scale < 1 && coverSharpen,
    };
  }

  if (d.width !== undefined && d.height !== undefined) {
    return {
      width: d.width,
      height: d.height,
      mode: 'cover',
      sharpen: coverSharpen,
    };
  }
  // One side requested and the derived side under the cap: the source aspect ratio, exactly.
  if (d.width !== undefined) {
    return {
      width: d.width,
      height: side((d.width * h) / w),
      mode: 'fill',
      sharpen: coverSharpen,
    };
  }
  if (d.height !== undefined) {
    return {
      width: side((d.height * w) / h),
      height: d.height,
      mode: 'fill',
      sharpen: coverSharpen,
    };
  }
  // No side at all (a size key that names none): the source at its own size, as today.
  return {
    width: side(w),
    height: side(h),
    mode: 'fill',
    sharpen: coverSharpen,
  };
}

const geometryKey = (g: Geometry): string =>
  `${g.width}x${g.height}:${g.mode}:${g.sharpen ? 's' : ''}`;

/**
 * The size plan of every request, in request order. Requests with one geometry share one
 * SizePlan; it is animated when animation is on, the source is animated and one of its variants
 * has an animated format.
 */
export function planVariants(
  info: SourceInfo,
  requests: readonly MissingPreview[],
  rules: PlanRules,
): VariantPlan[] {
  const geometries = requests.map((v) => geometry(info, v, rules));
  const animatedKeys = new Set<string>();
  if (rules.animate && info.animated) {
    requests.forEach((v, i) => {
      if (isAnimatedFormat(v.format)) {
        animatedKeys.add(geometryKey(geometries[i]));
      }
    });
  }
  const sizes = new Map<string, SizePlan>();
  return requests.map((variant, i) => {
    const g = geometries[i];
    const gKey = geometryKey(g);
    let size = sizes.get(gKey);
    if (size === undefined) {
      const animated = animatedKeys.has(gKey);
      size = { ...g, key: `${gKey}:${animated ? 'a' : ''}`, animated };
      sizes.set(gKey, size);
    }
    return {
      variant,
      identity: getPreviewIdentity(
        rules.scope,
        variant.sizeKey,
        variant.format,
        variant.filters,
      ),
      size,
    };
  });
}

/**
 * The plans with every size's variants next to each other, sizes in the order they first appear
 * and variants in request order within a size. Rendered in this order, a size's pixels are
 * released before a pool of `concurrency` variants starts a size beyond it, so at most
 * `concurrency` sizes are held at once.
 */
export function groupBySize(plans: readonly VariantPlan[]): VariantPlan[] {
  const bySize = new Map<string, VariantPlan[]>();
  for (const plan of plans) {
    const group = bySize.get(plan.size.key);
    if (group === undefined) {
      bySize.set(plan.size.key, [plan]);
    } else {
      group.push(plan);
    }
  }
  return [...bySize.values()].flat();
}

/**
 * The box a decoder renders: the source scaled by the largest factor any plan needs. With
 * `atLeastOwnSize` (beforeSteps see the whole source) it is at least the source's own size; a
 * raster box never exceeds the source, a vector box may.
 */
export function decodeBox(
  info: SourceInfo,
  plans: readonly VariantPlan[],
  opts: { atLeastOwnSize: boolean },
): DecodeBox {
  const { width: w, height: h } = info;
  // With no plan (the Processor never asks) the scale stays 0 and the box is the smallest, 1×1.
  let scale = 0;
  for (const { size } of plans) {
    scale = Math.max(scale, size.width / w, size.height / h);
  }
  if (opts.atLeastOwnSize) {
    scale = Math.max(scale, 1);
  }
  if (!info.vector) {
    scale = Math.min(scale, 1);
  }
  // The epsilon keeps a float product such as 6000 × 0.3 at 1800, not 1801.
  const boxSide = (n: number) => Math.max(1, Math.ceil(n * scale - 1e-6));
  return { width: boxSide(w), height: boxSide(h) };
}

/**
 * Frames to decode: 1 unless a plan is animated; then the source's own count, up to
 * limits.animationFrames and to what fits the pixel budget. Every frame is held at the larger of
 * the source's size and the largest animated size (an animation is stacked at its preview size,
 * which a width-only size can enlarge), so no stack the render holds exceeds the budget.
 */
export function framesToDecode(
  info: SourceInfo,
  plans: readonly VariantPlan[],
  limits: ResizeLimits,
): number {
  let framePixels = 0;
  for (const { size } of plans) {
    if (size.animated) {
      framePixels = Math.max(framePixels, size.width * size.height);
    }
  }
  if (framePixels === 0) {
    return 1;
  }
  framePixels = Math.max(framePixels, info.width * info.height);
  const budget = Math.min(limits.sourcePixels, limits.inputPixels);
  return Math.max(
    1,
    Math.min(
      info.pages ?? 1,
      limits.animationFrames,
      Math.floor(budget / framePixels),
    ),
  );
}
