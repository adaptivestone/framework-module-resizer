// What the 'sqs' queue driver knows about its `queues` entries without loading its module: the
// driver needs the optional SQS SDK, and these checks must run (and the entries must be grouped
// into backends) whether or not that package is installed.
import type { QueueEntry, QueueSection } from '../contracts/drivers.ts';
import { ResizeConfigError } from '../errors.ts';
import type { SqsQueueConfig } from '../types.d.ts';

// SqsTaskQueue's long poll when `waitTimeSeconds` is not set. Keep in step with the driver's own
// default (`this.#opts.waitTimeSeconds ?? 10` in SqsTaskQueue.claim, src/drivers/sqs.ts), which is
// not imported here: that module loads the optional AWS SDK.
const SQS_DEFAULT_WAIT_TIME_SECONDS = 10;

const invalid = (message: string): ResizeConfigError =>
  new ResizeConfigError(`resize config: ${message}`, {
    code: 'RESIZE_CONFIG_INVALID',
  });

/**
 * Check the SQS entries (every entry given, whatever its driver name): each needs its own
 * non-empty queueUrl, so one SQS queue never carries the tasks of two names (each name's worker
 * would take the other's).
 */
export function validateSqsEntries(
  entries: readonly QueueEntry[],
  ctx: { where: string },
): void {
  // A queue URL → the entry that uses it.
  const urls = new Map<string, string>();
  for (const { name, section } of entries) {
    const url = (section as Partial<SqsQueueConfig>).queueUrl;
    if (typeof url !== 'string' || url.length === 0) {
      throw invalid(
        `\`queues.${name}.queueUrl\` in ${ctx.where} is required for the 'sqs' driver`,
      );
    }
    const other = urls.get(url);
    if (other !== undefined) {
      throw invalid(
        `\`queues.${other}\` and \`queues.${name}\` in ${ctx.where} have the same queueUrl ${url} — give each queue name its own SQS queue`,
      );
    }
    urls.set(url, name);
  }
}

/**
 * The backend of an SQS entry: one per region, endpoint, dead-letter queue and effective long
 * poll, the settings one SqsTaskQueue holds for all its names.
 */
export function sqsBackendKey(section: QueueSection): string {
  const { region, endpoint, deadLetterQueueUrl, waitTimeSeconds } =
    section as Partial<SqsQueueConfig>;
  return `sqs:${JSON.stringify([region ?? null, endpoint ?? null, deadLetterQueueUrl ?? null, waitTimeSeconds ?? SQS_DEFAULT_WAIT_TIME_SECONDS])}`;
}
