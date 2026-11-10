// Compiled by `npm run types:check:src` (`tsconfig.type-pins.json`, which the minimum-peers CI
// job runs) and by `npm run types:check` (`tsconfig.tests.json`), never run. It pins the promise
// that each contract is an abstract class, yet a plain object of the same shape still
// type-checks as that contract, that `NoopMetrics` still takes zero-argument calls, and that a
// host logger with any `debug` value is a `ResizeLogger`. A contract change that breaks plain
// objects fails CI here.
import type { SourceDecoder } from '../contracts/decoder.ts';
import type { ImageEngine } from '../contracts/engine.ts';
import type { LockStore } from '../contracts/locks.ts';
import type { MediaStore } from '../contracts/media.ts';
import type { VariantStep } from '../contracts/pipeline.ts';
import type { ResizeStorage } from '../contracts/storage.ts';
import type { TaskQueue } from '../contracts/taskQueue.ts';
import type {
  LambdaContextLike,
  SqsBatchResponse,
  SqsEventLike,
} from '../lambda.ts';
import { NoopMetrics } from '../metrics.ts';
import type { ResizeLogger } from '../types.d.ts';

export const storage: ResizeStorage = {
  download: async () => Buffer.alloc(0),
  upload: async () => ({ key: 'k' }),
  publicUrl: () => '',
};

// A driver may honour maxBytes; one written before the option, with one parameter, still fits.
export const boundedStorage: ResizeStorage = {
  download: async (_ref, opts) =>
    Buffer.alloc(opts?.maxBytes === undefined ? 0 : 1),
  upload: async () => ({ key: 'k' }),
  publicUrl: () => '',
};
export const unboundedStorage: ResizeStorage = {
  download: async (_ref) => Buffer.alloc(0),
  upload: async () => ({ key: 'k' }),
  publicUrl: () => '',
};

// A decoder's public-originals flag is optional, on a plain object too.
export const publicDecoder: SourceDecoder = {
  formats: ['x'],
  publicOriginals: true,
  inspect: async () => ({
    format: 'x',
    contentType: 'image/x',
    width: 1,
    height: 1,
  }),
  render: async () => ({
    data: Buffer.alloc(3),
    info: { width: 1, height: 1, channels: 3 },
  }),
};

// An engine is a plain object too; its `verify` stays optional.
export const plainEngine: ImageEngine = {
  id: 'plain',
  formats: ['webp'],
  animatedFormats: [],
  resize: async (frame) => frame,
  encode: async (raster) => ({
    data: raster.data,
    format: 'webp',
    contentType: 'image/webp',
    width: raster.info.width,
    height: raster.info.height,
  }),
};
// Written out: spreading a value typed as the class drops its methods from the type.
export const verifiedEngine: ImageEngine = {
  id: 'verified',
  formats: plainEngine.formats,
  animatedFormats: plainEngine.animatedFormats,
  resize: plainEngine.resize,
  encode: plainEngine.encode,
  verify: async () => {},
};

export const tasks: TaskQueue = {
  add: async () => ({ status: 'unconfirmed' }),
  claim: async () => null,
  renew: async () => true,
  complete: async () => true,
  fail: async () => true,
};

// An unconfirmed add may say that calling again cannot help, and why.
export const finalUnconfirmedTasks: TaskQueue = {
  add: async () => ({
    status: 'unconfirmed',
    retryable: false,
    causeCode: 'X',
  }),
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

// A host logger whose `debug` is not a function (a flag, say) is still a ResizeLogger, as it was
// before `debug` was declared: LogMetrics calls `debug` only when it is a function.
export const flagDebugLogger: ResizeLogger = {
  info() {},
  warn() {},
  error() {},
  debug: false,
};
const hostLogger = {
  info() {},
  warn() {},
  error() {},
  debug: 'verbose',
};
export const hostDebugLogger: ResizeLogger = hostLogger;

// A variantStep takes and returns a Raster, like a beforeStep: no library object in either list.
export const rasterStep: VariantStep = (raster) => raster;
// @ts-expect-error — a variantStep receives a Raster, not a Sharp instance.
export const oldStep: VariantStep = (img) => img.composite([]);

// Pinned from the documented SQS event: AWS's own record must assign to these, so a host needs no
// @types/aws-lambda. The extra fields are what a real record also carries.
const documentedRecord = {
  messageId: '059f36b4-87a3-44ab-83d2-661975830a7d',
  receiptHandle: 'AQEBwJnKyrHigUMZj6rYigCgxlaS3SLy0a',
  body: '{}',
  attributes: {
    ApproximateReceiveCount: '1',
    SentTimestamp: '1545082649183',
    SenderId: 'AIDAENQZJOLO23YVJ4VO',
    ApproximateFirstReceiveTimestamp: '1545082649185',
  },
  messageAttributes: {},
  md5OfBody: 'e4e68fb7bd0e697a0ae8f1bb342846b3',
  eventSource: 'aws:sqs',
  eventSourceARN: 'arn:aws:sqs:us-east-2:123456789012:my-queue',
  awsRegion: 'us-east-2',
};
export const sqsEvent: SqsEventLike = { Records: [documentedRecord] };
export const pushContext: LambdaContextLike = {
  getRemainingTimeInMillis: () => 1,
};
export const batchResponse: SqsBatchResponse = {
  batchItemFailures: [{ itemIdentifier: 'id' }],
};
