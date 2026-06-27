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
│   │   └── ResizeTask.ts   # makeResizeTaskModel({fileRef}) — BaseModel factory (host re-exports it)
│   ├── commands/
│   │   └── ResizeWorker.ts # AbstractCommand: run() → runResizeWorker(this.app); isShouldInitModels=true
│   ├── transports/
│   │   ├── mongo.ts        # DEFAULT transport (Mongo queue + lease). No new infra.
│   │   └── sqs.ts          # OPTIONAL transport (AWS SQS + sqs-consumer). Optional peer deps.
│   ├── config/
│   │   └── resize.ts       # default config + getResizeConfig(app) + requiredFormats(config)
│   ├── scaffold/
│   │   ├── command.ts      # `resize/scaffold` generator (writes thin re-export shims into host app)
│   │   └── templates/
│   │       ├── ResizeTask.model.ts.tpl    # re-export: export default makeResizeTaskModel({fileRef:'File'})
│   │       ├── ResizeWorker.command.ts.tpl# re-export: export { default } from '.../commands/ResizeWorker.js'
│   │       └── resize.config.ts.tpl        # full editable config copy
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
  "engines": { "node": ">=22.12.0" },
  "files": ["dist"],
  "scripts": {
    "prepublishOnly": "npm run build",
    "build": "node preBuild.ts && tsc && node postBuild.ts",
    "types:check": "tsc --noEmit",
    "test": "node --test",
    "check": "biome check",
    "check:fix": "biome check --write"
  },
  "dependencies": { "sharp": "^0.34.0", "deepmerge": "^4.3.1" },
  "peerDependencies": { "mongoose": "*" },
  "optionalDependencies": { "@aws-sdk/client-sqs": "*", "sqs-consumer": "*" },
  "devDependencies": { "@biomejs/biome": "^2.4.9", "@types/node": "^26.0.0", "typescript": "^6.0.0" }
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
  (`node --test`) must pass.

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
- `mongoTransport`: enqueue maps `mediaId→fileId` and stores `pipeline`; `lease` claims
  oldest pending, reclaims an expired `processing` lease, two concurrent leases never
  claim the same task.
- `resizeTask.processTask`: skips existing previews; pipeline `beforeSteps` run once before
  resize; `.rotate()` on both branches; filtered variant reaches `variantSteps` with its
  `filters`; per-format encode settings applied (`quality`/`effort` per codec, not one shared
  int); **idempotent re-run** — re-processing a task whose previews already exist generates
  nothing and produces no duplicate `$push`; `sharp()` called with `limitInputPixels`; bounded
  concurrency; `$push` shape (incl. `filters`/`fit`); original dims backfilled when missing;
  both lock tiers released (success + error).
- `worker`: clean no-op when `workerEnabled=false`; graceful stop on abort;
  transport-agnostic (`startWorker` is what's invoked).
