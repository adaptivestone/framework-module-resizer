# Adoption plan — any framework host

`@adaptivestone/framework-module-resize@0.1.0` is a **shared** package. It must stay
comfortable in a greenfield app, a second product, and the first production host —
not a private adapter for one backend.

That host was only the first production probe. Lessons below are generalized.
Host-specific rollout lives in that app’s own docs, not in this module’s API.

---

## Product rule

The module owns: size identity, sharp, persist of `previews[]`, ready/missing.

The **host** owns: which model is media, which size catalogs exist, the public
JSON, when to fallback, delete, SVG sanitization, domain steps (blur, watermark).

If a feature only makes sense for one app’s field names or DTO, it does **not**
belong here.

---

## What every host hit (or will)

These are product bugs, not “one host’s quirks”:

| Problem | Why any host cares |
|---|---|
| `generate()` can return `[]` for success, missing original, SVG, or total failure | Every write path has to guess |
| Returned `previews` are **new** rows only; a second call looks like a failed generate | Every host that checks `.length` |
| Failed `formatPublicUrls` leaks `{ ready, missing }` as `output` | Easy to send garbage JSON to any frontend |
| No filesystem driver | Tests and local docker always reinvent 40 lines |
| S3 option named `publicUrl` shadows `publicUrl(ref)` | Anyone who copies the README into a class |
| `enqueueMissing` defaults **true** | Eager-only apps enqueue-or-log on every read |
| README / scaffold lead with Mongo queue + worker | First install looks harder than it is |
| Main entry loads `ResizeTask` | Fine on framework 5.3; noisy for eager-only / older peers |

Not the module’s job (stay on the host):

- Mapping `originalMetadata` → `original` (legacy schema).
- A named `generateAvatarPreviews` / Event helper.
- `resolveMany` (listings: `find().select(…).lean()` + a loop).
- Per-entity size lists (avatar vs banner vs “product card”).

---

## Keep

- One `Resizer` per process.
- `generate` / `resolve` / `prewarm`.
- Size keys (`720x720`, `620w`, `400h`, `fit`) and `previews[]`.
- Swappable storage / transport / mediaStore.
- Pipelines + hooks.
- Worker **optional**. Eager is a first-class, complete mode.

---

## Change (small, host-agnostic)

### 1. Honest `generate`

```ts
const { created, failed } = await resizer.generate({
  media,
  sizes, // host allowlist — never raw client width/height
});
```

| Case | Behavior |
|---|---|
| no `media.original` | throw `ResizeNoOriginalError` |
| SVG original | `{ created: [], failed: 0 }` — success |
| every requested variant fails | throw `ResizeGenerateError` |
| some fail | no throw, `failed > 0` |
| all identities already stored | `{ created: [], failed: 0 }` |

Name the array **`created`** (only this call). After persist, also append onto `media.previews`
so a same-request `resolve` sees the new rows.

Export the error classes. Any host can `instanceof` without string-matching logs.

### 2. Honest `resolve`

- No hook / hook throws → `output === undefined`. Never pass the raw decision off as a DTO.
- No `transport` → `enqueueMissing` defaults to **`false`**.
- Optional helper `formatPictureUrls(decision, { id, mediaType })` builds a **generic**
  `<picture>` map:

```ts
{
  mediaType?: string,
  id?: string,
  sizes: {
    [sizeKey: string]: {
      [format: string]: { url: string, contentType: string }
    }
  }
}
```

`sizeKey` is whatever identity already is (`720x720`, `620w`, `fit`).  
This is a convenience, **not** “one host’s contract”. Another app uses its own hook.

### 3. `LocalFsStorage`

```ts
import { LocalFsStorage } from '@adaptivestone/framework-module-resize/storage/fs.js';

new LocalFsStorage({
  rootDir: './var/media',
  publicBaseUrl: '/media',
});
```

Same `download` / `upload` / `publicUrl`. Option name `publicBaseUrl` (never `publicUrl`).

