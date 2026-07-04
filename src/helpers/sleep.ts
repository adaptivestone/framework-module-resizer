// INTERNAL utility — abortable sleep so a shutdown during an idle poll returns promptly. NOT
// exported from the main entry.
//
// Contract (UNCHANGED): resolve after `ms` ms, OR resolve EARLY the moment `signal` aborts —
// including a signal that is already aborted on entry. Callers (the mongo idle-poll loop) treat
// abort as "wake early", not an error, so this MUST resolve, never reject, on abort.
//
// That resolve-on-abort semantic is the whole reason this wrapper still exists: node:timers/promises
// REJECTS (with an AbortError) on abort and Node ships no resolve-on-abort variant. So we delegate
// to the platform timer and swallow ONLY the AbortError — any other rejection is re-thrown.
//
// What Node throws on abort (verified on Node 26): an AbortError with `err.name === 'AbortError'`
// and `err.code === 'ABORT_ERR'`; we accept either for robustness.
import { setTimeout as delay } from 'node:timers/promises';

export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === 'AbortError' || ('code' in err && err.code === 'ABORT_ERR'))
    ) {
      return; // abort → "wake early", not a failure
    }
    throw err;
  }
}
