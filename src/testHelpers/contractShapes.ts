// Compiled by `npm run types:check` (tsconfig.test-helpers.json), never run. It pins the D1
// promise: each driver contract is an abstract class, yet a plain object of the same shape still
// type-checks as that contract. A contract change that breaks plain objects fails CI here.
import type { LockStore } from '../contracts/lockStore.ts';
import type { MediaStore } from '../contracts/mediaStore.ts';
import type { ResizeStorage } from '../contracts/storage.ts';
import type { QueueTransport } from '../contracts/transport.ts';

const locks: LockStore = {
  acquire: async () => true,
  release: async () => {},
};

export const storage: ResizeStorage = {
  download: async () => Buffer.alloc(0),
  upload: async () => ({ key: 'k' }),
  publicUrl: () => '',
};

export const mediaStore: MediaStore = {
  load: async () => null,
  appendPreviews: async () => {},
};

export const transport: QueueTransport = {
  locks,
  enqueue: async () => ({ taskId: null }),
  startWorker: async () => {},
};

// The optional members stay optional on plain objects too.
export const fullTransport: QueueTransport = {
  locks,
  enqueue: async () => ({ taskId: null }),
  startWorker: async () => {},
  verify: () => {},
  servesQueue: () => true,
  getLockTtlMs: () => ({ dispatch: 1000, worker: 1000 }),
  findActive: async () => [],
};

// @ts-expect-error — a transport must carry its locks.
export const locklessTransport: QueueTransport = {
  enqueue: async () => ({ taskId: null }),
  startWorker: async () => {},
};
