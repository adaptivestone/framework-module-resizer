// Whether a stored preview row still matches its original and the current settings. A row is fresh
// only when both signatures it recorded equal what the writer would record now; a row missing
// either one is stale. The expected values follow the writer's recipe exactly, so the read path,
// eager generate and the worker agree on every row. Pure: no I/O, no Sharp.
import { previewOrigin } from './signatures.ts';
import type { Original, Preview } from './types.d.ts';

/**
 * The original's stored dimensions, only when both are numbers. A missing or `null` side means
 * none are stored: the worker then signs with the decoded size and backfills it.
 */
export function storedDims(
  original: Original | undefined,
): { width: number; height: number } | undefined {
  return typeof original?.width === 'number' &&
    typeof original.height === 'number'
    ? { width: original.width, height: original.height }
    : undefined;
}

/**
 * The `origin` a fresh row of this original carries: its storage ref signed with `dims`, else with
 * the stored dimensions. Undefined when there is no storage ref or no dimensions: the read path
 * cannot decode, so on such a media no row can be proven fresh.
 */
export function expectedOrigin(
  original: Original | undefined,
  dims?: { width: number; height: number },
): string | undefined {
  if (original?.storageRef == null) {
    return undefined;
  }
  const d = dims ?? storedDims(original);
  return d === undefined ? undefined : previewOrigin(original.storageRef, d);
}

/** True when `row` recorded exactly the expected signatures; never without an expected origin. */
export function isFreshRow(
  row: Preview,
  expect: { encodeSig: string; origin: string | undefined },
): boolean {
  return (
    expect.origin !== undefined &&
    row.origin === expect.origin &&
    typeof row.encodeSig === 'string' &&
    row.encodeSig === expect.encodeSig
  );
}
