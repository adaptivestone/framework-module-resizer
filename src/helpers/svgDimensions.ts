import sharp from 'sharp';

// librsvg refuses a raster whose side is larger than this; Sharp accepts integer DPI only.
const SVG_MAX_SIDE = 32767;

/**
 * Read fractional SVG dimensions without rendering. The 72 dpi header rounds to pixels; a
 * denser header preserves the aspect ratio (1000×0.6 otherwise looks like 1000×1). The margins
 * account for rounding when choosing a density within the input pixel limit.
 */
export async function svgNaturalSize(
  svg: Buffer,
  roundedW: number,
  roundedH: number,
  inputPixels: number,
  timeoutSeconds: number,
): Promise<{ width: number; height: number }> {
  const density = Math.max(
    72,
    Math.min(
      100_000,
      Math.floor(
        72 * Math.sqrt(inputPixels / ((roundedW + 2) * (roundedH + 2))),
      ),
    ),
  );
  const meta = await sharp(svg, { density, limitInputPixels: inputPixels })
    .timeout({ seconds: timeoutSeconds })
    .metadata();
  const scale = density / 72;
  const side = (scaled: number | undefined, rounded: number) => {
    const estimate = scaled === undefined ? rounded : scaled / scale;
    return Math.abs(estimate - rounded) <= 1 / scale ? rounded : estimate;
  };
  return {
    width: side(meta.width, roundedW),
    height: side(meta.height, roundedH),
  };
}

/**
 * Density for the shared SVG raster, or undefined when the capped raster has a zero-sized
 * side. Uploads check the same baseline as the worker; a larger requested scale only increases
 * the density. Do not raise the density to save a thin side: that can exceed librsvg's side cap.
 */
export async function svgRasterDensity(
  svg: Buffer,
  width: number,
  height: number,
  {
    pixelBudget,
    inputPixels,
    timeoutSeconds,
    largestScale = 1,
  }: {
    pixelBudget: number;
    inputPixels: number;
    timeoutSeconds: number;
    largestScale?: number;
  },
): Promise<number | undefined> {
  const scale = Math.min(
    Math.max(
      1,
      Math.min(largestScale, Math.sqrt(pixelBudget / (width * height))),
    ),
    SVG_MAX_SIDE / Math.max(width, height),
  );
  const density = Math.max(1, Math.min(100_000, Math.floor(72 * scale)));
  if (density < 72) {
    // Probe the actual header at the reduced density: fractional natural dimensions are only
    // estimates, so arithmetic alone can misclassify a short side at the rounding boundary.
    try {
      const meta = await sharp(svg, { density, limitInputPixels: inputPixels })
        .timeout({ seconds: timeoutSeconds })
        .metadata();
      if (
        meta.width === undefined ||
        meta.height === undefined ||
        meta.width < 1 ||
        meta.height < 1 ||
        meta.width > SVG_MAX_SIDE ||
        meta.height > SVG_MAX_SIDE
      ) {
        return undefined;
      }
    } catch (err) {
      if (
        err instanceof Error &&
        /svgload_buffer: (zero-sized image|bad dimensions)/.test(err.message)
      ) {
        return undefined;
      }
      throw err;
    }
  }
  return density;
}
