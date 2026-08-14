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
// Local filesystem (tests / first-week local) or S3 (install the optional AWS peers first):
// import { LocalFsStorage } from '@adaptivestone/framework-module-resize/storage/fs.js';
// import { S3Storage } from '@adaptivestone/framework-module-resize/storage/s3.js';

export const resizer = new Resizer({
  transport: new MongoTransport(), // or new SqsTransport({ queueUrl, region }); omit for eager-only (11 · Modes)
  // TODO(REQUIRED): provide a storage driver — e.g. `new LocalFsStorage({ rootDir: './var/media', publicBaseUrl: '/media' })`
  // or `new S3Storage({ bucketPublic: '…', publicBaseUrl: '…', client })` (uncomment an import above)
  // or your own ResizeStorage (05 · §10.4). Until then tsc fails with
  // "Cannot find name 'PROVIDE_YOUR_STORAGE_DRIVER'" — a loud, named reminder (see README).
  storage: PROVIDE_YOUR_STORAGE_DRIVER,
  pipelines: {
    default: {}, // add named pipelines, e.g. listing: { beforeSteps: [...] }, premium: { variantSteps: [...] }
  },
  // hooks: { formatPublicUrls: (decision, ctx) => formatPictureUrls(decision, { id: String(ctx.id) }) },
});
