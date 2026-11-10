/** True when an ISO BMFF image declares an AVIF/AVIS compatible brand. */
export function isAvifBuffer(body: Buffer): boolean {
  if (body.length < 16 || body.toString('ascii', 4, 8) !== 'ftyp') {
    return false;
  }
  const brands = body.toString('ascii', 8, Math.min(body.length, 64));
  return brands.includes('avif') || brands.includes('avis');
}
