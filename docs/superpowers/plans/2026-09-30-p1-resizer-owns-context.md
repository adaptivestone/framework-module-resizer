# P1 — The Resizer Owns Its Context: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow several named Resizers in one process, each with its own config, logger and media model, by making core code read its context from the Resizer instance instead of from process-wide globals.

**Architecture:** `Resizer` gains `name`, `config`, `logger` and an event bus. Framework defaults are filled in only when an option is omitted. A module-level `Map` replaces the single-instance slot. Core modules (`engine`, `enqueue`, `original`, `resizeTask`) stop importing `getApp`, `getResizeConfig` and `getResizer` and read everything from the `resizer` argument they already receive. Entry points (`worker.ts`, the Resizer constructor's defaults) and the framework drivers keep their framework access until phase 4.

**Tech Stack:** Node ≥ 24, TypeScript 7 (`erasableSyntaxOnly`, ESM, `.ts` import specifiers), `node:test`, Biome, sharp.

**Spec:** [`docs/design/2026-09-30-multi-resizer.md`](../../design/2026-09-30-multi-resizer.md) — decisions D1, D2, and the P1 row of §6.

## Global Constraints

- The module is pre-release: breaking API changes are allowed and ship without data migrations.
- Every task must finish with `npm run types:check`, `npm run check`, `npm run build`, `npm test` and `npm run smoke` all passing (`npm test` needs a build first for one integration test).
- No new runtime dependencies.
- No test-only code paths in shipped modules. The only allowed test hook is `resetResizerForTests()`.
- Classes for shipped drivers; contracts stay interfaces.
- New comments state the reason in plain words. Do not add references to archived spec sections (`05 · §10.4` style).
- This repository is public: never name private host projects in code, docs or commit messages.
- Commit messages: conventional prefix (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`), no `Co-Authored-By` trailer, no AI attribution.
- Out of scope for P1: transports (`transports/mongo.ts`, `transports/sqs.ts`), `locks/framework.ts`, the task envelope, the preview identity. Those belong to P2–P4.
- Public API changes are documented in the same phase: module `README.md`, `AGENTS.md`, `CHANGELOG.md`, and the framework docs site page `docs/12-resize.md` in `adaptivestone/framework-documenation` (local checkout next to this repo: `../framework-documenation-github`).

## Review Focus

1. A host constructs only a named Resizer (for example `'listings'`), then something calls `getResizer()` or starts the worker → a `ResizeSetupError` with code `RESIZE_NO_RESIZER` that names `'default'`, before any task is leased. (Tests: Task 2.)
2. Resizer B's `resolve()` must never use Resizer A's formats or write to A's logger. (Test: Task 4.)
3. A host gives a named Resizer a transport. Its tasks would not record their Resizer, so the worker would process them with the default Resizer's storage and config. Expected: construction throws `RESIZE_NAMED_TRANSPORT_UNSUPPORTED` until P2 lifts the restriction. (Test: Task 2.)
4. A framework-free construction (explicit `config`, `logger` and drivers, no framework app installed) must not touch the framework app. (Test: Task 2.)
5. Two Resizers with different `mediaModelName` values must load media from their own models, not from the app config's model. (Test: Task 3.)

---

## File Structure

| File | Change | Responsibility after P1 |
|---|---|---|
| `src/types.d.ts` | Modify | Adds `ResizeLogger`, `ResizeEventBus`; `TMinimalResizeApp` uses them. |
| `src/resizeConfig.ts` | Modify | `validateResizeConfig(config)` (pure) plus `getResizeConfig()` for framework drivers. |
| `src/resizer.ts` | Modify | `Resizer` with `name`/`config`/`logger`/events; named registry; `getResizer(name)`. |
| `src/mediaStore/framework.ts` | Modify | `FrameworkMediaStore({ modelName? })`. |
| `src/engine.ts`, `src/enqueue.ts`, `src/original.ts` | Modify | Read `resizer.config` / `resizer.logger`. |
| `src/resizeTask.ts` | Modify | `processTaskWith(resizer, task, opts)`; generation reads `resizer.config` / `resizer.logger`. |
| `src/worker.ts` | Modify | `processTask(task, opts)` entry wrapper (looks up the default Resizer). |
| `src/index.ts` | Modify | `processTask` exported from `./worker.ts`. |
| `src/architecture.test.ts` | Create | Guard: core files import no process-wide lookups. |
| Tests | Modify | `config/resize.test.ts`, `resizer.test.ts`, `mediaStore/framework.test.ts`, `engine.test.ts`, `resizeTask.test.ts`. |
| `README.md`, `AGENTS.md`, `CHANGELOG.md` | Modify | Named Resizers replace "one per process". |
| `../framework-documenation-github/docs/12-resize.md` | Modify (docs repo, own PR) | The framework docs site page for this module. |

---

### Task 1: Pure config validation and logger types

**Files:**
- Modify: `src/types.d.ts` (the `TMinimalResizeApp` block)
- Modify: `src/resizeConfig.ts` (the end of the file, from the `validatedConfigs` comment)
- Test: `src/config/resize.test.ts`

**Interfaces:**
- Produces: `validateResizeConfig(config: unknown): ResizeConfig` (pure; throws `ResizeConfigError`; caches validated objects), `getResizeConfig(): ResizeConfig` (unchanged behavior), types `ResizeLogger`, `ResizeEventBus`.

- [ ] **Step 1: Write the failing test** — add inside `describe('getResizeConfig', …)` in `src/config/resize.test.ts`, and add `validateResizeConfig` to the existing `import { getResizeConfig } from '../resizeConfig.ts';` line:

```ts
  test('validateResizeConfig checks a config without a framework app', () => {
    resetAppInstance();
    const config = makeResizeConfig({ formats: ['webp'] });
    assert.strictEqual(validateResizeConfig(config), config);
    assert.throws(
      () => validateResizeConfig({ ...config, formats: [] }),
      (err: unknown) =>
        err instanceof ResizeConfigError &&
        err.code === 'RESIZE_CONFIG_FORMATS_INVALID',
    );
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --experimental-strip-types --test src/config/resize.test.ts`
Expected: FAIL — `does not provide an export named 'validateResizeConfig'`.

- [ ] **Step 3: Add the types** — in `src/types.d.ts`, add above `TMinimalResizeApp` and use them inside it:

```ts
export interface ResizeLogger {
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
}

export interface ResizeEventBus {
  emit(name: string, ...args: unknown[]): void;
}
```

In `TMinimalResizeApp`, replace the inline `logger: { … }` object type with `logger: ResizeLogger;` and `events?: { emit(…): void };` with `events?: ResizeEventBus;`.

- [ ] **Step 4: Split validation from the framework read** — in `src/resizeConfig.ts`, replace everything from the `validatedConfigs` comment to the end of the file with:

```ts
// The framework returns the same cached object on every getConfig call, and a Resizer keeps
// its config object, so each object is validated once.
const validatedConfigs = new WeakSet<object>();

/** Validate a complete resize config. Pure: reads no framework state. */
export function validateResizeConfig(config: unknown): ResizeConfig {
  if (isRecord(config) && validatedConfigs.has(config)) {
    return config as unknown as ResizeConfig;
  }
  validateRequiredResizeConfigFields(config);
  validatedConfigs.add(config);
  return config;
}

/** The framework app's validated `resize` config — for the framework drivers only. */
export function getResizeConfig(): ResizeConfig {
  return validateResizeConfig(getApp().getConfig('resize'));
}
```

- [ ] **Step 5: Run the test file and the type check**

Run: `node --experimental-strip-types --test src/config/resize.test.ts && npm run types:check`
Expected: all tests PASS; `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/types.d.ts src/resizeConfig.ts src/config/resize.test.ts
git commit -m "refactor: validate resize config without reading the framework app"
```

---

### Task 2: The Resizer owns name, config, logger and events; named registry

**Files:**
- Modify: `src/resizer.ts` (header comment, imports, `ResizerOptions`, the `activeResizer` slot, `Resizer` fields/constructor/`runWaterfall`/`runObservers`, `getResizer`, `resetResizerForTests`)
- Test: `src/resizer.test.ts` (replace the `describe('Resizer one-per-process slot', …)` block)
- Test: `src/resizeTask.test.ts` (one worker test)

**Interfaces:**
- Consumes: `validateResizeConfig`, `ResizeLogger`, `ResizeEventBus` (Task 1).
- Produces:
  - `ResizerOptions` gains `name?: string`, `config?: ResizeConfig`, `logger?: ResizeLogger`, `events?: ResizeEventBus`.
  - `Resizer` gains `readonly name: string`, `readonly config: ResizeConfig`, `readonly logger: ResizeLogger`.
  - `getResizer(name?: string): Resizer` (default `'default'`).
  - Error codes: `RESIZE_DUPLICATE_RESIZER` (same name twice), `RESIZE_NO_RESIZER` (unknown name), `RESIZE_NAME_INVALID` (empty name), `RESIZE_NAMED_TRANSPORT_UNSUPPORTED` (a named Resizer with a transport; removed in P2).

- [ ] **Step 1: Write the failing tests** — in `src/resizer.test.ts`, add `import { ResizeConfigError, ResizeSetupError } from './errors.ts';` and replace the whole `describe('Resizer one-per-process slot', …)` block (and its section comment) with:

```ts
// ---------------------------------------------------------------------------
// Named registry: several Resizers per process, one per name
// ---------------------------------------------------------------------------

describe('Resizer registry', () => {
  test('a second Resizer with the same name throws a clear error', () => {
    new Resizer(baseOpts());
    assert.throws(
      () => new Resizer(baseOpts()),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_DUPLICATE_RESIZER' &&
        err.message.includes("'default'"),
    );
  });

  test('Resizers with different names coexist and are found by name', () => {
    const media = new Resizer(baseOpts());
    const listings = new Resizer({ ...baseOpts(), name: 'listings' });
    assert.equal(getResizer(), media);
    assert.equal(getResizer('default'), media);
    assert.equal(getResizer('listings'), listings);
    assert.equal(media.name, 'default');
    assert.equal(listings.name, 'listings');
  });

  test('each Resizer keeps its own config', () => {
    const a = new Resizer({
      ...baseOpts(),
      config: makeResizeConfig({ formats: ['webp'] }),
    });
    const b = new Resizer({
      ...baseOpts(),
      name: 'b',
      config: makeResizeConfig({ formats: ['jpeg'] }),
    });
    assert.deepEqual(a.config.formats, ['webp']);
    assert.deepEqual(b.config.formats, ['jpeg']);
  });

  test('getResizer() names the missing Resizer', () => {
    new Resizer({ ...baseOpts(), name: 'listings' });
    assert.throws(
      () => getResizer(),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_NO_RESIZER' &&
        err.message.includes("'default'"),
    );
  });

  test('an invalid config throws at construction and does not claim the name', () => {
    assert.throws(
      () =>
        new Resizer({
          ...baseOpts(),
          config: { mediaModelName: 'File' } as never,
        }),
      (err: unknown) => err instanceof ResizeConfigError,
    );
    assert.doesNotThrow(() => new Resizer(baseOpts()));
  });

  test('only the default Resizer may have a transport until tasks record their Resizer', () => {
    assert.throws(
      () =>
        new Resizer({ ...baseOpts(), name: 'listings', transport: fakeTransport() }),
      (err: unknown) =>
        err instanceof ResizeSetupError &&
        err.code === 'RESIZE_NAMED_TRANSPORT_UNSUPPORTED',
    );
    assert.doesNotThrow(
      () => new Resizer({ ...baseOpts(), transport: fakeTransport() }),
    );
  });

  test('an empty name is rejected', () => {
    assert.throws(
      () => new Resizer({ ...baseOpts(), name: '' }),
      (err: unknown) =>
        err instanceof ResizeSetupError && err.code === 'RESIZE_NAME_INVALID',
    );
  });

  test('explicit config, logger and drivers need no framework app', () => {
    resetAppInstance();
    const r = new Resizer({
      storage: fakeStorage(),
      mediaStore: fakeMediaStore(),
      lockProvider: fakeLockProvider(),
      config: makeResizeConfig(),
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(r.name, 'default');
    assert.equal(getResizer(), r);
  });

  test('resetResizerForTests() forgets every Resizer', () => {
    const first = new Resizer(baseOpts());
    new Resizer({ ...baseOpts(), name: 'listings' });
    resetResizerForTests();
    const second = new Resizer(baseOpts());
    assert.notEqual(first, second);
    assert.equal(getResizer(), second);
    assert.throws(() => getResizer('listings'), /no Resizer named 'listings'/);
  });
});
```

In `src/resizeTask.test.ts`, add `ResizeSetupError` to the `./errors.ts` import and add this test inside `describe('runResizeWorker', …)`:

```ts
  test('a worker with no default Resizer fails before leasing', async () => {
    installApp({ worker: { enabled: true } });
    new Resizer({ name: 'listings', storage: makeStorage(redPng).storage });
    await assert.rejects(
      () => runResizeWorker(),
      (err: unknown) =>
        err instanceof ResizeSetupError && err.code === 'RESIZE_NO_RESIZER',
    );
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --experimental-strip-types --test src/resizer.test.ts src/resizeTask.test.ts`
Expected: FAIL — `name`/`config` are not Resizer options yet; the duplicate test sees the old message; `getResizer('listings')` ignores its argument.

- [ ] **Step 3: Implement the options and the registry** — in `src/resizer.ts`:

1. Replace the header comment's last two lines ("logger/events are read through getApp() at CALL time …") with:

```ts
// Each Resizer owns its config, logger and event bus. Framework defaults are read only for
// options the host omits, so a framework-free host never touches the framework app.
```

2. Replace `import { getResizeConfig } from './resizeConfig.ts';` with `import { validateResizeConfig } from './resizeConfig.ts';`, and add `ResizeConfig`, `ResizeEventBus`, `ResizeLogger` to the `import type { … } from './types.d.ts';` list.

3. Add to `ResizerOptions`, above `storage`:

```ts
  name?: string; // registry key; default 'default'
  config?: ResizeConfig; // default: the framework app's `resize` config
  logger?: ResizeLogger; // default: the framework app's logger
  events?: ResizeEventBus; // default: the framework app's event bus, when one exists
```

4. Replace the `activeResizer` comment and `let activeResizer: Resizer | undefined;` with:

```ts
// Constructed Resizers by name. Entry points (the worker, host code) look them up here;
// core code always receives its Resizer as an argument.
const resizers = new Map<string, Resizer>();

/** The framework event bus when a framework app exists; framework-free hosts have none. */
function frameworkEvents(): ResizeEventBus | undefined {
  try {
    return getApp().events;
  } catch {
    return undefined;
  }
}
```

5. Replace the class doc comment ("One Resizer per process. …") with:

```ts
/**
 * A named resize engine: config, drivers, pipelines and hooks. Most hosts construct one
 * (named 'default'); a host that needs different storage, media models or formats constructs
 * more, each under its own name. Drivers are fixed at construction.
 */
```

6. Add the fields above `readonly storage`:

```ts
  readonly name: string;
  readonly config: ResizeConfig;
  readonly logger: ResizeLogger;
  readonly #events: ResizeEventBus | undefined;
```

7. In the constructor, replace the block from the `// One-per-process ENFORCED` comment through `getResizeConfig();` with:

```ts
    const name = opts.name ?? 'default';
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new ResizeSetupError('resize: `name` must be a non-empty string', {
        code: 'RESIZE_NAME_INVALID',
      });
    }
    if (resizers.has(name)) {
      throw new ResizeSetupError(
        `resize: a Resizer named '${name}' already exists in this process — construct each name once and use getResizer('${name}') elsewhere`,
        { code: 'RESIZE_DUPLICATE_RESIZER' },
      );
    }
    // Queued tasks do not record their Resizer yet, so the worker runs every task with the
    // default Resizer. A named Resizer's tasks would use the wrong storage and config.
    if (name !== 'default' && opts.transport) {
      throw new ResizeSetupError(
        `resize: Resizer '${name}' cannot have a transport yet — its queued tasks would be processed by the default Resizer. Use generate() for '${name}', or queue through the default Resizer.`,
        { code: 'RESIZE_NAMED_TRANSPORT_UNSUPPORTED' },
      );
    }
    // Validate before registering, so a bad config never claims the name and a corrected
    // retry succeeds.
    this.config = validateResizeConfig(
      opts.config ?? getApp().getConfig('resize'),
    );
    this.logger = opts.logger ?? getApp().logger;
    this.#events = opts.events ?? frameworkEvents();
    this.name = name;
```

and replace the constructor's last line `activeResizer = this;` with `resizers.set(name, this);`.

8. In `runWaterfall`, delete `const app = getApp();` and change `app.logger.error(` to `this.logger.error(`.

9. In `runObservers`, delete `const app = getApp();`, change `app.events?.emit(` to `this.#events?.emit(`, and change both `app.logger.error(` calls to `this.logger.error(`.

10. Replace `getResizer` and `resetResizerForTests` with:

```ts
/** The Resizer registered under `name` (worker entry, host code, late taps). */
export function getResizer(name = 'default'): Resizer {
  const resizer = resizers.get(name);
  if (!resizer) {
    throw new ResizeSetupError(
      `resize: no Resizer named '${name}' — construct it in bootstrap code that runs in every process that uses it`,
      { code: 'RESIZE_NO_RESIZER' },
    );
  }
  return resizer;
}

/** TEST-ONLY: forget every constructed Resizer so a test can construct fresh ones. */
export function resetResizerForTests(): void {
  resizers.clear();
}
```

- [ ] **Step 4: Run the two test files**

Run: `node --experimental-strip-types --test src/resizer.test.ts src/resizeTask.test.ts`
Expected: PASS. If an older test in `resizer.test.ts` still asserts `/no Resizer constructed/` or `/only one Resizer per process/`, change it to `/no Resizer named 'default'/` or `/already exists in this process/`.

- [ ] **Step 5: Run the full suite**

Run: `npm run build && npm test`
Expected: all tests PASS. If a test constructs a Resizer before installing its fake app config, move its `installApp(…)`/`installFakeApp(…)` call above the construction: the Resizer now reads config once, at construction.

- [ ] **Step 6: Commit**

```bash
git add src/resizer.ts src/resizer.test.ts src/resizeTask.test.ts
git commit -m "feat: named Resizers with their own config, logger and events"
```

---

### Task 3: The default media store uses the Resizer's media model

**Files:**
- Modify: `src/mediaStore/framework.ts` (class head and `getMediaModel`)
- Modify: `src/resizer.ts` (the `mediaStore` default in the constructor)
- Test: `src/mediaStore/framework.test.ts`, `src/resizer.test.ts`

**Interfaces:**
- Consumes: `Resizer.config` (Task 2).
- Produces: `FrameworkMediaStoreOptions { modelName?: string }`; `new FrameworkMediaStore(opts?)`. Without `modelName` it falls back to the app config's `mediaModelName`.

- [ ] **Step 1: Write the failing tests** — in `src/mediaStore/framework.test.ts` (it already imports `resetAppInstance`, `setAppInstance` and `makeResizeConfig`), inside the `describe` that holds the "unknown model" test:

```ts
  test('an explicit modelName wins over the app config', async () => {
    const asked: string[] = [];
    resetAppInstance();
    setAppInstance({
      getConfig: () => makeResizeConfig({ mediaModelName: 'File' }),
      getModel: (name: string) => {
        asked.push(name);
        return { findById: async () => null };
      },
      logger: { info() {}, warn() {}, error() {} },
    } as never);
    await new FrameworkMediaStore({ modelName: 'Photo' }).load('m1');
    assert.deepEqual(asked, ['Photo']);
  });
```

In `src/resizer.test.ts` (it already imports `resetAppInstance`, `setAppInstance` and `makeResizeConfig`), inside `describe('Resizer constructor — driver wiring', …)`:

```ts
  test('the default media store loads from the Resizer’s own media model', async () => {
    const asked: string[] = [];
    resetAppInstance();
    setAppInstance({
      getConfig: () => makeResizeConfig(), // mediaModelName 'File'
      getModel: (name: string) => {
        asked.push(name);
        return { findById: async () => null };
      },
      logger: { info() {}, warn() {}, error() {} },
    } as never);
    const photos = new Resizer({
      ...baseOpts(),
      name: 'photos',
      config: makeResizeConfig({ mediaModelName: 'Photo' }),
    });
    const files = new Resizer(baseOpts());
    await photos.mediaStore.load('m1');
    await files.mediaStore.load('m2');
    assert.deepEqual(asked, ['Photo', 'File']);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --experimental-strip-types --test src/mediaStore/framework.test.ts src/resizer.test.ts`
Expected: FAIL — `FrameworkMediaStore` ignores `modelName`, so both loads ask for `'File'`.

- [ ] **Step 3: Implement** — in `src/mediaStore/framework.ts`, add above the class:

```ts
export interface FrameworkMediaStoreOptions {
  // The host media model. Default: `mediaModelName` from the app's `resize` config.
  modelName?: string;
}
```

At the top of the class body:

```ts
  readonly #modelName: string | undefined;

  constructor(opts: FrameworkMediaStoreOptions = {}) {
    this.#modelName = opts.modelName;
  }
```

In `getMediaModel()`, replace `const { mediaModelName } = getResizeConfig();` with:

```ts
    const mediaModelName = this.#modelName ?? getResizeConfig().mediaModelName;
```

In `src/resizer.ts`, change the default to use the instance's config (it must come after `this.config` is assigned):

```ts
    this.mediaStore =
      opts.mediaStore ??
      new FrameworkMediaStore({ modelName: this.config.mediaModelName });
```

- [ ] **Step 4: Run the tests**

Run: `node --experimental-strip-types --test src/mediaStore/framework.test.ts src/resizer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mediaStore/framework.ts src/mediaStore/framework.test.ts src/resizer.ts src/resizer.test.ts
git commit -m "feat: FrameworkMediaStore takes the Resizer's media model name"
```

---

### Task 4: Core code reads its context from the Resizer

**Files:**
- Create: `src/architecture.test.ts`
- Modify: `src/engine.ts`, `src/enqueue.ts`, `src/original.ts`, `src/resizeTask.ts`, `src/worker.ts`, `src/index.ts`
- Test: `src/engine.test.ts`, `src/resizeTask.test.ts` (import path only)

**Interfaces:**
- Consumes: `Resizer.config`, `Resizer.logger` (Task 2).
- Produces:
  - `processTaskWith(resizer: Resizer, task: LeasedTask, taskOpts?: { signal: AbortSignal }): Promise<void>` in `src/resizeTask.ts` (core).
  - `processTask(task: LeasedTask, taskOpts?: { signal: AbortSignal }): Promise<void>` in `src/worker.ts` (entry point; runs the default Resizer; phase 2 routes by `task.resizer`). The main entry still exports `processTask`.

- [ ] **Step 1: Write the guard test** — create `src/architecture.test.ts`:

```ts
// Core modules receive their Resizer as an argument. Only entry points (the Resizer's
// constructor defaults, worker.ts) and framework drivers may import process-wide lookups.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const CORE_FILES = [
  'engine.ts',
  'enqueue.ts',
  'formatPictureUrls.ts',
  'images.ts',
  'original.ts',
  'resizeTask.ts',
];
const GLOBAL_LOOKUPS = new Set(['getApp', 'getResizeConfig', 'getResizer']);

/** Names imported as runtime values (`import type` and `type X` specifiers are erased). */
function valueImports(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(
    /import\s+(type\s+)?\{([^}]*)\}\s+from\s+'[^']+'/g,
  )) {
    if (match[1]) {
      continue;
    }
    for (const part of match[2].split(',')) {
      const specifier = part.trim();
      if (specifier && !specifier.startsWith('type ')) {
        names.push(specifier.split(/\s+as\s+/)[0]);
      }
    }
  }
  return names;
}

for (const file of CORE_FILES) {
  test(`${file} imports no process-wide lookup`, async () => {
    const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
    const found = valueImports(source).filter((name) =>
      GLOBAL_LOOKUPS.has(name),
    );
    assert.deepEqual(
      found,
      [],
      `${file} must read its context from the Resizer argument`,
    );
  });
}
```

- [ ] **Step 2: Write the behavior test** — append to `src/engine.test.ts`:

```ts
describe('several Resizers in one process', () => {
  test('each resolve uses its own formats and logger', async () => {
    const errorsA: unknown[][] = [];
    const errorsB: unknown[][] = [];
    const logger = (errors: unknown[][]) => ({
      info() {},
      warn() {},
      error: (...args: unknown[]) => {
        errors.push(args);
      },
    });
    const a = new Resizer({
      storage: makeStorage(),
      config: makeResizeConfig({ formats: ['webp'] }),
      logger: logger(errorsA),
    });
    const b = new Resizer({
      name: 'listings',
      storage: makeStorage(),
      config: makeResizeConfig({ formats: ['jpeg'] }),
      logger: logger(errorsB),
    });
    const media = { id: 'm1', previews: [] };
    const sizes = [{ width: 10, height: 10 }];

    const fromA = await a.resolve({ media, sizes });
    const fromB = await b.resolve({ media, sizes });
    assert.deepEqual(
      fromA.decision.missing.map((m) => m.format),
      ['webp'],
    );
    assert.deepEqual(
      fromB.decision.missing.map((m) => m.format),
      ['jpeg'],
    );

    // A media without an id is a never-throw failure, logged by the Resizer that hit it.
    await b.resolve({ media: {} as never, sizes });
    assert.equal(errorsA.length, 0);
    assert.equal(errorsB.length, 1);
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `node --experimental-strip-types --test src/architecture.test.ts src/engine.test.ts`
Expected: FAIL.
- The guard lists `getApp`/`getResizeConfig` for `engine.ts`, `enqueue.ts`, `original.ts` and `resizeTask.ts`, plus `getResizer` for `resizeTask.ts`.
- The behavior test sees the app config's three formats and an empty `errorsB`.

- [ ] **Step 4: `src/engine.ts`**
- Delete the `getApp` and `getResizeConfig` import lines.
- Replace the three `opts.formats ?? getResizeConfig().formats` with `opts.formats ?? resizer.config.formats`.
- Replace every `getApp().logger.` inside `resolveImpl`, `prewarmImpl` and `originalUrl` with `resizer.logger.` (7 occurrences).
- Replace the two helpers `logResolveError` and `logPrewarmError` (end of file) with:

```ts
/** Log a never-throw catch; a throwing host logger falls back to the console. */
function logNeverThrow(resizer: Resizer, message: string, err: unknown): void {
  try {
    resizer.logger.error(message, err);
  } catch {
    console.error(message, err);
  }
}
```

Then change their two call sites: `logResolveError(err);` becomes

```ts
    logNeverThrow(
      resizer,
      'resize resolve: unexpected internal error — returning the safe empty decision',
      err,
    );
```

and `logPrewarmError(err);` becomes

```ts
    logNeverThrow(
      resizer,
      'resize prewarm: unexpected internal error — nothing enqueued',
      err,
    );
```

- [ ] **Step 5: `src/enqueue.ts`**
- Delete the `getApp` and `getResizeConfig` import lines.
- Replace both `getResizeConfig().queue.lockTtlMs.dispatch` with `resizer.config.queue.lockTtlMs.dispatch`.
- Replace every `getApp().logger.` with `resizer.logger.` (7 occurrences, in `enqueue`, `enqueueConfirmed` and `releaseAll`; each already has a `resizer` parameter).

- [ ] **Step 6: `src/original.ts`**
- Delete `import { getResizeConfig } from './resizeConfig.ts';`.
- In `uploadOriginalImpl`, replace `const config = getResizeConfig();` with `const { config } = resizer;`.

- [ ] **Step 7: `src/resizeTask.ts`**
- Delete the `getApp` and `getResizeConfig` import lines, and delete `getResizer,` from the `./resizer.ts` import list.
- In `generatePreviews`, replace `const app = getApp();` and `const config = getResizeConfig();` with `const { config, logger } = resizer;`, and change its two `app.logger.error(` calls to `logger.error(`.
- In `releaseLock`, change `getApp().logger.error(` to `resizer.logger.error(`.
- In `generateImpl`, replace `const config = getResizeConfig();` with `const { config } = resizer;`.
- Rename `processTask` and give it the Resizer. The signature becomes:

```ts
export async function processTaskWith(
  resizer: Resizer,
  task: LeasedTask,
  taskOpts?: { signal: AbortSignal },
): Promise<void> {
  const { logger } = resizer;
```

  Delete its `const app = getApp();` and `const resizer = getResizer();` lines, and change its two `app.logger.info(` calls to `logger.info(`. Update the file's header comment line that mentions `processTask()` to `processTaskWith()`.

- [ ] **Step 8: `src/worker.ts` becomes the task entry point**
- Replace `import { processTask } from './resizeTask.ts';` with `import { processTaskWith } from './resizeTask.ts';`.
- Add `import type { LeasedTask } from './transports/AbstractTransport.ts';`.
- Add above `runResizeWorker`:

```ts
/** Run one leased task with the default Resizer. Phase 2 routes by the task's resizer name. */
export async function processTask(
  task: LeasedTask,
  taskOpts?: { signal: AbortSignal },
): Promise<void> {
  return processTaskWith(getResizer(), task, taskOpts);
}
```

- Inside `runResizeWorker`, change the handler to `(task, taskOpts) => processTaskWith(resizer, task, taskOpts)`.

- [ ] **Step 9: Export paths**
- In `src/index.ts`, delete `export { processTask } from './resizeTask.ts';` and change `export { runResizeWorker } from './worker.ts';` to `export { processTask, runResizeWorker } from './worker.ts';`.
- In `src/resizeTask.test.ts`, delete `import { processTask } from './resizeTask.ts';` and change `import { runResizeWorker } from './worker.ts';` to `import { processTask, runResizeWorker } from './worker.ts';`.

- [ ] **Step 10: Run the new tests, then everything**

Run: `node --experimental-strip-types --test src/architecture.test.ts src/engine.test.ts`
Expected: PASS.

Run: `npm run types:check && npm run check && npm run build && npm test && npm run smoke`
Expected: all green. (`npm run check:fix` fixes formatting only; re-run `npm run check` after it.)

- [ ] **Step 11: Commit**

```bash
git add src/architecture.test.ts src/engine.ts src/enqueue.ts src/original.ts src/resizeTask.ts src/worker.ts src/index.ts src/engine.test.ts src/resizeTask.test.ts
git commit -m "refactor: core code reads config and logger from its Resizer"
```

---

### Task 5: Documentation

**Files:**
- Modify: `README.md` (lines 87–88)
- Modify: `AGENTS.md` (the "ONE `Resizer` per process" rule and the troubleshooting row for "a second `new Resizer()` throws")
- Modify: `CHANGELOG.md` (the `# Unreleased` section)
- Modify (docs repo): `../framework-documenation-github/docs/12-resize.md` (section "4. Initialize once per process", the paragraph starting "Create **one `Resizer` per process**")

**Interfaces:**
- Consumes: the API from Tasks 2–4.

- [ ] **Step 1: README** — replace "One Resizer per process — a second `new Resizer()` throws." with:

```md
Most hosts construct one Resizer. A host that needs different storage, media models or formats
constructs more, each with its own `name`, and looks them up with `getResizer(name)`;
constructing the same name twice throws. For now only the default Resizer can have a
`transport` (queued work); named Resizers use `generate()` and `resolve()`.
```

- [ ] **Step 2: AGENTS.md** — replace the rule line with:

```md
- Construct each Resizer ONCE, at one construction site. Most hosts need one (`getResizer()`); for
  more, give each a `name` and its own `config` (`getResizer('listings')`). The same name twice
  throws. Only the default Resizer may have a `transport` for now.
```

and the troubleshooting row with:

```md
| `a Resizer named '…' already exists` | each name is constructed once per process — import the single construction site; elsewhere `getResizer(name)` |
```

- [ ] **Step 3: CHANGELOG** — under `# Unreleased`, add to **Breaking changes**:

```md
- Several named Resizers can live in one process. `new Resizer({ name })` registers under its
  name (default `'default'`), a duplicate name throws `RESIZE_DUPLICATE_RESIZER`, and
  `getResizer(name?)` looks one up. Each Resizer reads its own `config`, `logger` and `events`
  (framework app defaults when omitted) at construction, instead of reading the app on every call.
  Until queued tasks record their Resizer, only the default Resizer may have a `transport`
  (`RESIZE_NAMED_TRANSPORT_UNSUPPORTED`).
```

and to **Features**:

```md
- `FrameworkMediaStore({ modelName })`; the default media store uses the Resizer's own
  `mediaModelName`.
```

- [ ] **Step 4: Run the doc drift test and the full checks**

Run: `npm run build && npm test && npm run check`
Expected: PASS (includes `src/agentsDoc.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add README.md AGENTS.md CHANGELOG.md
git commit -m "docs: named Resizers replace one-per-process"
```

- [ ] **Step 6: Framework docs site** — in the docs repo (`../framework-documenation-github`), create a branch and edit `docs/12-resize.md`. Replace the paragraph that starts "Create **one `Resizer` per process**; a second construction throws." (end of section "4. Initialize once per process") with:

````md
Construct each `Resizer` once per process. Most apps need one: `getResizer()` returns it in handlers and DTO builders. An app that needs different storage, media models or formats constructs more, each with its own `name` and `config`, and reads them with `getResizer(name)`. Constructing the same name twice throws. The CLI/worker needs its own initialization, shown in the lazy setup.

```ts
// src/resizer.ts — a second Resizer next to the default one
import { Resizer } from '@adaptivestone/framework-module-resize';
import defaultResizeConfig from '@adaptivestone/framework-module-resize/config/resize.js';

export const listings = new Resizer({
  name: 'listings',
  config: { ...defaultResizeConfig, mediaModelName: 'File', formats: ['webp', 'avif'] },
  storage: listingsStorage, // any storage driver
});

// elsewhere: getResizer('listings').generate({ media, sizes })
```

For now only the default `Resizer` can have a `transport`. A named `Resizer` uses `generate()` and `resolve()`; queued work for it arrives in a later release.
````

Check that nothing else on the page still claims a single instance:

Run: `grep -n -E "one .Resizer. per process|second construction throws" ../framework-documenation-github/docs/12-resize.md`
Expected: no output.

Then commit in the docs repo and open its PR:

```bash
cd ../framework-documenation-github
git switch -c docs/resize-named-resizers
git add docs/12-resize.md
git commit -m "Document named Resizers in the resize module"
git push -u origin docs/resize-named-resizers
gh pr create --title "Resize: named Resizers" --body "Documents named Resizers (module phase P1): several Resizers per process, getResizer(name), and the temporary default-only transport rule."
```

Merge the docs PR when the module release that contains P1 is published.

---

## Definition of done (P1)

- Two Resizers with different configs, loggers and media models work in one process (tests in Tasks 2–4).
- `src/architecture.test.ts` passes: no core file imports `getApp`, `getResizeConfig` or `getResizer`.
- `npm run types:check`, `npm run check`, `npm run build`, `npm test`, `npm run smoke` all pass.
- README, AGENTS.md and CHANGELOG describe named Resizers; nothing still says "one Resizer per process".
- The framework docs site PR (`docs/12-resize.md`) is open and describes named Resizers and the default-only transport rule.
