// A FrameworkResizer behind createSqsHandler: the push entry needs nothing of the framework's own,
// so a framework host's Resizer, with its task queue passed in code, serves a pushed message as any
// other Resizer does. Nothing here touches AWS, and the recipe a framework host deploys is the
// guide's, tried only on a minimal host.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import sharp from 'sharp';
import defaultResizeConfig from '../config/resize.ts';
import { SqsTaskQueue } from '../drivers/sqs.ts';
import { createSqsHandler } from '../lambda.ts';
import { resetResizerForTests } from '../resizer.ts';
import { clockLocks, fakeMedia, silentLogger } from '../testHelpers/fakes.ts';
import {
  contextOf,
  fakeSqs,
  QUEUE_URL,
  recordOf,
} from '../testHelpers/pushHarness.ts';
import type { Preview } from '../types.d.ts';
import { FrameworkResizer } from './resizer.ts';

const jpeg = await sharp({
  create: {
    width: 64,
    height: 48,
    channels: 3,
    background: { r: 200, g: 40, b: 40 },
  },
})
  .jpeg()
  .toBuffer();

afterEach(() => {
  resetResizerForTests();
  resetAppInstance();
});

test('a FrameworkResizer serves a pushed message with no framework-specific code', async () => {
  setAppInstance({
    getConfig: () => ({
      ...defaultResizeConfig,
      concurrency: 1,
      formats: ['jpeg'],
      mediaModelName: 'File',
    }),
    getModel: () => undefined,
    logger: silentLogger,
  } as never);
  const sqs = fakeSqs();
  const rows = new Map<string, Preview[]>();
  new FrameworkResizer({
    storage: {
      download: async () => jpeg,
      upload: async ({ key }) => ({ key }),
      publicUrl: () => '',
    },
    media: fakeMedia({
      previews: rows,
      load: async (id) => ({
        id,
        original: {
          storageRef: { key: 'o' },
          format: 'jpeg',
          width: 64,
          height: 48,
        },
        previews: rows.get(id) ?? [],
      }),
    }),
    locks: clockLocks(),
    tasks: new SqsTaskQueue({
      queueUrl: QUEUE_URL,
      client: sqs.client as never,
      logger: silentLogger,
    }),
  });
  const handler = createSqsHandler({ logger: silentLogger });
  const body = {
    resizer: 'default',
    queue: 'default',
    mediaId: 'm1',
    pipeline: 'default',
    previews: [
      { sizeKey: '16w', format: 'jpeg', requestedWidth: 16 },
      { sizeKey: '24w', format: 'jpeg', requestedWidth: 24 },
    ],
    gateOwner: 'g1',
  };
  const out = await handler(
    { Records: [recordOf('a', { body })] },
    contextOf(60_000),
  );
  assert.deepEqual(out.batchItemFailures, []);
  assert.equal(rows.get('m1')?.length, 2);
  assert.equal(sqs.deletes(), 1);
});
