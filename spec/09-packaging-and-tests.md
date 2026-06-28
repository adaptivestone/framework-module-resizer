# 09 · Packaging, build & tests

> Part of the [`@adaptivestone/framework-module-resize` build spec](../BUILD-SPEC.md).
> Prev: [08 · Config & scaffold](./08-config-and-scaffold.md) · Next: [10 · Host integration](./10-host-integration.md)

Mirror `@adaptivestone/framework-module-email` exactly: ESM-only, source authored in TS
with `.ts` import specifiers, `tsc` rewrites them to `.js`, publishes only `dist`. Tests
use the built-in `node:test` (zero test deps), like the email module.

---

## §3. Package layout

```
framework-module-resize/
├── package.json
├── tsconfig.json
├── biome.json
├── preBuild.ts            # rm -rf dist (idempotent)
├── postBuild.ts           # copy non-TS assets (types.d.ts, assets/, scaffold/templates/) into dist
├── README.md
├── src/
│   ├── index.ts           # public entry: ResizeEngine, ResizeWorker, helpers, transports, types
│   ├── types.d.ts         # hand-authored types (copied verbatim to dist)
│   ├── engine.ts          # ResizeEngine: read decision + registration surface
│   ├── registry.ts        # module-scope active transport + storage + named pipelines (avoids import cycles)
│   ├── hooks.ts           # hook bus (waterfall + observer)
│   ├── enqueue.ts         # dedup + dispatch-lock + transport.enqueue
│   ├── worker.ts          # runResizeWorker / ResizeWorker (transport-agnostic loop)
│   ├── resizeTask.ts      # processTask: download once, beforeSteps, sharp+variantSteps, upload, $push, locks
│   ├── images.ts          # getSizeKey / parseSizeKey / getFilterSig / getPreviewIdentity /
│   │                      #   calculateResizedDimensions / getImageContentType
│   ├── models/
│   │   ├── ResizeTask.ts   # ResizeTaskModel — BaseModel subclass + TResizeTask type (host `extends` it)
│   │   └── mediaFragment.ts # optional `as const` media schema fragment (host spreads into File/Media — 08 · §12)
│   ├── commands/
│   │   └── ResizeWorker.ts # AbstractCommand: run() → runResizeWorker(this.app); isShouldInitModels=true
│   ├── transports/
│   │   ├── mongo.ts        # DEFAULT transport (Mongo queue + lease). No new infra.
│   │   └── sqs.ts          # OPTIONAL transport (AWS SQS + sqs-consumer). Optional peer deps.
│   ├── config/
│   │   └── resize.ts       # default config + getResizeConfig(app) + requiredFormats(config)
│   ├── scaffold/
│   │   ├── command.ts      # `resize-scaffold` bin generator (shebang #!/usr/bin/env node; writes re-export shims into host app)
│   │   └── templates/
│   │       ├── ResizeTask.model.ts.tpl      # extends: export default class ResizeTask extends ResizeTaskModel {}
│   │       ├── ResizeTask.model.full.ts.tpl # --eject: full editable model (custom fields/indexes)
│   │       ├── ResizeWorker.command.ts.tpl  # re-export: export { default } from '.../commands/ResizeWorker.js'
│   │       └── resize.config.ts.tpl         # full editable config copy
│   └── assets/
│       └── placeholders/   # optional default placeholders (loading.jpg/webp/avif) — host may override
```

