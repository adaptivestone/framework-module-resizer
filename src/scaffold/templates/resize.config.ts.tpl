// src/config/resize.ts — host extension of the module defaults.
// Put environment-only changes in resize.<NODE_ENV>.ts; @adaptivestone/framework
// merges that file over this one before getConfig('resize') is called.
import type { ResizeConfig } from '@adaptivestone/framework-module-resize';
import defaultResizeConfig from '@adaptivestone/framework-module-resize/config/resize.js';

export default {
  ...defaultResizeConfig,
  mediaModelName: 'File', // TODO(REQUIRED): the host media model, e.g. File or Media
} satisfies ResizeConfig;
