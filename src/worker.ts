// The transport-agnostic worker (07 · Worker §11), framework-free. `runWorker()` serves every
// registered Resizer for ONE named queue: they must share one transport, each media store is
// verified first, and each Resizer's worker-lock TTL is checked against the transport's lease.
// The TRANSPORT owns lease → complete | fail and reports task events; the worker runs each task
// with the Resizer named in it and routes the events to that Resizer's observers. Framework
// hosts start it through `runResizeWorker()` (src/framework/worker.ts), which adds the
// `worker.enabled` switch, process signals and the app logger.
import sharp from 'sharp';
import type {
  LeasedTask,
  QueueTransport,
  TaskEvent,
  TaskEventHandler,
} from './contracts/transport.ts';
import { ResizeSetupError } from './errors.ts';
import { getResizer, listResizers, type ObserverName } from './resizer.ts';
import { processTaskWith } from './resizeTask.ts';
import type { ResizeLogger } from './types.d.ts';

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

export interface RunWorkerOptions {
  queue?: string; // queue to consume; default 'default'
  signal: AbortSignal; // stops the worker: finish in-flight tasks, then return
  logger?: ResizeLogger; // the worker's own messages; default console
  // Process-wide Sharp tuning, applied once (keep Resizers' config.concurrency × concurrency ≈
  // CPU cores). Omitted: Sharp's settings are left as they are.
  sharp?: { concurrency: number; cache: boolean };
}

export async function runWorker(opts: RunWorkerOptions): Promise<void> {
  const queue = opts.queue ?? 'default';
  const logger = opts.logger ?? console;
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
    logger.error(
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
      logger.error(
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

  if (opts.sharp) {
    sharp.concurrency(opts.sharp.concurrency);
    sharp.cache(opts.sharp.cache);
  }

  // The transport drives consumption its own way (poll OR push), owns completion/redelivery,
  // and passes each task a per-task lease-loss signal. processTask SUCCEEDS by returning and
  // FAILS by rejecting (never a synchronous throw).
  await transport.startWorker((task, taskOpts) => processTask(task, taskOpts), {
    signal: opts.signal,
    queue,
    onEvent,
  });
  logger.info('resize worker stopped');
}
