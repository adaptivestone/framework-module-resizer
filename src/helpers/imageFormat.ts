/** True when an ISO BMFF image declares an AVIF/AVIS compatible brand. */
export function isAvifBuffer(body: Buffer): boolean {
  if (body.length < 16 || body.toString('ascii', 4, 8) !== 'ftyp') {
    return false;
  }
  const brands = body.toString('ascii', 8, Math.min(body.length, 64));
  return brands.includes('avif') || brands.includes('avis');
}

// Output formats Sharp writes as an animation. Measured with Sharp 0.35: webp and gif keep every
// frame; avif, jpeg and png stack the frames into one tall image, and tiff writes them as pages,
// which no browser plays. Every other format is rendered from the first frame.
const ANIMATED_OUTPUT_FORMATS: ReadonlySet<string> = new Set(['gif', 'webp']);

/** True when a preview in `format` can keep the frames of an animated source. */
export function isAnimatedFormat(format: string): boolean {
  return ANIMATED_OUTPUT_FORMATS.has(format);
}
