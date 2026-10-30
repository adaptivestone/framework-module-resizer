// The queue a Resizer's tasks go to, chosen from its `queueName` option or its config's `queue`.
// createResizer and the framework adapter choose it the same way; only how the messages name the
// config differs.
import { ResizeConfigError } from '../errors.ts';

/** The chosen queue: its name, and the `queues` entry to build the task queue for. */
export interface Lane<E> {
  queueName: string;
  // undefined: no task queue from the config (eager only, or the task queue was given in code)
  entry: E | undefined;
}

export interface ChooseLaneOptions<E> {
  resizer: string; // the Resizer's name, for the message
  where: string; // the Resizer's config as messages name it
  queuesIn: string; // the config that defines `queues`, as the messages name it
  option: string | undefined; // the `queueName` option
  file: unknown; // the config's `queue`, unchecked
  fromCode: boolean; // the task queue is given in code (or `tasks: false`)
  queues: () => ReadonlyMap<string, E>; // the `queues` entries by name, read only when needed
}

/**
 * Choose the queue of a Resizer from the `queueName` option, else its config's `queue`. A `queue`
 * object is the old shape (RESIZE_CONFIG_REMOVED_KEY); any other value that is neither a queue
 * name nor false is RESIZE_CONFIG_INVALID. With a task queue in code (`fromCode`), the lane is not
 * looked up in `queues`: the name is the option, the config's name, or 'default'. Otherwise false
 * is eager only; no name is 'default' when `queues` has entries, and eager only when it has none;
 * a name it does not define is RESIZE_CONFIG_QUEUE_UNKNOWN.
 */
export function chooseLane<E>(opts: ChooseLaneOptions<E>): Lane<E> {
  const { resizer, where, queuesIn, option, fromCode } = opts;
  const file = checkedQueue(opts.file, where, queuesIn);
  if (fromCode) {
    const queueName = option ?? (typeof file === 'string' ? file : 'default');
    return { queueName, entry: undefined };
  }
  const name = option ?? file;
  if (name === false) {
    return { queueName: 'default', entry: undefined };
  }
  const queues = opts.queues();
  if (name === undefined && queues.size === 0) {
    return { queueName: 'default', entry: undefined };
  }
  const queueName = name ?? 'default';
  const entry = queues.get(queueName);
  if (!entry) {
    const implied =
      name === undefined
        ? ` (the default when ${where} sets no \`queue\`)`
        : '';
    // The option wins over the config, so a name from it is fixed in the code.
    const fix =
      option === undefined
        ? 'set `queue` to a defined name, or queue: false for eager only'
        : 'set `queueName` to a defined name, or pass tasks: false for eager only';
    throw new ResizeConfigError(
      `resize config: Resizer '${resizer}' queues to '${queueName}'${implied}, which \`queues\` in ${queuesIn} does not define — add queues.${queueName}, ${fix}`,
      { code: 'RESIZE_CONFIG_QUEUE_UNKNOWN' },
    );
  }
  return { queueName, entry };
}

/** The config's `queue`: a queue name, false or undefined; any other value throws. */
function checkedQueue(
  value: unknown,
  where: string,
  queuesIn: string,
): string | false | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    // A `queue` object is the 0.2 shape, where each config carried its own task queue.
    throw new ResizeConfigError(
      `resize config: \`queue\` in ${where} is now a queue name — define the queue once in ${queuesIn} as queues: { default: { driver: 'database', …timing } } and set queue: 'default' (or queue: false for eager only)`,
      { code: 'RESIZE_CONFIG_REMOVED_KEY' },
    );
  }
  if (
    value === undefined ||
    value === false ||
    (typeof value === 'string' && value.trim().length > 0)
  ) {
    return value;
  }
  throw new ResizeConfigError(
    `resize config: \`queue\` in ${where} must be a queue name (a key of \`queues\` in ${queuesIn}) or false for eager only`,
    { code: 'RESIZE_CONFIG_INVALID' },
  );
}
