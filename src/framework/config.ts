// Loads a Resizer's config from the framework app. Each Resizer may read its own config file
// (`configName`, default 'resize'); the framework has already merged resize.<NODE_ENV>.ts over it.
import { ResizeConfigError } from '../errors.ts';
import { validateResizeConfig } from '../resizeConfig.ts';
import type { FrameworkResizeConfig } from '../types.d.ts';
import { getApp } from './app.ts';

/** The app's validated config file `configName`, including the framework-only mediaModelName. */
export function getResizeConfig(configName = 'resize'): FrameworkResizeConfig {
  const config = validateResizeConfig(
    getApp().getConfig(configName),
  ) as FrameworkResizeConfig;
  if (
    typeof config.mediaModelName !== 'string' ||
    config.mediaModelName.trim().length === 0
  ) {
    throw new ResizeConfigError(
      `resize config: \`mediaModelName\` is required — set it in the host src/config/${configName}.ts`,
      { code: 'RESIZE_CONFIG_MEDIA_MODEL_MISSING' },
    );
  }
  return config;
}
