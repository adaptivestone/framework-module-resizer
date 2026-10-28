// src/config/resize.ts — host extension of the module defaults.
// Put environment-only changes in resize.<NODE_ENV>.ts; @adaptivestone/framework merges that file
// over this one (objects field by field) before getConfig('resize') is called.
// The image settings go to the Resizer; FrameworkResizer builds `storage` from this file.
import {
  defaultFrameworkResizeConfig,
  type FrameworkResizeConfig,
} from '@adaptivestone/framework-module-resize/framework.js';

export default {
  ...defaultFrameworkResizeConfig,
  mediaModelName: 'File', // TODO(REQUIRED): the host media model, e.g. File or Media
  // Files on the local disk; serve `rootDir` at `publicBaseUrl`. For S3 in production, put in
  // resize.production.ts (npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner; credentials
  // come from the AWS SDK's default chain):
  //   storage: { driver: 's3', bucketPublic: '…', bucketPrivate: '…', publicBaseUrl: 'https://…' },
  storage: { driver: 'local', rootDir: './var/media', publicBaseUrl: '/media' },
  // Eager mode: no task queue. For background generation re-run resize-scaffold without --eager
  // (it adds the ResizeTask model and the worker command). Then, in this file,
  // add queues: { default: { driver: 'database' } }; to run the worker, also add
  // the switch worker: { enabled: true } (its other keys take their defaults).
} satisfies FrameworkResizeConfig;
