// src/config/resize.ts — host extension of the module defaults.
// Put environment-only changes in resize.<NODE_ENV>.ts; @adaptivestone/framework
// merges that file over this one before getConfig('resize') is called.
// The image settings go to the Resizer; `queue` (Mongo transport timing) and `worker` (the
// worker command) are read by the framework adapter.
import type { FrameworkResizeConfig } from '@adaptivestone/framework-module-resize/framework.js';
import { defaultFrameworkResizeConfig } from '@adaptivestone/framework-module-resize/config/resize.js';

export default {
  ...defaultFrameworkResizeConfig,
  mediaModelName: 'File', // TODO(REQUIRED): the host media model, e.g. File or Media
  // Lazy / pre-warm modes: allow the worker command, then run `npm run cli ResizeWorker`.
  // worker: { ...defaultFrameworkResizeConfig.worker, enabled: true },
} satisfies FrameworkResizeConfig;
