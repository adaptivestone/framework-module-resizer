// Compiled by `npm run types:check` (tsconfig.test-helpers.json), never run. It pins the promise
// that each driver contract is an abstract class, yet a plain object of the same shape still
// type-checks as that contract. A contract change that breaks plain objects fails CI here.
import type { LockStore } from '../contracts/locks.ts';
import type { MediaStore } from '../contracts/media.ts';
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

export const media: MediaStore = {
  loadMedia: async () => null,
  appendPreviews: async (_id, previews) => previews,
};
// Spelled out: a spread of a class-typed value drops its methods from the type.
export const verifiedMedia: MediaStore = {
  loadMedia: async () => null,
  appendPreviews: async (_id, previews) => previews,
  verify: () => {},
};
export const locks: LockStore = {
  acquire: async () => true,
  extend: async () => true,
  release: async () => true,
};
// The directive sits on the property: TypeScript reports a wrong member type there.
export const voidAppendMedia: MediaStore = {
  loadMedia: async () => null,
  // @ts-expect-error — appendPreviews resolves with the stored rows, never with nothing.
  appendPreviews: async () => {},
};
// @ts-expect-error — a media store is not a lock store.
export const locklessMedia: LockStore = media;
