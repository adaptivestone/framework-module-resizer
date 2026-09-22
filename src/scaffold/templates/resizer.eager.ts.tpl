// src/resizer.ts — the resize module's CONSTRUCTION SITE (scaffolded; edit freely).
//
// Load this file dynamically from API bootstrap AFTER `await server.init()`:
//     const { resizer } = await import('./resizer.ts');
// A static import runs before bootstrap code and is therefore too early.
import { Resizer } from '@adaptivestone/framework-module-resize';
import { LocalFsStorage } from '@adaptivestone/framework-module-resize/storage/fs.js';
// S3 / S3-compatible storage (install the optional AWS peers first — 05 · §10.5):
// import { S3Storage } from '@adaptivestone/framework-module-resize/storage/s3.js';

export const resizer = new Resizer({
  // Local filesystem — swap for `new S3Storage({ bucketPublic, publicBaseUrl, client })`
  // when you have buckets. No queue/worker in eager mode.
  storage: new LocalFsStorage({
    rootDir: './var/media',
    publicBaseUrl: '/media',
  }),
  pipelines: {
    default: {}, // add named pipelines, e.g. listing: { beforeSteps: [...] }, premium: { variantSteps: [...] }
  },
  // hooks: { formatPublicUrls: (decision, ctx) => formatPictureUrls(decision, { id: String(ctx.id) }) },
});

// Eager-only has no transport or worker. Queue indexes are not involved in this mode.
