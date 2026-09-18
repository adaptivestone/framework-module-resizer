// The transport-agnostic worker entry (07 · Worker §11). `runResizeWorker()` tunes sharp's
// process globals ONCE, wires graceful shutdown to SIGTERM/SIGINT, and hands the transport a
// per-task handler (processTask). The TRANSPORT owns lease → complete | fail and fires the
// completion/failure observers (05 · §10.2); the worker only supplies the WORK.
import sharp from 'sharp';
import { getApp } from './app.ts';
import { getResizeConfig } from './config/resize.ts';
import { getResizer } from './resizer.ts';
import { processTask } from './resizeTask.ts';

export async function runResizeWorker(): Promise<void> {
  const app = getApp();
  const config = getResizeConfig();
  if (config.worker.enabled === false) {
    app.logger.info(
      'resize worker disabled — set config.worker.enabled=true in the host src/config/resize.ts to run it',
    );
    return;
  }
  const resizer = getResizer();
  const { transport } = resizer;
  if (!transport) {
    app.logger.error(
      'resize worker: Resizer was constructed without a transport (eager-only wiring)',
    );
    return;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);

  try {
    // Tune sharp ONCE for a concurrent worker: keep worker.concurrency × sharp.concurrency ≈ nCPU
    // (avoid libvips thread oversubscription), and disable the op-cache (distinct images per task).
    sharp.concurrency(config.worker.sharpConcurrency);
    sharp.cache(config.worker.sharpCache);

    // The transport drives consumption its own way (poll OR push), owns completion/redelivery,
    // and passes each task a per-task lease-loss signal. processTask SUCCEEDS by returning, FAILS
    // by throwing. opts.signal is worker-wide graceful shutdown (finish in-flight, then stop).
    await transport.startWorker(
      (task, taskOpts) => processTask(task, taskOpts),
      {
        signal: controller.signal,
      },
    );
    app.logger.info('resize worker stopped');
  } finally {
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
  }
}
