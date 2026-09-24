import defaultResizeConfig from '../config/resize.ts';
import type { DeepPartial, ResizeConfig } from '../types.d.ts';

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

export function makeResizeConfig(
  override: DeepPartial<ResizeConfig> = {},
): ResizeConfig {
  // Test-only overrides. Each test gets independent nested defaults; production
  // config merging remains the framework's responsibility.
  const base = structuredClone({
    ...defaultResizeConfig,
    mediaModelName: 'File',
  });
  return merge(base, override) as ResizeConfig;
}
