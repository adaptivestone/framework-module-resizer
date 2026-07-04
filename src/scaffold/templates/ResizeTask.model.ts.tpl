// src/models/ResizeTask.ts — scaffolded thin shim (08 · §12). The MODULE owns the schema +
// indexes (ResizeTaskModel); this file only NAMES the model so the framework's filename-keyed
// loader registers getModel('ResizeTask') and `npm run gen` types it. Auto-updates with the
// package — no drift. Need custom fields/indexes? re-run the scaffold with `--eject`.
import ResizeTaskModel from '@adaptivestone/framework-module-resize/models/ResizeTask.js';

// Point fileId at a differently-named media model with `static fileRef = 'Media'` (default 'File').
export default class ResizeTask extends ResizeTaskModel {}
