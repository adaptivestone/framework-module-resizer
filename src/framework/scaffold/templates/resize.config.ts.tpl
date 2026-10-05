// src/config/resize.ts — host extension of the module defaults.
// Put environment-only changes in resize.<NODE_ENV>.ts; @adaptivestone/framework merges that file
// over this one (objects field by field) before getConfig('resize') is called.
// The image settings go to the Resizer; FrameworkResizer builds `storage` and `queue` from this
// file, and `worker` configures the worker command.
import type { FrameworkResizeConfig } from '@adaptivestone/framework-module-resize/framework.js';
import { defaultFrameworkResizeConfig } from '@adaptivestone/framework-module-resize/config/resize.js';

export default {
  ...defaultFrameworkResizeConfig,
  mediaModelName: 'File', // TODO(REQUIRED): the host media model, e.g. File or Media
  // Files on the local disk; serve `rootDir` at `publicBaseUrl`. For S3 in production, put in
  // resize.production.ts (npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner; credentials
  // come from the AWS SDK's default chain):
  //   storage: { driver: 's3', bucketPublic: '…', bucketPrivate: '…', publicBaseUrl: 'https://…' },
  storage: { driver: 'local', rootDir: './var/media', publicBaseUrl: '/media' },
  // Background generation: tasks wait in the scaffolded ResizeTask model. Create its indexes (and
  // the framework Lock model's) through your migration process; the module never creates them.
  // Or { driver: 'sqs', queueUrl: '…' } (npm i @aws-sdk/client-sqs); false = eager only.
  queue: { driver: 'database' },
  // Allow the worker command, then run `npm run cli ResizeWorker` as its own process.
  // worker: { ...defaultFrameworkResizeConfig.worker, enabled: true },
} satisfies FrameworkResizeConfig;
