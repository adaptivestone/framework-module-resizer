// The defaults a framework host's config files spread, exported from …/framework.js. Plain data:
// nothing here reads the framework.
import defaultResizeConfig from '../config/resize.ts';
import type { FrameworkWorkerConfig, ResizeConfig } from '../types.d.ts';

/** The worker command's settings (`worker` in src/config/resize.ts) when the file has none. */
export const defaultWorkerOptions: FrameworkWorkerConfig = {
  enabled: false,
  sharpConcurrency: 1,
  sharpCache: false,
};

/**
 * What every Resizer's config file spreads: the image settings only, a copy of the core defaults.
 * It carries no `worker` or `coordination` section, so any Resizer's file can spread it; a missing
 * `coordination` means `defaultCoordination` and a missing `worker` means `defaultWorkerOptions`.
 * The file adds `mediaModelName`, `storage` and (for background generation) `queue`.
 */
export const defaultFrameworkResizeConfig: ResizeConfig = {
  ...defaultResizeConfig,
};
