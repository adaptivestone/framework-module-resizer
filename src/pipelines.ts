// A Resizer's named pipelines, fixed at construction. `default` always exists: unregistered, it
// has no steps.
import type { Pipeline } from './contracts/pipeline.ts';

// Unknown pipeline name → the shared, frozen empty pipeline (no steps). One frozen
// constant avoids per-call allocation + accidental mutation of a "default".
const EMPTY_PIPELINE: Pipeline = Object.freeze({});

export class PipelineRegistry {
  readonly #pipelines: Map<string, Pipeline>;

  constructor(pipelines?: Record<string, Pipeline>) {
    this.#pipelines = new Map(Object.entries(pipelines ?? {}));
  }

  /** Look up a pipeline; an unknown name → the shared frozen empty pipeline (no steps). */
  get(name: string): Pipeline {
    return this.#pipelines.get(name) ?? EMPTY_PIPELINE;
  }

  /** True when `name` is registered. `default` always exists: unregistered, it has no steps. */
  has(name: string): boolean {
    return name === 'default' || this.#pipelines.has(name);
  }
}
