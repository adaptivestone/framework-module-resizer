// The framework's worker entry (the `ResizeWorker` CLI command runs it). It adds what the core
// worker leaves to the host: the `worker.enabled` switch and Sharp tuning from `worker` in
// src/config/resize.ts (process-wide: whatever files the process's Resizers read), graceful
// shutdown on SIGTERM/SIGINT, and the app logger.
import { ResizeSetupError } from '../errors.ts';
import { listResizers } from '../resizer.ts';
import { runWorker } from '../worker.ts';
import { getApp } from './app.ts';
import { getProcessConfig } from './config.ts';

export async function runResizeWorker(
  opts: { queue?: string } = {},
): Promise<void> {
  const app = getApp();
  const { worker } = getProcessConfig();
  if (worker.enabled === false) {
    app.logger.info(
      'resize worker disabled — set worker: { enabled: true } in src/config/resize.ts (or its resize.<NODE_ENV>.ts override) to run it',
    );
    return;
  }
  // The core worker rejects an empty registry too; this message names the framework fix.
  if (listResizers().length === 0) {
    throw new ResizeSetupError(
      'resize worker: no Resizer constructed in the worker process — src/commands/ResizeWorker.ts must import src/resizer.ts (delete it and re-run resize-scaffold)',
      { code: 'RESIZE_NO_RESIZER' },
    );
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  try {
    await runWorker({
      ...(opts.queue === undefined ? {} : { queue: opts.queue }),
      signal: controller.signal,
      logger: app.logger,
      sharp: { concurrency: worker.sharpConcurrency, cache: worker.sharpCache },
    });
  } finally {
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
  }
}
