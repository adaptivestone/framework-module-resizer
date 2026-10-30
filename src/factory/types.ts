// The config a Resizer is built from: its image settings, which merge over the package defaults
// key by key, and its sections, each read through the driver registered under its `driver` name.
import type { DriverRegistry } from '../contracts/drivers.ts';
import type { DeepPartial, ResizeConfig, ResizerSections } from '../types.d.ts';

/**
 * A Resizer's config: any image setting (missing ones take the package defaults; arrays and
 * `encode.formats` replace as a whole) and its sections. `D` is the registry of the host's own
 * drivers: each adds its `storage`, `database` and `queues` sections to the built-in ones.
 */
// biome-ignore lint/complexity/noBannedTypes: `{}` is the empty registry, the default when a host registers no driver
export type ResizerConfig<D extends DriverRegistry = {}> =
  DeepPartial<ResizeConfig> & ResizerSections<D>;
