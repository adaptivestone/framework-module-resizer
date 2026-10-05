// The worker's task handler (processTask) inside the core queue loop: a media error thrown while
// reading the source reaches the retry policy unwrapped, so an unusable source is dead-lettered
// on its first delivery instead of being downloaded and decoded again on every retry.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import sharp from 'sharp';
import type { LeasedTask, TaskEvent } from './contracts/taskQueue.ts';
import { consumeQueue } from './queue.ts';
import { Resizer, resetResizerForTests } from './resizer.ts';
import { fakeDb, MemoryTaskQueue } from './testHelpers/fakes.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';
import { processTask } from './worker.ts';

const silent = { info() {}, warn() {}, error() {} };

const png = await sharp({
  create: {
    width: 64,
    height: 48,
    channels: 3,
    background: { r: 255, g: 0, b: 0 },
  },
})
  .png()
  .toBuffer();

afterEach(resetResizerForTests);

test('a source over limits.sourcePixels is dead-lettered on its first delivery', async () => {
  const tasks = new MemoryTaskQueue({
    timing: { idlePollMs: 5, retryBackoffMs: { base: 5, max: 5 } },
  });
  let downloads = 0;
  new Resizer({
    config: makeImageConfig({
      formats: ['webp'],
      limits: { sourcePixels: 100 },
    }),
    logger: silent,
    storage: {
      download: async () => {
        downloads += 1;
        return png;
      },
      upload: async () => ({ key: 'k' }),
      publicUrl: () => '',
    },
    db: fakeDb({
      load: async () => ({
        id: 'm1',
        original: { storageRef: { key: 'o' } },
        previews: [],
      }),
    }),
    tasks,
  });
  await tasks.add({
    resizer: 'default',
    queue: 'default',
    mediaId: 'm1',
    pipeline: 'default',
    previews: [
      {
        sizeKey: '10x10',
        format: 'webp',
        requestedWidth: 10,
        requestedHeight: 10,
      },
    ],
    requestKey: 'k1',
  });
  const events: { event: TaskEvent; task: LeasedTask; error?: unknown }[] = [];
  const stop = new AbortController();
  const timeout = setTimeout(() => stop.abort(), 5000);
  await consumeQueue(tasks, {
    queue: 'default',
    signal: stop.signal,
    handle: (task, opts) => processTask(task, opts, tasks),
    onEvent: (event, task, error) => {
      events.push({ event, task, error });
      stop.abort();
    },
    logger: silent,
  });
  clearTimeout(timeout);
  assert.deepEqual(
    events.map((e) => e.event),
    ['deadLettered'],
  );
  assert.equal(
    (events[0].error as { code?: string }).code,
    'RESIZE_SOURCE_TOO_LARGE',
  );
  assert.equal(tasks.rows[0].status, 'dead');
  assert.equal(tasks.rows[0].attempts, 1);
  assert.equal(downloads, 1);
});
