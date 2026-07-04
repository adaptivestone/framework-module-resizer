// INTERNAL utility — the single definition of the positive-finite dimension guard shared by
// images/engine/resizeTask. NOT exported from the main entry.

export const isPositiveFinite = (n: number | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;
