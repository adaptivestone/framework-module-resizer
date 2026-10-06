// Compiled by `npm run types:check` (tsconfig.test-helpers.json), never run. It pins the promise
// that each driver contract is an abstract class, yet a plain object of the same shape still
// type-checks as that contract. A contract change that breaks plain objects fails CI here.
import type { ResizeDatabase } from '../contracts/database.ts';
import type { ResizeStorage } from '../contracts/storage.ts';
import type { TaskQueue } from '../contracts/taskQueue.ts';

export const storage: ResizeStorage = {
  download: async () => Buffer.alloc(0),
  upload: async () => ({ key: 'k' }),
  publicUrl: () => '',
};

export const tasks: TaskQueue = {
  add: async () => ({ taskId: null }),
  claim: async () => null,
  renew: async () => true,
  complete: async () => true,
  fail: async () => true,
};

// The optional members stay optional on plain objects too.
export const fullTasks: TaskQueue = {
  add: async () => ({ taskId: null }),
  claim: async () => null,
  renew: async () => true,
  complete: async () => true,
  fail: async () => true,
  release: async () => true,
  findActive: async () => [],
  servesQueue: () => true,
  getTiming: () => ({ leaseMs: 1000 }),
  verify: () => {},
};

export const db: ResizeDatabase = {
  loadMedia: async () => null,
  appendPreviews: async () => {},
  acquireLock: async () => true,
  releaseLock: async () => {},
};

export const dbWithQueue: ResizeDatabase = {
  loadMedia: async () => null,
  appendPreviews: async () => {},
  acquireLock: async () => true,
  releaseLock: async () => {},
  tasks,
  verify: () => {},
};

// @ts-expect-error — a database must provide locks.
export const locklessDb: ResizeDatabase = {
  loadMedia: async () => null,
  appendPreviews: async () => {},
};
