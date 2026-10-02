// @adaptivestone/framework-module-resize — the main entry: the core, the driver contracts and the
// helpers. It imports no framework code, no mongoose and no driver (a guard test walks its import
// graph). Shipped drivers live behind their own subpaths, so a missing optional peer fails at the
// host's own import line:
//   …/drivers/fs.js     LocalFsStorage
//   …/drivers/s3.js     S3Storage                      (optional peers: AWS S3 SDK)
//   …/drivers/mongo.js  MongoTransport, MongoMediaStore, MongoLockStore, createResizeModels
//   …/drivers/sqs.js    SqsTransport                   (optional peers: AWS SQS SDK, sqs-consumer)
//   …/framework.js      the framework adapter: createFrameworkResizer, createFrameworkMongoTransport, …

// --- driver contracts: abstract classes a custom driver extends (or any object of the same shape) ---
export { LockStore } from './contracts/lockStore.ts';
export { MediaStore } from './contracts/mediaStore.ts';
export { ResizeStorage, type StorageUploadArgs } from './contracts/storage.ts';
export {
  type EnqueueTask,
  type LeasedTask,
  QueueTransport,
  type StartWorkerOpts,
  type TaskEvent,
  type TaskEventHandler,
} from './contracts/transport.ts';
// --- read-path / eager option types (type-only) — hosts annotate their call sites ---
export type {
  EnqueueRequiredOpts,
  PrewarmOpts,
  ResolveOpts,
} from './engine.ts';
// --- error hierarchy: every module throw is a `ResizeError`; the subclass says what to DO ---
// Hosts catch `ResizeError` to separate "this module rejected it" from a sharp/S3/mongo failure,
// then branch on the subclass (or the stable `err.code`). `ResizeError.isResizeError(err)` is the
// duplicate-package-safe form of `instanceof` — prefer it across package boundaries.
export {
  ResizeConfigError,
  ResizeError,
  ResizeGenerateError,
  ResizeMediaError,
  ResizeNoOriginalError,
  ResizeOriginalError,
  ResizeSecurityError,
  ResizeSetupError,
  ResizeStorageError,
} from './errors.ts';
// --- pure identity + dimension helpers (03 · Identity) ---
export { formatPictureUrls } from './formatPictureUrls.ts';
export {
  calculateResizedDimensions,
  getFilterSig,
  getImageContentType,
  getPreviewIdentity,
  getSizeKey,
  isCatalogCovered,
  parseSizeKey,
} from './images.ts';
// --- optional `as const` media schema fragment the host spreads into File/Media (08 · §12) ---
export {
  resizeMediaPaths,
  resizeMediaSchemaFragment,
} from './mediaFragment.ts';
// --- contract types for custom-driver / pipeline / hook authors (type-only; erased at runtime) ---
export type {
  BeforeStep,
  GenerateOpts,
  GenerateResult,
  HookFn,
  HookName,
  HookSignatures,
  ObserverName,
  Pipeline,
  ResizerOptions,
  VariantStep,
  WaterfallName,
} from './resizer.ts';
// --- core: the Resizer + its registry accessors (constructor-wired; one per name) ---
// `resetResizerForTests` is a TEST-ONLY escape hatch. 02 · §6 documents it as "not re-exported
// from index.ts docs", but HOST test suites construct Resizers in their own tests (mirroring the
// framework publicly exporting `resetAppInstance`), so it IS re-exported here — documented
// deviation from that literal note.
export {
  getResizer,
  listResizers,
  Resizer,
  resetResizerForTests,
} from './resizer.ts';
// --- data shapes (types.d.ts) ---
export type * from './types.d.ts';
// --- the framework-free worker (framework hosts run `runResizeWorker` from …/framework.js) ---
export type { RunWorkerOptions } from './worker.ts';
export { processTask, runWorker } from './worker.ts';
