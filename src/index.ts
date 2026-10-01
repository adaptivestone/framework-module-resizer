// @adaptivestone/framework-module-resize — the main entry (public API surface, 02 · §6).
//
// MAIN ENTRY = CORE ONLY. It imports no framework code (a guard test walks its import graph) and
// no driver: every driver lives behind its own package subpath with plain static imports, so a
// missing optional peer fails LOUDLY at the host's own driver import line. Framework hosts wire
// everything through the framework adapter:
//   import { createFrameworkResizer, createFrameworkMongoTransport } from '@adaptivestone/framework-module-resize/framework.js';
// Driver subpaths (house style: CLASSES implementing the Abstract* contracts):
//   import { MongoTransport }        from '@adaptivestone/framework-module-resize/transports/mongo.js';
//   import { SqsTransport }          from '@adaptivestone/framework-module-resize/transports/sqs.js';
//   import { S3Storage }             from '@adaptivestone/framework-module-resize/storage/s3.js';
//   import { LocalFsStorage }        from '@adaptivestone/framework-module-resize/storage/fs.js';
//   import { FrameworkMediaStore }   from '@adaptivestone/framework-module-resize/mediaStore/framework.js';
//   import { FrameworkLockProvider } from '@adaptivestone/framework-module-resize/locks/framework.js';
// The contract INTERFACES for custom-driver authors re-export below (the VALUES live at the
// subpaths).

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
} from './models/mediaFragment.ts';
// --- contract types for custom-driver / pipeline / hook authors (type-only; erased at runtime) ---
export type {
  BeforeStep,
  EnqueueTask,
  GenerateOpts,
  GenerateResult,
  HookFn,
  HookName,
  HookSignatures,
  LeasedTask,
  LockProvider,
  MediaStore,
  ObserverName,
  Pipeline,
  QueueTransport,
  ResizerOptions,
  ResizeStorage,
  StartWorkerOpts,
  TaskEvent,
  TaskEventHandler,
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
