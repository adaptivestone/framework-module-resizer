# P3 — Identity Includes Resizer and Pipeline: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two pipelines (or two Resizers) that render the same media at the same size, format and filters produce and serve two different previews, instead of silently sharing whichever was generated first.

**Architecture:** The one identity helper gains a *scope*: `getPreviewIdentity(scope, sizeKey, format, filters)`, where `scope = { resizer, pipeline }`, returns `resizer:pipeline:sizeKey:format:filterSig`, with the names URI-encoded. Generated preview rows store `resizer` and `pipeline`; a stored row without them belongs to `{ resizer: 'default', pipeline: 'default' }`. Every comparison between a stored preview and a requested variant, every lock key and the worker's coverage check use the scoped identity. Changing the helper's signature makes the compiler list every call site.

**Tech Stack:** Node ≥ 24, TypeScript 7 (`erasableSyntaxOnly`, ESM), `node:test`, Biome, sharp.

**Spec:** [`docs/design/2026-09-30-multi-resizer.md`](../../design/2026-09-30-multi-resizer.md): decision D5 and the P3 section of §6. Builds on P1 and P2.

## Global Constraints

- The module is pre-release: breaking API changes are allowed and ship without data migrations. Stored preview rows without `resizer` / `pipeline` read as `'default'` (a default, not a migration).
- Every task ends with `npm run types:check`, `npm run check`, `npm run build`, `npm test`, `npm run smoke` all passing.
- No new runtime dependencies. No test-only code paths in shipped modules.
- `src/architecture.test.ts` keeps passing, and transports keep no `getResizer` import.
- Never build an identity or a lock key by hand; always go through `getPreviewIdentity`.
- New comments state reasons in plain words; no archived-spec section references. Public repository: no private project names. Commit messages: conventional prefix, no `Co-Authored-By`, no AI attribution.
- Out of scope: framework adapter work (P4).

## Review Focus

1. A resizer or pipeline name containing `:` (for example `a:b` + `c` versus `a` + `b:c`) must not produce the same identity. (Test: Task 1.)
2. Media with only a `default`-pipeline preview, read with `pipeline: 'watermark'` → the variant is **missing** and gets enqueued; the clean preview is never served for the watermark request. (Test: Task 2.)
3. Previews stored before this phase (no `resizer` / `pipeline` fields) are still served to `default`/`default` reads, not regenerated. (Test: Task 2.)
4. Two concurrent enqueues of the same size/format for two different pipelines must both win their dispatch locks. Before P3 they shared one lock key, so the second was silently dropped. (Test: Task 2.)
5. The worker's "task complete" coverage check must count only previews of the task's own resizer and pipeline. Otherwise a `default` preview marks a `watermark` task complete. (Test: Task 3.)

---

## File Structure

| File | Change | Responsibility after P3 |
|---|---|---|
| `src/types.d.ts` | Modify | `Preview.resizer?`, `Preview.pipeline?`; `PreviewScope`. |
| `src/models/mediaFragment.ts` | Modify | `previews[].resizer`, `previews[].pipeline` fields. |
| `src/images.ts` | Modify | `DEFAULT_SCOPE`, `previewScope()`, scoped `getPreviewIdentity`, `expandPreviewRequests`, `expandMissingPreviews`, `isCatalogCovered`. |
| `src/engine.ts`, `src/enqueue.ts` | Modify | Scoped identities on the read path, in strict enqueue, and in dispatch lock keys. |
| `src/resizeTask.ts` | Modify | Scoped existing-preview check, worker lock keys and coverage; generated rows carry scope. |
| Tests | Modify | `images.test.ts`, `engine.test.ts`, `prewarm.test.ts`, `enqueue.test.ts`, `enqueueRequired.test.ts`, `resizeTask.test.ts`, `index.test.ts`, integration tests. |
| `README.md`, `AGENTS.md`, `CHANGELOG.md`, design doc | Modify | Identity documentation; the fake-filter workaround removed. |

---

### Task 1: The scoped identity helper

**Files:**
- Modify: `src/types.d.ts`, `src/models/mediaFragment.ts`, `src/images.ts`
- Test: `src/images.test.ts`, `src/models/mediaFragment.test.ts`

**Interfaces:**
- Produces:

