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

// At most this many header reads per density choice. Each step lowers the density in proportion
// to how far the probed raster is over the budget, so a few reads are enough.
const MAX_DENSITY_PROBES = 8;

/**
 * Density for the shared SVG raster, or undefined when the capped raster has a zero-sized
 * side. The raster at that density, as the header reports it, fits `pixelBudget`. Uploads check
 * the same baseline as the worker; a larger requested scale only increases the density. Do not
 * raise the density to save a thin side: that can exceed librsvg's side cap.
 */
export async function svgRasterDensity(
  svg: Buffer,
  width: number,
  height: number,
  {
    pixelBudget,
    timeoutSeconds,
    largestScale = 1,
  }: {
    pixelBudget: number;
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
  let density = Math.max(1, Math.min(100_000, Math.floor(72 * scale)));
  // The renderer rounds each side to whole pixels. Counting the sides up gives a first density
  // that fits when the natural size is right.
  const pixelsAt = (d: number) =>
    Math.max(1, Math.ceil((width * d) / 72)) *
    Math.max(1, Math.ceil((height * d) / 72));
  while (density > 1 && pixelsAt(density) > pixelBudget) {
    density = stepDown(density, pixelsAt(density), pixelBudget);
  }
  // A fractional natural size is only an estimate, so the arithmetic can be off by a pixel on a
  // side. The header read at the chosen density gives the size the renderer will make (it reads
  // the markup, it does not render): lower the density until that size fits.
  for (let probes = 1; ; probes++) {
    const size = await headerSize(svg, density, timeoutSeconds);
    if (size === undefined) {
      return undefined;
    }
    const pixels = size.width * size.height;
    if (
      pixels <= pixelBudget ||
      density === 1 ||
      probes >= MAX_DENSITY_PROBES
    ) {
      // Past the probe bound the raster can still be over the budget: the core refuses a raster
      // over it with RESIZE_SOURCE_TOO_LARGE.
      return density;
    }
    density = stepDown(density, pixels, pixelBudget);
  }
}

/** A lower density for a raster of `pixels` over `pixelBudget`: in proportion, and at least 1 less. */
function stepDown(
  density: number,
  pixels: number,
  pixelBudget: number,
): number {
  if (pixels <= pixelBudget) {
    return density;
  }
  return Math.max(
    1,
    Math.min(
      density - 1,
      Math.floor(density * Math.sqrt(pixelBudget / pixels)),
    ),
  );
}

/**
 * The raster size the header reports at `density`, or undefined when a side has no pixel or is
 * over librsvg's side cap. No pixel limit here: the header read decodes no pixels, and the caller
 * compares the size with its own budget.
 */
async function headerSize(
  svg: Buffer,
  density: number,
  timeoutSeconds: number,
): Promise<{ width: number; height: number } | undefined> {
  try {
    const meta = await sharp(svg, { density, limitInputPixels: false })
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
    return { width: meta.width, height: meta.height };
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
