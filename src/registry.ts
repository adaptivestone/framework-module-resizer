// The process registry: constructed items by name, one per name. Entry points look Resizers up
// here; the services receive their ports, never a Resizer. Generic, so it needs nothing from the
// Resizer: resizer.ts keeps the one instance and the typed lookups hosts use. It also keeps the
// parts several items share in one process (e.g. one task queue per backend), so a reset forgets
// them together with the items that use them.
import { ResizeSetupError } from './errors.ts';

export class Registry<T extends { readonly name: string }> {
  readonly #items = new Map<string, T>();
  // The shared parts by key, each a build in progress or done. The value type is the caller's:
  // one key always holds what its one builder returns.
  readonly #shared = new Map<string, Promise<unknown>>();

  /** Add `item` under its name; a name already taken throws RESIZE_DUPLICATE_RESIZER. */
  register(item: T): void {
    const { name } = item;
    if (this.#items.has(name)) {
      throw new ResizeSetupError(
        `resize: a Resizer named '${name}' already exists in this process — construct each name once and use getResizer('${name}') elsewhere`,
        { code: 'RESIZE_DUPLICATE_RESIZER' },
      );
    }
    this.#items.set(name, item);
  }

  /** The item registered under `name`; a missing one throws RESIZE_NO_RESIZER. */
  get(name = 'default'): T {
    const item = this.#items.get(name);
    if (!item) {
      throw new ResizeSetupError(
        `resize: no Resizer named '${name}' — construct it in bootstrap code that runs in every process that uses it`,
        { code: 'RESIZE_NO_RESIZER' },
      );
    }
    return item;
  }

  /** Every registered item, in registration order. */
  list(): T[] {
    return [...this.#items.values()];
  }

  /**
   * The part shared under `key`: `build` runs on the first call, and every call until reset()
   * gets the same promise. A build that rejects is forgotten, so the next call builds again.
   */
  shared<V>(key: string, build: () => Promise<V>): Promise<V> {
    const existing = this.#shared.get(key);
    if (existing) {
      return existing as Promise<V>;
    }
    const building = build();
    this.#shared.set(key, building);
    building.catch(() => {
      if (this.#shared.get(key) === building) {
        this.#shared.delete(key);
      }
    });
    return building;
  }

  /** Forget every item and every shared part. */
  reset(): void {
    this.#items.clear();
    this.#shared.clear();
  }
}
