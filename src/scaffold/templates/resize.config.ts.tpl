// src/config/resize.ts — scaffolded EDITABLE config (08 · §12/§13). The framework loads this by
// filename as the `resize` config; the module's getResizeConfig() then deep-merges it OVER the
// module defaults (arrays REPLACE, nested objects merge field-by-field). This is the ONE file you
// are meant to tune — override any knob (formats / upload / encode / limits / queue / worker) at any depth.
import defaultResizeConfig from '@adaptivestone/framework-module-resize/config/resize.js';

export default {
  ...defaultResizeConfig,
  mediaModelName: 'File', // TODO (REQUIRED): your host media model name, e.g. 'File' or 'Media'
  // Example overrides (delete if unused):
  // formats: ['webp', 'avif'],            // arrays REPLACE the default (no concat)
  // upload: { ...defaultResizeConfig.upload, maxBytes: 10 * 1024 * 1024 },
  // encode: { ...defaultResizeConfig.encode, quality: { ...defaultResizeConfig.encode.quality, avif: 55 } },
  // Lazy/pre-warm: enable the worker command, then run `npm run cli ResizeWorker`.
  // worker: { ...defaultResizeConfig.worker, enabled: true, concurrency: 4 },
};
