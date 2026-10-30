// The metrics sinks the package ships, and the guard every Resizer puts in front of its sink.
// - LogMetrics (the default) writes metrics as log lines: the request-path events (reads, uploads,
//   stored variants, the worker's waits) are summed into one `info` line per Resizer per window, so
//   a busy API does not log a line per read; a task outcome and a failed variant are rare and worth
//   reading on their own, so each is one `info` line at once. With `debug: true` every call is also
//   one `debug` line.
// - NoopMetrics records nothing.
// - boundMetrics (internal) is what the services call: it labels every call with its Resizer,
//   keeps the `pipeline` and `code` labels to a bounded set of values (the raw value moves to the
//   context), and never lets the host's sink throw or reject into a read or a task.
import {
  type MetricContext,
  type MetricLabels,
  ResizeMetrics,
} from './contracts/metrics.ts';
import { RESIZE_ERROR_CODES } from './errorCodes.ts';
import { ResizeError, ResizeSetupError } from './errors.ts';
import { logNeverThrow } from './helpers/log.ts';
import type { ResizeLogger } from './types.d.ts';

export interface LogMetricsOptions {
  summaryIntervalMs?: number; // how long one summary window lasts; default 60000
  debug?: boolean; // also write one debug line per call; default false
}

const DEFAULT_SUMMARY_INTERVAL_MS = 60_000;

// The read outcomes in the order the summary lists them; an outcome not listed here follows them.
const READ_OUTCOMES = [
  'ready',
  'enqueued',
  'in-flight',
  'suppressed',
  'eager-only',
  'no-original',
  'unknown-pipeline',
  'failed',
];

// The variant outcomes that are summed; `failed` gets a line of its own.
const SUMMED_VARIANT_OUTCOMES = new Set(['stored', 'duplicate', 'rendered']);

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === 'object' || typeof value === 'function') &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function';

/**
 * The `code` label of a failure, to spread into a call's labels: the raw code of a module error
 * (told by its brand, so a duplicate copy of the package counts too), and no label for anything
 * else. The code is passed raw: the bound sink keeps the label to the module's own codes and moves
 * any other code to the context.
 */
export function errorCodeLabel(err: unknown): { code?: string } {
  return ResizeError.isResizeError(err) ? { code: err.code } : {};
}

/** True when `value` has the count() and timing() functions of a metrics sink. */
export function isMetrics(value: unknown): value is ResizeMetrics {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { count?: unknown }).count === 'function' &&
    typeof (value as { timing?: unknown }).timing === 'function'
  );
}

/** One Resizer's counts in the current summary window. */
class Tally {
  readonly reads = new Map<string, number>();
  stale = 0;
  uploadsStored = 0;
  uploadsRejected = 0;
  uploadBytes = 0;
  variants = 0;
  variantBytes = 0;
  claims = 0;
  claimWaitMs = 0;

  /** The sections that have something in them, in their fixed order. */
  sections(): string[] {
    const sections: string[] = [];
    const reads = [
      ...READ_OUTCOMES.filter((outcome) => this.reads.has(outcome)),
      ...[...this.reads.keys()].filter(
        (outcome) => !READ_OUTCOMES.includes(outcome),
      ),
    ]
      .map((outcome) => [outcome, this.reads.get(outcome) ?? 0] as const)
      .filter(([, n]) => n !== 0);
    if (reads.length > 0) {
      const total = reads.reduce((sum, [, n]) => sum + n, 0);
      const parts = reads.map(([outcome, n]) => `${outcome} ${n}`);
      sections.push(`reads ${total} (${parts.join(', ')})`);
    }
    if (this.stale !== 0) {
      // Found, not served: a stale cell whose publicUrl threw is counted too.
      sections.push(`stale previews found ${this.stale}`);
    }
    const uploads = this.uploadsStored + this.uploadsRejected;
    if (uploads !== 0 || this.uploadBytes !== 0) {
      const rejected = `rejected ${this.uploadsRejected}`;
      const detail =
        this.uploadsStored === 0 && this.uploadBytes === 0
          ? rejected
          : `${this.uploadBytes} bytes${this.uploadsRejected === 0 ? '' : `, ${rejected}`}`;
      sections.push(`uploads ${uploads} (${detail})`);
    }
    if (this.variants !== 0 || this.variantBytes !== 0) {
      sections.push(`variants ${this.variants} (${this.variantBytes} bytes)`);
    }
    if (this.claims !== 0) {
      const wait = Math.round(this.claimWaitMs / this.claims);
      sections.push(`claims ${this.claims} (average wait ${wait} ms)`);
    }
    return sections;
  }
}