`package.json` essentials (copy the email module's shape — ESM, `.ts` source):

```jsonc
{
  "name": "@adaptivestone/framework-module-resize",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "exports": {
    ".": "./dist/index.js",
    "./models/ResizeTask.js": "./dist/models/ResizeTask.js",
    "./commands/ResizeWorker.js": "./dist/commands/ResizeWorker.js",
    "./config/resize.js": "./dist/config/resize.js"
  },
  "bin": { "resize-scaffold": "./dist/scaffold/command.js" },   // npx @adaptivestone/framework-module-resize resize-scaffold (08 · §12)
  "engines": { "node": ">=22.12.0" },
  "files": ["dist"],
  "scripts": {
    "prepublishOnly": "npm run build",
    "build": "node preBuild.ts && tsc && node postBuild.ts",
    "types:check": "tsc --noEmit",
    "test": "node --experimental-strip-types --test",
    "check": "biome check",
    "check:fix": "biome check --write"
  },
  "dependencies": { "sharp": "^0.34.0", "deepmerge": "^4.3.1" },
  "peerDependencies": { "mongoose": "*", "@adaptivestone/framework": "*" },
  "optionalDependencies": { "@aws-sdk/client-sqs": "*", "sqs-consumer": "*" },
  "devDependencies": { "@biomejs/biome": "^2.4.9", "@types/node": "^26.0.0", "typescript": "^6.0.0", "mongodb-memory-server": "^10.0.0" }
}
```

`tsconfig.json` — copy the email module verbatim: `target esnext`, `module nodenext`,
`allowImportingTsExtensions`, `rewriteRelativeImportExtensions`, `verbatimModuleSyntax`,
`erasableSyntaxOnly`, `rootDir src`, `outDir dist`, `declaration true`,
`exclude: ["src/**/*.test.ts"]`. `biome.json` — copy verbatim (2-space, single quotes,
trailing commas, organize-imports). `preBuild.ts` / `postBuild.ts` — mirror the email
module; `postBuild` copies `['types.d.ts', 'assets', 'scaffold/templates']` from `src` to
`dist`.

> `mongoose` is a peer dep (host already has it; the module never imports it — `getModel`
> returns `any`). `sharp` and `deepmerge` are hard deps. SQS deps are optional,
> lazy-loaded. `erasableSyntaxOnly` forbids enums/namespaces/parameter-properties — use
> `as const` unions (e.g. `PreviewFormat`).

---

## §21. Build / release

- `tsc` → `dist`; `preBuild.ts` removes `dist`; `postBuild.ts` copies `src/types.d.ts`,
  `src/assets/**`, `src/scaffold/templates/**` into `dist` (they are not emitted by `tsc`).
  Mirror the email module's `preBuild.ts`/`postBuild.ts`.
- `package.json` `files: ["dist"]`; `prepublishOnly: npm run build`.
- `npm run check` (biome), `npm run types:check` (tsc --noEmit), and `npm test`
  (`node --experimental-strip-types --test`, so the `.ts` test files run directly on Node ≥22.12)
  must pass.

---

## §20. Tests (`node:test`, mirroring the email module; no live AWS/Mongo where avoidable)

- `images`: `getSizeKey`/`parseSizeKey` for `WxH`, `Ww`, `Hh`, `fit`, invalid;
  `getFilterSig` order-independence + empty→`none`; `getPreviewIdentity` composition;
  `calculateResizedDimensions` `fit` cap + no-upscale.
- `engine.resolve`: ready vs missing partitioning (incl. filtered vs unfiltered same
  size); `resolveSizes`/`formatPublicUrls` applied; pipeline name threaded into enqueue;
  enqueue only for missing; enqueue failure does not throw; `canUseOriginal` when known.
- `enqueue`: dedup by identity; dispatch-lock dedup (held lock ⇒ skipped); no task when
  nothing survives; dispatch locks released on enqueue failure.
- `mongoTransport` (against **`mongodb-memory-server`** — atomic claim semantics can't be
  faked with plain objects): enqueue maps `mediaId→fileId` and stores `pipeline`; `lease`
  claims oldest pending, reclaims an expired `processing` lease, **never reclaims an exhausted
  one** (`attempts >= maxAttempts`); two concurrent leases never claim the same task;
  `complete`/`fail`/`renew` are fencing-guarded (a stale `leaseToken` 0-matches); `fail` retries
  with backoff then dead-letters; the dead-letter sweep flips crash-looped tasks and fires
  `onTaskDeadLettered` once each.
- `sqsTransport` (mocked `@aws-sdk/client-sqs` + `sqs-consumer` — no live AWS): `enqueue` sends
  to `config.sqs.queueUrl` with the right body and returns `{ taskId }`; a thrown `handleTask`
  propagates (→ SQS redeliver) and fires `onTaskFailed`; `opts.signal` stops the consumer.
- `config`: `getResizeConfig` deep-merges defaults, host arrays **replace** (not concat),
  required-field omission throws; `requiredFormats` honors `webpAvifOnly`.
- `hooks`: `runWaterfall` threads values in registration order AND a throwing tap is logged +
  skipped (read never breaks); `runObservers` swallows tap errors.
- `scaffold` (write to a temp dir): emits the model `extends` shim + command re-export + config files; `--check` reports
  `ok`/`drift`/`missing` and exits non-zero on drift; `--eject` writes the full model; never
  overwrites without `--force`.
- `resizeTask.processTask`: skips existing previews; pipeline `beforeSteps` run once before
  resize; `.rotate()` on both branches; filtered variant reaches `variantSteps` with its
  `filters`; per-format encode settings applied (`quality`/`effort` per codec, not one shared
  int); **idempotent re-run** — re-processing a task whose previews already exist generates
  nothing and produces no duplicate `$push`; `sharp()` called with `limitInputPixels`; bounded
  concurrency; `$push` shape (incl. `filters`/`fit`); original dims backfilled when missing;
  both lock tiers released (success + error); **EXIF-rotated source** (orientation 6/8) → `fit`
  box + backfilled dims use DISPLAY orientation (W/H swapped); **`actualWidth/Height` from encoded
  `info`** not the resize box (a `fit` variant's recorded dims ≤ box); **transparent source → jpeg**
  variant is flattened (not black); **poison variant** (a `variantStep` that always throws) →
  task throws when zero previews produced (engages dead-letter, no infinite re-enqueue); sharpen
  applied per `config.sharpen` (cover vs fit); jpeg encoded with `mozjpeg`/`chromaSubsampling`.
- `worker`: clean no-op when `workerEnabled=false`; graceful stop on abort;
  transport-agnostic (`startWorker` is what's invoked).
