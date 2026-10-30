// The built-in 'database' queue driver: its names wait in the task queue of the config's database
// (the `database` section's driver builds it, e.g. MongoTaskQueue on the package's ResizeTask
// model). Every 'database' entry is one backend, so it has no `backendOf`: one task queue serves
// all of them, each name with its own timing.
import type { QueueDriver } from '../contracts/drivers.ts';
import { ResizeConfigError } from '../errors.ts';
import type { DatabaseQueueConfig } from '../types.d.ts';

const invalid = (message: string): ResizeConfigError =>
  new ResizeConfigError(`resize config: ${message}`, {
    code: 'RESIZE_CONFIG_INVALID',
  });

export const databaseQueueDriver: QueueDriver<DatabaseQueueConfig> = {
  fromConfig(entries, ctx) {
    const first = `\`queues.${entries[0]?.name}\` in ${ctx.where} uses driver 'database'`;
    if (!ctx.database) {
      throw invalid(`${first}, which needs a \`database\` section`);
    }
    if (typeof ctx.database.taskQueue !== 'function') {
      throw invalid(
        `${first}, but the \`database\` section's driver builds no task queue`,
      );
    }
    const timing = new Map(entries.map((entry) => [entry.name, entry.timing]));
    return ctx.database.taskQueue({
      queues: entries.map((entry) => entry.name),
      getTiming: (queue) => timing.get(queue),
      logger: ctx.logger,
    });
  },
};