/** A value of a written line; a missing one prints as `?`. */
const show = (value: string | number | undefined): string =>
  value === undefined ? '?' : String(value);

/**
 * The `, code <code>` part of a written line: the raw code from the context when the label was
 * reduced to 'other', else the label; nothing without a code label.
 */
function codePart(
  labels: MetricLabels | undefined,
  context: MetricContext | undefined,
): string {
  const code = labels?.code;
  if (code === undefined) {
    return '';
  }
  return `, code ${code === 'other' ? show(context?.code ?? code) : code}`;
}

function taskLine(
  ms: number,
  labels: MetricLabels | undefined,
  context: MetricContext | undefined,
): string {
  return `resize: task ${show(context?.taskId)} of media ${show(context?.mediaId)} ${show(labels?.outcome)} in ${Math.round(ms)} ms (Resizer '${show(labels?.resizer)}', queue '${show(labels?.queue)}', pipeline '${show(labels?.pipeline)}', attempt ${show(context?.attempts)}, variants ${show(context?.variants)}${codePart(labels, context)})`;
}

function failedVariantLine(
  ms: number,
  labels: MetricLabels | undefined,
  context: MetricContext | undefined,
): string {
  return `resize: variant ${show(context?.identity)} of media ${show(context?.mediaId)} failed in ${Math.round(ms)} ms (Resizer '${show(labels?.resizer)}', pipeline '${show(labels?.pipeline)}', format '${show(labels?.format)}'${codePart(labels, context)})`;
}

/**
 * Metrics as log lines, on the Resizer's logger by default. Request-path events are summed per
 * Resizer (the `resizer` label) into one `info` line per window of `summaryIntervalMs`; the
 * window opens with the first such event and closes when it is written, so no timer runs while
 * nothing happens, and the timer never keeps a process alive. A task outcome and a failed variant
 * are written at once. `flush()` writes the open window now.
 */
export class LogMetrics extends ResizeMetrics {
  readonly #logger: ResizeLogger;
  readonly #intervalMs: number;
  readonly #debug: boolean;
  // The open window: when it started, its timer (none: no window is open), and the counts of each
  // `resizer` label in first-seen order (undefined: calls without one).
  #windowStart = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #tallies = new Map<string | undefined, Tally>();