```ts
// src/types.d.ts
export interface PreviewScope {
  resizer: string; // Resizer name
  pipeline: string; // pipeline name
}
// Preview gains:
//   resizer?: string; // Resizer that generated it; absent → 'default'
//   pipeline?: string; // pipeline that generated it; absent → 'default'
```

```ts
// src/images.ts
export const DEFAULT_SCOPE: PreviewScope = Object.freeze({ resizer: 'default', pipeline: 'default' });
export function previewScope(preview: { resizer?: string; pipeline?: string }): PreviewScope;
export function getPreviewIdentity(scope: PreviewScope, sizeKey: string, format: PreviewFormat, filters?: Filters): string;
export function expandPreviewRequests(sizes: SizeInput[], formats: PreviewFormat[], scope: PreviewScope): MissingPreview[];
export function expandMissingPreviews(media: MediaLike, sizes: SizeInput[], formats: PreviewFormat[], scope: PreviewScope): MissingPreview[];
export function isCatalogCovered(media: MediaLike, sizes: SizeInput[], formats: PreviewFormat[], scope?: PreviewScope): boolean; // default DEFAULT_SCOPE
```

- [ ] **Step 1: Write the failing tests** in `src/images.test.ts`:

```ts
describe('scoped preview identity', () => {
  test('includes resizer and pipeline', () => {
    assert.equal(
      getPreviewIdentity({ resizer: 'default', pipeline: 'watermark' }, '300x300', 'webp'),
      'default:watermark:300x300:webp:none',
    );
  });

  test('names containing ":" cannot collide', () => {
    const a = getPreviewIdentity({ resizer: 'a:b', pipeline: 'c' }, '300x300', 'webp');
    const b = getPreviewIdentity({ resizer: 'a', pipeline: 'b:c' }, '300x300', 'webp');
    assert.notEqual(a, b);
  });

  test('a stored preview without resizer/pipeline belongs to the default scope', () => {
    assert.deepEqual(previewScope({}), DEFAULT_SCOPE);
    assert.deepEqual(previewScope({ pipeline: 'watermark' }), {
      resizer: 'default',
      pipeline: 'watermark',
    });
  });

  test('expandMissingPreviews ignores previews of another pipeline', () => {
    const media = {
      id: 'm1',
      previews: [
        { storageRef: { k: 1 }, sizeKey: '300x300', format: 'webp', contentType: 'image/webp' },
      ],
    };
    const sizes = [{ width: 300, height: 300 }];
    assert.equal(expandMissingPreviews(media, sizes, ['webp'], DEFAULT_SCOPE).length, 0);
    assert.equal(
      expandMissingPreviews(media, sizes, ['webp'], { resizer: 'default', pipeline: 'watermark' }).length,
      1,
    );
    assert.equal(isCatalogCovered(media, sizes, ['webp']), true);
  });
});
```

Update the existing identity assertions in `images.test.ts` to pass `DEFAULT_SCOPE` and expect the `default:default:` prefix. In `src/models/mediaFragment.test.ts`, assert that `previews[0]` has `resizer` and `pipeline` String fields.

- [ ] **Step 2: Run** `node --experimental-strip-types --test src/images.test.ts src/models/mediaFragment.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
1. `src/types.d.ts`: add `PreviewScope`, and add `resizer?: string;` and `pipeline?: string;` to `Preview` with the comments above.
2. `src/models/mediaFragment.ts`: add `resizer: { type: String },` and `pipeline: { type: String },` to the `previews` element, with the comment "Resizer and pipeline that generated this preview; absent means 'default'".
3. `src/images.ts`:

```ts
/** Scope of rows stored before previews recorded their resizer and pipeline. */
export const DEFAULT_SCOPE: PreviewScope = Object.freeze({
  resizer: 'default',
  pipeline: 'default',
});

/** The scope a stored preview belongs to. */
export function previewScope(preview: {
  resizer?: string;
  pipeline?: string;
}): PreviewScope {
  return {
    resizer: preview.resizer ?? 'default',
    pipeline: preview.pipeline ?? 'default',
  };
}

/**
 * The one lookup and lock identity: which Resizer and pipeline rendered which size, format
 * and filters. Names are URI-encoded so a ':' inside a name cannot shift the fields.
 */
