// @adaptivestone/framework-module-resize — the main entry (public API surface, 02 · §6).
//
// MAIN ENTRY = CORE ONLY. Every DRIVER lives behind its own package subpath with plain
// static imports inside; the main entry never resolves any driver's (optional-peer)
// dependencies — so `import '@adaptivestone/framework-module-resize'` never loads the AWS
// SDKs, and a missing optional peer fails LOUDLY at the host's own driver import line at
// bootstrap, not at the first I/O call. The five driver subpaths (house style: CLASSES
// implementing the Abstract* contracts, constructed `new X(opts?)`):
//   import { MongoTransport }        from '@adaptivestone/framework-module-resize/transports/mongo.js';
//   import { SqsTransport }          from '@adaptivestone/framework-module-resize/transports/sqs.js';
//   import { S3Storage }             from '@adaptivestone/framework-module-resize/storage/s3.js';
//   import { FrameworkMediaStore }   from '@adaptivestone/framework-module-resize/mediaStore/framework.js';
//   import { FrameworkLockProvider } from '@adaptivestone/framework-module-resize/locks/framework.js';
// The contract INTERFACES for custom-driver authors re-export below (the VALUES live at the
// subpaths). The core constructs the two framework DEFAULTS internally, so omitting
// mediaStore/lockProvider still needs zero host imports.

// --- worker: the CLI command (default export) + the programmatic entries ---
// Reconciled vs 02 · §6's literal `export { default as ResizeWorker, runResizeWorker } from
// './worker.ts'`: the ResizeWorker CLASS actually lives in ./commands/ResizeWorker.ts (a package
// subpath the scaffold re-exports); `runResizeWorker` is the module function in ./worker.ts.
export { default as ResizeWorker } from './commands/ResizeWorker.ts';
// --- config: the defaults + the host-merged resolver + the active-format list ---
export {
  default as defaultResizeConfig,
  getResizeConfig,
  requiredFormats,
} from './config/resize.ts';
// --- read-path / eager option types (type-only) — hosts annotate their call sites ---
export type { PrewarmOpts, ResolveOpts } from './engine.ts';
// --- pure identity + dimension helpers (03 · Identity) ---
export {
  calculateResizedDimensions,
  getFilterSig,
  getImageContentType,
  getPreviewIdentity,
  getSizeKey,
  parseSizeKey,
} from './images.ts';
// --- optional `as const` media schema fragment the host spreads into File/Media (08 · §12) ---
export { resizeMediaSchemaFragment } from './models/mediaFragment.ts';
export type { TResizeTask } from './models/ResizeTask.ts';
// --- Mongo-transport model class (the host's scaffolded model `extends` it) + its doc type ---
export { default as ResizeTaskModel } from './models/ResizeTask.ts';
// --- contract types for custom-driver / pipeline / hook authors (type-only; erased at runtime) ---
export type {
  BeforeStep,
  GenerateOpts,
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
  VariantStep,
  WaterfallName,
} from './resizer.ts';
// --- core: the Resizer + its process-wide accessors (constructor-wired; one per process) ---
// `resetResizerForTests` is a TEST-ONLY escape hatch. 02 · §6 documents it as "not re-exported
// from index.ts docs", but HOST test suites construct Resizers in their own tests (mirroring the
// framework publicly exporting `resetAppInstance`), so it IS re-exported here — documented
// deviation from that literal note.
export { getResizer, Resizer, resetResizerForTests } from './resizer.ts';
export { processTask } from './resizeTask.ts';
// --- data shapes (types.d.ts) ---
export type * from './types.d.ts';
export { runResizeWorker } from './worker.ts';