  constructor(logger: ResizeLogger, opts: LogMetricsOptions = {}) {
    super();
    // Only a missing value takes the default: an explicit null is checked like any other value.
    const intervalMs =
      opts.summaryIntervalMs === undefined
        ? DEFAULT_SUMMARY_INTERVAL_MS
        : opts.summaryIntervalMs;
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new ResizeSetupError(
        'resize: LogMetrics `summaryIntervalMs` must be a positive safe integer (ms)',
        { code: 'RESIZE_METRICS_INVALID', retryable: false },
      );
    }
    this.#logger = logger;
    this.#intervalMs = intervalMs;
    this.#debug = opts.debug === true;
  }

  count(
    name: string,
    value: number,
    labels?: MetricLabels,
    context?: MetricContext,
  ): void {
    this.#debugLine(name, value, labels, context);
    switch (name) {
      case 'resize.read': {
        const tally = this.#tally(labels);
        const outcome = show(labels?.outcome);
        tally.reads.set(outcome, (tally.reads.get(outcome) ?? 0) + value);
        return;
      }
      case 'resize.preview.stale':
        this.#tally(labels).stale += value;
        return;
      case 'resize.upload.bytes':
        this.#tally(labels).uploadBytes += value;
        return;
      case 'resize.variant.bytes':
        this.#tally(labels).variantBytes += value;
        return;
    }
  }

  timing(
    name: string,
    ms: number,
    labels?: MetricLabels,
    context?: MetricContext,
  ): void {
    this.#debugLine(name, ms, labels, context);
    switch (name) {
      case 'resize.task':
        this.#write(taskLine(ms, labels, context));
        return;
      case 'resize.variant':
        if (labels?.outcome === 'failed') {
          this.#write(failedVariantLine(ms, labels, context));
        } else if (SUMMED_VARIANT_OUTCOMES.has(labels?.outcome ?? '')) {
          this.#tally(labels).variants += 1;
        }
        return;
      case 'resize.upload':
        if (labels?.outcome === 'stored') {
          this.#tally(labels).uploadsStored += 1;
        } else if (labels?.outcome === 'rejected') {
          this.#tally(labels).uploadsRejected += 1;
        }
        return;
      case 'resize.claim': {
        const tally = this.#tally(labels);
        tally.claims += 1;
        tally.claimWaitMs += ms;
        return;
      }
    }
  }

  /** Write the open window's summary now, one line per Resizer that has counts, and close it. */
  flush(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const seconds = Math.max(
      1,
      Math.round((Date.now() - this.#windowStart) / 1000),
    );
    const tallies = [...this.#tallies];
    this.#tallies.clear();
    for (const [resizer, tally] of tallies) {
      const sections = tally.sections();
      if (sections.length > 0) {
        const who = resizer === undefined ? '' : `Resizer '${resizer}' `;
        this.#write(`resize: ${who}over ${seconds} s: ${sections.join(', ')}`);
      }
    }
  }

  /** The counts of the call's Resizer in the window, opening the window when none is open. */
  #tally(labels: MetricLabels | undefined): Tally {
    if (this.#timer === undefined) {
      this.#windowStart = Date.now();
      this.#timer = setTimeout(() => this.flush(), this.#intervalMs);
      // A window must not keep a process alive that has nothing else to do.
      this.#timer.unref?.();
    }
    const resizer = labels?.resizer;
    let tally = this.#tallies.get(resizer);
    if (!tally) {
      tally = new Tally();
      this.#tallies.set(resizer, tally);
    }
    return tally;
  }

  #write(line: string): void {
    logNeverThrow(this.#logger, line, undefined, 'info');
  }

  #debugLine(
    name: string,
    value: number,
    labels: MetricLabels | undefined,
    context: MetricContext | undefined,
  ): void {
    if (!this.#debug || typeof this.#logger.debug !== 'function') {
      return;
    }
    try {
      this.#logger.debug(
        `resize metric ${name} ${value} ${JSON.stringify(labels ?? {})} ${JSON.stringify(context ?? {})}`,
      );
    } catch {
      // A debug line is optional; a logger that cannot write it loses only that line.
    }
  }
}

/** A sink that records nothing (metrics turned off). */
export class NoopMetrics extends ResizeMetrics {
  count(
    _name?: string,
    _value?: number,
    _labels?: MetricLabels,
    _context?: MetricContext,
  ): void {}

  timing(
    _name?: string,
    _ms?: number,
    _labels?: MetricLabels,
    _context?: MetricContext,
  ): void {}
}

type SinkMethod = 'count' | 'timing' | 'flush';

/** The host's sink behind the guard of boundMetrics(). */
class BoundMetrics extends ResizeMetrics {
  readonly #sink: ResizeMetrics;
  readonly #resizer: string;
  readonly #logger: ResizeLogger;
  readonly #pipelineLabel: ((name: string) => string) | undefined;
  // The methods whose first failure was logged.
  readonly #failed = new Set<SinkMethod>();