Default story for tests and first-week local: FS. S3 when the host has buckets.

### 4. S3 — document, do not fork

Already accepts `client`. Show that first in README:

```ts
new S3Storage({
  bucketPublic,
  bucketPrivate,
  publicBaseUrl, // alias old `publicUrl` for one minor
  client,        // existing S3Client — env/keys stay in the host
});
```

No second S3 wrapper in the package.

### 5. Tiny shared helpers

```ts
isCatalogCovered(media, sizes, formats): boolean
resizeMediaSelect = 'original previews' // plus host fields they already need
```

`resizeMediaSelect` is the **module** fields `resolve`/`generate` read. Hosts append
`mediaType`, `name`, … themselves. Do not bake one host’s `mediaType` into the
constant as if every app has it — document:

```ts
.select(`${resizeMediaSelect} mediaType`)
```

or export only `['original', 'previews']` and let the host join.

Prefer:

```ts
export const resizeMediaPaths = ['original', 'previews'] as const;
```

Hosts: `.select(['mediaType', ...resizeMediaPaths])`.

### 6. Docs and scaffold: eager first

`resize-scaffold --eager` is already there. Make the README **open** with:

```ts
import { Resizer } from '@adaptivestone/framework-module-resize';
import { LocalFsStorage } from '@adaptivestone/framework-module-resize/storage/fs.js';

export const resizer = new Resizer({
  storage: new LocalFsStorage({ rootDir: './var/media', publicBaseUrl: '/media' }),
});
// after Server.init()
await resizer.generate({ media, sizes: [{ width: 320, height: 320 }] });
const { decision } = await resizer.resolve({ media, sizes: [{ width: 320, height: 320 }] });
```

Queue, `ResizeTask`, `ResizeWorker` = a later section (“when listings are huge”).

Construct **after** `Server.init()` (or lazily on first request). Do not construct in
`server.ts` before `startServer()`.

### 7. Schema

Module schema stays `original` + `previews` (fragment).  
New apps spread the fragment from day one — no `toMediaLike`.  
Old apps dual-write. No aliases in `FrameworkMediaStore`.

### 8. `./eager` subpath — 0.3, not 0.2

Nice when a host must not load `ResizeTask`. Not required if peer is framework ≥ 5.2.

---

## Do not do

- One host’s field names, catalogs, or public-URL shape as the only DTO.
- `app` on every method.
- Storage delete / CDN purge.
- Watermark, NSFW, plate blur in core (host `pipeline` steps).
- Change identity keys or default encode table.
- Require a worker.
- `resolveMany`.
- Map legacy `originalMetadata` / `resizedMetadata`.

---

## Ship

One PR on this branch — not five, no extra GitHub workflow. `npm test` + `types:check`, then publish **0.2.0** the usual manual way (`RELEASE.md`).

In that PR: honest `generate` / `resolve`, `LocalFsStorage`, S3 `publicBaseUrl`, `isCatalogCovered` + `resizeMediaPaths`, README eager+FS first, scaffold `--eager` uses FS (not a Mongo transport TODO).

---

## Done when (any new app)

A greenfield host, after scaffold `--eager` and one size list of their own:

- uploads an original onto `media.original`;
- calls `generate` and can tell success from failure without a wrapper;
- calls `resolve` and either maps `decision` or uses `formatPictureUrls`;
- runs locally and in CI with `LocalFsStorage` and no AWS;
- can add a second entity by passing another `sizes` array only.

If the next product still needs a 150-line wrapper, 0.2 failed.

---

## Appendix — first host (evidence only)

First probe: profile avatar, eager, dual schema, custom FS + S3 wrapper.

Next **in that app** (not module work): auth → a host-side image helper (four catalogs,
including `620w`) → listing `.select` must include `original`/`previews`.  
Sitemap `uploadRaw` and video are out of scope.

Do not let those catalogs or `.select('resizedMetadata')` leak into the package API.
