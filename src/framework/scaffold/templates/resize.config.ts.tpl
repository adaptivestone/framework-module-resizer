// src/config/resize.ts — host extension of the module defaults.
// Put environment-only changes in resize.<NODE_ENV>.ts; @adaptivestone/framework merges that file
// over this one (objects field by field) before getConfig('resize') is called.
// The default Resizer (new FrameworkResizer() without `configName`) reads its image settings,
// `storage` and `queue` from this file; another Resizer reads the same sections from its own file.
import {
  defaultFrameworkResizeConfig,
  defaultWorkerOptions,
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
  // The queue this Resizer's tasks go to: a name from `queues` below; false = eager only.
  queue: 'default',

  // process-wide sections, read only from this file (every Resizer and the worker use them)

  // Every queue, by name, with its own timing (leaseMs, maxAttempts, …; the rest default). The
  // 'database' driver keeps tasks in the scaffolded ResizeTask model. Create its indexes (the
  // gate index among them) through your migration process; the module never creates them.
  queues: { default: { driver: 'database' } },
  // or { driver: 'sqs', queueUrl: '…' } (npm i @aws-sdk/client-sqs), one SQS queue per name;
  // beside SQS, the framework Lock model holds a gate lock per Resizer, media, pipeline and queue.
  // A queue may use another backend than its neighbours, for example
  //   bulk: { driver: 'sqs', queueUrl: '…' } beside the database `default`
  // (needs @aws-sdk/client-sqs; without it `bulk` is not served in that process). One worker can
  // consume several queues: npm run cli ResizeWorker -- --queue=default --queue=bulk
  // The coordination defaults (see README "Coordination"):
  // coordination: { gateTtlMs: 600_000, cooldownMs: 600_000 },
  // enabled: true lets `npm run cli ResizeWorker` run; start it as its own process.
  worker: { ...defaultWorkerOptions, enabled: false },
} satisfies FrameworkResizeConfig;
// resize.<NODE_ENV>.ts holds only what it changes, so it ends with
// `satisfies Partial<FrameworkResizeConfig>` when it leaves out only top-level keys, or with
// `satisfies PartialFrameworkResizeConfig` (a type from the same framework.js) when it leaves out
// nested keys, for example only limits.sourcePixels. Likewise, a resize.ts that holds only the
// process-wide sections (no default Resizer) writes `satisfies Partial<FrameworkResizeConfig>`.