  constructor(
    sink: ResizeMetrics,
    opts: {
      resizer: string;
      logger: ResizeLogger;
      pipelineLabel?: (name: string) => string;
    },
  ) {
    super();
    this.#sink = sink;
    this.#resizer = opts.resizer;
    this.#logger = opts.logger;
    this.#pipelineLabel = opts.pipelineLabel;
  }

  count(
    name: string,
    value: number,
    labels?: MetricLabels,
    context?: MetricContext,
  ): void {
    this.#send('count', name, value, labels, context);
  }

  timing(
    name: string,
    ms: number,
    labels?: MetricLabels,
    context?: MetricContext,
  ): void {
    this.#send('timing', name, ms, labels, context);
  }

  /** The sink's flush(), when it has one; resolves once it settles, and never rejects. */
  async flush(): Promise<void> {
    const onFailure = (err: unknown) => this.#failure('flush', 'flush', err);
    try {
      const result = this.#sink.flush?.();
      if (isThenable(result)) {
        await Promise.resolve(result).then(undefined, onFailure);
      }
    } catch (err) {
      onFailure(err);
    }
  }

  #send(
    method: 'count' | 'timing',
    name: string,
    value: number,
    labels: MetricLabels | undefined,
    context: MetricContext | undefined,
  ): void {
    const onFailure = (err: unknown) => this.#failure(method, name, err);
    try {
      const [boundLabels, boundContext] = this.#normalize(labels, context);
      const result = this.#sink[method](name, value, boundLabels, boundContext);
      // Never awaited: a slow sink must not hold up a read or a task, and a rejection is caught.
      if (isThenable(result)) {
        result.then(undefined, onFailure);
      }
    } catch (err) {
      onFailure(err);
    }
  }

  /**
   * The labels with `resizer` first, a pipeline the Resizer does not have as its label for
   * unregistered ones, and a code the module does not raise as 'other': a host's names and codes
   * are unbounded, and a metrics backend keeps one series per label value. A raw value that was
   * rewritten moves to the context, where logs still show it.
   */
  #normalize(
    labels: MetricLabels | undefined,
    context: MetricContext | undefined,
  ): [MetricLabels, MetricContext | undefined] {
    const bound: Record<string, string> = { resizer: this.#resizer };
    let moved: Record<string, string> | undefined;
    for (const [key, value] of Object.entries(labels ?? {})) {
      if (key === 'resizer') {
        continue;
      }
      let label = value;
      if (key === 'pipeline' && this.#pipelineLabel) {
        label = this.#pipelineLabel(value);
      } else if (key === 'code' && !RESIZE_ERROR_CODES.has(value)) {
        label = 'other';
      }
      if (label !== value) {
        moved ??= {};
        moved[key] = value;
      }
      bound[key] = label;
    }
    return [bound, moved ? { ...context, ...moved } : context];
  }

  #failure(method: SinkMethod, name: string, err: unknown): void {
    if (this.#failed.has(method)) {
      return;
    }
    this.#failed.add(method);
    logNeverThrow(
      this.#logger,
      `resize: the metrics sink of Resizer '${this.#resizer}' failed on '${name}' — further failures of ${method}() are not logged`,
      err,
    );
  }
}

/**
 * The sink a Resizer's services call: `metrics` labelled with the Resizer, with the pipeline and
 * code labels bounded, that never throws and never lets a rejection escape. Its flush() calls the
 * sink's flush() when there is one and resolves when that settles. Internal: the main entry does
 * not export it.
 */
export function boundMetrics(
  metrics: ResizeMetrics,
  opts: {
    resizer: string;
    logger: ResizeLogger;
    pipelineLabel?: (name: string) => string;
  },
): ResizeMetrics & { flush(): Promise<void> } {
  return new BoundMetrics(metrics, opts);
}
