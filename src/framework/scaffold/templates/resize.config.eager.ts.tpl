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
  // The name of your media model. 'File' is a guess: change it if yours has another name (a wrong
  // name fails on first use with RESIZE_CONFIG_MEDIA_MODEL_UNKNOWN).
  mediaModelName: 'File',
  // Files on the local disk. The framework serves no static files, so run something that serves
  // exactly `rootDir` at `publicBaseUrl` (guide: "Serve local files"). Never serve a folder above
  // `rootDir`: `privateRootDir` holds the private originals beside it. Use an absolute URL when the
  // frontend is on another origin. For S3 in production, put in resize.production.ts (npm i
  // @aws-sdk/client-s3; credentials come from the AWS SDK's default chain):
  //   storage: { driver: 's3', bucketPublic: '…', bucketPrivate: '…', publicBaseUrl: 'https://…' },
  storage: { driver: 'local', rootDir: './var/media', privateRootDir: './var/media-private',
    publicBaseUrl: process.env.RESIZE_PUBLIC_BASE_URL || 'http://localhost:3300/media' },
  // Eager mode: no task queue. For background generation re-run resize-scaffold without --eager
  // (it adds the ResizeTask model and the worker command). Then, in this file,
  // add queues: { default: { driver: 'database' } }; to run the worker, also add
  // the switch worker: { enabled: true } (its other keys take their defaults).
} satisfies FrameworkResizeConfig;
