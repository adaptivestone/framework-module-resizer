// src/resizer.ts — the resize module's CONSTRUCTION SITE (scaffolded; edit freely).
//
// Import this file ONCE from src/server.ts so it runs in EVERY process (API + worker):
//     import './resizer.ts';
// On construction the Resizer registers itself as the one-per-process active instance, so the
// ResizeWorker command and your DTO builders reach it via getResizer() — or `import { resizer }`.
//
// Everything below is wired EXCEPT `storage` (REQUIRED): fill the storage TODO and you're done.
import { Resizer } from '@adaptivestone/framework-module-resize';
import { MongoTransport } from '@adaptivestone/framework-module-resize/transports/mongo.js';
// S3 / S3-compatible storage (install the optional AWS peers first — 05 · §10.5):
// import { S3Storage } from '@adaptivestone/framework-module-resize/storage/s3.js';

export const resizer = new Resizer({
  transport: new MongoTransport(), // or new SqsTransport({ queueUrl, region }); omit for eager-only (11 · Modes)
  storage:
    /* TODO (REQUIRED): new S3Storage({ bucketPublic: '…', publicUrl: '…' }) — uncomment the import above — or your own ResizeStorage (05 · §10.4) */,
  pipelines: {
    default: {}, // add named pipelines, e.g. listing: { beforeSteps: [...] }, premium: { variantSteps: [...] }
  },
  // hooks: { resolveSizes: (sizes, ctx) => sizes, formatPublicUrls: (decision, ctx) => decision },
});
