import defaultResizeConfig, {
  defaultFrameworkResizeConfig,
} from '../config/resize.ts';
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

/** Test-only: a framework config file (framework defaults + mediaModelName 'File') with overrides. */
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
