// src/resizer.ts — the resize module's CONSTRUCTION SITE (scaffolded; edit freely).
//
// Import it wherever you need the Resizer — a normal static import is fine: nothing is read from
// the framework until first use. The worker process imports it from the scaffolded
// src/commands/ResizeWorker.ts. To check the config at boot, call `await resizer.verify()` after
// `await server.init()`.
// On construction the Resizer registers itself under its name ('default' unless you pass
// `name`), so the ResizeWorker command and your DTO builders reach it via getResizer() — or
// `import { resizer }`. Construct each name once.
//
// Everything below is wired EXCEPT `storage` (REQUIRED): fill the storage TODO and you're done.
// createFrameworkResizer fills config (src/config/resize.ts), the app logger and the media store
// from the framework app; createFrameworkMongoTransport uses the scaffolded ResizeTask model, the
// framework Lock model and the `queue` timing from the same config.
import {
  createFrameworkMongoTransport,
  createFrameworkResizer,
} from '@adaptivestone/framework-module-resize/framework.js';
// Local filesystem (tests / first-week local) or S3 (install the optional AWS peers first):
// import { LocalFsStorage } from '@adaptivestone/framework-module-resize/drivers/fs.js';
// import { S3Storage } from '@adaptivestone/framework-module-resize/drivers/s3.js';

export const resizer = createFrameworkResizer({
  transport: createFrameworkMongoTransport(), // or new SqsTransport({ queueUrl, region, locks: new FrameworkLockStore() }); omit for eager-only
  // TODO(REQUIRED): provide a storage driver — e.g. `new LocalFsStorage({ rootDir: './var/media', publicBaseUrl: '/media' })`
  // or `new S3Storage({ bucketPublic: '…', bucketPrivate: '…', publicBaseUrl: '…', client })`
  // (use distinct buckets when originals must stay private; uncomment an import above)
  // or your own ResizeStorage (05 · §10.4). Until then tsc fails with
  // "Cannot find name 'PROVIDE_YOUR_STORAGE_DRIVER'" — a loud, named reminder.
  storage: PROVIDE_YOUR_STORAGE_DRIVER,
  pipelines: {
    default: {}, // add named pipelines, e.g. listing: { beforeSteps: [...] }, premium: { variantSteps: [...] }
  },
  // hooks: { formatPublicUrls: (decision, ctx) => formatPictureUrls(decision, { id: String(ctx.id) }) },
});

// Queue indexes are declared by the scaffolded ResizeTask model and the framework Lock model.
// Prepare those indexes in the host's normal migration/lifecycle process before exposing
// producers or starting the separate ResizeWorker CLI. The resizer runtime does not create or
// synchronize indexes.
