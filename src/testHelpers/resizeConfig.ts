import defaultResizeConfig from '../config/resize.ts';
import { defaultFrameworkResizeConfig } from '../framework/defaults.ts';
import type {
  DeepPartial,
  FrameworkResizeConfig,
  ResizeConfig,
} from '../types.d.ts';

function merge(base: unknown, override: unknown): unknown {
  if (Array.isArray(override)) {
    return [...override];
  }
  if (
    override &&
    typeof override === 'object' &&
    !Array.isArray(override) &&
    base &&
    typeof base === 'object' &&
    !Array.isArray(base)
  ) {
    const result = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(override)) {
      result[key] = merge(result[key], value);
    }
    return result;
  }
  return override === undefined ? base : override;
}

/**
 * Test-only: a Resizer's framework config file (the framework defaults and mediaModelName 'File')
 * with overrides. It holds no process-wide section, so any Resizer's file can be one; a test that
 * stands for src/config/resize.ts adds `queues`, `worker` or `coordination` through `override`.
 */
export function makeResizeConfig(
  override: DeepPartial<FrameworkResizeConfig> = {},
): FrameworkResizeConfig & ResizeConfig {
  // Each test gets independent nested defaults; production config merging remains the
  // framework's responsibility.
  const base = structuredClone({
    ...defaultFrameworkResizeConfig,
    mediaModelName: 'File',
  });
  return merge(base, override) as FrameworkResizeConfig & ResizeConfig;
}

/** Test-only: a core image config (what `new Resizer({ config })` takes) with overrides. */
export function makeImageConfig(
  override: DeepPartial<ResizeConfig> = {},
): ResizeConfig {
  return merge(structuredClone(defaultResizeConfig), override) as ResizeConfig;
}
