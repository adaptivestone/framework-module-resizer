// src/resizer.ts — the resize module's CONSTRUCTION SITE (scaffolded; edit freely).
//
// Storage, the task queue and the media model come from src/config/resize.ts (and
// resize.<NODE_ENV>.ts per environment); this file holds behaviour only: pipelines and hooks.
// Import it wherever you need the Resizer — a normal static import is fine: nothing is read from
// the framework until first use, and the worker command imports it too. To check the config at
// boot, call `await resizer.verify()` after `await server.init()`.
// The Resizer registers itself under its name ('default' unless you pass `name`), so DTO builders
// reach it via getResizer() — or `import { resizer }`. Construct each name once.
import { FrameworkResizer } from '@adaptivestone/framework-module-resize/framework.js';

export const resizer = new FrameworkResizer({
  pipelines: {
    default: {}, // add named pipelines, e.g. listing: { beforeSteps: [...] }, premium: { variantSteps: [...] }
  },
  // hooks: { formatPublicUrls: (decision, ctx) => formatPictureUrls(decision, { id: String(ctx.id) }) },
  // Code wins over config, e.g. `storage: new S3Storage({ …, client })` to reuse your own S3 client.
});
