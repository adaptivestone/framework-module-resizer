// src/config/resize.ts — scaffolded EDITABLE config (08 · §12/§13). The framework loads this by
// filename as the resize config; the module's getResizeConfig() then deep-merges it OVER the
// module defaults (arrays REPLACE, nested objects merge field-by-field). Keep only host overrides
// here; the package supplies defaults for omitted fields.
import type {
  DeepPartial,
  ResizeConfig,
} from '@adaptivestone/framework-module-resize';

export default {
  mediaModelName: 'File', // TODO (REQUIRED): your host media model name, e.g. File or Media
  // Example overrides (delete if unused):
  // formats: ['webp'], // generated preview formats; arrays REPLACE the default
  // upload: { maxBytes: 10 * 1024 * 1024 }, // accepted original uploads
  // encode: { quality: { avif: 55 } },
  // Lazy/pre-warm: enable the worker command, then run npm run cli ResizeWorker.
  // worker: { enabled: true, concurrency: 4 },
} satisfies DeepPartial<ResizeConfig>;
