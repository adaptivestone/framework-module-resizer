// INTERNAL utility — bounded promise pool (the worker's per-variant fan-out). Generic: no
// resize-specific types. NOT exported from the main entry.

/**
 * Run `worker` over `items` with at most `concurrency` in flight (a small promise pool, not
 * unbounded Promise.all). Each runner pulls the next index and, before pulling, checks the
 * abort signal — so a lost lease stops NEW variants without cancelling in-flight ones.
 */
export async function runBounded<T>(
  items: T[],
  concurrency: number,
  signal: AbortSignal | undefined,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const runNext = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) {
        return;
      }
      const i = index;
      index += 1;
      if (i >= items.length) {
        return;
      }
      await worker(items[i]);
    }
  };
  const runners = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: runners }, () => runNext()));
}
