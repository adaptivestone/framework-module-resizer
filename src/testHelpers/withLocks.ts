// Test-only. Locks belong to the queue transport, so a test's fake locks ride on its fake
// transport (the same object, so identity assertions still hold). Without a transport, a no-op
// one carries them — e.g. for processTask(), which coordinates through the transport's locks.
import type { LockStore } from '../contracts/lockStore.ts';
import type { QueueTransport } from '../contracts/transport.ts';

export function withLocks(
  transport: object | undefined,
  locks: LockStore,
): QueueTransport {
  const base = transport ?? {
    enqueue: async () => ({ taskId: null }),
    startWorker: async () => {},
  };
  return Object.assign(base, { locks }) as unknown as QueueTransport;
}

/** Test-only: an in-memory LockStore (no expiry). */
export function memoryLocks(): LockStore {
  const held = new Set<string>();
  return {
    acquire: async (key) => {
      if (held.has(key)) {
        return false;
      }
      held.add(key);
      return true;
    },
    release: async (key) => {
      held.delete(key);
    },
  };
}
