// src/resizer.ts — the resize module's CONSTRUCTION SITE (scaffolded; edit freely).
//
// Construct AFTER Server.init() (or lazily on first request). Do not construct
// in server.ts before startServer() — the framework app must exist first.
// Import this file from the API process (eager mode has no worker):
//     import './resizer.ts';
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
