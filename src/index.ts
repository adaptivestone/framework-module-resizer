// @adaptivestone/framework-module-resize — the main entry: the core, the driver contracts and the
// helpers. It imports no framework code, no mongoose and no driver (a guard test walks its import
// graph). Shipped drivers live behind their own subpaths, so a missing optional peer fails at the
// host's own import line:
//   …/drivers/fs.js     LocalFsStorage
//   …/drivers/s3.js     S3Storage                      (optional peers: AWS S3 SDK)
//   …/drivers/mongo.js  mongoParts, MongoMediaStore, MongoLockStore, MongoTaskQueue, …
//   …/drivers/sqs.js    SqsTaskQueue                   (optional peer: AWS SQS SDK)
//   …/framework.js      the framework adapter: FrameworkResizer, FrameworkMediaStore, …

// --- contracts: the abstract classes a custom driver or decoder extends (or any object of the
// same shape), the decoder's data shapes, and the pipeline and hook types for pipeline and hook
// authors (type-only; erased at runtime) ---
export {
  type DecodeBox,
  type Raster,
  type RasterInfo,
  type RenderOptions,
  SourceDecoder,
  type SourceInfo,
} from './contracts/decoder.ts';
// The driver factories: how a config section becomes a part (`fromConfig` on a registered driver).
export type {
  DatabaseDriver,
  DatabaseParts,
  DriverContext,
  DriverRegistry,
  QueueDriver,
  QueueDriverContext,
  QueueEntry,
  QueueSection,
  StorageDriver,
} from './contracts/drivers.ts';
export type {
  HookFn,
  HookName,
  HookSignatures,
  HookTaps,
  ObserverName,
  WaterfallName,
} from './contracts/hooks.ts';
export { LockStore } from './contracts/locks.ts';
export { MediaStore, type ReplacedPreviews } from './contracts/media.ts';
export type {
  BeforeStep,
  Pipeline,
  VariantStep,
} from './contracts/pipeline.ts';
export { ResizeStorage, type StorageUploadArgs } from './contracts/storage.ts';
export {
  type ClaimedTask,
  type ClaimOptions,
  type FailOptions,
  type LeasedTask,
  type NewTask,
  type TaskAddResult,
  type TaskEvent,
  type TaskEventHandler,
  TaskQueue,
} from './contracts/taskQueue.ts';
// --- error hierarchy: every module throw is a `ResizeError`; the subclass says what to DO ---
// Hosts catch `ResizeError` to separate "this module rejected it" from a sharp/S3/mongo failure,
// then branch on the subclass (or the stable `err.code`). `ResizeError.isResizeError(err)` is the
// duplicate-package-safe form of `instanceof` — prefer it across package boundaries.
export {
  ResizeConfigError,
  ResizeError,
  type ResizeErrorOptions,
  ResizeGenerateError,
  ResizeMediaError,
  ResizeNoOriginalError,
  ResizeOriginalError,
  ResizeSecurityError,
  ResizeSetupError,
  ResizeStorageError,
} from './errors.ts';
// --- the config a Resizer is built from: image settings over the defaults, and its sections;
// createResizer builds a Resizer from it, each section through a built-in driver or one the host
// registers by name (the built-in drivers' modules load only when a config selects them) ---
export {
  type CreateResizerOptions,
  createResizer,
} from './factory/createResizer.ts';
export type { ResizerConfig } from './factory/types.ts';
// --- public URL formatting and size catalog helpers ---
export { formatPictureUrls } from './formatPictureUrls.ts';
export {
  getSizeKey,
  isCatalogCovered,
  parseSizeKey,
} from './images.ts';
// --- the Raster helpers: a Sharp-based beforeStep wraps the raster it receives and reads its
// result back (`async (r) => sharpToRaster(rasterToSharp(r).blur(5))`) ---
export { rasterToSharp, sharpToRaster } from './raster.ts';
// --- core: the Resizer + named lookup (constructor-wired; one per name) ---
// `resetResizerForTests` is a TEST-ONLY escape hatch for host test suites.
export type { ResizerOptions } from './resizer.ts';
export {
  getResizer,
  Resizer,
  resetResizerForTests,
} from './resizer.ts';
// --- queue names on several backends: a task queue that routes each name to the backend that
// carries it, and how to find the backend of a name on any task queue ---
export {
  carrierOf,
  type Route,
  RoutingTaskQueue,
  type RoutingTaskQueueOptions,
} from './routing.ts';
// --- data shapes and options (types.d.ts: ResolveOpts, PrewarmOpts, GenerateOpts,
// InvalidateOpts, CoordinationOptions, …) ---
export type * from './types.d.ts';
// --- the framework-free worker (framework hosts run `runResizeWorker` from …/framework.js) ---
export type { RunWorkerOptions } from './worker.ts';
export { runWorker } from './worker.ts';
