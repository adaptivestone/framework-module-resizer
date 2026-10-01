// The transport-agnostic worker entry (07 · Worker §11). `runResizeWorker()` serves every
// registered Resizer for ONE named queue: they must share one transport, each media store is
// verified first, sharp's process globals are tuned once, and SIGTERM/SIGINT stop it gracefully.
// The TRANSPORT owns lease → complete | fail and reports task events; the worker runs each task
// with the Resizer named in it and routes the events to that Resizer's observers.
import sharp from 'sharp';
import { getApp } from './app.ts';
import { ResizeSetupError } from './errors.ts';
import { getResizeConfig } from './resizeConfig.ts';
import { getResizer, listResizers, type ObserverName } from './resizer.ts';
import { processTaskWith } from './resizeTask.ts';
import type {
  LeasedTask,
  QueueTransport,
  TaskEvent,
  TaskEventHandler,
} from './transports/AbstractTransport.ts';

const OBSERVER: Record<TaskEvent, ObserverName> = {
  completed: 'afterTaskComplete',
  failed: 'onTaskFailed',
  deadLettered: 'onTaskDeadLettered',
};

/**
 * Run one leased task with the Resizer it names. An unknown name rejects with
 * RESIZE_NO_RESIZER, so the task retries and dead-letters instead of running with another
 * Resizer's storage and config.
 */
export async function processTask(
  task: LeasedTask,
  taskOpts?: { signal: AbortSignal },
): Promise<void> {
  return processTaskWith(getResizer(task.resizer), task, taskOpts);
}

export async function runResizeWorker(
  opts: { queue?: string } = {},
): Promise<void> {
  const queue = opts.queue ?? 'default';
  const app = getApp();
  const config = getResizeConfig();
  if (config.worker.enabled === false) {
    app.logger.info(
      'resize worker disabled — set config.worker.enabled=true in the host src/config/resize.ts to run it',
    );
    return;
  }
  const resizers = listResizers();
  if (resizers.length === 0) {
    throw new ResizeSetupError(
      'resize worker: no Resizer constructed — construct your Resizers in the worker process before starting it',
      { code: 'RESIZE_NO_RESIZER' },
    );
  }
  const transports = new Set<QueueTransport>();
  for (const resizer of resizers) {
    if (resizer.transport) {
      transports.add(resizer.transport);
    }
  }
  if (transports.size === 0) {
    app.logger.error(
      'resize worker: no Resizer was constructed with a transport (eager-only wiring)',
    );
    return;
  }
  if (transports.size > 1) {
    throw new ResizeSetupError(
      'resize worker: every Resizer served by one worker must share one transport instance — run one worker process per transport',
      { code: 'RESIZE_WORKER_TRANSPORTS_DIFFER' },
    );
  }
  const [transport] = transports;
  // Fail before leasing anything: a misconfigured media store (e.g. a wrong mediaModelName)
  // would otherwise surface only as per-task errors.
  for (const resizer of resizers) {
    await resizer.mediaStore.verify?.();
  }

  // Events are routed by the task's Resizer name, looked up when the event arrives.
  const onEvent: TaskEventHandler = async (event, task, error) => {
    const owner = listResizers().find((r) => r.name === task.resizer);
    if (!owner) {
      app.logger.error(
        `resize worker: ${event} for task ${task.taskId} of unknown Resizer '${task.resizer}'`,
      );
      return;
    }
    if (event === 'completed') {
      await owner.runObservers(OBSERVER[event], task, {});
    } else {
      await owner.runObservers(OBSERVER[event], task, error, {});
    }
  };

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
    // and passes each task a per-task lease-loss signal. processTask SUCCEEDS by returning and
    // FAILS by rejecting (never a synchronous throw). opts.signal is worker-wide graceful
    // shutdown (finish in-flight, then stop).
    await transport.startWorker(
      (task, taskOpts) => processTask(task, taskOpts),
      { signal: controller.signal, queue, onEvent },
    );
    app.logger.info('resize worker stopped');
  } finally {
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
  }
}
