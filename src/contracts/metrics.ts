// Metrics contract: where a Resizer reports what it did — reads, uploads, rendered variants, task
// outcomes and the worker's waits. Each event is one call: `timing` for an event with a duration,
// `count` otherwise. Labels are the few low-cardinality values a metrics backend can group by
// (the Resizer, the pipeline, the outcome, an error code); context carries the per-event details
// (media and task ids, identities) that belong in logs, never in labels. The module never awaits
// `count` or `timing`, and it catches what they throw or reject, so a slow or broken backend cannot
// hold up or break a read. Extend this class (or pass any object of the same shape — the core never
// checks `instanceof`, so duplicate package copies still work). A class written with three
// parameters per method still conforms.

/** Low-cardinality values a backend may group by. */
export type MetricLabels = Readonly<Record<string, string>>;

/** Per-event details for logs (ids, identities, counts); never use them as labels. */
export type MetricContext = Readonly<Record<string, string | number>>;

export abstract class ResizeMetrics {
  /** Add `value` to the counter `name`. May be async; the module does not wait for it. */
  abstract count(
    name: string,
    value: number,
    labels?: MetricLabels,
    context?: MetricContext,
  ): void | Promise<void>;

  /** Record that the event `name` took `ms`. May be async; the module does not wait for it. */
  abstract timing(
    name: string,
    ms: number,
    labels?: MetricLabels,
    context?: MetricContext,
  ): void | Promise<void>;

  /** Optional: write what is pending now (LogMetrics: its summary of the current window). */
  flush?(): void | Promise<void>;
}
