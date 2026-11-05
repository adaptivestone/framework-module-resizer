// Test-only: a real worker process whose afterTaskComplete tap never settles, stopped the way a
// deploy stops one, with SIGTERM. worker.test.ts spawns it and watches it exit.
import { Resizer } from '../resizer.ts';
import { runWorker } from '../worker.ts';
import { fakeMedia, MemoryTaskQueue, memoryStorage } from './fakes.ts';
import { makeImageConfig } from './resizeConfig.ts';

const print = (line: unknown) => {
  process.stdout.write(`${String(line)}\n`);
};
const logger = { info: print, warn: print, error: print };
const tasks = new MemoryTaskQueue({ timing: { idlePollMs: 5 } });
const resizer = new Resizer({
  config: makeImageConfig({ formats: ['webp'] }),
  logger,
  storage: memoryStorage().storage,
  // A media that is gone: the task completes with no render, so only the tap can hold the worker.
  media: fakeMedia(),
  tasks,
});
resizer.hook('afterTaskComplete', () => {
  print('the tap is hanging');
  return new Promise<void>(() => {});
});
await tasks.add({
  resizer: 'default',
  queue: 'default',
  mediaId: 'gone',
  pipeline: 'default',
  previews: [{ sizeKey: '10x10', format: 'webp' }],
});

const stop = new AbortController();
process.once('SIGTERM', () => {
  stop.abort();
});
await runWorker({ logger, resizers: [resizer], signal: stop.signal });
