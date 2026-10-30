// Compiled by `npm run types:check` (tsconfig.test-helpers.json), never run. It pins the promise
// that each contract is an abstract class, yet a plain object of the same shape still
// type-checks as that contract. A contract change that breaks plain objects fails CI here.
import type { SourceDecoder } from '../contracts/decoder.ts';
import type { LockStore } from '../contracts/locks.ts';
import type { MediaStore } from '../contracts/media.ts';
import type { ResizeStorage } from '../contracts/storage.ts';
import type { TaskQueue } from '../contracts/taskQueue.ts';
import { NoopMetrics } from '../metrics.ts';

export const storage: ResizeStorage = {
  download: async () => Buffer.alloc(0),
  upload: async () => ({ key: 'k' }),
  publicUrl: () => '',
};

export const tasks: TaskQueue = {
  add: async () => ({ status: 'unconfirmed' }),
  claim: async () => null,
  renew: async () => true,
  complete: async () => true,
  fail: async () => true,
};

// The optional members stay optional on plain objects too.
export const fullTasks: TaskQueue = {
  add: async () => ({ status: 'added', taskId: 't' }),
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
  replacePreviews: async () => ({ stored: [], removed: [] }),
};
// Spelled out: a spread of a class-typed value drops its methods from the type.
export const verifiedMedia: MediaStore = {
  loadMedia: async () => null,
  appendPreviews: async (_id, previews) => previews,
  replacePreviews: async () => ({ stored: [], removed: [] }),
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
  replacePreviews: async () => ({ stored: [], removed: [] }),
};
export const oldMedia: MediaStore = {
  loadMedia: async () => null,
  appendPreviews: async (_id, previews) => previews,
  // @ts-expect-error — replacePreviews resolves with { stored, removed }, never with the stored rows alone.
  replacePreviews: async (_id, _identities, rows) => rows,
};
// @ts-expect-error — a media store is not a lock store.
export const locklessMedia: LockStore = media;

// The gate flags and the fourth parameters of claim and fail. The four-parameter forms do not
// type-check against three-parameter signatures, so they pin the new parameters.
export const gatingTasks: TaskQueue = {
  gatesByTask: true,
  claimFilters: true,
  add: async () => ({ status: 'in-flight' }),
  claim: async (_queue, _leaseMs, _signal, opts) =>
    opts?.resizers?.length === 0 ? null : null,
  renew: async () => true,
  complete: async () => true,
  fail: async (_task, _next, _error, opts) => opts?.cooldownMs !== undefined,
};
export const oldAddTasks: TaskQueue = {
  // @ts-expect-error — add resolves with a status; a bare taskId is the older contract.
  add: async () => ({ taskId: 'x' }),
  claim: async () => null,
  renew: async () => true,
  complete: async () => true,
  fail: async () => true,
};
export const falseGate: TaskQueue = {
  // @ts-expect-error — gatesByTask is `true` or absent.
  gatesByTask: false,
  add: async () => ({ status: 'unconfirmed' }),
  claim: async () => null,
  renew: async () => true,
  complete: async () => true,
  fail: async () => true,
};

export const decoder: SourceDecoder = {
  formats: ['pdf'],
  inspect: async () => ({
    format: 'pdf',
    contentType: 'application/pdf',
    width: 1,
    height: 1,
  }),
  render: async () => ({
    data: Buffer.alloc(3),
    info: { width: 1, height: 1, channels: 3 },
  }),
};

// The sink that records nothing declares its parameters optional, so the zero-argument calls
// written before it declared them still type-check.
export const noopMetrics = new NoopMetrics();
noopMetrics.count();
noopMetrics.timing();
