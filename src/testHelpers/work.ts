// Test-only: run the framework-free worker until a condition holds, then stop it and wait for it
// to return. A worker that fails before then (refused at start, say) fails the wait with its error.
import assert from 'node:assert/strict';
import { type RunWorkerOptions, runWorker } from '../worker.ts';

/** Run the worker until `done()` (or 5 s), then stop it and wait for it to return. */
export async function workUntil(
  opts: Omit<RunWorkerOptions, 'signal'>,
  done: () => boolean,
): Promise<void> {
  const stop = new AbortController();
  const working = runWorker({ ...opts, signal: stop.signal });
  let failed: { error: unknown } | undefined;
  working.catch((error: unknown) => {
    failed = { error };
  });
  const until = Date.now() + 5000;
  try {
    while (!done()) {
      if (failed) {
        throw failed.error;
      }
      assert.ok(
        Date.now() < until,
        'the worker never reached the expected state',
      );
      await new Promise((r) => setTimeout(r, 5));
    }
  } catch (err) {
    // A failed wait still stops the worker, so the test file can exit; the assertion is the error.
    stop.abort();
    await working.catch(() => {});
    throw err;
  }
  stop.abort();
  await working;
}
