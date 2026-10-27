// The process registry: constructed items by name, one per name. Entry points look them up here;
// core code always receives its Resizer as an argument. Generic, so it needs nothing from the
// Resizer: resizer.ts keeps the one instance and the typed lookups hosts use.
import { ResizeSetupError } from './errors.ts';

export class Registry<T extends { readonly name: string }> {
  readonly #items = new Map<string, T>();
  // Run by reset(): each clears per-process state kept beside the registry (e.g. the framework
  // adapter's shared task queues).
  readonly #resetHooks = new Set<() => void>();

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

  /** Forget every item, then run every onReset hook. */
  reset(): void {
    this.#items.clear();
    for (const reset of this.#resetHooks) {
      reset();
    }
  }

  /** Run `hook` on every reset(). */
  onReset(hook: () => void): void {
    this.#resetHooks.add(hook);
  }
}
