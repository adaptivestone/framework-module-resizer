// src/models/ResizeTask.ts — scaffolded thin shim. The MODULE owns the schema +
// indexes (ResizeTaskModel); this file only NAMES the model so the framework's filename-keyed
// loader registers getModel('ResizeTask'). The direct model import lets `npm run gen` parse
// the BaseModel ancestor and type getModel('ResizeTask'). Schema and indexes update with the
// package. Need custom fields/indexes? delete this file and re-run the scaffold with `--eject`.
import ResizeTaskModel from '@adaptivestone/framework-module-resize/framework/ResizeTaskModel.js';

// Point fileId at a differently-named media model with `static fileRef = 'Media'` (default 'File').
export default class ResizeTask extends ResizeTaskModel {}