export function getPreviewIdentity(
  scope: PreviewScope,
  sizeKey: string,
  format: PreviewFormat,
  filters?: Filters,
): string {
  return `${encodeURIComponent(scope.resizer)}:${encodeURIComponent(scope.pipeline)}:${sizeKey}:${format}:${getFilterSig(filters)}`;
}
```

Thread `scope` through `expandPreviewRequests` (its de-duplication identity), `expandMissingPreviews` (existing previews keyed with `previewScope(p)`, requests with `scope`), and `isCatalogCovered` (default `DEFAULT_SCOPE`).

- [ ] **Step 4: Run** `npm run types:check`. Expected: errors at every old call site in `engine.ts`, `enqueue.ts` and `resizeTask.ts`. Those are fixed in Tasks 2 and 3. Commit this task together with Task 2 once the build compiles again, or do Tasks 1–3 as one working session and commit per task at the end of each (tests of each task pass at its commit).
- [ ] **Step 5: Commit** (after Task 2 compiles) — `git commit -m "feat: preview identity includes the resizer and pipeline"`

---

### Task 2: Read path, strict enqueue and dispatch locks use the scope

**Files:**
- Modify: `src/engine.ts`, `src/enqueue.ts`
- Test: `src/engine.test.ts`, `src/prewarm.test.ts`, `src/enqueue.test.ts`, `src/enqueueRequired.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers.
- Produces: `enqueue(resizer, mediaId, pipeline, missing, queue)` and `enqueueConfirmed(…)` build lock keys as `resize_dispatch:${mediaId}:${getPreviewIdentity({ resizer: resizer.name, pipeline }, …)}` (signatures unchanged from P2).

Rules:
- `resolveImpl`: key the stored-preview map with `getPreviewIdentity(previewScope(p), p.sizeKey, p.format, p.filters)`, and look requests up with `scope = { resizer: resizer.name, pipeline }`.
- `prewarmImpl`: `expandMissingPreviews(media, sizes, formats, scope)`.
- `enqueueRequiredImpl`: `expandPreviewRequests(sizes, formats, scope)`; ready identities from stored previews with `previewScope(preview)`; every other identity uses `scope`.
- `enqueue.ts`: every `getPreviewIdentity` call uses `{ resizer: resizer.name, pipeline }`. Receipts from `findActive` belong to the same resizer and pipeline (the transport filters by both), so they use the same scope.

- [ ] **Step 1: Write the failing tests.** In `src/engine.test.ts`:

```ts
describe('pipelines are part of preview identity', () => {
  const stored = {
    storageRef: { k: 'clean' },
    sizeKey: '300x300',
    format: 'webp',
    contentType: 'image/webp',
  };
  const sizes = [{ width: 300, height: 300 }];

  test('a default preview is not served for another pipeline', async () => {
    const r = new Resizer({ storage: makeStorage() });
    const media = { id: 'm1', previews: [stored] };
    const clean = await r.resolve({ media, sizes, formats: ['webp'] });
    const watermarked = await r.resolve({ media, sizes, formats: ['webp'], pipeline: 'watermark' });
    assert.equal(clean.decision.ready.length, 1);
    assert.equal(watermarked.decision.ready.length, 0);
    assert.equal(watermarked.decision.missing.length, 1);
  });

  test('a preview stored for a pipeline is served only to that pipeline', async () => {
    const r = new Resizer({ storage: makeStorage() });
    const media = { id: 'm1', previews: [{ ...stored, pipeline: 'watermark' }] };
    const watermarked = await r.resolve({ media, sizes, formats: ['webp'], pipeline: 'watermark' });
    const clean = await r.resolve({ media, sizes, formats: ['webp'] });
    assert.equal(watermarked.decision.ready.length, 1);
    assert.equal(clean.decision.ready.length, 0);
  });
});
```

In `src/enqueue.test.ts`: two `enqueue` calls for the same media and variant, one with pipeline `'default'` and one with `'watermark'`, with a lock provider that grants each key once. Both reach the transport, and the recorded lock keys differ. In `src/prewarm.test.ts`: `prewarm({ pipeline: 'watermark' })` enqueues a variant even though a `default` preview exists. In `src/enqueueRequired.test.ts`: the same case yields `status: 'accepted'` for the watermark request.

