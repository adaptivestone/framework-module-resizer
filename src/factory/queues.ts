// The `queues` map of a config: every queue, by name. resolveQueueEntries checks what every entry
// needs whatever its driver (an object with a driver name, valid timing); validateQueueDrivers
// checks each entry's driver is registered and lets each driver check its own entries.
import type {
  QueueDriver,
  QueueEntry,
  QueueSection,
} from '../contracts/drivers.ts';
import { ResizeConfigError, ResizeError } from '../errors.ts';
import { fillTiming, LOCK_TTL_MOVES } from '../timing.ts';
import type { QueueTimingOptions } from '../types.d.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalid = (message: string): ResizeConfigError =>
  new ResizeConfigError(`resize config: ${message}`, {
    code: 'RESIZE_CONFIG_INVALID',
  });

const removed = (message: string): ResizeConfigError =>
  new ResizeConfigError(`resize config: ${message}`, {
    code: 'RESIZE_CONFIG_REMOVED_KEY',
  });

// The driver names a message offers: the registered ones in registry order (the built-in ones
// first), as 'a', 'b' or 'c'.
const driverChoice = (names: readonly string[]): string => {
  const quoted = names.map((name) => `'${name}'`);
  return quoted.length > 1
    ? `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`
    : (quoted[0] ?? 'a registered driver');
};

// The built-in queue drivers, which a message names when the drivers are not known yet.
const BUILT_IN_QUEUE_DRIVERS = ['database', 'sqs'];

const needsDriver = (
  name: string,
  where: string,
  names: readonly string[],
): ResizeConfigError =>
  invalid(`\`queues.${name}\` in ${where} needs driver ${driverChoice(names)}`);

/**
 * The entries of the `queues` map `value`, in the map's order; `where` names the config in
 * messages. No map is no entries, and an entry set to undefined is not defined: the framework's
 * merge keeps the key of an environment file that removes a queue that way. Each entry needs an
 * object with a non-empty `driver` name (which names are registered is validateQueueDrivers'
 * question); its timing keys fill the defaults.
 */
export function resolveQueueEntries(
  value: unknown,
  where: string,
): QueueEntry[] {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    throw invalid(
      `\`queues\` in ${where} must be an object of queue names, e.g. queues: { default: { driver: 'database' } }`,
    );
  }
  const entries: QueueEntry[] = [];
  for (const [name, entry] of Object.entries(value)) {
    if (entry === undefined) {
      continue;
    }
    if (name.trim().length === 0) {
      throw invalid(
        `\`queues\` in ${where} has a blank queue name — name each queue, e.g. queues: { default: { driver: 'database' } }`,
      );
    }
    // Checked before fillTiming, which rejects lockTtlMs too, but without naming the entry.
    if (isRecord(entry) && Object.hasOwn(entry, 'lockTtlMs')) {
      throw removed(
        `\`queues.${name}.lockTtlMs\` in ${where} is no longer supported — set coordination in the same file instead: { gateTtlMs, cooldownMs } (${LOCK_TTL_MOVES})`,
      );
    }
    if (isRecord(entry) && Object.hasOwn(entry, 'queues')) {
      throw removed(
        `\`queues.${name}.queues\` in ${where} is no longer supported — give each SQS queue its own entry in \`queues\`, e.g. bulk: { driver: 'sqs', queueUrl: '…' }`,
      );
    }
    if (
      !isRecord(entry) ||
      typeof entry.driver !== 'string' ||
      entry.driver.trim().length === 0
    ) {
      throw needsDriver(name, where, BUILT_IN_QUEUE_DRIVERS);
    }
    const section = entry as unknown as QueueSection;
    entries.push({ name, section, timing: entryTiming(entry, name, where) });
  }
  return entries;
}

/** An entry's timing; an invalid one keeps its code and names the entry. */
function entryTiming(
  section: Record<string, unknown>,
  name: string,
  where: string,
): QueueTimingOptions {
  try {
    return fillTiming(section);
  } catch (err) {
    if (ResizeError.isResizeError(err)) {
      throw new ResizeConfigError(
        `resize config: \`queues.${name}\` in ${where}: ${err.message.replace(/^resize queue options: /, '')}`,
        { code: err.code, retryable: err.retryable, cause: err },
      );
    }
    throw err;
  }
}

/**
 * Check each entry's driver is registered in `drivers` (RESIZE_CONFIG_INVALID naming the entry and
 * the registered names), then run each selected driver's `validate` once, on all its entries.
 * A `validate` in `validated` already ran on these entries (e.g. the framework adapter checks its
 * SQS entries itself) and is skipped. The skip is by function, not by name: a host driver
 * registered under a built-in name has its own `validate`, which always runs.
 */
export function validateQueueDrivers(
  entries: readonly QueueEntry[],
  drivers: Record<string, QueueDriver>,
  where: string,
  validated: ReadonlySet<QueueDriver['validate']>,
): void {
  const byDriver = new Map<string, QueueEntry[]>();
  for (const entry of entries) {
    const name = entry.section.driver;
    if (!Object.hasOwn(drivers, name)) {
      throw needsDriver(entry.name, where, Object.keys(drivers));
    }
    const group = byDriver.get(name);
    if (group) {
      group.push(entry);
    } else {
      byDriver.set(name, [entry]);
    }
  }
  for (const [name, group] of byDriver) {
    const driver = drivers[name];
    if (
      typeof driver.validate === 'function' &&
      !validated.has(driver.validate)
    ) {
      driver.validate(group, { where });
    }
  }
}