- [ ] **Step 2: Run** those files. Expected: FAIL (or compile errors from Task 1's signature change).
- [ ] **Step 3: Implement** as described in Rules. Update existing tests that build identities or lock keys by hand to use `getPreviewIdentity(DEFAULT_SCOPE, …)`.
- [ ] **Step 4: Run** the four test files and `npm run types:check` (the remaining errors should be in `resizeTask.ts` only). Expected: the tests PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: reads, strict enqueue and dispatch locks are scoped per pipeline"`

---

### Task 3: Generation and the worker use the scope

**Files:**
- Modify: `src/resizeTask.ts`
- Test: `src/resizeTask.test.ts`

Rules:
- `generatePreviews(resizer, { …, pipeline })`: `scope = { resizer: resizer.name, pipeline }`. The existing set is keyed by `previewScope(p)`. Worker lock keys `resize_worker:${mediaId}:${identity}` and the dispatch key it releases use the scoped identity. Every generated `Preview` gets `resizer: resizer.name, pipeline` (set both, even for `'default'`).
- `processTaskWith`: `requestedByIdentity` and the coverage check use `scope = { resizer: resizer.name, pipeline: task.pipeline }`. Covered identities from stored previews use `previewScope(preview)`.
- `generateImpl`: `expandMissingPreviews(media, sizes, formats, { resizer: resizer.name, pipeline })`.

- [ ] **Step 1: Write the failing tests** in `src/resizeTask.test.ts`:
  - `generate({ pipeline: 'watermark' })` on media whose only preview is the same size/format for `default` creates one new preview. That preview has `pipeline: 'watermark'` and `resizer: 'default'`.
  - `generate()` without a pipeline sets `pipeline: 'default'` and `resizer: 'default'` on created rows.
  - A Resizer named `'listings'` writes `resizer: 'listings'`.
  - `processTask` for `task({ pipeline: 'watermark' })`, when the reloaded media has only a `default` preview of that variant and generation fails for it, rejects with `RESIZE_WORKER_INCOMPLETE`. The `default` preview must not count as coverage.
  - Worker lock keys recorded by the fake lock provider contain the pipeline segment (`:watermark:`).
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement** as described in Rules.
- [ ] **Step 4: Run** the full suite: `npm run types:check && npm run check && npm run build && npm test && npm run smoke`. Expected: all green. Update the integration tests (`queueIndexes.mongo.integration.test.ts`, `storageRef.persistence.integration.test.ts`, `worker.mongo.integration.test.ts`) where they build identities or compare preview rows.
- [ ] **Step 5: Commit** — `git commit -m "feat: generation and worker coverage are scoped per resizer and pipeline"`

---

### Task 4: Documentation

**Files:** `README.md`, `AGENTS.md`, `CHANGELOG.md`, `docs/design/2026-09-30-multi-resizer.md`

- [ ] **Step 1: README.** In "Sizes & identity", the identity is `resizer:pipeline:sizeKey:format:filterSig`. Preview rows record `resizer` and `pipeline`; rows without them belong to `default`. Two pipelines on one media keep separate previews. Renaming a pipeline (for example `watermark-v2`) regenerates its images. Update the `isCatalogCovered` example to show the optional scope argument.
- [ ] **Step 2: AGENTS.md.** Remove the paragraph telling hosts to use distinct filters for different renderings across pipelines. Replace it with: "Preview identity includes the Resizer and pipeline, so different pipelines keep separate previews; rename a pipeline to regenerate its images."
- [ ] **Step 3: CHANGELOG** (`# Unreleased`), **Breaking:** `getPreviewIdentity(scope, sizeKey, format, filters)`; identities, lock keys and `isCatalogCovered` are scoped by resizer and pipeline; preview rows gain `resizer` / `pipeline`; `expandMissingPreviews` / `expandPreviewRequests` take a scope.
- [ ] **Step 4: Design doc.** Mark P3 done in §6.
- [ ] **Step 5: Run** `npm run build && npm test && npm run check`. Expected: PASS.
- [ ] **Step 6: Commit** — `git commit -m "docs: preview identity includes resizer and pipeline"`

---

## Definition of done (P3)

- Two pipelines and two Resizers keep separate previews for the same media, size, format and filters. Reads, prewarm, strict enqueue, generation and worker coverage all agree.
- Rows without `resizer` / `pipeline` behave as `default`/`default`.
- Lock keys include the scope; no identity is built by hand.
- All checks pass; the docs describe the scoped identity, and the workaround is gone.
